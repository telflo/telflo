import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  DurationField,
  FormScope,
  NumberField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
} from "./form-context.js";
import { CORSConfigSection } from "./shared/CORSConfigSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The OTLP receiver's form, over the form's fields: each field writes its
 * own key under `protocols.grpc` or `protocols.http`.
 *
 * A protocol is on while its key is under `protocols`, whatever its value: a
 * bare `grpc:` (null) is on, the collector's default configuration. Turning a
 * protocol on writes its default endpoint as its value
 * (`{ endpoint: localhost:4317 }`, `localhost:4318`), turning it off removes
 * it, each one change. A protocol whose value is a scalar or a list shows on,
 * read-only, with `UNSHOWABLE_VALUE_MESSAGE`; a `protocols` that is a scalar
 * or a list makes both boxes read-only (unticked: no protocol is under it),
 * with the hint. While no protocol is on and one can't be shown, the sections
 * show the hint rather than "Enable at least one protocol…". The form never
 * holds the config.
 *
 * The TLS sections are the server sections; CORS is under HTTP. The
 * compression list is written by item: a box ticked appends its algorithm,
 * unticked removes its item, and the last one unticked removes the list
 * (with an empty list confighttp decompresses nothing). 0 can be entered.
 *
 * The collector's defaults, checked at core v0.162.0, show while a key is
 * unset: endpoints `localhost:4317` and `localhost:4318`
 * (`otlpreceiver.createDefaultConfig`); transport tcp
 * (`configgrpc.NewDefaultServerConfig`); max receive message 4 MiB
 * (configgrpc leaves 0 to grpc-go's 4 MiB); max request body 20971520
 * (`confighttp.defaultMaxRequestBodySize`); every encoding accepted while
 * the list is unset (`confighttp.defaultCompressionAlgorithms`); keepalive
 * 0s, 0s, 2h, 20s and 5m (configgrpc leaves them unset to grpc-go's
 * `keepalive` defaults); URL paths `/v1/traces`, `/v1/metrics`, `/v1/logs`
 * (`otlpreceiver.createDefaultConfig`).
 *
 * Not offered: a "Profiles URL Path" field for `profiles_url_path`, which
 * the receiver doesn't have at v0.162.0 (it serves profiles at
 * `/v1development/profiles`, `defaultProfilesURLPath`); the form has no
 * field for it, and a key already in the text is left alone.
 */

type Protocol = "grpc" | "http";

const DEFAULT_ENDPOINTS: Readonly<Record<Protocol, string>> = {
  grpc: "localhost:4317",
  http: "localhost:4318",
};

const TRANSPORTS = [
  { value: "tcp", label: "TCP" },
  { value: "tcp4", label: "TCP (IPv4 only)" },
  { value: "tcp6", label: "TCP (IPv6 only)" },
  { value: "udp", label: "UDP" },
  { value: "unix", label: "Unix Socket" },
] as const;

const COMPRESSION_ALGORITHMS = ["gzip", "zstd", "zlib", "snappy", "deflate", "lz4"] as const;

type ProtocolState = "on" | "off" | "unshowable";

/**
 * On while the key is under `protocols` (a bare `grpc:` included); read-only
 * when its value can't hold settings, or when `protocols` itself isn't a
 * mapping.
 */
function protocolState(protocols: ValueView, value: ValueView, protocol: Protocol): ProtocolState {
  if (protocols.kind === "absent") return "off";
  if (protocols.kind !== "map") return "unshowable";
  if (!Object.hasOwn(protocols.value, protocol)) return "off";
  return value.kind === "map" || value.kind === "absent" ? "on" : "unshowable";
}

function ProtocolCard({
  protocol,
  label,
  state,
  present,
  disabled,
  onToggle,
}: {
  protocol: Protocol;
  label: string;
  state: ProtocolState;
  /** Whether the protocol's key is under `protocols`: the box's tick. */
  present: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/50 p-2.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${protocol}-enable`}
          checked={present}
          onCheckedChange={(checked) => {
            if (state !== "unshowable" && (checked === true) !== present) onToggle(checked === true);
          }}
          disabled={disabled || state === "unshowable"}
        />
        <Label htmlFor={`${protocol}-enable`} className="text-sm font-medium">
          {label}
        </Label>
      </div>

      {state === "on" && (
        <FormScope path={["protocols", protocol]}>
          <TextField
            path={["endpoint"]}
            id={`${protocol}-endpoint`}
            label="Endpoint"
            defaultValue={DEFAULT_ENDPOINTS[protocol]}
            description="Listen address."
          />
        </FormScope>
      )}
      {state === "unshowable" && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </div>
  );
}

/** The compression boxes over `compression_algorithms`, written by item. */
function CompressionAlgorithms({ path }: { path: ValuePath }) {
  const form = useForm();
  const view = form.read(path);
  const items = view.kind === "list" ? view.value : view.kind === "absent" ? [] : null;

  return (
    <ConfigField
      label="Compression Algorithms"
      description="Leave all unchecked to accept every encoding."
      htmlFor="http-compression"
    >
      <div className="grid grid-cols-3 gap-x-2 gap-y-1.5">
        {COMPRESSION_ALGORITHMS.map((algo) => (
          <div key={algo} className="flex items-center gap-2">
            <Checkbox
              id={`compression-${algo}`}
              checked={items?.includes(algo) ?? false}
              onCheckedChange={(checked) => {
                if (items === null) return;
                const index = items.indexOf(algo);
                if (checked === true && index === -1) {
                  form.set([...path, items.length], algo);
                } else if (checked !== true && index !== -1) {
                  // The last one unticked removes the list: with an empty one, nothing is decompressed.
                  form.remove(items.length === 1 ? path : [...path, index]);
                }
              }}
              disabled={form.disabled || items === null}
            />
            <Label htmlFor={`compression-${algo}`} className="text-sm">
              {algo}
            </Label>
          </div>
        ))}
      </div>
      {items === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </ConfigField>
  );
}

export function OTLPReceiverForm() {
  const form = useForm();
  const protocols = form.read(["protocols"]);
  const grpc = protocolState(protocols, form.read(["protocols", "grpc"]), "grpc");
  const http = protocolState(protocols, form.read(["protocols", "http"]), "http");
  const grpcEnabled = grpc === "on";
  const httpEnabled = http === "on";
  const present = (protocol: Protocol) => protocols.kind === "map" && Object.hasOwn(protocols.value, protocol);
  // No protocol on: say to enable one, or, when one can't be shown, why nothing is.
  const unshowable = grpc === "unshowable" || http === "unshowable";

  const toggle = (protocol: Protocol) => (on: boolean) => {
    if (on) form.set(["protocols", protocol], { endpoint: DEFAULT_ENDPOINTS[protocol] });
    else form.remove(["protocols", protocol]);
  };

  const noProtocolNotice = (what: string) =>
    unshowable ? (
      <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
    ) : (
      <div className="text-xs italic text-muted-foreground">
        Enable at least one protocol to configure {what} settings.
      </div>
    );

  return (
    <div className="space-y-4">
      {/* gRPC Protocol */}
      <ProtocolCard
        protocol="grpc"
        label="Enable gRPC Protocol"
        state={grpc}
        present={present("grpc")}
        disabled={form.disabled}
        onToggle={toggle("grpc")}
      />

      {/* HTTP Protocol */}
      <ProtocolCard
        protocol="http"
        label="Enable HTTP Protocol"
        state={http}
        present={present("http")}
        disabled={form.disabled}
        onToggle={toggle("http")}
      />

      <ConfigSection title="Security">
        {grpcEnabled && <TLSConfigSection path={["protocols", "grpc", "tls"]} protocolLabel="gRPC" variant="server" />}

        {httpEnabled && (
          <>
            <TLSConfigSection path={["protocols", "http", "tls"]} protocolLabel="HTTP" variant="server" />

            <CORSConfigSection path={["protocols", "http", "cors"]} />
          </>
        )}

        {!grpcEnabled && !httpEnabled && noProtocolNotice("security")}
      </ConfigSection>

      <ConfigSection title="Performance">
        {grpcEnabled && (
          <FormScope path={["protocols", "grpc"]}>
            <div className="space-y-4">
              <h3 className="tf-label">gRPC</h3>

              <SelectField
                path={["transport"]}
                id="grpc-transport"
                label="Transport"
                placeholder="TCP"
                options={TRANSPORTS}
              />

              <NumberField
                path={["max_recv_msg_size_mib"]}
                id="grpc-max-msg"
                label="Max Receive Message Size"
                defaultValue="4"
                description="In MiB."
                placeholder="4"
              />

              <NumberField
                path={["max_concurrent_streams"]}
                id="grpc-max-streams"
                label="Max Concurrent Streams"
                description="Per connection."
                placeholder="e.g. 100"
              />

              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  path={["read_buffer_size"]}
                  id="grpc-read-buffer"
                  label="Read Buffer Size"
                  description="In bytes."
                  placeholder="e.g. 524288"
                />

                <NumberField
                  path={["write_buffer_size"]}
                  id="grpc-write-buffer"
                  label="Write Buffer Size"
                  description="In bytes."
                  placeholder="e.g. 524288"
                />
              </div>
            </div>
          </FormScope>
        )}

        {httpEnabled && (
          <FormScope path={["protocols", "http"]}>
            <div className={grpcEnabled ? "space-y-4 border-t border-border pt-3" : "space-y-4"}>
              <h3 className="tf-label">HTTP</h3>

              <NumberField
                path={["max_request_body_size"]}
                id="http-max-body"
                label="Max Request Body Size"
                defaultValue="20971520 (20 MiB)"
                description="In bytes."
                placeholder="20971520"
              />

              <CompressionAlgorithms path={["compression_algorithms"]} />
            </div>
          </FormScope>
        )}

        {!grpcEnabled && !httpEnabled && noProtocolNotice("performance")}
      </ConfigSection>

      <ConfigSection title="Network">
        {grpcEnabled && (
          <FormScope path={["protocols", "grpc", "keepalive"]}>
            <div className="space-y-4">
              <h3 className="tf-label">gRPC Keepalive (Server Parameters)</h3>

              <DurationField
                path={["server_parameters", "max_connection_idle"]}
                id="keepalive-idle"
                label="Max Connection Idle"
                defaultValue="0s (no limit)"
                description="Close connections idle for this long."
                placeholder="0s"
              />

              <DurationField
                path={["server_parameters", "max_connection_age"]}
                id="keepalive-age"
                label="Max Connection Age"
                defaultValue="0s (no limit)"
                placeholder="0s"
              />

              <div className="grid grid-cols-2 gap-2">
                <DurationField
                  path={["server_parameters", "time"]}
                  id="keepalive-time"
                  label="Keepalive Time"
                  defaultValue="2h"
                  description="Ping interval."
                  placeholder="2h"
                />

                <DurationField
                  path={["server_parameters", "timeout"]}
                  id="keepalive-timeout"
                  label="Keepalive Timeout"
                  defaultValue="20s"
                  description="Ping timeout."
                  placeholder="20s"
                />
              </div>

              <div className="space-y-3 border-t border-border pt-3">
                <h3 className="tf-label">gRPC Keepalive (Enforcement Policy)</h3>

                <DurationField
                  path={["enforcement_policy", "min_time"]}
                  id="keepalive-mintime"
                  label="Min Time Between Pings"
                  defaultValue="5m"
                  description="Clients pinging more often are disconnected."
                  placeholder="5m"
                />

                <CheckboxField
                  path={["enforcement_policy", "permit_without_stream"]}
                  id="keepalive-permit"
                  label="Permit keepalive pings without active streams"
                  defaultChecked={false}
                  labelClassName="text-sm"
                />
              </div>
            </div>
          </FormScope>
        )}

        {httpEnabled && (
          <FormScope path={["protocols", "http"]}>
            <div className={grpcEnabled ? "space-y-4 border-t border-border pt-3" : "space-y-4"}>
              <h3 className="tf-label">HTTP URL Paths</h3>

              <TextField path={["traces_url_path"]} id="http-traces-path" label="Traces URL Path" defaultValue="/v1/traces" />

              <TextField
                path={["metrics_url_path"]}
                id="http-metrics-path"
                label="Metrics URL Path"
                defaultValue="/v1/metrics"
              />

              <TextField path={["logs_url_path"]} id="http-logs-path" label="Logs URL Path" defaultValue="/v1/logs" />
            </div>
          </FormScope>
        )}

        {!grpcEnabled && !httpEnabled && noProtocolNotice("network")}
      </ConfigSection>
    </div>
  );
}
