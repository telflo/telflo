// A rule's own checks, the same at Save (validate) and in a run
// (evaluate), so lint and runs can't disagree: both parse with the
// converters-only parsers runs use, never with the editors registered too
// (StandardFuncs).

package rules

import (
	"errors"
	"fmt"
	"regexp"
	"regexp/syntax"
	"strings"

	"github.com/telflo/ottl-evaluator/pkg/ottlassert"
)

// Problem is one thing wrong with a rule: the field (pattern, ottl.context,
// ottl.condition, ottl.expression, ottl.count, ottl.count.value2) and why.
// Its message is worded once, here, and carried as it is both by validate
// (Save) and by a run's rule error, so the two always read alike: a parser's
// message follows SyntaxErrorPrefix, a regexp's follows InvalidRegexPrefix,
// and every other problem is in its own words. Each is capped at
// maxMessageBytes.
type Problem struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// The prefixes before a parser's and a regexp's own messages.
const (
	SyntaxErrorPrefix  = "OTTL syntax error: "
	InvalidRegexPrefix = "Invalid regex: "
)

// The fields a problem names.
const (
	FieldPattern    = "pattern"
	FieldContext    = "ottl.context"
	FieldQuantifier = "ottl.quantifier"
	FieldCondition  = "ottl.condition"
	FieldExpression = "ottl.expression"
	FieldCount      = "ottl.count"
	FieldValue2     = "ottl.count.value2"
)

// Check finds a rule's problems, for a run of signal. With first, it stops
// at the first (evaluate: a rule's error is its first problem); without, it
// finds them all (validate). checking, when not nil, is told each field just
// before its text is parsed or compiled: the slow steps, which only the
// child's kill can stop.
func Check(signal string, rule Rule, first bool, checking func(field string)) []Problem {
	c := checker{first: first, checking: checking}
	switch rule.Kind {
	case KindContainsText, KindNotContainsText:
		c.text(rule)
	case KindContainsRegex, KindNotContainsRegex:
		c.regex(rule)
	case KindOTTL:
		c.ottl(signal, rule)
	default:
		c.add(Problem{Field: "kind", Message: fmt.Sprintf("Unknown rule kind %q.", rule.Kind)})
	}
	return c.problems
}

type checker struct {
	first    bool
	checking func(string)
	problems []Problem
}

func (c *checker) add(p Problem) {
	p.Message = capMessage(p.Message)
	c.problems = append(c.problems, p)
}

func (c *checker) done() bool {
	return c.first && len(c.problems) > 0
}

func (c *checker) about(field string) {
	if c.checking != nil {
		c.checking(field)
	}
}

func (c *checker) text(rule Rule) {
	pattern := deref(rule.Pattern)
	switch {
	case len(pattern) > MaxTextBytes:
		c.add(Problem{Field: FieldPattern, Message: "The text is longer than 8,192 bytes."})
	case isBlank(pattern):
		c.add(Problem{Field: FieldPattern, Message: EmptyText})
	}
}

func (c *checker) regex(rule Rule) {
	pattern := deref(rule.Pattern)
	switch {
	case len(pattern) > MaxTextBytes:
		c.add(Problem{Field: FieldPattern, Message: "The pattern is longer than 8,192 bytes."})
		return
	case isBlank(pattern):
		c.add(Problem{Field: FieldPattern, Message: "The pattern is empty."})
		return
	}
	c.about(FieldPattern)
	if _, err := regexp.Compile(pattern); err != nil {
		c.add(Problem{Field: FieldPattern, Message: InvalidRegexPrefix + regexMessage(err)})
	}
}

// regexMessage is Go's message without its "error parsing regexp: ".
func regexMessage(err error) string {
	var syntaxErr *syntax.Error
	if errors.As(err, &syntaxErr) {
		return string(syntaxErr.Code) + ": `" + syntaxErr.Expr + "`"
	}
	return strings.TrimPrefix(err.Error(), "error parsing regexp: ")
}

func (c *checker) ottl(signal string, rule Rule) {
	o := rule.OTTL
	if o == nil {
		c.add(Problem{Field: "ottl", Message: "An OTTL rule needs its OTTL."})
		return
	}
	context := ottlassert.Context(o.Context)
	contextAllowed := ottlassert.ContextAllowed(ottlassert.Signal(signal), context)
	if !contextAllowed {
		c.add(Problem{Field: FieldContext, Message: contextMessage(signal, o.Context)})
		if c.done() {
			return
		}
	}

	condition, expression := o.Condition, o.Expression
	switch o.Quantifier {
	case "all", "any", "none", "count":
		if condition == nil || isBlank(*condition) {
			c.add(Problem{Field: FieldCondition, Message: "The condition is empty."})
		}
		if expression != nil {
			c.add(Problem{Field: FieldExpression, Message: "Only a distinct rule has an expression."})
		}
	case "distinct":
		if expression == nil || isBlank(*expression) {
			c.add(Problem{Field: FieldExpression, Message: "A distinct rule needs an expression."})
		}
		if condition != nil && isBlank(*condition) {
			c.add(Problem{Field: FieldCondition, Message: "The condition is empty."})
		}
	default:
		c.add(Problem{Field: FieldQuantifier, Message: fmt.Sprintf("Unknown quantifier %q.", o.Quantifier)})
	}
	if c.done() {
		return
	}
	c.count(o)
	if c.done() {
		return
	}

	for _, part := range []struct {
		field, name string
		text        *string
		parse       func(ottlassert.Context, string) error
	}{
		{FieldCondition, "condition", condition, ottlassert.ParseCondition},
		{FieldExpression, "expression", expression, ottlassert.ParseValueExpression},
	} {
		if part.text == nil || isBlank(*part.text) {
			continue
		}
		text := *part.text
		if p, ok := textProblem(part.field, part.name, text); ok {
			c.add(p)
		} else if contextAllowed {
			c.about(part.field)
			if err := part.parse(context, text); err != nil {
				c.add(Problem{Field: part.field, Message: SyntaxErrorPrefix + err.Error()})
			}
		}
		if c.done() {
			return
		}
	}
}

// count checks the count against the quantifier and its operator.
func (c *checker) count(o *OTTL) {
	switch o.Quantifier {
	case "all", "any", "none":
		if o.Count != nil {
			c.add(Problem{Field: FieldCount, Message: "Only a count or distinct rule has a count."})
		}
		return
	case "count", "distinct":
	default:
		return
	}
	count := o.Count
	if count == nil {
		c.add(Problem{Field: FieldCount, Message: "A count or distinct rule needs a count."})
		return
	}
	switch count.Operator {
	case "between":
		switch {
		case count.Value2 == nil:
			c.add(Problem{Field: FieldValue2, Message: "Between needs a second value."})
		case *count.Value2 < count.Value:
			c.add(Problem{Field: FieldValue2, Message: "Between's second value can't be less than its first."})
		}
	case "eq", "ne", "gt", "gte", "lt", "lte":
		if count.Value2 != nil {
			c.add(Problem{Field: FieldValue2, Message: "Only between has a second value."})
		}
	default:
		c.add(Problem{Field: FieldCount, Message: fmt.Sprintf("Unknown count operator %q.", count.Operator)})
	}
}

// textProblem checks an OTTL text before it may be parsed: its length, its
// nesting, and a single-escaped regex sequence such as `\b` (which parses,
// as a backspace, so a pattern can never match; it is correct RE2, so only
// OTTL refuses it).
func textProblem(field, name, text string) (Problem, bool) {
	if len(text) > MaxTextBytes {
		return Problem{Field: field, Message: fmt.Sprintf("The %s is longer than 8,192 bytes.", name)}, true
	}
	if nesting(text) > MaxNesting {
		return Problem{Field: field, Message: fmt.Sprintf("The %s nests brackets more than 12 deep.", name)}, true
	}
	if seq := ottlassert.FindSuspiciousEscape(text); seq != "" {
		return Problem{Field: field, Message: ottlassert.SuspiciousEscapeError(seq)}, true
	}
	return Problem{}, false
}

// nesting is how deep (, [ and { nest in an OTTL text, outside its string
// literals.
func nesting(text string) int {
	depth, deepest := 0, 0
	inString, escaped := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '(', '[', '{':
			depth++
			deepest = max(deepest, depth)
		case ')', ']', '}':
			if depth > 0 {
				depth--
			}
		}
	}
	return deepest
}

func contextMessage(signal, context string) string {
	contexts := ottlassert.ContextsOf(ottlassert.Signal(signal))
	names := make([]string, len(contexts))
	for i, c := range contexts {
		names[i] = string(c)
	}
	if len(names) == 0 {
		return fmt.Sprintf("Unknown signal %q.", signal)
	}
	return fmt.Sprintf("A %s rule can't use the %q context: use %s.", signal, context, joinOr(names))
}

func joinOr(names []string) string {
	if len(names) == 1 {
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " or " + names[len(names)-1]
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
