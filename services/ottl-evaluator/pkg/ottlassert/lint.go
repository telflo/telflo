package ottlassert

import (
	"fmt"

	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/contexts/ottldatapoint"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/contexts/ottllog"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/contexts/ottlmetric"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/contexts/ottlresource"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/contexts/ottlscope"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/contexts/ottlspan"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/contexts/ottlspanevent"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl/ottlfuncs"
	"go.opentelemetry.io/collector/component/componenttest"
)

// LintItem is the parse verdict for one OTTL string.
type LintItem struct {
	Kind  string `json:"kind"` // condition | statement | value_expression
	Index int    `json:"index"`
	Input string `json:"input"`
	Valid bool   `json:"valid"`
	Error string `json:"error,omitempty"`
}

// LintResult aggregates parse verdicts for a lint request.
type LintResult struct {
	Context Context    `json:"context"`
	Valid   bool       `json:"valid"`
	Items   []LintItem `json:"items"`
}

// Lint parse-checks OTTL conditions, statements, and value expressions
// against the given context using the standard OTTL function set (editors +
// converters). No route calls it, and Save never uses it. Because it
// registers the editors, it accepts what a run can't evaluate; a rule is
// checked at Save and in a run alike by internal/rules' Check, with the
// converters-only parsers (ParseCondition, ParseValueExpression).
// Processor-specific custom functions are not registered, so a statement
// using one will report an unknown-function error — callers that lint e.g.
// filter processor conditions should treat those with judgment.
func Lint(c Context, conditions, statements, valueExpressions []string) (LintResult, error) {
	set := componenttest.NewNopTelemetrySettings()
	switch c {
	case ContextSpan:
		p, err := ottlspan.NewParser(ottlfuncs.StandardFuncs[*ottlspan.TransformContext](), set)
		if err != nil {
			return LintResult{}, err
		}
		return lintWith(c, p, conditions, statements, valueExpressions), nil
	case ContextSpanEvent:
		p, err := ottlspanevent.NewParser(ottlfuncs.StandardFuncs[*ottlspanevent.TransformContext](), set)
		if err != nil {
			return LintResult{}, err
		}
		return lintWith(c, p, conditions, statements, valueExpressions), nil
	case ContextMetric:
		p, err := ottlmetric.NewParser(ottlfuncs.StandardFuncs[*ottlmetric.TransformContext](), set)
		if err != nil {
			return LintResult{}, err
		}
		return lintWith(c, p, conditions, statements, valueExpressions), nil
	case ContextDataPoint:
		p, err := ottldatapoint.NewParser(ottlfuncs.StandardFuncs[*ottldatapoint.TransformContext](), set)
		if err != nil {
			return LintResult{}, err
		}
		return lintWith(c, p, conditions, statements, valueExpressions), nil
	case ContextLog:
		p, err := ottllog.NewParser(ottlfuncs.StandardFuncs[*ottllog.TransformContext](), set)
		if err != nil {
			return LintResult{}, err
		}
		return lintWith(c, p, conditions, statements, valueExpressions), nil
	case ContextResource:
		p, err := ottlresource.NewParser(ottlfuncs.StandardFuncs[*ottlresource.TransformContext](), set)
		if err != nil {
			return LintResult{}, err
		}
		return lintWith(c, p, conditions, statements, valueExpressions), nil
	case ContextScope:
		p, err := ottlscope.NewParser(ottlfuncs.StandardFuncs[*ottlscope.TransformContext](), set)
		if err != nil {
			return LintResult{}, err
		}
		return lintWith(c, p, conditions, statements, valueExpressions), nil
	default:
		return LintResult{}, fmt.Errorf("unknown context %q", c)
	}
}

func lintWith[K any](c Context, parser ottl.Parser[K], conditions, statements, valueExpressions []string) LintResult {
	res := LintResult{Context: c, Valid: true}
	add := func(kind string, i int, s string, parse func(string) error) {
		item := LintItem{Kind: kind, Index: i, Input: s, Valid: true}
		if err := checkExpressionLength(s); err != nil {
			// Never hand an unbounded string to the recursive-descent parser
			// (stack exhaustion is a fatal crash) — and don't echo it back.
			item.Input = s[:MaxExpressionBytes] + "…"
			item.Valid = false
			item.Error = err.Error()
		} else if err := parse(s); err != nil {
			item.Valid = false
			item.Error = err.Error()
		} else {
			flagSuspiciousEscape(&item)
		}
		if !item.Valid {
			res.Valid = false
		}
		res.Items = append(res.Items, item)
	}
	for i, s := range conditions {
		add("condition", i, s, func(s string) error { _, err := parser.ParseCondition(s); return err })
	}
	for i, s := range statements {
		add("statement", i, s, func(s string) error { _, err := parser.ParseStatement(s); return err })
	}
	for i, s := range valueExpressions {
		add("value_expression", i, s, func(s string) error { _, err := parser.ParseValueExpression(s); return err })
	}
	return res
}

// flagSuspiciousEscape downgrades a grammatically valid item when it carries
// a single-escaped regex metachar: "\b" PARSES fine (it is a backspace
// character) yet produces a pattern that can never match — a silent no-op
// assertion or transform is worse than a parse error.
func flagSuspiciousEscape(item *LintItem) {
	if !item.Valid {
		return
	}
	if seq := findSuspiciousEscape(item.Input); seq != "" {
		item.Valid = false
		item.Error = suspiciousEscapeError(seq)
	}
}
