import { Plus, Trash2 } from "lucide-react";
import { useRef } from "react";

import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { useCardKeys } from "./card-keys.js";
import { ItemScope, useHeldItem, type HeldItem } from "./held-item.js";
import { Button } from "~/components/ui/button.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * spanmetrics' dimension rows (D9d decision 12): `[]Dimension{name, default}`
 * under `path`, a row per item (Name, Default, "Remove dimension"), and "Add
 * Dimension".
 *
 * - Fixed (decision 3): Add never appends `{name: ""}`, which the
 *   collector refuses ("dimension entry must set one of `name` or `glob`",
 *   `connector/spanmetricsconnector/config.go:238-241`). Add holds a row
 *   (`useHeldItem`) until a name is typed; a Default typed first waits in
 *   it. The first name writes `{name, default?}` as the list's last item,
 *   and the row becomes the item's in place (the same key, so focus and
 *   caret stay). The held row goes when focus leaves it with nothing in it
 *   (as MultiValueField's held rows, D9c Preflight ruling 8; D9d Ruling
 *   33; focus moving into a field's `$` picker doesn't leave it, Ruling 38), when its list's length changes or it stops being a list (Ruling
 *   33a: another dimension edited keeps it), or with the form.
 * - A name cleared removes the item once the field is left (never written
 *   `""`); Default cleared removes `default`.
 * - An item that isn't a mapping, holds `glob` (a name typed beside it
 *   would be refused, `config.go:238-239`), or a name or default that isn't
 *   a one-line scalar, is a read-only row with D9b's hint; its Remove works.
 * - Rows are keyed by their items (D9c Ruling 68). Ids are
 *   `<id>-<index>-name` and `<id>-<index>-default`; the remove label is
 *   fixed (decision 13).
 */

/** A Radix popover's portalled wrapper, as `useUndoRedo` finds one. */
const POPPER_WRAPPER = "[data-radix-popper-content-wrapper]";

/** The held dimension's key order: name, then default. */
const SEED = { name: undefined, default: undefined };

const hasName = (item: unknown) =>
  item !== null && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" && (item as { name: string }).name !== "";

/** A one-line scalar as written, `""` unset, or null when it can't be shown. */
function lineOf(view: ValueView): string | null {
  if (view.kind === "absent") return "";
  if (view.kind !== "scalar") return null;
  const shown = view.source ?? String(view.value);
  return /[\r\n]/.test(shown) ? null : shown;
}

export function DimensionListField({
  path,
  id,
  namePlaceholder = "e.g. http.method",
}: {
  path: ValuePath;
  /** Fixed per field: each row's inputs are `<id>-<index>-name` and `-default`. */
  id: string;
  namePlaceholder?: string;
}) {
  const form = useForm();
  const view = form.read(path);
  const items = view.kind === "list" ? view.value : [];
  const cards = useCardKeys(items);
  const held = useHeldItem(path, { cards, ready: hasName });

  if (view.kind !== "list" && view.kind !== "absent") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }

  const removeItem = (index: number) => {
    if (form.remove([...path, index]) === "written") cards.remove(index);
  };

  const rows = cards.keys.map((key, index) => (
    <DimensionRow key={key} path={path} index={index} id={id} namePlaceholder={namePlaceholder} onRemove={() => removeItem(index)} />
  ));
  // Focus leaving the held row with nothing in it drops it (what its fields held was written to it just before).
  const leaveHeld = () => {
    if (held.empty()) held.drop();
  };
  // The held row is the list's last, in the same array, keyed by the key its item will get: once written, it is that row.
  if (held.held) {
    rows.push(
      <DimensionRow
        key={cards.next}
        path={path}
        index={items.length}
        id={id}
        namePlaceholder={namePlaceholder}
        held={held}
        onRemove={held.drop}
        onLeave={leaveHeld}
      />,
    );
  }

  return (
    <>
      {rows}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => held.hold()}
        className="w-full"
        disabled={form.disabled}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Dimension
      </Button>
    </>
  );
}

function DimensionRow({
  path,
  index,
  id,
  namePlaceholder,
  held,
  onRemove,
  onLeave,
}: {
  path: ValuePath;
  index: number;
  id: string;
  namePlaceholder: string;
  held?: HeldItem;
  onRemove: () => void;
  /** The held row's: focus left it. */
  onLeave?: () => void;
}) {
  return (
    <ItemScope listPath={path} index={index} held={held} seed={SEED}>
      <DimensionFields
        id={id}
        index={index}
        namePlaceholder={namePlaceholder}
        held={held !== undefined}
        onRemove={onRemove}
        {...(onLeave ? { onLeave } : {})}
      />
    </ItemScope>
  );
}

function DimensionFields({
  id,
  index,
  namePlaceholder,
  held,
  onRemove,
  onLeave,
}: {
  id: string;
  index: number;
  namePlaceholder: string;
  held: boolean;
  onRemove: () => void;
  onLeave?: () => void;
}) {
  const form = useForm();
  const formRef = useRef(form);
  formRef.current = form;
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;
  const item = form.read([]);
  const name = lineOf(form.read(["name"]));
  const value = lineOf(form.read(["default"]));
  const showable = (item.kind === "map" || item.kind === "absent") && form.read(["glob"]).kind === "absent" && name !== null && value !== null;

  const nameText = useHeldText(
    showable ? (name ?? "") : "",
    (typed) => {
      if (typed !== "") formRef.current.set(["name"], typed);
      // A name cleared removes the dimension (never written `""`); the held row's waits.
      else if (held) formRef.current.remove(["name"]);
      else onRemoveRef.current();
    },
    // Emptied, it is removed only once it is left, not under the cursor (D9c Preflight ruling 8).
    { pause: (typed) => typed !== "" },
  );
  const defaultText = useHeldText(showable ? (value ?? "") : "", (typed) => {
    if (typed === "") formRef.current.remove(["default"]);
    else formRef.current.set(["default"], typed);
  });
  const readOnly = form.disabled || !showable;

  return (
    <>
      <div
        className="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
        onBlur={(e) => {
          // After the field's own blur wrote what it held; focus moving within the row keeps it, and so does focus
          // moving into a popover (VaultAwareInput's `$` picker, portalled to <body>, which skips the field's blur
          // and gives the field focus back; D9d Ruling 38).
          const to = e.relatedTarget;
          if (!onLeave || (to instanceof Node && e.currentTarget.contains(to))) return;
          if (to instanceof Element && to.closest(POPPER_WRAPPER) !== null) return;
          onLeave();
        }}
      >
        <VaultAwareInput
          id={`${id}-${index}-name`}
          placeholder={namePlaceholder}
          value={nameText.value}
          onChange={(e) => nameText.change(e.target.value)}
          onBlur={nameText.flush}
          onKeyDown={(e) => nameText.handleKeyDown(e)}
          disabled={readOnly}
        />
        <VaultAwareInput
          id={`${id}-${index}-default`}
          placeholder="Default value"
          value={defaultText.value}
          onChange={(e) => defaultText.change(e.target.value)}
          onBlur={defaultText.flush}
          onKeyDown={(e) => defaultText.handleKeyDown(e)}
          disabled={readOnly}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove dimension"
          onClick={() => {
            // What a row still holds belongs to its index, which the removal shifts: written first.
            flushHeldEdits();
            onRemoveRef.current();
          }}
          disabled={form.disabled}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {!showable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </>
  );
}
