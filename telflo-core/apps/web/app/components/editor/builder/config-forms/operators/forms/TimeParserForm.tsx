import { ConfigField } from "../../ConfigField.js";
import { BareTextField, SelectField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { useAdjustments } from "../../shared/AdjustmentAlert.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { LAYOUT_TYPE_OPTIONS, useLayoutControl } from "../shared/TimestampConfigSection.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";

/*
 * The `time_parser` operator's form, with the strptime cheat-sheet, over
 * the card's scope. Ids are the card's (`op-<index>-time-…`); the custom
 * layout's input gets `…-time-layout-custom`. The Layout label still points
 * at `…-time-layout`, which no control has (the select is
 * `…-time-layout-preset`).
 *
 * - Layout offers the layout type's presets (`LAYOUT_PRESETS`, shared with
 *   the timestamp section, all six here): the strptime ones, the first
 *   labeled with what it writes ("%Y-%m-%d %H:%M:%S", not Go's notation);
 *   Go layouts under Go time (never strptime strings there); under epoch
 *   the collector's `s` "Unix epoch (seconds)" and `s.us` "Unix epoch with
 *   fractional" (`helper/time.go:98-106`; `%s` and `%s.%f` are refused
 *   there, and `%s` is nanoseconds to strptime). Picking a preset writes
 *   `layout` only, never `layout_type` (each type offers its own).
 * - Switching Layout Type sets the new type's first preset when the layout
 *   is another type's preset, in the same change (one undo entry), with the
 *   toast "Layout set to the first <type> preset." (`useLayoutControl`,
 *   `layoutAfterSwitch`); a custom layout is typed text and is kept.
 * - Custom... is per-card state, following the card; it shows while the
 *   layout is none of the type's presets.
 *
 * An unset Layout Type shows the collector's `strptime`
 * (`helper/time.go:37-41, 62-64`) as the placeholder and "Default strptime"; a
 * type outside the three (`native`) shows as written, an extra option, and
 * Layout offers Custom... only. A layout the select can't show is read-only
 * with the unshowable-value hint. Parse From and Layout have no default: the
 * collector requires both (`time.go:75-81`). Timezone keeps its placeholder
 * with no "Default" hint (the collector's is the host's local zone, or UTC for
 * a layout ending in `Z`, `time.go:127-141`). Clearing the custom layout
 * removes `layout` (never `""`); Timezone is hidden under epoch, where the
 * collector doesn't read `location` (`time.go:114-117`), and a location in the
 * text is kept; the seven epoch layouts (`time.go:100`) all count as epoch's
 * in the switch (`EPOCH_LAYOUTS`).
 */

export function TimeParserForm() {
  const form = useForm();
  const opId = useOperatorId();
  const adjustments = useAdjustments();
  const { presets, selectValue, custom, unshowable, switchType, chooseLayout } = useLayoutControl(adjustments, true);
  const typeView = form.read(["layout_type"]);
  // The collector reads `location` for Go time and strptime only (time.go:114-117).
  const isEpoch = typeView.kind === "scalar" && typeView.value === "epoch";

  return (
    <div className="space-y-4">
      <ConfigField label="Parse From" description="Field containing the timestamp string." htmlFor={opId("time-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("time-parse-from")} />
      </ConfigField>

      <SelectField
        path={["layout_type"]}
        id={opId("time-layout-type")}
        label="Layout Type"
        description="Time format specification type."
        defaultValue="strptime"
        options={LAYOUT_TYPE_OPTIONS}
        onSelect={switchType}
      />

      <ConfigField label="Layout" description="Time format pattern." htmlFor={opId("time-layout")}>
        <Select value={selectValue} onValueChange={chooseLayout} disabled={form.disabled || unshowable}>
          <SelectTrigger id={opId("time-layout-preset")}>
            <SelectValue placeholder="Select format..." />
          </SelectTrigger>
          <SelectContent>
            {presets.map((preset) => (
              <SelectItem key={preset.value} value={preset.value}>
                {preset.label}
              </SelectItem>
            ))}
            <SelectItem value="custom">Custom...</SelectItem>
          </SelectContent>
        </Select>
        {unshowable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </ConfigField>

      {custom && (
        <BareTextField
          path={["layout"]}
          id={opId("time-layout-custom")}
          placeholder="%Y-%m-%d %H:%M:%S"
          className="font-mono text-xs"
          emptyRemoves
        />
      )}

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">strptime format:</strong>{" "}
          <span className="font-mono">%Y=year, %m=month, %d=day, %H=hour, %M=minute, %S=second, %f=microseconds, %z=timezone</span>
        </p>
      </div>

      {!isEpoch && (
        <TextField
          path={["location"]}
          id={opId("time-location")}
          label="Timezone"
          description="Default timezone (if not in timestamp)."
          placeholder="UTC, America/New_York, etc."
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}
