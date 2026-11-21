import { useState } from "react";

import { ConfigField } from "../../ConfigField.js";
import { SelectField, TextField, useForm, type FormSource } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { findPattern } from "~/lib/regex-library.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";

/*
 * The `regex_replace` operator's form, over the card's scope. Ids are the
 * card's (`op-<index>-regex-replace-…`). The pattern's placeholder is
 * regex-library's "ISO Date (YYYY-MM-DD)".
 *
 * The collector takes exactly one of `regex` and `regex_name`
 * (`transformer/regexreplace/config.go:66-68`), and `regex_name` only as
 * `ansi_control_sequences` (`:48-57`).
 * - Pattern Type shows Well-Known Pattern while `regex_name` is set, else
 *   Custom Regex.
 * - Choosing Custom Regex writes nothing (never `regex: ""` with
 *   `regex_name` removed, which the collector refuses). The choice is the
 *   card's own state until a regex is typed: the form's, so it follows the
 *   card when it moves, and it holds only while `regex` and `regex_name`
 *   read as they did when it was made (a change from elsewhere, an undo or
 *   the YAML box, drops it, as FieldSelector's pick does). The first regex
 *   typed is written with `regex_name` removed, in the same change
 *   (`TextField`'s `excludes`; one undo entry, no alert).
 * - Choosing Well-Known Pattern writes `regex_name: ansi_control_sequences`
 *   and removes `regex`, in one change; with `regex_name`
 *   still there (Custom chosen, nothing typed), it writes nothing.
 *
 * Field is required (`docs/operators/regex_replace.md`) and shows no
 * default (never `body` as a value it doesn't write); the Regex Pattern,
 * cleared, removes `regex` (never `""`); Replace With, cleared, removes its
 * key (the seed's `replace_with: ""` shows empty and blurring it writes
 * nothing). A `regex_name` outside the one option shows as an extra option,
 * as written.
 */

type PatternType = "custom" | "well-known";

/** The two keys as the pattern choice was made: the choice holds while they read so. */
function patternKeys(form: FormSource): string {
  const values = [form.read(["regex_name"]).value ?? null, form.read(["regex"]).value ?? null];
  return JSON.stringify(values, (_key, item: unknown) => (typeof item === "bigint" ? `${item}n` : item));
}

export function RegexReplaceForm() {
  const form = useForm();
  const opId = useOperatorId();
  const keys = patternKeys(form);
  const hasName = form.read(["regex_name"]).kind !== "absent";
  const [pick, setPick] = useState<{ value: PatternType; at: string } | null>(null);
  let picked = pick?.value ?? null;
  if (pick !== null && pick.at !== keys) {
    // A regex was typed, or the keys changed from elsewhere: the choice is the text's now.
    setPick(null);
    picked = null;
  }
  const patternType: PatternType = picked ?? (hasName ? "well-known" : "custom");

  const choosePatternType = (next: string) => {
    if (next === patternType) return;
    if (next === "custom") {
      setPick({ value: "custom", at: keys });
      return;
    }
    setPick(null);
    if (hasName) return;
    const changes: ValueChange[] = [{ path: ["regex_name"], value: "ansi_control_sequences" }];
    if (form.read(["regex"]).kind !== "absent") changes.push({ path: ["regex"], remove: true });
    form.apply(changes);
  };

  return (
    <div className="space-y-4">
      <ConfigField label="Field" description="String field to apply replacement on." required htmlFor={opId("regex-replace-field")}>
        <FieldSelector path={["field"]} id={opId("regex-replace-field")} />
      </ConfigField>

      <ConfigField label="Pattern Type" description="Use custom regex or well-known pattern." htmlFor={opId("regex-replace-pattern-type")}>
        <Select value={patternType} onValueChange={choosePatternType} disabled={form.disabled}>
          <SelectTrigger id={opId("regex-replace-pattern-type")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom">Custom Regex</SelectItem>
            <SelectItem value="well-known">Well-Known Pattern</SelectItem>
          </SelectContent>
        </Select>
      </ConfigField>

      {patternType === "well-known" ? (
        <SelectField
          path={["regex_name"]}
          id={opId("regex-replace-well-known")}
          label="Well-Known Pattern"
          description="Select a pre-defined regex pattern."
          options={[{ value: "ansi_control_sequences", label: "ANSI Control Sequences (ESC [)" }]}
        />
      ) : (
        <TextField
          path={["regex"]}
          id={opId("regex-replace-regex")}
          label="Regex Pattern"
          description="Go regex pattern (RE2 syntax)."
          placeholder={findPattern("ISO Date (YYYY-MM-DD)").pattern}
          className="font-mono text-sm"
          excludes={["regex_name"]}
        />
      )}

      <TextField
        path={["replace_with"]}
        id={opId("regex-replace-with")}
        label="Replace With"
        description="Replacement string (leave empty to remove matches)."
        placeholder="Leave empty to remove matches"
        className="font-mono text-sm"
      />

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Tip:</strong> Use capture groups with{" "}
          <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">{"${1}"}</code>,{" "}
          <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">{"${2}"}</code> syntax in the replacement string to reference
          matched groups.
        </p>
      </div>
    </div>
  );
}
