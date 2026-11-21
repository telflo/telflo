// A rule's own checks, which validate answers as problems and evaluate as
// a rule's error, the prechecks a client would otherwise make before sending
// a rule included.

package rules

import (
	"strings"
	"testing"
)

func fields(problems []Problem) []string {
	var out []string
	for _, p := range problems {
		out = append(out, p.Field)
	}
	return out
}

func checkAll(signal string, r Rule) []Problem {
	return Check(signal, r, false, nil)
}

func TestTheContextsEachSignalAllows(t *testing.T) {
	allowed := map[string][]string{
		"logs":    {"log", "resource", "scope"},
		"traces":  {"span", "spanevent", "resource", "scope"},
		"metrics": {"metric", "datapoint", "resource", "scope"},
	}
	all := []string{"log", "span", "spanevent", "metric", "datapoint", "resource", "scope"}
	for signal, contexts := range allowed {
		for _, context := range all {
			problems := checkAll(signal, ottlRule(context, "all", "true"))
			want := strings.Contains(" "+strings.Join(contexts, " ")+" ", " "+context+" ")
			if got := len(problems) == 0; got != want {
				t.Errorf("%s/%s: problems %v, want allowed=%v", signal, context, problems, want)
			}
			if !want && (len(problems) != 1 || problems[0].Field != FieldContext) {
				t.Errorf("%s/%s: %v", signal, context, problems)
			}
		}
	}
	p := checkAll("metrics", ottlRule("log", "all", "true"))[0]
	if p.Message != `A metrics rule can't use the "log" context: use metric, datapoint, resource or scope.` {
		t.Errorf("message: %q", p.Message)
	}
}

func TestQuantifierCountAndExpressionAgree(t *testing.T) {
	withCount := func(r Rule, c *Count) Rule { r.OTTL.Count = c; return r }
	withExpression := func(r Rule, e string) Rule { r.OTTL.Expression = strPtr(e); return r }
	cases := []struct {
		name string
		rule Rule
		want []string
	}{
		{"all with a condition", ottlRule("log", "all", "true"), nil},
		{"all without a condition", ottlRule("log", "all", ""), []string{FieldCondition}},
		{"any with a blank condition", ottlRule("log", "any", " \t"), []string{FieldCondition}},
		{"none with a count", withCount(ottlRule("log", "none", "true"), &Count{Operator: "eq", Value: 1}), []string{FieldCount}},
		{"all with an expression", withExpression(ottlRule("log", "all", "true"), "body"), []string{FieldExpression}},
		{"count without a count", ottlRule("log", "count", "true"), []string{FieldCount}},
		{"count", withCount(ottlRule("log", "count", "true"), &Count{Operator: "gte", Value: 1}), nil},
		{"between ordered", withCount(ottlRule("log", "count", "true"), &Count{Operator: "between", Value: 1, Value2: int64Ptr(1)}), nil},
		{"between without value2", withCount(ottlRule("log", "count", "true"), &Count{Operator: "between", Value: 1}), []string{FieldValue2}},
		{"between unordered", withCount(ottlRule("log", "count", "true"), &Count{Operator: "between", Value: 5, Value2: int64Ptr(4)}), []string{FieldValue2}},
		{"value2 without between", withCount(ottlRule("log", "count", "true"), &Count{Operator: "eq", Value: 5, Value2: int64Ptr(6)}), []string{FieldValue2}},
		{"distinct", distinctRule("log", "body", "lte", 5), nil},
		{"distinct with a filter", withExpression(withCount(ottlRule("log", "distinct", `severity_text == "ERROR"`), &Count{Operator: "lte", Value: 5}), "body"), nil},
		{"distinct without an expression", withCount(ottlRule("log", "distinct", ""), &Count{Operator: "lte", Value: 5}), []string{FieldExpression}},
		{"distinct without a count", withExpression(ottlRule("log", "distinct", ""), "body"), []string{FieldCount}},
		{"distinct with a blank filter", withExpression(withCount(ottlRule("log", "distinct", " "), &Count{Operator: "lte", Value: 5}), "body"), []string{FieldCondition}},
	}
	for _, c := range cases {
		if got := fields(checkAll("logs", c.rule)); strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("%s: problems %v, want %v", c.name, got, c.want)
		}
	}
}

func TestNestingIsCappedAtTwelve(t *testing.T) {
	nested := func(n int) string {
		return strings.Repeat("Concat([", n) + `"a"` + strings.Repeat(`], "")`, n) + ` == "a"`
	}
	// Twelve deep is "Concat([" six times.
	if problems := checkAll("logs", ottlRule("log", "all", nested(6))); len(problems) != 0 {
		t.Errorf("twelve deep: %v", problems)
	}
	problems := checkAll("logs", ottlRule("log", "all", nested(7)))
	if len(problems) != 1 || problems[0].Field != FieldCondition || !strings.Contains(problems[0].Message, "more than 12 deep") {
		t.Errorf("fourteen deep: %v", problems)
	}
	// Brackets inside a string literal don't count.
	if problems := checkAll("logs", ottlRule("log", "all", `body == "`+strings.Repeat("([{", 20)+`"`)); len(problems) != 0 {
		t.Errorf("brackets in a string: %v", problems)
	}
	// A parse measured at 37 s, refused before it is parsed.
	parsed := false
	invalid := strings.Repeat("Concat([", 20)
	Check("logs", ottlRule("log", "all", invalid), false, func(string) { parsed = true })
	if parsed {
		t.Error("a text nested past the cap was parsed")
	}
}

func TestLengthsAreCappedInBytes(t *testing.T) {
	// 4,097 two-byte characters: under 8,192 characters, over 8,192 bytes.
	long := strings.Repeat("é", 4097)
	for _, r := range []Rule{textRule(KindContainsText, long), textRule(KindContainsRegex, long)} {
		if p := checkAll("logs", r); len(p) != 1 || !strings.Contains(p[0].Message, "longer than 8,192 bytes") {
			t.Errorf("%s: %v", r.Kind, p)
		}
	}
	if p := checkAll("logs", ottlRule("log", "all", `body == "`+long+`"`)); len(p) != 1 || p[0].Message != "The condition is longer than 8,192 bytes." {
		t.Errorf("condition: %v", p)
	}
	if p := checkAll("logs", distinctRule("log", `Concat(["`+long+`"], "")`, "eq", 1)); len(p) != 1 || p[0].Field != FieldExpression {
		t.Errorf("expression: %v", p)
	}
	exact := strings.Repeat("a", MaxTextBytes)
	if p := checkAll("logs", textRule(KindContainsText, exact)); len(p) != 0 {
		t.Errorf("8,192 bytes is allowed: %v", p)
	}
}

// `\b` in an OTTL string is a backspace, so the pattern can never match; in
// a regex rule it is RE2's word boundary.
func TestTheSingleEscapedSequenceIsRefusedInOTTLOnly(t *testing.T) {
	condition := `not IsMatch(body, "\b[0-9]{4}\b")`
	p := checkAll("logs", ottlRule("log", "all", condition))
	if len(p) != 1 || !strings.Contains(p[0].Message, "single-escaped regex sequence") {
		t.Errorf("OTTL: %v", p)
	}
	if p := checkAll("logs", ottlRule("log", "all", `not IsMatch(body, "\\b[0-9]{4}\\b")`)); len(p) != 0 {
		t.Errorf("double-escaped: %v", p)
	}
	if p := checkAll("logs", textRule(KindNotContainsRegex, `\b[0-9]{4}\b`)); len(p) != 0 {
		t.Errorf("regex: %v", p)
	}
	// test_distinct_prechecks_fail_locally's escaped expression.
	if p := checkAll("logs", distinctRule("log", `Concat([attributes["r"], "\d"], "|")`, "lte", 5)); len(p) != 1 || !strings.Contains(p[0].Message, "single-escaped regex sequence") {
		t.Errorf("expression: %v", p)
	}
}

func TestTextsParseWithTheEvaluationsParser(t *testing.T) {
	cases := []struct {
		name  string
		rule  Rule
		field string
	}{
		{"a broken condition", ottlRule("log", "all", `attributes["env"] == "prod`), FieldCondition},
		{"an unknown converter", ottlRule("log", "all", `Nope(body) == "x"`), FieldCondition},
		{"an editor is no condition", ottlRule("log", "all", `set(attributes["a"], "b")`), FieldCondition},
		{"a broken expression", distinctRule("log", `attributes[`, "eq", 1), FieldExpression},
		{"a removed converter (0.147.0's LuhnValid)", ottlRule("log", "all", `LuhnValid(body)`), FieldCondition},
	}
	for _, c := range cases {
		p := checkAll("logs", c.rule)
		if len(p) != 1 || p[0].Field != c.field || !strings.HasPrefix(p[0].Message, SyntaxErrorPrefix) {
			t.Errorf("%s: %v", c.name, p)
		}
	}
	for _, ok := range []Rule{
		ottlRule("log", "all", `Coalesce([attributes["missing"], "x"]) == "x"`),
		ottlRule("log", "all", `IsMatch(body, "payment.*") and not IsEmpty(attributes["env"])`),
		distinctRule("log", `Concat([attributes["a"], attributes["b"]], "|")`, "lte", 3),
	} {
		if p := checkAll("logs", ok); len(p) != 0 {
			t.Errorf("%v: %v", ok.OTTL, p)
		}
	}
}

func TestRegexPatternsCompile(t *testing.T) {
	for _, c := range []struct {
		pattern, message string
	}{
		{"(unclosed", "missing closing ): `(unclosed`"},
		{"(?=foo)bar", "invalid or unsupported Perl syntax: `(?=`"},
		{`(a)\1`, "invalid escape sequence: `\\1`"},
	} {
		p := checkAll("logs", textRule(KindContainsRegex, c.pattern))
		if len(p) != 1 || p[0].Message != InvalidRegexPrefix+c.message {
			t.Errorf("%q: %+v", c.pattern, p)
		}
	}
	if p := checkAll("logs", textRule(KindNotContainsRegex, `(?i)error:\s+\d+`)); len(p) != 0 {
		t.Errorf("inline flags: %v", p)
	}
	if p := checkAll("logs", textRule(KindContainsRegex, " \t ")); len(p) != 1 || p[0].Message != "The pattern is empty." {
		t.Errorf("blank pattern: %v", p)
	}
}

func TestCheckFirstStopsAtTheFirstProblem(t *testing.T) {
	r := ottlRule("span", "count", "")
	if all := Check("logs", r, false, nil); len(all) < 3 {
		t.Fatalf("all problems: %v", all)
	}
	if first := Check("logs", r, true, nil); len(first) != 1 || first[0].Field != FieldContext {
		t.Fatalf("first: %v", first)
	}
}

func TestCheckingNamesEachSlowStep(t *testing.T) {
	var steps []string
	r := distinctRule("log", "body", "eq", 1)
	r.OTTL.Condition = strPtr("true")
	Check("logs", r, false, func(field string) { steps = append(steps, field) })
	if strings.Join(steps, ",") != FieldCondition+","+FieldExpression {
		t.Fatalf("steps %v", steps)
	}
	steps = nil
	Check("logs", textRule(KindContainsRegex, "x"), false, func(field string) { steps = append(steps, field) })
	if strings.Join(steps, ",") != FieldPattern {
		t.Fatalf("steps %v", steps)
	}
}
