import { useRef, useState } from "react";

import { ConfigField } from "../../ConfigField.js";
import { CheckboxField, FormScope, SelectField, UNSHOWABLE_VALUE_MESSAGE, useForm, type FormSource } from "../../form-context.js";
import { presenceOf } from "../../shared/section-toggle.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "./FieldSelector.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The severity section (ADR 0018), a parser's `severity` block, over the
 * form (D9c decisions 2 and 8). It sits in an operator
 * card, under the card's scope; its ids are the card's (`op-<index>-…`,
 * decision 8: fixed ids such as `severity-enable` or `sev-parse-from` would
 * be shared by every card).
 *
 * Kept (Parity Notes): ticking "Parse Severity" writes
 * `{parse_from: attributes.level, preset: default}`; unticking removes the
 * block; "Overwrite severity text…" writes `true` or `false`; a mapping level
 * typed as `a, b` is written as a list, one value as a string, none removes
 * the level, and the last level's removal removes `mapping`.
 * Fixed (decision 8):
 * - the "Custom severity mapping" box is on while `mapping` is there, and
 *   while it was ticked or its rows typed in (never reset on a change,
 *   which would collapse it under the person's typing); it is per-card state,
 *   so it follows the card;
 * - mapping keys are read case-insensitively and written under the spelling
 *   the text has (`WARN:` stays `WARN:`; Preflight ruling 26): the collector
 *   lower-cases them itself (`helper/severity_builder.go:125-126`, through
 *   the aliases' lookup, `helper/severity.go:75-79`), so nothing is
 *   lower-cased on render;
 * - a mapping the six rows can't show — a key that isn't one of the six
 *   levels (`warning`, `info2`, `5`, the aliases, `severity_builder.go:18-86`),
 *   a level written twice in two spellings, a value that isn't a string or
 *   a list of strings (a number, a `{min, max}` range, `:167-225`), a value
 *   with a comma the rows would split — makes the rows and the box
 *   read-only, with decision 3's hint (never `[object Object]`).
 * Changed (D9b decision 3; Ruling 31): an unset Preset shows the collector's
 * default (`getBuiltinMapping`'s default, `severity_builder.go:18-107`) as
 * the placeholder and "Default default"; a preset outside the two (`otel`,
 * `aliases`, `:22`) shows as an extra option, as written. Parse From has no
 * default: the collector requires it (`:149-151`).
 */

export const SEVERITY_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

const PRESETS = [
  { value: "default", label: "Default (common patterns: info, warn, error, etc.)" },
  { value: "none", label: "None (use custom mapping only)" },
] as const;

/** What a `mapping` holds, as the six rows show it. */
export interface SeverityMapping {
  /** Unset, shown in the six rows, or written in a form they can't show. */
  state: "absent" | "shown" | "unshowable";
  /** Each level's text as a row shows it (`a, b`), "" when the level has none. */
  text: Readonly<Record<SeverityLevel, string>>;
  /** Each level's key as the text spells it, where it has one. */
  keys: Readonly<Partial<Record<SeverityLevel, string>>>;
  /** How many keys the mapping has. */
  size: number;
}

function scalarString(view: ValueView): string | null {
  return view.kind === "scalar" && typeof view.value === "string" ? view.value : null;
}

/** The `mapping` under the form's scope, as the six rows read it (Preflight ruling 26). */
export function readSeverityMapping(form: FormSource): SeverityMapping {
  const empty = { trace: "", debug: "", info: "", warn: "", error: "", fatal: "" };
  const view = form.read(["mapping"]);
  if (view.kind === "absent") return { state: "absent", text: empty, keys: {}, size: 0 };
  if (view.kind !== "map") return { state: "unshowable", text: empty, keys: {}, size: 0 };
  const text: Record<SeverityLevel, string> = { ...empty };
  const keys: Partial<Record<SeverityLevel, string>> = {};
  let showable = true;
  const names = Object.keys(view.value);
  for (const key of names) {
    const level = SEVERITY_LEVELS.find((l) => l === key.toLowerCase());
    if (level === undefined || keys[level] !== undefined) {
      showable = false;
      continue;
    }
    keys[level] = key;
    const value = form.read(["mapping", key]);
    let values: (string | null)[];
    if (value.kind === "absent") values = [];
    else if (value.kind === "list") values = value.value.map((_v, index) => scalarString(form.read(["mapping", key, index])));
    else values = [scalarString(value)];
    if (values.some((v) => v === null || v.includes(","))) showable = false;
    else text[level] = values.join(", ");
  }
  return { state: showable ? "shown" : "unshowable", text, keys, size: names.length };
}

/** The changes a level's row writes for `typed`, under the text's spelling. */
export function severityMappingChanges(mapping: SeverityMapping, level: SeverityLevel, typed: string): ValueChange[] {
  const values = typed
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const key = mapping.keys[level] ?? level;
  if (values.length === 0) {
    if (mapping.keys[level] === undefined) return [];
    // The last level gone: `mapping` goes.
    return [{ path: mapping.size === 1 ? ["mapping"] : ["mapping", key], remove: true }];
  }
  return [{ path: ["mapping", key], value: values.length === 1 ? values[0] : values }];
}

/**
 * The six level rows (shared by the section and the
 * severity parser's form): each a held text over its level; read-only while
 * the mapping can't be shown. `onWrite` tells the caller a row wrote (its
 * box stays on).
 */
export function SeverityMappingRows({ idPrefix, onWrite }: { idPrefix: string; onWrite?: () => void }) {
  const form = useForm();
  const mapping = readSeverityMapping(form);
  return (
    <>
      {SEVERITY_LEVELS.map((level) => (
        <MappingRow
          key={level}
          id={`${idPrefix}-${level}`}
          level={level}
          mapping={mapping}
          form={form}
          {...(onWrite !== undefined ? { onWrite } : {})}
        />
      ))}
      {mapping.state === "unshowable" && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </>
  );
}

function MappingRow({
  id,
  level,
  mapping,
  form,
  onWrite,
}: {
  id: string;
  level: SeverityLevel;
  mapping: SeverityMapping;
  form: FormSource;
  onWrite?: () => void;
}) {
  const latest = useRef({ mapping, form });
  latest.current = { mapping, form };
  const text = useHeldText(mapping.text[level], (typed) => {
    const changes = severityMappingChanges(latest.current.mapping, level, typed);
    if (changes.length === 0) return;
    onWrite?.();
    latest.current.form.apply(changes);
  });
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 items-center">
      <Label className="text-xs font-medium capitalize">{level}</Label>
      <VaultAwareInput
        id={id}
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder={`e.g., ${level.toUpperCase()}, ${level}`}
        disabled={form.disabled || mapping.state === "unshowable"}
        className="font-mono text-xs"
      />
    </div>
  );
}

/**
 * The "Custom severity mapping" box's state: on while `mapping` is there, or
 * while the person has it on (ticked, or a row typed in) though the mapping
 * is gone; unticking removes `mapping`.
 */
export function useCustomMapping(): { on: boolean; disabled: boolean; toggle: (on: boolean) => void; keepOn: () => void } {
  const form = useForm();
  const mapping = readSeverityMapping(form);
  const [kept, setKept] = useState(false);
  return {
    on: mapping.state !== "absent" || kept,
    disabled: form.disabled || mapping.state === "unshowable",
    toggle: (on) => {
      setKept(on);
      if (!on && mapping.state !== "absent") form.remove(["mapping"]);
    },
    keepOn: () => setKept(true),
  };
}

/** A parser's `severity` block, under the card's scope. */
export function SeverityConfigSection() {
  const form = useForm();
  const opId = useOperatorId();
  const state = presenceOf(form.read(["severity"]));
  const enableId = opId("severity-enable");

  const toggle = (checked: boolean) => {
    if (checked) form.set(["severity"], { parse_from: "attributes.level", preset: "default" });
    else form.remove(["severity"]);
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
        Parse Severity
      </Label>
    </div>
  );

  if (state === "off") {
    return (
      <div className="space-y-2 p-3 bg-muted/50 rounded-md border border-border">
        {box}
        <p className="text-xs text-muted-foreground">Extract and set log severity level from a parsed field</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 bg-muted/50 rounded-md border border-border">
      {box}
      {state === "unshowable" ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        <FormScope path={["severity"]}>
          <SeverityFields />
        </FormScope>
      )}
    </div>
  );
}

/** The block's fields, under its scope. */
function SeverityFields() {
  const opId = useOperatorId();
  const custom = useCustomMapping();
  const customId = opId("sev-custom-mapping");
  return (
    <>
      <ConfigField label="Parse From" description="Field containing the severity value." htmlFor={opId("sev-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("sev-parse-from")} />
      </ConfigField>

      <SelectField
        path={["preset"]}
        id={opId("sev-preset")}
        label="Preset"
        description="Predefined severity mappings."
        defaultValue="default"
        options={PRESETS}
      />

      <div className="flex items-center gap-2">
        <Checkbox
          id={customId}
          checked={custom.on}
          onCheckedChange={(checked) => {
            if ((checked === true) !== custom.on) custom.toggle(checked === true);
          }}
          disabled={custom.disabled}
        />
        <Label htmlFor={customId} className="text-sm">
          Custom severity mapping
        </Label>
      </div>

      {custom.on && (
        <div className="space-y-2 pl-4 border-l-2 border-border">
          <p className="text-xs text-muted-foreground">Map log values to severity levels (comma-separated for multiple)</p>
          <SeverityMappingRows idPrefix={opId("sev-mapping")} onWrite={custom.keepOn} />
        </div>
      )}

      <CheckboxField
        path={["overwrite_text"]}
        id={opId("sev-overwrite")}
        label="Overwrite severity text with standard name"
        defaultChecked={false}
        labelClassName="text-sm"
      />
    </>
  );
}
