import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "../ConfigField.js";
import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { Button } from "~/components/ui/button.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";

/*
 * A string list, over the form: add/remove string list used by list-shaped
 * config fields (bearer tokens, label sets, …). Existing rows are
 * read-only; Enter or "+" appends the trimmed value as an item, and Remove
 * removes the item's lines. With `emptyRemovesKey`, removing the last item
 * removes the key (the bearer form's `tokens.length ? tokens : undefined`);
 * otherwise it leaves `[]`.
 *
 * Each row's remove button says "Remove", never "Remove <value>", a token in
 * an attribute.
 *
 * For the span processor's filters, `alsoOnAppend` gives changes written
 * with an appended item, in the same write (the filter's
 * `match_type: strict` with its first item), and `onEmptied` the changes
 * removing the last item writes in place of removing it (or the key): the
 * filter side's removal while nothing else is left in it.
 */

interface StringListFieldProps {
  /** The list's path under the form. */
  path: ValuePath;
  label: string;
  description?: string;
  placeholder: string;
  /** Removing the last item removes the key. */
  emptyRemovesKey?: boolean;
  /** More changes for an append's write (after the item's). */
  alsoOnAppend?: () => ValueChange[];
  /** What removing the last item writes, in place of removing it. */
  onEmptied?: () => ValueChange[];
}

export function StringListField({
  path,
  label,
  description,
  placeholder,
  emptyRemovesKey = false,
  alsoOnAppend,
  onEmptied,
}: StringListFieldProps) {
  const form = useForm();
  const [newValue, setNewValue] = useState("");
  const view = form.read(path);
  const items = view.kind === "list" ? view.value.map((_item, index) => form.read([...path, index])) : [];
  // A row is one line: an item that isn't a scalar, or spans lines, can't be shown.
  const values = items.map((item) => {
    if (item.kind === "absent") return "";
    const shown = item.kind === "scalar" ? (item.source ?? String(item.value)) : null;
    return shown === null || /[\r\n]/.test(shown) ? null : shown;
  });
  const unshowable = (view.kind !== "list" && view.kind !== "absent") || values.some((value) => value === null);

  const commit = () => {
    if (newValue.trim()) {
      const changes: ValueChange[] = [{ path: [...path, values.length], value: newValue.trim() }, ...(alsoOnAppend?.() ?? [])];
      if (form.apply(changes) !== "refused") setNewValue("");
    }
  };

  const remove = (index: number) => {
    if (onEmptied && values.length === 1) form.apply(onEmptied());
    else if (emptyRemovesKey && values.length === 1) form.remove(path);
    else form.remove([...path, index]);
  };

  return (
    <ConfigField label={label} {...(description !== undefined ? { description } : {})}>
      {unshowable ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      ) : (
        <div className="space-y-2">
          {values.map((value, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] gap-2">
              <VaultAwareInput value={value ?? ""} readOnly />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove"
                onClick={() => remove(i)}
                disabled={form.disabled}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <VaultAwareInput
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commit();
                }
              }}
              disabled={form.disabled}
            />
            <Button type="button" variant="outline" size="sm" aria-label="Add" onClick={commit} disabled={form.disabled}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </ConfigField>
  );
}
