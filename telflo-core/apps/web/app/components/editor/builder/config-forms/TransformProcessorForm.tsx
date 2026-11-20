import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { ERROR_MODE_OPTIONS } from "./FilterProcessorForm.js";
import { MultiValueField, readLatest, SelectField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { useCardKeys } from "./shared/card-keys.js";
import { listLength } from "./shared/counts.js";
import { ItemScope, useHeldItem, type HeldItem } from "./shared/held-item.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Label } from "~/components/ui/label.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import { Textarea } from "~/components/ui/textarea.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import { ottlString } from "~/lib/ottl.js";
import { findPattern } from "~/lib/regex-library.js";

/*
 * The transform processor's form, over the form's fields. Collector claims
 * are contrib v0.162.0's `processor/transformprocessor` and `pkg/ottl`.
 *
 * The statement lists. The collector reads every flat statement (a string
 * item) of a list as one group, inferred together and run after the list's
 * groups, and refuses a group (a mapping item) after a flat statement
 * (`config.go:110-123`: "configuring multiple configuration styles is not
 * supported"). So:
 * - A section shows its list as two runs: the groups, then the flat
 *   statements, each its own sortable list. Dragging moves an item's own
 *   lines (`form.move`) within its run only, so a group never lands after a
 *   flat statement. Cards and rows are keyed by item (`useCardKeys`; a
 *   group's collapsed state follows it, not `${type}-${index}`); ids are
 *   by list index (`transform-trace-group-0-context`,
 *   `transform-trace-statement-2`, sortable `trace-group-0`), never a value.
 * - A text whose order is already refused (a group after a flat statement)
 *   shows its items as written, with dragging off and `REFUSED_ORDER_HINT`.
 * - Add Statement holds a row that isn't in the text (never `""`, which
 *   doesn't parse, `config.go:145-205`); its first typing appends the
 *   statement at the list's end. A flat row emptied and left removes its item.
 *   Add Statement Group holds a card (never
 *   `{statements: [""], conditions: []}`); its first statement typed writes
 *   the group, with what was typed into it before, inserted before the list's
 *   first flat statement (`useHeldItem`'s index: set at the length and moved,
 *   one change), worked out from the list as it is when the group is written
 *   (a change keeping the list's length, from the YAML box or an undo, keeps
 *   the held card). A group's Add Condition and Add Statement hold their rows
 *   (`holdEmpty`); its only statement can't be removed (`keepLast`; never
 *   `statements: [""]`), Remove statement group removes the group. Removing a
 *   group's last condition removes `conditions`.
 * - A template's Add writes its statements as a group of their own,
 *   `- statements: [...]`, inserted before the list's first flat statement in
 *   one change (one undo entry), so its context is inferred alone and
 *   templates combine (appended as flat statements, T7 beside T5, T6 or T8
 *   would make a group the collector can't infer,
 *   `pkg/ottl/context_inferrer.go`), with a toast. T2's patterns come from
 *   the regex library through `ottlString`; T10's copy says what it does; T11
 *   matches with `IsMatch` (OTTL has no `contains`,
 *   `pkg/ottl/grammar.go:593`), case-sensitive, a literal match.
 * - Error Mode unset shows the collector's default, ignore
 *   (`factory.go:174`), as filter's. A group's Error Mode Inherited removes
 *   its key.
 * - The placeholders are each signal's own (a span or metric path is refused
 *   by the other signals).
 * - Strings are written as typed: statements, conditions and contexts never
 *   go through `EscapedTextField`.
 * - A group the form can't show (not a mapping) is a card with
 *   `UNSHOWABLE_VALUE_MESSAGE`; a group without `statements` shows none, never
 *   a throw.
 *
 * No statement, condition or context reaches an attribute.
 */

type Signal = "trace" | "metric" | "log";

interface SignalSection {
  signal: Signal;
  key: string;
  title: string;
  /** The toast's name for it: "Added to Trace statements". */
  label: string;
  /** Placeholders, per signal. */
  statement: string;
  groupStatement: string;
  condition: string;
}

export const SECTIONS: readonly SignalSection[] = [
  {
    signal: "trace",
    key: "trace_statements",
    title: "Trace Statements",
    label: "Trace",
    statement: 'e.g. set(span.name, "redacted") where span.attributes["sensitive"] == true',
    groupStatement: 'e.g. set(span.attributes["env"], "prod")',
    condition: "e.g. span.kind == SPAN_KIND_SERVER",
  },
  {
    signal: "metric",
    key: "metric_statements",
    title: "Metric Statements",
    label: "Metric",
    statement: 'e.g. set(metric.description, "CPU usage") where metric.name == "system.cpu.time"',
    groupStatement: 'e.g. set(metric.description, "CPU usage")',
    condition: "e.g. metric.type == METRIC_DATA_TYPE_SUM",
  },
  {
    signal: "log",
    key: "log_statements",
    title: "Log Statements",
    label: "Log",
    statement: 'e.g. set(log.severity_text, "WARN") where log.severity_number == SEVERITY_NUMBER_WARN',
    groupStatement: 'e.g. set(log.attributes["env"], "prod")',
    condition: "e.g. IsMap(log.body)",
  },
];

/** Shown over a list whose order the collector refuses. */
export const REFUSED_ORDER_HINT = "The collector refuses a statement group after a flat statement. Reorder them in the YAML below.";

export const NO_CONDITIONS = "No conditions (statements always run)";

// Example patterns for common transformations
export interface ExamplePattern {
  category: string;
  name: string;
  description: string;
  signalType: Signal | "all";
  statements: readonly string[];
}

export const EXAMPLE_PATTERNS: readonly ExamplePattern[] = [
  // Trace Examples
  {
    category: "Security",
    name: "Redact Sensitive Headers",
    description: "Remove authentication headers and cookies from span attributes",
    signalType: "trace",
    statements: [
      'delete_key(span.attributes, "http.request.header.authorization")',
      'delete_key(span.attributes, "http.request.header.cookie")',
      'delete_key(span.attributes, "http.request.header.x-api-key")',
    ],
  },
  {
    category: "Security",
    name: "Redact Passwords in URLs",
    description: "Mask password parameters in URLs and command lines",
    signalType: "trace",
    statements: [
      `replace_pattern(span.attributes["http.url"], ${ottlString(findPattern("Password in URL Query").pattern)}, "password=***")`,
      `replace_pattern(span.attributes["process.command_line"], ${ottlString(findPattern("Password in Command Line").pattern)}, "password=***")`,
    ],
  },
  {
    category: "Attributes",
    name: "Keep Essential Attributes",
    description: "Limit span attributes to only essential fields",
    signalType: "trace",
    statements: [
      'keep_keys(span.attributes, ["http.method", "http.status_code", "http.route", "service.name"])',
      "truncate_all(span.attributes, 1000)",
    ],
  },
  {
    category: "Attributes",
    name: "Set Error Status",
    description: "Mark spans as errors based on HTTP status codes",
    signalType: "trace",
    statements: [
      'set(span.status.code, STATUS_CODE_ERROR) where span.attributes["http.status_code"] >= 500',
      'set(span.status.message, "Server Error") where span.attributes["http.status_code"] >= 500',
    ],
  },

  // Metric Examples
  {
    category: "Metric Conversion",
    name: "Convert Sum to Gauge",
    description: "Convert cumulative sum metrics to gauge type",
    signalType: "metric",
    statements: ['convert_sum_to_gauge() where metric.name == "system.memory.usage"'],
  },
  {
    category: "Metric Conversion",
    name: "Scale Time Units",
    description: "Convert milliseconds to seconds",
    signalType: "metric",
    statements: ['scale_metric(0.001) where metric.unit == "ms"', 'set(metric.unit, "s") where metric.unit == "ms"'],
  },
  {
    category: "Attributes",
    name: "Limit Metric Labels",
    description: "Keep only essential labels and limit cardinality",
    signalType: "metric",
    statements: [
      'keep_keys(resource.attributes, ["service.name", "service.namespace", "deployment.environment"])',
      'limit(datapoint.attributes, 100, ["host.name", "service.name"])',
    ],
  },
  {
    category: "Metric Extraction",
    name: "Extract Histogram Metrics",
    description: "Create separate count and sum metrics from histograms",
    signalType: "metric",
    statements: [
      'extract_count_metric(true, ".count") where metric.type == METRIC_DATA_TYPE_HISTOGRAM',
      'extract_sum_metric(true, ".sum") where metric.type == METRIC_DATA_TYPE_HISTOGRAM',
    ],
  },

  // Log Examples
  {
    category: "Security",
    name: "Redact Log Secrets",
    description: "Remove sensitive fields from log attributes",
    signalType: "log",
    statements: [
      'delete_key(log.attributes, "password") where log.attributes["password"] != nil',
      'delete_key(log.attributes, "api_key") where log.attributes["api_key"] != nil',
      'delete_key(log.attributes, "token") where log.attributes["token"] != nil',
    ],
  },
  {
    category: "Parsing",
    name: "Extract JSON Fields",
    description: "Copy fields of a map log body (already-parsed JSON) into attributes.",
    signalType: "log",
    statements: [
      'set(log.attributes["http.method"], log.body["method"]) where IsMap(log.body)',
      'set(log.attributes["http.path"], log.body["path"]) where IsMap(log.body)',
      'set(log.attributes["http.status"], log.body["status"]) where IsMap(log.body)',
    ],
  },
  {
    category: "Attributes",
    name: "Set Log Severity",
    description: "Standardize severity levels based on log content",
    signalType: "log",
    statements: [
      'set(log.severity_text, "ERROR") where IsMatch(log.body, "error")',
      'set(log.severity_text, "WARN") where IsMatch(log.body, "warning")',
      'set(log.severity_text, "INFO") where IsMatch(log.body, "info")',
    ],
  },

  // Multi-signal Examples
  {
    category: "Enrichment",
    name: "Add Environment Tags",
    description: "Add deployment environment to all signals",
    signalType: "all",
    statements: ['set(resource.attributes["environment"], "production")', 'set(resource.attributes["region"], "us-west-2")'],
  },
];

// OTTL Function Reference
interface OTTLFunction {
  name: string;
  signature: string;
  description: string;
  example: string;
}

const COMMON_FUNCTIONS: readonly OTTLFunction[] = [
  {
    name: "set",
    signature: "set(target, value)",
    description: "Assign a value to a target path",
    example: 'set(span.name, "new-name")',
  },
  {
    name: "delete_key",
    signature: "delete_key(target, key)",
    description: "Remove a specific key from a map",
    example: 'delete_key(span.attributes, "password")',
  },
  {
    name: "keep_keys",
    signature: "keep_keys(target, keys[])",
    description: "Keep only specified keys, remove all others",
    example: 'keep_keys(span.attributes, ["method", "path"])',
  },
  {
    name: "truncate_all",
    signature: "truncate_all(target, limit)",
    description: "Truncate all string values to max length",
    example: "truncate_all(span.attributes, 1000)",
  },
  {
    name: "replace_pattern",
    signature: "replace_pattern(target, regex, replacement)",
    description: "Replace regex matches in a value",
    example: `replace_pattern(span.attributes["url"], ${ottlString(findPattern("Password in URL Query").pattern)}, "password=***")`,
  },
  {
    name: "limit",
    signature: "limit(target, limit, priority_keys[])",
    description: "Limit map size, keeping priority keys",
    example: 'limit(datapoint.attributes, 100, ["host.name"])',
  },
  {
    name: "convert_sum_to_gauge",
    signature: "convert_sum_to_gauge()",
    description: "Convert Sum metric to Gauge (metric context)",
    example: 'convert_sum_to_gauge() where metric.name == "memory.usage"',
  },
  {
    name: "scale_metric",
    signature: "scale_metric(factor)",
    description: "Multiply datapoint values by factor",
    example: 'scale_metric(0.001) where metric.unit == "ms"',
  },
  {
    name: "extract_count_metric",
    signature: "extract_count_metric(is_monotonic, suffix)",
    description: "Extract count from Histogram as new metric",
    example: 'extract_count_metric(true, ".count")',
  },
];

const GROUP_ERROR_MODES = [
  { value: "ignore", label: "Ignore" },
  { value: "silent", label: "Silent" },
  { value: "propagate", label: "Propagate" },
] as const;

/** A held group's keys in the order a person reads a group (each placed when typed; never written empty). */
const GROUP_SEED = { context: undefined, error_mode: undefined, conditions: undefined, statements: undefined };

/** A held group is written once it has a statement: a group without one can't be inferred or does nothing (`pkg/ottl/parser_collection.go:429-431`). */
function groupReady(item: unknown): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const statements = (item as Record<string, unknown>).statements;
  return Array.isArray(statements) && statements.some((statement) => typeof statement === "string" && statement !== "");
}

/** Where a new group goes: before the list's first flat statement (`config.go:110-123`), else at its end. */
export function firstFlatIndex(items: readonly unknown[]): number {
  const index = items.findIndex((item) => typeof item === "string");
  return index === -1 ? items.length : index;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count !== 1 ? "s" : ""}`;

export function TransformProcessorForm() {
  const form = useForm();
  const [expandedExamples, setExpandedExamples] = useState<Set<string>>(new Set());

  // Toggle example expansion
  const toggleExample = (exampleName: string) => {
    setExpandedExamples((prev) => {
      const next = new Set(prev);
      if (next.has(exampleName)) {
        next.delete(exampleName);
      } else {
        next.add(exampleName);
      }
      return next;
    });
  };

  // Apply example pattern: its own group, before the flat statements.
  const applyExample = (example: ExamplePattern, targetSignal?: Signal) => {
    const signal = targetSignal ?? (example.signalType === "all" ? "trace" : example.signalType);
    const section = SECTIONS.find((s) => s.signal === signal)!;
    // A row's typing lands on its own item before the list shifts; the list is read as that left it.
    flushHeldEdits();
    const view = readLatest(form, [section.key]);
    if (view.kind !== "list" && view.kind !== "absent") return;
    const items = view.kind === "list" ? view.value : [];
    const end = items.length;
    const at = firstFlatIndex(items);
    const changes: ValueChange[] = [{ path: [section.key, end], value: { statements: [...example.statements] } }];
    if (at < end) changes.push({ path: [section.key, end], moveTo: at });
    if (form.apply(changes) !== "written") return;

    // Show success toast
    toast.success(`Added to ${section.label} statements`, {
      description: example.name,
    });
  };

  const examplesByCategory = EXAMPLE_PATTERNS.reduce(
    (acc, ex) => {
      (acc[ex.category] ??= []).push(ex);
      return acc;
    },
    {} as Record<string, ExamplePattern[]>,
  );

  return (
    <div className="space-y-4">
      <SelectField path={["error_mode"]} id="error-mode" label="Error Mode" options={ERROR_MODE_OPTIONS} defaultValue="ignore" />

      {SECTIONS.map((section) => (
        <ConfigSection key={section.signal} title={section.title} count={listLength(form.read([section.key]))}>
          <StatementsSection section={section} />
        </ConfigSection>
      ))}

      <ConfigSection title="Examples & Reference">
        {/* Example Patterns */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-foreground">Common Transform Patterns</h3>
          {Object.entries(examplesByCategory).map(([category, examples]) => (
            <div key={category} className="space-y-2">
              <h4 className="tf-label">{category}</h4>
              {examples.map((example) => {
                const isExpanded = expandedExamples.has(example.name);
                return (
                  <div key={example.name} className="border rounded-lg p-2.5 space-y-2 hover:bg-accent/50 transition-colors">
                    <div className="flex items-start justify-between cursor-pointer" onClick={() => toggleExample(example.name)}>
                      <div className="flex items-start gap-2 flex-1">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 mt-1 flex-shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 mt-1 flex-shrink-0" />
                        )}
                        <div className="flex-1">
                          <p className="font-medium text-sm">{example.name}</p>
                          <p className="text-xs text-muted-foreground">{example.description}</p>
                          <Badge variant="info" className="mt-1">
                            {example.signalType === "all"
                              ? "All Signals"
                              : example.signalType.charAt(0).toUpperCase() + example.signalType.slice(1)}
                          </Badge>
                        </div>
                      </div>
                      {example.signalType !== "all" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            applyExample(example);
                          }}
                          disabled={form.disabled}
                        >
                          <Plus className="h-3 w-3 mr-1" />
                          Add
                        </Button>
                      ) : (
                        <div className="flex gap-1">
                          {(
                            [
                              ["trace", "Traces"],
                              ["metric", "Metrics"],
                              ["log", "Logs"],
                            ] as const
                          ).map(([signal, label]) => (
                            <Button
                              key={signal}
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                applyExample(example, signal);
                              }}
                              disabled={form.disabled}
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="pl-6 space-y-1">
                        {example.statements.map((stmt, idx) => (
                          <pre key={idx} className="text-xs bg-muted p-2 rounded overflow-x-auto font-mono">
                            {stmt}
                          </pre>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Function Reference */}
        <div className="space-y-4 pt-4 border-t">
          <h3 className="text-sm font-medium text-foreground">Common OTTL Functions</h3>
          <div className="grid gap-3">
            {COMMON_FUNCTIONS.map((fn) => (
              <div key={fn.name} className="border rounded-lg p-2.5 space-y-1">
                <code className="font-mono text-sm font-semibold">{fn.signature}</code>
                <p className="text-sm text-muted-foreground">{fn.description}</p>
                <pre className="text-xs bg-muted p-2 rounded overflow-x-auto font-mono mt-2">{fn.example}</pre>
              </div>
            ))}
          </div>
        </div>
      </ConfigSection>
    </div>
  );
}

/** A section's item as shown: a group card or a flat row, the held ones included. */
interface Entry {
  kind: "group" | "flat";
  /** Its index in the list (a held one's: where it goes). */
  index: number;
  key: number;
  held: boolean;
}

/** One signal's list: the groups' run, then the flat statements' run. */
function StatementsSection({ section }: { section: SignalSection }) {
  const form = useForm();
  const { signal } = section;
  const listPath: ValuePath = [section.key];
  const view = form.read(listPath);
  const showable = view.kind === "list" || view.kind === "absent";
  const items = view.kind === "list" ? view.value : [];
  const cards = useCardKeys(items);
  const heldGroup = useHeldItem(listPath, { cards, ready: groupReady });
  const firstFlat = firstFlatIndex(items);
  // A group (anything but a string, to the collector) after a flat statement: refused (config.go:110-123).
  const refused = items.some((item, index) => index > firstFlat && typeof item !== "string");
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  // The held flat row belongs to the list's length when it was held: a change of length drops it.
  const [flatHeldAt, setFlatHeldAt] = useState<number | null>(null);
  const [seenLength, setSeenLength] = useState(items.length);
  if (seenLength !== items.length) {
    setSeenLength(items.length);
    setFlatHeldAt(null);
  }
  const flatHeld = flatHeldAt === items.length;

  const toggle = (key: number) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };

  const removeItem = (index: number) => {
    if (form.remove([...listPath, index]) === "written") cards.remove(index);
  };

  /** A drop within a run (`base` its first index, `count` its items in the text): the item's own lines move. */
  const moveWithin = (base: number, count: number) => (from: number, to: number) => {
    // A held card or row isn't in the text: it neither moves nor is a drop target.
    if (refused || from >= count || to >= count) return;
    if (form.move(listPath, base + from, base + to) === "written") cards.move(base + from, base + to);
  };

  const entries: Entry[] = items.map((item, index) => ({
    kind: typeof item === "string" ? "flat" : "group",
    index,
    key: cards.keys[index]!,
    held: false,
  }));
  // One held item at a time (they'd share the key the next item takes): the group card shows where it goes.
  if (heldGroup.held) entries.splice(heldGroup.at, 0, { kind: "group", index: heldGroup.at, key: cards.next, held: true });
  if (flatHeld) entries.push({ kind: "flat", index: items.length, key: cards.next, held: true });

  const renderEntry = (entry: Entry, id: string) => (
    <SortableItem key={entry.key} id={id} disabled={form.disabled || entry.held || refused}>
      {({ isDragging, dragHandleProps }) => {
        const handle = (className?: string) => (
          <SortableHandle {...dragHandleProps} disabled={form.disabled || entry.held || refused} {...(className ? { className } : {})} />
        );
        return entry.kind === "group" ? (
          <GroupCard
            section={section}
            index={entry.index}
            held={entry.held ? heldGroup : undefined}
            expanded={!collapsed.has(entry.key)}
            onToggle={() => toggle(entry.key)}
            onRemove={() => (entry.held ? heldGroup.drop() : removeItem(entry.index))}
            handle={handle()}
            isDragging={isDragging}
          />
        ) : (
          <StatementRow
            listPath={listPath}
            index={entry.index}
            held={entry.held}
            id={`transform-${signal}-statement-${entry.index}`}
            placeholder={section.statement}
            handle={handle("mt-2")}
            isDragging={isDragging}
            onDrop={() => setFlatHeldAt(null)}
            onRemove={() => removeItem(entry.index)}
          />
        );
      }}
    </SortableItem>
  );

  const overlay = (entry: Entry) => {
    if (entry.kind === "flat") {
      const item = items[entry.index];
      return (
        <div className="flex gap-2 items-start p-2">
          <SortableHandle attributes={{} as never} listeners={undefined} className="mt-2 cursor-grabbing" />
          <div className="font-mono text-sm flex-1 min-w-0 truncate bg-muted p-2 rounded">
            {typeof item === "string" && item !== "" ? item : "(empty statement)"}
          </div>
        </div>
      );
    }
    const statements = listLength(form.read([...listPath, entry.index, "statements"]));
    const conditions = listLength(form.read([...listPath, entry.index, "conditions"]));
    return (
      <div className="p-3">
        <div className="flex items-center gap-2">
          <SortableHandle attributes={{} as never} listeners={undefined} className="cursor-grabbing" />
          <ChevronRight className="h-4 w-4" />
          <Label className="text-sm font-semibold">Statement Group {entry.index + 1}</Label>
          <span className="text-xs text-muted-foreground ml-2">
            {plural(statements, "statement")}
            {conditions > 0 && `, ${plural(conditions, "condition")}`}
          </span>
        </div>
      </div>
    );
  };

  if (!showable) return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;

  const groups = entries.filter((entry) => entry.kind === "group");
  const flats = entries.filter((entry) => entry.kind === "flat");
  const anyHeld = heldGroup.held || flatHeld;

  return (
    <>
      {refused && <p className="text-[11px] leading-4 text-muted-foreground">{REFUSED_ORDER_HINT}</p>}

      {/* Statements list */}
      {entries.length === 0 ? (
        <p className="text-[11px] leading-4 text-muted-foreground">No statements configured</p>
      ) : refused ? (
        // As written, dragging off.
        <SortableList
          list={`${signal}-item`}
          items={entries}
          onReorder={() => {}}
          listClassName="space-y-3"
          contextId={`transform-${signal}-items`}
        >
          {(entry, _position, id) => renderEntry(entry, id)}
        </SortableList>
      ) : (
        <>
          {groups.length > 0 && (
            <SortableList
              list={`${signal}-group`}
              items={groups}
              onReorder={moveWithin(0, firstFlat)}
              listClassName="space-y-3"
              contextId={`transform-${signal}-groups`}
              renderOverlay={(entry) => overlay(entry)}
            >
              {(entry, _position, id) => renderEntry(entry, id)}
            </SortableList>
          )}
          {flats.length > 0 && (
            <SortableList
              list={`${signal}-statement`}
              items={flats}
              onReorder={moveWithin(firstFlat, items.length - firstFlat)}
              listClassName="space-y-3"
              contextId={`transform-${signal}-statements`}
              renderOverlay={(entry) => overlay(entry)}
            >
              {(entry, _position, id) => renderEntry(entry, id)}
            </SortableList>
          )}
        </>
      )}

      {/* Add buttons */}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => {
            flushHeldEdits();
            setFlatHeldAt(items.length);
          }}
          disabled={form.disabled || heldGroup.held}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Statement
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          // Where it goes is worked out from the list it is written into.
          onClick={() => heldGroup.hold(firstFlatIndex)}
          disabled={form.disabled || anyHeld}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Statement Group
        </Button>
      </div>
    </>
  );
}

/** A flat statement's row: its typing written to its item; the held row's first typing appended. */
function StatementRow({
  listPath,
  index,
  held,
  id,
  placeholder,
  handle,
  isDragging,
  onDrop,
  onRemove,
}: {
  listPath: ValuePath;
  index: number;
  held: boolean;
  id: string;
  placeholder: string;
  handle: ReactNode;
  isDragging: boolean;
  /** Drops the held row, writing nothing. */
  onDrop: () => void;
  /** Removes the row's item. */
  onRemove: () => void;
}) {
  const form = useForm();
  const view = held ? null : form.read([...listPath, index]);
  const shown = view?.kind === "scalar" && typeof view.value === "string" ? view.value : "";
  const formRef = useRef(form);
  formRef.current = form;
  const text = useHeldText(
    shown,
    (typed) => {
      const current = formRef.current;
      if (held) {
        // The held row's first typing is the list's new last statement; nothing typed writes nothing.
        if (typed !== "") current.set([...listPath, index], typed);
        return;
      }
      // Emptied and left: the statement goes, never written "" (which doesn't parse).
      if (typed === "") onRemove();
      else current.set([...listPath, index], typed);
    },
    // An emptied row is removed when it is left, not under the cursor.
    { pause: (typed) => typed !== "" },
  );
  return (
    <div className={`flex gap-2 items-start ${isDragging ? "shadow-lg ring-2 ring-brand rounded-md bg-card" : ""}`}>
      {handle}
      <Textarea
        id={id}
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={() => {
          text.flush();
          // Left with nothing typed, the held row goes (what it held was written just before).
          if (held) onDrop();
        }}
        onKeyDown={(e) => text.handleKeyDown(e, false)}
        placeholder={placeholder}
        className="font-mono text-sm flex-1"
        rows={2}
        disabled={form.disabled}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Remove statement"
        onClick={() => (held ? onDrop() : onRemove())}
        disabled={form.disabled}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** A statement group's card, under its `ItemScope` (the item's own, or the held card's). */
function GroupCard({
  section,
  index,
  held,
  expanded,
  onToggle,
  onRemove,
  handle,
  isDragging,
}: {
  section: SignalSection;
  index: number;
  held: HeldItem | undefined;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  handle: ReactNode;
  isDragging: boolean;
}) {
  return (
    <div className={`border rounded-lg ${isDragging ? "shadow-lg ring-2 ring-brand" : ""}`}>
      <ItemScope listPath={[section.key]} index={index} held={held} seed={GROUP_SEED}>
        <GroupFields
          section={section}
          index={index}
          held={held !== undefined}
          expanded={expanded}
          onToggle={onToggle}
          onRemove={onRemove}
          handle={handle}
        />
      </ItemScope>
    </div>
  );
}

function GroupFields({
  section,
  index,
  held,
  expanded,
  onToggle,
  onRemove,
  handle,
}: {
  section: SignalSection;
  index: number;
  held: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  handle: ReactNode;
}) {
  const form = useForm();
  const showable = held || form.read([]).kind === "map";
  const statementsCount = listLength(form.read(["statements"]));
  const conditionsCount = listLength(form.read(["conditions"]));
  const contextView = form.read(["context"]);
  const context = contextView.kind === "scalar" ? (contextView.source ?? String(contextView.value)) : "";
  const prefix = `transform-${section.signal}-group-${index}`;

  return (
    <>
      {/* Header - always visible */}
      <div className={`flex items-center justify-between p-2.5 ${expanded ? "border-b" : ""}`}>
        <div className="flex items-center gap-2 flex-1">
          {handle}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="flex items-center gap-2 hover:text-brand transition-colors"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Label className="text-sm font-semibold cursor-pointer">Statement Group {index + 1}</Label>
          </button>
          {/* Summary when collapsed */}
          {!expanded && showable && (
            <span className="text-xs text-muted-foreground ml-2">
              {plural(statementsCount, "statement")}
              {conditionsCount > 0 && `, ${plural(conditionsCount, "condition")}`}
              {context && ` · ${context}`}
            </span>
          )}
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Remove statement group" onClick={onRemove} disabled={form.disabled}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Collapsible content */}
      {expanded && (
        <div className="p-2.5 space-y-2">
          {!showable ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
          ) : (
            <>
              {/* Context + error mode overrides */}
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  path={["context"]}
                  id={`${prefix}-context`}
                  label="Context"
                  description="Inferred from the statements when empty."
                  placeholder="e.g. span"
                />

                <SelectField
                  path={["error_mode"]}
                  id={`${prefix}-error-mode`}
                  label="Error Mode"
                  description="Overrides the global error mode."
                  placeholder="Inherited"
                  unsetOption={{ label: "Inherited" }}
                  options={GROUP_ERROR_MODES}
                />
              </div>

              {/* Conditions */}
              <div className="space-y-2">
                <ConfigField label="Conditions" htmlFor={`${prefix}-conditions`} description="Statements run if any condition matches.">
                  <MultiValueField
                    path={["conditions"]}
                    id={`${prefix}-conditions`}
                    placeholder={section.condition}
                    holdEmpty
                    emptyRemovesKey
                    vaultAware
                    removeLabel="Remove condition"
                    addButtonText="Add Condition"
                    inputClassName="font-mono text-sm"
                    emptyText={NO_CONDITIONS}
                  />
                </ConfigField>
              </div>

              {/* Statements */}
              <div className="space-y-2">
                <ConfigField label="Statements" htmlFor={`${prefix}-statements`}>
                  <MultiValueField
                    path={["statements"]}
                    id={`${prefix}-statements`}
                    placeholder={section.groupStatement}
                    holdEmpty
                    keepLast
                    multiline={2}
                    removeLabel="Remove statement"
                    addButtonText="Add Statement"
                    inputClassName="font-mono text-sm"
                    startHeld={held}
                  />
                </ConfigField>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
