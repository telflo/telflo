import { ConfigSection } from "./ConfigSection.js";
import { TextareaField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";

/*
 * The health check extension's form (ADR 0018), over the form's fields
 * (D9b decisions 2 and 3): each field writes its own key; the TLS section
 * is the server section (Preflight ruling 4). The collector's defaults
 * (health_check `createDefaultConfig`, contrib v0.162.0: `localhost:13133`,
 * path `/`) show while a key is unset.
 *
 * The sections' counts read the text: the response bodies set, and the
 * `tls` block's keys.
 */

export function HealthCheckForm() {
  const form = useForm();
  const healthy = form.read(["response_body", "healthy"]);
  const unhealthy = form.read(["response_body", "unhealthy"]);
  const responseBodyCount = [healthy, unhealthy].filter((view) => view.kind !== "absent" && view.value !== "").length;
  const tls = form.read(["tls"]);
  const tlsCount = tls.kind === "map" ? Object.keys(tls.value).length : 0;

  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="health-check-endpoint"
        label="Endpoint"
        defaultValue="localhost:13133"
        description="Address the health check HTTP server listens on."
      />

      <TextField path={["path"]} id="health-check-path" label="Path" defaultValue="/" />

      <ConfigSection title="Response Body" count={responseBodyCount}>
        <TextareaField
          path={["response_body", "healthy"]}
          id="health-check-healthy-response"
          label="Healthy Response"
          description="Body returned with HTTP 200."
          placeholder='e.g. {"status": "healthy"}'
          className="font-mono text-sm"
          rows={4}
        />

        <TextareaField
          path={["response_body", "unhealthy"]}
          id="health-check-unhealthy-response"
          label="Unhealthy Response"
          description="Body returned with HTTP 503."
          placeholder='e.g. {"status": "unhealthy"}'
          className="font-mono text-sm"
          rows={4}
        />
      </ConfigSection>

      <ConfigSection title="TLS" count={tlsCount}>
        <TLSConfigSection path={["tls"]} protocolLabel="HTTP" variant="server" />

        {tls.kind === "map" && (
          <InlineAlert variant="warn" title="HTTPS required">
            Probes and monitors must call this endpoint over HTTPS and trust the certificate authority.
          </InlineAlert>
        )}
      </ConfigSection>
    </div>
  );
}
