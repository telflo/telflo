// parsePayload's per-document parse is ParseDocuments (engine.go), which a
// deadline can stop between documents; SplitPayload exports splitDocs.

package ottlassert

import (
	"encoding/json"
	"fmt"
	"strings"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// docSet holds every OTLP document parsed out of a payload. Only the slice
// matching the request signal is populated.
type docSet struct {
	traces  []ptrace.Traces
	metrics []pmetric.Metrics
	logs    []plog.Logs
}

// splitDocs accepts the three shapes the Telflo testing sandbox produces or
// accepts as fixtures: a single OTLP/JSON document, a JSON array of documents,
// or NDJSON (one document per line — the file exporter's capture format).
func splitDocs(text string) ([][]byte, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, fmt.Errorf("payload is empty")
	}
	if json.Valid([]byte(trimmed)) {
		if strings.HasPrefix(trimmed, "[") {
			var docs []json.RawMessage
			if err := json.Unmarshal([]byte(trimmed), &docs); err != nil {
				return nil, fmt.Errorf("payload is not a valid JSON array: %w", err)
			}
			out := make([][]byte, 0, len(docs))
			for _, d := range docs {
				out = append(out, []byte(d))
			}
			return out, nil
		}
		return [][]byte{[]byte(trimmed)}, nil
	}
	// Not one JSON value: treat as NDJSON.
	var out [][]byte
	for i, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !json.Valid([]byte(line)) {
			return nil, fmt.Errorf("payload line %d is not valid JSON", i+1)
		}
		out = append(out, []byte(line))
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("payload contains no JSON documents")
	}
	return out, nil
}

// SplitPayload splits text into its OTLP/JSON documents: one JSON value, a
// JSON array of documents, or NDJSON (splitDocs).
func SplitPayload(text string) ([][]byte, error) {
	return splitDocs(text)
}

func parsePayload(signal Signal, text string) (*Documents, error) {
	raws, err := splitDocs(text)
	if err != nil {
		return nil, err
	}
	return ParseDocuments(signal, raws, nil)
}
