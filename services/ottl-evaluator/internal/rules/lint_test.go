// New in D25 Task 3: the lint child's checks. Each text gets the rule
// checks' guards before the parse, a blank one is empty, a parse error is
// worded as a rule's, and the child writes one verdict line per text, in
// order, with no text in it.

package rules

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/telflo/ottl-evaluator/pkg/ottlassert"
)

func TestLintTextGuardsBeforeTheParse(t *testing.T) {
	linter, err := ottlassert.NewLinter(ottlassert.ContextLog)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		kind, text, error string
	}{
		{LintKindCondition, `severity_number >= 17`, ""},
		{LintKindStatement, `set(attributes["env"], "prod")`, ""},
		{LintKindValueExpression, `body`, ""},
		{LintKindCondition, strings.Repeat("x", MaxTextBytes+1), "The condition is longer than 8,192 bytes."},
		{LintKindStatement, strings.Repeat("Concat([", 13), "The statement nests brackets more than 12 deep."},
		{LintKindValueExpression, `Concat(["\b"], "")`, ottlassert.SuspiciousEscapeError(`\b`)},
		{LintKindCondition, " \t", "The condition is empty."},
		{LintKindValueExpression, "", "The value expression is empty."},
		{LintKindCondition, `attributes[`, SyntaxErrorPrefix},
	} {
		verdict := LintText(linter, LintTarget{Kind: c.kind, Index: 3, Text: c.text})
		got := ""
		if verdict.Error != nil {
			got = *verdict.Error
		}
		if verdict.Kind != c.kind || verdict.Index != 3 || verdict.Valid != (c.error == "") || !strings.HasPrefix(got, c.error) || (c.error == "") != (got == "") {
			t.Errorf("%s %.40q: %+v %q", c.kind, c.text, verdict, got)
		}
	}
}

func TestRunLintChildWritesAVerdictPerTextInOrder(t *testing.T) {
	marker := "MARKER-90b2"
	in, _ := json.Marshal(LintInput{
		Context:          "span",
		ValueExpressions: []string{`attributes["` + marker + `"]`},
		Statements:       []string{`set(name, "` + marker + `")`},
		Conditions:       []string{`name == "` + marker + `"`, marker + `(`},
	})
	var out bytes.Buffer
	if code := RunLintChild(bytes.NewReader(in), &out); code != ExitDone {
		t.Fatalf("exit %d", code)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	want := []string{
		`{"kind":"condition","index":0,"valid":true}`,
		`{"kind":"condition","index":1,"valid":false,"error":"OTTL syntax error: `,
		`{"kind":"statement","index":0,"valid":true}`,
		`{"kind":"valueExpression","index":0,"valid":true}`,
	}
	if len(lines) != len(want) {
		t.Fatalf("%d lines: %s", len(lines), out.String())
	}
	for i, line := range lines {
		if !strings.HasPrefix(line, want[i]) {
			t.Errorf("line %d: %s", i, line)
		}
	}
	// Only a parser's own message about the broken text may quote it.
	for _, i := range []int{0, 2, 3} {
		if strings.Contains(lines[i], marker) {
			t.Errorf("line %d echoes its text: %s", i, lines[i])
		}
	}
	for _, bad := range []string{`{"context":"trace","conditions":["true"]}`, `{"context":"log"}`, `not json`} {
		out.Reset()
		if code := RunLintChild(strings.NewReader(bad), &out); code != ExitInput || out.Len() != 0 {
			t.Errorf("%s: exit %d, %s", bad, code, out.String())
		}
	}
}
