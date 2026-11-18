import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { useCardKeys } from "../../shared/card-keys.js";
import { useOperatorId } from "../operator-ids.js";
import { Button } from "~/components/ui/button.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The `retain` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). The rows are hand-drawn (an input
 * and a "Remove" button each, "Add Field" below), written by item: a row's
 * typing sets its item (held, D9b decision 2), Remove removes the item's
 * lines. Each row's input gets a fixed id by index,
 * `op-<index>-retain-field-<row>` (decision 10).
 *
 * Changed (decisions 3 and 9; Preflight ruling 8): Add Field holds a row
 * that isn't in the text; its first typing appends the item as the list's
 * last (after the pause, on blur or Enter, on a save, or when the card
 * goes), and the row becomes that item's in place (the same key, so focus
 * and caret stay). Rows are keyed by their items (`useCardKeys`; D9c
 * Ruling 68): a row emptied and left removes its item as the pointer goes
 * down on a Remove button, and with index keys the click then removed the
 * next item too. Left empty, the held row goes. A row emptied and left
 * removes its item. So `""` is never written, which the collector refuses
 * (`fields` is `[]entry.Field`, `transformer/retain/config.go:38`;
 * `entry/field.go:111-133`). The empty text shows while there are no rows (a
 * held row is one). A `fields` that isn't a list of scalars is read-only with
 * decision 3's hint. Fixed (decision 4; Preflight ruling 13): the hint's
 * examples are fields the collector takes. Not `timestamp` (not a field: the
 * prefix must be `body`, `attributes` or `resource`, `field.go:117-131`) and
 * bare `attributes` and `resource` ("All attributes", "Resource attributes";
 * refused without a sub-field, `field.go:119-126`) are gone; the list is
 * `body`, `attributes.user_id` and `resource["host.name"]`, a group whose
 * fields aren't named being kept whole (`docs/operators/retain.md`;
 * `retain/transformer.go:35-43`).
 */

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

function scalarText(view: ValueView): string | null {
  if (view.kind !== "scalar") return null;
  const text = view.source ?? String(view.value);
  return /[\r\n]/.test(text) ? null : text;
}

function RetainRow({
  id,
  value,
  onCommit,
  onLeave,
  onRemove,
  disabled,
}: {
  id: string;
  value: string;
  onCommit: (typed: string) => void;
  onLeave: () => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  // An emptied row is written (removed) only once it is left, not under the cursor (Preflight ruling 8).
  const text = useHeldText(value, onCommit, { pause: (typed) => typed !== "" });
  return (
    <div className="flex gap-2">
      <VaultAwareInput
        id={id}
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={() => {
          text.flush();
          onLeave();
        }}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder="body, attributes.field, resource.key"
        className="flex-1 font-mono text-xs"
        disabled={disabled}
      />
      <Button variant="ghost" size="sm" onClick={onRemove} type="button" aria-label="Remove" disabled={disabled}>
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  );
}

export function RetainOperatorForm() {
  const form = useForm();
  const opId = useOperatorId();
  const path = ["fields"];
  const view = form.read(path);
  const items = view.kind === "absent" ? [] : view.kind === "list" ? view.value.map((_item, index) => scalarText(form.read([...path, index]))) : null;
  const shown = items?.every((item): item is string => item !== null) ? items : null;
  /** The list's length when Add Field made the held row: it shows while the list still has that length. */
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const length = shown?.length ?? -1;
  const [seenLength, setSeenLength] = useState(length);
  if (seenLength !== length) {
    setSeenLength(length);
    setHeldAt(null);
  }
  const holding = shown !== null && heldAt === shown.length;
  const rows = shown === null ? [] : holding ? [...shown, ""] : shown;
  // Rows keyed by their items (Ruling 68): a row emptied and left removes its item as the pointer goes down on
  // its Remove, and the click must not land on the next item's row. The held row takes the key its item gets.
  const cards = useCardKeys(shown ?? []);
  const rowKeys = holding ? [...cards.keys, cards.next] : cards.keys;
  const removeItem = (index: number) => {
    if (form.remove([...path, index]) === "written") cards.remove(index);
  };
  const disabled = form.disabled || shown === null;

  return (
    <div className="space-y-4">
      <div className="border border-warn/25 bg-warn-soft rounded-md px-3 py-2">
        <p className="text-xs text-warn">
          Keep only the specified fields. All other fields will be removed. Use this carefully as it permanently drops data.
        </p>
      </div>

      <div className="space-y-3 p-3 bg-muted/50 rounded-md border border-border">
        <h3 className="text-sm font-medium text-foreground">Fields to Retain</h3>

        {shown !== null && rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No fields specified. Click &quot;Add Field&quot; to add fields to retain.</p>
        )}
        {shown === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}

        {rows.map((value, index) => (
          <RetainRow
            key={rowKeys[index]}
            id={opId(`retain-field-${index}`)}
            value={value}
            onCommit={(typed) => {
              if (shown === null) return;
              if (index === shown.length) {
                // The held row: its first typing is the list's new last item.
                if (typed === "") return;
                if (form.set([...path, index], typed) !== "refused") setHeldAt(null);
              } else if (typed === "") {
                removeItem(index);
              } else {
                form.set([...path, index], typed);
              }
            }}
            onLeave={() => {
              // Left empty, the held row goes (what it held was written just before, making it an item's row).
              if (shown !== null && index === shown.length) setHeldAt(null);
            }}
            onRemove={() => {
              flushHeldEdits();
              // The held row goes, unwritten; any other row's item is removed.
              if (shown !== null && index === shown.length) setHeldAt(null);
              else removeItem(index);
            }}
            disabled={disabled}
          />
        ))}

        <Button
          onClick={() => {
            flushHeldEdits();
            if (shown !== null) setHeldAt(shown.length);
          }}
          size="sm"
          variant="outline"
          type="button"
          className="w-full"
          disabled={disabled}
        >
          <Plus className="w-4 h-4 mr-1" />
          Add Field
        </Button>
      </div>

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Common fields to retain:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            <code className={CODE}>body</code> - Log message
          </li>
          <li>
            <code className={CODE}>attributes.user_id</code> - An attribute
          </li>
          <li>
            <code className={CODE}>{'resource["host.name"]'}</code> - A resource attribute
          </li>
        </ul>
      </div>
    </div>
  );
}
