import { ConfigSection } from "./ConfigSection.js";
import { DESCRIBED_BOX, FormScope, NumberField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { CORSConfigSection } from "./shared/CORSConfigSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The Jaeger receiver's form, over the form's fields: each field writes its
 * own key under `protocols.<protocol>`. Collector claims are contrib
 * v0.162.0's `receiver/jaegerreceiver`.
 *
 * - Fixed: a protocol is on while its key is under `protocols`, whatever its
 *   value. Every protocol is a `configoptional.Default` (`factory.go:46-64`),
 *   which is Some whenever its key is present, a bare `grpc:` (null) included
 *   (core `config/configoptional/optional.go:155-200`), never off. As in the
 *   OTLP receiver's form: a protocol whose value is a scalar or a list shows
 *   on, read-only, with `UNSHOWABLE_VALUE_MESSAGE`; a `protocols` that isn't a
 *   mapping makes every box read-only. (`grpc: {enabled: false}` under the
 *   `configoptional.AddEnabledField` gate is off to the collector and shows on
 *   here; the gate is off by default.)
 * - Kept: ticking a protocol writes the seed `{endpoint: 0.0.0.0:<port>}` (a
 *   listener on every interface, as a container needs); unticking removes it.
 *   Each is one change.
 * - Changed: the collector's defaults show as placeholders and
 *   "Default …" hints: `localhost:14250`, `localhost:14268`,
 *   `localhost:6832` (thrift_binary) and `localhost:6831` (thrift_compact)
 *   (`factory.go:23-28`), not `0.0.0.0`.
 * - Changed: the UDP tuning fields are number fields, so 0 can be entered and
 *   shows (`socket_buffer_size: 0` is the default, `config.go:20-25, 70-77`);
 *   cleared removes the key.
 * - Each card's box sits beside its label and description in a row, moved
 *   down to centre on the label's first line.
 * - The Security section keys off the on-state: with neither gRPC nor Thrift
 *   HTTP on, an info alert; when one of them can't be shown,
 *   `UNSHOWABLE_VALUE_MESSAGE` instead.
 *
 * Unticking the last protocol leaves `protocols: {}`, which the collector
 * refuses (`config.go:92-97`): the person's own removal (the config validation
 * reports it), as in the OTLP receiver's form. Ids are fixed; no value reaches
 * an attribute.
 */

type Protocol = "grpc" | "thrift_http" | "thrift_binary" | "thrift_compact";

/** The seeds: what ticking a protocol writes. */
export const JAEGER_SEEDS: Readonly<Record<Protocol, string>> = {
  grpc: "0.0.0.0:14250",
  thrift_http: "0.0.0.0:14268",
  thrift_binary: "0.0.0.0:6832",
  thrift_compact: "0.0.0.0:6831",
};

/** The collector's defaults (`factory.go:23-28`). */
const DEFAULT_ENDPOINTS: Readonly<Record<Protocol, string>> = {
  grpc: "localhost:14250",
  thrift_http: "localhost:14268",
  thrift_binary: "localhost:6832",
  thrift_compact: "localhost:6831",
};

const CARDS: readonly { protocol: Protocol; idPart: string; label: string; description: string; udp: boolean }[] = [
  { protocol: "grpc", idPart: "grpc", label: "gRPC", description: "TCP. Recommended for collector-to-collector traffic.", udp: false },
  {
    protocol: "thrift_http",
    idPart: "thrift-http",
    label: "Thrift HTTP",
    description: "TCP. For older Jaeger clients sending Thrift over HTTP.",
    udp: false,
  },
  {
    protocol: "thrift_binary",
    idPart: "thrift-binary",
    label: "Thrift Binary",
    description: "UDP. Lower overhead, no delivery guarantees.",
    udp: true,
  },
  {
    protocol: "thrift_compact",
    idPart: "thrift-compact",
    label: "Thrift Compact",
    description: "UDP. Most common for Jaeger agent traffic.",
    udp: true,
  },
];

type ProtocolState = "on" | "off" | "unshowable";

/** On while the key is under `protocols` (null included); read-only when its value can't hold settings, or `protocols` isn't a mapping. */
function protocolState(protocols: ValueView, value: ValueView, protocol: Protocol): ProtocolState {
  if (protocols.kind === "absent") return "off";
  if (protocols.kind !== "map") return "unshowable";
  if (!Object.hasOwn(protocols.value, protocol)) return "off";
  return value.kind === "map" || value.kind === "absent" ? "on" : "unshowable";
}

/** The UDP tuning fields, under the protocol's block. */
function UdpTuningSection({ idPrefix }: { idPrefix: string }) {
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <h3 className="tf-label">UDP Tuning</h3>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          path={["queue_size"]}
          id={`${idPrefix}-queue-size`}
          label="Queue Size"
          defaultValue="1000"
          description="Max pending requests."
        />

        <NumberField
          path={["max_packet_size"]}
          id={`${idPrefix}-max-packet`}
          label="Max Packet Size"
          defaultValue="65000"
          description="In bytes."
        />

        <NumberField path={["workers"]} id={`${idPrefix}-workers`} label="Workers" defaultValue="10" description="Queue consumers." />

        <NumberField
          path={["socket_buffer_size"]}
          id={`${idPrefix}-buffer`}
          label="Socket Buffer Size"
          defaultValue="0 (OS default)"
          description="In bytes."
          placeholder="0"
        />
      </div>
    </div>
  );
}

function ProtocolCard({ card, state, present }: { card: (typeof CARDS)[number]; state: ProtocolState; present: boolean }) {
  const form = useForm();
  const boxId = `protocol-${card.idPart}`;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/50 p-2.5">
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={boxId}
          className={DESCRIBED_BOX}
          checked={present}
          onCheckedChange={(checked) => {
            if (state === "unshowable" || (checked === true) === present) return;
            if (checked === true) form.set(["protocols", card.protocol], { endpoint: JAEGER_SEEDS[card.protocol] });
            else form.remove(["protocols", card.protocol]);
          }}
          disabled={form.disabled || state === "unshowable"}
        />
        <div className="grid flex-1 gap-1 leading-none">
          <Label htmlFor={boxId} className="cursor-pointer text-sm font-medium">
            {card.label}
          </Label>
          <p className="text-xs text-muted-foreground">{card.description}</p>
        </div>
      </div>

      {state === "on" && (
        <FormScope path={["protocols", card.protocol]}>
          <TextField
            path={["endpoint"]}
            id={`${card.idPart}-endpoint`}
            label="Endpoint"
            defaultValue={DEFAULT_ENDPOINTS[card.protocol]}
            description="Listen address."
          />
          {card.udp && <UdpTuningSection idPrefix={card.idPart} />}
        </FormScope>
      )}
      {state === "unshowable" && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </div>
  );
}

export function JaegerReceiverForm() {
  const form = useForm();
  const protocols = form.read(["protocols"]);
  const stateOf = (protocol: Protocol) => protocolState(protocols, form.read(["protocols", protocol]), protocol);
  const present = (protocol: Protocol) => protocols.kind === "map" && Object.hasOwn(protocols.value, protocol);
  const grpc = stateOf("grpc");
  const thriftHttp = stateOf("thrift_http");

  return (
    <div className="space-y-4">
      {CARDS.map((card) => (
        <ProtocolCard key={card.protocol} card={card} state={stateOf(card.protocol)} present={present(card.protocol)} />
      ))}

      <ConfigSection title="Security">
        {grpc !== "on" &&
          thriftHttp !== "on" &&
          (grpc === "unshowable" || thriftHttp === "unshowable" ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
          ) : (
            <InlineAlert variant="info" title="No TCP protocols enabled">
              TLS and CORS apply only to gRPC and Thrift HTTP. Enable one above to configure them.
            </InlineAlert>
          ))}

        {grpc === "on" && <TLSConfigSection path={["protocols", "grpc", "tls"]} protocolLabel="gRPC" variant="server" />}

        {thriftHttp === "on" && (
          <>
            <TLSConfigSection path={["protocols", "thrift_http", "tls"]} protocolLabel="Thrift HTTP" variant="server" />

            <CORSConfigSection path={["protocols", "thrift_http", "cors"]} />
          </>
        )}
      </ConfigSection>

      <ConfigSection title="Remote Sampling">
        <InlineAlert variant="warn" title="Removed from this receiver">
          Use the <span className="font-mono">jaegerremotesampling</span> extension instead.
        </InlineAlert>
      </ConfigSection>
    </div>
  );
}
