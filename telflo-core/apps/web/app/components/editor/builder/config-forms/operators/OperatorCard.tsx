import { ChevronDown, ChevronRight, FileText, GripVertical, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { SelectField, TextField, useForm } from "../form-context.js";
import { OPERATOR_FORMS } from "./forms/index.js";
import { operatorMeta, type OperatorMeta } from "./operator-catalog.js";
import { OperatorIdProvider, useOperatorId } from "./operator-ids.js";
import { Button } from "~/components/ui/button.js";
import { SortableHandle, type DragHandleProps } from "~/components/ui/sortable/index.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The operator card (ADR 0018): one operator of a receiver's `operators`
 * list, over the form (D9c decision 8). The card sits under its
 * item's scope (`FormScope` at `operators.<index>`, given by the pipeline),
 * so its fields write the operator's own keys, and keys no field shows
 * (`output`, `body`, …) stay.
 *
 * - The header: the drag handle (the shared `SortableHandle`), the card's
 *   number, the type chip (the catalog's icon and label), `id: <id>` as
 *   text when set, expand/collapse and delete. Cards start expanded; the
 *   expanded state is the card's own, and the card is keyed by its item
 *   (`useCardKeys`), so it follows the card when it moves and after an undo
 *   (Preflight ruling 25; D9c Ruling 35), not the position.
 * - The common fields: Operator ID, On Error, Condition (if). Then the
 *   type's form (`OPERATOR_FORMS`, Tasks 6 and 7), when it has one.
 * - Every id is the card's: `op-<index>-<field>` (decision 8; the type forms
 *   take theirs from `useOperatorId`).
 *
 * Fixed:
 * - On Error offers the collector's four values, `send`, `send_quiet`,
 *   `drop`, `drop_quiet` (`helper/transformer.go:43-51, 214-224`), as "Send
 *   (continue)", "Send quietly (continue, debug log)", "Drop entry", "Drop
 *   quietly (debug log)" (decisions 3 and 6; the quiet modes log at debug,
 *   `:142-173`); never `silent`, which the collector refuses.
 *   Unset shows the collector's `send` (`:25`) as its placeholder and
 *   "Default send" (D9b decision 3; Ruling 31); a value outside the four
 *   shows as an extra option.
 * - A router shows neither On Error nor Condition (decision 4): a router is
 *   a `BasicConfig` (`transformer/router/config.go:34-38`), and the
 *   collector ignores both keys there (`operator/config.go:111`).
 * - The Operator ID's placeholder is the operator's type when it is one of
 *   the catalog's 26, a fixed name, else "Operator ID" (Preflight ruling 9;
 *   never the type as written in the attribute).
 * - An item the catalog doesn't know (Preflight ruling 20): a mapping with
 *   another `type` shows its common fields and "Unknown operator type"
 *   (the default case); an item that isn't a mapping shows its
 *   number and "Unknown operator type", no fields. Both can be removed and
 *   moved. The chip shows a type the catalog doesn't know as written, in
 *   text (the fallback label), and no chip for an item without one.
 * - The collapse and delete buttons are `type="button"` with fixed labels
 *   ("Collapse operator"/"Expand operator", with `aria-expanded`; "Remove
 *   operator").
 */

/** The operator's `type` as the card reads it. */
export interface OperatorItem {
  /** The item is a mapping (an operator), not a scalar or a list. */
  mapping: boolean;
  /** The catalog's entry for its `type`, if it is one of the 26. */
  meta: OperatorMeta | undefined;
  /** Its `type` as written, when it is a string. */
  type: string | undefined;
  /** Its `id` as written, when it is a scalar. */
  id: string | undefined;
}

function scalarText(view: ValueView): string | undefined {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : undefined;
}

/** The item under the form's scope, as the card reads it. */
export function useOperatorItem(): OperatorItem {
  const form = useForm();
  const mapping = form.read([]).kind === "map";
  const typeView = mapping ? form.read(["type"]) : undefined;
  const type = typeView?.kind === "scalar" && typeof typeView.value === "string" ? typeView.value : undefined;
  return {
    mapping,
    meta: operatorMeta(type),
    type,
    id: mapping ? scalarText(form.read(["id"])) : undefined,
  };
}

const ON_ERROR_OPTIONS = [
  { value: "send", label: "Send (continue)" },
  { value: "send_quiet", label: "Send quietly (continue, debug log)" },
  { value: "drop", label: "Drop entry" },
  { value: "drop_quiet", label: "Drop quietly (debug log)" },
] as const;

export const UNKNOWN_OPERATOR_TYPE = "Unknown operator type";

/**
 * The header's contents: the grip, number, type chip and `id:`, then
 * the controls. The drag overlay draws it alone (Preflight ruling 25), with a
 * still grip and no controls, so no field's id is drawn twice.
 */
export function OperatorCardHeader({ index, item, handle, controls }: { index: number; item: OperatorItem; handle: ReactNode; controls?: ReactNode }) {
  const Icon = item.meta?.icon ?? FileText;
  const chip = item.meta?.label ?? item.type;
  return (
    <div className="flex items-center gap-2 p-3 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800 rounded-t-lg">
      {handle}
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 w-5">{index + 1}.</span>
      {chip !== undefined && (
        <div className="flex items-center gap-1 rounded-[4px] border border-border px-1.5 py-px font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
          <Icon className="w-3 h-3" />
          <span>{chip}</span>
        </div>
      )}
      {item.id !== undefined && item.id !== "" && <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">id: {item.id}</span>}
      <div className="flex-1" />
      {controls}
    </div>
  );
}

/** The overlay's still grip, as the handle draws it. */
export function StillGrip() {
  return (
    <span className="text-gray-400">
      <GripVertical className="w-4 h-4" />
    </span>
  );
}

export function OperatorCard({
  index,
  isDragging,
  dragHandleProps,
  onRemove,
}: {
  index: number;
  isDragging: boolean;
  dragHandleProps: DragHandleProps;
  onRemove: () => void;
}) {
  const form = useForm();
  const item = useOperatorItem();
  const [expanded, setExpanded] = useState(true);
  const TypeForm = item.meta ? OPERATOR_FORMS[item.meta.type] : undefined;
  const isRouter = item.meta?.type === "router";

  return (
    <div className={`border border-border rounded-lg bg-card ${isDragging ? "shadow-lg ring-2 ring-brand" : ""}`}>
      <OperatorCardHeader
        index={index}
        item={item}
        handle={<SortableHandle {...dragHandleProps} disabled={form.disabled} />}
        controls={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              className="h-7 w-7 p-0"
              aria-label={expanded ? "Collapse operator" : "Expand operator"}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              className="h-7 w-7 p-0 text-fail hover:text-fail hover:bg-fail-soft"
              aria-label="Remove operator"
              disabled={form.disabled}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </>
        }
      />

      {expanded && (
        <OperatorIdProvider index={index}>
          <div className="p-4 space-y-4">
            {item.mapping ? (
              <>
                <CommonFields placeholder={item.meta?.type ?? "Operator ID"} isRouter={isRouter} />
                {item.meta === undefined ? (
                  <div className="border-t pt-4">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{UNKNOWN_OPERATOR_TYPE}</p>
                  </div>
                ) : (
                  TypeForm && (
                    <div className="border-t pt-4">
                      <TypeForm />
                    </div>
                  )
                )}
              </>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">{UNKNOWN_OPERATOR_TYPE}</p>
            )}
          </div>
        </OperatorIdProvider>
      )}
    </div>
  );
}

/** Operator ID, On Error and Condition (if), under the card's scope. */
function CommonFields({ placeholder, isRouter }: { placeholder: string; isRouter: boolean }) {
  const opId = useOperatorId();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          path={["id"]}
          id={opId("id")}
          label="Operator ID"
          description="Custom identifier."
          placeholder={placeholder}
          className="font-mono text-xs"
        />
        {!isRouter && (
          <SelectField
            path={["on_error"]}
            id={opId("on-error")}
            label="On Error"
            description="Error handling behavior."
            defaultValue="send"
            options={ON_ERROR_OPTIONS}
          />
        )}
      </div>

      {!isRouter && (
        <TextField
          path={["if"]}
          id={opId("if")}
          label="Condition (if)"
          description="Only apply this operator when condition is true."
          placeholder='e.g., body contains "error"'
          className="font-mono text-xs"
        />
      )}
    </>
  );
}
