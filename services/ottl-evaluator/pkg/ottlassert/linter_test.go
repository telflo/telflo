// New in D25 Task 3: the Linter parses one text at a time, with the
// standard function set (editors and converters), as Lint does.

package ottlassert

import (
	"strings"
	"testing"
)

func TestLinterParsesEachKindAsLintDoes(t *testing.T) {
	linter, err := NewLinter(ContextSpan)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name  string
		parse func(string) error
		text  string
		valid bool
	}{
		{"a condition", linter.ParseCondition, `attributes["http.status_code"] >= 400`, true},
		{"a broken condition", linter.ParseCondition, `attributes[`, false},
		{"an editor statement", linter.ParseStatement, `set(attributes["env"], "prod")`, true},
		{"a statement missing an argument", linter.ParseStatement, `set(attributes["env"])`, false},
		{"a value expression", linter.ParseValueExpression, `attributes["http.route"]`, true},
		{"an oversized text", linter.ParseCondition, strings.Repeat("(", MaxExpressionBytes+1), false},
	} {
		if err := c.parse(c.text); (err == nil) != c.valid {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	for _, c := range []Context{ContextSpanEvent, ContextMetric, ContextDataPoint, ContextLog, ContextResource, ContextScope} {
		if _, err := NewLinter(c); err != nil {
			t.Errorf("%s: %v", c, err)
		}
	}
	if _, err := NewLinter("trace"); err == nil {
		t.Error("an unknown context built a linter")
	}
}
