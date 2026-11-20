import { ConfigField } from "../ConfigField.js";
import { UNSET_OPTION, UNSHOWABLE_VALUE_MESSAGE, useForm, WRITTEN_OPTION } from "../form-context.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * A native `<select>`, over the form (syslog's Encoding and Framing Trailer,
 * tail sampling's policy type, booleans and error mode). It shows the text's
 * value, a value outside the options as an extra option showing it as written,
 * and writes the chosen option at once; an option whose value is `""` removes
 * the key (syslog's Framing Trailer None). A value it can't show (a mapping, a
 * list) makes it read-only with the unshowable-value hint.
 *
 * - Unset shows `unset` (the collector's default, an option's value), or,
 *   with `unsetOption` or without `unset`, a first option (blank, or
 *   `unsetOption`'s label) whose value is the fixed `UNSET_OPTION`: choosing
 *   it removes the key (or calls `onUnset`).
 * - `onSelect` writes another option in place of setting `path` to it (tail
 *   sampling's type switch).
 * - The extra option's `value` attribute is the fixed `WRITTEN_OPTION` token,
 *   never the value; choosing it writes nothing. A text value equal to
 *   `UNSET_OPTION` is such a value.
 */

const NATIVE_SELECT = "w-full h-8 border border-border bg-background rounded-md px-2 text-sm";

export interface NativeSelectOption {
  /** Fixed by the form (a collector value): the only thing an option's `value` attribute holds besides the tokens. */
  value: string;
  label: string;
}

export function NativeSelectField({
  path,
  id,
  label,
  description,
  defaultValue,
  options,
  unset,
  unsetOption,
  onSelect,
  onUnset,
  className = NATIVE_SELECT,
}: {
  path: ValuePath;
  id: string;
  label: string;
  description?: string;
  /** The collector's default, as the hint's "Default <value>" (tail sampling's Expected Value). */
  defaultValue?: string;
  options: readonly NativeSelectOption[];
  /** The option an unset key shows (the collector's default). */
  unset?: string;
  /** A first option standing for "unset" (its label; blank by default), shown while the key is unset. */
  unsetOption?: { label: string };
  /** What choosing another option writes, in place of setting `path` to it. */
  onSelect?: (value: string) => void;
  /** What choosing the unset option writes, in place of removing the key. */
  onUnset?: () => void;
  className?: string;
}) {
  const form = useForm();
  const view = form.read(path);
  const unsetShown = unsetOption !== undefined || unset === undefined;
  const absent = view.kind === "absent";
  const written = absent ? (unsetShown ? UNSET_OPTION : unset!) : view.kind === "scalar" ? (view.source ?? String(view.value)) : null;
  const listed = options.some((option) => option.value === written);
  // Unset shows the unset option; a written value is an extra option unless it is one of the options.
  const extra = written !== null && !(absent && unsetShown) && (!listed || (!absent && written === UNSET_OPTION));
  const selected = written === null ? "" : extra ? WRITTEN_OPTION : written;
  return (
    <ConfigField
      label={label}
      htmlFor={id}
      {...(description !== undefined ? { description } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
    >
      <select
        id={id}
        value={selected}
        onChange={(e) => {
          const value = e.target.value;
          if (value === WRITTEN_OPTION || value === selected) return;
          if (value === UNSET_OPTION || value === "") {
            if (view.kind === "absent") return;
            if (value === UNSET_OPTION && onUnset) onUnset();
            else form.remove(path);
          } else if (onSelect) {
            onSelect(value);
          } else {
            form.set(path, value);
          }
        }}
        disabled={form.disabled || written === null}
        className={className}
      >
        {unsetShown && <option value={UNSET_OPTION}>{unsetOption?.label ?? ""}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {extra && <option value={WRITTEN_OPTION}>{written}</option>}
      </select>
      {written === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </ConfigField>
  );
}
