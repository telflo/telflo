// The public API's OTTL lint parses one text at a time, so the lint child
// (internal/rules' RunLintChild) can apply the rule checks' guards before
// each parse and write each item's verdict as it finishes. It parses as
// Lint does, with the standard function set (editors and converters), so a
// transform's `set(…)` statement parses; Lint is unchanged.

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

// Linter parses conditions, statements and value expressions against one
// context, one at a time. Each method returns the parser's error, or nil.
// A text over MaxExpressionBytes is refused unparsed.
type Linter struct {
	condition       func(string) error
	statement       func(string) error
	valueExpression func(string) error
}

// NewLinter builds a context's parser once, for every text linted against
// it. An unknown context is an error.
func NewLinter(c Context) (*Linter, error) {
	set := componenttest.NewNopTelemetrySettings()
	switch c {
	case ContextSpan:
		return linterOf(ottlspan.NewParser(ottlfuncs.StandardFuncs[*ottlspan.TransformContext](), set))
	case ContextSpanEvent:
		return linterOf(ottlspanevent.NewParser(ottlfuncs.StandardFuncs[*ottlspanevent.TransformContext](), set))
	case ContextMetric:
		return linterOf(ottlmetric.NewParser(ottlfuncs.StandardFuncs[*ottlmetric.TransformContext](), set))
	case ContextDataPoint:
		return linterOf(ottldatapoint.NewParser(ottlfuncs.StandardFuncs[*ottldatapoint.TransformContext](), set))
	case ContextLog:
		return linterOf(ottllog.NewParser(ottlfuncs.StandardFuncs[*ottllog.TransformContext](), set))
	case ContextResource:
		return linterOf(ottlresource.NewParser(ottlfuncs.StandardFuncs[*ottlresource.TransformContext](), set))
	case ContextScope:
		return linterOf(ottlscope.NewParser(ottlfuncs.StandardFuncs[*ottlscope.TransformContext](), set))
	default:
		return nil, fmt.Errorf("unknown context %q", c)
	}
}

func linterOf[K any](parser ottl.Parser[K], err error) (*Linter, error) {
	if err != nil {
		return nil, fmt.Errorf("failed to construct OTTL parser: %w", err)
	}
	return &Linter{
		condition:       func(s string) error { _, err := parser.ParseCondition(s); return err },
		statement:       func(s string) error { _, err := parser.ParseStatement(s); return err },
		valueExpression: func(s string) error { _, err := parser.ParseValueExpression(s); return err },
	}, nil
}

// ParseCondition parses a condition.
func (l *Linter) ParseCondition(s string) error { return bounded(s, l.condition) }

// ParseStatement parses a statement.
func (l *Linter) ParseStatement(s string) error { return bounded(s, l.statement) }

// ParseValueExpression parses a value expression.
func (l *Linter) ParseValueExpression(s string) error { return bounded(s, l.valueExpression) }

// bounded never hands the recursive-descent parser a text past
// MaxExpressionBytes (lint.go's guard).
func bounded(s string, parse func(string) error) error {
	if err := checkExpressionLength(s); err != nil {
		return err
	}
	return parse(s)
}
