import { useState } from "react";

import { ConfigField } from "../../ConfigField.js";
import { BareTextField, FormScope, SelectField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { useAdjustments, type Adjustments } from "../../shared/AdjustmentAlert.js";
import { presenceOf } from "../../shared/section-toggle.js";
import {
  LAYOUT_PRESETS,
  LAYOUT_TYPES,
  layoutAfterSwitch,
  layoutSetMessage,
  type LayoutPreset,
  type LayoutType,
} from "../operator-catalog.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "./FieldSelector.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";

/*
 * The timestamp section (ADR 0018), a parser's `timestamp` block, over the
 * form (D9c decisions 2 and 7). It sits in an operator
 * card, under the card's scope; its ids are the card's (`op-<index>-…`,
 * decision 8). The Layout label still points at `…-ts-layout`, which no
 * control has (the select is `…-ts-layout-preset`).
 *
 * Kept (Parity Notes): ticking "Parse Timestamp" writes
 * `{parse_from: attributes.timestamp, layout: "%Y-%m-%d %H:%M:%S",
 * layout_type: strptime}`; unticking removes the block; Custom... shows the
 * layout's input (a per-card toggle, following the card, Preflight ruling
 * 25).
 * Fixed (decisions 3, 4 and 7; Preflight rulings 14 and 15):
 * - the Layout presets are the layout type's (`LAYOUT_PRESETS`): strptime's
 *   ones, the first labelled with what it writes ("%Y-%m-%d %H:%M:%S", not
 *   the Go notation); Go layouts under Go time (never strptime strings, which
 *   Go doesn't read); the collector's epoch layouts `s` and `s.us` under
 *   epoch (`helper/time.go:98-106`);
 * - switching Layout Type sets the new type's first preset when the layout
 *   is another type's preset (the collector refuses a strptime layout under
 *   epoch, `time.go:98-106`), in the same change (one undo entry), with the
 *   toast "Layout set to the first <type> preset." (D9d decision 7); a custom layout is typed text and is kept, as
 *   is one of the new type's own;
 * - Layout shows under epoch too, so the layout the switch set is seen
 *   (decision 7: "the other control shows its new value"), not hidden with
 *   its strptime layout left in the text.
 * Changed (D9b decision 3; Ruling 31): an unset Layout Type shows the
 * collector's `strptime` (`time.go:62-64`) as its placeholder and "Default
 * strptime"; a type outside the three (`native`) shows as an extra option,
 * and its Layout offers Custom... only. A layout the select can't show is
 * read-only with decision 3's hint.
 * As time_parser's (D9c Ruling 63, final review M1 and M2): clearing the
 * custom layout removes `layout` (D9b's rule; never `""`);
 * Timezone is hidden under epoch, where the collector doesn't read
 * `location` (`time.go:114-117`), and a location in the text is kept.
 */

/** Layout Type's options and labels (the section's and the time parser's). */
export const LAYOUT_TYPE_OPTIONS = [
  { value: "strptime", label: "strptime (Python-style)" },
  { value: "gotime", label: "Go time format" },
  { value: "epoch", label: "Epoch (Unix timestamp)" },
] as const;

function asLayoutType(value: unknown): LayoutType | undefined {
  return LAYOUT_TYPES.find((type) => type === value);
}

/** A parser's `timestamp` block, under the card's scope. */
export function TimestampConfigSection() {
  const form = useForm();
  const opId = useOperatorId();
  const adjustments = useAdjustments();
  const state = presenceOf(form.read(["timestamp"]));
  const enableId = opId("timestamp-enable");

  const toggle = (checked: boolean) => {
    if (checked) {
      form.set(["timestamp"], { parse_from: "attributes.timestamp", layout: "%Y-%m-%d %H:%M:%S", layout_type: "strptime" });
    } else {
      form.remove(["timestamp"]);
    }
  };

  const box = (
    <div className="flex items-center gap-2">
      <Checkbox
        id={enableId}
        checked={state !== "off"}
        onCheckedChange={(checked) => {
          if ((checked === true) !== (state !== "off")) toggle(checked === true);
        }}
        disabled={form.disabled || state === "unshowable"}
      />
      <Label htmlFor={enableId} className="text-sm font-medium">
        Parse Timestamp
      </Label>
    </div>
  );

  if (state === "off") {
    return (
      <div className="space-y-2 p-3 bg-muted/50 rounded-md border border-border">
        {box}
        <p className="text-xs text-muted-foreground">Extract and set log timestamp from a parsed field</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 bg-muted/50 rounded-md border border-border">
      {box}
      {state === "unshowable" ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        <FormScope path={["timestamp"]}>
          <TimestampFields adjustments={adjustments} />
        </FormScope>
      )}
    </div>
  );
}

/** What the Layout Type and Layout controls show and do, under the scope that holds `layout_type` and `layout`. */
export interface LayoutControl {
  /** The layout type's presets the Layout select offers (none for a type outside the three). */
  presets: readonly LayoutPreset[];
  /** The Layout select's value: a preset, `custom`, or "" (unset, or unshowable). */
  selectValue: string;
  /** Custom... is picked: the layout's own input shows. */
  custom: boolean;
  /** The layout is written in a form the select can't show: read-only, with decision 3's hint. */
  unshowable: boolean;
  /** Layout Type's write: decision 7's switch. */
  switchType: (next: string) => void;
  /** The Layout select's write. */
  chooseLayout: (value: string) => void;
}

/**
 * The layout controls' reading and writing (decision 7; Preflight ruling 14),
 * shared by this section (its own presets, `inSection`) and the time parser's
 * form (all of its type's presets, `all`). A switch that sets the layout
 * toasts `layoutSetMessage`. Custom... is per-card state, following the card
 * (Preflight ruling 25).
 */
export function useLayoutControl(adjustments: Adjustments, all: boolean): LayoutControl {
  const form = useForm();
  /** Custom... picked while the layout is still a preset. */
  const [customPicked, setCustomPicked] = useState(false);

  const typeView = form.read(["layout_type"]);
  const typeText = typeView.kind === "scalar" ? (typeView.source ?? String(typeView.value)) : undefined;
  // Unset is strptime (time.go:62-64); a type outside the three offers no presets.
  const layoutType = typeView.kind === "absent" ? "strptime" : asLayoutType(typeText);
  const presets: readonly LayoutPreset[] = layoutType ? LAYOUT_PRESETS[layoutType].filter((preset) => all || preset.inSection) : [];

  const layoutView = form.read(["layout"]);
  const layout = layoutView.kind === "absent" ? "" : layoutView.kind === "scalar" ? (layoutView.source ?? String(layoutView.value)) : null;
  const unshowable = layout === null || /[\r\n]/.test(layout);
  const byLayout = !unshowable && (customPicked || (layout !== "" && !presets.some((preset) => preset.value === layout)));
  // A custom layout cleared in its input keeps the input (its key removed, or `""`), so the typing goes on there.
  const [wasCustom, setWasCustom] = useState(false);
  const custom = byLayout || (wasCustom && layout === "");
  if (wasCustom !== custom) setWasCustom(custom);
  const selectValue = unshowable ? "" : custom ? "custom" : layout;

  /** decision 7: a preset of another type becomes the new type's first, in the same change, with the toast. */
  const switchType = (next: string) => {
    const to = asLayoutType(next);
    const current = layoutView.kind === "scalar" && typeof layoutView.value === "string" ? layoutView.value : undefined;
    const nextLayout = to === undefined ? undefined : layoutAfterSwitch(current, to);
    const changes: ValueChange[] = [{ path: ["layout_type"], value: next }];
    if (nextLayout !== undefined) changes.push({ path: ["layout"], value: nextLayout });
    const result = form.apply(changes);
    if (nextLayout !== undefined && to !== undefined) {
      if (result === "written") setCustomPicked(false);
      adjustments.note([layoutSetMessage(to)], result);
    }
  };

  const chooseLayout = (value: string) => {
    if (value === "custom") {
      setCustomPicked(true);
      return;
    }
    setCustomPicked(false);
    if (value !== layout) form.set(["layout"], value);
  };

  return { presets, selectValue, custom, unshowable, switchType, chooseLayout };
}

/** The block's fields, under its scope. */
function TimestampFields({ adjustments }: { adjustments: Adjustments }) {
  const form = useForm();
  const opId = useOperatorId();
  const { presets, selectValue, custom, unshowable, switchType, chooseLayout } = useLayoutControl(adjustments, false);
  const typeView = form.read(["layout_type"]);
  // The collector reads `location` for Go time and strptime only (time.go:114-117).
  const isEpoch = typeView.kind === "scalar" && typeView.value === "epoch";

  return (
    <>
      <ConfigField label="Parse From" description="Field containing the timestamp." htmlFor={opId("ts-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("ts-parse-from")} />
      </ConfigField>

      <SelectField
        path={["layout_type"]}
        id={opId("ts-layout-type")}
        label="Layout Type"
        description="Time format specification type."
        defaultValue="strptime"
        options={LAYOUT_TYPE_OPTIONS}
        onSelect={switchType}
      />

      <ConfigField label="Layout" description="Time format pattern." htmlFor={opId("ts-layout")}>
        <Select value={selectValue} onValueChange={chooseLayout} disabled={form.disabled || unshowable}>
          <SelectTrigger id={opId("ts-layout-preset")}>
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
          id={opId("ts-layout-custom")}
          placeholder="%Y-%m-%d %H:%M:%S"
          className="font-mono text-xs"
          emptyRemoves
        />
      )}

      {!isEpoch && (
        <TextField
          path={["location"]}
          id={opId("ts-location")}
          label="Timezone"
          description="Timezone for parsing (if not in timestamp)."
          placeholder="UTC, America/New_York, etc."
          className="font-mono text-xs"
        />
      )}
    </>
  );
}
