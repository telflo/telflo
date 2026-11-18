// New in D15a Task 2 (plan Preflight ruling 10): every record loop calls its
// Checkpoint, in every context, and stops with its error; a miss's snippet
// is built only for the misses kept.

package ottlassert

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

var errStop = errors.New("stop")

// failingAt fails from its n-th call on, counting them.
func failingAt(n int) (Checkpoint, *int) {
	calls := 0
	return func() error {
		calls++
		if calls >= n {
			return errStop
		}
		return nil
	}, &calls
}

func join(n int, item func(i int) string) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = item(i)
	}
	return strings.Join(parts, ",")
}

// 300 of every record of each context: past CheckEveryRecords.
var (
	manyLogs = `{"resourceLogs":[` + join(300, func(i int) string {
		return fmt.Sprintf(`{"resource":{},"scopeLogs":[{"scope":{"name":"s%d"},"logRecords":[{"body":{"stringValue":"r%d"}}]}]}`, i, i)
	}) + `]}`
	manySpans = `{"resourceSpans":[{"resource":{},"scopeSpans":[{"scope":{},"spans":[` + join(300, func(i int) string {
		return fmt.Sprintf(`{"traceId":"0102030405060708090a0b0c0d0e0f10","spanId":"%016x","name":"s%d","events":[{"name":"e"}]}`, i+1, i)
	}) + `]}]}]}`
	manyMetrics = `{"resourceMetrics":[{"resource":{},"scopeMetrics":[{"scope":{},"metrics":[` + join(300, func(i int) string {
		return fmt.Sprintf(`{"name":"m%d","gauge":{"dataPoints":[{"asInt":"1"}]}}`, i)
	}) + `]}]}]}`
)

func TestEveryRecordLoopCallsItsCheckpoint(t *testing.T) {
	for _, c := range []struct {
		signal  Signal
		payload string
		context Context
	}{
		{SignalLogs, manyLogs, ContextLog},
		{SignalLogs, manyLogs, ContextResource},
		{SignalLogs, manyLogs, ContextScope},
		{SignalTraces, manySpans, ContextSpan},
		{SignalTraces, manySpans, ContextSpanEvent},
		{SignalMetrics, manyMetrics, ContextMetric},
		{SignalMetrics, manyMetrics, ContextDataPoint},
	} {
		raws, err := SplitPayload(c.payload)
		if err != nil {
			t.Fatal(err)
		}
		docs, err := ParseDocuments(c.signal, raws, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, rule := range []Rule{
			{ID: "all", Context: c.context, Condition: "true", Quantifier: QuantifierAll},
			{ID: "distinct", Context: c.context, Expression: `"x"`, Quantifier: QuantifierDistinct, Count: &CountSpec{Operator: "eq", Value: 1}},
		} {
			// Unstopped, it passes over 300 records.
			res, err := EvaluateRule(context.Background(), c.signal, docs, rule, nil)
			if err != nil || !res.Passed || res.TotalCount != 300 {
				t.Fatalf("%s/%s: %+v %v", c.context, rule.ID, res, err)
			}
			// The first checkpoint call is in the record collection: it stops
			// the rule there.
			check, calls := failingAt(1)
			if _, err := EvaluateRule(context.Background(), c.signal, docs, rule, check); !errors.Is(err, errStop) || *calls != 1 {
				t.Errorf("%s/%s: collection: err %v after %d calls", c.context, rule.ID, err, *calls)
			}
			// The second is in the evaluation loop.
			check, calls = failingAt(2)
			if _, err := EvaluateRule(context.Background(), c.signal, docs, rule, check); !errors.Is(err, errStop) || *calls != 2 {
				t.Errorf("%s/%s: evaluation: err %v after %d calls", c.context, rule.ID, err, *calls)
			}
		}
	}
}

func TestParseDocumentsCallsItsCheckpointBeforeEachDocument(t *testing.T) {
	raws, _ := SplitPayload(logsLine1 + "\n" + logsLine2)
	check, calls := failingAt(2)
	if _, err := ParseDocuments(SignalLogs, raws, check); !errors.Is(err, errStop) || *calls != 2 {
		t.Fatalf("err %v after %d calls", err, *calls)
	}
	var documentErr *DocumentError
	if _, err := ParseDocuments(SignalLogs, [][]byte{[]byte(`{"resourceLogs":7}`)}, nil); !errors.As(err, &documentErr) || documentErr.Index != 0 {
		t.Fatalf("a bad document: %v", err)
	}
}

// Snippets are built lazily: for the misses kept, never for every record.
func TestOnlyTheKeptMissesBuildSnippets(t *testing.T) {
	built := 0
	recs := make([]evalRecord[int], 1000)
	outcomes := make([]bool, 1000)
	for i := range recs {
		recs[i] = evalRecord[int]{snippet: func() string { built++; return "s" }}
	}
	var res Result
	collectMisses(&res, recs, outcomes, false, "condition evaluated to false")
	if res.TotalMissCount != 1000 || len(res.Misses) != maxMisses || built != maxMisses {
		t.Fatalf("misses %d of %d, %d snippets built", len(res.Misses), res.TotalMissCount, built)
	}
}

func TestSnippetsAndSamplesStayWithinTheirBytes(t *testing.T) {
	for _, s := range []string{strings.Repeat("x", 500), strings.Repeat("é", 150), strings.Repeat("€", 100)} {
		if got := truncate(s); len(got) > maxSnippetChars || !strings.HasSuffix(got, "…") {
			t.Errorf("snippet %d bytes: %q", len(got), got)
		}
		if got := truncateDisplay(s); len(got) > maxDisplayBytes || !strings.HasSuffix(got, "…") {
			t.Errorf("sample %d bytes: %q", len(got), got)
		}
	}
	if got := truncate("short"); got != "short" {
		t.Errorf("%q", got)
	}
}

func TestParseConditionUsesTheEvaluationsParser(t *testing.T) {
	if err := ParseCondition(ContextLog, `IsMatch(body, "x") and Coalesce([attributes["a"], "b"]) == "b"`); err != nil {
		t.Errorf("a valid condition: %v", err)
	}
	if err := ParseCondition(ContextLog, `attributes[`); err == nil {
		t.Error("a broken condition parsed")
	}
	if err := ParseValueExpression(ContextSpan, `Concat([name, "x"], "|")`); err != nil {
		t.Errorf("a valid expression: %v", err)
	}
	if err := ParseCondition("banana", "true"); err == nil {
		t.Error("an unknown context parsed")
	}
}
