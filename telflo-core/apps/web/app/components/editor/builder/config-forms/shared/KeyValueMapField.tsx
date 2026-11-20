import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "../ConfigField.js";
import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { renamedIndex, useCardKeys } from "./card-keys.js";
import { Button } from "~/components/ui/button.js";
import { Label } from "~/components/ui/label.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * A mapping of string keys to string values, edited by key, in one of two
 * markups:
 * - `"staging"` (`HeadersConfigSection`'s): the rows, then a staging row
 *   that adds a key (trimmed) on Enter or "+", with "Press Enter to add."
 *   (the headers; docker_stats' label maps, with no title);
 * - `"rows"`: filelog's attributes and resource and journald's match
 *   fields: the rows, the empty state
 *   (`emptyText`) and an Add button under them.
 * The nouns (placeholders, the add and remove labels, the clash message)
 * are the form's (`nouns`).
 *
 * The mechanics, for both: a row's key is held while typed and renamed in
 * place, where it stands and with its comment, on blur or Enter, trimmed; a
 * key another row has is refused with `nouns.exists` under the row, as text
 * (one per refused row), and the row shows its key again; an empty key isn't a
 * rename. A row's value is held as typing and written to its key (clearing it
 * writes `""`: a value is a string). Remove removes the key's lines, and the
 * mapping itself with its last key unless `emptyRemovesKey` is false
 * (journald's match keeps `{}`).
 *
 * In `"rows"` (Add never writes `"": ""`, and a key clash never collapses
 * two rows), Add shows a held row that isn't in the text. It is written
 * when its key is committed (blur or Enter, trimmed, a clash refused under
 * it) with the value it holds (`key: ""` if none), and becomes the key's
 * row in place (the same key, so focus stays). The key typed in it is a
 * held edit (a save, or the form going, writes it); a value typed while
 * the key is empty is only the row's, not a held edit, and goes with the
 * row (the form going, a configuration loaded, Remove).
 *
 * Rows are keyed by their items (`useCardKeys`), a renamed key keeping its
 * row, never by the key's text: a removed row's Remove button goes with
 * it, so a click can't land on the next row. No attribute carries a key or
 * a value.
 *
 * With `holdUntilValue` (journald's match fields: `_UID: ""` matches entries
 * whose field is empty, `config_linux.go:155-192`), the held row is written
 * only once both its key and its value are typed: a key committed while the
 * value is empty stays the row's own, and the value's typing (a held edit
 * then) writes the pair.
 *
 * journald's match rows keep their own classes: `flex gap-2` rows
 * (`rowClassName`), an icon-sized remove button (`removeSize`,
 * `removeClassName`), and an Add field button that isn't full width
 * (`addButtonClassName`).
 */

/** A row's card key (`useCardKeys`), or the held row's. */
type RowKey = number | typeof HELD;
const HELD = "held";

/** The words a map's rows use, the form's own. */
export interface KeyValueNouns {
  /** A row's key placeholder ("Header name", "key", "_SYSTEMD_UNIT"). */
  key: string;
  /** A row's value placeholder ("Header value", "value", "ssh.service"). */
  value: string;
  /** The staging row's "+" (its `aria-label`, "Add header"), or the rows' Add button ("Add Attribute"). */
  addLabel: string;
  /** Each row's remove button's `aria-label` ("Remove header", "Remove", "Remove field"). */
  removeLabel: string;
  /** Under a row whose new key another row has ("A header with this name already exists."). */
  exists: string;
  /** The staging row's placeholders ("e.g. Authorization", "e.g. Bearer token"). */
  newKey?: string;
  newValue?: string;
}

interface KeyValueMapFieldProps {
  /** The mapping's path under the form. */
  path: ValuePath;
  nouns: KeyValueNouns;
  layout: "staging" | "rows";
  /**
   * `"staging"`: the ConfigField's label (null when the parent names the
   * block). `"rows"`: the label above the rows (none when omitted).
   */
  title?: string | null;
  description?: string;
  /** `"rows"`: shown while there are no rows ("No resource attributes configured"). */
  emptyText?: string;
  /** Removing the last key removes the mapping (the default), or leaves `{}`. */
  emptyRemovesKey?: boolean;
  /** `"rows"`: each row's classes (journald's match fields: `flex gap-2`). */
  rowClassName?: string;
  /** `"rows"`: the remove buttons' size and classes (journald's: `icon`, `shrink-0`). */
  removeSize?: "sm" | "icon";
  removeClassName?: string;
  /** `"rows"`: the Add button's classes (journald's Add field: none, not full width). */
  addButtonClassName?: string;
  /** `"rows"`: the held row is written only once both its key and its value are typed. */
  holdUntilValue?: boolean;
}

export function KeyValueMapField({
  path,
  nouns,
  layout,
  title,
  description,
  emptyText,
  emptyRemovesKey = true,
  rowClassName = "grid grid-cols-[1fr_1fr_auto] gap-2",
  removeSize = "sm",
  removeClassName,
  addButtonClassName = "w-full",
  holdUntilValue = false,
}: KeyValueMapFieldProps) {
  const form = useForm();
  const view = form.read(path);
  const names = view.kind === "map" ? Object.keys(view.value) : [];
  // Rows are keyed by their keys' items, a rename keeping its row: a removed row's Remove button goes with it, so a
  // click can't land on the next row's.
  const cards = useCardKeys(names);
  const [holding, setHolding] = useState(false);
  // Kept here, not in a row: a row that goes (another removed above the held one, or the held row written) mustn't
  // take a value typed before the key, or a clash, with it.
  /** The held row's value: the row's own until its key is written, never a held edit. */
  const [heldValue, setHeldValue] = useState("");
  /** `holdUntilValue`: the held row's key, committed while its value is empty. */
  const [heldKey, setHeldKey] = useState("");
  /**
   * The rows a key was refused on, each by its row's card key (`HELD`: the held row), so a message follows its row;
   * one per row. Each holds the row's key when refused (null for the held row): the message shows while the row
   * still has that key, until its key is typed in again or the row's key changes, from here or from outside (the
   * YAML box, an undo).
   */
  const [clashes, setClashes] = useState<ReadonlyMap<RowKey, string | null>>(() => new Map());
  const without = (on: RowKey) => (current: ReadonlyMap<RowKey, string | null>) => {
    if (!current.has(on)) return current;
    const next = new Map(current);
    next.delete(on);
    return next;
  };
  const clashProps = (on: RowKey, name: string | null) => ({
    clashed: clashes.has(on) && clashes.get(on) === name,
    onClash: () => setClashes((current) => (current.has(on) && current.get(on) === name ? current : new Map(current).set(on, name))),
    onClearClash: () => setClashes(without(on)),
  });
  const dropHeld = () => {
    setHolding(false);
    setHeldValue("");
    setHeldKey("");
    setClashes(without(HELD));
  };

  const handleRemove = (name: string, index: number) => {
    // The last key takes the mapping with it.
    if (form.remove(names.length === 1 && emptyRemovesKey ? path : [...path, name]) === "written") {
      setClashes(without(cards.keys[index]!));
      cards.remove(index);
    }
  };

  const unshowable = view.kind !== "map" && view.kind !== "absent";
  const rowClasses = { rowClassName, removeSize, removeClassName };
  const rows = names.map((name, index) => (
    <MapRow
      key={cards.keys[index]}
      path={path}
      name={name}
      nouns={nouns}
      taken={(typed) => names.some((other, i) => i !== index && other === typed)}
      onRemove={() => handleRemove(name, index)}
      onRenamed={(to) => cards.move(index, renamedIndex(names, index, to))}
      {...clashProps(cards.keys[index]!, name)}
      {...rowClasses}
    />
  ));

  if (layout === "rows") {
    return (
      <div className="space-y-2">
        {title && <Label className="text-[13px] font-medium text-foreground">{title}</Label>}
        {unshowable ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <>
            {names.length === 0 && !holding && emptyText && (
              <p className="text-[11px] leading-4 text-muted-foreground">{emptyText}</p>
            )}
            {/* The held row is the rows' last, with the key its item will get: written, it is the key's row, the same input. */}
            {holding
              ? [
                  ...rows,
                  <MapRow
                    key={cards.next}
                    path={path}
                    name={null}
                    nouns={nouns}
                    taken={(typed) => names.includes(typed)}
                    onRemove={dropHeld}
                    onWritten={dropHeld}
                    {...clashProps(HELD, null)}
                    heldValue={heldValue}
                    onHeldValue={setHeldValue}
                    {...(holdUntilValue ? { held: { key: heldKey, onKey: setHeldKey } } : {})}
                    {...rowClasses}
                  />,
                ]
              : rows}
            <Button
              onClick={() => {
                // A key typed in the held row is written first; a new held row then shows.
                flushHeldEdits();
                setHolding(true);
              }}
              size="sm"
              variant="outline"
              type="button"
              className={addButtonClassName}
              disabled={form.disabled}
            >
              <Plus className="w-3 h-3 mr-1" />
              {nouns.addLabel}
            </Button>
          </>
        )}
        {description && <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>}
      </div>
    );
  }

  const body = unshowable ? (
    <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
  ) : (
    <div className="space-y-2">
      {/* Existing entries */}
      {rows}

      {/* Stage a new entry */}
      <StagingRow path={path} names={names} nouns={nouns} />
    </div>
  );

  if (title === null) {
    return (
      <div className="space-y-1.5">
        {body}
        {description && <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>}
      </div>
    );
  }

  return (
    <ConfigField label={title ?? ""} {...(description !== undefined ? { description } : {})}>
      {body}
    </ConfigField>
  );
}

/** The staging row: a key and a value, added (trimmed) on Enter or "+"; a key another row has is refused. */
function StagingRow({ path, names, nouns }: { path: ValuePath; names: readonly string[]; nouns: KeyValueNouns }) {
  const form = useForm();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [addClash, setAddClash] = useState(false);

  const handleAdd = () => {
    const key = newKey.trim();
    if (!key) return;
    if (names.includes(key)) {
      setAddClash(true);
      return;
    }
    if (form.set([...path, key], newValue.trim()) === "refused") return;
    setNewKey("");
    setNewValue("");
  };

  return (
    <>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <VaultAwareInput
          value={newKey}
          onChange={(e) => {
            setNewKey(e.target.value);
            setAddClash(false);
          }}
          placeholder={nouns.newKey}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          disabled={form.disabled}
        />
        <VaultAwareInput
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder={nouns.newValue}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          disabled={form.disabled}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={nouns.addLabel}
          onClick={handleAdd}
          disabled={!newKey.trim() || form.disabled}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {addClash && <p className="text-[11px] leading-4 text-fail">{nouns.exists}</p>}
      <p className="text-[11px] leading-4 text-muted-foreground">Press Enter to add.</p>
    </>
  );
}

/**
 * A key's row: its key renamed on blur or Enter, its value written as
 * typed. `name` null is the held row: its key, once committed, writes the
 * key with the value the row holds (`heldValue`, the field's), and the row
 * becomes that key's. With `held` (`holdUntilValue`), the held row's key
 * and value are written together, once both are typed.
 */
function MapRow({
  path,
  name,
  nouns,
  taken,
  onRemove,
  onRenamed,
  onWritten,
  clashed,
  onClash,
  onClearClash,
  heldValue = "",
  onHeldValue,
  held,
  rowClassName = "grid grid-cols-[1fr_1fr_auto] gap-2",
  removeSize = "sm",
  removeClassName,
}: {
  path: ValuePath;
  name: string | null;
  nouns: KeyValueNouns;
  /** Whether another row has this key. */
  taken: (typed: string) => boolean;
  onRemove: () => void;
  /** The row's key was renamed: its row's key follows it (an integer-like key reorders the rows). */
  onRenamed?: (to: string) => void;
  /** The held row's key was written. */
  onWritten?: () => void;
  /** A key typed in this row was refused: the message shows under it. */
  clashed: boolean;
  onClash: () => void;
  onClearClash: () => void;
  /** The held row's value, and its typing. */
  heldValue?: string;
  onHeldValue?: (value: string) => void;
  /** `holdUntilValue`: the held row's committed key, kept until its value is typed. */
  held?: { key: string; onKey: (key: string) => void };
  rowClassName?: string;
  removeSize?: "sm" | "icon";
  removeClassName?: string | undefined;
}) {
  const form = useForm();
  const valueView = name === null ? null : form.read([...path, name]);
  const shownValue =
    valueView === null || valueView.kind === "absent"
      ? ""
      : valueView.kind === "scalar" && !/[\r\n]/.test(valueView.source ?? String(valueView.value))
        ? (valueView.source ?? String(valueView.value))
        : null;

  /** The held row (`holdUntilValue`): the pair written once both are there. */
  const writeHeld = (key: string, value: string) => {
    if (form.set([...path, key], value) !== "refused") onWritten?.();
  };
  const nameText = useHeldText(
    name ?? held?.key ?? "",
    (typed) => {
      // Trimmed, as the staging row's: a key with spaces around it is that key.
      const renamed = typed.trim();
      if (held !== undefined && name === null) {
        if (renamed === held.key) return;
        if (renamed !== "" && taken(renamed)) {
          onClash();
          return;
        }
        if (renamed === "" || heldValue === "") held.onKey(renamed);
        else writeHeld(renamed, heldValue);
        return;
      }
      if (renamed === "" || renamed === name) return;
      if (taken(renamed)) {
        onClash();
        return;
      }
      if (name !== null) {
        if (form.rename([...path, name], renamed) === "written") onRenamed?.(renamed);
        return;
      }
      if (form.set([...path, renamed], heldValue) === "refused") return;
      onWritten?.();
    },
    { pause: false },
  );
  // A value is a string: clearing it writes "", not a removal. The held row's (`holdUntilValue`) is written with its key.
  const valueText = useHeldText(name === null ? heldValue : (shownValue ?? ""), (typed) => {
    if (name !== null) form.set([...path, name], typed);
    else if (held !== undefined && held.key !== "" && typed !== "") writeHeld(held.key, typed);
    else onHeldValue?.(typed);
  });
  /** The held row's value is its own (no held edit), unless it waits for a value to write its key with. */
  const ownValue = name === null && held === undefined;

  return (
    <>
      <div className={rowClassName}>
        <VaultAwareInput
          value={nameText.value}
          onChange={(e) => {
            nameText.change(e.target.value);
            onClearClash();
          }}
          onBlur={nameText.flush}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
            nameText.handleKeyDown(e);
          }}
          placeholder={nouns.key}
          disabled={form.disabled}
        />
        <VaultAwareInput
          value={ownValue ? heldValue : valueText.value}
          onChange={(e) => (ownValue ? onHeldValue?.(e.target.value) : valueText.change(e.target.value))}
          onBlur={valueText.flush}
          onKeyDown={(e) => valueText.handleKeyDown(e)}
          placeholder={nouns.value}
          disabled={form.disabled || shownValue === null}
        />
        <Button
          type="button"
          variant="ghost"
          size={removeSize}
          className={removeClassName}
          aria-label={nouns.removeLabel}
          onClick={onRemove}
          disabled={form.disabled}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {clashed && <p className="text-[11px] leading-4 text-fail">{nouns.exists}</p>}
      {shownValue === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </>
  );
}
