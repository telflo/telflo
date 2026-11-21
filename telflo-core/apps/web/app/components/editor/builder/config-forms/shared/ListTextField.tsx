import { useRef } from "react";

import { ConfigField } from "../ConfigField.js";
import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { Textarea } from "~/components/ui/textarea.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import { plainNumber, type ValueChange, type ValuePath } from "~/lib/graph/text-edits.js";

/*
 * A list of strings as text: Self-monitoring's comma list, with a newline
 * variant (tail sampling's "One per line" values, OTTL's span and span
 * event values) and number items (spanmetrics' buckets, statsd's
 * percentiles).
 *
 * - `separator: ","` is a one-line field (Enter writes); `"\n"` a textarea,
 *   where Enter is a new line. Items show joined by `join` (`,` by default;
 *   spanmetrics and statsd pass `", "`) or by a line break.
 * - Typing is held (`useHeldText`). After the pause a draft is written only
 *   while it reads back as itself: not while it ends in a separator, a line
 *   break or whitespace, holds an empty item, or is spaced as the written
 *   list wouldn't show it; those would be written and the field would show
 *   the text again, dropping what is under the cursor (a typed line break
 *   would be dropped). On blur, Enter in the comma field, Cmd/Ctrl+S, a
 *   flush and when the field goes, the draft is written as it parses:
 *   split, trimmed, empty items dropped.
 * - Written by item: a changed item is set, items past the typed ones are
 *   removed by their lines (from the last), typed items past the list's are
 *   appended; an unset list is written whole. With `plainNumbers`, an item
 *   that reads as a number is written plain as typed (`100`, `1e3`), any
 *   other as a string (`2ms`). Emptied, the items are removed, leaving
 *   `[]`; with `emptyRemovesKey`, the key goes (Self-monitoring's), and
 *   with `removePathWhenEmpty`, that path goes (spanmetrics' `explicit`).
 * - An item it can't show (not a scalar; holding a separator or a line break;
 *   empty; spaces around it), or a value that isn't a list, makes it read-only
 *   with the unshowable-value hint: what it would write back would change the
 *   item.
 *
 * Ids are fixed by the form; no item reaches an attribute.
 */

export function ListTextField({
  path,
  id,
  separator,
  join = ",",
  label,
  description,
  defaultValue,
  placeholder,
  rows,
  className,
  plainNumbers = false,
  emptyRemovesKey = false,
  removePathWhenEmpty,
  inputMode,
}: {
  path: ValuePath;
  /** Fixed per field, never built from a value. */
  id: string;
  /** What separates typed items: a comma (one line) or a line break (a textarea). */
  separator: "," | "\n";
  /** What the comma field shows between items. */
  join?: string;
  label: string;
  description?: string;
  /** The collector's default, as "Default <value>". */
  defaultValue?: string;
  placeholder?: string;
  /** The textarea's rows (the newline variant). */
  rows?: number;
  className?: string;
  /** An item that reads as a number is written plain, as typed. */
  plainNumbers?: boolean;
  /** Emptied, the key is removed rather than left `[]`. */
  emptyRemovesKey?: boolean;
  /** Emptied, this path is removed (a block holding only the list). */
  removePathWhenEmpty?: ValuePath;
  inputMode?: "decimal";
}) {
  const form = useForm();
  const formRef = useRef(form);
  formRef.current = form;
  const view = form.read(path);
  const shownJoin = separator === "\n" ? "\n" : join;
  const items =
    view.kind === "absent"
      ? []
      : view.kind === "list"
        ? view.value.map((_item, index) => {
            const item = form.read([...path, index]);
            const shown = item.kind === "scalar" ? (item.source ?? String(item.value)) : null;
            return shown === null || (separator === "," ? /[,\r\n]/ : /[\r\n]/).test(shown) || shown.trim() !== shown || shown === ""
              ? null
              : shown;
          })
        : null;
  const current = items?.every((item): item is string => item !== null) ? items : null;

  /** The draft's items: split, trimmed, empty ones dropped. */
  const parse = (typed: string) =>
    typed
      .split(separator === "," ? "," : /\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

  const text = useHeldText(
    current?.join(shownJoin) ?? "",
    (typed) => {
      const latest = formRef.current;
      if (current === null) return;
      const next = parse(typed);
      if (next.length === 0) {
        if (view.kind === "absent") return;
        if (removePathWhenEmpty !== undefined) latest.remove(removePathWhenEmpty);
        else if (emptyRemovesKey) latest.remove(path);
        else latest.apply(current.map((_item, index) => ({ path: [...path, current.length - 1 - index], remove: true as const })));
        return;
      }
      const write = (at: number, item: string): ValueChange =>
        plainNumbers && plainNumber(item) !== undefined ? { path: [...path, at], plain: item } : { path: [...path, at], value: item };
      if (view.kind === "absent" && !next.some((item) => plainNumbers && plainNumber(item) !== undefined)) {
        latest.set(path, next);
        return;
      }
      const changes: ValueChange[] = [];
      next.forEach((item, index) => {
        if (item !== current[index]) changes.push(write(index, item));
      });
      for (let index = current.length - 1; index >= next.length; index--) changes.push({ path: [...path, index], remove: true });
      latest.apply(changes);
    },
    // After the pause, only a draft that reads back as itself.
    { pause: (typed) => typed !== "" && parse(typed).join(shownJoin) === typed },
  );

  const disabled = form.disabled || current === null;
  return (
    <ConfigField
      label={label}
      htmlFor={id}
      {...(description !== undefined ? { description } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
    >
      {separator === "\n" ? (
        <Textarea
          id={id}
          rows={rows}
          value={text.value}
          onChange={(e) => text.change(e.target.value)}
          onBlur={text.flush}
          onKeyDown={(e) => text.handleKeyDown(e, false)}
          placeholder={placeholder ?? defaultValue}
          disabled={disabled}
          className={className}
        />
      ) : (
        <VaultAwareInput
          id={id}
          value={text.value}
          onChange={(e) => text.change(e.target.value)}
          onBlur={text.flush}
          onKeyDown={(e) => text.handleKeyDown(e)}
          placeholder={placeholder ?? defaultValue}
          disabled={disabled}
          className={className}
          {...(inputMode !== undefined ? { inputMode } : {})}
        />
      )}
      {current === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </ConfigField>
  );
}

/**
 * Comma-separated numbers (statsd's percentiles): a `ListTextField` whose
 * items are written plain when they read as numbers (`50`, `99.9`), as
 * typed otherwise (`${env:P}`), and whose emptying removes the key.
 */
export function NumberListField(props: {
  path: ValuePath;
  id: string;
  join?: string;
  label: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
}) {
  return <ListTextField {...props} separator="," plainNumbers emptyRemovesKey inputMode="decimal" />;
}
