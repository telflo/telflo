import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, NumberField, RadioField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";

/*
 * The NetFlow receiver's form (ADR 0018), over the form's fields
 * (D9c decision 2, D9b's contract): each field writes its own key.
 *
 * - Flow Protocol is native radios (`RadioField`, D9c decision
 *   9). Unset shows NetFlow checked, the collector's default
 *   (`receiver/netflowreceiver/factory.go:29-37` at contrib v0.162.0;
 *   Preflight ruling 23). A scheme
 *   outside the two (`flow`, which Validate refuses, `config.go:49-60`) checks
 *   none and is read-only with D9b decision 3's hint (Preflight ruling 9).
 * - Changed (D9b's "a person's own config isn't lost"): a scheme change sets
 *   the port to the scheme's usual one (2055, 6343) only when
 *   the port is unset or the other scheme's; a port of the person's own is
 *   kept.
 * - Port's default is the collector's 2055 for both schemes (D9c decision 4;
 *   `factory.go:32`): "Default 2055", placeholder 2055.
 * - Queue Size below 1000 is a warning, not an error (D9c decision 4): the
 *   collector keeps a queue of 1 to 999 and replaces only 0 or less with
 *   1000 (`config.go:70-72`). The alert, for 1 to 999 only (Ruling 74), is
 *   a `warn` box, with "Below the recommended minimum of
 *   1000.", read from the text; the input takes the warn border
 *   (not a red `border-fail`). The section is open while it shows
 *   (`forceOpen`). For 0 or less, a hint says "The collector
 *   uses 1000."
 * - Copy (Ruling 72, decision 4): Flow Protocol's hint says the port changes
 *   only while it is a protocol's default; Queue Size's says 1000 or more is
 *   recommended.
 * - Unset shows the collector's default (D9b decision 3; `config.go:10-17`,
 *   `factory.go:29-37`): Hostname 0.0.0.0 (the collector's `""` binds every
 *   interface, as 0.0.0.0 does), Listening Sockets 1,
 *   Worker Threads 2, Queue Size 1000, as placeholders and "Default" hints.
 *   Clearing a field removes its key (never writing `NaN`, YAML `null`).
 *   The numbers are D9b's
 *   number fields (text inputs, a number or a reference as typed; no
 *   `min`/`max`, which aren't the collector's limits).
 * - Send Raw Messages writes `true` or `false`.
 *
 * Ids are fixed (`hostname`, `port`, …; the radios
 * `scheme-<index>`); no value reaches an attribute (decision 10).
 */

/** Below this queue size the warning shows (`config.go:15-16`, the collector's default and the README's minimum). */
const RECOMMENDED_QUEUE = 1000;

export const QUEUE_WARNING = "Below the recommended minimum of 1000.";
/** Under Queue Size while it is 0 or less: the collector replaces it (`config.go:70-72`; Ruling 74). */
export const QUEUE_REPLACED = "The collector uses 1000.";
/** Flow Protocol's hint (Ruling 72): a port of the person's own is kept on a switch. */
export const SCHEME_HINT = "Switching protocol changes the port only while it is a protocol's default.";
/** Queue Size's hint (Ruling 72): 1 to 999 is accepted, below the recommendation. */
export const QUEUE_HINT = "Buffer for incoming packets; 1000 or more is recommended.";

const SCHEMES = [
  { value: "netflow", label: "NetFlow (v5/v9/IPFIX)" },
  { value: "sflow", label: "sFlow (v5)" },
] as const;

/** Each scheme's usual port: a scheme change moves the port between them. */
const SCHEME_PORT: Readonly<Record<string, number>> = { netflow: 2055, sflow: 6343 };

export function NetflowReceiverForm() {
  const form = useForm();
  const queue = form.read(["queue_size"]);
  const queueNumber = queue.kind === "scalar" && typeof queue.value === "number" ? queue.value : null;
  // 1 to 999 is kept, below the recommendation; 0 or less the collector replaces with 1000 (config.go:70-72).
  const queueLow = queueNumber !== null && queueNumber > 0 && queueNumber < RECOMMENDED_QUEUE;
  const queueReplaced = queueNumber !== null && queueNumber <= 0;

  const switchScheme = (scheme: string) => {
    const changes: ValueChange[] = [{ path: ["scheme"], value: scheme }];
    const port = form.read(["port"]);
    const usual = Object.values(SCHEME_PORT);
    const portIsUsual = port.kind === "absent" || (port.kind === "scalar" && typeof port.value === "number" && usual.includes(port.value));
    const next = SCHEME_PORT[scheme];
    if (portIsUsual && next !== undefined && !(port.kind === "scalar" && port.value === next)) {
      changes.push({ path: ["port"], plain: String(next) });
    }
    form.apply(changes);
  };

  return (
    <div className="space-y-4">
      <RadioField
        path={["scheme"]}
        id="scheme"
        label="Flow Protocol"
        defaultValue="netflow"
        description={SCHEME_HINT}
        options={SCHEMES}
        onSelect={switchScheme}
        optionClassName="text-[13px]"
      />

      <TextField
        path={["hostname"]}
        id="hostname"
        label="Hostname"
        defaultValue="0.0.0.0"
        description="IP address to listen on; 0.0.0.0 binds all interfaces."
      />

      <NumberField path={["port"]} id="port" label="Port" defaultValue="2055" description="UDP port to listen on." />

      <ConfigSection title="Performance" forceOpen={queueLow}>
        <NumberField path={["sockets"]} id="sockets" label="Listening Sockets" defaultValue="1" />

        <NumberField
          path={["workers"]}
          id="workers"
          label="Worker Threads"
          defaultValue="2"
          description="Threads decoding flow data."
        />

        <NumberField
          path={["queue_size"]}
          id="queue_size"
          label="Queue Size"
          defaultValue="1000"
          description={QUEUE_HINT}
          {...(queueLow ? { className: "border-warn" } : {})}
        />
        {queueReplaced && <p className="text-[11px] leading-4 text-muted-foreground">{QUEUE_REPLACED}</p>}

        {queueLow && (
          <InlineAlert variant="warn" title="Queue too small">
            {QUEUE_WARNING}
          </InlineAlert>
        )}

        <InlineAlert variant="info" title="High traffic tuning">
          Raise sockets (16), workers (32), and queue size (5000); pair with a batch processor.
        </InlineAlert>
      </ConfigSection>

      <ConfigSection title="Advanced">
        <CheckboxField
          path={["send_raw"]}
          id="send_raw"
          label="Send Raw Messages"
          description="Emit unparsed flow messages, for debugging or pass-through."
          defaultChecked={false}
        />
      </ConfigSection>
    </div>
  );
}
