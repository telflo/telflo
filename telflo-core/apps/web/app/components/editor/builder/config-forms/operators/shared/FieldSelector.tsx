import { useRef, useState } from "react";

import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The field selector (ADR 0018), over the form: a
 * stanza field path (`attributes.level`) as a prefix select (body,
 * attributes, resource, custom…) and a suffix input. It reads the path from
 * the text at `path` and writes it there as typed (held, D9b decision 2).
 *
 * The collector reads a field as `body`, `attributes` or `resource`, then
 * its keys, dot-separated or bracketed (`entry/field.go:111-133, 152-226`);
 * any other first key is refused ("unrecognized prefix", `:130-131`), and a
 * bare `attributes` or `resource` is refused except where the field is
 * rootable (`:119-126`): a parser's `parse_to` (`helper/parser.go:35`) and
 * remove's `field` (`transformer/remove/config.go:39`). A bare `body` is a
 * field everywhere (`:128-129`).
 *
 * Fixed (D9c decisions 3 and 8; Preflight ruling 17):
 * - a `body` suffix is shown and editable (`body.message` never shows as
 *   `body`);
 * - switching to custom… keeps the whole path as written (not the suffix
 *   alone, `attributes.level` → `level`, which is refused); it is
 *   the input's mode, not a write;
 * - an empty suffix removes the key where a bare root isn't a field; with
 *   `rootable` it writes the bare `attributes` or `resource`. `body` is
 *   written bare either way;
 * - a bracketed suffix is joined without a dot (`attributes` + `["x"]` →
 *   `attributes["x"]`; a dot before the bracket, `attributes.["x"]`, reads
 *   as a nested empty key, `field.go:195-203`), and a path written so reads
 *   back as that prefix and suffix. A path the prefix and suffix wouldn't
 *   write back exactly shows as custom…, as written;
 * - a suffix with a dot outside its brackets shows the hint "Dots nest keys.
 *   For a key with dots, use brackets: attributes["log.file.path"]"
 *   (decision 8; D9c Ruling 57): `attributes.log.file.path` would be a
 *   nested path, not the flat semconv key. `["a.b"]` shows none;
 * - picking a prefix for a custom path that starts with one replaces it
 *   (`attributes.["x"]` → resource: `resource["x"]`; Ruling 57), where
 *   a plain join would double it (`resource.attributes.["x"]`); a custom
 *   path with no prefix becomes the suffix.
 * Changed (D9b decision 3): unset shows the select empty (its placeholder the
 * default's prefix, when the field has a default) and the custom input with
 * the default, or the field's example, as its placeholder (never the
 * default as the value); what is typed there is
 * the path as typed, and the input stays custom… while it is typed in.
 * The person's pick (custom…, or a prefix waiting for its suffix) holds only
 * while the key reads as it did when the pick was made, or as this selector
 * last wrote it: a change from elsewhere (an undo, the YAML box) drops it
 * (Ruling 57), so a stale prefix never comes back. A
 * value the selector can't show (a mapping, a list, a line break) is
 * read-only with decision 3's hint. The suffix and custom inputs get fixed
 * ids of their own (`<id>-suffix`, `<id>-custom`); the label still points
 * at the select.
 */

export type FieldPrefix = "body" | "attributes" | "resource";

const FIELD_PREFIXES: readonly FieldPrefix[] = ["body", "attributes", "resource"];

/** The hint under a suffix with a dot in it (decision 8). */
export const BRACKET_HINT = 'Dots nest keys. For a key with dots, use brackets: attributes["log.file.path"]';

/** Whether a suffix has a dot outside its quoted brackets: a nested path, where the bracket hint helps (Ruling 57). */
export function nestsWithDots(suffix: string): boolean {
  return suffix.replace(/\[\s*"[^"]*"\s*\]|\[\s*'[^']*'\s*\]/g, "").includes(".");
}

/**
 * What picking a prefix keeps of a custom path: a prefix it starts with is
 * dropped (`attributes.["x"]` → `["x"]`, `resource.a` → `a`), so it isn't
 * doubled (Ruling 57); a path with none is kept whole.
 */
export function suffixOfCustom(path: string): string {
  for (const prefix of FIELD_PREFIXES) {
    if (path === prefix) return "";
    if (path.startsWith(`${prefix}.`)) return path.slice(prefix.length + 1);
    if (path.startsWith(`${prefix}[`)) return path.slice(prefix.length);
  }
  return path;
}

/** A suffix joined to its prefix: a bracketed one without a dot (Preflight ruling 17). */
export function joinField(prefix: FieldPrefix, suffix: string): string {
  if (suffix === "") return prefix;
  return suffix.startsWith("[") ? `${prefix}${suffix}` : `${prefix}.${suffix}`;
}

/** A path as a prefix and suffix, when joining them writes the path back exactly; else null (custom…). */
export function splitField(path: string): { prefix: FieldPrefix; suffix: string } | null {
  for (const prefix of FIELD_PREFIXES) {
    if (path !== prefix && !path.startsWith(`${prefix}.`) && !path.startsWith(`${prefix}[`)) continue;
    const rest = path.slice(prefix.length);
    const suffix = rest.startsWith(".") ? rest.slice(1) : rest;
    return joinField(prefix, suffix) === path ? { prefix, suffix } : null;
  }
  return null;
}

export function FieldSelector({
  path,
  id,
  rootable = false,
  placeholder = "e.g., body, attributes.field",
  defaultValue,
}: {
  path: ValuePath;
  /** The select's id: fixed per card (`useOperatorId`), never a value. */
  id: string;
  /** A bare `attributes` or `resource` is a field here (`parse_to`, remove's `field`). */
  rootable?: boolean;
  /** The custom input's example. */
  placeholder?: string;
  /** The collector's default path, shown as placeholders while unset (the form's hint names it). */
  defaultValue?: string;
}) {
  const form = useForm();
  const view = form.read(path);
  const written = view.kind === "absent" ? undefined : view.kind === "scalar" ? (view.source ?? String(view.value)) : null;
  const unshowable = written === null || (written !== undefined && /[\r\n]/.test(written));
  const parts = typeof written === "string" && !unshowable ? splitField(written) : null;
  /**
   * The person's pick the text doesn't show: custom…, or a prefix waiting
   * for its suffix, with the key's value it holds for (Ruling 57).
   */
  const [pick, setPick] = useState<{ value: FieldPrefix | "custom"; at: string | undefined | null } | null>(null);
  let picked = pick?.value ?? null;
  if (pick !== null && pick.at !== written) {
    // The key changed from elsewhere: the pick is stale.
    setPick(null);
    picked = null;
  }

  const prefix: FieldPrefix | "custom" | "" = unshowable
    ? ""
    : picked === "custom"
      ? "custom"
      : written !== undefined
        ? (parts?.prefix ?? "custom")
        : (picked ?? "");
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;
  const formRef = useRef(form);
  formRef.current = form;

  /** This selector's own write: a pick holds on for the value it writes. */
  const setTo = (value: string) => {
    if (formRef.current.set(path, value) !== "refused") setPick((p) => p && { ...p, at: value });
  };
  const removeKey = (keep?: FieldPrefix) => {
    if (formRef.current.remove(path) === "refused") return;
    setPick((p) => (keep !== undefined ? { value: keep, at: undefined } : p && { ...p, at: undefined }));
  };

  /** An empty suffix: the bare root where it is a field, else no key. */
  const writeBare = (to: FieldPrefix) => {
    if (to === "body" || rootable) setTo(to);
    else removeKey(to);
  };

  const suffixText = useHeldText(parts?.suffix ?? "", (typed) => {
    const shownPrefix = prefixRef.current;
    if (shownPrefix === "custom" || shownPrefix === "") return;
    if (typed === "") writeBare(shownPrefix);
    else setTo(joinField(shownPrefix, typed));
  });
  const customText = useHeldText(unshowable ? "" : (written ?? ""), (typed) => {
    if (typed === "") removeKey();
    else setTo(typed);
  });

  const choosePrefix = (next: string) => {
    if (next === prefix) return;
    if (next === "custom") {
      setPick({ value: "custom", at: written });
      return;
    }
    const to = next as FieldPrefix;
    const suffix = parts?.suffix ?? suffixOfCustom(written ?? "");
    setPick(null);
    if (suffix === "") writeBare(to);
    else if (joinField(to, suffix) !== written) setTo(joinField(to, suffix));
  };

  const defaultPrefix = defaultValue !== undefined ? splitField(defaultValue)?.prefix : undefined;
  const disabled = form.disabled || unshowable;
  const showSuffix = prefix !== "custom" && prefix !== "";

  return (
    <>
      <div className="flex gap-2">
        <Select value={prefix} onValueChange={choosePrefix} disabled={disabled}>
          <SelectTrigger className="w-[130px]" id={id}>
            <SelectValue {...(defaultPrefix !== undefined ? { placeholder: defaultPrefix } : {})} />
          </SelectTrigger>
          <SelectContent>
            {FIELD_PREFIXES.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
            <SelectItem value="custom">custom...</SelectItem>
          </SelectContent>
        </Select>
        {showSuffix && (
          <>
            <span className="flex items-center text-muted-foreground">.</span>
            <VaultAwareInput
              id={`${id}-suffix`}
              value={suffixText.value}
              onChange={(e) => suffixText.change(e.target.value)}
              onBlur={suffixText.flush}
              onKeyDown={(e) => suffixText.handleKeyDown(e)}
              placeholder="field_name"
              disabled={disabled}
              className="flex-1 font-mono text-xs"
            />
          </>
        )}
        {!showSuffix && !unshowable && (
          <VaultAwareInput
            id={`${id}-custom`}
            value={customText.value}
            onChange={(e) => {
              // Typed while unset, it stays custom… once written.
              if (prefix === "") setPick({ value: "custom", at: written });
              customText.change(e.target.value);
            }}
            onBlur={customText.flush}
            onKeyDown={(e) => customText.handleKeyDown(e)}
            placeholder={defaultValue ?? placeholder}
            disabled={disabled}
            className="flex-1 font-mono text-xs"
          />
        )}
      </div>
      {showSuffix && nestsWithDots(suffixText.value) && <p className="text-[11px] leading-4 text-muted-foreground">{BRACKET_HINT}</p>}
      {unshowable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </>
  );
}
