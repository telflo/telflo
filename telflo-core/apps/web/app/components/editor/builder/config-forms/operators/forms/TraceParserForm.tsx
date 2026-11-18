import { ConfigField } from "../../ConfigField.js";
import { UNSHOWABLE_VALUE_MESSAGE, useForm } from "../../form-context.js";
import { presenceOf } from "../../shared/section-toggle.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";

/*
 * The `trace_parser` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2, 4 and 8). Ids are the card's (`op-<index>-trace-id-…`,
 * `op-<index>-span-id-…`).
 *
 * Kept (Parity Notes): ticking "Parse Trace ID" writes
 * `trace_id: {parse_from: attributes.trace_id}`, unticking removes
 * `trace_id`; "Parse Span ID" likewise with `span_id`.
 * Changed:
 * - Under each box, the hint "Off: the collector still reads
 *   body.trace_id." / "…body.span_id." (decision 4): unticked, the block is
 *   gone, and the collector then reads `body.trace_id` and `body.span_id`
 *   (`helper/trace.go:59-83`; a missing field is skipped, `:86-90`).
 * - Each box is ticked while its block is in the text (never a local copy
 *   set once from the config); a block the box can't show (not
 *   a mapping) makes it read-only, with decision 3's hint.
 * - A block without `parse_from` shows the collector's default,
 *   `body.trace_id` or `body.span_id` (`trace.go:64-73`), as FieldSelector's
 *   placeholder and the hint's "Default …" (D9b decision 3; never an empty
 *   path).
 */

/** Under "Parse Trace ID" (decision 4, Appearance). */
export const TRACE_ID_OFF_HINT = "Off: the collector still reads body.trace_id.";
/** Under "Parse Span ID" (decision 4, Appearance). */
export const SPAN_ID_OFF_HINT = "Off: the collector still reads body.span_id.";

function IdBlock({
  keyName,
  idPart,
  label,
  offHint,
  fromDescription,
}: {
  keyName: "trace_id" | "span_id";
  idPart: "trace-id" | "span-id";
  label: string;
  offHint: string;
  fromDescription: string;
}) {
  const form = useForm();
  const opId = useOperatorId();
  const state = presenceOf(form.read([keyName]));
  const enableId = opId(`${idPart}-enable`);
  const fromId = opId(`${idPart}-from`);
  const collectorDefault = `body.${keyName}`;

  return (
    <div className="space-y-3 p-3 bg-muted/50 rounded-md border border-border">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Checkbox
            id={enableId}
            checked={state !== "off"}
            onCheckedChange={(checked) => {
              if ((checked === true) === (state !== "off")) return;
              if (checked === true) form.set([keyName], { parse_from: `attributes.${keyName}` });
              else form.remove([keyName]);
            }}
            disabled={form.disabled || state === "unshowable"}
          />
          <Label htmlFor={enableId} className="text-sm font-medium">
            {label}
          </Label>
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">{offHint}</p>
        {state === "unshowable" && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </div>

      {state === "on" && (
        <ConfigField label="Parse From" description={fromDescription} defaultValue={collectorDefault} htmlFor={fromId}>
          <FieldSelector path={[keyName, "parse_from"]} id={fromId} defaultValue={collectorDefault} />
        </ConfigField>
      )}
    </div>
  );
}

export function TraceParserForm() {
  return (
    <div className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Extract trace context (<span className="font-mono">trace_id</span> and <span className="font-mono">span_id</span>) from log
          entries to correlate logs with distributed traces.
        </p>
      </div>

      {/* Trace ID */}
      <IdBlock
        keyName="trace_id"
        idPart="trace-id"
        label="Parse Trace ID"
        offHint={TRACE_ID_OFF_HINT}
        fromDescription="Field containing the trace ID (32 hex chars)."
      />

      {/* Span ID */}
      <IdBlock
        keyName="span_id"
        idPart="span-id"
        label="Parse Span ID"
        offHint={SPAN_ID_OFF_HINT}
        fromDescription="Field containing the span ID (16 hex chars)."
      />
    </div>
  );
}
