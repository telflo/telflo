import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { useCardKeys } from "./card-keys.js";
import { Button } from "~/components/ui/button.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * A pattern list (ADR 0018), over a list path in the form (D9d decision 12;
 * Task 10): redaction's Blocked Values.
 *
 * - Rows show each item, the pattern, as `code` (not editable), and a trash
 *   button ("Remove pattern") that removes the item by its lines; removing
 *   the last leaves `[]`. Rows are keyed by their items
 *   (`useCardKeys`; D9c Ruling 68), never by position or a value.
 * - Changed (Parity Notes, redaction): items are strings, never
 *   `{pattern, name}`: the collector takes strings only
 *   (`processor/redactionprocessor/config.go:72`, `BlockedValues []string`).
 *   The list holds strings; the name badge is `nameFor(pattern)`, display
 *   only (the form derives it from the regex library by exact pattern), so
 *   there is no "Remove name" button: no key stands behind the badge.
 * - Staging is local state (nothing is in the text until it is added), a
 *   `VaultAwareInput` (the `$` picker; D9d's controller
 *   ruling). Enter, or "+" ("Add pattern"), trims what was typed and appends
 *   it as a string, written as typed (decision 2: never escape-aware); the
 *   button is disabled while the trimmed text is empty, so `""` is never
 *   written. No duplicate check.
 * - A value that isn't a list, or an item that isn't a scalar, can't be
 *   shown: read-only with D9b's hint.
 * - Privacy (decision 13): the id is the form's, fixed; labels are fixed;
 *   a pattern and its badge are text only.
 */

export interface PatternListFieldProps {
  /** The list's path under the form. */
  path: ValuePath;
  /** Fixed by the form: the staging input's id (the field's label points at it). */
  id: string;
  placeholder?: string;
  /** The badge beside a pattern, if any: display only, never written. */
  nameFor?: (pattern: string) => string | undefined;
}

/** An item's characters (a string's value, any other scalar as written), or null when a row can't show it. */
function itemText(view: ValueView): string | null {
  if (view.kind !== "scalar") return null;
  return view.source ?? String(view.value);
}

function PatternRow({
  pattern,
  name,
  onRemove,
  disabled,
}: {
  pattern: string;
  name: string | undefined;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2.5">
      {/* Pattern */}
      <code className="flex-1 text-xs font-mono text-foreground break-all">{pattern}</code>

      {/* Name Badge (derived; no Remove name) */}
      {name && (
        <div className="flex items-center gap-1 px-1.5 py-0.5 border border-brand/25 bg-brand-soft text-brand rounded-[4px] text-xs shrink-0">
          <span className="font-medium">{name}</span>
        </div>
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Remove pattern"
        onClick={onRemove}
        disabled={disabled}
        className="shrink-0"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function PatternListField({ path, id, placeholder = "e.g. \\d{3}-\\d{2}-\\d{4}", nameFor }: PatternListFieldProps) {
  const form = useForm();
  const view = form.read(path);
  const items = view.kind === "absent" ? [] : view.kind === "list" ? view.value.map((_item, index) => itemText(form.read([...path, index]))) : null;
  const values = items?.every((item): item is string => item !== null) ? items : null;
  const cards = useCardKeys(values ?? []);
  const [inputValue, setInputValue] = useState("");

  if (values === null) {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    // Manual entry creates a simple string (no name)
    if (form.set([...path, values.length], trimmed) !== "refused") setInputValue("");
  };

  const handleRemove = (index: number) => {
    if (form.remove([...path, index]) === "written") cards.remove(index);
  };

  return (
    <div className="space-y-2">
      {/* Existing Patterns */}
      {values.length > 0 && (
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {values.map((pattern, index) => (
            <PatternRow
              key={cards.keys[index]}
              pattern={pattern}
              name={nameFor?.(pattern)}
              onRemove={() => handleRemove(index)}
              disabled={form.disabled}
            />
          ))}
        </div>
      )}

      {/* Empty State */}
      {values.length === 0 && <p className="text-[11px] leading-4 text-muted-foreground">No patterns configured</p>}

      {/* Stage a new pattern */}
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <VaultAwareInput
          id={id}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder={placeholder}
          disabled={form.disabled}
          className="font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Add pattern"
          onClick={handleAdd}
          disabled={form.disabled || !inputValue.trim()}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">Press Enter to add.</p>
    </div>
  );
}
