package ottlassert

import (
	"strings"
	"testing"
)

func TestLintConditionsAndStatements(t *testing.T) {
	res, err := Lint(ContextSpan,
		[]string{`attributes["http.status_code"] >= 400`, `attributes[`},
		[]string{`set(attributes["env"], "prod")`, `set(attributes["env"])`},
		[]string{`attributes["http.route"]`},
	)
	if err != nil {
		t.Fatalf("Lint returned error: %v", err)
	}
	if res.Valid {
		t.Errorf("overall result should be invalid")
	}
	if len(res.Items) != 5 {
		t.Fatalf("expected 5 items, got %d", len(res.Items))
	}
	if !res.Items[0].Valid {
		t.Errorf("valid condition flagged invalid: %+v", res.Items[0])
	}
	if res.Items[1].Valid {
		t.Errorf("broken condition should be invalid")
	}
	if !res.Items[2].Valid {
		t.Errorf("valid set statement flagged invalid: %+v", res.Items[2])
	}
	if res.Items[3].Valid {
		t.Errorf("set with missing arg should be invalid")
	}
	if !res.Items[4].Valid {
		t.Errorf("valid value expression flagged invalid: %+v", res.Items[4])
	}
}

func TestLintRejectsOversizedExpression(t *testing.T) {
	// A deeply nested expression would drive the recursive-descent parser's
	// stack depth toward a fatal overflow — it must be rejected BEFORE
	// parsing, as a per-item verdict, without failing the other items.
	huge := strings.Repeat("(", MaxExpressionBytes+1)
	res, err := Lint(ContextLog, []string{huge, "true"}, nil, nil)
	if err != nil {
		t.Fatalf("Lint returned error: %v", err)
	}
	if res.Items[0].Valid {
		t.Errorf("oversized expression should be invalid")
	}
	if !strings.Contains(res.Items[0].Error, "maximum") {
		t.Errorf("expected a length-cap error, got: %s", res.Items[0].Error)
	}
	if len(res.Items[0].Input) > MaxExpressionBytes+len("…") {
		t.Errorf("oversized input must not be echoed back in full (%d bytes)", len(res.Items[0].Input))
	}
	if !res.Items[1].Valid {
		t.Errorf("valid sibling item should be unaffected: %+v", res.Items[1])
	}
}

func TestLintUnknownContext(t *testing.T) {
	if _, err := Lint("banana", []string{"true"}, nil, nil); err == nil {
		t.Errorf("unknown context should error")
	}
}

func TestLintUnknownFunction(t *testing.T) {
	res, err := Lint(ContextDataPoint, nil, []string{`totally_made_up_function(attributes["x"])`}, nil)
	if err != nil {
		t.Fatalf("Lint returned error: %v", err)
	}
	if res.Items[0].Valid {
		t.Errorf("unknown function should be invalid")
	}
	if !strings.Contains(strings.ToLower(res.Items[0].Error), "undefined") && res.Items[0].Error == "" {
		t.Logf("error text: %s", res.Items[0].Error)
	}
}
