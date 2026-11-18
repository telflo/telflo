// truncate keeps a snippet within 200 bytes, its "…" included, on a rune
// boundary (D15a plan Preflight ruling 5).

package ottlassert

import (
	"encoding/json"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

const maxSnippetChars = 200

func truncate(s string) string {
	return truncateBytes(s, maxSnippetChars)
}

func jsonSnippet(fields map[string]any) string {
	b, err := json.Marshal(fields)
	if err != nil {
		return ""
	}
	return truncate(string(b))
}

func spanSnippet(span ptrace.Span) string {
	return jsonSnippet(map[string]any{
		"name":       span.Name(),
		"attributes": span.Attributes().AsRaw(),
	})
}

func spanEventSnippet(ev ptrace.SpanEvent, span ptrace.Span) string {
	return jsonSnippet(map[string]any{
		"name":       ev.Name(),
		"span":       span.Name(),
		"attributes": ev.Attributes().AsRaw(),
	})
}

func logSnippet(lr plog.LogRecord) string {
	return jsonSnippet(map[string]any{
		"body":       lr.Body().AsString(),
		"severity":   lr.SeverityText(),
		"attributes": lr.Attributes().AsRaw(),
	})
}

func metricSnippet(m pmetric.Metric) string {
	return jsonSnippet(map[string]any{
		"name": m.Name(),
		"type": m.Type().String(),
	})
}

func dataPointSnippet(metric pmetric.Metric, attrs pcommon.Map) string {
	return jsonSnippet(map[string]any{
		"metric":     metric.Name(),
		"attributes": attrs.AsRaw(),
	})
}

func resourceSnippet(res pcommon.Resource) string {
	return jsonSnippet(map[string]any{
		"attributes": res.Attributes().AsRaw(),
	})
}

func scopeSnippet(scope pcommon.InstrumentationScope) string {
	return jsonSnippet(map[string]any{
		"name":    scope.Name(),
		"version": scope.Version(),
	})
}
