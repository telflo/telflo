import { Plus, Trash2 } from "lucide-react";

import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import { Textarea } from "~/components/ui/textarea.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";

/*
 * A list of values (ADR 0018): plain inputs, one per value, each with a
 * "Remove" button (a fixed label, never the value; D9b decision 10), and
 * the add button below.
 *
 * A form writes by item (D9b decision 2), so the list says which item
 * changed: a row's typing is held and handed back once (`onValueChange`,
 * after the pause, on blur or Enter), and adding or removing says which
 * (`onAdd` appends an empty value; `onRemove`). What any row still holds is
 * written before a row is added or removed, so it lands on its own item.
 *
 * For a list whose empty rows are held rather than written (D9c decision 9,
 * Preflight ruling 8; `holdEmpty`): a row emptied isn't handed back after
 * the pause, only when it is left (blur, Enter, a flush), so the form can
 * remove its item then rather than under the cursor; `onRowBlur` says a
 * row was left, after what it held was handed back.
 *
 * The Kubernetes forms' rows (D9c Task 2): each a `VaultAwareInput`
 * (`vaultAware`), a remove button whose fixed label the form names
 * (`removeLabel`, "Remove namespace"), and, for k8sobjects' per- object
 * namespaces, a drag handle before each row (`sortable`: the rows below
 * `count` are dnd-kit items `<list>-<index>`, and a drop says which row moved
 * where; a held row past `count` has a disabled handle and is never a drop
 * target).
 *
 * Every row is keyed by its item (`rowKeys`, the form's `useCardKeys`; D9c
 * Ruling 68), never by its index: a row emptied and left removes its item
 * as the pointer goes down on a Remove button, and with index keys the
 * next item's row took the removed row's place, button and all, so the
 * click removed that item too. Keyed by item, the removed row's button goes
 * with it and the click lands nowhere. A held row takes the key its item
 * will get, so once written it keeps its input, focus and caret.
 *
 * The logs forms' rows (D9c Task 8): filelog's path rows and
 * journald's lists are `font-mono text-xs` inputs (`inputClassName`), and
 * journald's Add button is a small one, not full width, with a smaller
 * icon (`addButtonClassName`, `addIconClassName`).
 *
 * D9d's numeric rows (load balancing's ports): `numeric` gives each row
 * `inputMode="decimal"`; the form writes what is typed. `canRemove` says
 * which rows' Remove is enabled (load balancing's last endpoint and last
 * routing attribute, D9d Task 4).
 *
 * D9d Task 9's rows: `multiline` makes each row a Textarea of that many
 * rows, where Enter is a new line (transform's group statements);
 * `emptyText` shows under no rows (transform's "No conditions (statements
 * always run)"); `locked` disables typing and Add while another setting
 * excludes the list, leaving Remove (logdedup's Include and Exclude Fields,
 * as k8sobjects' box can always be unticked).
 */

interface MultiValueInputProps {
  label?: string;
  /** The first row's id, for a label elsewhere. */
  id?: string;
  values: readonly string[];
  /** Each row's key, by its item (the form's `useCardKeys`), never its index or its value. */
  rowKeys: readonly number[];
  onValueChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  placeholder?: string;
  helpText?: string;
  addButtonText?: string;
  disabled?: boolean;
  /** A row emptied is handed back only when it is left, not after the pause. */
  holdEmpty?: boolean;
  /** A row was left (after its edit, if any, was handed back). */
  onRowBlur?: (index: number) => void;
  /** The remove buttons' fixed label (e.g. "Remove namespace"); never a value. */
  removeLabel?: string;
  /** Rows are `VaultAwareInput`s, with the `$` picker. */
  vaultAware?: boolean;
  /** Rows below `count` reorder by drag (pointer or keyboard); `onMove(from, to)` says which. */
  sortable?: { list: string; contextId: string; count: number; onMove: (from: number, to: number) => void };
  /** Each row's input classes (the filelog and journald rows: `flex-1 font-mono text-xs`). */
  inputClassName?: string;
  /** The Add button's classes (journald's: none, not full width). */
  addButtonClassName?: string;
  /** The Add button's icon classes (journald's: `mr-1 h-3 w-3`). */
  addIconClassName?: string;
  /** Each row is a number: `inputMode="decimal"`. */
  numeric?: boolean;
  /** Whether row `index`'s Remove is enabled (all by default). */
  canRemove?: (index: number) => boolean;
  /** Each row is a Textarea of this many rows; Enter is a new line. */
  multiline?: number;
  /** Shown while there are no rows. */
  emptyText?: string;
  /** Typing and Add are disabled; Remove isn't. */
  locked?: boolean;
}

export function MultiValueInput({
  label,
  id,
  values,
  rowKeys,
  onValueChange,
  onAdd,
  onRemove,
  placeholder = "",
  helpText,
  addButtonText = "Add",
  disabled = false,
  holdEmpty = false,
  onRowBlur,
  removeLabel = "Remove",
  vaultAware = false,
  sortable,
  inputClassName = "flex-1",
  addButtonClassName = "w-full",
  addIconClassName = "h-4 w-4 mr-2",
  numeric = false,
  canRemove,
  multiline,
  emptyText,
  locked = false,
}: MultiValueInputProps) {
  const handleAddValue = () => {
    flushHeldEdits();
    onAdd();
  };

  const handleRemoveValue = (index: number) => {
    flushHeldEdits();
    onRemove(index);
  };

  const row = (value: string, index: number) => (
    <>
      <MultiValueRow
        id={index === 0 ? id : undefined}
        placeholder={placeholder}
        value={value}
        onCommit={(typed) => onValueChange(index, typed)}
        onLeave={() => onRowBlur?.(index)}
        holdEmpty={holdEmpty}
        vaultAware={vaultAware}
        numeric={numeric}
        multiline={multiline}
        className={inputClassName}
        disabled={disabled || locked}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={removeLabel}
        onClick={() => handleRemoveValue(index)}
        className="shrink-0"
        disabled={disabled || (canRemove !== undefined && !canRemove(index))}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </>
  );

  return (
    <div className="space-y-2">
      {label && <Label className="text-[13px] font-medium text-foreground">{label}</Label>}

      {values.length > 0 && !sortable && (
        <div className="space-y-2">
          {values.map((value, index) => (
            <div key={rowKeys[index]} className="flex gap-2">
              {row(value, index)}
            </div>
          ))}
        </div>
      )}

      {values.length === 0 && emptyText !== undefined && <p className="text-[11px] leading-4 text-muted-foreground">{emptyText}</p>}

      {values.length > 0 && sortable && (
        <SortableList
          list={sortable.list}
          items={values}
          onReorder={(from, to) => {
            if (from < sortable.count && to < sortable.count) sortable.onMove(from, to);
          }}
          listClassName="space-y-2"
          contextId={sortable.contextId}
        >
          {(value, index, itemId) => (
            <SortableItem key={rowKeys[index]} id={itemId} disabled={disabled || index >= sortable.count}>
              {({ isDragging, dragHandleProps }) => (
                <div className={`flex gap-2 ${isDragging ? "shadow-lg ring-2 ring-ring rounded-md" : ""}`}>
                  <SortableHandle {...dragHandleProps} disabled={disabled || index >= sortable.count} />
                  {row(value, index)}
                </div>
              )}
            </SortableItem>
          )}
        </SortableList>
      )}

      <Button type="button" variant="outline" size="sm" onClick={handleAddValue} className={addButtonClassName} disabled={disabled || locked}>
        <Plus className={addIconClassName} />
        {addButtonText}
      </Button>

      {helpText && <p className="text-[11px] leading-4 text-muted-foreground">{helpText}</p>}
    </div>
  );
}

function MultiValueRow({
  id,
  placeholder,
  value,
  onCommit,
  onLeave,
  holdEmpty,
  vaultAware,
  numeric,
  multiline,
  className,
  disabled,
}: {
  id: string | undefined;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
  onLeave: () => void;
  holdEmpty: boolean;
  vaultAware: boolean;
  numeric: boolean;
  multiline: number | undefined;
  className: string;
  disabled: boolean;
}) {
  const text = useHeldText(value, onCommit, holdEmpty ? { pause: (typed) => typed !== "" } : {});
  const props = {
    id,
    placeholder,
    ...(numeric ? { inputMode: "decimal" as const } : {}),
    value: text.value,
    onBlur: () => {
      text.flush();
      onLeave();
    },
    className,
    disabled,
  };
  if (multiline !== undefined) {
    return (
      <Textarea {...props} rows={multiline} onChange={(e) => text.change(e.target.value)} onKeyDown={(e) => text.handleKeyDown(e, false)} />
    );
  }
  return vaultAware ? (
    <VaultAwareInput {...props} onChange={(e) => text.change(e.target.value)} onKeyDown={(e) => text.handleKeyDown(e)} />
  ) : (
    <Input {...props} onChange={(e) => text.change(e.target.value)} onKeyDown={(e) => text.handleKeyDown(e)} />
  );
}
