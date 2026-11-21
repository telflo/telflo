import { SelectField, TextField } from "./form-context.js";

/*
 * The Zipkin exporter's form, over the form's fields: each field writes its
 * own key. Collector claims are contrib v0.162.0's `exporter/zipkinexporter`.
 *
 * - Endpoint is required (`config.go:33-37`, "endpoint required"); cleared,
 *   the key is removed (not `""`), which the collector refuses as it refuses
 *   `""`: the person's change.
 * - Format unset is blank with the placeholder JSON and "Default json"
 *   (`factory.go:20-26`), not json as the value. A format outside json and
 *   proto (`format: JSON`, refused, `zipkin.go:50-56`) shows as written.
 * - No new controls: retry, queue, TLS, timeout and headers stay in the YAML
 *   box.
 *
 * Ids are fixed; no value reaches an attribute.
 */

const FORMATS = [
  { value: "json", label: "JSON" },
  { value: "proto", label: "Protobuf" },
] as const;

export function ZipkinExporterForm() {
  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="endpoint"
        label="Endpoint"
        required
        description="Full URL of the Zipkin span-ingest API."
        placeholder="e.g. http://zipkin:9411/api/v2/spans"
      />

      <SelectField path={["format"]} id="format" label="Format" defaultValue="json" options={FORMATS} />
    </div>
  );
}
