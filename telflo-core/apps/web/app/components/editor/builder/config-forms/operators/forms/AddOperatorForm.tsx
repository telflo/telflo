import { useRef } from "react";

import { ConfigField } from "../../ConfigField.js";
import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import { plainValue } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The `add` operator's form, over the card's scope. Ids are the card's
 * (`op-<index>-add-…`). Field is required (`docs/operators/add.md`), so it
 * shows no default; it isn't rootable (`transformer/add/config.go:38`, an
 * `entry.Field`).
 *
 * Value is written as typed. It is never coerced on a keystroke (`1.0` to `1`,
 * so a decimal couldn't be typed, or `007` to `7`): what is typed is written
 * verbatim, plain, when it reads alone on one line as a number, a boolean (any
 * YAML 1.2 core spelling) or a one-line flow mapping or sequence
 * (`{"k": "v"}`, `[1, "a"]`; the text edits' `plainValue`; a plain string in
 * it that the collector would read as another type is written double-quoted,
 * `["2024-01-01"]`), and as a string otherwise; `EXPR(...)` is a string, which
 * the collector compiles (`add/config.go:53-66`). The field shows what the
 * text holds as written: a plain scalar's characters (`0750`, `1.0`), a
 * string's value, a one-line flow collection's characters (`readValue`'s
 * `source`), so it stays editable; a block collection or a line break is
 * read-only with `UNSHOWABLE_VALUE_MESSAGE`. Retyping the characters shown
 * writes them (`writeSame`, as docker_stats' API Version): a string `"42"`
 * shows `42`, and typing `42` means the number; while the text holds such a
 * string (`"42"`, `"true"`, `'1.0'`), "Written as a string." shows under the
 * field. Cleared, it writes `""`, as the seed does: the collector requires a
 * value (`add.md`). The examples' "JSON object" is `{"key": "value"}`, which
 * the field writes as a mapping.
 */

/** Under a Value that is a string whose characters read as a number or a boolean. */
export const WRITTEN_AS_STRING_HINT = "Written as a string.";

/**
 * Whether the text's value is a string whose characters, typed, would be
 * written as a number or a boolean: the field shows `42` for `"42"`, and the
 * hint says it is a string. A string `yaml` reads so must have been quoted
 * (a plain `42` reads as a number).
 */
function stringLooksTyped(view: ValueView): boolean {
  if (view.kind !== "scalar" || typeof view.value !== "string") return false;
  const read = plainValue(view.value);
  return read !== undefined && (typeof read.value === "number" || typeof read.value === "boolean");
}

/** What the Value field shows for the text's value, or null when it can't show it. */
function shownValue(view: ValueView): string | null {
  if (view.kind === "absent") return "";
  const text = view.source ?? (view.kind === "scalar" ? String(view.value) : null);
  return text === null || /[\r\n]/.test(text) ? null : text;
}

function ValueField({ id }: { id: string }) {
  const form = useForm();
  const view = form.read(["value"]);
  const shown = shownValue(view);
  const formRef = useRef(form);
  formRef.current = form;
  const text = useHeldText(
    shown ?? "",
    (typed) => {
      const current = formRef.current;
      if (plainValue(typed) !== undefined) current.setPlain(["value"], typed);
      else current.set(["value"], typed);
    },
    { writeSame: true },
  );
  return (
    <ConfigField label="Value" description="Value to set (string, number, boolean, JSON, or EXPR())." htmlFor={id}>
      <VaultAwareInput
        id={id}
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder="static_value or EXPR(body.field)"
        disabled={form.disabled || shown === null}
        className="font-mono text-xs"
      />
      {shown === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      {stringLooksTyped(view) && <p className="text-[11px] leading-4 text-muted-foreground">{WRITTEN_AS_STRING_HINT}</p>}
    </ConfigField>
  );
}

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function AddOperatorForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          Add a new field with a static value or expression. Use <code className={CODE}>EXPR(...)</code> for dynamic values.
        </p>
      </div>

      <ConfigField label="Field" description="Field path to add (e.g., attributes.new_field)." htmlFor={opId("add-field")}>
        <FieldSelector path={["field"]} id={opId("add-field")} />
      </ConfigField>

      <ValueField id={opId("add-value")} />

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Examples:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            <code className={CODE}>production</code> - String value
          </li>
          <li>
            <code className={CODE}>42</code> - Number value
          </li>
          <li>
            <code className={CODE}>true</code> - Boolean value
          </li>
          <li>
            <code className={CODE}>EXPR(body.user_id)</code> - Copy from another field
          </li>
          <li>
            <code className={CODE}>{'{"key": "value"}'}</code> - JSON object
          </li>
        </ul>
      </div>
    </div>
  );
}
