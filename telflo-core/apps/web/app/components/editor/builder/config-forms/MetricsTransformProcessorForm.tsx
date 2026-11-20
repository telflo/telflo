import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { BareSelectField, NumberField, SelectField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments, type Notice } from "./shared/AdjustmentAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { isEmptyValue, ItemScope, useHeldItem } from "./shared/held-item.js";
import { StringListField } from "./shared/StringListField.js";
import { Button } from "~/components/ui/button.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The metrics transform processor's form, over the form's fields: each
 * field writes its own key under `transforms.<i>` or
 * `transforms.<i>.operations.<j>` (`ItemScope`), so keys the form doesn't
 * show (`submatch_case`, `experimental_match_labels`, `value_actions`)
 * stay. Collector claims are contrib v0.162.0's
 * `processor/metricstransformprocessor`. The collector's own name,
 * `metrics_transform`, opens this form.
 *
 * - The transforms are cards, not sortable, keyed by their items
 *   (`useCardKeys`, not by index); one transform starts expanded. The
 *   header is a button, "Collapse transform" / "Expand transform".
 * - Fixed: Add Transform holds a card that isn't in the text (never
 *   `include: ""`, refused, `factory.go:70-72`). Its Metric typed writes
 *   `{include: <typed>, match_type: strict, action: update}`, the seed
 *   with what was typed; a match, action, name or aggregation chosen
 *   before then is held with it. Add Operation holds an operation card
 *   (its action select shown, add_label); its first field typed writes
 *   `{action, <field>}` (never `{action: add_label}`, refused without
 *   `new_label` and `new_value`, `factory.go:122-127`); an action with no
 *   other field (Toggle int/double data type) chosen writes `{action}` at
 *   once. A transform's operations can be added once it is written.
 * - Changed: Action unset is blank, "Select action", with the hint
 *   "Required." (the collector has no default and refuses none,
 *   `factory.go:85-87`); Match Type unset is strict's placeholder and
 *   "Default strict" (`factory.go:145-147`).
 * - Changed: Action offers `group` (`config.go:158-172`).
 * - Changed: Combine writes `aggregation_type: sum` with it when the
 *   transform has none (`factory.go:97-99`), and Group writes
 *   `group_resource_labels: {}` when it has none (`factory.go:101-103`; `{}`
 *   is accepted), each with a toast.
 * - Changed: New Name says it is required for Insert and Combine while
 *   either is chosen (`factory.go:89-95`); the empty list's alert, false
 *   (no transform is accepted, `factory.go:34-36`), is an info line.
 * - An operation's action change rebuilds it as `{action}`:
 *   the action is set and its other keys removed, in one change, so the
 *   item keeps its own lines and comments. The action select is labelled
 *   "Operation action". Removing the last
 *   operation removes `operations`; Scale is a
 *   number field (a number as typed, or a reference).
 * - Text fields of an item keep `""` when cleared; New
 *   Name and Scale cleared remove their keys.
 *
 * Ids are by index (`transform-0-include`, `t0-op1-label`), never a value;
 * the header's metric is text.
 */

/** The toasts for a setting a change adds with it. */
export const COMBINE_SUM = "Aggregation Type set to sum: combine needs one.";
export const GROUP_LABELS = "Added group_resource_labels: group needs it. Edit it in the YAML.";

/** The empty list's line (an info line, not an alert). */
export const NO_TRANSFORMS = "With no transforms, metrics pass through unchanged.";
/** New Name's hint while the action is insert or combine. */
export const NEW_NAME_REQUIRED = "Required for Insert and Combine.";
/** Under an unset Action. */
export const ACTION_REQUIRED = "Required.";

const MATCH_TYPES = [
  { value: "strict", label: "Strict - Exact name" },
  { value: "regexp", label: "Regexp - Pattern" },
] as const;

const ACTIONS = [
  { value: "update", label: "Update - In place" },
  { value: "insert", label: "Insert - On a copy" },
  { value: "combine", label: "Combine - Merge matches" },
  { value: "group", label: "Group - Into new resources" },
] as const;

const AGGREGATION_TYPES = ["sum", "mean", "min", "max", "count", "median"].map((type) => ({ value: type, label: type }));

const OPERATION_ACTIONS = [
  { value: "add_label", label: "Add label" },
  { value: "update_label", label: "Rename label key" },
  { value: "delete_label_value", label: "Delete points by label value" },
  { value: "toggle_scalar_data_type", label: "Toggle int/double data type" },
  { value: "experimental_scale_value", label: "Scale values" },
  { value: "aggregate_labels", label: "Aggregate across labels" },
  { value: "aggregate_label_values", label: "Aggregate label values" },
] as const;

/** Add Transform's seed, with what is typed: `include` first. */
const TRANSFORM_SEED = { include: undefined, match_type: "strict", action: "update" };
/** Add Operation's seed. */
const OPERATION_SEED = { action: "add_label" };

/** A scalar's text as written, or "" for anything else. */
function textOf(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

function isMapping(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === "object" && !Array.isArray(item);
}

/** The held transform is written once its metric is typed (`include`, `factory.go:70-72`). */
function transformReady(item: unknown): boolean {
  return isMapping(item) && typeof item.include === "string" && item.include !== "";
}

/** Operation actions with no other field: chosen in a held card, the operation is complete. */
const FIELDLESS_OPERATIONS: ReadonlySet<string> = new Set(["toggle_scalar_data_type"]);

/**
 * The held operation is written once a field other than its action is
 * typed, or once an action with no other field is chosen
 * (`{action: toggle_scalar_data_type}` is accepted, `factory.go:119-127`).
 */
function operationReady(item: unknown): boolean {
  if (!isMapping(item)) return false;
  if (typeof item.action === "string" && FIELDLESS_OPERATIONS.has(item.action)) return true;
  return Object.entries(item).some(([key, value]) => key !== "action" && !isEmptyValue(value));
}

export function MetricsTransformProcessorForm() {
  const form = useForm();
  const view = form.read(["transforms"]);
  const showable = view.kind === "list" || view.kind === "absent";
  const transforms = view.kind === "list" ? view.value : [];
  const cards = useCardKeys(transforms);
  const held = useHeldItem(["transforms"], { cards, ready: transformReady });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set(transforms.length === 1 ? [0] : []));

  const toggle = (key: number) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const addTransform = () => {
    held.hold();
    setExpanded(new Set([...expanded, cards.next]));
  };

  const removeTransform = (index: number) => {
    if (form.remove(["transforms", index]) === "written") cards.remove(index);
  };

  // The held card shows at the list's end, keyed as its item will be.
  const keys = held.held ? [...cards.keys, cards.next] : cards.keys;

  return (
    <div className="space-y-4">
      <ConfigField
        label="Transforms"
        description="Applied in order; later transforms see the result of earlier ones. Renames and aggregations happen within a batch only."
      >
        <div className="space-y-2">
          {!showable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
          {keys.map((key, index) => {
            const isHeld = held.held && index === transforms.length;
            return (
              <div key={key} className="border border-border rounded-md overflow-hidden">
                <ItemScope listPath={["transforms"]} index={index} held={isHeld ? held : undefined} seed={TRANSFORM_SEED}>
                  <TransformCard
                    index={index}
                    expanded={expanded.has(key)}
                    onToggle={() => toggle(key)}
                    onRemove={() => (isHeld ? held.drop() : removeTransform(index))}
                    isHeld={isHeld}
                  />
                </ItemScope>
              </div>
            );
          })}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTransform}
            className="w-full"
            disabled={form.disabled || !showable || held.held}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Transform
          </Button>
        </div>
      </ConfigField>

      {showable && transforms.length === 0 && !held.held && <InlineAlert variant="info">{NO_TRANSFORMS}</InlineAlert>}

      <p className="text-[11px] leading-4 text-muted-foreground">
        Label-value renames (value_actions), label-set match filters (experimental_match_labels), and submatch_case are
        available in the YAML editor.
      </p>
    </div>
  );
}

/** A transform's card, under its `ItemScope` (the item's own, or the held card's). */
function TransformCard({
  index,
  expanded,
  onToggle,
  onRemove,
  isHeld,
}: {
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  isHeld: boolean;
}) {
  const form = useForm();
  const adjustments = useAdjustments();
  const showable = form.read([]).kind === "map";
  const include = textOf(form.read(["include"]));
  const actionView = form.read(["action"]);
  const action = textOf(actionView);

  const setAction = (next: string) => {
    const changes: ValueChange[] = [{ path: ["action"], value: next }];
    // Each message names the key it set: a later change to it in a held card drops it.
    const messages: Notice[] = [];
    if (next === "combine" && form.read(["aggregation_type"]).kind === "absent") {
      changes.push({ path: ["aggregation_type"], value: "sum" });
      messages.push({ message: COMBINE_SUM, adjusted: [["aggregation_type"]] });
    }
    if (next === "group" && form.read(["group_resource_labels"]).kind === "absent") {
      changes.push({ path: ["group_resource_labels"], value: {} });
      messages.push({ message: GROUP_LABELS, adjusted: [["group_resource_labels"]] });
    }
    const result = form.apply(changes);
    if (messages.length > 0) adjustments.note(messages, result);
  };

  return (
    <>
      <div className="flex items-center justify-between p-2.5 bg-muted/50 hover:bg-muted">
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "Collapse transform" : "Expand transform"}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium text-sm">
            {action || "(no action)"}
            {include ? `: ${include}` : " (configure metric)"}
          </span>
        </button>
        <Button type="button" variant="ghost" size="sm" aria-label="Remove transform" onClick={onRemove} disabled={form.disabled}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {expanded && (
        <div className="p-2.5 space-y-2">
          {!showable ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  path={["include"]}
                  id={`transform-${index}-include`}
                  label="Metric (include)"
                  placeholder="e.g. system.cpu.usage"
                  keepEmpty
                />

                <SelectField
                  path={["match_type"]}
                  id={`transform-${index}-match-type`}
                  label="Match Type"
                  defaultValue="strict"
                  options={MATCH_TYPES}
                />
              </div>

              <div className="space-y-1.5">
                <SelectField
                  path={["action"]}
                  id={`transform-${index}-action`}
                  label="Action"
                  placeholder="Select action"
                  description="update edits in place, insert edits a copy, combine merges all matches into one new metric (removing the originals)."
                  options={ACTIONS}
                  onSelect={setAction}
                />
                {actionView.kind === "absent" && <p className="text-[11px] leading-4 text-muted-foreground">{ACTION_REQUIRED}</p>}
              </div>

              <TextField
                path={["new_name"]}
                id={`transform-${index}-new-name`}
                label="New Name"
                description={action === "insert" || action === "combine" ? NEW_NAME_REQUIRED : "Optional rename of the matched metric."}
                placeholder="e.g. system.cpu.usage_time"
              />

              {action === "combine" && (
                <SelectField
                  path={["aggregation_type"]}
                  id={`transform-${index}-aggregation-type`}
                  label="Aggregation Type"
                  description="How combined data points are aggregated. Required for combine."
                  placeholder="Select aggregation"
                  options={AGGREGATION_TYPES}
                />
              )}

              <TransformOperations transformIndex={index} transformHeld={isHeld} />
            </>
          )}
        </div>
      )}
    </>
  );
}

/** A transform's operations, under the transform's item. */
function TransformOperations({ transformIndex, transformHeld }: { transformIndex: number; transformHeld: boolean }) {
  const form = useForm();
  const view = form.read(["operations"]);
  const showable = view.kind === "list" || view.kind === "absent";
  const operations = view.kind === "list" ? view.value : [];
  const cards = useCardKeys(operations);
  const held = useHeldItem(["operations"], { cards, ready: operationReady });

  const removeOperation = (index: number) => {
    // A field's typing goes first: written after the removal, it would bring the list back.
    flushHeldEdits();
    // The last operation takes the key with it.
    const path = operations.length === 1 ? ["operations"] : ["operations", index];
    if (form.remove(path) === "written") cards.remove(index);
  };

  const keys = held.held ? [...cards.keys, cards.next] : cards.keys;

  return (
    <ConfigField label="Operations" description="Applied in order to the metric produced by the action above.">
      <div className="space-y-2">
        {!showable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
        {keys.map((key, index) => {
          const isHeld = held.held && index === operations.length;
          return (
            <div key={key} className="border border-border rounded-md p-2.5 space-y-2">
              <ItemScope listPath={["operations"]} index={index} held={isHeld ? held : undefined} seed={OPERATION_SEED}>
                <OperationFields
                  id={`t${transformIndex}-op${index}`}
                  onRemove={() => (isHeld ? held.drop() : removeOperation(index))}
                />
              </ItemScope>
            </div>
          );
        })}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => held.hold()}
          className="w-full"
          disabled={form.disabled || !showable || held.held || transformHeld}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Operation
        </Button>
      </div>
    </ConfigField>
  );
}

/** An operation's fields, under its item; `id` is its fixed prefix (`t0-op1`). */
function OperationFields({ id, onRemove }: { id: string; onRemove: () => void }) {
  const form = useForm();
  const item = form.read([]);
  const action = textOf(form.read(["action"]));

  // An action change rebuilds the operation as `{action}`: the action set and every other key removed, in place.
  const changeAction = (next: string) => {
    const others = item.kind === "map" ? Object.keys(item.value).filter((key) => key !== "action") : [];
    form.apply([{ path: ["action"], value: next }, ...others.map((key) => ({ path: [key], remove: true as const }))]);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        {item.kind === "map" ? (
          <div className="flex-1 min-w-0">
            <BareSelectField
              path={["action"]}
              id={`${id}-action`}
              ariaLabel="Operation action"
              options={OPERATION_ACTIONS}
              onSelect={changeAction}
            />
          </div>
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        )}
        <Button type="button" variant="ghost" size="sm" aria-label="Remove operation" onClick={onRemove} disabled={form.disabled}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {(action === "update_label" || action === "delete_label_value" || action === "aggregate_label_values") && (
        <TextField path={["label"]} id={`${id}-label`} label="Label" placeholder="e.g. state" keepEmpty />
      )}

      {(action === "add_label" || action === "update_label") && (
        <TextField
          path={["new_label"]}
          id={`${id}-new-label`}
          label="New Label"
          description={action === "add_label" ? "Name of the label to add." : "Renamed label key."}
          placeholder="e.g. cpu_state"
          keepEmpty
        />
      )}

      {(action === "add_label" || action === "aggregate_label_values") && (
        <TextField
          path={["new_value"]}
          id={`${id}-new-value`}
          label="New Value"
          description={action === "add_label" ? "Value set on every data point." : "Label value the aggregated points collapse into."}
          placeholder={action === "add_label" ? "e.g. 1" : "e.g. used"}
          keepEmpty
        />
      )}

      {action === "delete_label_value" && (
        <TextField
          path={["label_value"]}
          id={`${id}-label-value`}
          label="Label Value"
          description="Data points with this value are deleted."
          placeholder="e.g. idle"
          keepEmpty
        />
      )}

      {action === "experimental_scale_value" && (
        <NumberField
          path={["experimental_scale"]}
          id={`${id}-scale`}
          label="Scale Factor"
          description="Values are multiplied by this scalar (e.g. 1000 for s → ms)."
          placeholder="e.g. 1000"
        />
      )}

      {action === "aggregate_labels" && (
        <StringListField
          path={["label_set"]}
          label="Label Set"
          description="Labels kept after aggregation; points matching on these labels are merged."
          placeholder="e.g. state"
        />
      )}

      {action === "aggregate_label_values" && (
        <StringListField
          path={["aggregated_values"]}
          label="Aggregated Values"
          description="Label values merged into the new value above."
          placeholder="e.g. user"
        />
      )}

      {(action === "aggregate_labels" || action === "aggregate_label_values") && (
        <SelectField
          path={["aggregation_type"]}
          id={`${id}-aggregation-type`}
          label="Aggregation Type"
          placeholder="Select aggregation"
          options={AGGREGATION_TYPES}
        />
      )}
    </>
  );
}
