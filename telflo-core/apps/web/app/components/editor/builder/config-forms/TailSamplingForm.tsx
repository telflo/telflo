import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  CheckboxSetField,
  DurationField,
  FormScope,
  NumberField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { ListTextField } from "./shared/ListTextField.js";
import { NativeSelectField } from "./shared/NativeSelectField.js";
import { Button } from "~/components/ui/button.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The tail sampling processor's form, over the form's fields. Collector
 * claims are contrib v0.162.0's `processor/tailsamplingprocessor`.
 *
 * - The policies are a sortable list of cards. Dragging a card moves the
 *   policy's own lines, its comments with it (`form.move`); a card's
 *   expanded state follows the card (`useCardKeys`), not the index. The
 *   first card starts expanded, and Add Policy expands the new one. Each
 *   card's fields write their own key under `policies.<index>`
 *   (`FormScope`), so keys the form doesn't show (`hash_salt`,
 *   `burst_capacity`, `enabled_regex_matching`, `policy_order`, an
 *   extension's config) stay. Ids are by card index (`policy-0-name`,
 *   sortable `policy-0`), never a value; the expand button is "Collapse
 *   policy" / "Expand policy".
 * - The card's header shows the policy's name and a summary as
 *   text, read from the text: a missing block or key reads as the Go zero
 *   the collector decodes (`0% sampling`), never a throw. OTTL's count is its
 *   span and span event conditions.
 * - Changed: Policy Type offers the collector's 17 types
 *   (`config.go:20-58`): the first 13, then NOT, Drop, Bytes Limiting and
 *   Trace Flags. A type outside them (a sampling-policy extension's,
 *   `processor.go:431-440`) shows as written. Choosing a type is one change:
 *   `type` set, every known type block removed, the new type's seed written;
 *   the item's other lines, comments and keys stay. No toast: the old block
 *   goes silently.
 * - Fixed: OTTL Condition seeds a condition,
 *   `span: ['span.attributes["http.status_code"] >= 400']` (`span: []` is
 *   refused, `internal/sampling/ottl.go:39-41`); NOT, Drop and Bytes
 *   Limiting seed a policy the collector builds; composite's seed drops
 *   `policy_order` (declared, never read, `config.go:157`). Add Policy names
 *   the first `policy-N` (from the length + 1) no policy has
 *   (`processor.go:248-250` refuses a duplicate).
 * - Fixed: Spans Per Second writes its key only (never rebuilding
 *   `rate_limiting`, dropping `burst_capacity`); the "One per line" textareas
 *   take a typed line break (`ListTextField`, newline).
 * - Changed: Policy Order is dropped (`config.go:157`; a key in the text
 *   stays). The numeric bounds say 0 is no bound (`processor.go:387-395`)
 *   and, with neither, ask for one
 *   (`internal/sampling/numeric_tag_filter.go:31-34` builds no evaluator).
 *   AND and Drop with no sub-policies say what they do (`and.go`, `drop.go`:
 *   the loop over none samples, or drops, every trace). The Policies alert
 *   says drop policies run first (`processor.go:279-280`). Error Mode adds
 *   `silent` (`pkg/ottl/config.go:16-31`); unset is blank, as the collector
 *   runs it: errors skipped without a log (`pkg/ottl/parser.go:543-560`).
 * - Changed: Decision Wait, Traces in Memory, Expected New Traces and the
 *   cache sizes show their defaults as placeholders (`factory.go:29-37`),
 *   never as written values. Expected Value unset shows false, the Go zero,
 *   "Default false".
 * - Sub-policies stay YAML-only: NOT, Drop and Bytes Limiting get
 *   "Configure <type> in the YAML editor"; Trace Flags has nothing to
 *   configure (`processor.go:430-431`).
 */

/** The collector's policy types (`config.go:20-58`), as Policy Type offers them. */
const POLICY_TYPES = [
  { value: "always_sample", label: "Always Sample" },
  { value: "probabilistic", label: "Probabilistic" },
  { value: "status_code", label: "Status Code" },
  { value: "latency", label: "Latency" },
  { value: "string_attribute", label: "String Attribute" },
  { value: "numeric_attribute", label: "Numeric Attribute" },
  { value: "boolean_attribute", label: "Boolean Attribute" },
  { value: "trace_state", label: "Trace State" },
  { value: "span_count", label: "Span Count" },
  { value: "ottl_condition", label: "OTTL Condition" },
  { value: "rate_limiting", label: "Rate Limiting" },
  { value: "and", label: "AND" },
  { value: "composite", label: "Composite" },
  { value: "not", label: "NOT" },
  { value: "drop", label: "Drop" },
  { value: "bytes_limiting", label: "Bytes Limiting" },
  { value: "trace_flags", label: "Trace Flags" },
] as const;

/** Every known type's block key: the type switch removes each but the new type's. */
export const POLICY_TYPE_KEYS: readonly string[] = POLICY_TYPES.map((type) => type.value);

const STATUS_CODES = ["OK", "ERROR", "UNSET"].map((code) => ({
  value: code,
  label: code,
}));

const ERROR_MODES = [
  { value: "ignore", label: "Ignore errors" },
  { value: "silent", label: "Ignore errors silently" },
  { value: "propagate", label: "Propagate errors" },
] as const;

const BOOLEANS = [
  { value: "true", label: "true" },
  { value: "false", label: "false" },
] as const;

export const POLICIES_INFO = "A trace is sampled if any policy matches, unless a drop policy matches first. Policies evaluate in order.";
export const AND_EMPTY_HINT = "With no sub-policies, this policy samples every trace.";
export const DROP_EMPTY_HINT = "With no sub-policies, this policy drops every trace.";
export const NO_MINIMUM_HINT = "0 or empty: no minimum.";
export const NO_MAXIMUM_HINT = "0 or empty: no maximum.";
export const BOUNDS_HINT = "Set a minimum or a maximum.";
export const ERROR_MODE_UNSET_HINT = "Unset: errors are skipped without a log.";

/**
 * The block a type switch writes for `type`, for a policy named `name`
 * (the seeds for the first 13, composite's without `policy_order`; the
 * spec's for OTTL and the four new types); undefined for a type with no
 * block (`always_sample`, `trace_flags`) or one the form doesn't know.
 */
export function policySeed(type: string, name: string): Record<string, unknown> | undefined {
  switch (type) {
    case "probabilistic":
      return { sampling_percentage: 10 };
    case "status_code":
      return { status_codes: ["ERROR"] };
    case "latency":
      return { threshold_ms: 1000 };
    case "string_attribute":
      return { key: "service.name", values: [] };
    case "rate_limiting":
      return { spans_per_second: 1000 };
    case "numeric_attribute":
      return { key: "", min_value: 0, max_value: 100 };
    case "boolean_attribute":
      return { key: "", value: true };
    case "trace_state":
      return { key: "", values: [] };
    case "span_count":
      return { min_spans: 1 };
    case "ottl_condition":
      return {
        error_mode: "ignore",
        span: ['span.attributes["http.status_code"] >= 400'],
      };
    case "and":
      return { and_sub_policy: [] };
    case "composite":
      return {
        max_total_spans_per_second: 1000,
        composite_sub_policy: [],
        rate_allocation: [],
      };
    case "not":
      return {
        not_sub_policy: {
          name: `${name}-not`,
          type: "latency",
          latency: { threshold_ms: 1000 },
        },
      };
    case "drop":
      return {
        drop_sub_policy: [
          {
            name: `${name}-drop`,
            type: "string_attribute",
            string_attribute: {
              key: "url.path",
              values: ["/health", "/metrics"],
            },
          },
        ],
      };
    case "bytes_limiting":
      return { bytes_per_second: 1048576 };
    default:
      return undefined;
  }
}

/**
 * The type switch's changes, under the policy (one change, one undo
 * entry): `type` set, every known type block removed but the new one's,
 * which is set to its seed. Removing a key the policy doesn't have writes
 * nothing; keys that aren't known type blocks stay.
 */
export function typeSwitchChanges(next: string, name: string): ValueChange[] {
  const seed = policySeed(next, name);
  const changes: ValueChange[] = [{ path: ["type"], value: next }];
  for (const key of POLICY_TYPE_KEYS) if (key !== next || seed === undefined) changes.push({ path: [key], remove: true });
  if (seed !== undefined) changes.push({ path: [next], value: seed });
  return changes;
}

/** A scalar's text as written, or "" for anything else. */
function textOf(view: ValueView): string {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : "";
}

/** A number as the summary shows it: as written, or the Go zero the collector decodes while unset. */
function numberOf(view: ValueView): string {
  return view.kind === "absent" ? "0" : textOf(view);
}

/** The first `policy-N` no policy is named, from `policy-<length + 1>` (`processor.go:248-250`). */
export function nextPolicyName(form: FormSource, count: number): string {
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    const name = form.read(["policies", index, "name"]);
    if (name.kind === "scalar") names.add(String(name.value));
  }
  let n = count + 1;
  while (names.has(`policy-${n}`)) n++;
  return `policy-${n}`;
}

/** The card's summary, read from the policy's views (a missing block reads as unset; never a throw). */
function summaryOf(form: FormSource, type: string | null): string {
  const at = (...path: ValuePath) => form.read(path);
  switch (type) {
    case "always_sample":
      return "Always Sample";
    case "probabilistic":
      return `${numberOf(at("probabilistic", "sampling_percentage"))}% sampling`;
    case "status_code": {
      const codes = at("status_code", "status_codes");
      const shown = codes.kind === "list" ? codes.value.map((_c, index) => textOf(at("status_code", "status_codes", index))) : [];
      return `Status: ${shown.join(", ")}`;
    }
    case "latency":
      return `Latency > ${numberOf(at("latency", "threshold_ms"))}ms`;
    case "string_attribute":
      return `${textOf(at("string_attribute", "key"))} in [...]`;
    case "numeric_attribute":
      return `${textOf(at("numeric_attribute", "key"))}: ${numberOf(at("numeric_attribute", "min_value"))}-${numberOf(at("numeric_attribute", "max_value"))}`;
    case "boolean_attribute": {
      const value = at("boolean_attribute", "value");
      return `${textOf(at("boolean_attribute", "key"))} = ${value.kind === "absent" ? "false" : textOf(value)}`;
    }
    case "trace_state":
      return `TraceState ${textOf(at("trace_state", "key"))} in [${listLength(at("trace_state", "values"))} values]`;
    case "span_count": {
      const min = numberOf(at("span_count", "min_spans"));
      const max = at("span_count", "max_spans");
      return isTruthy(max) ? `${min}-${textOf(max)} spans` : `>= ${min} spans`;
    }
    case "ottl_condition":
      return `OTTL: ${listLength(at("ottl_condition", "span")) + listLength(at("ottl_condition", "spanevent"))} conditions`;
    case "rate_limiting":
      return `${numberOf(at("rate_limiting", "spans_per_second"))} spans/sec`;
    case "and":
      return `AND (${listLength(at("and", "and_sub_policy"))} sub-policies)`;
    case "composite":
      return `Composite: ${numberOf(at("composite", "max_total_spans_per_second"))} spans/sec`;
    default:
      return type ?? "";
  }
}

/** The policy's type as written; null while unset or not a scalar. */
function typeOf(form: FormSource): string | null {
  const view = form.read(["type"]);
  return view.kind === "scalar" ? textOf(view) : null;
}

export function TailSamplingForm() {
  const form = useForm();
  const policiesView = form.read(["policies"]);
  const policies = policiesView.kind === "list" ? policiesView.value : [];
  const count = policies.length;
  const cards = useCardKeys(policies);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set([0]));
  const showable = policiesView.kind === "list" || policiesView.kind === "absent";

  const toggle = (key: number) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const addPolicy = () => {
    const seed = {
      name: nextPolicyName(form, count),
      type: "probabilistic",
      probabilistic: { sampling_percentage: 10 },
    };
    const result = policiesView.kind === "list" ? form.set(["policies", count], seed) : form.set(["policies"], [seed]);
    if (result !== "written") return;
    cards.add();
    setExpanded(new Set([...expanded, cards.next]));
  };

  const removePolicy = (index: number) => {
    if (form.remove(["policies", index]) === "written") cards.remove(index);
  };

  const movePolicy = (from: number, to: number) => {
    if (form.move(["policies"], from, to) === "written") cards.move(from, to);
  };

  return (
    <div className="space-y-4">
      <InlineAlert variant="warn" title="Trace affinity required">
        All spans of a trace must reach the same collector instance. Use consistent-hash load balancing or the load-balancing exporter.
      </InlineAlert>

      <DurationField
        path={["decision_wait"]}
        id="decision-wait"
        label="Decision Wait"
        defaultValue="30s"
        description="Buffer spans this long before deciding; longer uses more memory."
        className="font-mono"
      />

      <NumberField
        path={["num_traces"]}
        id="num-traces"
        label="Traces in Memory"
        defaultValue="50000"
        description="Max concurrent traces held; raise with traffic volume."
        className="font-mono"
      />

      <NumberField
        path={["expected_new_traces_per_sec"]}
        id="expected-traces"
        label="Expected New Traces Per Second"
        defaultValue="0 (auto)"
        placeholder="0"
        description="Hint for memory allocation."
        className="font-mono"
      />

      <ConfigSection title="Policies" defaultOpen count={count}>
        <InlineAlert variant="info">{POLICIES_INFO}</InlineAlert>

        {count === 0 && showable && <p className="text-[11px] leading-4 text-muted-foreground">No policies configured</p>}

        {!showable ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <SortableList
            list="policy"
            items={cards.keys}
            onReorder={movePolicy}
            listClassName="space-y-2"
            contextId="tail-sampling-policies"
          >
            {(key, index, id) => (
              <SortableItem key={key} id={id} disabled={form.disabled}>
                {({ isDragging, dragHandleProps }) => (
                  <div
                    className={`rounded-md border border-border bg-card overflow-hidden ${isDragging ? "shadow-lg ring-2 ring-brand" : ""}`}
                  >
                    <FormScope path={["policies", index]}>
                      <PolicyCard
                        index={index}
                        expanded={expanded.has(key)}
                        onToggle={() => toggle(key)}
                        onRemove={() => removePolicy(index)}
                        handle={<SortableHandle {...dragHandleProps} disabled={form.disabled} />}
                      />
                    </FormScope>
                  </div>
                )}
              </SortableItem>
            )}
          </SortableList>
        )}

        <Button type="button" variant="outline" size="sm" onClick={addPolicy} className="w-full" disabled={form.disabled || !showable}>
          <Plus className="h-4 w-4 mr-2" />
          Add Policy
        </Button>
      </ConfigSection>

      <ConfigSection title="Advanced: Cache & Tuning">
        <InlineAlert variant="warn">
          If the same trace gets inconsistent decisions, raise both cache sizes. Monitor{" "}
          <span className="font-mono">otelcol_processor_tailsampling_*</span> metrics to tune.
        </InlineAlert>

        {/* config.go:310-323: 0 (or a block emptied of both) is no cache; an emptied block is removed. */}
        <FormScope path={["decision_cache"]} prune>
          <NumberField
            path={["sampled_cache_size"]}
            id="sampled-cache-size"
            label="Sampled Decision Cache Size"
            defaultValue="0 (disabled)"
            placeholder="0"
            description="'Keep' decisions cached after traces leave memory; ~24 bytes each."
            className="font-mono"
          />

          <NumberField
            path={["non_sampled_cache_size"]}
            id="non-sampled-cache-size"
            label="Non-Sampled Decision Cache Size"
            defaultValue="0 (disabled)"
            placeholder="0"
            description="'Drop' decisions cached; size well above traces in memory."
            className="font-mono"
          />
        </FormScope>

        <CheckboxField
          path={["sample_on_first_match"]}
          id="sample-on-first-match"
          label="Stop on First Match"
          description="Evaluate policies in order and stop at the first match."
          defaultChecked={false}
          rowClassName="flex items-start gap-2.5"
          describedClassName="grid flex-1 gap-1 leading-none"
          labelClassName="cursor-pointer text-sm font-medium"
        />
      </ConfigSection>
    </div>
  );
}

/** A policy's card, under `policies.<index>`. */
function PolicyCard({
  index,
  expanded,
  onToggle,
  onRemove,
  handle,
}: {
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  handle: ReactNode;
}) {
  const form = useForm();
  const showable = form.read([]).kind === "map";
  const type = typeOf(form);
  const name = textOf(form.read(["name"]));

  return (
    <>
      <div className="flex items-center justify-between p-2.5">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {handle}
          <button
            type="button"
            className="flex items-center gap-2 flex-1 min-w-0 hover:bg-accent px-2 py-1 rounded text-left"
            onClick={onToggle}
            aria-label={expanded ? "Collapse policy" : "Expand policy"}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{name}</div>
              <div className="text-xs text-muted-foreground truncate">{summaryOf(form, type)}</div>
            </div>
          </button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove policy"
          onClick={onRemove}
          disabled={form.disabled}
          className="text-fail hover:text-fail hover:bg-fail-soft"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-border p-2.5 space-y-2 bg-muted/50">
          {!showable ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <TextField path={["name"]} id={`policy-${index}-name`} label="Policy Name" keepEmpty className="text-sm" />
                {/* Unset (refused, `processor.go:443`) shows blank, and offers no removal: `unset=""` isn't an option. */}
                <NativeSelectField
                  path={["type"]}
                  id={`policy-${index}-type`}
                  label="Policy Type"
                  options={POLICY_TYPES}
                  unset=""
                  onSelect={(next) => form.apply(typeSwitchChanges(next, name))}
                />
              </div>

              {type !== null && <PolicyFields index={index} type={type} />}
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Types whose fields read and write under their block. */
const BLOCK_FIELDS = new Set([
  "probabilistic",
  "status_code",
  "latency",
  "string_attribute",
  "rate_limiting",
  "numeric_attribute",
  "boolean_attribute",
  "trace_state",
  "span_count",
  "ottl_condition",
  "and",
  "composite",
  "drop",
]);

/** The type's fields, under the policy. */
function PolicyFields({ index, type }: { index: number; type: string }) {
  const form = useForm();
  if (type === "always_sample" || type === "trace_flags") {
    return <p className="text-[11px] leading-4 text-muted-foreground">No additional configuration</p>;
  }
  if (!BLOCK_FIELDS.has(type)) {
    return <p className="text-[11px] leading-4 text-muted-foreground">Configure {type} in the YAML editor</p>;
  }
  const block = form.read([type]);
  if (block.kind !== "map" && block.kind !== "absent") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }
  return (
    <FormScope path={[type]}>
      <TypeFields index={index} type={type} />
    </FormScope>
  );
}

/** A known type's fields, under its block. */
function TypeFields({ index, type }: { index: number; type: string }) {
  const form = useForm();
  const id = (field: string) => `policy-${index}-${field}`;
  const emptyList = (key: string) => {
    const view = form.read([key]);
    return view.kind === "absent" || (view.kind === "list" && view.value.length === 0);
  };

  switch (type) {
    case "probabilistic":
      return (
        <NumberField
          path={["sampling_percentage"]}
          id={id("sampling-percentage")}
          label="Sampling Percentage"
          description="0–100."
          className="font-mono"
        />
      );

    case "status_code":
      return (
        <CheckboxSetField
          path={["status_codes"]}
          id={id("status")}
          label="Status Codes to Sample"
          items={STATUS_CODES}
          className="space-y-2"
          rowClassName="flex items-center gap-2.5"
          labelClassName="cursor-pointer text-sm"
        />
      );

    case "latency":
      return (
        <div className="grid grid-cols-2 gap-2">
          <NumberField path={["threshold_ms"]} id={id("threshold")} label="Threshold (ms)" className="font-mono" />
          <NumberField
            path={["upper_threshold_ms"]}
            id={id("upper-threshold")}
            label="Upper Threshold (ms)"
            placeholder="No upper limit"
            className="font-mono"
          />
        </div>
      );

    case "string_attribute":
      return (
        <div className="space-y-2">
          <TextField path={["key"]} id={id("key")} label="Attribute Key" placeholder="e.g. service.name" className="font-mono text-xs" />
          <ListTextField
            path={["values"]}
            id={id("values")}
            separator={"\n"}
            label="Values"
            description="One per line."
            placeholder={"e.g. frontend\nbackend\napi"}
            rows={3}
            className="font-mono text-xs"
          />
        </div>
      );

    case "rate_limiting":
      return <NumberField path={["spans_per_second"]} id={id("spans-per-second")} label="Spans Per Second" className="font-mono" />;

    case "numeric_attribute": {
      // processor.go:387-395: 0 is no bound; with neither, numeric_tag_filter.go:31-34 builds no evaluator.
      const unbounded = (key: string) => {
        const view = form.read([key]);
        return view.kind === "absent" || (view.kind === "scalar" && view.value === 0);
      };
      return (
        <div className="space-y-2">
          <TextField
            path={["key"]}
            id={id("key")}
            label="Attribute Key"
            placeholder="e.g. http.status_code"
            className="font-mono text-xs"
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              path={["min_value"]}
              id={id("min-value")}
              label="Minimum Value"
              description={NO_MINIMUM_HINT}
              className="font-mono"
            />
            <NumberField
              path={["max_value"]}
              id={id("max-value")}
              label="Maximum Value"
              description={NO_MAXIMUM_HINT}
              className="font-mono"
            />
          </div>
          {unbounded("min_value") && unbounded("max_value") && <p className="text-[11px] leading-4 text-muted-foreground">{BOUNDS_HINT}</p>}
          <CheckboxField
            path={["invert_match"]}
            id={id("invert-match")}
            label="Invert Match"
            description="Sample traces where the value falls outside the range."
            defaultChecked={false}
            rowClassName="flex items-start gap-2.5"
            describedClassName="grid flex-1 gap-1 leading-none"
            labelClassName="cursor-pointer text-sm font-medium"
          />
        </div>
      );
    }

    case "boolean_attribute":
      return (
        <div className="grid grid-cols-2 gap-2">
          <TextField path={["key"]} id={id("key")} label="Attribute Key" placeholder="e.g. error" className="font-mono text-xs" />
          {/* Written as a boolean; unset is the Go zero, false (config.go:288-298). */}
          <NativeSelectField
            path={["value"]}
            id={id("value")}
            label="Expected Value"
            defaultValue="false"
            options={BOOLEANS}
            unset="false"
            onSelect={(next) => form.set(["value"], next === "true")}
          />
        </div>
      );

    case "trace_state":
      return (
        <div className="space-y-2">
          <TextField
            path={["key"]}
            id={id("key")}
            label="Trace State Key"
            description="Key in the W3C tracestate header."
            placeholder="e.g. tenant"
            className="font-mono text-xs"
          />
          <ListTextField
            path={["values"]}
            id={id("values")}
            separator={"\n"}
            label="Values"
            description="One per line."
            placeholder={"e.g. premium\nenterprise\nvip"}
            rows={3}
            className="font-mono text-xs"
          />
        </div>
      );

    case "span_count":
      return (
        <div className="grid grid-cols-2 gap-2">
          <NumberField path={["min_spans"]} id={id("min-spans")} label="Minimum Spans" className="font-mono" />
          <NumberField path={["max_spans"]} id={id("max-spans")} label="Maximum Spans" placeholder="No upper limit" className="font-mono" />
        </div>
      );

    case "ottl_condition":
      return (
        <div className="space-y-2">
          <NativeSelectField
            path={["error_mode"]}
            id={id("error-mode")}
            label="Error Mode"
            {...(form.read(["error_mode"]).kind === "absent" ? { description: ERROR_MODE_UNSET_HINT } : {})}
            options={ERROR_MODES}
          />
          <ListTextField
            path={["span"]}
            id={id("span")}
            separator={"\n"}
            label="Span Conditions"
            description="OTTL expressions on span context, one per line."
            placeholder={'attributes["http.status_code"] >= 400\nresource.attributes["service.name"] == "api"'}
            rows={4}
            className="font-mono text-xs"
          />
          <ListTextField
            path={["spanevent"]}
            id={id("spanevent")}
            separator={"\n"}
            label="Span Event Conditions"
            description="OTTL expressions on span event context, one per line."
            placeholder='name == "exception"'
            rows={2}
            className="font-mono text-xs"
          />
        </div>
      );

    case "and":
      return (
        <div className="space-y-2">
          <InlineAlert variant="info" title="YAML-only sub-policies">
            A trace is sampled only when every sub-policy matches. Define sub-policies in the YAML editor.
          </InlineAlert>
          {emptyList("and_sub_policy") && <p className="text-[11px] leading-4 text-muted-foreground">{AND_EMPTY_HINT}</p>}
        </div>
      );

    case "composite":
      return (
        <div className="space-y-2">
          <InlineAlert variant="info" title="YAML-only sub-policies">
            The total rate is split across sub-policies. Define sub-policies and rate allocation in the YAML editor.
          </InlineAlert>
          <NumberField
            path={["max_total_spans_per_second"]}
            id={id("max-total-spans")}
            label="Max Total Spans Per Second"
            className="font-mono"
          />
        </div>
      );

    case "drop":
      return (
        <div className="space-y-2">
          <p className="text-[11px] leading-4 text-muted-foreground">Configure {type} in the YAML editor</p>
          {emptyList("drop_sub_policy") && <p className="text-[11px] leading-4 text-muted-foreground">{DROP_EMPTY_HINT}</p>}
        </div>
      );

    default:
      return null;
  }
}
