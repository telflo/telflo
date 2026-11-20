import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { BareTextField, SelectField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { SortableHandle, SortableItem, SortableList } from "~/components/ui/sortable/index.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";
import { findPattern } from "~/lib/regex-library.js";

/*
 * The filter processor's form, over the form.
 *
 * - **Carried forward**: OTTL condition lists only (`traces.span`,
 *   `traces.spanevent`, `metrics.metric`, `metrics.datapoint`,
 *   `logs.log_record`); the legacy matchers and the newer `*_conditions` keys
 *   stay in the YAML, untouched.
 * - Each list is sortable: dragging a condition (pointer or keyboard) moves
 *   its own lines, comments and quoting with it (`form.move`). A condition's
 *   typing is written to its item; cleared, it writes `""` (the item stays).
 *   "Add Filter" appends `""`; the trash button removes the item's lines.
 * - The examples' "Add" appends the example's expression to the list for
 *   its context and toasts "Added to <list>"; the
 *   "All Signals" examples go to Span Filters only (carried forward).
 * - **Fixed**: an unset `error_mode` shows the collector's default, `ignore`
 *   (filterprocessor `createDefaultConfig`, `ErrorMode: ottl.IgnoreError`,
 *   contrib v0.162.0), as its placeholder (the option's label) and in the
 *   "Default ignore" hint, never propagate as if it were set.
 *
 * Rows are keyed and identified by index (`span-filter-0`), never by a
 * condition.
 */

// Example filter patterns
interface FilterExample {
  category: string;
  name: string;
  description: string;
  signalType: "traces" | "metrics" | "logs" | "all";
  context: "span" | "spanevent" | "metric" | "datapoint" | "log_record";
  expression: string;
}

export const FILTER_EXAMPLES: readonly FilterExample[] = [
  // Security Examples
  {
    category: "Security",
    name: "Drop Test Services",
    description: "Drop telemetry from test and staging services",
    signalType: "all",
    context: "span",
    expression: 'resource.attributes["service.name"] == "test-service"',
  },
  {
    category: "Security",
    name: "Drop Sensitive Endpoints",
    description: "Drop requests to admin or internal endpoints",
    signalType: "traces",
    context: "span",
    expression: `IsMatch(attributes["http.target"], "${findPattern("Admin/Internal Routes").pattern}")`,
  },

  // Cost Optimization Examples
  {
    category: "Cost Optimization",
    name: "Drop Debug/Trace Logs",
    description: "Reduce log volume by dropping low-severity logs",
    signalType: "logs",
    context: "log_record",
    expression: "severity_number < SEVERITY_NUMBER_INFO",
  },
  {
    category: "Cost Optimization",
    name: "Drop Fast Successful Spans",
    description: "Reduce trace volume for fast, successful requests",
    signalType: "traces",
    context: "span",
    expression: '(end_time - start_time) < Duration("100ms") and status.code == STATUS_CODE_OK',
  },
  {
    category: "Cost Optimization",
    name: "Drop Health Check Spans",
    description: "Drop health check and readiness probe traffic",
    signalType: "traces",
    context: "span",
    expression: `IsMatch(attributes["http.target"], "${findPattern("Health Check Routes").pattern}")`,
  },

  // Data Quality Examples
  {
    category: "Data Quality",
    name: "Drop Invalid Metrics",
    description: "Drop metrics without type information",
    signalType: "metrics",
    context: "metric",
    expression: "type == METRIC_DATA_TYPE_NONE",
  },
  {
    category: "Data Quality",
    name: "Drop Non-HTTP Spans",
    description: "Keep only HTTP protocol spans",
    signalType: "traces",
    context: "span",
    expression: 'attributes["http.request.method"] == nil',
  },
  {
    category: "Data Quality",
    name: "Drop Pending Pod Metrics",
    description: "Drop datapoints from pods in the Pending phase",
    signalType: "metrics",
    context: "datapoint",
    expression: 'attributes["pod.phase"] == "Pending"',
  },

  // Compliance Examples
  {
    category: "Compliance",
    name: "Drop Development Environment",
    description: "Drop telemetry from non-production environments",
    signalType: "all",
    context: "span",
    expression: 'resource.attributes["deployment.environment"] != "production"',
  },
  {
    category: "Compliance",
    name: "Drop Synthetic Monitoring",
    description: "Drop synthetic test traffic",
    signalType: "traces",
    context: "span",
    expression: 'attributes["http.user_agent"] == "synthetic-monitor"',
  },
];

// OTTL Functions reference
interface OTTLFunction {
  name: string;
  signature: string;
  description: string;
  example: string;
}

const OTTL_FUNCTIONS: OTTLFunction[] = [
  {
    name: "IsMatch",
    signature: "IsMatch(target, pattern)",
    description: "Returns true if target matches regex pattern",
    example: `IsMatch(attributes["http.target"], "${findPattern("API Routes").pattern}")`,
  },
  {
    name: "Duration",
    signature: "Duration(value)",
    description: "Converts string to duration for comparisons",
    example: '(end_time - start_time) < Duration("100ms")',
  },
  {
    name: "HasAttrKeyOnDatapoint",
    signature: "HasAttrKeyOnDatapoint(key)",
    description: "Checks if datapoint has specific attribute key",
    example: 'HasAttrKeyOnDatapoint("error")',
  },
  {
    name: "HasAttrOnDatapoint",
    signature: "HasAttrOnDatapoint(key, value)",
    description: "Checks if datapoint has attribute with specific value",
    example: 'HasAttrOnDatapoint("error", "true")',
  },
];

type FilterContext = FilterExample["context"];

/** Each context's list: its path and its label (the examples' toast names it). */
const FILTER_LISTS: Record<FilterContext, { path: ValuePath; label: string }> = {
  span: { path: ["traces", "span"], label: "Span Filters" },
  spanevent: { path: ["traces", "spanevent"], label: "Span Event Filters" },
  metric: { path: ["metrics", "metric"], label: "Metric Filters" },
  datapoint: { path: ["metrics", "datapoint"], label: "Datapoint Filters" },
  log_record: { path: ["logs", "log_record"], label: "Log Record Filters" },
};

export const ERROR_MODE_OPTIONS = [
  { value: "ignore", label: "Ignore - Log errors and continue (recommended for production)" },
  { value: "silent", label: "Silent - Suppress error logs" },
  { value: "propagate", label: "Propagate - Return error and drop data (strict)" },
] as const;

function listLength(view: ValueView): number {
  return view.kind === "list" ? view.value.length : 0;
}

export function FilterProcessorForm() {
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

  // Apply example to appropriate field
  const applyExample = (example: FilterExample) => {
    const { path, label } = FILTER_LISTS[example.context];
    const length = listLength(form.read(path));
    if (form.set([...path, length], example.expression) === "refused") return;

    // Show success toast
    toast.success(`Added to ${label}`, {
      description: example.name,
    });
  };

  const count = (context: FilterContext) => listLength(form.read(FILTER_LISTS[context].path));
  const traceFilterCount = count("span") + count("spanevent");
  const metricFilterCount = count("metric") + count("datapoint");
  const logFilterCount = count("log_record");

  const examplesByCategory = FILTER_EXAMPLES.reduce(
    (acc, ex) => {
      (acc[ex.category] ??= []).push(ex);
      return acc;
    },
    {} as Record<string, FilterExample[]>,
  );

  return (
    <div className="space-y-4">
      <SelectField
        path={["error_mode"]}
        id="error-mode"
        label="Error Mode"
        options={ERROR_MODE_OPTIONS}
        defaultValue="ignore"
      />

      <ConfigSection title="Traces" count={traceFilterCount}>
        <FilterEditor
          type="span"
          description="Any matching expression drops the span"
          placeholder={'attributes["http.request.method"] == "GET"\nresource.attributes["service.name"] == "my-service"'}
        />

        <FilterEditor
          type="spanevent"
          description="Evaluated only when the parent span is kept"
          placeholder={'name == "exception"\nattributes["exception.type"] == "TimeoutError"'}
        />
      </ConfigSection>

      <ConfigSection title="Metrics" count={metricFilterCount}>
        <FilterEditor
          type="metric"
          description="Any matching expression drops the whole metric"
          placeholder={'name == "http.server.duration"\ntype == METRIC_DATA_TYPE_NONE'}
        />

        <FilterEditor
          type="datapoint"
          description="Drops points; a metric with no points left is dropped too"
          placeholder={'metric.type == METRIC_DATA_TYPE_HISTOGRAM\nattributes["pod.phase"] == "Pending"'}
        />
      </ConfigSection>

      <ConfigSection title="Logs" count={logFilterCount}>
        <FilterEditor
          type="log_record"
          description="Any matching expression drops the log record"
          placeholder={'severity_number < SEVERITY_NUMBER_WARN\nattributes["log.level"] == "debug"'}
        />
      </ConfigSection>

      <ConfigSection title="Examples & Reference">
        {/* Example Patterns */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-foreground">Common Filter Patterns</h3>
          {Object.entries(examplesByCategory).map(([category, examples]) => (
            <div key={category} className="space-y-2">
              <h4 className="tf-label">{category}</h4>
              {examples.map((example) => {
                const isExpanded = expandedExamples.has(example.name);
                return (
                  <div
                    key={example.name}
                    className="border rounded-lg p-2.5 space-y-2 hover:bg-accent/50 transition-colors"
                  >
                    <div
                      className="flex items-start justify-between cursor-pointer"
                      onClick={() => toggleExample(example.name)}
                    >
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
                    </div>
                    {isExpanded && (
                      <div className="pl-6">
                        <pre className="text-xs bg-muted p-2 rounded overflow-x-auto font-mono">
                          {example.expression}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* OTTL Functions Reference */}
        <div className="space-y-4 pt-4 border-t">
          <h3 className="text-sm font-medium text-foreground">Common OTTL Functions</h3>
          <div className="grid gap-3">
            {OTTL_FUNCTIONS.map((fn) => (
              <div key={fn.name} className="border rounded-lg p-2.5 space-y-1">
                <code className="font-mono text-sm font-semibold">{fn.signature}</code>
                <p className="text-sm text-muted-foreground">{fn.description}</p>
                <pre className="text-xs bg-muted p-2 rounded overflow-x-auto font-mono mt-2">{fn.example}</pre>
              </div>
            ))}
          </div>

          {/* OTTL Syntax Basics */}
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <div>
              <strong className="text-foreground font-medium">Operators:</strong>{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">==</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">!=</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">&lt;</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">&gt;</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">&lt;=</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">&gt;=</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">and</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">or</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">not</code>
            </div>
            <div>
              <strong className="text-foreground font-medium">Fields:</strong>{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">attributes["key"]</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">resource.attributes["key"]</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">name</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">status.code</code>,{" "}
              <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">severity_number</code>
            </div>
            <p>
              Full reference:{" "}
              <a
                href="https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/pkg/ottl"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:underline"
              >
                OTTL Functions Documentation
              </a>
            </p>
          </div>
        </div>
      </ConfigSection>
    </div>
  );
}

/** One OTTL condition list: sortable rows, "No filters configured", and "Add Filter". */
function FilterEditor({ type, description, placeholder }: { type: FilterContext; description: string; placeholder: string }) {
  const form = useForm();
  const { path, label } = FILTER_LISTS[type];
  const view = form.read(path);
  const count = listLength(view);
  const indices = Array.from({ length: count }, (_item, index) => index);
  const unshowable = view.kind !== "list" && view.kind !== "absent";

  return (
    <div className="space-y-3">
      <ConfigField label={label} description={`${description}.`}>
        {unshowable ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : count > 0 ? (
          <SortableList
            list={`${type}-filter`}
            items={indices}
            onReorder={(from, to) => form.move(path, from, to)}
            listClassName="space-y-2"
            contextId={`filter-${type}`}
          >
            {(idx, _position, id) => (
              <SortableItem key={id} id={id} disabled={form.disabled}>
                {({ isDragging, dragHandleProps }) => (
                  <div className={`flex gap-2 ${isDragging ? "shadow-lg ring-2 ring-brand rounded-md" : ""}`}>
                    <SortableHandle {...dragHandleProps} className="mt-2" disabled={form.disabled} />
                    <BareTextField
                      path={[...path, idx]}
                      multiline
                      placeholder={placeholder}
                      rows={2}
                      className="font-mono text-sm flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove filter"
                      onClick={() => form.remove([...path, idx])}
                      disabled={form.disabled}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </SortableItem>
            )}
          </SortableList>
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">No filters configured</p>
        )}
      </ConfigField>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => form.set([...path, count], "")}
        disabled={form.disabled || unshowable}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Filter
      </Button>
    </div>
  );
}
