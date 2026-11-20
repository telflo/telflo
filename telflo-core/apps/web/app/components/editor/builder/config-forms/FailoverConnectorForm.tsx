import { Plus, Trash2 } from "lucide-react";

import { ConfigSection } from "./ConfigSection.js";
import { DurationField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { ItemScope, useHeldItem } from "./shared/held-item.js";
import { PipelineListField, useConnectorPipelineOptions } from "./shared/PipelineListField.js";
import { SendingQueueSection } from "./shared/SendingQueueSection.js";
import { Button } from "~/components/ui/button.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The failover connector's form, over the form's fields. The priority levels
 * are a sortable list of cards; each card is its level's `PipelineListField`
 * (`ItemScope` over `priority_levels.<index>`), so a choice writes its item by
 * its lines.
 *
 * - Dragging a level moves its own lines (`form.move`); cards are keyed by
 *   their levels (`useCardKeys`), not by index. Ids are by card
 *   index (`level-0-targets`, sortable `level-0`), never a value.
 * - A level offers `connectorPipelineOptions` less the pipelines other
 *   levels name (the collector itself doesn't refuse one at two levels).
 *   Choosing a pipeline writes it and, in the store, the connector into
 *   that pipeline's receivers, one change with its toast; removing one, or
 *   a level, takes the connector out of receivers once nothing here names
 *   the pipeline, unless it is the pipeline's only receiver
 *   (`failover.go:77-84` refuses a level naming a pipeline that doesn't
 *   receive from the connector).
 * - Fixed: Add Priority Level holds a card that isn't in the text (never
 *   an appended `[]`, which `failover.go:78-81` refuses); its first
 *   pipeline chosen writes the level `[p]`. A level's last pipeline can't
 *   be removed (its Remove disabled, with a hint to remove the level), so
 *   the form never writes a level `[]`; "No priority levels configured"
 *   hides while a card is held.
 * - Retry Interval's default 10m and the queue on by default are the
 *   collector's (`factory.go:30-35`: `sending_queue` is Some(default)).
 */

/** A scalar's text as written, or "" for anything else. */
function textOf(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

/** Under a level's last pipeline, whose Remove is disabled (`failover.go:77-84` refuses an empty level). */
export const LEVEL_KEEPS_LAST_PIPELINE = "A priority level needs at least one pipeline. Remove the level instead.";

const TARGETS_HELP =
  "Pipelines at this level — the connector is wired into their receivers automatically. If any of them fails, the whole level is treated as unhealthy.";

export function FailoverConnectorForm() {
  const form = useForm();
  const options = useConnectorPipelineOptions(form);
  const levelsView = form.read(["priority_levels"]);
  const levels = levelsView.kind === "list" ? levelsView.value : [];
  const cards = useCardKeys(levels);
  const held = useHeldItem(["priority_levels"], { cards });
  const levelsShowable = levelsView.kind === "list" || levelsView.kind === "absent";

  /** Level `index`'s pipelines as written (none for a level that isn't a list). */
  const namesAt = (index: number): string[] => {
    const level = form.read(["priority_levels", index]);
    return level.kind === "list" ? level.value.map((_item, at) => textOf(form.read(["priority_levels", index, at]))) : [];
  };
  const named = levels.map((_level, index) => namesAt(index));
  /** The pipelines the other levels name: a level can't choose them. */
  const claimedElsewhere = (index: number) => named.flatMap((names, at) => (at === index ? [] : names));

  const removeLevel = (index: number) => {
    if (form.remove(["priority_levels", index]) === "written") cards.remove(index);
  };

  const moveLevel = (from: number, to: number) => {
    // The held card, last, isn't in the text: it neither moves nor is a drop target.
    if (from >= levels.length || to >= levels.length) return;
    if (form.move(["priority_levels"], from, to) === "written") cards.move(from, to);
  };

  // The held card shows at the list's end, keyed as its item will be.
  const keys = held.held ? [...cards.keys, cards.next] : cards.keys;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div>
          <label className="text-sm font-medium">Priority Levels</label>
          <p className="text-xs text-muted-foreground">
            Tried top to bottom. Telemetry goes to the highest level whose pipelines are all healthy; several pipelines at one level
            fan out together.
          </p>
        </div>

        {levels.length === 0 && levelsShowable && !held.held && (
          <InlineAlert variant="warn" title="No priority levels configured">
            Add at least one level with a target pipeline — the collector rejects a failover connector with an empty priority list.
          </InlineAlert>
        )}

        {!levelsShowable ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <SortableList list="level" items={keys} onReorder={moveLevel} listClassName="space-y-2" contextId="failover-connector-levels">
            {(key, index, id) => {
              const isHeld = held.held && index === levels.length;
              const names = isHeld ? [] : (named[index] ?? []).filter((name) => name.trim() !== "");
              return (
                <SortableItem key={key} id={id} disabled={form.disabled || isHeld}>
                  {({ isDragging, dragHandleProps }) => (
                    <div
                      className={`rounded-md border border-border bg-card overflow-hidden ${isDragging ? "shadow-lg ring-2 ring-brand" : ""}`}
                    >
                      <div className="flex items-center justify-between p-2.5">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <SortableHandle {...dragHandleProps} disabled={form.disabled || isHeld} />
                          <div className="flex-1 min-w-0 px-2">
                            <div className="font-medium text-sm truncate">
                              Priority {index + 1}
                              {index === 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">(preferred)</span>}
                            </div>
                            <div className="text-xs text-muted-foreground truncate font-mono">
                              {names.length > 0 ? names.join(", ") : "no pipelines"}
                            </div>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove priority level"
                          onClick={() => (isHeld ? held.drop() : removeLevel(index))}
                          disabled={form.disabled}
                          className="text-fail hover:text-fail hover:bg-fail-soft"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="border-t border-border p-2.5 bg-muted/50">
                        <ItemScope listPath={["priority_levels"]} index={index} held={isHeld ? held : undefined}>
                          <PipelineListField
                            path={[]}
                            id={`level-${index}-targets`}
                            label="Target Pipelines"
                            options={options}
                            exclude={isHeld ? named.flat() : claimedElsewhere(index)}
                            helpText={TARGETS_HELP}
                            addButtonText="Add Pipeline"
                            keepLast={LEVEL_KEEPS_LAST_PIPELINE}
                          />
                        </ItemScope>
                      </div>
                    </div>
                  )}
                </SortableItem>
              );
            }}
          </SortableList>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => held.hold()}
          className="w-full"
          disabled={form.disabled || !levelsShowable || held.held}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Priority Level
        </Button>
      </div>

      <ConfigSection title="Recovery & Queue">
        <DurationField
          path={["retry_interval"]}
          id="failover-retry-interval"
          label="Retry Interval"
          defaultValue="10m"
          description="How often the connector probes unhealthy higher-priority levels to fail back."
          placeholder="10m"
        />

        <SendingQueueSection path={["sending_queue"]} showBatchSettings={true} />
        <p className="text-[11px] leading-4 text-muted-foreground">
          Queue here rather than on the downstream exporters, so data already queued when an exporter fails is not stranded in its
          queue and can still fail over.
        </p>
      </ConfigSection>
    </div>
  );
}
