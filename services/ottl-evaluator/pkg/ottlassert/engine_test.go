package ottlassert

import (
	"context"
	"strings"
	"testing"
)

const tracesDoc = `{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          {"key": "service.name", "value": {"stringValue": "checkout"}}
        ]
      },
      "scopeSpans": [
        {
          "scope": {"name": "telflo-test", "version": "1.0.0"},
          "spans": [
            {
              "traceId": "0102030405060708090a0b0c0d0e0f10",
              "spanId": "0102030405060708",
              "name": "GET /api/cart",
              "kind": 2,
              "startTimeUnixNano": "1000000000",
              "endTimeUnixNano": "2000000000",
              "attributes": [
                {"key": "http.status_code", "value": {"intValue": "200"}}
              ],
              "events": [
                {"timeUnixNano": "1500000000", "name": "cache.hit", "attributes": []}
              ],
              "status": {}
            },
            {
              "traceId": "0102030405060708090a0b0c0d0e0f10",
              "spanId": "1112131415161718",
              "name": "POST /api/checkout",
              "kind": 2,
              "startTimeUnixNano": "1000000000",
              "endTimeUnixNano": "3000000000",
              "attributes": [
                {"key": "http.status_code", "value": {"intValue": "500"}}
              ],
              "status": {"code": 2}
            }
          ]
        }
      ]
    }
  ]
}`

const logsLine1 = `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"scope":{"name":"applog"},"logRecords":[{"timeUnixNano":"1","severityText":"INFO","body":{"stringValue":"user logged in"},"attributes":[{"key":"env","value":{"stringValue":"prod"}}]}]}]}]}`
const logsLine2 = `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"scope":{"name":"applog"},"logRecords":[{"timeUnixNano":"2","severityText":"ERROR","body":{"stringValue":"payment failed"},"attributes":[{"key":"env","value":{"stringValue":"prod"}}]}]}]}]}`

const metricsDoc = `{
  "resourceMetrics": [
    {
      "resource": {
        "attributes": [
          {"key": "service.name", "value": {"stringValue": "api"}}
        ]
      },
      "scopeMetrics": [
        {
          "scope": {"name": "app-metrics"},
          "metrics": [
            {
              "name": "http_requests_total",
              "sum": {
                "aggregationTemporality": 2,
                "isMonotonic": true,
                "dataPoints": [
                  {
                    "startTimeUnixNano": "1",
                    "timeUnixNano": "2",
                    "asInt": "10",
                    "attributes": [
                      {"key": "route", "value": {"stringValue": "/api/cart"}}
                    ]
                  },
                  {
                    "startTimeUnixNano": "1",
                    "timeUnixNano": "2",
                    "asInt": "3",
                    "attributes": [
                      {"key": "route", "value": {"stringValue": "/api/checkout"}}
                    ]
                  }
                ]
              }
            },
            {
              "name": "process_uptime_seconds",
              "gauge": {
                "dataPoints": [
                  {"timeUnixNano": "2", "asDouble": 12.5, "attributes": []}
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}`

func mustEvaluate(t *testing.T, signal Signal, payload string, rules []Rule) []Result {
	t.Helper()
	results, err := Evaluate(context.Background(), signal, payload, rules)
	if err != nil {
		t.Fatalf("Evaluate returned error: %v", err)
	}
	if len(results) != len(rules) {
		t.Fatalf("expected %d results, got %d", len(rules), len(results))
	}
	return results
}

func TestSpanQuantifiers(t *testing.T) {
	rules := []Rule{
		{ID: "all-200", Context: ContextSpan, Condition: `attributes["http.status_code"] == 200`, Quantifier: QuantifierAll},
		{ID: "any-200", Context: ContextSpan, Condition: `attributes["http.status_code"] == 200`, Quantifier: QuantifierAny},
		{ID: "none-404", Context: ContextSpan, Condition: `attributes["http.status_code"] == 404`, Quantifier: QuantifierNone},
		{ID: "none-500", Context: ContextSpan, Condition: `attributes["http.status_code"] == 500`, Quantifier: QuantifierNone},
		{ID: "count-2", Context: ContextSpan, Condition: `true`, Quantifier: QuantifierCount, Count: &CountSpec{Operator: "eq", Value: 2}},
	}
	results := mustEvaluate(t, SignalTraces, tracesDoc, rules)

	if results[0].Passed {
		t.Errorf("all-200 should fail: one span is 500")
	}
	if results[0].MatchedCount != 1 || results[0].TotalCount != 2 {
		t.Errorf("all-200 counts wrong: %+v", results[0])
	}
	if len(results[0].Misses) != 1 || !strings.Contains(results[0].Misses[0].Snippet, "checkout") {
		t.Errorf("all-200 should report the failing span, got %+v", results[0].Misses)
	}
	if !results[1].Passed {
		t.Errorf("any-200 should pass: %+v", results[1])
	}
	if !results[2].Passed {
		t.Errorf("none-404 should pass: %+v", results[2])
	}
	if results[3].Passed {
		t.Errorf("none-500 should fail")
	}
	if len(results[3].Misses) != 1 || results[3].Misses[0].Reason != "unexpected match" {
		t.Errorf("none-500 should report the unexpected match, got %+v", results[3].Misses)
	}
	if !results[4].Passed {
		t.Errorf("count-2 should pass: %+v", results[4])
	}
}

func TestBooleanComposition(t *testing.T) {
	rules := []Rule{
		// Same-record AND: one span must satisfy both predicates at once.
		{ID: "and-same-record", Context: ContextSpan,
			Condition:  `attributes["http.status_code"] == 500 and IsMatch(name, "POST.*")`,
			Quantifier: QuantifierAny},
		// OR with grouping and NOT.
		{ID: "or-not", Context: ContextSpan,
			Condition:  `(attributes["http.status_code"] == 200 or attributes["http.status_code"] == 500) and not (name == "nope")`,
			Quantifier: QuantifierAll},
		// AND that no single record satisfies, even though each half matches
		// some record — proves same-record semantics.
		{ID: "and-no-single-record", Context: ContextSpan,
			Condition:  `attributes["http.status_code"] == 200 and IsMatch(name, "POST.*")`,
			Quantifier: QuantifierAny},
	}
	results := mustEvaluate(t, SignalTraces, tracesDoc, rules)
	if !results[0].Passed {
		t.Errorf("and-same-record should pass (the 500 span is the POST): %+v", results[0])
	}
	if !results[1].Passed {
		t.Errorf("or-not should pass for every span: %+v", results[1])
	}
	if results[2].Passed {
		t.Errorf("and-no-single-record must fail: no span is both 200 and POST")
	}
}

func TestSpanEventAndScopeAndResource(t *testing.T) {
	rules := []Rule{
		{ID: "event", Context: ContextSpanEvent, Condition: `name == "cache.hit"`, Quantifier: QuantifierAny},
		{ID: "resource", Context: ContextResource, Condition: `attributes["service.name"] == "checkout"`, Quantifier: QuantifierAll},
		{ID: "scope", Context: ContextScope, Condition: `name == "telflo-test"`, Quantifier: QuantifierAll},
	}
	results := mustEvaluate(t, SignalTraces, tracesDoc, rules)
	for _, r := range results {
		if !r.Passed {
			t.Errorf("rule %s should pass: %+v", r.ID, r)
		}
	}
}

func TestLogsNDJSON(t *testing.T) {
	payload := logsLine1 + "\n" + logsLine2 + "\n"
	rules := []Rule{
		{ID: "err-any", Context: ContextLog, Condition: `severity_text == "ERROR"`, Quantifier: QuantifierAny},
		{ID: "prod-all", Context: ContextLog, Condition: `attributes["env"] == "prod"`, Quantifier: QuantifierAll},
		{ID: "body-match", Context: ContextLog, Condition: `IsMatch(body, "payment.*")`, Quantifier: QuantifierCount, Count: &CountSpec{Operator: "eq", Value: 1}},
	}
	results := mustEvaluate(t, SignalLogs, payload, rules)
	for _, r := range results {
		if !r.Passed {
			t.Errorf("rule %s should pass: %+v", r.ID, r)
		}
	}
	if results[0].TotalCount != 2 {
		t.Errorf("expected 2 log records across NDJSON lines, got %d", results[0].TotalCount)
	}
}

func TestMetricsAndDataPoints(t *testing.T) {
	rules := []Rule{
		{ID: "metric-name", Context: ContextMetric, Condition: `name == "http_requests_total"`, Quantifier: QuantifierAny},
		{ID: "dp-count", Context: ContextDataPoint, Condition: `true`, Quantifier: QuantifierCount, Count: &CountSpec{Operator: "eq", Value: 3}},
		{ID: "dp-route", Context: ContextDataPoint, Condition: `attributes["route"] == "/api/checkout"`, Quantifier: QuantifierCount, Count: &CountSpec{Operator: "eq", Value: 1}},
	}
	results := mustEvaluate(t, SignalMetrics, metricsDoc, rules)
	for _, r := range results {
		if !r.Passed {
			t.Errorf("rule %s should pass: %+v", r.ID, r)
		}
	}
}

func TestPayloadArrayForm(t *testing.T) {
	payload := "[" + logsLine1 + "," + logsLine2 + "]"
	rules := []Rule{
		{ID: "count", Context: ContextLog, Condition: `true`, Quantifier: QuantifierCount, Count: &CountSpec{Operator: "eq", Value: 2}},
	}
	results := mustEvaluate(t, SignalLogs, payload, rules)
	if !results[0].Passed {
		t.Errorf("expected 2 records from JSON array payload: %+v", results[0])
	}
}

func TestRuleErrors(t *testing.T) {
	rules := []Rule{
		{ID: "bad-condition", Context: ContextSpan, Condition: `attributes[`, Quantifier: QuantifierAny},
		{ID: "wrong-context", Context: ContextLog, Condition: `true`, Quantifier: QuantifierAny},
		{ID: "bad-quantifier", Context: ContextSpan, Condition: `true`, Quantifier: "sometimes"},
		{ID: "count-no-spec", Context: ContextSpan, Condition: `true`, Quantifier: QuantifierCount},
		// Rejected before parsing: unbounded nesting would exhaust the
		// recursive-descent parser's stack (a fatal crash, not a panic).
		{ID: "oversized", Context: ContextSpan, Condition: strings.Repeat("(", MaxExpressionBytes+1), Quantifier: QuantifierAny},
	}
	results := mustEvaluate(t, SignalTraces, tracesDoc, rules)
	if results[0].Error == "" || !strings.Contains(results[0].Error, "invalid OTTL condition") {
		t.Errorf("bad-condition should report a parse error: %+v", results[0])
	}
	if results[1].Error == "" || !strings.Contains(results[1].Error, "not valid for signal") {
		t.Errorf("wrong-context should report a context/signal mismatch: %+v", results[1])
	}
	if results[2].Error == "" {
		t.Errorf("bad-quantifier should report an error: %+v", results[2])
	}
	if results[3].Error == "" {
		t.Errorf("count-no-spec should report an error: %+v", results[3])
	}
	if results[4].Error == "" || !strings.Contains(results[4].Error, "maximum") {
		t.Errorf("oversized condition should report a length-cap error: %+v", results[4])
	}
	for _, r := range results {
		if r.Passed {
			t.Errorf("errored rule %s must not pass", r.ID)
		}
	}
}

func TestEmptyAndInvalidPayloads(t *testing.T) {
	if _, err := Evaluate(context.Background(), SignalTraces, "   ", nil); err == nil {
		t.Errorf("empty payload should error")
	}
	if _, err := Evaluate(context.Background(), SignalTraces, "not json at all", nil); err == nil {
		t.Errorf("non-JSON payload should error")
	}
	if _, err := Evaluate(context.Background(), "profiles", tracesDoc, nil); err == nil {
		t.Errorf("unknown signal should error")
	}
}

func TestDistinctQuantifier(t *testing.T) {
	rules := []Rule{
		// 3 datapoints, 2 carry route (2 distinct values), 1 has none (nil,
		// excluded from the set).
		{ID: "routes-lte-2", Context: ContextDataPoint, Expression: `attributes["route"]`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "lte", Value: 2}},
		{ID: "routes-lt-2", Context: ContextDataPoint, Expression: `attributes["route"]`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "lt", Value: 2}},
		// Absent attribute: distinct 0 — `lte 0` keeps its "never appears"
		// meaning.
		{ID: "absent-eq-0", Context: ContextDataPoint, Expression: `attributes["nonexistent"]`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "eq", Value: 0}},
		// Row filter via the condition: only http_requests_total datapoints
		// contribute.
		{ID: "filtered", Context: ContextDataPoint, Condition: `metric.name == "http_requests_total"`,
			Expression: `attributes["route"]`, Quantifier: QuantifierDistinct,
			Count: &CountSpec{Operator: "eq", Value: 2}},
		// A filter matching nothing yields an empty set.
		{ID: "filter-none", Context: ContextDataPoint, Condition: `metric.name == "no_such_metric"`,
			Expression: `attributes["route"]`, Quantifier: QuantifierDistinct,
			Count: &CountSpec{Operator: "eq", Value: 0}},
	}
	results := mustEvaluate(t, SignalMetrics, metricsDoc, rules)

	if !results[0].Passed || results[0].DistinctCount != 2 {
		t.Errorf("routes-lte-2 should pass with 2 distinct routes: %+v", results[0])
	}
	if results[0].TotalCount != 3 || results[0].MatchedCount != 3 {
		t.Errorf("routes-lte-2 should evaluate all 3 datapoints: %+v", results[0])
	}
	if results[1].Passed {
		t.Errorf("routes-lt-2 should fail: 2 distinct routes")
	}
	if len(results[1].DistinctSamples) != 2 {
		t.Errorf("failing distinct rule should carry samples: %+v", results[1])
	}
	found := false
	for _, s := range results[1].DistinctSamples {
		if s == "/api/cart" {
			found = true
		}
	}
	if !found {
		t.Errorf("samples should include an observed value, got %v", results[1].DistinctSamples)
	}
	if !results[2].Passed || results[2].DistinctCount != 0 {
		t.Errorf("absent-eq-0 should pass with 0 distinct: %+v", results[2])
	}
	if !results[3].Passed {
		t.Errorf("filtered should pass: %+v", results[3])
	}
	if results[3].MatchedCount != 2 {
		t.Errorf("filtered should only evaluate the 2 matching datapoints: %+v", results[3])
	}
	if !results[4].Passed || results[4].MatchedCount != 0 {
		t.Errorf("filter-none should pass with an empty set: %+v", results[4])
	}
}

func TestDistinctConverterExpression(t *testing.T) {
	// Converters compose in the expression — the composite-key case JSONPath
	// could never express.
	rules := []Rule{
		{ID: "composite", Context: ContextSpan,
			Expression: `Concat([attributes["http.status_code"], name], "|")`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "eq", Value: 2}},
		{ID: "span-names", Context: ContextSpan, Expression: `name`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "between", Value: 1, Value2: int64Ptr(2)}},
	}
	results := mustEvaluate(t, SignalTraces, tracesDoc, rules)
	for _, r := range results {
		if !r.Passed {
			t.Errorf("rule %s should pass: %+v", r.ID, r)
		}
	}
}

func TestDistinctTypedValues(t *testing.T) {
	// int64 attribute values stay distinct by value; the type prefix keeps
	// cross-type collisions impossible.
	rules := []Rule{
		{ID: "status-codes", Context: ContextSpan, Expression: `attributes["http.status_code"]`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "eq", Value: 2}},
	}
	results := mustEvaluate(t, SignalTraces, tracesDoc, rules)
	if !results[0].Passed || results[0].DistinctCount != 2 {
		t.Errorf("status-codes should count 2 distinct int values: %+v", results[0])
	}
}

func TestDistinctRuleErrors(t *testing.T) {
	rules := []Rule{
		{ID: "no-expression", Context: ContextSpan, Quantifier: QuantifierDistinct,
			Count: &CountSpec{Operator: "lte", Value: 5}},
		{ID: "no-count", Context: ContextSpan, Expression: `name`, Quantifier: QuantifierDistinct},
		{ID: "expr-wrong-quantifier", Context: ContextSpan, Condition: `true`,
			Expression: `name`, Quantifier: QuantifierAll},
		{ID: "bad-expression", Context: ContextSpan, Expression: `attributes[`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "lte", Value: 5}},
		{ID: "escaped-expression", Context: ContextSpan, Expression: `Concat([name, "\d"], "|")`,
			Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "lte", Value: 5}},
	}
	results := mustEvaluate(t, SignalTraces, tracesDoc, rules)
	if results[0].Error == "" || !strings.Contains(results[0].Error, "requires an expression") {
		t.Errorf("no-expression should error: %+v", results[0])
	}
	if results[1].Error == "" || !strings.Contains(results[1].Error, "requires a count spec") {
		t.Errorf("no-count should error: %+v", results[1])
	}
	if results[2].Error == "" || !strings.Contains(results[2].Error, "only valid with quantifier") {
		t.Errorf("expr-wrong-quantifier should error: %+v", results[2])
	}
	if results[3].Error == "" || !strings.Contains(results[3].Error, "invalid OTTL value expression") {
		t.Errorf("bad-expression should report a parse error: %+v", results[3])
	}
	if results[4].Error == "" || !strings.Contains(results[4].Error, "single-escaped") {
		t.Errorf("escaped-expression should trip the escape guard: %+v", results[4])
	}
	for _, r := range results {
		if r.Passed {
			t.Errorf("errored rule %s must not pass", r.ID)
		}
	}
}

func int64Ptr(v int64) *int64 { return &v }

func TestVacuousAll(t *testing.T) {
	// A logs payload with zero records matching a span-less document: use an
	// empty resourceLogs doc so the context yields no records.
	payload := `{"resourceLogs":[]}`
	rules := []Rule{
		{ID: "vacuous", Context: ContextLog, Condition: `true`, Quantifier: QuantifierAll},
		{ID: "any-empty", Context: ContextLog, Condition: `true`, Quantifier: QuantifierAny},
	}
	results := mustEvaluate(t, SignalLogs, payload, rules)
	if !results[0].Passed || results[0].TotalCount != 0 {
		t.Errorf("all over zero records is vacuously true with TotalCount 0: %+v", results[0])
	}
	if results[1].Passed {
		t.Errorf("any over zero records must fail: %+v", results[1])
	}
}
