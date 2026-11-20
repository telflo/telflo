import { ConfigField } from "../../ConfigField.js";
import { SelectField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { useAdjustments } from "../../shared/AdjustmentAlert.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityConfigSection } from "../shared/SeverityConfigSection.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";

/*
 * The `syslog_parser` operator's form, over the card's scope. Ids are the
 * card's (`op-<index>-syslog-…`).
 *
 * - Protocol offers the collector's three: `rfc5424`, `rfc3164` and `none`
 *   (`parser/syslog/config.go:19-24, 81-85`). The collector requires it
 *   (`:82-83`), so unset shows no selection and no "Default" (never RFC
 *   5424 shown but not written). A protocol outside the three shows as
 *   written, an extra option.
 * - The Timestamp section isn't shown: with no `timestamp` block the
 *   parser reads the message's own time with its native parser
 *   (`config.go:66-74`); a section would replace it with a strptime layout
 *   over a time value, which fails. A `timestamp` block already in the
 *   text is kept, as every key the form doesn't show.
 * - Location shows for RFC 3164; the protocol is compared
 *   as the collector reads it, lower-cased (`config.go:64`). Location's
 *   unset hint is the collector's "Default UTC" (`config.go:98-100`),
 *   beside its placeholder.
 * - "Enable octet counting" shows for every protocol (not for RFC 5424 only):
 *   the collector frames RFC 3164 and none by octet count too
 *   (`parser.go:169-173, 199-209`). Ticking it removes a
 *   `non_transparent_framing_trailer` in the same change, with the toast
 *   "Removed the framing trailer: it can't be used with octet counting.": the
 *   collector refuses both (`config.go:86-87`).
 * - Switching Protocol to RFC 3164 or none removes a
 *   `non_transparent_framing_trailer` in the same change, with the toast
 *   "Removed the framing trailer: it's only used with RFC 5424.": the
 *   collector refuses the trailer with any other protocol
 *   (`config.go:88-91`).
 * - Parse From shows the collector's `body` when unset
 *   (`helper/parser.go:26`). "Enable octet counting" writes `true` or
 *   `false`; unset is off (`config.go:56`).
 */

export const REMOVED_PARSER_TRAILER = "Removed the framing trailer: it's only used with RFC 5424.";

/** Toasted once ticking "Enable octet counting" removed the trailer. */
export const REMOVED_TRAILER_FOR_OCTETS = "Removed the framing trailer: it can't be used with octet counting.";

const PROTOCOL_OPTIONS = [
  { value: "rfc5424", label: "RFC 5424 (Modern)" },
  { value: "rfc3164", label: "RFC 3164 (BSD/Legacy)" },
  { value: "none", label: "None (message kept as-is)" },
] as const;

export function SyslogParserForm() {
  const form = useForm();
  const opId = useOperatorId();
  const view = form.read(["protocol"]);
  const protocol = view.kind === "scalar" && typeof view.value === "string" ? view.value.toLowerCase() : undefined;
  const adjustments = useAdjustments();

  /** A protocol other than RFC 5424 takes no framing trailer (config.go:88-91), in the same change. */
  const switchProtocol = (next: string) => {
    const trailer = next !== "rfc5424" && form.read(["non_transparent_framing_trailer"]).kind !== "absent";
    const result = form.apply([
      { path: ["protocol"], value: next },
      ...(trailer ? [{ path: ["non_transparent_framing_trailer"], remove: true as const }] : []),
    ]);
    if (trailer) adjustments.note([REMOVED_PARSER_TRAILER], result);
  };

  const octetView = form.read(["enable_octet_counting"]);
  const octets = octetView.kind === "absent" ? false : typeof octetView.value === "boolean" ? octetView.value : null;
  const octetId = opId("syslog-octet");
  /** Octet counting takes no framing trailer (config.go:86-87), in the same change; unticking writes false. */
  const toggleOctets = (on: boolean) => {
    const trailer = on && form.read(["non_transparent_framing_trailer"]).kind !== "absent";
    const changes: ValueChange[] = [{ path: ["enable_octet_counting"], value: on }];
    if (trailer) changes.push({ path: ["non_transparent_framing_trailer"], remove: true });
    const result = form.apply(changes);
    if (trailer) adjustments.note([REMOVED_TRAILER_FOR_OCTETS], result);
  };

  return (
    <div className="space-y-4">
      <SelectField
        path={["protocol"]}
        id={opId("syslog-protocol")}
        label="Protocol"
        description="Syslog format specification."
        options={PROTOCOL_OPTIONS}
        onSelect={switchProtocol}
      />

      <ConfigField label="Parse From" description="Field containing syslog message." defaultValue="body" htmlFor={opId("syslog-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("syslog-parse-from")} defaultValue="body" />
      </ConfigField>

      {protocol === "rfc3164" && (
        <TextField
          path={["location"]}
          id={opId("syslog-location")}
          label="Location"
          description="Timezone for RFC 3164 (no TZ in format)."
          defaultValue="UTC"
          placeholder="UTC, America/New_York, etc."
          className="font-mono text-xs"
        />
      )}

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id={octetId}
            checked={octets ?? false}
            onCheckedChange={(next) => {
              if ((next === true) !== octets) toggleOctets(next === true);
            }}
            disabled={form.disabled || octets === null}
          />
          <Label htmlFor={octetId} className="text-sm">
            Enable octet counting (for TCP streams)
          </Label>
        </div>
        {octets === null && <p className="ml-6 text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </div>

      <SeverityConfigSection />
    </div>
  );
}
