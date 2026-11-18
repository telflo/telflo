// Package ottlassert evaluates OTTL conditions as assertions against OTLP
// payloads. It is deliberately independent of the HTTP layer so it can later
// be proposed upstream (alongside pkg/pdatatest / pkg/golden) as a
// condition-based assertion package for collector pipeline tests.
package ottlassert

import "fmt"

// Signal identifies the telemetry signal a payload carries.
type Signal string

const (
	SignalTraces  Signal = "traces"
	SignalMetrics Signal = "metrics"
	SignalLogs    Signal = "logs"
)

// Context is the OTTL context a rule's condition is written against.
type Context string

const (
	ContextSpan      Context = "span"
	ContextSpanEvent Context = "spanevent"
	ContextMetric    Context = "metric"
	ContextDataPoint Context = "datapoint"
	ContextLog       Context = "log"
	ContextResource  Context = "resource"
	ContextScope     Context = "scope"
)

// MaxExpressionBytes caps a single OTTL expression (condition, statement, or
// value expression). OTTL's recursive-descent parser recurses once per
// nesting level, so an unbounded expression (megabytes of "(") can exhaust
// the goroutine stack — a fatal runtime crash, not a recoverable panic. 8KB
// is orders of magnitude above any real expression; enforced here in the
// library so every entry point (Lint, Evaluate) is covered.
const MaxExpressionBytes = 8 << 10

func checkExpressionLength(s string) error {
	if len(s) > MaxExpressionBytes {
		return fmt.Errorf(
			"expression is %d bytes; the maximum is %d — oversized expressions are rejected to protect the parser",
			len(s), MaxExpressionBytes,
		)
	}
	return nil
}

// Quantifier folds per-record condition outcomes into a single verdict.
// "distinct" is the odd one out: instead of folding boolean outcomes it
// evaluates a value expression per record, counts DISTINCT non-nil values,
// and compares that count against the rule's CountSpec — the cardinality
// assertion ("no more than N distinct k8s.pod.name values").
type Quantifier string

const (
	QuantifierAll      Quantifier = "all"
	QuantifierAny      Quantifier = "any"
	QuantifierNone     Quantifier = "none"
	QuantifierCount    Quantifier = "count"
	QuantifierDistinct Quantifier = "distinct"
)

// CountSpec compares the number of matching records against a threshold.
// Operator "between" is inclusive on both ends and requires Value2.
type CountSpec struct {
	Operator string `json:"operator"`
	Value    int64  `json:"value"`
	Value2   *int64 `json:"value2,omitempty"`
}

// Rule is one assertion: an OTTL condition evaluated per record in Context,
// folded by Quantifier. With QuantifierDistinct the roles shift: Expression
// (an OTTL value expression, e.g. `attributes["k8s.pod.name"]` or
// `Concat([attributes["region"], attributes["pod"]], "|")`) is evaluated per
// record and Condition becomes an OPTIONAL row filter — only records where
// it holds contribute values to the distinct set.
type Rule struct {
	ID         string     `json:"id"`
	Context    Context    `json:"context"`
	Condition  string     `json:"condition"`
	Quantifier Quantifier `json:"quantifier"`
	Count      *CountSpec `json:"count,omitempty"`
	Expression string     `json:"expression,omitempty"`
}

// RecordMiss pinpoints one record that caused a rule to fail.
type RecordMiss struct {
	Index   int    `json:"index"`
	Reason  string `json:"reason"`
	Snippet string `json:"snippet,omitempty"`
}

// Result is the outcome of one rule. For QuantifierDistinct rules,
// MatchedCount is the number of records that passed the filter (all records
// when no filter is set), DistinctCount is the size of the distinct-value
// set, and DistinctSamples holds up to maxMisses observed values (first-seen
// order) when the rule fails — so the user can see WHICH values blew the
// threshold, not just how many.
type Result struct {
	ID              string       `json:"id"`
	Passed          bool         `json:"passed"`
	Error           string       `json:"error,omitempty"`
	MatchedCount    int          `json:"matched_count"`
	TotalCount      int          `json:"total_count"`
	Misses          []RecordMiss `json:"misses,omitempty"`
	TotalMissCount  int          `json:"total_miss_count,omitempty"`
	DistinctCount   int          `json:"distinct_count,omitempty"`
	DistinctSamples []string     `json:"distinct_samples,omitempty"`
}

const maxMisses = 5

var contextsBySignal = map[Signal]map[Context]bool{
	SignalTraces:  {ContextSpan: true, ContextSpanEvent: true, ContextResource: true, ContextScope: true},
	SignalMetrics: {ContextMetric: true, ContextDataPoint: true, ContextResource: true, ContextScope: true},
	SignalLogs:    {ContextLog: true, ContextResource: true, ContextScope: true},
}

func (r Rule) validate(signal Signal) error {
	// Distinct rules invert the condition contract: the expression is the
	// required half and the condition is an optional row filter.
	if r.Quantifier == QuantifierDistinct {
		if r.Expression == "" {
			return fmt.Errorf("quantifier %q requires an expression", QuantifierDistinct)
		}
	} else {
		if r.Expression != "" {
			return fmt.Errorf("expression is only valid with quantifier %q", QuantifierDistinct)
		}
		if r.Condition == "" {
			return fmt.Errorf("condition must not be empty")
		}
	}
	for _, s := range []string{r.Condition, r.Expression} {
		if s == "" {
			continue
		}
		if err := checkExpressionLength(s); err != nil {
			return err
		}
		if seq := findSuspiciousEscape(s); seq != "" {
			return fmt.Errorf("%s", suspiciousEscapeError(seq))
		}
	}
	allowed, ok := contextsBySignal[signal]
	if !ok {
		return fmt.Errorf("unknown signal %q", signal)
	}
	if !allowed[r.Context] {
		return fmt.Errorf("context %q is not valid for signal %q", r.Context, signal)
	}
	switch r.Quantifier {
	case QuantifierAll, QuantifierAny, QuantifierNone:
		if r.Count != nil {
			return fmt.Errorf("count spec is only valid with quantifiers %q and %q", QuantifierCount, QuantifierDistinct)
		}
	case QuantifierCount, QuantifierDistinct:
		if r.Count == nil {
			return fmt.Errorf("quantifier %q requires a count spec", r.Quantifier)
		}
		if err := r.Count.validate(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown quantifier %q", r.Quantifier)
	}
	return nil
}

func (c CountSpec) validate() error {
	switch c.Operator {
	case "eq", "ne", "gt", "gte", "lt", "lte":
		return nil
	case "between":
		if c.Value2 == nil {
			return fmt.Errorf("count operator %q requires value2", c.Operator)
		}
		return nil
	default:
		return fmt.Errorf("unknown count operator %q", c.Operator)
	}
}

func (c CountSpec) matches(n int64) bool {
	switch c.Operator {
	case "eq":
		return n == c.Value
	case "ne":
		return n != c.Value
	case "gt":
		return n > c.Value
	case "gte":
		return n >= c.Value
	case "lt":
		return n < c.Value
	case "lte":
		return n <= c.Value
	case "between":
		return n >= c.Value && c.Value2 != nil && n <= *c.Value2
	default:
		return false
	}
}
