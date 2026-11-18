// New in D15a Task 3's follow-up (the controller's Ruling 34): which
// quantifiers list their misses. A failing all or any lists its first
// maxMisses records that evaluated to false, none its first maxMisses
// matches, and count none at all; the rest are only counted.

package ottlassert

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestFailingQuantifiersListTheirFirstMisses(t *testing.T) {
	// Seven log records, bodies r0 to r6: past maxMisses.
	payload := `{"resourceLogs":[{"resource":{},"scopeLogs":[{"scope":{},"logRecords":[` + join(7, func(i int) string {
		return fmt.Sprintf(`{"body":{"stringValue":"r%d"}}`, i)
	}) + `]}]}]}`
	rules := []Rule{
		{ID: "any", Context: ContextLog, Condition: `body == "nowhere"`, Quantifier: QuantifierAny},
		{ID: "all", Context: ContextLog, Condition: `body == "nowhere"`, Quantifier: QuantifierAll},
		{ID: "none", Context: ContextLog, Condition: `true`, Quantifier: QuantifierNone},
		{ID: "count", Context: ContextLog, Condition: `true`, Quantifier: QuantifierCount, Count: &CountSpec{Operator: "eq", Value: 3}},
		{ID: "any-passing", Context: ContextLog, Condition: `body == "r6"`, Quantifier: QuantifierAny},
	}
	results, err := Evaluate(context.Background(), SignalLogs, payload, rules)
	if err != nil {
		t.Fatal(err)
	}
	for i, reason := range []string{"condition evaluated to false", "condition evaluated to false", "unexpected match"} {
		r := results[i]
		if r.Passed || r.Error != "" || r.TotalCount != 7 || r.TotalMissCount != 7 || len(r.Misses) != maxMisses {
			t.Fatalf("%s: passed %v, error %q, %d records, %d missed, %d listed", r.ID, r.Passed, r.Error, r.TotalCount, r.TotalMissCount, len(r.Misses))
		}
		for j, m := range r.Misses {
			if m.Index != j || m.Reason != reason || !strings.Contains(m.Snippet, fmt.Sprintf(`"r%d"`, j)) {
				t.Errorf("%s's miss %d: %+v", r.ID, j, m)
			}
		}
	}
	if c := results[3]; c.Passed || c.MatchedCount != 7 || c.TotalMissCount != 0 || c.Misses != nil {
		t.Errorf("a failing count counts and lists no miss: %+v", c)
	}
	if a := results[4]; !a.Passed || a.TotalMissCount != 0 || a.Misses != nil {
		t.Errorf("a passing any lists no miss: %+v", a)
	}
}
