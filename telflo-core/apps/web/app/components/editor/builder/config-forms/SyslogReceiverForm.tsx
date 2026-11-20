import type { ReactNode } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  FormProvider,
  FormScope,
  formSource,
  NumberField,
  RadioField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { OperatorPipeline } from "./operators/OperatorPipeline.js";
import { REMOVED_PARSER_TRAILER, REMOVED_TRAILER_FOR_OCTETS } from "./operators/forms/SyslogParserForm.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { listLength } from "./shared/counts.js";
import { NativeSelectField } from "./shared/NativeSelectField.js";
import { StanzaRetrySection } from "./shared/StanzaRetrySection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The syslog receiver's form, over the form's fields: each field writes
 * its own key. Collector claims cite contrib v0.162.0
 * (`pkg/stanza/operator/` unless named).
 *
 * The transport:
 * - It is read from the text, never kept apart from it (a copy
 *   would go stale after a YAML edit, and could write `tcp:` beside a
 *   `udp` block): TCP while a `tcp` key is there, else UDP while a `udp` key
 *   is, else neither radio is checked and the transport's fields are shown
 *   disabled until one is picked (the collector refuses neither,
 *   `input/syslog/config.go:118`).
 *   With both, TCP shows: the collector builds TCP and ignores UDP
 *   (`config.go:64-88`; `receiver/syslogreceiver/syslog.go:70-74`).
 * - Switching renames the block in place (as the OpAMP extension's transport
 *   switch), so it keeps its keys, their order and comments: `listen_address`,
 *   `encoding`, `add_attributes`, `multiline`, the whitespace keys, and
 *   anything else. The receiver decodes strictly (`syslog.go:64-76`, core's
 *   `ErrorUnused`), so the rename drops what the other transport can't take:
 *   going to UDP, TCP's `tls`, `max_log_size`, `auth`, `max_connections` and
 *   `connection_idle_timeout` (`input/tcp/config.go:66-79` against
 *   `input/udp/config.go:69-77`); going to TCP, UDP's `async`. With no block,
 *   the pick writes the seed: TCP
 *   `{listen_address: 0.0.0.0:54526, max_log_size: 1048576}`, UDP
 *   `{listen_address: 0.0.0.0:54526}`. One change, one undo entry.
 * - Adjustments (one change, with a toast saying what changed): going to UDP
 *   also removes `enable_octet_counting` (unless `false`) and
 *   `non_transparent_framing_trailer` (`input/syslog/config.go:96-99` refuses
 *   either with UDP), with "Removed settings UDP can't take. Undo to restore
 *   them.", which also says the TCP-only keys went; they stay gone on a switch
 *   back. With both blocks, switching to UDP removes the TCP block, "Removed
 *   the TCP block: the collector uses TCP when both are set." Going to TCP
 *   drops only `async`, silently, as the OpAMP switch drops
 *   `polling_interval`.
 *
 * Fixed:
 * - Listen Address has no default (it is required, `input/tcp/config.go:103-105`,
 *   `input/udp/config.go:86-88`): marked required, with the example
 *   "e.g. 0.0.0.0:54526" as its placeholder, not a value.
 * - Protocol offers the collector's three, `none` added as "None (message kept
 *   as-is)" (`parser/syslog/config.go:19-24, 81-85`). It is required
 *   (`config.go:82-83`): unset checks none and shows no hint. Switching to RFC
 *   3164 or none removes `non_transparent_framing_trailer`
 *   (`config.go:88-91`), with the toast "Removed the framing trailer: it's
 *   only used with RFC 5424." The protocol is compared lower-cased, as the
 *   collector reads it (`config.go:64`).
 * - Enable Octet Counting shows for any protocol on TCP (the parser frames
 *   every protocol by octet count,
 *   `parser/syslog/parser.go:169-173, 199-209`). Ticking it removes the
 *   framing trailer (`config.go:86-87`), with "Removed the framing trailer: it
 *   can't be used with octet counting."
 * - Framing Trailer's None removes the key (never `''`, which
 *   `config.go:92-95` refuses).
 * - UDP's async fields show unset while there is no `async` block (the
 *   collector reads synchronously until one exists, `input/udp/config.go:62-66,
 *   112-145`), with "Off until one is set; then Default 1 / 1 / 100";
 *   with the block, "Default 1", "Default 1", "Default 100".
 * - Encoding is a native select; a value outside its list shows as
 *   written, an extra option whose `value` attribute is a fixed token,
 *   not the value. Unset shows UTF-8, the collector's default
 *   (`input/tcp/config.go:54`, `input/udp/config.go:47`). Framing Trailer
 *   likewise.
 * - The numbers are number fields (a number or a reference as typed, `1MiB`
 *   for Max Log Size, a `helper.ByteSize`; clearing removes the key, never
 *   writing `NaN`, YAML `null`). Max Log Size and Max Octets show their
 *   defaults (1 MiB, `input/tcp/config.go:36, 94-97`; 8192, the README) as
 *   placeholders and hints; Timezone shows UTC
 *   (`parser/syslog/config.go:98-100`).
 * - TLS is the shared server section under `tcp.tls` (`TLSConfigSection`); UDP
 *   shows a "TCP only" alert; a TCP block that isn't a mapping shows
 *   `UNSHOWABLE_VALUE_MESSAGE` there.
 * - Protocol matches in any case, as the collector reads it
 *   (`protocol: RFC5424` shows RFC 5424 checked; a choice writes lower
 *   case). Clearing UDP's last async key removes the `async` block, so the
 *   collector reads synchronously again and "Off until one is set" shows.
 * - On UDP, Enable Octet Counting (unless `false`) and Framing Trailer
 *   show while set, so they can be removed (unticking removes the key
 *   there; None removes the trailer): UDP refuses both
 *   (`input/syslog/config.go:96-99`).
 * - Copy: ASCII is "ASCII (read as UTF-8)", as filelog's: the collector
 *   decodes `ascii` as UTF-8
 *   (`internal/coreinternal/textutils/encoding.go:23-24`).
 * - Retry on Failure is the stanza receivers' section (`StanzaRetrySection`).
 * - The Operators section is the operator framework over `operators`, from
 *   syslog.
 *
 * Ids are fixed (`listen_address`, `encoding`, …; the radios
 * `transport-<index>`, `protocol-<index>`); no value reaches an attribute.
 */

type Transport = "tcp" | "udp";

/** Toasted once a switch to UDP removed what UDP can't take. */
export const REMOVED_FOR_UDP = "Removed settings UDP can't take. Undo to restore them.";
/** Toasted once a switch to UDP removed the TCP block both were set with. */
export const REMOVED_TCP_BLOCK = "Removed the TCP block: the collector uses TCP when both are set.";
/** Under the async fields while there is no `async` block. */
export const ASYNC_OFF_HINT = "Off until one is set; then Default 1 / 1 / 100";

/** TCP's keys UDP's block refuses (`input/tcp/config.go:66-79`, `input/udp/config.go:69-77`). */
const TCP_ONLY = ["tls", "max_log_size", "auth", "max_connections", "connection_idle_timeout"] as const;
/** UDP's keys TCP's block refuses. */
const UDP_ONLY = ["async"] as const;

/** What a transport picked with no block writes. */
const SEEDS: Readonly<Record<Transport, Record<string, unknown>>> = {
  tcp: { listen_address: "0.0.0.0:54526", max_log_size: 1048576 },
  udp: { listen_address: "0.0.0.0:54526" },
};

const TRANSPORTS: readonly { value: Transport; label: string }[] = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
];

const PROTOCOLS = [
  { value: "rfc3164", label: "RFC 3164 (BSD-syslog)" },
  { value: "rfc5424", label: "RFC 5424" },
  { value: "none", label: "None (message kept as-is)" },
] as const;

const ENCODINGS = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
  { value: "ascii", label: "ASCII (read as UTF-8)" },
  { value: "big5", label: "Big5" },
  { value: "iso-8859-1", label: "ISO-8859-1 (Latin-1)" },
] as const;

const TRAILERS = [
  { value: "", label: "None" },
  { value: "LF", label: "LF (Line Feed)" },
  { value: "NUL", label: "NUL (Null Byte)" },
] as const;

/** The syslog boxes: a `space-y-1.5` block, `cursor-pointer text-sm` labels, the hint unindented. */
const BOX = {
  className: "space-y-1.5",
  labelClassName: "cursor-pointer text-sm",
  hintClassName: "text-[11px] leading-4 text-muted-foreground",
  defaultChecked: false,
} as const;

/** The native selects. */
const ABSENT: ValueView = { kind: "absent", value: undefined };

/** The transport the text holds (TCP when both are there, as the collector), and whether both are. */
export function transportOf(root: ValueView): { transport: Transport | null; both: boolean } {
  const has = (key: Transport) => root.kind === "map" && Object.hasOwn(root.value, key);
  return { transport: has("tcp") ? "tcp" : has("udp") ? "udp" : null, both: has("tcp") && has("udp") };
}

/**
 * The changes that switch the text's transport to `next`, and the toast's
 * messages: the block renamed in place without the keys the other
 * transport refuses; with both, the TCP block removed; with neither, the
 * seed; going to UDP, the parser's framing keys removed.
 */
export function transportChanges(form: FormSource, next: Transport): { changes: ValueChange[]; messages: string[] } {
  const { transport: current, both } = transportOf(form.read([]));
  const changes: ValueChange[] = [];
  const messages: string[] = [];
  if (current === next) return { changes, messages };
  let dropped = false;
  if (current === null) {
    changes.push({ path: [next], value: SEEDS[next] });
  } else if (both) {
    changes.push({ path: [current], remove: true });
    messages.push(REMOVED_TCP_BLOCK);
  } else {
    const block = form.read([current]);
    for (const key of current === "tcp" ? TCP_ONLY : UDP_ONLY) {
      if (block.kind === "map" && Object.hasOwn(block.value, key)) {
        changes.push({ path: [current, key], remove: true });
        dropped ||= next === "udp";
      }
    }
    changes.push({ path: [current], renameTo: next });
  }
  if (next === "udp") {
    const octets = form.read(["enable_octet_counting"]);
    if (octets.kind !== "absent" && octets.value !== false) {
      changes.push({ path: ["enable_octet_counting"], remove: true });
      dropped = true;
    }
    if (form.read(["non_transparent_framing_trailer"]).kind !== "absent") {
      changes.push({ path: ["non_transparent_framing_trailer"], remove: true });
      dropped = true;
    }
  }
  if (dropped) messages.push(REMOVED_FOR_UDP);
  return { changes, messages };
}

/** The protocol as the collector reads it, lower-cased (`parser/syslog/config.go:64`). */
function protocolOf(view: ValueView): string | undefined {
  return view.kind === "scalar" && typeof view.value === "string" ? view.value.toLowerCase() : undefined;
}

export function SyslogReceiverForm() {
  const form = useForm();
  const adjustments = useAdjustments();
  const { transport } = transportOf(form.read([]));
  const block = transport === null ? ABSENT : form.read([transport]);
  const blockShowable = block.kind === "map" || block.kind === "absent";
  const protocol = protocolOf(form.read(["protocol"]));
  const octetView = form.read(["enable_octet_counting"]);
  const octets = octetView.value === true;
  // On UDP the collector refuses both framing keys (`input/syslog/config.go:96-99`): shown while set, so they can go.
  const octetsOnUdp = transport === "udp" && octetView.kind !== "absent" && octetView.value !== false;
  const trailerOnUdp = transport === "udp" && form.read(["non_transparent_framing_trailer"]).kind !== "absent";
  const asyncSet = transport === "udp" && form.read(["udp", "async"]).kind !== "absent";

  const switchTransport = (next: Transport) => {
    const { changes, messages } = transportChanges(form, next);
    if (changes.length === 0) return;
    const result = form.apply(changes);
    if (messages.length > 0) adjustments.note(messages, result);
  };

  /** A protocol other than RFC 5424 takes no framing trailer (`config.go:88-91`), in the same change. */
  const switchProtocol = (next: string) => {
    const trailer = next !== "rfc5424" && form.read(["non_transparent_framing_trailer"]).kind !== "absent";
    const changes: ValueChange[] = [{ path: ["protocol"], value: next }];
    if (trailer) changes.push({ path: ["non_transparent_framing_trailer"], remove: true });
    const result = form.apply(changes);
    if (trailer) adjustments.note([REMOVED_PARSER_TRAILER], result);
  };

  /** Octet counting takes no framing trailer (`config.go:86-87`), in the same change; unticking writes false (removes it on UDP). */
  const toggleOctets = (on: boolean) => {
    if (!on && transport === "udp") {
      form.remove(["enable_octet_counting"]);
      return;
    }
    const trailer = on && form.read(["non_transparent_framing_trailer"]).kind !== "absent";
    const changes: ValueChange[] = [{ path: ["enable_octet_counting"], value: on }];
    if (trailer) changes.push({ path: ["non_transparent_framing_trailer"], remove: true });
    const result = form.apply(changes);
    if (trailer) adjustments.note([REMOVED_TRAILER_FOR_OCTETS], result);
  };

  return (
    <div className="space-y-4">
      <ConfigField
        label="Transport Protocol"
        {...(transport !== null
          ? {
              description:
                transport === "tcp" ? "Reliable delivery; supports TLS encryption." : "Connectionless; drops messages under load.",
            }
          : {})}
      >
        <div className="flex gap-4">
          {TRANSPORTS.map((option, index) => (
            <label key={option.value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                id={`transport-${index}`}
                name="transport"
                value={option.value}
                checked={transport === option.value}
                onChange={() => switchTransport(option.value)}
                disabled={form.disabled}
                className="w-4 h-4"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </ConfigField>

      <TransportScope transport={transport} showable={blockShowable}>
        <TextField
          path={["listen_address"]}
          id="listen_address"
          label="Listen Address"
          required
          description="host:port (standard syslog port 514 requires root)."
          placeholder="e.g. 0.0.0.0:54526"
        />
      </TransportScope>

      <RadioField
        path={["protocol"]}
        id="protocol"
        label="Syslog Protocol"
        {...(protocol === "rfc3164"
          ? { description: "Legacy BSD-syslog format, most compatible." }
          : protocol === "rfc5424"
            ? { description: "Structured format with better timestamp precision." }
            : {})}
        options={PROTOCOLS}
        ignoreCase
        onSelect={switchProtocol}
      />

      {protocol === "rfc3164" && (
        <TextField
          path={["location"]}
          id="location"
          label="Timezone"
          defaultValue="UTC"
          description="IANA timezone for RFC 3164 timestamps, e.g. America/New_York."
        />
      )}

      <ConfigSection title="Operators" count={listLength(form.read(["operators"]))}>
        <OperatorPipeline path={["operators"]} source="syslog" />
      </ConfigSection>

      <ConfigSection title="TLS">
        {transport === "tcp" && blockShowable ? (
          <TLSConfigSection path={["tcp", "tls"]} protocolLabel="TCP" variant="server" />
        ) : transport === "tcp" ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <InlineAlert variant="info" title="TCP only">
            Switch to TCP to configure TLS.
          </InlineAlert>
        )}
      </ConfigSection>

      <ConfigSection title="Parsing">
        <TransportScope transport={transport} showable={blockShowable}>
          <NativeSelectField path={["encoding"]} id="encoding" label="Encoding" options={ENCODINGS} unset="utf-8" />
        </TransportScope>

        {(transport === "tcp" || octetsOnUdp) && (
          <>
            <CheckboxField
              path={["enable_octet_counting"]}
              id="enable_octet_counting"
              label="Enable Octet Counting"
              description="RFC 6587 octet-counting framing."
              onToggle={toggleOctets}
              {...BOX}
            />

            {octets && transport === "tcp" && (
              <NumberField
                path={["max_octets"]}
                id="max_octets"
                label="Max Octets"
                defaultValue="8192"
                description="Maximum message size in octets."
              />
            )}

            {!octets && protocol === "rfc5424" && transport === "tcp" && (
              <NativeSelectField
                path={["non_transparent_framing_trailer"]}
                id="framing_trailer"
                label="Framing Trailer"
                description="Delimiter marking the end of each message."
                options={TRAILERS}
                unset=""
              />
            )}
          </>
        )}
        {trailerOnUdp && (
          <NativeSelectField
            path={["non_transparent_framing_trailer"]}
            id="framing_trailer"
            label="Framing Trailer"
            description="Delimiter marking the end of each message."
            options={TRAILERS}
            unset=""
          />
        )}

        <CheckboxField
          path={["allow_skip_pri_header"]}
          id="allow_skip_pri_header"
          label="Allow Skip PRI Header"
          description="Parse messages without PRI header; requires octet counting disabled."
          disabled={octets}
          {...BOX}
          labelClassName={octets ? "text-sm text-muted-foreground" : "cursor-pointer text-sm"}
        />

        <TransportScope transport={transport} showable={blockShowable}>
          <div className="space-y-1.5">
            <CheckboxField
              path={["preserve_leading_whitespaces"]}
              id="preserve_leading_whitespaces"
              label="Preserve Leading Whitespaces"
              {...BOX}
              className=""
            />
            <CheckboxField
              path={["preserve_trailing_whitespaces"]}
              id="preserve_trailing_whitespaces"
              label="Preserve Trailing Whitespaces"
              {...BOX}
              className=""
            />
          </div>
        </TransportScope>
      </ConfigSection>

      <ConfigSection title="Advanced">
        <TransportScope transport={transport} showable={blockShowable}>
          {transport === "tcp" && (
            <NumberField
              path={["max_log_size"]}
              id="max_log_size"
              label="Max Log Size"
              defaultValue="1048576 (1 MiB)"
              description="Maximum bytes for a single log entry."
              placeholder="1048576"
            />
          )}

          <CheckboxField
            path={["one_log_per_packet"]}
            id="one_log_per_packet"
            label="One Log Per Packet"
            description="Skip tokenization when each packet contains one log."
            {...BOX}
          />

          <CheckboxField
            path={["add_attributes"]}
            id="add_attributes"
            label="Add Network Attributes"
            description="Attach net.* attributes (peer address, transport)."
            {...BOX}
          />

          {transport === "udp" && <AsyncFields set={asyncSet} />}
        </TransportScope>
      </ConfigSection>

      <ConfigSection title="Retry on Failure">
        <StanzaRetrySection path={["retry_on_failure"]} />
      </ConfigSection>
    </div>
  );
}

/**
 * UDP's async fields, under `async`. Clearing the block's last key removes
 * the block: the collector reads asynchronously while an `async` block
 * exists, whatever it holds (`input/udp/config.go:112-145`), so an emptied
 * `async: {}` would keep it on. A pruning `FormScope` removes the block
 * when its last key is cleared.
 */
function AsyncFields({ set }: { set: boolean }) {
  return (
    <>
      <FormScope path={["async"]} prune>
        <NumberField path={["readers"]} id="readers" label="Async Readers" {...(set ? { defaultValue: "1" } : {})} />
        <NumberField path={["processors"]} id="processors" label="Async Processors" {...(set ? { defaultValue: "1" } : {})} />
        <NumberField path={["max_queue_length"]} id="max_queue_length" label="Max Queue Length" {...(set ? { defaultValue: "100" } : {})} />
      </FormScope>
      {!set && <p className="text-[11px] leading-4 text-muted-foreground">{ASYNC_OFF_HINT}</p>}
    </>
  );
}

/** A source that holds nothing and takes no write: the transport's fields before a transport is picked. */
const NO_TRANSPORT: FormSource = formSource(
  () => ABSENT,
  () => "refused",
  true,
);

/**
 * The transport's fields: under its block (keyed by the transport, as OpAMP's:
 * a switch addresses another block), disabled and empty with neither, and in
 * place of them `UNSHOWABLE_VALUE_MESSAGE` when the block isn't a mapping.
 */
function TransportScope({ transport, showable, children }: { transport: Transport | null; showable: boolean; children: ReactNode }) {
  if (transport === null) return <FormProvider form={NO_TRANSPORT}>{children}</FormProvider>;
  if (!showable) return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  return (
    <FormScope key={transport} path={[transport]}>
      {children}
    </FormScope>
  );
}
