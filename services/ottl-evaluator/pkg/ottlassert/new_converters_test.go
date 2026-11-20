// OTTL 0.162.0 has the converters Coalesce and IsEmpty, which 0.147.0
// lacked. This test shows that rules may use them: they parse, in lint and
// in a rule, and evaluate per record.

package ottlassert

import "testing"

const (
	coalesceCondition = `Coalesce([attributes["missing"], "x"]) == "x"`
	isEmptyCondition  = `IsEmpty(attributes["missing"])`
)

func TestConvertersAddedSince0147ParseAndEvaluate(t *testing.T) {
	lint, err := Lint(ContextLog, []string{coalesceCondition, isEmptyCondition}, nil, nil)
	if err != nil {
		t.Fatalf("Lint returned error: %v", err)
	}
	if !lint.Valid {
		t.Fatalf("Coalesce and IsEmpty should lint as valid: %+v", lint)
	}

	payload := logsLine1 + "\n" + logsLine2 + "\n"
	rules := []Rule{
		{ID: "coalesce", Context: ContextLog, Condition: coalesceCondition, Quantifier: QuantifierAll},
		{ID: "is-empty", Context: ContextLog, Condition: isEmptyCondition, Quantifier: QuantifierAll},
		// The other way round, so neither passes by never being true:
		// Coalesce takes the first value that isn't nil, and a present
		// attribute isn't empty.
		{ID: "coalesce-present", Context: ContextLog, Condition: `Coalesce([attributes["env"], "x"]) == "prod"`, Quantifier: QuantifierAll},
		{ID: "is-empty-present", Context: ContextLog, Condition: `IsEmpty(attributes["env"])`, Quantifier: QuantifierNone},
	}
	results := mustEvaluate(t, SignalLogs, payload, rules)
	for _, r := range results {
		if r.Error != "" {
			t.Errorf("rule %s should evaluate without an error, got %q", r.ID, r.Error)
		}
		if !r.Passed {
			t.Errorf("rule %s should pass: %+v", r.ID, r)
		}
		if r.TotalCount != 2 {
			t.Errorf("rule %s should see both log records, saw %d", r.ID, r.TotalCount)
		}
	}
	for _, r := range results[:3] {
		if r.MatchedCount != 2 {
			t.Errorf("rule %s should hold on both records, held on %d", r.ID, r.MatchedCount)
		}
	}
}
