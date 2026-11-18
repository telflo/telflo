// New in D15a Task 2 (plan Preflight ruling 8): what the evaluator's rule
// checks (internal/rules) need from this package, so the checks a rule gets
// at Save are exactly the ones a run applies.

package ottlassert

// signalContexts lists each signal's contexts in the order messages name
// them.
var signalContexts = map[Signal][]Context{
	SignalLogs:    {ContextLog, ContextResource, ContextScope},
	SignalTraces:  {ContextSpan, ContextSpanEvent, ContextResource, ContextScope},
	SignalMetrics: {ContextMetric, ContextDataPoint, ContextResource, ContextScope},
}

// ContextsOf lists the contexts a rule of signal may use (logs: log,
// resource, scope; traces: span, spanevent, resource, scope; metrics:
// metric, datapoint, resource, scope), nil for an unknown signal.
func ContextsOf(signal Signal) []Context {
	return append([]Context(nil), signalContexts[signal]...)
}

// ContextAllowed says whether a rule of signal may use context c: the same
// table Rule.validate checks.
func ContextAllowed(signal Signal, c Context) bool {
	return contextsBySignal[signal][c]
}

// FindSuspiciousEscape returns the single-escaped regex sequence (such as
// `\b`) in an OTTL text, or "" when there is none (escapes.go).
func FindSuspiciousEscape(expr string) string {
	return findSuspiciousEscape(expr)
}

// SuspiciousEscapeError is the message for a sequence FindSuspiciousEscape
// found.
func SuspiciousEscapeError(sequence string) string {
	return suspiciousEscapeError(sequence)
}
