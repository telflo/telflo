// New in D15a Task 2 (plan Preflight ruling 10): the child processes' entry
// points, run in-process over pipes; internal/server's tests run them as
// real processes.

package rules

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func evaluateChildInput(t *testing.T, header EvaluateHeader, output string) *bytes.Buffer {
	t.Helper()
	header.OutputBytes = len(output)
	line, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewBufferString(string(line) + "\n" + output)
}

func resultLines(t *testing.T, out string) []Result {
	t.Helper()
	var results []Result
	for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		var r Result
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("line %q: %v", line, err)
		}
		results = append(results, r)
	}
	return results
}

func fixedClock(at time.Time) func() time.Time { return func() time.Time { return at } }

func TestTheEvaluateChildWritesALinePerRule(t *testing.T) {
	output := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"hello"}}]}]}]}`
	header := EvaluateHeader{
		Input: Input{Signal: "logs", OutputPresent: true, Log: "WARN x\n", MaxOutputObjects: DefaultMaxOutputObjects, Rules: []Rule{
			textRule(KindContainsText, "hello"),
			stderrRule(KindNotContainsText, "WARN"),
			ottlRule("log", "all", `body == "hello"`),
		}},
		SoftDeadline: 20 * time.Second,
	}
	var out bytes.Buffer
	code := RunEvaluateChild(evaluateChildInput(t, header, output), &out, fixedClock(time.Unix(0, 0)))
	if code != ExitDone {
		t.Fatalf("exit %d", code)
	}
	results := resultLines(t, out.String())
	if len(results) != 3 || !results[0].Passed || results[1].Passed || !results[2].Passed {
		t.Fatalf("%+v", results)
	}
}

// A soft deadline already past stops the child before its first rule: it
// writes nothing and exits ExitDeadline.
func TestTheEvaluateChildStopsAtItsDeadline(t *testing.T) {
	header := EvaluateHeader{
		Input:        Input{Signal: "logs", Rules: []Rule{textRule(KindContainsText, "x")}, MaxOutputObjects: DefaultMaxOutputObjects},
		SoftDeadline: 0,
	}
	var out bytes.Buffer
	if code := RunEvaluateChild(evaluateChildInput(t, header, ""), &out, fixedClock(time.Unix(0, 0))); code != ExitDeadline {
		t.Fatalf("exit %d", code)
	}
	if out.Len() != 0 {
		t.Fatalf("wrote %q", out.String())
	}
}

func TestTheEvaluateChildRefusesABadInput(t *testing.T) {
	for _, input := range []string{"", "not json\n", `{"outputBytes":5}` + "\nab"} {
		var out bytes.Buffer
		if code := RunEvaluateChild(strings.NewReader(input), &out, time.Now); code != ExitInput {
			t.Errorf("%q: exit %d", input, code)
		}
	}
}

func TestTheValidateChildNamesItsStepsThenItsProblems(t *testing.T) {
	r := distinctRule("log", "attributes[", "eq", 1)
	r.ID = ""
	in, _ := json.Marshal(ValidateInput{Signal: "logs", Rule: r})
	var out bytes.Buffer
	if code := RunValidateChild(bytes.NewReader(in), &out); code != ExitDone {
		t.Fatalf("exit %d", code)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || lines[0] != `{"checking":"ottl.expression"}` {
		t.Fatalf("lines %q", lines)
	}
	var last ValidateLine
	if err := json.Unmarshal([]byte(lines[1]), &last); err != nil || last.Problems == nil || len(*last.Problems) != 1 {
		t.Fatalf("last %q: %v", lines[1], err)
	}
	if p := (*last.Problems)[0]; p.Field != FieldExpression || p.Message == "" {
		t.Fatalf("%+v", p)
	}

	in, _ = json.Marshal(ValidateInput{Signal: "logs", Rule: Rule{Kind: KindContainsText, Target: TargetOutput, Pattern: strPtr("ok")}})
	out.Reset()
	RunValidateChild(bytes.NewReader(in), &out)
	if strings.TrimSpace(out.String()) != `{"problems":[]}` {
		t.Fatalf("a valid rule: %q", out.String())
	}
}
