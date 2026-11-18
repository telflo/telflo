import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, DurationField, FormScope, SelectField, TextField } from "./form-context.js";
import { RetryConfigSection } from "./shared/RetryConfigSection.js";
import { SendingQueueSection } from "./shared/SendingQueueSection.js";

/*
 * The ClickHouse exporter's form (ADR 0018), over the form's fields
 * (D9d decision 2, D9b's contract): each field writes its own key.
 * Collector claims are contrib v0.162.0's `exporter/clickhouseexporter`.
 *
 * - Changed (decision 4): the Exponential Histogram table's default is
 *   `otel_metrics_exponential_histogram` (`config.go:109, 137`), not
 *   `otel_metrics_exp_histogram`. Database's placeholder is `default`, the
 *   default (`config.go:102, 125`; not `otel`); Data TTL's is `0`
 *   (`config.go:129`; not `72h`).
 * - New hints (decision 4; Preflight ruling 17): setting a certificate,
 *   key, CA, server name or Skip Verify loads TLS whatever the endpoint
 *   (`config.go:223-234`); Async Insert and Compression apply only when
 *   the endpoint and connection params don't set them (`config.go:182-191`);
 *   Engine Parameters are dropped while Table Engine is unset
 *   (`config.go:281-284`).
 * - Kept: the metric tables sit in a pruning scope two levels deep:
 *   clearing a kind's name removes the kind, and the last kind removes
 *   `metrics_tables`; Table Engine and its parameters in one on
 *   `table_engine`. TLS is four plain fields (`tls` is a
 *   `configtls.ClientConfig`, `config.go:44`), not D9b's TLS section, which
 *   would add controls (decision 6).
 * - Kept (decision 11): Password is a plain text field: the usual value is
 *   a `${env:…}` reference, the YAML beside it shows it, and replay masks
 *   the editor (ADR 0024).
 * - Endpoint cleared removes the key (D9b's contract; `""` is refused
 *   either way, `config.go:143-146`). The queue and retry are
 *   on by default (`configoptional.Some`, `config.go:122-123`), as D9b's.
 *
 * Ids are fixed, the metric tables' by their fixed kind (decision 13).
 */

/** Ignored when the endpoint sets compress (`config.go:187-191`). */
export const COMPRESS_HINT = "Ignored when the endpoint or connection params set compress.";
/** Ignored when the endpoint sets async_insert (`config.go:182-185`). */
export const ASYNC_INSERT_HINT = "Ignored when the endpoint or connection params set async_insert.";
/** Dropped while no engine is named (`config.go:281-284`). */
export const ENGINE_PARAMS_HINT = "Ignored unless Table Engine is set.";
/** Any of these loads TLS (`config.go:223-234`; Core `configtls.go:331-343`). */
export const TLS_HINT = "Setting a certificate, key, CA, server name or Skip Verify connects with TLS, whatever the endpoint.";

const COMPRESS_OPTIONS = ["lz4", "zstd", "gzip", "deflate", "br", "none"] as const;

/** The metric tables (`config.go:82-93`) and their defaults (`config.go:101-110, 133-138`). */
export const METRIC_TABLE_KEYS = [
  { key: "gauge", label: "Gauge", defaultName: "otel_metrics_gauge" },
  { key: "sum", label: "Sum", defaultName: "otel_metrics_sum" },
  { key: "summary", label: "Summary", defaultName: "otel_metrics_summary" },
  { key: "histogram", label: "Histogram", defaultName: "otel_metrics_histogram" },
  { key: "exponential_histogram", label: "Exponential Histogram", defaultName: "otel_metrics_exponential_histogram" },
] as const;

export function ClickhouseExporterForm() {
  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="clickhouse-endpoint"
        label="Endpoint"
        required
        description="tcp://, http://, https:// or clickhouse:// URL. Add ?secure=true for TLS on the native protocol."
        placeholder="e.g. tcp://clickhouse:9000?dial_timeout=10s"
      />

      <TextField
        path={["database"]}
        id="clickhouse-database"
        label="Database"
        defaultValue="default"
        description="Created automatically when schema creation is on."
      />

      <TextField path={["username"]} id="clickhouse-username" label="Username" placeholder="e.g. otel_writer" />

      <TextField
        path={["password"]}
        id="clickhouse-password"
        label="Password"
        description="Use a secret reference instead of hardcoding the password."
        placeholder="${env:CLICKHOUSE_PASSWORD}"
      />

      <DurationField
        path={["ttl"]}
        id="clickhouse-ttl"
        label="Data TTL"
        defaultValue="0 (disabled)"
        placeholder="0"
        description="Rows expire after this duration (e.g. 72h, 30m)."
      />

      <ConfigSection title="Schema & Tables">
        <CheckboxField
          path={["create_schema"]}
          id="clickhouse-create-schema"
          label="Create Schema on Startup"
          description="Runs CREATE DATABASE / CREATE TABLE DDL. Turn off in production and manage the schema yourself."
          defaultChecked={true}
          labelClassName="text-sm"
        />

        <TextField path={["logs_table_name"]} id="clickhouse-logs-table" label="Logs Table" defaultValue="otel_logs" />

        <TextField path={["traces_table_name"]} id="clickhouse-traces-table" label="Traces Table" defaultValue="otel_traces" />

        <FormScope path={["metrics_tables"]} prune>
          {METRIC_TABLE_KEYS.map(({ key, label, defaultName }) => (
            <FormScope key={key} path={[key]} prune>
              <TextField path={["name"]} id={`clickhouse-metrics-${key}`} label={`${label} Metrics Table`} defaultValue={defaultName} />
            </FormScope>
          ))}
        </FormScope>
      </ConfigSection>

      <ConfigSection title="Cluster & Engine">
        <TextField
          path={["cluster_name"]}
          id="clickhouse-cluster"
          label="Cluster Name"
          description="Adds ON CLUSTER to table-creation DDL."
          placeholder="e.g. my_cluster"
        />

        <FormScope path={["table_engine"]} prune>
          <TextField path={["name"]} id="clickhouse-engine" label="Table Engine" defaultValue="MergeTree" />

          <TextField
            path={["params"]}
            id="clickhouse-engine-params"
            label="Engine Parameters"
            description={`Raw parameter string passed to the engine. ${ENGINE_PARAMS_HINT}`}
            placeholder="e.g. '/clickhouse/tables/{shard}/otel', '{replica}'"
          />
        </FormScope>
      </ConfigSection>

      <ConfigSection title="Performance">
        <CheckboxField
          path={["async_insert"]}
          id="clickhouse-async-insert"
          label="Async Insert"
          description={`Lets ClickHouse buffer and batch inserts server-side. Server settings can still override this. ${ASYNC_INSERT_HINT}`}
          defaultChecked={true}
          labelClassName="text-sm"
        />

        <SelectField
          path={["compress"]}
          id="clickhouse-compress"
          label="Compression"
          defaultValue="lz4"
          description={COMPRESS_HINT}
          options={COMPRESS_OPTIONS.map((value) => ({ value, label: value }))}
        />

        <DurationField path={["timeout"]} id="clickhouse-timeout" label="Request Timeout" defaultValue="5s" />
      </ConfigSection>

      <ConfigSection title="TLS">
        <p className="text-[11px] leading-4 text-muted-foreground">{TLS_HINT}</p>

        <CheckboxField
          path={["tls", "insecure_skip_verify"]}
          id="clickhouse-tls-skip-verify"
          label="Skip TLS Verification (insecure)"
          defaultChecked={false}
          labelClassName="text-sm"
        />

        <TextField path={["tls", "ca_file"]} id="clickhouse-tls-ca" label="CA File" placeholder="e.g. /etc/ssl/certs/ca.pem" />

        <TextField
          path={["tls", "cert_file"]}
          id="clickhouse-tls-cert"
          label="Client Certificate"
          placeholder="e.g. /etc/ssl/certs/client.pem"
        />

        <TextField
          path={["tls", "key_file"]}
          id="clickhouse-tls-key"
          label="Client Key"
          placeholder="e.g. /etc/ssl/private/client-key.pem"
        />
      </ConfigSection>

      <ConfigSection title="Retry on Failure">
        <RetryConfigSection path={["retry_on_failure"]} />
      </ConfigSection>

      <ConfigSection title="Sending Queue">
        <SendingQueueSection path={["sending_queue"]} showBatchSettings={true} />
      </ConfigSection>
    </div>
  );
}
