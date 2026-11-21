// What each kind does with an absent output, a truncated one, one that
// isn't OTLP/JSON and one too large for OTTL; the {"records":[…]} unwrap;
// the vacuous advisory; and the deadline, through an injectable checkpoint
// (no sleeps).

package rules

import (
	"errors"
	"strings"
	"testing"
)

func countRule(context, condition, operator string, value int64) Rule {
	r := ottlRule(context, "count", condition)
	r.OTTL.Count = &Count{Operator: operator, Value: value}
	return r
}

func distinctRule(context, expression, operator string, value int64) Rule {
	r := ottlRule(context, "distinct", "")
	r.OTTL.Expression = strPtr(expression)
	r.OTTL.Count = &Count{Operator: operator, Value: value}
	return r
}

func TestAnAbsentOutputPerKind(t *testing.T) {
	results := run(t, "logs", nil, "",
		textRule(KindContainsText, "x"),
		textRule(KindNotContainsText, "x"),
		textRule(KindContainsRegex, "x"),
		textRule(KindNotContainsRegex, "x"),
		textRule(KindNotContainsRegex, "a*"), // matches the empty string
		ottlRule("log", "all", "true"),
		ottlRule("log", "none", "true"),
		ottlRule("log", "any", "true"),
		countRule("log", "true", "eq", 0),
		distinctRule("log", "body", "eq", 0),
	)
	for _, i := range []int{0, 2} {
		d := detailOf(t, results[i])
		if results[i].Passed || d.Kind != "no_match" || d.SearchedCharacters != 0 {
			t.Errorf("contains rule %d over no output: %+v %+v", i, results[i], d)
		}
	}
	for _, i := range []int{1, 3} {
		if !results[i].Passed {
			t.Errorf("not-contains rule %d over no output should pass: %+v", i, results[i])
		}
	}
	if results[4].Passed {
		t.Errorf("a regex matching the empty string fails over no output: %+v", results[4])
	}
	for _, i := range []int{5, 6} {
		if !results[i].Passed || !strings.Contains(advisoryOf(results[i]), "No log records in the output") {
			t.Errorf("all/none over zero records passes with the advisory: %+v", results[i])
		}
	}
	if advisoryOf(results[5]) != "No log records in the output: all holds only because there was nothing to check." {
		t.Errorf("advisory: %q", advisoryOf(results[5]))
	}
	if d := detailOf(t, results[7]); results[7].Passed || d.TotalCount != 0 || d.MissCount != 0 || len(d.Misses) != 0 {
		t.Errorf("any over zero records fails: %+v %+v", results[7], d)
	}
	for _, i := range []int{8, 9} {
		if !results[i].Passed || results[i].Advisory != nil {
			t.Errorf("count and distinct compare 0, with no advisory: %+v", results[i])
		}
	}
}

func TestAnEmptyOutputIsZeroRecords(t *testing.T) {
	for _, output := range []string{"", "  \n"} {
		results := run(t, "logs", &output, "", ottlRule("log", "any", "true"), ottlRule("log", "all", "true"))
		if results[0].Passed || !results[1].Passed || results[0].Error != nil {
			t.Errorf("%q: %+v", output, results)
		}
	}
}

func TestATruncatedOutputPerKind(t *testing.T) {
	logs := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"hello"}}]}]}]}`
	in := Input{Signal: "logs", OutputPresent: true, Truncated: true, Log: "hello", MaxOutputObjects: DefaultMaxOutputObjects, Rules: []Rule{
		textRule(KindContainsText, "hello"),
		textRule(KindNotContainsText, "hello"),
		textRule(KindContainsRegex, "nope"),
		textRule(KindNotContainsRegex, "nope"),
		ottlRule("log", "all", `body == "hello"`),
		ottlRule("spanevent", "all", "true"), // a rule error
		stderrRule(KindContainsText, "hello"),
		ottlRule("scope", "none", "true"), // no scope? one scope: fails
	}}
	results := runInput(t, in, &logs)
	for i := 0; i < 5; i++ {
		if advisoryOf(results[i]) != TruncatedAdvisory {
			t.Errorf("output rule %d: advisory %q", i, advisoryOf(results[i]))
		}
	}
	if results[5].Error == nil || results[5].Advisory != nil {
		t.Errorf("a rule's error carries no advisory: %+v", results[5])
	}
	if results[6].Advisory != nil {
		t.Errorf("a log rule isn't about the output: %+v", results[6])
	}
	if !results[0].Passed || results[1].Passed || results[2].Passed || !results[3].Passed || !results[4].Passed || results[7].Passed {
		t.Errorf("verdicts: %+v", results)
	}
	// Both advisories at once: zero records of a context, and a cut output.
	in.Rules = []Rule{ottlRule("log", "none", `body == "nope"`), ottlRule("log", "all", `body == "x"`)}
	empty := `{"resourceLogs":[]}`
	results = runInput(t, in, &empty)
	if want := "No log records in the output: none holds only because there was nothing to check. " + TruncatedAdvisory; advisoryOf(results[0]) != want {
		t.Errorf("advisory %q", advisoryOf(results[0]))
	}
}

func TestOTTLReadsTheRecordsWrapper(t *testing.T) {
	// The tester's {"records":[…]}: pdata would read the wrapper as an empty
	// document, and every all rule would pass: the wrapper is unwrapped.
	results := run(t, "logs", strPtr(twoRecords), "",
		countRule("log", "true", "eq", 3),
		ottlRule("log", "all", `attributes["env"] == "prod"`),
		countRule("resource", "true", "eq", 2),
	)
	for _, r := range results[:1] {
		if !r.Passed {
			t.Errorf("three log records across two documents: %+v", r)
		}
	}
	if d := detailOf(t, results[1]); results[1].Passed || d.TotalCount != 3 || d.MatchedCount != 1 || d.MissCount != 2 {
		t.Errorf("all over the unwrapped records: %+v", d)
	}
	if !results[2].Passed {
		t.Errorf("two resources: %+v", results[2])
	}
	// One document unwrapped, a JSON array and NDJSON still read.
	for _, output := range []string{
		`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{},{}]}]}]}`,
		`[{"resourceLogs":[{"scopeLogs":[{"logRecords":[{}]}]}]},{"resourceLogs":[{"scopeLogs":[{"logRecords":[{}]}]}]}]`,
		`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{}]}]}]}` + "\n" + `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{}]}]}]}`,
	} {
		if r := run(t, "logs", &output, "", countRule("log", "true", "eq", 2))[0]; !r.Passed {
			t.Errorf("%s: %+v", output, r)
		}
	}
}

func TestAnOutputThatIsntOTLPErrorsEachOTTLRuleOnly(t *testing.T) {
	for _, c := range []struct{ name, output, want string }{
		{"not JSON", "plain text", "The output isn't OTLP/JSON logs"},
		{"another signal", `{"resourceSpans":[]}`, "The output isn't OTLP/JSON logs"},
		{"a record of another signal", `{"records":[{"resourceLogs":[]},{"resourceMetrics":[]}]}`, "Record 2 of the output isn't OTLP/JSON logs"},
		{"an array of numbers", `[1,2]`, "Record 1 of the output isn't OTLP/JSON logs"},
	} {
		t.Run(c.name, func(t *testing.T) {
			results := run(t, "logs", &c.output, "",
				ottlRule("log", "all", "true"),
				textRule(KindNotContainsText, "secret"),
				ottlRule("resource", "any", "true"))
			for _, i := range []int{0, 2} {
				if results[i].Passed || !strings.HasPrefix(errorOf(results[i]), c.want) {
					t.Errorf("OTTL rule %d: %+v", i, results[i])
				}
			}
			if !results[1].Passed || results[1].Error != nil {
				t.Errorf("the text rule still runs: %+v", results[1])
			}
		})
	}
}

func TestPastTheObjectCapOTTLRulesErrAndTextRulesRun(t *testing.T) {
	output := `{"records":[` + strings.Repeat(`{"resourceLogs":[]},`, 9) + `{"resourceLogs":[]}]}`
	in := Input{Signal: "logs", OutputPresent: true, MaxOutputObjects: 10, Rules: []Rule{
		ottlRule("log", "all", "true"),
		textRule(KindContainsText, "resourceLogs"),
	}}
	results := runInput(t, in, &output)
	if errorOf(results[0]) != OutputTooLarge {
		t.Errorf("11 objects over a cap of 10: %+v", results[0])
	}
	if !results[1].Passed {
		t.Errorf("text rules run: %+v", results[1])
	}
	in.MaxOutputObjects = 11
	if results = runInput(t, in, &output); results[0].Error != nil {
		t.Errorf("11 objects within a cap of 11: %+v", results[0])
	}
}

func TestAnOTTLRulesOwnErrorFailsIt(t *testing.T) {
	logs := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"a"}}]}]}]}`
	results := run(t, "logs", &logs, "",
		ottlRule("log", "all", `Substring(body, 5, 1) == "x"`), // an error at run time
		ottlRule("span", "all", "true"),                        // a context logs doesn't have
		ottlRule("log", "all", `attributes[`),                  // a syntax error
		ottlRule("log", "all", `body == "a"`),
	)
	if results[0].Passed || !strings.Contains(errorOf(results[0]), "condition evaluation failed on 1 of 1 records") {
		t.Errorf("an error at run time: %+v", results[0])
	}
	if !strings.Contains(errorOf(results[1]), `can't use the "span" context: use log, resource or scope`) {
		t.Errorf("context: %+v", results[1])
	}
	if !strings.HasPrefix(errorOf(results[2]), "OTTL syntax error: ") {
		t.Errorf("syntax: %+v", results[2])
	}
	if !results[3].Passed {
		t.Errorf("the other rules are unaffected: %+v", results[3])
	}
}

// countingCheckpoint fails from its failAt-th call on.
type countingCheckpoint struct {
	calls, failAt int
}

var errTestDeadline = errors.New("the test's deadline")

func (c *countingCheckpoint) check() error {
	c.calls++
	if c.failAt > 0 && c.calls >= c.failAt {
		return errTestDeadline
	}
	return nil
}

// manyLogs is one document of n log records.
func manyLogs(n int) string {
	return `{"resourceLogs":[{"scopeLogs":[{"logRecords":[` +
		strings.TrimSuffix(strings.Repeat(`{"body":{"stringValue":"x"}},`, n), ",") + `]}]}]}`
}

// The deadline ends the work inside a rule's record loop: the rule it
// stopped in and every rule after it are "Not checked". The checkpoint's
// calls: 1, before the first rule; 2, before the output's one document;
// 3, at the 256th record. Failing from call 3 stops the first rule inside
// its record loop; without that loop's check, the first rule would finish.
func TestTheDeadlineEndsWorkInsideTheRecordLoop(t *testing.T) {
	output := manyLogs(2000)
	rules := []Rule{ottlRule("log", "all", `body == "x"`), textRule(KindContainsText, "x")}
	in := Input{Signal: "logs", OutputPresent: true, Rules: rules, MaxOutputObjects: DefaultMaxOutputObjects}

	// Unstopped, the evaluation calls the checkpoint more than three times.
	free := &countingCheckpoint{}
	var all []Result
	if err := Evaluate(in, []byte(output), free.check, func(r Result) error { all = append(all, r); return nil }); err != nil || len(all) != 2 {
		t.Fatalf("unstopped: %v, %d results", err, len(all))
	}
	if free.calls <= 3 {
		t.Errorf("only %d checkpoint calls: none in the record loops", free.calls)
	}

	stopping := &countingCheckpoint{failAt: 3}
	var got []Result
	err := Evaluate(in, []byte(output), stopping.check, func(r Result) error { got = append(got, r); return nil })
	if !errors.Is(err, errTestDeadline) {
		t.Fatalf("Evaluate returned %v, want the checkpoint's error", err)
	}
	if len(got) != 0 {
		t.Fatalf("the first rule finished: %+v", got)
	}
	results := Complete(rules, got, NotCheckedDeadline)
	for i, r := range results {
		if r.ID != rules[i].ID || r.Passed || errorOf(r) != NotCheckedDeadline || r.Detail != nil || r.Advisory != nil {
			t.Errorf("rule %d: %+v", i, r)
		}
	}
}

// The text matcher checks every 4,096 candidate positions: a deadline ends
// a search with many candidates and no match.
func TestTheDeadlineEndsTheTextMatcher(t *testing.T) {
	output := strings.Repeat("a ", 3*checkEveryCandidates) // short: no 64 KiB scan check first
	in := Input{Signal: "logs", OutputPresent: true, MaxOutputObjects: DefaultMaxOutputObjects,
		Rules: []Rule{textRule(KindContainsText, "a b")}}
	stopping := &countingCheckpoint{failAt: 2} // 1: before the rule; 2: the 4,096th candidate
	err := Evaluate(in, []byte(output), stopping.check, func(Result) error {
		t.Fatal("the rule finished")
		return nil
	})
	if !errors.Is(err, errTestDeadline) {
		t.Fatalf("Evaluate returned %v", err)
	}
}

func TestCompleteKeepsFinishedRulesAndMarksTheRest(t *testing.T) {
	rules := []Rule{textRule(KindContainsText, "a"), textRule(KindContainsText, "b"), textRule(KindContainsText, "c")}
	got := []Result{{ID: rules[0].ID, Passed: true}}
	results := Complete(rules, got, NotCheckedMemory)
	if !results[0].Passed || errorOf(results[1]) != NotCheckedMemory || errorOf(results[2]) != NotCheckedMemory {
		t.Fatalf("%+v", results)
	}
}
