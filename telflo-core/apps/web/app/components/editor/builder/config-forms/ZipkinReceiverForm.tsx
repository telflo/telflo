import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, TextField } from "./form-context.js";
import { CORSConfigSection } from "./shared/CORSConfigSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";

/*
 * The Zipkin receiver's form, over the form's fields: each field writes its
 * own key. Collector claims are contrib v0.162.0's `receiver/zipkinreceiver`.
 *
 * - Endpoint unset shows the collector's default, `localhost:9411`
 *   (`factory.go:21`), as the placeholder and the "Default …" hint (the
 *   palette's seed, `0.0.0.0:9411`, stays). Cleared, the key is removed
 *   (never `""`).
 * - Parse String Tags writes `true` or `false`, unticked while unset
 *   (`factory.go:42`); the box sits beside its label and description in one
 *   row (the box moved down to sit centered on the label's first line).
 * - Security: the shared server TLS section at `tls` (HTTP) and CORS at `cors`
 *   (`confighttp.ServerConfig` squashed, `config.go:12-17`).
 *
 * Ids are fixed; no value reaches an attribute.
 */

export function ZipkinReceiverForm() {
  return (
    <div className="space-y-4">
      <TextField path={["endpoint"]} id="endpoint" label="Endpoint" defaultValue="localhost:9411" description="Listen address." />

      <CheckboxField
        path={["parse_string_tags"]}
        id="parse-string-tags"
        label="Parse String Tags"
        description="Convert legacy V1 string tags into int, bool, or float types."
        defaultChecked={false}
        rowClassName="flex items-start gap-2.5"
        describedClassName="grid flex-1 gap-1 leading-none"
        labelClassName="cursor-pointer text-sm font-medium"
        descriptionClassName="text-xs text-muted-foreground"
      />

      <ConfigSection title="Security">
        <TLSConfigSection path={["tls"]} protocolLabel="HTTP" variant="server" />

        <CORSConfigSection path={["cors"]} />
      </ConfigSection>
    </div>
  );
}
