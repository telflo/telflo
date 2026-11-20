import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "../ConfigField.js";
import { UNSHOWABLE_VALUE_MESSAGE, useForm, type FormSource } from "../form-context.js";
import { useCardKeys } from "./card-keys.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The include/exclude section, over the form: hostmetrics' filters, a
 * mode select (No Filter, Include Only, Exclude), a Match select (Strict
 * Match, Regex Match) and the list's rows, each block
 * (`include: {devices: […], match_type: strict}`) at its own path.
 *
 * - a list with items needs a `match_type`, which the collector requires
 *   (`internal/filter/filterset/config.go:37-48` at v0.162.0): an item
 *   added to a side is written with `match_type: strict` (or the match
 *   chosen before its first item) whenever the block has none, a null one
 *   included (a text's side with items and no `match_type` gets one with
 *   the next item);
 * - include and exclude are independent: the collector builds and applies
 *   both (`receiver/hostmetricsreceiver/internal/scraper/diskscraper/
 *   disk_scraper_others.go:51-63`, `filesystemscraper/config.go:78-117`),
 *   so the other side is never deleted. Picking Include Only or Exclude
 *   never removes the other side; with both set, the include list shows
 *   with its Match select, then the exclude list with its own, each select
 *   reading and writing its own side's `match_type`. No Filter removes
 *   both blocks;
 * - the mode is read from the text (include if its list has items, else
 *   exclude, else No Filter), unless a side picked has no item yet: that
 *   side's first row is held (never `[""]`), and the mode is the form's until
 *   the side has an item, typed there or written elsewhere. While both sides
 *   show, the mode select reads the side last picked there, while it still
 *   shows;
 * - rows are held rows (`MultiValueField`'s `holdEmpty`): Add shows a row
 *   that isn't in the text, its first typing appends the item, and a row
 *   emptied and left removes its item; removing the last row removes that
 *   side's block;
 * - an unset `match_type` beside items shows blank (the collector has no
 *   default); one outside the options shows as an extra option, as
 *   written.
 * Ids are fixed (`<id>-mode`, `<id>-include-match`, `<id>-include-<index>`),
 * and each row's remove button says "Remove <item label>", a label the form
 * gives, never a value.
 */

type Side = "include" | "exclude";

const MATCH_OPTIONS = [
  { value: "strict", label: "Strict Match" },
  { value: "regexp", label: "Regex Match" },
] as const;

interface IncludeExcludeSectionProps {
  /** Fixed per section: the controls' ids start with it. */
  id: string;
  /** The ConfigField's label ("Device Filter"). */
  title: string;
  /** The include and exclude blocks' paths under the form (`["include"]`, `["include_devices"]`). */
  includePath: ValuePath;
  excludePath: ValuePath;
  /** The list's key in each block (`devices`, `fs_types`, `names`). */
  listKey: string;
  /** "Device", "Process Name": the Add button's and the remove button's words. */
  itemLabel: string;
  placeholder: string;
  showMatchType?: boolean;
}

/** A side's list as the rows show it: its items' text, or null when it can't be shown. */
function listOf(form: FormSource, block: ValuePath, listKey: string): string[] | null {
  const blockView = form.read(block);
  if (blockView.kind === "absent") return [];
  if (blockView.kind !== "map") return null;
  const view = form.read([...block, listKey]);
  if (view.kind === "absent") return [];
  if (view.kind !== "list") return null;
  const items = view.value.map((_item, index) => form.read([...block, listKey, index]));
  const shown = items.map((item) => textOf(item));
  return shown.every((item): item is string => item !== null) ? shown : null;
}

function textOf(view: ValueView): string | null {
  if (view.kind === "absent") return "";
  if (view.kind !== "scalar") return null;
  const text = view.source ?? String(view.value);
  return /[\r\n]/.test(text) ? null : text;
}

export function IncludeExcludeSection({
  id,
  title,
  includePath,
  excludePath,
  listKey,
  itemLabel,
  placeholder,
  showMatchType = true,
}: IncludeExcludeSectionProps) {
  const form = useForm();
  /** A side picked that has no item yet, and the match chosen for it: the form's, until its first item. */
  const [pending, setPending] = useState<{ side: Side; match?: string } | null>(null);
  /** The side last picked in the mode select: what it reads while that side shows. */
  const [picked, setPicked] = useState<Side | null>(null);
  const paths: Record<Side, ValuePath> = { include: includePath, exclude: excludePath };
  const lists: Record<Side, string[] | null> = {
    include: listOf(form, includePath, listKey),
    exclude: listOf(form, excludePath, listKey),
  };
  if (lists.include === null || lists.exclude === null) {
    return (
      <ConfigField label={title}>
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      </ConfigField>
    );
  }
  const has = (side: Side) => (lists[side]?.length ?? 0) > 0;
  // A side picked is the form's only until it has items, however they came (the YAML box, an undo): then the text
  // says the mode, and emptied again it doesn't come back as picked.
  if (pending !== null && has(pending.side)) setPending(null);
  const pendingSide = pending !== null && !has(pending.side) ? pending.side : null;
  const sides = (["include", "exclude"] as const).filter((side) => has(side) || pendingSide === side);
  const mode: Side | "none" =
    picked !== null && sides.includes(picked)
      ? picked
      : has("include")
        ? "include"
        : (pendingSide ?? (has("exclude") ? "exclude" : "none"));

  const handleModeChange = (next: string) => {
    if (next === "none") {
      setPending(null);
      setPicked(null);
      const present = (["include", "exclude"] as const).filter((side) => form.read(paths[side]).kind !== "absent");
      if (present.length > 0) form.apply(present.map((side) => ({ path: paths[side], remove: true as const })));
      return;
    }
    const side = next as Side;
    setPicked(side);
    // A side with items is shown already; one without gets its first row, held.
    setPending(has(side) ? null : { side });
  };

  const matchSelect = (side: Side) => {
    const view = form.read([...paths[side], "match_type"]);
    const written = textOf(view);
    const shown = pendingSide === side ? (written || pending?.match || "strict") : written;
    const extra = shown !== null && shown !== "" && !MATCH_OPTIONS.some((option) => option.value === shown);
    const options = extra ? [...MATCH_OPTIONS, { value: shown, label: shown }] : MATCH_OPTIONS;
    return (
      <Select
        value={shown ?? ""}
        onValueChange={(value) => {
          if (value === shown) return;
          if (pendingSide === side && written === "") setPending({ side, match: value });
          else form.set([...paths[side], "match_type"], value);
        }}
        disabled={form.disabled || shown === null}
      >
        <SelectTrigger id={`${id}-${side}-match`} className="w-[140px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  return (
    <ConfigField label={title}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Select value={mode} onValueChange={handleModeChange} disabled={form.disabled}>
            <SelectTrigger id={`${id}-mode`} className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No Filter</SelectItem>
              <SelectItem value="include">Include Only</SelectItem>
              <SelectItem value="exclude">Exclude</SelectItem>
            </SelectContent>
          </Select>

          {showMatchType && sides[0] !== undefined && matchSelect(sides[0])}
        </div>

        {sides.map((side, index) => (
          <div key={side} className="space-y-2">
            {index > 0 && (
              // Both sides set: the second is labeled with its mode's own words.
              <div className="flex items-center gap-2">
                <span className="w-[180px] text-sm text-muted-foreground">Exclude</span>
                {showMatchType && matchSelect(side)}
              </div>
            )}
            <FilterList
              id={`${id}-${side}`}
              path={paths[side]}
              listKey={listKey}
              items={lists[side] ?? []}
              itemLabel={itemLabel}
              placeholder={placeholder}
              startHeld={pendingSide === side}
              firstMatch={pendingSide === side ? (pending?.match ?? "strict") : "strict"}
              onFirstWritten={() => setPending(null)}
              onDropFirst={() => setPending(null)}
            />
          </div>
        ))}
      </div>
    </ConfigField>
  );
}

/**
 * One side's rows and its Add button. Rows are held rows: the held one, at the
 * list's end, is appended by its first typing; an item added is written with
 * the side's `match_type` when the block has none.
 */
function FilterList({
  id,
  path,
  listKey,
  items,
  itemLabel,
  placeholder,
  startHeld,
  firstMatch,
  onFirstWritten,
  onDropFirst,
}: {
  id: string;
  path: ValuePath;
  listKey: string;
  items: readonly string[];
  itemLabel: string;
  placeholder: string;
  /** The side has no item yet: its first row shows, held. */
  startHeld: boolean;
  /** The match an added item is written with, when the block has none. */
  firstMatch: string;
  onFirstWritten: () => void;
  /** The held first row was removed: the side goes. */
  onDropFirst: () => void;
}) {
  const form = useForm();
  /** The list's length when Add made the held row: it shows while the list still has that length. */
  const [heldAt, setHeldAt] = useState<number | null>(null);
  // A change of the list's length (its own item written, or the list edited elsewhere) drops the held row.
  const [seenLength, setSeenLength] = useState(items.length);
  if (seenLength !== items.length) {
    setSeenLength(items.length);
    setHeldAt(null);
  }
  const holding = startHeld || heldAt === items.length;
  const rows = holding ? [...items, ""] : items;
  // Rows keyed by their items: a row emptied and left removes its item as the pointer goes down on a Remove button,
  // and the click must not land on the next item's row. The held row takes the key its item gets.
  const cards = useCardKeys(items);
  const rowKeys = holding ? [...cards.keys, cards.next] : cards.keys;

  const commit = (index: number, typed: string) => {
    if (index === items.length) {
      // The held row: its first typing is the list's new last item.
      if (typed === "") return;
      const changes: ValueChange[] = [{ path: [...path, listKey, index], value: typed }];
      // Whenever the side has no match_type (a null one reads as none), not only with its first item.
      if (form.read([...path, "match_type"]).kind === "absent") {
        changes.push({ path: [...path, "match_type"], value: firstMatch });
      }
      if (form.apply(changes) === "refused") return;
      setHeldAt(null);
      if (index === 0) onFirstWritten();
      return;
    }
    if (typed === "") remove(index);
    else form.set([...path, listKey, index], typed);
  };

  const remove = (index: number) => {
    if (index === items.length) {
      setHeldAt(null);
      if (startHeld) onDropFirst();
      return;
    }
    // The last item takes its block with it.
    if (form.remove(items.length === 1 ? path : [...path, listKey, index]) === "written") cards.remove(index);
  };

  return (
    <div className="space-y-2">
      {rows.map((item, index) => (
        <div key={rowKeys[index]} className="grid grid-cols-[1fr_auto] gap-2">
          <FilterRow
            id={`${id}-${index}`}
            placeholder={placeholder}
            value={item}
            onCommit={(typed) => commit(index, typed)}
            onLeave={() => {
              // Left empty, a held row added to a list goes; a side's held first row stays with its mode.
              if (index === items.length && !startHeld) setHeldAt(null);
            }}
            disabled={form.disabled}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${itemLabel.toLowerCase()}`}
            onClick={() => {
              flushHeldEdits();
              remove(index);
            }}
            className="shrink-0"
            disabled={form.disabled}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          flushHeldEdits();
          if (!holding) setHeldAt(items.length);
        }}
        className="w-full"
        disabled={form.disabled}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add {itemLabel}
      </Button>
    </div>
  );
}

function FilterRow({
  id,
  placeholder,
  value,
  onCommit,
  onLeave,
  disabled,
}: {
  id: string;
  placeholder: string;
  value: string;
  onCommit: (typed: string) => void;
  onLeave: () => void;
  disabled: boolean;
}) {
  // An emptied row is removed once it is left, not under the cursor.
  const text = useHeldText(value, onCommit, { pause: (typed) => typed !== "" });
  return (
    <VaultAwareInput
      id={id}
      placeholder={placeholder}
      value={text.value}
      onChange={(e) => text.change(e.target.value)}
      onBlur={() => {
        text.flush();
        onLeave();
      }}
      onKeyDown={(e) => text.handleKeyDown(e)}
      disabled={disabled}
    />
  );
}
