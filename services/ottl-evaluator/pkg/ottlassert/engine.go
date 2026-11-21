// The evaluation engine:
//
//   - each context's transform context is pooled and closed through each
//     record's close; ottlscope's takes the resource's schema-URL item (rs,
//     rm, rl at the three scope calls, as the third is the scope's);
//   - a Checkpoint is called every CheckEveryRecords records, in every
//     record collector and every evaluation loop, so a deadline ends the
//     work inside the loops; EvaluateRule returns its error and no result;
//   - a record's snippet is built lazily, only for the misses kept (at
//     most maxMisses);
//   - the output's documents are parsed once (ParseDocuments) and shared by
//     every rule (EvaluateRule); Evaluate is built on them;
//   - each rule's condition is parsed before its records are collected;
//   - ParseCondition and ParseValueExpression check a text with the same
//     converters-only parsers the evaluation uses;
//   - a failing any lists its first maxMisses records ("condition evaluated
//     to false"), as all does.

package ottlassert

import (
	"context"
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
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// Checkpoint is called inside the engine's loops. A non-nil error stops the
// work at once: the function that called it returns that error and no
// result. The evaluator's child passes one that answers an error once its
// deadline has passed; tests pass one that fails after N calls.
type Checkpoint func() error

// CheckEveryRecords is how often a record loop calls its Checkpoint.
const CheckEveryRecords = 256

func noCheckpoint() error { return nil }

// ticker calls its Checkpoint on every CheckEveryRecords-th tick.
type ticker struct {
	n     int
	check Checkpoint
}

func newTicker(check Checkpoint) *ticker {
	if check == nil {
		check = noCheckpoint
	}
	return &ticker{check: check}
}

func (t *ticker) tick() error {
	t.n++
	if t.n%CheckEveryRecords == 0 {
		return t.check()
	}
	return nil
}

// evalRecord pairs a ready-to-evaluate OTTL transform context with a
// human-readable snippet, built only when asked for, used in failure
// details. close returns the pooled transform context (v0.146+ contexts are
// pooled and must be closed).
type evalRecord[K any] struct {
	tCtx    K
	snippet func() string
	close   func()
}

func closeRecords[K any](recs []evalRecord[K]) {
	for _, rec := range recs {
		if rec.close != nil {
			rec.close()
		}
	}
}

// collector gathers records, calling its ticker for each one.
type collector[K any] struct {
	recs []evalRecord[K]
	t    *ticker
	err  error
}

func newCollector[K any](check Checkpoint) *collector[K] {
	return &collector[K]{t: newTicker(check)}
}

// add keeps one record; false means the checkpoint stopped the collection.
func (c *collector[K]) add(tCtx K, snippet func() string, close func()) bool {
	c.recs = append(c.recs, evalRecord[K]{tCtx: tCtx, snippet: snippet, close: close})
	if err := c.t.tick(); err != nil {
		c.err = err
		return false
	}
	return true
}

func (c *collector[K]) result() ([]evalRecord[K], error) {
	if c.err != nil {
		closeRecords(c.recs)
		return nil, c.err
	}
	return c.recs, nil
}

// Documents are an output's OTLP documents, parsed once and shared by every
// rule evaluated against them.
type Documents struct {
	set docSet
}

// DocumentError says which document of a payload isn't OTLP/JSON of the
// signal.
type DocumentError struct {
	// Index is the document's place, from 0.
	Index  int
	Signal Signal
	Err    error
}

func (e *DocumentError) Error() string {
	return fmt.Sprintf("document %d is not valid OTLP/JSON %s: %s", e.Index+1, e.Signal, e.Err)
}

func (e *DocumentError) Unwrap() error { return e.Err }

// ParseDocuments parses each raw document as OTLP/JSON of signal, calling
// check before each one. No documents is an empty output: every context
// then has zero records. An unknown signal or a document that doesn't parse
// is an error (a *DocumentError for the latter); so is check's.
func ParseDocuments(signal Signal, raws [][]byte, check Checkpoint) (*Documents, error) {
	if check == nil {
		check = noCheckpoint
	}
	var set docSet
	switch signal {
	case SignalTraces, SignalMetrics, SignalLogs:
	default:
		return nil, fmt.Errorf("unknown signal %q", signal)
	}
	for i, raw := range raws {
		if err := check(); err != nil {
			return nil, err
		}
		switch signal {
		case SignalTraces:
			u := &ptrace.JSONUnmarshaler{}
			td, err := u.UnmarshalTraces(raw)
			if err != nil {
				return nil, &DocumentError{Index: i, Signal: signal, Err: err}
			}
			set.traces = append(set.traces, td)
		case SignalMetrics:
			u := &pmetric.JSONUnmarshaler{}
			md, err := u.UnmarshalMetrics(raw)
			if err != nil {
				return nil, &DocumentError{Index: i, Signal: signal, Err: err}
			}
			set.metrics = append(set.metrics, md)
		case SignalLogs:
			u := &plog.JSONUnmarshaler{}
			ld, err := u.UnmarshalLogs(raw)
			if err != nil {
				return nil, &DocumentError{Index: i, Signal: signal, Err: err}
			}
			set.logs = append(set.logs, ld)
		}
	}
	return &Documents{set: set}, nil
}

// Evaluate parses payload as signal and evaluates every rule against it.
// Payload-level failures (unparseable payload, unknown signal) return an
// error; per-rule failures (bad condition, context/signal mismatch) are
// reported in that rule's Result so one bad rule never hides the others.
func Evaluate(ctx context.Context, signal Signal, payload string, rules []Rule) ([]Result, error) {
	docs, err := parsePayload(signal, payload)
	if err != nil {
		return nil, err
	}
	results := make([]Result, 0, len(rules))
	for _, rule := range rules {
		// No checkpoint, so no error.
		res, _ := EvaluateRule(ctx, signal, docs, rule, nil)
		results = append(results, res)
	}
	return results, nil
}

// EvaluateRule evaluates one rule against docs. The rule's own problems
// (a bad condition, a context the signal doesn't have) are in the Result;
// the only error is check's, which stops the rule with no result.
func EvaluateRule(ctx context.Context, signal Signal, docs *Documents, rule Rule, check Checkpoint) (Result, error) {
	if err := rule.validate(signal); err != nil {
		return Result{ID: rule.ID, Error: err.Error()}, nil
	}
	set := docs.set
	switch rule.Context {
	case ContextSpan:
		return evalContext(ctx, rule, newSpanParser, func() ([]evalRecord[*ottlspan.TransformContext], error) { return spanRecords(set, check) }, check)
	case ContextSpanEvent:
		return evalContext(ctx, rule, newSpanEventParser, func() ([]evalRecord[*ottlspanevent.TransformContext], error) { return spanEventRecords(set, check) }, check)
	case ContextMetric:
		return evalContext(ctx, rule, newMetricParser, func() ([]evalRecord[*ottlmetric.TransformContext], error) { return metricRecords(set, check) }, check)
	case ContextDataPoint:
		return evalContext(ctx, rule, newDataPointParser, func() ([]evalRecord[*ottldatapoint.TransformContext], error) { return dataPointRecords(set, check) }, check)
	case ContextLog:
		return evalContext(ctx, rule, newLogParser, func() ([]evalRecord[*ottllog.TransformContext], error) { return logRecords(set, check) }, check)
	case ContextResource:
		return evalContext(ctx, rule, newResourceParser, func() ([]evalRecord[*ottlresource.TransformContext], error) { return resourceRecords(set, check) }, check)
	case ContextScope:
		return evalContext(ctx, rule, newScopeParser, func() ([]evalRecord[*ottlscope.TransformContext], error) { return scopeRecords(set, check) }, check)
	default:
		return Result{ID: rule.ID, Error: fmt.Sprintf("unknown context %q", rule.Context)}, nil
	}
}

func evalContext[K any](ctx context.Context, rule Rule, newParser func() (ottl.Parser[K], error), collect func() ([]evalRecord[K], error), check Checkpoint) (Result, error) {
	res := Result{ID: rule.ID}
	parser, err := newParser()
	if err != nil {
		res.Error = fmt.Sprintf("failed to construct OTTL parser: %s", err)
		return res, nil
	}
	if rule.Quantifier == QuantifierDistinct {
		return evalDistinct(ctx, rule, parser, collect, check, res)
	}
	cond, err := parser.ParseCondition(rule.Condition)
	if err != nil {
		res.Error = fmt.Sprintf("invalid OTTL condition: %s", err)
		return res, nil
	}
	recs, err := collect()
	if err != nil {
		return Result{}, err
	}
	defer closeRecords(recs)
	res.TotalCount = len(recs)
	outcomes := make([]bool, len(recs))
	evalErrs := 0
	firstErr := ""
	t := newTicker(check)
	for i, rec := range recs {
		if err := t.tick(); err != nil {
			return Result{}, err
		}
		ok, err := cond.Eval(ctx, rec.tCtx)
		if err != nil {
			evalErrs++
			if firstErr == "" {
				firstErr = err.Error()
			}
			continue
		}
		outcomes[i] = ok
		if ok {
			res.MatchedCount++
		}
	}
	if evalErrs > 0 {
		res.Error = fmt.Sprintf("condition evaluation failed on %d of %d records: %s", evalErrs, len(recs), firstErr)
		return res, nil
	}
	switch rule.Quantifier {
	case QuantifierAll:
		// Vacuously true on zero records; TotalCount lets callers surface that.
		res.Passed = res.MatchedCount == len(recs)
		if !res.Passed {
			collectMisses(&res, recs, outcomes, false, "condition evaluated to false")
		}
	case QuantifierAny:
		// Every record missed: its first maxMisses are listed, as all's
		// are, so the misses agree with TotalMissCount.
		res.Passed = res.MatchedCount > 0
		if !res.Passed {
			collectMisses(&res, recs, outcomes, false, "condition evaluated to false")
		}
	case QuantifierNone:
		res.Passed = res.MatchedCount == 0
		if !res.Passed {
			collectMisses(&res, recs, outcomes, true, "unexpected match")
		}
	case QuantifierCount:
		res.Passed = rule.Count.matches(int64(res.MatchedCount))
	}
	return res, nil
}

// collectMisses records every index whose outcome equals offending, keeping
// at most maxMisses snippets (built only for those) while still counting the
// rest.
func collectMisses[K any](res *Result, recs []evalRecord[K], outcomes []bool, offending bool, reason string) {
	for i := range recs {
		if outcomes[i] != offending {
			continue
		}
		res.TotalMissCount++
		if len(res.Misses) < maxMisses {
			res.Misses = append(res.Misses, RecordMiss{Index: i, Reason: reason, Snippet: recs[i].snippet()})
		}
	}
}

// --- parser constructors (conditions only: converters, no editors) ---------

func newSpanParser() (ottl.Parser[*ottlspan.TransformContext], error) {
	return ottlspan.NewParser(ottlfuncs.StandardConverters[*ottlspan.TransformContext](), componenttest.NewNopTelemetrySettings())
}

func newSpanEventParser() (ottl.Parser[*ottlspanevent.TransformContext], error) {
	return ottlspanevent.NewParser(ottlfuncs.StandardConverters[*ottlspanevent.TransformContext](), componenttest.NewNopTelemetrySettings())
}

func newMetricParser() (ottl.Parser[*ottlmetric.TransformContext], error) {
	return ottlmetric.NewParser(ottlfuncs.StandardConverters[*ottlmetric.TransformContext](), componenttest.NewNopTelemetrySettings())
}

func newDataPointParser() (ottl.Parser[*ottldatapoint.TransformContext], error) {
	return ottldatapoint.NewParser(ottlfuncs.StandardConverters[*ottldatapoint.TransformContext](), componenttest.NewNopTelemetrySettings())
}

func newLogParser() (ottl.Parser[*ottllog.TransformContext], error) {
	return ottllog.NewParser(ottlfuncs.StandardConverters[*ottllog.TransformContext](), componenttest.NewNopTelemetrySettings())
}

func newResourceParser() (ottl.Parser[*ottlresource.TransformContext], error) {
	return ottlresource.NewParser(ottlfuncs.StandardConverters[*ottlresource.TransformContext](), componenttest.NewNopTelemetrySettings())
}

func newScopeParser() (ottl.Parser[*ottlscope.TransformContext], error) {
	return ottlscope.NewParser(ottlfuncs.StandardConverters[*ottlscope.TransformContext](), componenttest.NewNopTelemetrySettings())
}

// --- checking a text with the evaluation's own parsers ----------------------

// ParseCondition parses condition in context c with the converters-only
// parser EvaluateRule uses, so a condition that passes here parses there.
// The error is the parser's.
func ParseCondition(c Context, condition string) error {
	return parseWith(c, func(p parseFuncs) error { return p.condition(condition) })
}

// ParseValueExpression parses a value expression (a distinct rule's) in
// context c with the converters-only parser EvaluateRule uses.
func ParseValueExpression(c Context, expression string) error {
	return parseWith(c, func(p parseFuncs) error { return p.valueExpression(expression) })
}

type parseFuncs struct {
	condition       func(string) error
	valueExpression func(string) error
}

func funcsOf[K any](newParser func() (ottl.Parser[K], error)) (parseFuncs, error) {
	p, err := newParser()
	if err != nil {
		return parseFuncs{}, err
	}
	return parseFuncs{
		condition:       func(s string) error { _, err := p.ParseCondition(s); return err },
		valueExpression: func(s string) error { _, err := p.ParseValueExpression(s); return err },
	}, nil
}

func parseWith(c Context, parse func(parseFuncs) error) error {
	var funcs parseFuncs
	var err error
	switch c {
	case ContextSpan:
		funcs, err = funcsOf(newSpanParser)
	case ContextSpanEvent:
		funcs, err = funcsOf(newSpanEventParser)
	case ContextMetric:
		funcs, err = funcsOf(newMetricParser)
	case ContextDataPoint:
		funcs, err = funcsOf(newDataPointParser)
	case ContextLog:
		funcs, err = funcsOf(newLogParser)
	case ContextResource:
		funcs, err = funcsOf(newResourceParser)
	case ContextScope:
		funcs, err = funcsOf(newScopeParser)
	default:
		return fmt.Errorf("unknown context %q", c)
	}
	if err != nil {
		return fmt.Errorf("failed to construct OTTL parser: %w", err)
	}
	return parse(funcs)
}

// --- record collectors -----------------------------------------------------

func spanRecords(docs docSet, check Checkpoint) ([]evalRecord[*ottlspan.TransformContext], error) {
	c := newCollector[*ottlspan.TransformContext](check)
	for _, td := range docs.traces {
		rss := td.ResourceSpans()
		for i := 0; i < rss.Len(); i++ {
			rs := rss.At(i)
			sss := rs.ScopeSpans()
			for j := 0; j < sss.Len(); j++ {
				ss := sss.At(j)
				spans := ss.Spans()
				for k := 0; k < spans.Len(); k++ {
					span := spans.At(k)
					tCtx := ottlspan.NewTransformContext(rs, ss, span)
					if !c.add(tCtx, func() string { return spanSnippet(span) }, tCtx.Close) {
						return c.result()
					}
				}
			}
		}
	}
	return c.result()
}

func spanEventRecords(docs docSet, check Checkpoint) ([]evalRecord[*ottlspanevent.TransformContext], error) {
	c := newCollector[*ottlspanevent.TransformContext](check)
	for _, td := range docs.traces {
		rss := td.ResourceSpans()
		for i := 0; i < rss.Len(); i++ {
			rs := rss.At(i)
			sss := rs.ScopeSpans()
			for j := 0; j < sss.Len(); j++ {
				ss := sss.At(j)
				spans := ss.Spans()
				for k := 0; k < spans.Len(); k++ {
					span := spans.At(k)
					events := span.Events()
					for l := 0; l < events.Len(); l++ {
						ev := events.At(l)
						tCtx := ottlspanevent.NewTransformContext(rs, ss, span, ev)
						if !c.add(tCtx, func() string { return spanEventSnippet(ev, span) }, tCtx.Close) {
							return c.result()
						}
					}
				}
			}
		}
	}
	return c.result()
}

func logRecords(docs docSet, check Checkpoint) ([]evalRecord[*ottllog.TransformContext], error) {
	c := newCollector[*ottllog.TransformContext](check)
	for _, ld := range docs.logs {
		rls := ld.ResourceLogs()
		for i := 0; i < rls.Len(); i++ {
			rl := rls.At(i)
			sls := rl.ScopeLogs()
			for j := 0; j < sls.Len(); j++ {
				sl := sls.At(j)
				lrs := sl.LogRecords()
				for k := 0; k < lrs.Len(); k++ {
					lr := lrs.At(k)
					tCtx := ottllog.NewTransformContext(rl, sl, lr)
					if !c.add(tCtx, func() string { return logSnippet(lr) }, tCtx.Close) {
						return c.result()
					}
				}
			}
		}
	}
	return c.result()
}

func metricRecords(docs docSet, check Checkpoint) ([]evalRecord[*ottlmetric.TransformContext], error) {
	c := newCollector[*ottlmetric.TransformContext](check)
	for _, md := range docs.metrics {
		rms := md.ResourceMetrics()
		for i := 0; i < rms.Len(); i++ {
			rm := rms.At(i)
			sms := rm.ScopeMetrics()
			for j := 0; j < sms.Len(); j++ {
				sm := sms.At(j)
				metrics := sm.Metrics()
				for k := 0; k < metrics.Len(); k++ {
					m := metrics.At(k)
					tCtx := ottlmetric.NewTransformContext(rm, sm, m)
					if !c.add(tCtx, func() string { return metricSnippet(m) }, tCtx.Close) {
						return c.result()
					}
				}
			}
		}
	}
	return c.result()
}

func dataPointRecords(docs docSet, check Checkpoint) ([]evalRecord[*ottldatapoint.TransformContext], error) {
	c := newCollector[*ottldatapoint.TransformContext](check)
	for _, md := range docs.metrics {
		rms := md.ResourceMetrics()
		for i := 0; i < rms.Len(); i++ {
			rm := rms.At(i)
			sms := rm.ScopeMetrics()
			for j := 0; j < sms.Len(); j++ {
				sm := sms.At(j)
				metrics := sm.Metrics()
				for k := 0; k < metrics.Len(); k++ {
					m := metrics.At(k)
					add := func(dp any, snippet func() string) bool {
						tCtx := ottldatapoint.NewTransformContext(rm, sm, m, dp)
						return c.add(tCtx, snippet, tCtx.Close)
					}
					switch m.Type() {
					case pmetric.MetricTypeSum:
						dps := m.Sum().DataPoints()
						for l := 0; l < dps.Len(); l++ {
							dp := dps.At(l)
							if !add(dp, func() string { return dataPointSnippet(m, dp.Attributes()) }) {
								return c.result()
							}
						}
					case pmetric.MetricTypeGauge:
						dps := m.Gauge().DataPoints()
						for l := 0; l < dps.Len(); l++ {
							dp := dps.At(l)
							if !add(dp, func() string { return dataPointSnippet(m, dp.Attributes()) }) {
								return c.result()
							}
						}
					case pmetric.MetricTypeHistogram:
						dps := m.Histogram().DataPoints()
						for l := 0; l < dps.Len(); l++ {
							dp := dps.At(l)
							if !add(dp, func() string { return dataPointSnippet(m, dp.Attributes()) }) {
								return c.result()
							}
						}
					case pmetric.MetricTypeExponentialHistogram:
						dps := m.ExponentialHistogram().DataPoints()
						for l := 0; l < dps.Len(); l++ {
							dp := dps.At(l)
							if !add(dp, func() string { return dataPointSnippet(m, dp.Attributes()) }) {
								return c.result()
							}
						}
					case pmetric.MetricTypeSummary:
						dps := m.Summary().DataPoints()
						for l := 0; l < dps.Len(); l++ {
							dp := dps.At(l)
							if !add(dp, func() string { return dataPointSnippet(m, dp.Attributes()) }) {
								return c.result()
							}
						}
					}
				}
			}
		}
	}
	return c.result()
}

func resourceRecords(docs docSet, check Checkpoint) ([]evalRecord[*ottlresource.TransformContext], error) {
	c := newCollector[*ottlresource.TransformContext](check)
	for _, td := range docs.traces {
		rss := td.ResourceSpans()
		for i := 0; i < rss.Len(); i++ {
			rs := rss.At(i)
			tCtx := ottlresource.NewTransformContext(rs.Resource(), rs)
			if !c.add(tCtx, func() string { return resourceSnippet(rs.Resource()) }, tCtx.Close) {
				return c.result()
			}
		}
	}
	for _, md := range docs.metrics {
		rms := md.ResourceMetrics()
		for i := 0; i < rms.Len(); i++ {
			rm := rms.At(i)
			tCtx := ottlresource.NewTransformContext(rm.Resource(), rm)
			if !c.add(tCtx, func() string { return resourceSnippet(rm.Resource()) }, tCtx.Close) {
				return c.result()
			}
		}
	}
	for _, ld := range docs.logs {
		rls := ld.ResourceLogs()
		for i := 0; i < rls.Len(); i++ {
			rl := rls.At(i)
			tCtx := ottlresource.NewTransformContext(rl.Resource(), rl)
			if !c.add(tCtx, func() string { return resourceSnippet(rl.Resource()) }, tCtx.Close) {
				return c.result()
			}
		}
	}
	return c.result()
}

func scopeRecords(docs docSet, check Checkpoint) ([]evalRecord[*ottlscope.TransformContext], error) {
	c := newCollector[*ottlscope.TransformContext](check)
	for _, td := range docs.traces {
		rss := td.ResourceSpans()
		for i := 0; i < rss.Len(); i++ {
			rs := rss.At(i)
			sss := rs.ScopeSpans()
			for j := 0; j < sss.Len(); j++ {
				ss := sss.At(j)
				tCtx := ottlscope.NewTransformContext(ss.Scope(), rs.Resource(), ss, rs)
				if !c.add(tCtx, func() string { return scopeSnippet(ss.Scope()) }, tCtx.Close) {
					return c.result()
				}
			}
		}
	}
	for _, md := range docs.metrics {
		rms := md.ResourceMetrics()
		for i := 0; i < rms.Len(); i++ {
			rm := rms.At(i)
			sms := rm.ScopeMetrics()
			for j := 0; j < sms.Len(); j++ {
				sm := sms.At(j)
				tCtx := ottlscope.NewTransformContext(sm.Scope(), rm.Resource(), sm, rm)
				if !c.add(tCtx, func() string { return scopeSnippet(sm.Scope()) }, tCtx.Close) {
					return c.result()
				}
			}
		}
	}
	for _, ld := range docs.logs {
		rls := ld.ResourceLogs()
		for i := 0; i < rls.Len(); i++ {
			rl := rls.At(i)
			sls := rl.ScopeLogs()
			for j := 0; j < sls.Len(); j++ {
				sl := sls.At(j)
				tCtx := ottlscope.NewTransformContext(sl.Scope(), rl.Resource(), sl, rl)
				if !c.add(tCtx, func() string { return scopeSnippet(sl.Scope()) }, tCtx.Close) {
					return c.result()
				}
			}
		}
	}
	return c.result()
}
