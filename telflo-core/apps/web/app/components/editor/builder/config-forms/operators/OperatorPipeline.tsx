import { ArrowDown, FileInput, FileOutput } from "lucide-react";

import { FormScope, UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { useCardKeys } from "../shared/card-keys.js";
import { OperatorCard, OperatorCardHeader, StillGrip, useOperatorItem } from "./OperatorCard.js";
import { operatorSeed, type OperatorType } from "./operator-catalog.js";
import { OperatorSelector } from "./OperatorSelector.js";
import { SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The operator pipeline: a filelog, journald or syslog receiver's
 * `operators` list as a column of operator cards between the log entry's
 * input and output, over the form. The receivers' forms put it in their
 * Operators section with the list's `path`.
 *
 * Every change is the item's own lines, never the whole array.
 * - Add Operator (the selector) appends the type's seed (`operatorSeed`) as
 *   one item; an empty `operators: []`, a null `operators:` or a missing key
 *   takes it in block style.
 * - The trash button removes the item's lines (the comment lines above it
 *   stay, as with any removed entry); removing the last operator removes
 *   `operators`. What a field of the card still holds is written first,
 *   so it can't write into the item after it has gone.
 * - Dragging a card (pointer or keyboard, the shared `SortableList`, list
 *   `operator`: sortable ids `operator-<index>`, never a value) moves the
 *   item's lines, its comments with it (`form.move`; the array is never
 *   rebuilt).
 * - Each card sits under its item's scope (`FormScope` at `<path>.<index>`),
 *   keyed by the item's card key (`useCardKeys`): its state (expanded, a
 *   section's toggle, a selector's pick) follows it through the form's own
 *   moves and removals, and is matched to it again after an undo, a redo or
 *   a YAML edit. A card whose item no key matches starts afresh (expanded,
 *   as every card starts).
 * - The drag overlay draws the dragged card's header only: a whole card
 *   would draw every field's id twice.
 *
 * Fixed: the input row names the receiver's source ("from file", "from
 * journal", "from syslog"; not "from file" for every receiver), and no arrow
 * is drawn after a router: a router sends each entry where its routes say
 * (`transformer/router/transformer.go:90-120`), never on to the next card or
 * to the output by position.
 * Changed: `operators` that isn't a list is read-only, with
 * `UNSHOWABLE_VALUE_MESSAGE` in place of the cards (no count; Add Operator
 * disabled).
 */

export type OperatorSource = "file" | "journal" | "syslog";

function Arrow({ muted = false }: { muted?: boolean }) {
  return <ArrowDown className={`w-5 h-5 ${muted ? "text-gray-300" : "text-gray-400"}`} />;
}

export function OperatorPipeline({ path, source }: { path: ValuePath; source: OperatorSource }) {
  const form = useForm();
  const view = form.read(path);
  const showable = view.kind === "list" || view.kind === "absent";
  const items = view.kind === "list" ? view.value : [];
  const count = items.length;
  const cards = useCardKeys(items);
  const isRouter = (index: number) => {
    const type = form.read([...path, index, "type"]);
    return type.kind === "scalar" && type.value === "router";
  };
  const lastIsRouter = count > 0 && isRouter(count - 1);

  const addOperator = (type: OperatorType) => {
    if (form.set([...path, count], operatorSeed(type)) === "written") cards.add();
  };

  const removeOperator = (index: number) => {
    // A field of the card writes what it holds before the item goes (a held edit would otherwise recreate it).
    flushHeldEdits();
    const result = count === 1 ? form.remove(path) : form.remove([...path, index]);
    if (result === "written") cards.remove(index);
  };

  const moveOperator = (from: number, to: number) => {
    if (form.move(path, from, to) === "written") cards.move(from, to);
  };

  return (
    <div className="space-y-4">
      {/* Pipeline Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Operator Pipeline</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Operators process logs in order from top to bottom</p>
        </div>
        {showable && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {count} operator{count !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Data Flow Start */}
      <div className="flex items-center gap-2 p-3 bg-muted rounded-lg border border-border">
        <FileInput className="w-4 h-4 text-muted-foreground" />
        <span className="tf-label">Log Entry Input</span>
        <span className="text-xs text-muted-foreground ml-auto">from {source}</span>
      </div>

      {!showable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}

      {/* Operators List */}
      {count > 0 && (
        <>
          <div className="flex justify-center">
            <Arrow />
          </div>

          <SortableList
            list="operator"
            items={cards.keys}
            onReorder={moveOperator}
            listClassName="space-y-3"
            contextId="operators"
            renderOverlay={(_key, index) => (
              <FormScope path={[...path, index]}>
                <OverlayHeader index={index} />
              </FormScope>
            )}
          >
            {(key, index, id) => (
              <div key={key}>
                <SortableItem id={id} disabled={form.disabled}>
                  {({ isDragging, dragHandleProps }) => (
                    <FormScope path={[...path, index]}>
                      <OperatorCard
                        index={index}
                        isDragging={isDragging}
                        dragHandleProps={dragHandleProps}
                        onRemove={() => removeOperator(index)}
                      />
                    </FormScope>
                  )}
                </SortableItem>
                {index < count - 1 && !isRouter(index) && (
                  <div className="flex justify-center py-2">
                    <Arrow />
                  </div>
                )}
              </div>
            )}
          </SortableList>

          {/* Arrow before output */}
          {!lastIsRouter && (
            <div className="flex justify-center">
              <Arrow />
            </div>
          )}
        </>
      )}

      {/* Empty State */}
      {showable && count === 0 && (
        <div className="flex flex-col items-center py-8 text-center">
          <div className="flex justify-center mb-2">
            <Arrow muted />
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">No operators configured</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 max-w-xs">
            Add operators to parse, transform, or filter your log entries before they are sent to the collector.
          </p>
          <div className="flex justify-center my-2">
            <Arrow muted />
          </div>
        </div>
      )}

      {/* Add Operator Button */}
      <OperatorSelector onSelect={addOperator} disabled={form.disabled || !showable} />

      {/* Data Flow End */}
      {count > 0 && !lastIsRouter && (
        <div className="flex justify-center">
          <Arrow />
        </div>
      )}

      <div className="flex items-center gap-2 p-3 bg-muted rounded-lg border border-border">
        <FileOutput className="w-4 h-4 text-muted-foreground" />
        <span className="tf-label">Log Entry Output</span>
        <span className="text-xs text-muted-foreground ml-auto">to pipeline</span>
      </div>

      {/* Tips */}
      <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <p className="text-xs text-gray-600 dark:text-gray-400">
          <strong>Tips:</strong>
        </p>
        <ul className="text-xs text-gray-500 dark:text-gray-400 list-disc ml-4 mt-1 space-y-1">
          <li>Drag operators to reorder the pipeline</li>
          <li>Click expand/collapse to show/hide configuration</li>
          <li>Common flow: Parse → Extract fields → Filter → Transform</li>
        </ul>
      </div>
    </div>
  );
}

/** The dragged card's header, alone. */
function OverlayHeader({ index }: { index: number }) {
  const item = useOperatorItem();
  return (
    <div className="border border-border rounded-lg bg-card">
      <OperatorCardHeader index={index} item={item} handle={<StillGrip />} />
    </div>
  );
}
