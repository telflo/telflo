// Save (validate) and a run (evaluate) word a rule's problem identically,
// since the platform shows the message as it is.

package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

func TestSaveAndARunWordAProblemAlike(t *testing.T) {
	ts := newTestServer(t)
	output := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"x"}}]}]}]}`
	cases := []struct {
		name, rule, prefix string
	}{
		{"an OTTL parse error", `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":"attributes[\"env\"] == \"prod"}}`, rules.SyntaxErrorPrefix},
		{"an expression's parse error", `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"distinct","expression":"attributes[","count":{"operator":"eq","value":1}}}`, rules.SyntaxErrorPrefix},
		{"a regex compile error", `{"kind":"contains_regex","target":"output","pattern":"(unclosed"}`, rules.InvalidRegexPrefix},
		{"a regex RE2 refuses", `{"kind":"not_contains_regex","target":"stderr","pattern":"(?=x)"}`, rules.InvalidRegexPrefix},
		{"nesting past 12", `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":` + jsonQuote(strings.Repeat("Len(", 13)+"body"+strings.Repeat(")", 13)+" > 0") + `}}`, ""},
		{"a single-escaped \\b", `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":"IsMatch(body, \"\\bx\")"}}`, ""},
		{"a context the signal lacks", `{"kind":"ottl","target":"output","ottl":{"context":"span","quantifier":"all","condition":"true"}}`, ""},
		{"an empty pattern", `{"kind":"contains_regex","target":"output","pattern":"  "}`, ""},
		{"a text of only whitespace", `{"kind":"contains_text","target":"output","pattern":" \t "}`, ""},
		{"between backwards", `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"between","value":5,"value2":2}}}`, ""},
	}
	// One run checks every rule (one child), then Save checks each.
	var withIDs []string
	for i, c := range cases {
		withIDs = append(withIDs, `{"id":"r`+strconv.Itoa(i)+`",`+strings.TrimPrefix(c.rule, "{"))
	}
	results := decodeAnswer(t, ts.post(evaluatePath, evaluateBody("logs", &output, "log", withIDs...))).Results
	if len(results) != len(cases) {
		t.Fatalf("%d results for %d rules", len(results), len(cases))
	}
	for i, c := range cases {
		rec := ts.post(validatePath, `{"signal":"logs","rule":`+c.rule+`}`)
		var validated struct {
			Valid    bool            `json:"valid"`
			Problems []rules.Problem `json:"problems"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &validated) != nil || validated.Valid || len(validated.Problems) == 0 {
			t.Fatalf("%s: validate %d %s", c.name, rec.Code, rec.Body.String())
		}
		saved, ran := validated.Problems[0].Message, resultError(results[i])
		if saved != ran {
			t.Errorf("%s: Save says %q, a run says %q", c.name, saved, ran)
		}
		if c.prefix != "" && !strings.HasPrefix(saved, c.prefix) {
			t.Errorf("%s: %q should start %q", c.name, saved, c.prefix)
		}
		if c.prefix == "" && (strings.HasPrefix(saved, rules.SyntaxErrorPrefix) || strings.HasPrefix(saved, rules.InvalidRegexPrefix)) {
			t.Errorf("%s: %q is in its own words, with no prefix", c.name, saved)
		}
	}
}
