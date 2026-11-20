import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { UNSHOWABLE_VALUE_MESSAGE, useForm, type FormSource } from "../form-context.js";
import { useCardKeys } from "./card-keys.js";
import { listShape } from "./held-item.js";
import { Button } from "~/components/ui/button.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { readTextModel } from "~/lib/graph/model.js";
import { connectorPipelineOptions } from "~/lib/graph/routing-connector.js";
import { splitKey, type ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * A pipeline multi-select, over a list path in the form: each row a select
 * over the canvas's pipelines, so a target can't be mistyped. Routing's Target
 * Pipelines and Default Pipelines, and failover's levels.
 *
 * - Choosing writes the row's item; for a routing or failover connector the
 *   store wires the pipeline's receivers in the same write. Remove removes
 *   the item by its lines (with `emptyRemovesKey`, the last one takes the
 *   key with it; with `keepLast`, the last one's Remove is disabled with
 *   the form's hint).
 * - Rows are keyed by their items (`useCardKeys`), never by position, so a
 *   Remove click can't land on the next item's row.
 * - A row offers the eligible pipelines (`options`, less `exclude`) that the
 *   list's other rows don't hold, and its own value.
 * - A row's own value that is on the canvas but not eligible (a source,
 *   another signal) is shown as written; only a name not on the canvas is
 *   "(not found)", not every value outside the options.
 * - Add holds a row, written when a pipeline is chosen (never `""`); the
 *   held row goes when it is removed, when its list's length changes or it
 *   stops being a list (another row added or removed, by the form, an undo
 *   or the YAML box), or with the form; another row chosen anew, a write
 *   elsewhere and their undos keep it. Add is disabled while there is a
 *   held or empty row, or nothing left to choose, with a no-options hint.
 * - Privacy: an option's `value` is an index token into the canvas's
 *   pipelines (`pipeline-<i>`, the same in every row and render), or
 *   `not-found`; ids are the field's `id` with the row's index. Names are
 *   text only.
 * - A list it can't show (not a list, an item that isn't one line of
 *   scalar) is read-only with the unshowable-value hint.
 */

/** The value of the option showing a name that isn't on the canvas. */
export const NOT_FOUND_OPTION = "not-found";

const NO_OPTIONS_HINT = "No eligible pipelines yet — add a pipeline of the connector's signal type to the canvas first.";

export interface PipelineListFieldProps {
  /** The list's path under the form. */
  path: ValuePath;
  /** Fixed by the form: the label's id, and with a row's index, its select's. */
  id: string;
  /** The pipelines a row may choose (`connectorPipelineOptions`), in order. */
  options: readonly { name: string }[];
  label: string;
  helpText?: string;
  addButtonText?: string;
  /** Removing the last item removes the key rather than leaving `[]`. */
  emptyRemovesKey?: boolean;
  /** Names no row may choose (failover's pipelines claimed by another level); a row's own stays shown. */
  exclude?: readonly string[];
  /**
   * The list keeps its last item (a route's targets, a failover level): its
   * Remove is disabled and this hint shown under it.
   */
  keepLast?: string;
}

/**
 * The pipelines a routing or failover form's pickers offer:
 * `connectorPipelineOptions` over the text's model, for the component whose
 * source `form` is (its `componentKey`). Without one, every canvas pipeline.
 */
export function useConnectorPipelineOptions(form: FormSource): readonly { name: string }[] {
  const document = useEditorStore((state) => state.document);
  const pipelines = useEditorStore((state) => state.graph.pipelines);
  const connector = form.componentKey === undefined ? undefined : splitKey(form.componentKey)[1];
  return useMemo(
    () => (document === null || connector === undefined ? pipelines : connectorPipelineOptions(readTextModel(document), pipelines, connector)),
    [document, pipelines, connector],
  );
}

/** An item's characters, or null when a row can't show it. */
function itemText(view: ValueView): string | null {
  if (view.kind !== "scalar") return null;
  const text = view.source ?? String(view.value);
  return /[\r\n]/.test(text) ? null : text;
}

export function PipelineListField({
  path,
  id,
  options,
  label,
  helpText,
  addButtonText = "Add Pipeline",
  emptyRemovesKey = false,
  exclude = [],
  keepLast,
}: PipelineListFieldProps) {
  const form = useForm();
  const canvas = useEditorStore((state) => state.graph.pipelines);
  const view = form.read(path);
  const items = view.kind === "absent" ? [] : view.kind === "list" ? view.value.map((_item, index) => itemText(form.read([...path, index]))) : null;
  const values = items?.every((item): item is string => item !== null) ? items : null;
  const cards = useCardKeys(values ?? []);
  /** The list's length when Add held a row (`listShape`): the row shows while the list keeps it. */
  const [heldFor, setHeldFor] = useState<number | null>(null);
  const list = listShape(view);
  if (heldFor !== null && heldFor !== list) setHeldFor(null);

  const labelId = `${id}-label`;
  if (values === null) {
    return (
      <div className="space-y-2">
        <Label id={labelId} className="text-[13px] font-medium text-foreground">
          {label}
        </Label>
        <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
      </div>
    );
  }

  const holding = heldFor === list;
  const excluded = new Set(exclude);
  const onCanvas = new Set(canvas.map((pipeline) => pipeline.name));
  const eligible = options.map((option) => option.name).filter((name) => onCanvas.has(name) && !excluded.has(name));
  const unselected = eligible.filter((name) => !values.includes(name));
  const hasEmptyRow = holding || values.some((value) => !value.trim());
  // The last written item stays (a held row's Remove is its own, and stays enabled).
  const keepsLast = keepLast !== undefined && values.length === 1;
  const tokenOf = (name: string) => {
    const index = canvas.findIndex((pipeline) => pipeline.name === name);
    return index === -1 ? NOT_FOUND_OPTION : `pipeline-${index}`;
  };
  const nameOf = (token: string) => {
    const match = /^pipeline-(\d+)$/.exec(token);
    return match ? canvas[Number(match[1])]?.name : undefined;
  };

  const choose = (index: number, token: string) => {
    const name = nameOf(token);
    if (name === undefined || name === values[index]) return;
    if (form.set([...path, index], name) !== "refused" && index === values.length) setHeldFor(null);
  };
  const remove = (index: number) => {
    if (index === values.length) {
      // The held row goes, unwritten.
      setHeldFor(null);
      return;
    }
    if (form.remove(emptyRemovesKey && values.length === 1 ? path : [...path, index]) === "written") cards.remove(index);
  };

  const rows = holding ? [...values, ""] : values;
  const keys = holding ? [...cards.keys, cards.next] : cards.keys;
  return (
    <div className="space-y-2">
      <Label id={labelId} className="text-[13px] font-medium text-foreground">
        {label}
      </Label>

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((value, index) => {
            // Each row offers the pipelines not claimed by the other rows,
            // plus its own current value (also when it isn't eligible or is
            // stale, so it can be seen and replaced instead of vanishing).
            const rowOptions = eligible.filter((name) => name === value || !values.includes(name));
            const own = value.trim() !== "" && !rowOptions.includes(value);
            const isStale = own && tokenOf(value) === NOT_FOUND_OPTION;
            return (
              <div key={keys[index]} className="flex gap-2">
                <Select
                  value={value.trim() === "" ? "" : tokenOf(value)}
                  onValueChange={(token) => choose(index, token)}
                  disabled={form.disabled}
                >
                  <SelectTrigger
                    id={`${id}-${index}`}
                    aria-labelledby={labelId}
                    className={`flex-1 font-mono text-xs ${isStale ? "text-fail" : ""}`}
                  >
                    <SelectValue placeholder="Select pipeline" />
                  </SelectTrigger>
                  <SelectContent>
                    {own && (
                      <SelectItem value={tokenOf(value)} className="font-mono text-xs">
                        {isStale ? `${value} (not found)` : value}
                      </SelectItem>
                    )}
                    {rowOptions.map((name) => (
                      <SelectItem key={tokenOf(name)} value={tokenOf(name)} className="font-mono text-xs">
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Remove pipeline"
                  onClick={() => remove(index)}
                  disabled={form.disabled || (keepsLast && index === 0)}
                  className="shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setHeldFor(list)}
        disabled={form.disabled || hasEmptyRow || unselected.length === 0}
        className="w-full"
      >
        <Plus className="h-4 w-4 mr-2" />
        {addButtonText}
      </Button>

      {keepsLast && <p className="text-[11px] leading-4 text-muted-foreground">{keepLast}</p>}

      {options.length === 0 && <p className="text-[11px] leading-4 text-muted-foreground">{NO_OPTIONS_HINT}</p>}

      {helpText && <p className="text-[11px] leading-4 text-muted-foreground">{helpText}</p>}
    </div>
  );
}
