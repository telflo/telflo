import { ConfigSection } from "./ConfigSection.js";
import { DurationField, SelectField, TextField, useForm } from "./form-context.js";
import { HeadersConfigSection } from "./shared/HeadersConfigSection.js";
import { RetryConfigSection } from "./shared/RetryConfigSection.js";
import { SendingQueueSection } from "./shared/SendingQueueSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { TLSInsecureCheckbox } from "./shared/TLSInsecureCheckbox.js";

/*
 * The OTLP exporter's form, over the form's fields: each field writes its own
 * key.
 *
 * The collector's defaults (otlp exporter `createDefaultConfig`, core
 * v0.162.0: timeout 5s from `exporterhelper.NewDefaultTimeoutConfig`,
 * compression gzip) show while a key is unset, not written as values. A
 * compression outside gzip/none (zstd, snappy …) shows as an extra
 * option, as written.
 *
 * Changed: the TLS section is the client variant ("Customize TLS for OTLP
 * gRPC", no Client CA fields), and the `insecure` box says what it does
 * on gRPC.
 */

const COMPRESSIONS = [
  { value: "gzip", label: "gzip" },
  { value: "none", label: "none" },
] as const;

export function OTLPExporterForm() {
  const form = useForm();
  const tls = form.read(["tls"]);

  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="otlp-endpoint"
        label="Endpoint"
        required
        description="gRPC endpoint in host:port format."
        placeholder="e.g. otelcol:4317"
      />

      <DurationField
        path={["timeout"]}
        id="otlp-timeout"
        label="Timeout"
        defaultValue="5s"
        description="Max wait per delivery attempt."
        placeholder="5s"
      />

      <SelectField
        path={["compression"]}
        id="otlp-compression"
        label="Compression"
        placeholder="gzip"
        options={COMPRESSIONS}
      />

      <ConfigSection title="Security">
        <TLSConfigSection path={["tls"]} protocolLabel="OTLP gRPC" variant="client" />

        {tls.kind === "map" && <TLSInsecureCheckbox path={["tls", "insecure"]} protocol="grpc" />}

        <div className="border-t border-border pt-4">
          <HeadersConfigSection
            path={["headers"]}
            title="gRPC Metadata Headers"
            description="Attached to every export request, e.g. API keys or tenant IDs."
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Retry & Queue">
        <RetryConfigSection path={["retry_on_failure"]} />

        <div className="border-t border-border pt-4">
          <SendingQueueSection path={["sending_queue"]} showBatchSettings={true} />
        </div>
      </ConfigSection>
    </div>
  );
}
