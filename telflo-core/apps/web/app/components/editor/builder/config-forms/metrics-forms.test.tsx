import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify } from "yaml";

import { CumulativeToDeltaProcessorForm, MEMORY_ALERT } from "./CumulativeToDeltaProcessorForm.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { COMPACTION_ALERT, GroupByAttrsProcessorForm } from "./GroupByAttrsProcessorForm.js";
import {
  ACTION_REQUIRED,
  COMBINE_SUM,
  GROUP_LABELS,
  MetricsTransformProcessorForm,
  NEW_NAME_REQUIRED,
  NO_TRANSFORMS,
} from "./MetricsTransformProcessorForm.js";
import { formFor } from "./registry.js";
import {
  EMPTY_MAPPINGS,
  NO_MAPPINGS,
  REMOVED_HISTOGRAM,
  REMOVED_SUMMARY,
  SOCKET_PERMISSIONS_STRING_HINT,
  StatsdReceiverForm,
} from "./StatsdReceiverForm.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { findPaletteEntry, paletteDefaultConfig } from "~/lib/graph/palette.js";
import type { ComponentType } from "~/lib/graph/types.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The statsd receiver and the cumulativetodelta, metricstransform and
 * groupbyattrs processors: their forms over the form contract. Each field
 * is driven as a person would on the metrics corpus text (comments, an
 * anchor and a merge, flow and block lists, a plain `0622` and a bare
 * `0750`), LF and CRLF, and writes only its key. The metricstransform (4;
 * the empty alert's copy changed) and groupbyattrs (3) cases follow. The
 * fixes each have a test that fails if the bug returns.
 *
 * Collector claims cite contrib v0.162.0: `receiver/statsdreceiver`,
 * `processor/cumulativetodeltaprocessor`,
 * `processor/metricstransformprocessor`, `processor/groupbyattrsprocessor`.
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The metrics corpus (LF): comments, an anchor and a merge, a plain `0622` and a bare `0750`. */
const CORPUS = LF(corpusText("forms-metrics.yaml"));

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Ends the store's run of changes (one undo entry per run within 800 ms,
 * `HISTORY_THROTTLE_MS`): the next write is an entry of its own.
 */
function stepPastRuns() {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 1000);
}

const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const STATSD = "receivers.statsd";
const STATSD_UNIX = "receivers.statsd/unix";
const CTD = "processors.cumulativetodelta";
const CTD_REGEXP = "processors.cumulative_to_delta/regexp";
const MT = "processors.metricstransform";
const GBA = "processors.groupbyattrs";
const GBA_COMPACT = "processors.groupbyattrs/compact";

function formOf(key: string): ReactNode {
  if (key.startsWith("receivers.statsd")) return <StatsdReceiverForm />;
  if (key.startsWith("processors.cumulative")) return <CumulativeToDeltaProcessorForm />;
  if (key.startsWith("processors.metric")) return <MetricsTransformProcessorForm />;
  return <GroupByAttrsProcessorForm />;
}

function renderForm(key: string, text = CORPUS, options?: Parameters<typeof userEvent.setup>[0]) {
  openText(text);
  const user = userEvent.setup(options);
  render(<ComponentForm nodeId={componentNamed(key).id}>{formOf(key)}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const parsed = (written = text()) => parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>;
const valueOf = (key: string, written = text()): Value => {
  const dot = key.indexOf(".");
  return parsed(written)[key.slice(0, dot)]![key.slice(dot + 1)]!;
};
/** A hint line, by its whole text ("… · Default 5m" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const queryHint = (whole: string) => screen.queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** `typed` with user-event's special characters (`{`, `[`) escaped. */
const escapeKeys = (typed: string) => typed.replace(/[{[]/g, (c) => c + c);

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, escapeKeys(typed));
  await user.tab();
}

/** Types into an empty field and leaves it. */
async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.click(input);
  await user.keyboard(escapeKeys(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

async function optionsOf(user: UserEvent, trigger: HTMLElement): Promise<string[]> {
  await user.click(trigger);
  const shown = screen.getAllByRole("option").map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return shown;
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${title}\\s*\\d*$`) }).at(-1)!);
}

/** Expands transform card `index` (0-based) of metricstransform. */
async function expandTransform(user: UserEvent, index: number) {
  const toggles = screen.getAllByRole("button", { name: /^(Expand|Collapse) transform$/ });
  if (toggles[index]!.getAttribute("aria-expanded") !== "true") await user.click(toggles[index]!);
}

/** Expands statsd mapping card `index` (0-based), by its header ("histogram → histogram"). */
async function expandMapping(user: UserEvent, index: number) {
  const headers = screen.getAllByRole("button", { name: /→/ });
  if (headers[index]!.getAttribute("aria-expanded") !== "true") await user.click(headers[index]!);
}

/** A box of cumulativetodelta (Include Metrics, Exclude Metrics), by its heading. */
const boxOf = (title: string) => screen.getByRole("heading", { name: title }).parentElement!;

/** A text holding `type`'s palette default under `subType`, in a metrics pipeline. */
function paletteText(type: ComponentType, subType: string, key = subType): string {
  const config = paletteDefaultConfig(findPaletteEntry(type, subType)!);
  return stringify({
    ...(type === "receiver" ? {} : { receivers: { otlp: { protocols: { grpc: null } } } }),
    [`${type}s`]: { [key]: config },
    exporters: { debug: {} },
    service: {
      pipelines: {
        metrics:
          type === "receiver"
            ? { receivers: [key], exporters: ["debug"] }
            : { receivers: ["otlp"], processors: [key], exporters: ["debug"] },
      },
    },
  });
}

/** A text of its own: `component` (its lines, at two spaces) under `section`, in a metrics pipeline. */
function ownText(section: "receivers" | "processors", key: string, lines: string): string {
  const isReceiver = section === "receivers";
  return [
    ...(isReceiver ? [] : ["receivers:", "  otlp:", "    protocols:", "      grpc:"]),
    `${section}:`,
    `  ${key}:${lines === "" ? " {}" : ""}`,
    ...(lines === "" ? [] : [lines.trimEnd()]),
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    "    metrics:",
    `      receivers: [${isReceiver ? key : "otlp"}]`,
    ...(isReceiver ? [] : [`      processors: [${key}]`]),
    "      exporters: [debug]",
    "",
  ].join("\n");
}

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: Value) => void;
}

const mapping = (value: Value, index: number) => (value.timer_histogram_mapping as Value[])[index]!;
const transform = (value: Value, index: number) => (value.transforms as Value[])[index]!;
const operation = (value: Value, t: number, o: number) => (transform(value, t).operations as Value[])[o]!;

const CASES: FieldCase[] = [
  // statsd
  {
    name: "statsd Transport (TCP keeps the default endpoint)",
    key: STATSD,
    edit: (user) => user.click(byId("transport-3")),
    from: "    transport: udp\n",
    to: "    transport: tcp\n",
    check: (v) => expect([v.transport, v.endpoint]).toEqual(["tcp", "localhost:8125"]),
  },
  {
    name: "statsd Endpoint",
    key: STATSD,
    edit: (user) => retypeInto(user, byId("endpoint"), "0.0.0.0:8125"),
    from: "    endpoint: localhost:8125\n",
    to: "    endpoint: 0.0.0.0:8125\n",
    check: (v) => expect(v.endpoint).toBe("0.0.0.0:8125"),
  },
  {
    name: "statsd Aggregation Interval",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Aggregation");
      await retypeInto(user, byId("aggregation_interval"), "30s");
    },
    from: "    aggregation_interval: 60s\n",
    to: "    aggregation_interval: 30s\n",
    check: (v) => expect(v.aggregation_interval).toBe("30s"),
  },
  {
    name: "statsd IP-Only Aggregation (unset)",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Aggregation");
      await user.click(byId("enable_ip_only_aggregation"));
    },
    from: "        observer_type: gauge\n  statsd/unix:\n",
    to: "        observer_type: gauge\n    enable_ip_only_aggregation: true\n  statsd/unix:\n",
    check: (v) => expect(v.enable_ip_only_aggregation).toBe(true),
  },
  {
    name: "statsd Metric Type Label",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Metric Processing");
      await user.click(byId("enable_metric_type"));
    },
    from: "    enable_metric_type: true\n",
    to: "    enable_metric_type: false\n",
    check: (v) => expect(v.enable_metric_type).toBe(false),
  },
  {
    name: "statsd Monotonic Counters",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Metric Processing");
      await user.click(byId("is_monotonic_counter"));
    },
    from: "    is_monotonic_counter: false\n",
    to: "    is_monotonic_counter: true\n",
    check: (v) => expect(v.is_monotonic_counter).toBe(true),
  },
  {
    name: "statsd Simple Tags (unset)",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Metric Processing");
      await user.click(byId("enable_simple_tags"));
    },
    from: "        observer_type: gauge\n  statsd/unix:\n",
    to: "        observer_type: gauge\n    enable_simple_tags: true\n  statsd/unix:\n",
    check: (v) => expect(v.enable_simple_tags).toBe(true),
  },
  {
    name: "statsd a mapping's StatsD Type",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Timer Mapping");
      await pickIn(user, byId("statsd_type_0"), "distribution");
    },
    from: "      - statsd_type: histogram\n",
    to: "      - statsd_type: distribution\n",
    check: (v) => expect(mapping(v, 0).statsd_type).toBe("distribution"),
  },
  {
    name: "statsd a mapping's Max Size",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Timer Mapping");
      await retypeInto(user, byId("max_size_0"), "200");
    },
    from: "          max_size: 100\n",
    to: "          max_size: 200\n",
    check: (v) => expect(mapping(v, 0).histogram).toEqual({ max_size: 200 }),
  },
  {
    name: "statsd a mapping's Percentiles, by item",
    key: STATSD,
    edit: async (user) => {
      await openSection(user, "Timer Mapping");
      await expandMapping(user, 1);
      await retypeInto(user, byId("percentiles_1"), "0, 50, 99.9");
    },
    from: "          percentiles: [0, 10, 50, 90, 95, 100]\n",
    to: "          percentiles: [0, 50, 99.9]\n",
    check: (v) => expect(mapping(v, 1).summary).toEqual({ percentiles: [0, 50, 99.9] }),
  },
  {
    name: "statsd/unix Socket Path",
    key: STATSD_UNIX,
    edit: (user) => retypeInto(user, byId("endpoint"), "/run/statsd.sock"),
    from: "    endpoint: /var/run/statsd.sock\n",
    to: "    endpoint: /run/statsd.sock\n",
    check: (v) => expect(v.endpoint).toBe("/run/statsd.sock"),
  },
  {
    name: "statsd/unix Socket Permissions, plain, its comment kept",
    key: STATSD_UNIX,
    edit: (user) => retypeInto(user, byId("socket_permissions"), "0644"),
    from: "    socket_permissions: 0622 # octal to the collector\n",
    to: "    socket_permissions: 0644 # octal to the collector\n",
    // YAML 1.2 reads 644; the collector's yaml.v3, octal 0o644.
    check: (v) => expect(v.socket_permissions).toBe(644),
  },
  // cumulativetodelta
  {
    name: "cumulativetodelta Initial Value Handling",
    key: CTD,
    edit: (user) => pickIn(user, byId("initial-value"), "Drop"),
    from: "    initial_value: auto\n",
    to: "    initial_value: drop\n",
    check: (v) => expect(v.initial_value).toBe("drop"),
  },
  {
    name: "cumulativetodelta an include metric, its comment kept",
    key: CTD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, within(boxOf("Include Metrics")).getAllByRole("textbox")[1]!, "system.disk.io");
    },
    from: "        - system.disk.operations # per device\n",
    to: "        - system.disk.io # per device\n",
    check: (v) => expect((v.include as Value).metrics).toEqual(["system.network.io", "system.disk.io"]),
  },
  {
    name: "cumulativetodelta the include Match Type",
    key: CTD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await pickIn(user, byId("include-match-type"), "Regexp (pattern match)");
    },
    from: "    include:\n      match_type: strict\n",
    to: "    include:\n      match_type: regexp\n",
    check: (v) => expect((v.include as Value).match_type).toBe("regexp"),
  },
  {
    name: "cumulativetodelta the exclude side's first metric, with match_type strict",
    key: CTD,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(within(boxOf("Exclude Metrics")).getByRole("button", { name: "Add Metric Name" }));
      await typeInto(user, byId("exclude-metrics"), "system.cpu.time");
    },
    from: "    initial_value: auto\n",
    to: "    initial_value: auto\n    exclude:\n      metrics:\n        - system.cpu.time\n      match_type: strict\n",
    check: (v) => expect(v.exclude).toEqual({ metrics: ["system.cpu.time"], match_type: "strict" }),
  },
  {
    name: "cumulativetodelta Max Staleness",
    key: CTD,
    edit: async (user) => {
      await openSection(user, "Advanced: Stream Limits");
      await retypeInto(user, byId("max-staleness"), "10m");
    },
    from: "    max_staleness: 5m\n",
    to: "    max_staleness: 10m\n",
    check: (v) => expect(v.max_staleness).toBe("10m"),
  },
  {
    name: "cumulative_to_delta/regexp a second exclude metric, in its flow list",
    key: CTD_REGEXP,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(within(boxOf("Exclude Metrics")).getByRole("button", { name: "Add Metric Name" }));
      await typeInto(user, within(boxOf("Exclude Metrics")).getAllByRole("textbox")[1]!, ".*_count");
    },
    from: '      metrics: [".*_total"]\n',
    to: '      metrics: [".*_total", .*_count]\n',
    check: (v) => expect(v.exclude).toEqual({ match_type: "regexp", metrics: [".*_total", ".*_count"] }),
  },
  // metricstransform
  {
    name: "metricstransform a transform's Metric",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 0);
      await retypeInto(user, byId("transform-0-include"), "system.cpu.utilization");
    },
    from: "      - include: system.cpu.usage\n",
    to: "      - include: system.cpu.utilization\n",
    check: (v) => expect(transform(v, 0).include).toBe("system.cpu.utilization"),
  },
  {
    name: "metricstransform a transform's Match Type (unset)",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 0);
      await pickIn(user, byId("transform-0-match-type"), "Regexp - Pattern");
    },
    from: "        new_name: system.cpu.usage_time\n",
    to: "        new_name: system.cpu.usage_time\n        match_type: regexp\n",
    check: (v) => expect(transform(v, 0).match_type).toBe("regexp"),
  },
  {
    name: "metricstransform a transform's Action",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 0);
      await pickIn(user, byId("transform-0-action"), "Insert - On a copy");
    },
    from: "        action: update\n",
    to: "        action: insert\n",
    check: (v) => expect(transform(v, 0).action).toBe("insert"),
  },
  {
    name: "metricstransform a transform's New Name",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 0);
      await retypeInto(user, byId("transform-0-new-name"), "system.cpu.time");
    },
    from: "        new_name: system.cpu.usage_time\n",
    to: "        new_name: system.cpu.time\n",
    check: (v) => expect(transform(v, 0).new_name).toBe("system.cpu.time"),
  },
  {
    name: "metricstransform an operation's New Label",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 1);
      await retypeInto(user, byId("t1-op0-new-label"), "release");
    },
    from: "            new_label: version\n",
    to: "            new_label: release\n",
    check: (v) => expect(operation(v, 1, 0).new_label).toBe("release"),
  },
  {
    name: "metricstransform an operation's New Value, a string",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 1);
      await retypeInto(user, byId("t1-op0-new-value"), "2.0");
    },
    from: '            new_value: "1.0"\n',
    to: '            new_value: "2.0"\n',
    check: (v) => expect(operation(v, 1, 0).new_value).toBe("2.0"),
  },
  {
    name: "metricstransform an operation's Label Set, in its flow list",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 1);
      const field = screen.getByText("Label Set", { selector: "label" }).parentElement!;
      await user.type(within(field).getByPlaceholderText("e.g. state"), "cpu{Enter}");
    },
    from: "            label_set: [state]\n",
    to: "            label_set: [state, cpu]\n",
    check: (v) => expect(operation(v, 1, 1).label_set).toEqual(["state", "cpu"]),
  },
  {
    name: "metricstransform an operation's Aggregation Type",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 1);
      await pickIn(user, byId("t1-op1-aggregation-type"), "mean");
    },
    from: "            aggregation_type: sum\n",
    to: "            aggregation_type: mean\n",
    check: (v) => expect(operation(v, 1, 1).aggregation_type).toBe("mean"),
  },
  {
    name: "metricstransform a combine's Aggregation Type, beside a key no field shows",
    key: MT,
    edit: async (user) => {
      await expandTransform(user, 2);
      await pickIn(user, byId("transform-2-aggregation-type"), "max");
    },
    from: "        submatch_case: lower\n        aggregation_type: sum\n",
    to: "        submatch_case: lower\n        aggregation_type: max\n",
    check: (v) => expect([transform(v, 2).aggregation_type, transform(v, 2).submatch_case]).toEqual(["max", "lower"]),
  },
  // groupbyattrs
  {
    name: "groupbyattrs a key added, in its flow list",
    key: GBA,
    edit: (user) => user.type(screen.getByPlaceholderText("e.g. host.name"), "service.name{Enter}"),
    from: "    keys: [host.name, k8s.pod.name]\n",
    to: "    keys: [host.name, k8s.pod.name, service.name]\n",
    check: (v) => expect(v.keys).toEqual(["host.name", "k8s.pod.name", "service.name"]),
  },
  {
    name: "groupbyattrs a key removed",
    key: GBA,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove" })[0]!),
    from: "    keys: [host.name, k8s.pod.name]\n",
    to: "    keys: [k8s.pod.name]\n",
    check: (v) => expect(v.keys).toEqual(["k8s.pod.name"]),
  },
];

describe("every field of each form writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(CORPUS) : CORPUS;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf(c.key));
      expect(infoToasts()).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

describe("opening writes nothing", () => {
  /** What each form shows once opened, at least: its text fields, every control, and a field. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [STATSD]: { textboxes: 4, all: 21, field: "percentiles_1" },
    [STATSD_UNIX]: { textboxes: 3, all: 14, field: "socket_permissions" },
    [CTD]: { textboxes: 3, all: 6, field: "exclude-match-type" },
    [CTD_REGEXP]: { textboxes: 2, all: 5, field: "max-staleness" },
    [MT]: { textboxes: 10, all: 20, field: "t1-op1-aggregation-type" },
    [GBA]: { textboxes: 3, all: 3, field: "" },
    [GBA_COMPACT]: { textboxes: 1, all: 1, field: "" },
  };
  // One test per form and text, each with its own time limit.
  it.each(Object.keys(OPENED).flatMap((key) => [[key, "LF", CORPUS] as const, [key, "CRLF", CRLF(CORPUS)] as const]))(
    "opening %s (%s), every section and card, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      const { textboxes, all } = formControls();
      expect(textboxes.length).toBeGreaterThanOrEqual(OPENED[key]!.textboxes);
      expect(all).toBeGreaterThanOrEqual(OPENED[key]!.all);
      if (OPENED[key]!.field !== "") expect(document.getElementById(OPENED[key]!.field)).not.toBeNull();
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );
});

// ── statsd ──

/** A statsd receiver of its own. */
const statsdText = (lines: string) => ownText("receivers", "statsd", lines);

describe("StatsdReceiverForm: transport and socket", () => {
  it("offers the collector's seven transports (internal/transport/transport.go:17-25), udp checked while unset (factory.go:40-43)", () => {
    renderForm(STATSD, statsdText("    aggregation_interval: 60s\n"));
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(["udp", "udp4", "udp6", "tcp", "tcp4", "tcp6", "unixgram"]);
    expect(radios.map((radio) => radio.closest("label")!.textContent)).toEqual([
      "UDP",
      "UDP (IPv4)",
      "UDP (IPv6)",
      "TCP",
      "TCP (IPv4)",
      "TCP (IPv6)",
      "Unix Socket",
    ]);
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["udp"]);
    expect(radios.every((radio) => radio.name === "transport")).toBe(true);
  });

  // The deliberate break: a quoted seed ("0622") fails this test.
  it("Unix Socket writes socket_permissions plain 0622 with the socket endpoint, one entry (config.go:34 is an os.FileMode)", async () => {
    const before = statsdText("    endpoint: localhost:8125\n    transport: udp\n");
    const user = renderForm(STATSD, before);
    await user.click(byId("transport-6"));
    expect(text()).toBe(
      before.replace(
        "    endpoint: localhost:8125\n    transport: udp\n",
        "    endpoint: /var/run/statsd-receiver.sock\n    transport: unixgram\n    socket_permissions: 0622\n",
      ),
    );
    expect(text()).not.toMatch(/socket_permissions: ["']/);
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
    // The field shows it as written, with the default's hint.
    expect(byId("socket_permissions")).toHaveValue("0622");
    expect(hint("Octal file mode. · Default 0622")).toBeInTheDocument();
  });

  it("0622 stays plain through the radio seed, typing, an unchanged blur and undo", async () => {
    const before = statsdText("    transport: udp\n");
    const user = renderForm(STATSD, before);
    await user.click(byId("transport-6"));
    const seeded = text();
    expect(seeded).toContain("    socket_permissions: 0622\n");

    // Focusing and leaving writes nothing; retyping the same characters writes nothing.
    stepPastRuns();
    await user.click(byId("socket_permissions"));
    await user.tab();
    await retypeInto(user, byId("socket_permissions"), "0622");
    expect(text()).toBe(seeded);
    expect(entries()).toBe(1);

    await retypeInto(user, byId("socket_permissions"), "0600");
    expect(text()).toContain("    socket_permissions: 0600\n");
    stepPastRuns();
    await retypeInto(user, byId("socket_permissions"), "0622");
    expect(text()).toBe(seeded);
    expect(entries()).toBe(3);

    act(() => void builderStore().undo());
    act(() => void builderStore().undo());
    expect(text()).toBe(seeded);
    act(() => void builderStore().undo());
    expect(text()).toBe(before);
    act(() => void builderStore().redo());
    expect(text()).toBe(seeded);
  });

  it("a quoted socket_permissions (\"0622\", refused) has the hint; retyping the same characters writes it plain", async () => {
    const before = statsdText('    transport: unixgram\n    endpoint: /var/run/statsd-receiver.sock\n    socket_permissions: "0622" # mode\n');
    const user = renderForm(STATSD, before);
    expect(screen.getByText(SOCKET_PERMISSIONS_STRING_HINT)).toBeInTheDocument();
    expect(byId("socket_permissions")).toHaveValue("0622");

    // Focusing and leaving still writes nothing.
    await user.click(byId("socket_permissions"));
    await user.tab();
    expect(text()).toBe(before);

    await retypeInto(user, byId("socket_permissions"), "0622");
    expect(text()).toBe(before.replace('    socket_permissions: "0622" # mode\n', "    socket_permissions: 0622 # mode\n"));
    expect(entries()).toBe(1);
    expect(screen.queryByText(SOCKET_PERMISSIONS_STRING_HINT)).toBeNull();
  });

  it("a quoted reference or a mode the collector reads anyway has no hint", () => {
    renderForm(STATSD, statsdText('    transport: unixgram\n    socket_permissions: "${env:MODE}"\n'));
    expect(screen.queryByText(SOCKET_PERMISSIONS_STRING_HINT)).toBeNull();
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(STATSD, statsdText("    transport: unixgram\n    socket_permissions: 0600\n"));
    expect(screen.queryByText(SOCKET_PERMISSIONS_STRING_HINT)).toBeNull();
  });

  it("Unix Socket keeps a socket_permissions the text has; a custom endpoint is kept on every switch", async () => {
    const user = renderForm(STATSD_UNIX);
    await user.click(byId("transport-0"));
    // The person's own socket path stays, and so does the mode.
    expect(valueOf(STATSD_UNIX)).toEqual({ endpoint: "/var/run/statsd.sock", transport: "udp", socket_permissions: 622 });
    expect(text()).toContain("    socket_permissions: 0622 # octal to the collector\n");
    await user.click(byId("transport-6"));
    expect(valueOf(STATSD_UNIX)).toEqual({ endpoint: "/var/run/statsd.sock", transport: "unixgram", socket_permissions: 622 });
    expect(text()).toBe(CORPUS);

    cleanup();
    useEditorStore.setState(initialState, true);
    const own = statsdText("    endpoint: 0.0.0.0:9125\n    transport: udp\n");
    const user2 = renderForm(STATSD, own);
    await user2.click(byId("transport-3"));
    expect(text()).toBe(own.replace("transport: udp", "transport: tcp"));
    await user2.click(byId("transport-6"));
    expect(valueOf(STATSD)).toEqual({ endpoint: "0.0.0.0:9125", transport: "unixgram", socket_permissions: 622 });
  });

  it("a switch writes the transport's default endpoint while the endpoint is unset or the other default (the seeds)", async () => {
    const unset = statsdText("    transport: udp\n");
    const user = renderForm(STATSD, unset);
    await user.click(byId("transport-4"));
    expect(valueOf(STATSD)).toEqual({ transport: "tcp4", endpoint: "localhost:8125" });
    stepPastRuns();
    await user.click(byId("transport-6"));
    expect(valueOf(STATSD)).toEqual({ transport: "unixgram", endpoint: "/var/run/statsd-receiver.sock", socket_permissions: 622 });
    stepPastRuns();
    await user.click(byId("transport-2"));
    expect(valueOf(STATSD)).toEqual({ transport: "udp6", endpoint: "localhost:8125", socket_permissions: 622 });
    expect(entries()).toBe(3);
  });

  it("shows the collector's defaults as placeholders and hints (factory.go:20-25); the socket's field only for a Unix socket", async () => {
    const user = renderForm(STATSD, statsdText("    enable_metric_type: true\n"));
    expect(byId("endpoint")).toHaveAttribute("placeholder", "localhost:8125");
    expect(byId("endpoint")).toHaveValue("");
    expect(hint("host:port to listen on. · Default localhost:8125")).toBeInTheDocument();
    expect(screen.getByText("Endpoint", { selector: "label" })).toBeInTheDocument();
    expect(document.getElementById("socket_permissions")).toBeNull();
    await openSection(user, "Aggregation");
    expect(byId("aggregation_interval")).toHaveAttribute("placeholder", "60s");
    expect(hint("Window for aggregating metrics before flushing downstream. · Default 60s")).toBeInTheDocument();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(STATSD, statsdText("    transport: unixgram\n"));
    expect(screen.getByText("Socket Path", { selector: "label" })).toBeInTheDocument();
    expect(byId("endpoint")).toHaveAttribute("placeholder", "e.g. /var/run/statsd-receiver.sock");
    expect(byId("socket_permissions")).toHaveAttribute("placeholder", "0622");
    expect(byId("socket_permissions")).toHaveValue("");
  });

  it("a transport outside the seven is read-only with the unshowable-value hint", () => {
    renderForm(STATSD, statsdText("    transport: sctp\n"));
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).every((radio) => radio.disabled && !radio.checked)).toBe(true);
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });
});

// ── Sortable cards by keyboard ──

const ROW_HEIGHT = 40;

/** The sortable card an element is in: a child of a `space-y-2` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (parent?.classList.contains("space-y-2") && [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))) {
      return e;
    }
  }
  return null;
}

/** dnd-kit measures rows; jsdom's are all zero, so cards are laid out 40 px apart. */
function layOutRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = rowOf(this);
    const index = row ? [...row.parentElement!.children].indexOf(row) : 0;
    const top = index * ROW_HEIGHT;
    return { x: 0, y: top, top, left: 0, right: 200, bottom: top + ROW_HEIGHT, width: 200, height: ROW_HEIGHT, toJSON: () => ({}) } as DOMRect;
  });
}

async function press(element: Element, key: string, code = key) {
  await act(async () => {
    fireEvent.keyDown(element, { key, code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Drags handle `handle` by keyboard: Space, `steps` arrows, Space. */
async function dragByKeyboard(handle: HTMLElement, steps: number) {
  act(() => handle.focus());
  await press(handle, " ", "Space");
  for (let i = 0; i < Math.abs(steps); i++) await press(handle, steps > 0 ? "ArrowDown" : "ArrowUp");
  await press(handle, " ", "Space");
}

describe("StatsdReceiverForm: the mappings", () => {
  it("Observer Type away from histogram removes the histogram block, one entry, with the toast (config.go:90-95)", async () => {
    const user = renderForm(STATSD);
    await openSection(user, "Timer Mapping");
    await pickIn(user, byId("observer_type_0"), "gauge");
    expect(text()).toBe(
      CORPUS.replace(
        "        observer_type: histogram\n        histogram:\n          max_size: 100\n",
        "        observer_type: gauge\n",
      ),
    );
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_HISTOGRAM]);
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("Observer Type away from summary removes the summary block, its comment line kept, one entry, with the toast (config.go:96-105)", async () => {
    const user = renderForm(STATSD);
    await openSection(user, "Timer Mapping");
    await expandMapping(user, 1);
    await pickIn(user, byId("observer_type_1"), "histogram");
    expect(text()).toBe(
      CORPUS.replace(
        "        observer_type: summary\n        summary:\n          percentiles: [0, 10, 50, 90, 95, 100]\n",
        "        observer_type: histogram\n",
      ),
    );
    expect(mapping(valueOf(STATSD), 1)).toEqual({ statsd_type: "timing", observer_type: "histogram" });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_SUMMARY]);
    // Histogram's field shows, unset: the collector's default 160.
    expect(byId("max_size_1")).toHaveAttribute("placeholder", "160");
    expect(byId("max_size_1")).toHaveValue("");
    expect(within(rowOf(byId("max_size_1"))!).getByText("Default", { exact: false })).toHaveTextContent(
      "Bucket limit for the exponential histogram. · Default 160",
    );
  });

  it("Observer Type with no block to remove writes the type alone, with no toast", async () => {
    const user = renderForm(STATSD);
    await openSection(user, "Timer Mapping");
    await expandMapping(user, 2);
    await pickIn(user, byId("observer_type_2"), "summary");
    expect(text()).toBe(CORPUS.replace("        observer_type: gauge\n", "        observer_type: summary\n"));
    expect(infoToasts()).toEqual([]);
    expect(byId("percentiles_2")).toHaveAttribute("placeholder", "0, 10, 50, 90, 95, 100");
  });

  it("a refused mapping holding both blocks loses each the new type refuses, both named in the toast", async () => {
    const before = statsdText(
      "    timer_histogram_mapping:\n      - statsd_type: timer\n        observer_type: histogram\n        histogram: {max_size: 10}\n        summary: {percentiles: [50]}\n",
    );
    const user = renderForm(STATSD, before);
    await openSection(user, "Timer Mapping");
    await pickIn(user, byId("observer_type_0"), "gauge");
    expect(mapping(valueOf(STATSD), 0)).toEqual({ statsd_type: "timer", observer_type: "gauge" });
    expect(infoToasts()).toEqual([`${REMOVED_HISTOGRAM} ${REMOVED_SUMMARY}`]);
    expect(entries()).toBe(1);
  });

  it("Add Mapping on an unset list writes one seeded mapping, expanded; the empty state names the collector's defaults", async () => {
    const before = statsdText("    transport: udp\n");
    const user = renderForm(STATSD, before);
    await openSection(user, "Timer Mapping");
    expect(screen.getByText(NO_MAPPINGS)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Mapping" }));
    expect(valueOf(STATSD).timer_histogram_mapping).toEqual([{ statsd_type: "histogram", observer_type: "histogram", histogram: { max_size: 100 } }]);
    expect(entries()).toBe(1);
    expect(screen.queryByText(NO_MAPPINGS)).toBeNull();
    expect(byId("max_size_0")).toHaveValue("100");
  });

  it("Add Mapping appends the seed and expands it; removing a mapping removes its lines, the expanded card staying its own", async () => {
    const user = renderForm(STATSD);
    await openSection(user, "Timer Mapping");
    await user.click(screen.getByRole("button", { name: "Add Mapping" }));
    expect((valueOf(STATSD).timer_histogram_mapping as Value[]).length).toBe(4);
    expect(document.getElementById("max_size_3")).not.toBeNull();

    stepPastRuns();
    await user.click(screen.getAllByRole("button", { name: "Remove mapping" })[0]!);
    expect((valueOf(STATSD).timer_histogram_mapping as Value[]).map((m) => m.statsd_type)).toEqual(["timing", "distribution", "histogram"]);
    expect(text()).toContain("      - statsd_type: timing # timers as summaries\n");
    // The removed card was the open one; the added card, now the third, is still open.
    expect(document.getElementById("max_size_2")).not.toBeNull();
    expect(document.getElementById("percentiles_0")).toBeNull();
    expect(entries()).toBe(2);
  });

  it("removing the last mapping leaves [], which maps nothing: the empty state", async () => {
    const before = statsdText("    timer_histogram_mapping:\n      - statsd_type: timer\n        observer_type: gauge\n");
    const user = renderForm(STATSD, before);
    await openSection(user, "Timer Mapping");
    await user.click(screen.getByRole("button", { name: "Remove mapping" }));
    expect(valueOf(STATSD).timer_histogram_mapping).toEqual([]);
    expect(screen.getByText(EMPTY_MAPPINGS)).toBeInTheDocument();
    expect(screen.queryByText(NO_MAPPINGS)).toBeNull();
  });

  it("dragging a mapping by keyboard moves its lines and comment, its expanded state with it", async () => {
    layOutRows();
    const user = renderForm(STATSD);
    await openSection(user, "Timer Mapping");
    const [first] = screen.getAllByRole("button", { name: "Drag to reorder" });
    await dragByKeyboard(first!, 1);
    expect((valueOf(STATSD).timer_histogram_mapping as Value[]).map((m) => m.statsd_type)).toEqual(["timing", "histogram", "distribution"]);
    expect(text()).toContain(
      "      - statsd_type: timing # timers as summaries\n        observer_type: summary\n        summary:\n          percentiles: [0, 10, 50, 90, 95, 100]\n      - statsd_type: histogram\n",
    );
    expect(entries()).toBe(1);
    // The open card moved with its mapping: the histogram one, now second.
    expect(document.getElementById("max_size_1")).not.toBeNull();
    expect(document.getElementById("percentiles_0")).toBeNull();
  });

  it("Max Size cleared removes max_size, and the histogram block with it (never null)", async () => {
    const user = renderForm(STATSD);
    await openSection(user, "Timer Mapping");
    await retypeInto(user, byId("max_size_0"), "");
    expect(text()).toBe(CORPUS.replace("        histogram:\n          max_size: 100\n", ""));
    expect(entries()).toBe(1);
  });

  it("Percentiles cleared removes percentiles, and the summary block with it", async () => {
    const user = renderForm(STATSD);
    await openSection(user, "Timer Mapping");
    await expandMapping(user, 1);
    await retypeInto(user, byId("percentiles_1"), "");
    expect(text()).toBe(CORPUS.replace("        summary:\n          percentiles: [0, 10, 50, 90, 95, 100]\n", ""));
  });

  it("a mapping that isn't a mapping is read-only with the unshowable-value hint; the list that isn't a list disables Add", async () => {
    const user = renderForm(STATSD, statsdText("    timer_histogram_mapping:\n      - timer\n"));
    await openSection(user, "Timer Mapping");
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    cleanup();
    useEditorStore.setState(initialState, true);
    const user2 = renderForm(STATSD, statsdText("    timer_histogram_mapping: none\n"));
    await openSection(user2, "Timer Mapping");
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Mapping" })).toBeDisabled();
  });

  it("a mapping card lacking both types is labeled Mapping <n>; one with a type keeps its arrow", async () => {
    const user = renderForm(
      STATSD,
      statsdText("    timer_histogram_mapping:\n      - statsd_type: timer\n        observer_type: gauge\n      - histogram:\n          max_size: 10\n      - timer\n"),
    );
    await openSection(user, "Timer Mapping");
    const toggles = screen.getAllByRole("button", { expanded: true }).concat(screen.getAllByRole("button", { expanded: false }));
    const names = toggles.map((b) => b.textContent ?? "").filter((t) => t.includes("→") || /^Mapping \d$/.test(t));
    expect(names.sort()).toEqual(["Mapping 2", "Mapping 3", "timer → gauge"]);
  });
});

describe("StatsdReceiverForm: percentiles typed", () => {
  /** The summary mapping's text, its percentiles as given. */
  const summaryText = (percentiles: string) =>
    statsdText(`    timer_histogram_mapping:\n      - statsd_type: timing\n        observer_type: summary\n        summary:\n          percentiles: ${percentiles}\n`);

  /** Types `typed` at the field's end, as keystrokes do (the field's value grows). */
  const typeAtEnd = (field: HTMLElement, typed: string) =>
    act(() => void fireEvent.change(field, { target: { value: (field as HTMLInputElement).value + typed } }));
  const pause = () => act(() => void vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS + 100));

  it("shows the list joined \", \"; a draft ending in \", \" waits past the pause, and the next item is written after it", () => {
    const before = summaryText("[50, 90]");
    renderForm(STATSD, before);
    fireEvent.click(screen.getByRole("button", { name: /^Timer Mapping/ }));
    vi.useFakeTimers();
    const field = byId("percentiles_0");
    expect(field).toHaveValue("50, 90");

    typeAtEnd(field, ",");
    pause();
    typeAtEnd(field, " ");
    pause();
    expect(text()).toBe(before);
    expect(field).toHaveValue("50, 90, ");

    typeAtEnd(field, "99");
    pause();
    expect(text()).toBe(before.replace("percentiles: [50, 90]", "percentiles: [50, 90, 99]"));
    expect(field).toHaveValue("50, 90, 99");
    expect(entries()).toBe(1);
  });

  it("a draft spaced otherwise (\"50,99\") is written only on blur, by item, and then shows joined \", \"", () => {
    const before = summaryText("[50]");
    renderForm(STATSD, before);
    fireEvent.click(screen.getByRole("button", { name: /^Timer Mapping/ }));
    vi.useFakeTimers();
    const field = byId("percentiles_0");
    typeAtEnd(field, ",99");
    pause();
    expect(text()).toBe(before);
    expect(field).toHaveValue("50,99");

    act(() => void fireEvent.blur(field));
    expect(text()).toBe(before.replace("percentiles: [50]", "percentiles: [50, 99]"));
    expect(field).toHaveValue("50, 99");
    expect(entries()).toBe(1);
  });

  it("each item is written as typed: a number plain, anything else as a string (the config validation checks the range)", async () => {
    const before = summaryText("[50]");
    const user = renderForm(STATSD, before);
    await openSection(user, "Timer Mapping");
    await retypeInto(user, byId("percentiles_0"), "50, 150, ${env:P}");
    expect((mapping(valueOf(STATSD), 0).summary as Value).percentiles).toEqual([50, 150, "${env:P}"]);
  });
});

// ── cumulativetodelta ──

const ctdText = (lines: string) => ownText("processors", "cumulativetodelta", lines);

describe("CumulativeToDeltaProcessorForm", () => {
  it("has no Max Streams control (config.go:28-53 has no max_streams; refused); one in the text is left alone", async () => {
    const before = ctdText("    max_streams: 10\n    max_staleness: 5m\n");
    const user = renderForm(CTD, before);
    await openSection(user, "Advanced: Stream Limits");
    expect(screen.queryByText("Max Streams")).toBeNull();
    expect(document.getElementById("max-streams")).toBeNull();
    await retypeInto(user, byId("max-staleness"), "1m");
    expect(text()).toBe(before.replace("max_staleness: 5m", "max_staleness: 1m"));
  });

  it("shows the collector's defaults: Initial Value blank, Default auto (config.go:32-37); Max Staleness Default 1h (factory.go:33-37); the alert names it", async () => {
    const user = renderForm(CTD, ctdText(""));
    expect(byId("initial-value")).toHaveTextContent("Auto");
    expect(hint("Auto decides per metric; drop avoids large initial deltas. · Default auto")).toBeInTheDocument();
    await openSection(user, "Advanced: Stream Limits");
    expect(byId("max-staleness")).toHaveValue("");
    expect(byId("max-staleness")).toHaveAttribute("placeholder", "e.g. 5m");
    expect(hint("Drop streams idle for this long. · Default 1h")).toBeInTheDocument();
    expect(screen.getByText(MEMORY_ALERT)).toBeInTheDocument();
    expect(screen.queryByText(/max_streams/)).toBeNull();
    expect(screen.getByText("Unbounded memory")).toBeInTheDocument();
  });

  it("Add Metric Name holds a row: nothing written; its first metric writes the side with match_type: strict, one entry (config.go:60-63)", async () => {
    const before = ctdText("    max_staleness: 5m\n");
    const user = renderForm(CTD, before);
    await openSection(user, "Filtering");
    expect(byId("include-match-type")).toHaveTextContent("Strict (exact match)");
    await user.click(within(boxOf("Include Metrics")).getByRole("button", { name: "Add Metric Name" }));
    expect(text()).toBe(before);
    await typeInto(user, byId("include-metrics"), "system.cpu.time");
    expect(text()).toBe(before.replace("    max_staleness: 5m\n", "    max_staleness: 5m\n    include:\n      metrics:\n        - system.cpu.time\n      match_type: strict\n"));
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
  });

  it("a match chosen on a side with no metrics is held (config.go:64-67 refuses it alone), then written with the first metric", async () => {
    const before = ctdText("    max_staleness: 5m\n");
    const user = renderForm(CTD, before);
    await openSection(user, "Filtering");
    await pickIn(user, byId("exclude-match-type"), "Regexp (pattern match)");
    expect(text()).toBe(before);
    expect(byId("exclude-match-type")).toHaveTextContent("Regexp (pattern match)");
    expect(within(boxOf("Exclude Metrics")).getByText("Go regular expressions; exclude wins over include.")).toBeInTheDocument();

    await user.click(within(boxOf("Exclude Metrics")).getByRole("button", { name: "Add Metric Name" }));
    await typeInto(user, byId("exclude-metrics"), ".*_total");
    expect(valueOf(CTD).exclude).toEqual({ metrics: [".*_total"], match_type: "regexp" });
    expect(entries()).toBe(1);
    // The include side's match is its own.
    expect(byId("include-match-type")).toHaveTextContent("Strict (exact match)");
  });

  it("removing a side's last metric removes metrics and match_type, and the block with them, one entry", async () => {
    const user = renderForm(CTD_REGEXP);
    await openSection(user, "Filtering");
    await user.click(within(boxOf("Exclude Metrics")).getByRole("button", { name: "Remove" }));
    // The component left with no keys is written `{}` (the text edits'), as the collector reads none.
    expect(text()).toBe(CORPUS.replace('  cumulative_to_delta/regexp:\n    exclude:\n      match_type: regexp\n      metrics: [".*_total"]\n', "  cumulative_to_delta/regexp: {}\n"));
    expect(valueOf(CTD_REGEXP)).toEqual({});
    expect(entries()).toBe(1);
    // The side shows unset again: no rows, the first item's match.
    expect(byId("exclude-match-type")).toHaveTextContent("Strict (exact match)");
  });

  it("the last metric's removal keeps the side's keys no field shows (metric_types), the block with them", async () => {
    const before = ctdText("    include:\n      match_type: strict\n      metrics: [a]\n      metric_types: [sum] # sums only\n");
    const user = renderForm(CTD, before);
    await openSection(user, "Filtering");
    await user.click(within(boxOf("Include Metrics")).getByRole("button", { name: "Remove" }));
    expect(valueOf(CTD).include).toEqual({ metric_types: ["sum"] });
    expect(text()).toContain("    include:\n      metric_types: [sum] # sums only\n");
  });

  it("a row emptied and left removes its metric; the last one so takes match_type with it, never writing \"\"", async () => {
    const before = ctdText("    include:\n      match_type: strict\n      metrics: [a, b]\n");
    const user = renderForm(CTD, before);
    await openSection(user, "Filtering");
    await retypeInto(user, within(boxOf("Include Metrics")).getAllByRole("textbox")[0]!, "");
    expect(valueOf(CTD).include).toEqual({ match_type: "strict", metrics: ["b"] });
    stepPastRuns();
    await retypeInto(user, within(boxOf("Include Metrics")).getAllByRole("textbox")[0]!, "");
    expect(valueOf(CTD)).toEqual({});
    expect(text()).not.toContain('""');
  });

  it("a side with metrics and no match_type (refused) shows the match blank; its next metric is written with strict", async () => {
    const before = ctdText("    include:\n      metrics: [a]\n");
    const user = renderForm(CTD, before);
    await openSection(user, "Filtering");
    expect(byId("include-match-type")).toHaveTextContent("Select match type");
    await user.click(within(boxOf("Include Metrics")).getByRole("button", { name: "Add Metric Name" }));
    await typeInto(user, within(boxOf("Include Metrics")).getAllByRole("textbox")[1]!, "b");
    expect(valueOf(CTD).include).toEqual({ metrics: ["a", "b"], match_type: "strict" });

    // Choosing a match beside metrics writes it.
    cleanup();
    useEditorStore.setState(initialState, true);
    const user2 = renderForm(CTD, before);
    await openSection(user2, "Filtering");
    await pickIn(user2, byId("include-match-type"), "Regexp (pattern match)");
    expect(valueOf(CTD).include).toEqual({ metrics: ["a"], match_type: "regexp" });
  });

  it("the cumulative_to_delta spelling opens this form; the Filtering count is both sides' metrics", async () => {
    expect(formFor("processor", "cumulative_to_delta")).toBe(CumulativeToDeltaProcessorForm);
    renderForm(CTD);
    expect(screen.getByRole("button", { name: /^Filtering/ })).toHaveTextContent("2");
  });

  it("a side that isn't a mapping is read-only with the unshowable-value hint", async () => {
    const user = renderForm(CTD, ctdText("    include: everything\n"));
    await openSection(user, "Filtering");
    expect(within(boxOf("Include Metrics")).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(within(boxOf("Exclude Metrics")).queryByText(UNSHOWABLE_VALUE_MESSAGE)).toBeNull();
  });
});

// ── metricstransform ──

const mtText = (lines: string, key = "metricstransform") => ownText("processors", key, lines);

describe("MetricsTransformProcessorForm cases", () => {
  it("renders the default transform expanded with its metric name", () => {
    renderForm(MT, paletteText("processor", "metricstransform"));
    expect([...document.querySelectorAll("input")].find((input) => input.value === "system.cpu.usage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse transform" })).toHaveAttribute("aria-expanded", "true");
  });

  it("says metrics pass through with no transforms (the empty alert's copy changed: no transform is accepted, factory.go:34-36)", () => {
    renderForm(MT, mtText(""));
    expect(screen.getByText(NO_TRANSFORMS)).toBeInTheDocument();
    expect(screen.queryByText(/an empty metrics transform processor/)).toBeNull();
  });

  it("edits a transform with operations in place: only the edited lines change (was: generates valid YAML and round-trips)", async () => {
    const before = mtText(
      [
        "    transforms:",
        "      - include: system.cpu.usage",
        "        match_type: strict",
        "        action: update",
        "        operations:",
        "          - action: update_label",
        "            label: state",
        "            new_label: cpu_state",
        "          - action: aggregate_label_values",
        "            label: cpu_state",
        "            aggregated_values: [user, system]",
        "            new_value: used",
        "            aggregation_type: sum",
        "",
      ].join("\n"),
    );
    const user = renderForm(MT, before);
    await retypeInto(user, byId("t0-op0-label"), "cpu");
    stepPastRuns();
    await pickIn(user, byId("t0-op1-aggregation-type"), "max");
    expect(text()).toBe(before.replace("            label: state\n", "            label: cpu\n").replace("aggregation_type: sum", "aggregation_type: max"));
    const ops = transform(valueOf(MT), 0).operations as Value[];
    expect(ops).toHaveLength(2);
    expect(ops[1]!.aggregation_type).toBe("max");
    expect(entries()).toBe(2);
  });

  it("opens the collector's metrics_transform spelling in this form, and edits it", async () => {
    expect(formFor("processor", "metrics_transform")).toBe(MetricsTransformProcessorForm);
    const before = mtText("    transforms:\n      - include: system.cpu.usage\n        action: update\n        new_name: system.cpu.usage_time\n", "metrics_transform");
    const user = renderForm("processors.metrics_transform", before);
    await retypeInto(user, byId("transform-0-new-name"), "system.cpu.time");
    expect(text()).toBe(before.replace("new_name: system.cpu.usage_time", "new_name: system.cpu.time"));
    expect(transform(valueOf("processors.metrics_transform"), 0).new_name).toBe("system.cpu.time");
  });
});

describe("MetricsTransformProcessorForm: held cards", () => {
  it("Add Transform holds a card; its metric typed writes {include, match_type: strict, action: update} as one entry, the card keeping focus", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    expect(text()).toBe(before);
    expect(screen.getByText("update (configure metric)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Transform" })).toBeDisabled();
    // Its operations come once it is written.
    expect(screen.getAllByRole("button", { name: "Add Operation" }).map((button) => (button as HTMLButtonElement).disabled)).toEqual([false, true]);

    const include = byId("transform-1-include");
    await user.click(include);
    await user.keyboard("b");
    await user.tab({ shift: true });
    expect(text()).toBe(before.replace("        action: update\n", "        action: update\n      - include: b\n        match_type: strict\n        action: update\n"));
    expect(entries()).toBe(1);
    expect(byId("transform-1-include")).toBe(include);
    expect(screen.getByRole("button", { name: "Add Transform" })).toBeEnabled();
  });

  it("a held transform's action is held with it; Combine's aggregation type comes with it, toasted once when written", async () => {
    const before = mtText("");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    expect(screen.queryByText(NO_TRANSFORMS)).toBeNull();
    await pickIn(user, byId("transform-0-action"), "Combine - Merge matches");
    expect(text()).toBe(before);
    expect(infoToasts()).toEqual([]);
    expect(byId("transform-0-aggregation-type")).toHaveTextContent("sum");

    await typeInto(user, byId("transform-0-include"), "^disk\\..*");
    expect(valueOf(MT).transforms).toEqual([{ include: "^disk\\..*", match_type: "strict", action: "combine", aggregation_type: "sum" }]);
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([COMBINE_SUM]);
  });

  it("a held transform's Remove writes nothing; nothing empty is ever written", async () => {
    const before = mtText("    transforms: []\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-0-match-type"), "Regexp - Pattern");
    await user.click(screen.getByRole("button", { name: "Remove transform" }));
    expect(text()).toBe(before);
    expect(entries()).toBe(0);
    expect(screen.getByText(NO_TRANSFORMS)).toBeInTheDocument();
  });

  it("Add Operation holds an operation (add_label shown); its action is held; the first field typed writes {action, field} (factory.go:119-127)", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Operation" }));
    expect(text()).toBe(before);
    const action = screen.getByRole("combobox", { name: "Operation action" });
    expect(action).toHaveTextContent("Add label");
    await pickIn(user, action, "Rename label key");
    expect(text()).toBe(before);
    expect(document.getElementById("t0-op0-new-value")).toBeNull();

    await typeInto(user, byId("t0-op0-label"), "state");
    expect(text()).toBe(before.replace("        action: update\n", "        action: update\n        operations:\n          - action: update_label\n            label: state\n"));
    expect(entries()).toBe(1);
    // A second field writes into the item.
    stepPastRuns();
    await typeInto(user, byId("t0-op0-new-label"), "cpu_state");
    expect(operation(valueOf(MT), 0, 0)).toEqual({ action: "update_label", label: "state", new_label: "cpu_state" });
  });

  it("a held operation's Toggle int/double data type (no other field) writes {action} at once, one entry; Add Operation is enabled again", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Operation" }));
    await pickIn(user, screen.getByRole("combobox", { name: "Operation action" }), "Toggle int/double data type");
    expect(text()).toBe(before.replace("        action: update\n", "        action: update\n        operations:\n          - action: toggle_scalar_data_type\n"));
    expect(entries()).toBe(1);
    expect(screen.getByRole("button", { name: "Add Operation" })).toBeEnabled();
    expect(screen.getAllByRole("combobox", { name: "Operation action" })).toHaveLength(1);
  });

  it("a held operation's Label Set item writes {action: aggregate_labels, label_set: [item]}", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n        operations:\n          - action: toggle_scalar_data_type\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Operation" }));
    await pickIn(user, screen.getAllByRole("combobox", { name: "Operation action" })[1]!, "Aggregate across labels");
    const field = screen.getByText("Label Set", { selector: "label" }).parentElement!;
    await user.type(within(field).getByPlaceholderText("e.g. state"), "state{Enter}");
    expect(transform(valueOf(MT), 0).operations).toEqual([
      { action: "toggle_scalar_data_type" },
      { action: "aggregate_labels", label_set: ["state"] },
    ]);
    expect(entries()).toBe(1);
  });
});

describe("MetricsTransformProcessorForm: a held card's toasts", () => {
  it("Combine in a held transform toasts nothing; its metric typed writes aggregation_type: sum and toasts once", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-1-action"), "Combine - Merge matches");
    expect(text()).toBe(before);
    expect(infoToasts()).toEqual([]);
    // Chosen again (away and back): still held, still one message.
    await pickIn(user, byId("transform-1-action"), "Insert - On a copy");
    await pickIn(user, byId("transform-1-action"), "Combine - Merge matches");
    expect(infoToasts()).toEqual([]);

    await typeInto(user, byId("transform-1-include"), "b");
    expect(transform(valueOf(MT), 1)).toEqual({ include: "b", match_type: "strict", action: "combine", aggregation_type: "sum" });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([COMBINE_SUM]);
  });

  it("Combine in a held transform, then Aggregation Type mean: the write writes mean and says nothing of sum", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-1-action"), "Combine - Merge matches");
    await pickIn(user, byId("transform-1-aggregation-type"), "mean");
    expect(text()).toBe(before);
    // Combine chosen again: the key is set, so nothing is set and nothing held.
    await pickIn(user, byId("transform-1-action"), "Insert - On a copy");
    await pickIn(user, byId("transform-1-action"), "Combine - Merge matches");
    expect(infoToasts()).toEqual([]);

    await typeInto(user, byId("transform-1-include"), "b");
    expect(transform(valueOf(MT), 1)).toEqual({ include: "b", match_type: "strict", action: "combine", aggregation_type: "mean" });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
  });

  it("Combine and Group held, then Aggregation Type chosen: only Group's message comes with the write", async () => {
    const before = mtText("");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-0-action"), "Combine - Merge matches");
    await pickIn(user, byId("transform-0-aggregation-type"), "max");
    await pickIn(user, byId("transform-0-action"), "Group - Into new resources");
    await typeInto(user, byId("transform-0-include"), "b");
    expect(valueOf(MT).transforms).toEqual([
      { include: "b", match_type: "strict", action: "group", aggregation_type: "max", group_resource_labels: {} },
    ]);
    expect(infoToasts()).toEqual([GROUP_LABELS]);
  });

  it("Combine in a held transform, then its Remove: nothing written, nothing toasted, nor by the next held card's write", async () => {
    const before = mtText("    transforms: []\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-0-action"), "Combine - Merge matches");
    await user.click(screen.getByRole("button", { name: "Remove transform" }));
    expect(text()).toBe(before);
    expect(infoToasts()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await typeInto(user, byId("transform-0-include"), "b");
    expect(transform(valueOf(MT), 0)).toEqual({ include: "b", match_type: "strict", action: "update" });
    expect(infoToasts()).toEqual([]);
  });

  it("Group in a held transform toasts nothing; its metric typed writes group_resource_labels: {} and toasts once", async () => {
    const before = mtText("");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-0-action"), "Group - Into new resources");
    expect(text()).toBe(before);
    expect(infoToasts()).toEqual([]);

    await typeInto(user, byId("transform-0-include"), "b");
    expect(valueOf(MT).transforms).toEqual([{ include: "b", match_type: "strict", action: "group", group_resource_labels: {} }]);
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([GROUP_LABELS]);
  });

  it("Group in a held transform, then its Remove: nothing written, nothing toasted", async () => {
    const before = mtText("    transforms: []\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-0-action"), "Group - Into new resources");
    await user.click(screen.getByRole("button", { name: "Remove transform" }));
    expect(text()).toBe(before);
    expect(infoToasts()).toEqual([]);
  });

  it("Combine and Group both held: one toast, both messages, with the write", async () => {
    const before = mtText("");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-0-action"), "Combine - Merge matches");
    await pickIn(user, byId("transform-0-action"), "Group - Into new resources");
    expect(infoToasts()).toEqual([]);
    await typeInto(user, byId("transform-0-include"), "b");
    expect(valueOf(MT).transforms).toEqual([
      { include: "b", match_type: "strict", action: "group", aggregation_type: "sum", group_resource_labels: {} },
    ]);
    expect(infoToasts()).toEqual([`${COMBINE_SUM} ${GROUP_LABELS}`]);
  });

  it("a held transform dropped by its list's length changing takes its held toast with it", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await pickIn(user, byId("transform-1-action"), "Combine - Merge matches");
    act(() => {
      builderStore().setComponentValue(componentNamed(MT).id, "transforms:\n  - include: a\n    action: update\n  - include: c\n    action: update\n");
    });
    expect(screen.queryByText("combine (configure metric)")).toBeNull();
    expect(infoToasts()).toEqual([]);
  });

  it("once the card is written, a cascade on it toasts at once", async () => {
    const before = mtText("");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await typeInto(user, byId("transform-0-include"), "b");
    expect(infoToasts()).toEqual([]);
    stepPastRuns();
    await pickIn(user, byId("transform-0-action"), "Combine - Merge matches");
    expect(transform(valueOf(MT), 0)).toEqual({ include: "b", match_type: "strict", action: "combine", aggregation_type: "sum" });
    expect(infoToasts()).toEqual([COMBINE_SUM]);
  });
});

describe("MetricsTransformProcessorForm: removing an operation with a field's edit pending", () => {
  /** Types `typed` into the field without leaving it: the edit waits for the pause. */
  const typePending = (field: HTMLElement, typed: string) =>
    act(() => void fireEvent.change(field, { target: { value: (field as HTMLInputElement).value + typed } }));

  it("the last operation: the edit is written first, then operations goes, and doesn't come back", () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n        operations:\n          - action: add_label\n            new_label: version\n");
    renderForm(MT, before);
    vi.useFakeTimers();
    typePending(byId("t0-op0-new-value"), "v1");
    expect(text()).toBe(before);

    act(() => void fireEvent.click(screen.getByRole("button", { name: "Remove operation" })));
    expect(transform(valueOf(MT), 0)).toEqual({ include: "a", action: "update" });
    act(() => void vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS + 100));
    expect(transform(valueOf(MT), 0)).toEqual({ include: "a", action: "update" });
    expect(screen.queryByRole("button", { name: "Remove operation" })).toBeNull();
  });

  it("another operation: the edit is written to its own item, which goes; the next keeps its own fields", () => {
    const before = mtText(
      "    transforms:\n      - include: a\n        action: update\n        operations:\n          - action: add_label\n            new_label: version\n          - action: add_label\n            new_label: zone\n",
    );
    renderForm(MT, before);
    vi.useFakeTimers();
    typePending(byId("t0-op0-new-value"), "v1");

    act(() => void fireEvent.click(screen.getAllByRole("button", { name: "Remove operation" })[0]!));
    expect(transform(valueOf(MT), 0).operations).toEqual([{ action: "add_label", new_label: "zone" }]);
    act(() => void vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS + 100));
    expect(transform(valueOf(MT), 0).operations).toEqual([{ action: "add_label", new_label: "zone" }]);
  });
});

describe("MetricsTransformProcessorForm: the changes", () => {
  it("an unset Action is blank, Select action, with the hint Required. (factory.go:85-87); Match Type unset is Default strict (factory.go:145-147)", async () => {
    const user = renderForm(MT, mtText("    transforms:\n      - include: a\n"));
    expect(screen.getByText("(no action): a")).toBeInTheDocument();
    expect(byId("transform-0-action")).toHaveTextContent("Select action");
    expect(screen.getByText(ACTION_REQUIRED)).toBeInTheDocument();
    expect(byId("transform-0-match-type")).toHaveTextContent("Strict - Exact name");
    expect(screen.getByText("Default", { exact: false, selector: "p" })).toHaveTextContent("Default strict");
    await pickIn(user, byId("transform-0-action"), "Update - In place");
    expect(transform(valueOf(MT), 0)).toEqual({ include: "a", action: "update" });
    expect(screen.queryByText(ACTION_REQUIRED)).toBeNull();
  });

  it("offers the collector's four actions, group included (config.go:158-172)", async () => {
    const user = renderForm(MT, mtText("    transforms:\n      - include: a\n        action: update\n"));
    expect(await optionsOf(user, byId("transform-0-action"))).toEqual([
      "Update - In place",
      "Insert - On a copy",
      "Combine - Merge matches",
      "Group - Into new resources",
    ]);
  });

  it("Combine with no aggregation type also writes aggregation_type: sum, one entry, with the toast (factory.go:97-99)", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update # in place\n        new_name: b\n");
    const user = renderForm(MT, before);
    await pickIn(user, byId("transform-0-action"), "Combine - Merge matches");
    expect(text()).toBe(before.replace("        action: update # in place\n        new_name: b\n", "        action: combine # in place\n        new_name: b\n        aggregation_type: sum\n"));
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([COMBINE_SUM]);
    act(() => void builderStore().undo());
    expect(text()).toBe(before);
  });

  it("Combine beside an aggregation type the text has writes the action alone, with no toast", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n        aggregation_type: max\n");
    const user = renderForm(MT, before);
    await pickIn(user, byId("transform-0-action"), "Combine - Merge matches");
    expect(text()).toBe(before.replace("action: update", "action: combine"));
    expect(infoToasts()).toEqual([]);
  });

  it("Group with no group_resource_labels also writes group_resource_labels: {}, one entry, with the toast (factory.go:101-103)", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await pickIn(user, byId("transform-0-action"), "Group - Into new resources");
    expect(text()).toBe(before.replace("        action: update\n", "        action: group\n        group_resource_labels: {}\n"));
    expect(transform(valueOf(MT), 0).group_resource_labels).toEqual({});
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([GROUP_LABELS]);

    // Switching away leaves it (the collector reads it only for group).
    stepPastRuns();
    await pickIn(user, byId("transform-0-action"), "Update - In place");
    expect(transform(valueOf(MT), 0)).toEqual({ include: "a", action: "update", group_resource_labels: {} });
  });

  it("New Name says it is required for Insert and Combine while either is chosen (factory.go:89-95)", () => {
    renderForm(MT);
    // The corpus: update, insert, combine.
    fireEvent.click(screen.getAllByRole("button", { name: "Expand transform" })[0]!);
    expect(hint("Optional rename of the matched metric.")).toBeInTheDocument();
    expect(queryHint(NEW_NAME_REQUIRED)).toBeNull();
    for (const toggle of screen.getAllByRole("button", { name: "Expand transform" })) fireEvent.click(toggle);
    expect(screen.getAllByText(NEW_NAME_REQUIRED)).toHaveLength(2);
  });

  it("an operation's action change rebuilds it as {action} in place, its comment kept", async () => {
    const before = mtText(
      "    transforms:\n      - include: a\n        action: update\n        operations:\n          # the version label\n          - action: add_label\n            new_label: version\n            new_value: v1\n",
    );
    const user = renderForm(MT, before);
    await pickIn(user, screen.getByRole("combobox", { name: "Operation action" }), "Delete points by label value");
    expect(text()).toBe(before.replace("          - action: add_label\n            new_label: version\n            new_value: v1\n", "          - action: delete_label_value\n"));
    expect(entries()).toBe(1);
    expect(byId("t0-op0-label")).toHaveValue("");
  });

  it("removing the last operation removes operations; another keeps the list", async () => {
    const before = mtText(
      "    transforms:\n      - include: a\n        action: update\n        operations:\n          - action: toggle_scalar_data_type\n          - action: experimental_scale_value\n            experimental_scale: 1000\n",
    );
    const user = renderForm(MT, before);
    await user.click(screen.getAllByRole("button", { name: "Remove operation" })[0]!);
    expect(transform(valueOf(MT), 0).operations).toEqual([{ action: "experimental_scale_value", experimental_scale: 1000 }]);
    stepPastRuns();
    await user.click(screen.getByRole("button", { name: "Remove operation" }));
    expect(transform(valueOf(MT), 0)).toEqual({ include: "a", action: "update" });
    expect(entries()).toBe(2);
  });

  it("Scale is a number field: written plain as typed, a reference as a string; cleared removes it", async () => {
    const before = mtText(
      "    transforms:\n      - include: a\n        action: update\n        operations:\n          - action: experimental_scale_value\n            experimental_scale: 1000\n",
    );
    const user = renderForm(MT, before);
    await retypeInto(user, byId("t0-op0-scale"), "1e-3");
    expect(text()).toContain("            experimental_scale: 1e-3\n");
    stepPastRuns();
    await retypeInto(user, byId("t0-op0-scale"), "");
    expect(operation(valueOf(MT), 0, 0)).toEqual({ action: "experimental_scale_value" });
  });

  it("a card's header is a labeled button; the operation's select is labeled Operation action", async () => {
    const user = renderForm(MT);
    const toggles = screen.getAllByRole("button", { name: "Expand transform" });
    expect(toggles).toHaveLength(3);
    expect(toggles[1]).toHaveTextContent("insert: http.server.duration");
    await user.click(toggles[1]!);
    expect(screen.getByRole("button", { name: "Collapse transform" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("combobox", { name: "Operation action" }).map((select) => select.id)).toEqual(["t1-op0-action", "t1-op1-action"]);
  });

  it("removing a transform removes its lines; the expanded card stays its own", async () => {
    const user = renderForm(MT);
    await expandTransform(user, 2);
    await user.click(screen.getAllByRole("button", { name: "Remove transform" })[0]!);
    expect((valueOf(MT).transforms as Value[]).map((t) => t.include)).toEqual(["http.server.duration", "^system\\.disk\\.(.*)"]);
    expect(text()).toContain("      # the disks, combined into one metric\n      - include: ^system\\.disk\\.(.*)\n");
    expect(screen.getAllByRole("button", { name: /transform$/ }).map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", null, "true", null]);
    expect(byId("transform-1-include")).toHaveValue("^system\\.disk\\.(.*)");
  });

  it("a transforms value that isn't a list is read-only with the unshowable-value hint; Add Transform is disabled", () => {
    renderForm(MT, mtText("    transforms: everything\n"));
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Transform" })).toBeDisabled();
    expect(screen.queryByText(NO_TRANSFORMS)).toBeNull();
  });
});

// ── groupbyattrs ──

describe("GroupByAttrsProcessorForm cases", () => {
  it("renders the default grouping key", () => {
    renderForm(GBA, paletteText("processor", "groupbyattrs"));
    expect([...document.querySelectorAll("input")].find((input) => input.value === "host.name")).toBeInTheDocument();
  });

  it("shows the compaction hint only when no keys are set (unset, or [] too)", () => {
    renderForm(GBA_COMPACT);
    expect(screen.getByText(COMPACTION_ALERT)).toBeInTheDocument();
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(GBA, ownText("processors", "groupbyattrs", "    keys: []\n"));
    expect(screen.getByText(COMPACTION_ALERT)).toBeInTheDocument();
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(GBA, paletteText("processor", "groupbyattrs"));
    expect(screen.queryByText(COMPACTION_ALERT)).toBeNull();
  });

  it("adds and removes a key in place in a metrics pipeline (was: generates valid YAML and round-trips); the last leaves [] (factory.go:32-36)", async () => {
    const before = paletteText("processor", "groupbyattrs");
    const user = renderForm(GBA, before);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(valueOf(GBA).keys).toEqual([]);
    expect(screen.getByText(COMPACTION_ALERT)).toBeInTheDocument();
    stepPastRuns();
    await user.type(screen.getByPlaceholderText("e.g. host.name"), "host.name{Enter}");
    expect(text()).toBe(before);
    expect(valueOf(GBA).keys).toEqual(["host.name"]);
    expect(entries()).toBe(2);
  });
});

// ── Privacy ──

describe("privacy", () => {
  it("puts no config value in any attribute: every section and card open, the menus open, a held card and row, a drag in progress", async () => {
    const MARK = "zq-mark";
    const marked = [
      "receivers:",
      "  statsd:",
      `    endpoint: ${MARK}-endpoint`,
      `    transport: ${MARK}-transport`,
      `    aggregation_interval: ${MARK}-interval`,
      "    timer_histogram_mapping:",
      `      - statsd_type: ${MARK}-type`,
      `        observer_type: ${MARK}-observer`,
      "      - statsd_type: timing",
      "        observer_type: summary",
      `        summary: {percentiles: [${MARK}-p]}`,
      "      - statsd_type: histogram",
      "        observer_type: histogram",
      `        histogram: {max_size: ${MARK}-size}`,
      "  statsd/unix:",
      "    transport: unixgram",
      `    endpoint: /${MARK}.sock`,
      `    socket_permissions: ${MARK}-mode`,
      "processors:",
      "  cumulativetodelta:",
      `    initial_value: ${MARK}-initial`,
      `    max_staleness: ${MARK}-staleness`,
      "    include:",
      `      match_type: ${MARK}-match`,
      `      metrics: [${MARK}-metric]`,
      "    exclude:",
      "      match_type: strict",
      `      metrics: [${MARK}-excluded]`,
      "  metricstransform:",
      "    transforms:",
      `      - include: ${MARK}-include`,
      `        match_type: ${MARK}-mt`,
      `        action: ${MARK}-action`,
      `        new_name: ${MARK}-name`,
      "        operations:",
      `          - action: ${MARK}-op`,
      "          - action: aggregate_label_values",
      `            label: ${MARK}-label`,
      `            aggregated_values: [${MARK}-v]`,
      `            new_value: ${MARK}-nv`,
      `            aggregation_type: ${MARK}-agg`,
      "      - include: second",
      "        action: combine",
      `        aggregation_type: ${MARK}-combine`,
      "  groupbyattrs:",
      `    keys: [${MARK}-key]`,
      "exporters:",
      "  debug:",
      "service:",
      "  pipelines:",
      "    metrics:",
      "      receivers: [statsd, statsd/unix]",
      "      processors: [cumulativetodelta, metricstransform, groupbyattrs]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    const leaks: string[] = [];
    const scan = (where: string) => {
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
        }
        if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(MARK)) leaks.push(`${where}: option value`);
        if (element.tagName === "INPUT" && (element as HTMLInputElement).type === "radio" && (element as HTMLInputElement).value.includes(MARK)) {
          leaks.push(`${where}: radio value`);
        }
      }
    };
    const shown = () => document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    const runs: [string, readonly string[]][] = [
      ["receivers.statsd", ["statsd_type_0", "observer_type_0"]],
      ["receivers.statsd/unix", []],
      [CTD, ["initial-value", "include-match-type"]],
      [MT, ["transform-0-match-type", "transform-0-action", "t0-op0-action", "t0-op1-aggregation-type", "transform-1-aggregation-type"]],
      [GBA, []],
    ];
    for (const [key, menus] of runs) {
      cleanup();
      useEditorStore.setState(initialState, true);
      layOutRows();
      const user = renderForm(key, marked);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      expect(shown()).toContain(`${MARK}-`);
      scan(key);

      for (const handle of screen.queryAllByRole("button", { name: "Drag to reorder" })) {
        act(() => handle.focus());
        await press(handle, " ", "Space");
        await press(handle, "ArrowDown");
        scan(`${key} (dragging)`);
        await press(handle, "Escape");
      }

      for (const menu of menus) {
        await user.click(byId(menu));
        expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
        scan(`${key} (${menu} menu)`);
        await user.keyboard("{Escape}");
      }

      // A held card and a held row show what the text has around them.
      for (const name of ["Add Transform", "Add Operation", "Add Metric Name"]) {
        const add = screen.queryAllByRole("button", { name }).find((button) => !(button as HTMLButtonElement).disabled);
        if (add) await user.click(add);
      }
      scan(`${key} (held)`);
      expect(text()).toBe(marked);
      expect(entries()).toBe(0);
    }
    expect(leaks).toEqual([]);
  }, 30_000);
});

// ── The copy, word for word ──

describe("the copy", () => {
  it("toasts, hints and alerts read exactly as written", () => {
    expect(REMOVED_HISTOGRAM).toBe("Removed the histogram settings: they need observer type histogram.");
    expect(REMOVED_SUMMARY).toBe("Removed the summary percentiles: they need observer type summary.");
    expect(COMBINE_SUM).toBe("Aggregation Type set to sum: combine needs one.");
    expect(GROUP_LABELS).toBe("Added group_resource_labels: group needs it. Edit it in the YAML.");
    expect(NO_MAPPINGS).toBe("None set: the collector maps timer, histogram and distribution to gauge.");
    expect(SOCKET_PERMISSIONS_STRING_HINT).toBe("Written as a string; the collector needs a plain octal number. Retype it to unquote it.");
    expect(NO_TRANSFORMS).toBe("With no transforms, metrics pass through unchanged.");
    expect(NEW_NAME_REQUIRED).toBe("Required for Insert and Combine.");
    expect(ACTION_REQUIRED).toBe("Required.");
    expect(MEMORY_ALERT).toBe(
      "Every unique metric name + label combination is tracked as its own stream until it has been idle for Max Staleness (default 1h). In high-cardinality setups, lower it to cap memory growth.",
    );
  });
});

// ── Held items and the YAML box ──

describe("held cards and the YAML box", () => {
  it("a held transform stays through an edit inside another transform, and goes when the YAML box changes the list's length", async () => {
    const before = mtText("    transforms:\n      - include: a\n        action: update\n");
    const user = renderForm(MT, before);
    await user.click(screen.getByRole("button", { name: "Add Transform" }));
    await retypeInto(user, byId("transform-0-new-name"), "b");
    expect(transform(valueOf(MT), 0)).toEqual({ include: "a", action: "update", new_name: "b" });
    expect(screen.getByText("update (configure metric)")).toBeInTheDocument();

    act(() => {
      builderStore().setComponentValue(componentNamed(MT).id, "transforms:\n  - include: a\n    action: update\n  - include: c\n    action: update\n");
    });
    expect(screen.queryByText("update (configure metric)")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^(Expand|Collapse) transform$/ })).toHaveLength(2);
  });
});
