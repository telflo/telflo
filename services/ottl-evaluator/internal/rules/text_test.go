// New in D15a Task 2: text rules' whitespace tolerance (spec decision 8;
// plan Preflight ruling 6), each failure detail's shape, the snippets' caps
// and a match's record (Preflight ruling 5). D15a Task 3's follow-up (the
// controller's Ruling 34) adds TestRecordMismatchListsTheMissesItCounts.

package rules

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestWhitespaceTolerance(t *testing.T) {
	cases := []struct {
		name, output, pattern string
		matches               bool
	}{
		// Ana's text copied from the viewer, against the stored compact JSON.
		{"viewer text matches compact JSON", `{"key":"env","value":{"stringValue":"prod"}}`, `"stringValue": "prod"`, true},
		{"no whitespace matches none", "apikey", "api key", true},
		{"one space matches a run", "api   key", "api key", true},
		{"a space matches a tab", "api\tkey", "api key", true},
		{"a space matches a newline", "api\nkey", "api key", true},
		{"a no-break space is whitespace", "api key", "api\u00a0key", true},
		{"no-break space in the output is whitespace", "api\u00a0key", "api key", true},
		{"whitespace isn't added inside a token", "disk full", "diskfull", false},
		{"leading and trailing whitespace ignored", `{"env":"prod"}`, "  prod\t\n", true},
		{"a JSON escape is two characters, not whitespace", `api\nkey`, "api key", false},
		{"tokens are case-sensitive", "API KEY", "api key", false},
		{"tokens are in order", "key api", "api key", false},
		{"every token is needed", "api", "api key", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := one(t, c.output, textRule(KindContainsText, c.pattern))
			if r.Passed != c.matches || r.Error != nil {
				t.Fatalf("contains %q in %q: passed=%v error=%q, want %v", c.pattern, c.output, r.Passed, errorOf(r), c.matches)
			}
			r = one(t, c.output, textRule(KindNotContainsText, c.pattern))
			if r.Passed == c.matches {
				t.Fatalf("not contains %q in %q: passed=%v", c.pattern, c.output, r.Passed)
			}
		})
	}
}

func TestRegexMatchesExactly(t *testing.T) {
	// The same texts as whitespace tolerance's, as patterns: no tolerance.
	for _, c := range []struct{ output, pattern string }{
		{`{"stringValue":"prod"}`, `"stringValue": "prod"`},
		{"apikey", "api key"},
		{"api   key", "api key"},
	} {
		if r := one(t, c.output, textRule(KindContainsRegex, c.pattern)); r.Passed {
			t.Errorf("regex %q matched %q", c.pattern, c.output)
		}
	}
	if r := one(t, "api key", textRule(KindContainsRegex, "api key")); !r.Passed {
		t.Errorf("an exact regex should match: %+v", r)
	}
}

func TestATextOfOnlyWhitespaceIsTheRulesError(t *testing.T) {
	for _, kind := range []string{KindContainsText, KindNotContainsText} {
		r := one(t, "anything", textRule(kind, " \t\u00a0\n"))
		if r.Passed || errorOf(r) != EmptyText {
			t.Errorf("%s: %+v", kind, r)
		}
	}
}

func TestMatchesAreLeftmostAndNonOverlapping(t *testing.T) {
	r := one(t, "a a a a a", textRule(KindNotContainsText, "a a"))
	d := detailOf(t, r)
	if d.TotalMatchCount != 2 || d.Matches[0].Text != "a a" || d.Matches[0].Before != "" || d.Matches[1].Before != "a a " {
		t.Fatalf("%+v", d)
	}
	// A match is the tokens and the whitespace between them, never around.
	r = one(t, "x  api   key  y", textRule(KindNotContainsText, "api key"))
	if m := detailOf(t, r).Matches[0]; m.Text != "api   key" || m.Before != "x  " || m.After != "  y" {
		t.Fatalf("%+v", m)
	}
}

// New in D15a's final fix wave (Ruling 55): a not-contains regex whose only
// matches are empty fails with no detail to show, so its advisory says why,
// counting them and never quoting what it searched.
func TestOnlyEmptyMatchesFailWithAnAdvisory(t *testing.T) {
	const secret = "token=hunter2"
	cases := []struct {
		name, output, pattern, want string
		truncated, stderr           bool
	}{
		{name: "x* everywhere", output: "abc", pattern: "x*",
			want: "The pattern matched only empty text (4 times), so there is no match to show."},
		{name: "^ once", output: secret, pattern: "^",
			want: "The pattern matched only empty text (once), so there is no match to show."},
		{name: `\b at word edges`, output: "ab cd", pattern: `\b`,
			want: "The pattern matched only empty text (4 times), so there is no match to show."},
		{name: "on the log", output: "", pattern: `$`, stderr: true,
			want: "The pattern matched only empty text (once), so there is no match to show."},
		{name: "thousands grouped", output: strings.Repeat("b", 1233), pattern: "x*",
			want: "The pattern matched only empty text (1,234 times), so there is no match to show."},
		{name: "past the count", output: strings.Repeat("b", maxCountedMatches+5), pattern: "x*",
			want: "The pattern's first 100,000 matches were all empty text, so there is no match to show."},
		{name: "with a cut output", output: secret, pattern: "^", truncated: true,
			want: "The pattern matched only empty text (once), so there is no match to show. " + TruncatedAdvisory},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rule := textRule(KindNotContainsRegex, c.pattern)
			output, log := c.output, ""
			if c.stderr {
				rule = stderrRule(KindNotContainsRegex, c.pattern)
				log = secret
			}
			in := Input{Signal: "logs", OutputPresent: true, Truncated: c.truncated, Log: log, Rules: []Rule{rule}, MaxOutputObjects: DefaultMaxOutputObjects}
			r := runInput(t, in, &output)[0]
			if r.Passed || r.Error != nil || !noDetail(r) {
				t.Fatalf("want failed, no error, no detail: %+v", r)
			}
			if advisoryOf(r) != c.want {
				t.Fatalf("advisory %q, want %q", advisoryOf(r), c.want)
			}
			if strings.Contains(advisoryOf(r), "hunter2") {
				t.Fatalf("the advisory quotes the text searched: %q", advisoryOf(r))
			}
		})
	}
	// A pattern with an empty and a non-empty match shows the non-empty one,
	// and no advisory.
	r := one(t, "bxb", textRule(KindNotContainsRegex, "x*"))
	if d := detailOf(t, r); d.TotalMatchCount != 1 || d.Matches[0].Text != "x" || r.Advisory != nil {
		t.Fatalf("%+v %+v", r, d)
	}
}

// Each detail kind carries exactly its members (openapi.yaml's
// additionalProperties: false).
func TestEachFailureDetailsShape(t *testing.T) {
	logs := `{"resourceLogs":[{"resource":{},"scopeLogs":[{"scope":{},"logRecords":[` +
		`{"body":{"stringValue":"a"},"attributes":[{"key":"pod","value":{"stringValue":"p1"}}]},` +
		`{"body":{"stringValue":"b"},"attributes":[{"key":"pod","value":{"stringValue":"p2"}}]}]}]}]}`
	distinct := ottlRule("log", "distinct", "")
	distinct.OTTL.Expression = strPtr(`attributes["pod"]`)
	distinct.OTTL.Count = &Count{Operator: "lte", Value: 1}
	results := run(t, "logs", &logs, "",
		textRule(KindContainsText, "nowhere"),
		textRule(KindNotContainsText, "stringValue"),
		ottlRule("log", "all", `body == "a"`),
		distinct,
	)
	want := []struct {
		kind    string
		members []string
	}{
		{"no_match", []string{"kind", "source", "searchedCharacters"}},
		{"unexpected_match", []string{"kind", "source", "totalMatchCount", "moreMatches", "matches"}},
		{"record_mismatch", []string{"kind", "context", "totalCount", "matchedCount", "missCount", "misses"}},
		{"distinct_mismatch", []string{"kind", "totalCount", "matchedCount", "distinctCount", "samples"}},
	}
	for i, w := range want {
		r := results[i]
		if r.Passed || r.Error != nil {
			t.Fatalf("rule %d should fail without an error: %+v", i, r)
		}
		keys := detailKeys(t, r)
		if len(keys) != len(w.members) {
			t.Errorf("%s has %v, want %v", w.kind, keys, w.members)
		}
		for _, m := range w.members {
			if !keys[m] {
				t.Errorf("%s lacks %s: %v", w.kind, m, keys)
			}
		}
		if d := detailOf(t, r); d.Kind != w.kind {
			t.Errorf("rule %d: kind %s, want %s", i, d.Kind, w.kind)
		}
	}
	// A match's members, and its record's.
	var unexpected struct {
		Matches []map[string]json.RawMessage `json:"matches"`
	}
	if err := json.Unmarshal(results[1].Detail, &unexpected); err != nil {
		t.Fatal(err)
	}
	for _, m := range unexpected.Matches {
		if len(m) != 5 || m["text"] == nil || m["textTruncated"] == nil || m["before"] == nil || m["after"] == nil || m["record"] == nil {
			t.Errorf("a match's members: %v", m)
		}
		var record map[string]json.RawMessage
		if err := json.Unmarshal(m["record"], &record); err != nil || len(record) != 2 || record["index"] == nil || record["path"] == nil {
			t.Errorf("an output match's record: %s", m["record"])
		}
	}
	d := detailOf(t, results[2])
	if d.Context != "log" || d.TotalCount != 2 || d.MatchedCount != 1 || d.MissCount != 1 || len(d.Misses) != 1 ||
		d.Misses[0].Index != 1 || d.Misses[0].Reason != "condition evaluated to false" || !strings.Contains(d.Misses[0].Snippet, `"b"`) {
		t.Errorf("record_mismatch: %+v", d)
	}
	d = detailOf(t, results[3])
	if d.TotalCount != 2 || d.MatchedCount != 2 || d.DistinctCount != 2 || len(d.Samples) != 2 {
		t.Errorf("distinct_mismatch: %+v", d)
	}
}

// A failing any lists its first five misses as all does, so misses agree
// with missCount; a failing count lists none, and says so with an empty
// array (openapi.yaml's RecordMismatch).
func TestRecordMismatchListsTheMissesItCounts(t *testing.T) {
	logs := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[` +
		strings.Repeat(`{"body":{"stringValue":"b"}},`, 6) + `{"body":{"stringValue":"b"}}]}]}]}`
	results := run(t, "logs", &logs, "",
		ottlRule("log", "any", `body == "a"`),
		ottlRule("log", "all", `body == "a"`),
		ottlRule("log", "none", `body == "b"`),
		countRule("log", "true", "eq", 3),
	)
	for i, reason := range []string{"condition evaluated to false", "condition evaluated to false", "unexpected match"} {
		d := detailOf(t, results[i])
		if results[i].Passed || d.Kind != "record_mismatch" || d.TotalCount != 7 || d.MissCount != 7 || len(d.Misses) != 5 {
			t.Fatalf("rule %d: %+v", i, d)
		}
		for j, m := range d.Misses {
			if m.Index != j || m.Reason != reason || !strings.Contains(m.Snippet, `"b"`) {
				t.Errorf("rule %d's miss %d: %+v", i, j, m)
			}
		}
	}
	d := detailOf(t, results[3])
	if results[3].Passed || d.TotalCount != 7 || d.MatchedCount != 7 || d.MissCount != 0 || d.Misses == nil || len(d.Misses) != 0 {
		t.Errorf("count: %+v", d)
	}
	if !strings.Contains(string(results[3].Detail), `"misses":[]`) {
		t.Errorf("count's misses is an empty array: %s", results[3].Detail)
	}
}

func TestSnippetsAreCapped(t *testing.T) {
	t.Run("at most five matches, all counted", func(t *testing.T) {
		r := one(t, strings.Repeat("hit,", 12), textRule(KindNotContainsRegex, "hit"))
		if d := detailOf(t, r); len(d.Matches) != 5 || d.TotalMatchCount != 12 || d.MoreMatches {
			t.Fatalf("%+v", d)
		}
	})
	t.Run("past 100,000 matches the count stops and says so", func(t *testing.T) {
		r := one(t, strings.Repeat("x", maxCountedMatches+7), textRule(KindNotContainsText, "x"))
		if d := detailOf(t, r); d.TotalMatchCount != maxCountedMatches || !d.MoreMatches || len(d.Matches) != 5 {
			t.Fatalf("text: total %d more %v", d.TotalMatchCount, d.MoreMatches)
		}
		r = one(t, strings.Repeat("x", maxCountedMatches+7), textRule(KindNotContainsRegex, "x"))
		if d := detailOf(t, r); d.TotalMatchCount != maxCountedMatches || !d.MoreMatches {
			t.Fatalf("regex: total %d more %v", d.TotalMatchCount, d.MoreMatches)
		}
	})
	t.Run("text 200 bytes, on a rune boundary", func(t *testing.T) {
		r := one(t, strings.Repeat("€", 150), textRule(KindNotContainsRegex, "€+"))
		m := detailOf(t, r).Matches[0]
		if len(m.Text) > 200 || len(m.Text) < 197 || !utf8.ValidString(m.Text) || !m.TextTruncated {
			t.Fatalf("text %d bytes, valid %v, truncated %v", len(m.Text), utf8.ValidString(m.Text), m.TextTruncated)
		}
	})
	t.Run("context 40 bytes each side, on rune boundaries", func(t *testing.T) {
		output := "x" + strings.Repeat("é", 50) + "hit" + strings.Repeat("€", 50)
		r := one(t, output, textRule(KindNotContainsText, "hit"))
		m := detailOf(t, r).Matches[0]
		if len(m.Before) > 40 || len(m.After) > 40 || !utf8.ValidString(m.Before) || !utf8.ValidString(m.After) {
			t.Fatalf("before %d %q, after %d %q", len(m.Before), m.Before, len(m.After), m.After)
		}
		if m.Before != strings.Repeat("é", 20) || m.After != strings.Repeat("€", 13) {
			t.Fatalf("before %q, after %q", m.Before, m.After)
		}
	})
	t.Run("a miss's snippet 200 bytes and a sample 120", func(t *testing.T) {
		long := strings.Repeat("ü", 300)
		logs := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"` + long + `"}}]}]}]}`
		distinct := ottlRule("log", "distinct", "")
		distinct.OTTL.Expression = strPtr("body")
		distinct.OTTL.Count = &Count{Operator: "eq", Value: 0}
		results := run(t, "logs", &logs, "", ottlRule("log", "none", "true"), distinct)
		snippet := detailOf(t, results[0]).Misses[0].Snippet
		if len(snippet) > 200 || !utf8.ValidString(snippet) || !strings.HasSuffix(snippet, "…") {
			t.Fatalf("snippet %d bytes: %q", len(snippet), snippet)
		}
		sample := detailOf(t, results[1]).Samples[0]
		if len(sample) > 120 || !utf8.ValidString(sample) || !strings.HasSuffix(sample, "…") {
			t.Fatalf("sample %d bytes: %q", len(sample), sample)
		}
	})
	t.Run("a message 4 KiB", func(t *testing.T) {
		long := strings.Repeat("(", 4000) + strings.Repeat("a", 4000)
		r := one(t, "x", textRule(KindContainsRegex, long))
		if len(errorOf(r)) > maxMessageBytes || !strings.HasPrefix(errorOf(r), "Invalid regex: ") {
			t.Fatalf("error %d bytes", len(errorOf(r)))
		}
	})
}

// The tester's form: several records as {"records":[…]}, compact.
const twoRecords = `{"records":[` +
	`{"resourceLogs":[{"resource":{},"scopeLogs":[{"scope":{},"logRecords":[{"body":{"stringValue":"user logged in"},"attributes":[{"key":"env","value":{"stringValue":"prod"}}]}]}]}]},` +
	`{"resourceLogs":[{"resource":{},"scopeLogs":[{"scope":{},"logRecords":[{"body":{"stringValue":"ok"}},{"body":{"stringValue":"payment failed"},"attributes":[{"key":"card","value":{"stringValue":"4111"}}]}]}]}]}` +
	`]}`

func recordOfMatch(t *testing.T, output string, rule Rule, n int) map[string]any {
	t.Helper()
	d := detailOf(t, one(t, output, rule))
	if len(d.Matches) <= n {
		t.Fatalf("only %d matches", len(d.Matches))
	}
	return d.Matches[n].Record
}

func TestAMatchsRecordIsNamed(t *testing.T) {
	cases := []struct {
		name, output, pattern string
		index                 any
		path                  string
	}{
		{"inside a string, second record", twoRecords, "payment failed",
			float64(1), "resourceLogs[0].scopeLogs[0].logRecords[1].body.stringValue"},
		{"across a key and its value: the object holding both", twoRecords, `"stringValue": "prod"`,
			float64(0), "resourceLogs[0].scopeLogs[0].logRecords[0].attributes[0].value"},
		{"a key alone: its object", twoRecords, "attributes",
			float64(0), "resourceLogs[0].scopeLogs[0].logRecords[0]"},
		{"a number's digits", `{"records":[{"a":1},{"resourceLogs":[],"n":12345}]}`, "234",
			float64(1), "n"},
		{"the record's own brace", twoRecords, `{"resourceLogs"`, float64(0), ""},
		{"the wrapper's text: no record", twoRecords, "records", nil, ""},
		{"across two records: the first, no path", twoRecords, `]}]}]},{"resourceLogs"`, float64(0), ""},
		{"one unwrapped document is record 0", `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"boom"}}]}]}]}`, "boom",
			float64(0), "resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue"},
		{"a key that isn't an identifier", `{"records":[{"a":1},{"service.name":"x y"}]}`, "x y",
			float64(1), `["service.name"]`},
		{"output that isn't JSON: no record", "plain text, payment failed", "payment failed", nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			record := recordOfMatch(t, c.output, textRule(KindNotContainsText, c.pattern), 0)
			if record["index"] != c.index || record["path"] != c.path {
				t.Fatalf("record %v, want index %v path %q", record, c.index, c.path)
			}
		})
	}
	t.Run("each of several matches", func(t *testing.T) {
		d := detailOf(t, one(t, twoRecords, textRule(KindNotContainsRegex, `"stringValue":"[^"]+"`)))
		want := []struct {
			index float64
			path  string
		}{
			{0, "resourceLogs[0].scopeLogs[0].logRecords[0].body"},
			{0, "resourceLogs[0].scopeLogs[0].logRecords[0].attributes[0].value"},
			{1, "resourceLogs[0].scopeLogs[0].logRecords[0].body"},
			{1, "resourceLogs[0].scopeLogs[0].logRecords[1].body"},
			{1, "resourceLogs[0].scopeLogs[0].logRecords[1].attributes[0].value"},
		}
		if len(d.Matches) != len(want) {
			t.Fatalf("%d matches", len(d.Matches))
		}
		for i, w := range want {
			if r := d.Matches[i].Record; r["index"] != w.index || r["path"] != w.path {
				t.Errorf("match %d: %v, want %v %q", i, r, w.index, w.path)
			}
		}
	})
	t.Run("a long path keeps its end", func(t *testing.T) {
		deep := strings.Repeat(`{"averyveryverylongkeyname":`, 20) + `"needle"` + strings.Repeat("}", 20)
		record := recordOfMatch(t, deep, textRule(KindNotContainsText, "needle"), 0)
		path, _ := record["path"].(string)
		if len(path) > 200 || !strings.HasPrefix(path, "….averyveryverylongkeyname") || !strings.HasSuffix(path, "averyveryverylongkeyname") {
			t.Fatalf("path %d bytes: %q", len(path), path)
		}
	})
	t.Run("a log match's line", func(t *testing.T) {
		log := "one\ntwo ERROR\nthree\nfour ERROR ERROR\n"
		d := detailOf(t, oneLog(t, "{}", log, stderrRule(KindNotContainsText, "ERROR")))
		lines := []float64{2, 4, 4}
		for i, m := range d.Matches {
			if len(m.Record) != 1 || m.Record["line"] != lines[i] {
				t.Errorf("match %d: %v, want line %v", i, m.Record, lines[i])
			}
		}
	})
}

func TestScanFactsFindsTheWrapper(t *testing.T) {
	cases := []struct {
		output           string
		wellFormed, wrap bool
		records, objects int
	}{
		{twoRecords, true, true, 2, 21},
		{`{"records":[]}`, true, true, 0, 1},
		{` { "records" : [ {"a":1} , {"b":[2]} ] } `, true, true, 2, 3},
		{`{"records":[{"a":1}],"other":1}`, true, false, 0, 2},
		{`{"other":1,"records":[{"a":1}]}`, true, false, 0, 2},
		{`{"records":{"a":1}}`, true, false, 0, 2},
		{`{"resourceLogs":[]}`, true, false, 0, 1},
		{`{"a":"{{{"}`, true, false, 0, 1},
		{`{"a":1}{"b":2}`, true, false, 0, 2},
		{`[{"a":1}]`, true, false, 0, 1},
		{`{"a":[}`, false, false, 0, 1},
		{`"text"`, false, false, 0, 0},
		{`plain text`, false, false, 0, 0},
		{``, false, false, 0, 0},
	}
	for _, c := range cases {
		f, err := scanFacts([]byte(c.output), newWork(nil))
		if err != nil {
			t.Fatal(err)
		}
		if f.wellFormed != c.wellFormed || f.wrapped != c.wrap || len(f.records) != c.records || (c.wellFormed && f.objects != c.objects) {
			t.Errorf("%q: %+v", c.output, f)
		}
	}
	f, _ := scanFacts([]byte(` { "records" : [ {"a":1} , {"b":[2]} ] } `), newWork(nil))
	got := []string{}
	for _, span := range f.records {
		got = append(got, ` { "records" : [ {"a":1} , {"b":[2]} ] } `[span[0]:span[1]])
	}
	if fmt.Sprint(got) != `[{"a":1} {"b":[2]}]` {
		t.Errorf("record spans: %q", got)
	}
}
