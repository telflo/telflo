import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { ConfigurationPanel } from "../ConfigurationPanel.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import {
  EXCLUDE_FIELDS_DESCRIPTION,
  EXCLUDE_LOCKED_HINT,
  INCLUDE_LOCKED_HINT,
  LogDedupProcessorForm,
} from "./LogDedupProcessorForm.js";
import { formFor } from "./registry.js";
import {
  EXAMPLE_PATTERNS,
  NO_CONDITIONS,
  REFUSED_ORDER_HINT,
  SECTIONS,
  TransformProcessorForm,
} from "./TransformProcessorForm.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { paletteSubType } from "~/lib/graph/parse.js";
import type { ComponentType } from "~/lib/graph/types.js";
import { ottlString } from "~/lib/ottl.js";
import { findPattern } from "~/lib/regex-library.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The transform and logdedup processors: their forms over the form
 * contract. Each field is driven as a person would on the OTTL corpus text
 * (comments, an anchor and its merges, flow lists, OTTL written as typed
 * with its quotes and escapes, groups before flat statements, a bare `0750`
 * the collector reads as a number), LF and CRLF, and writes only its key.
 * Seven logdedup cases are included.
 *
 * Collector claims cite contrib v0.162.0: `processor/transformprocessor`,
 * `processor/logdedupprocessor`, `pkg/ottl`.
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The OTTL corpus (LF). */
const CORPUS = LF(corpusText("forms-ottl.yaml"));

const TR = "processors.transform";
const TR_FLAT = "processors.transform/flat";
const LD = "processors.logdedup";
const LD_INCLUDE = "processors.logdedup/include";

/** A text holding only `component` (its lines at four spaces under `processors.<name>`), in a pipeline of `signal`. */
function ownText(name: string, lines: string, signal = "traces"): string {
  const body = lines.trimEnd() === "" ? [`  ${name}: {}`] : [`  ${name}:`, lines.trimEnd()];
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    "processors:",
    ...body,
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    `    ${signal}:`,
    "      receivers: [otlp]",
    `      processors: [${name}]`,
    "      exporters: [debug]",
    "",
  ].join("\n");
}

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
const errorToasts = () => vi.mocked(toast.error).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderForm(key: string, text = CORPUS, options?: Parameters<typeof userEvent.setup>[0]) {
  openText(text);
  const user = userEvent.setup(options);
  render(
    <ComponentForm nodeId={componentNamed(key).id}>
      {key.includes("dedup") ? <LogDedupProcessorForm /> : <TransformProcessorForm />}
    </ComponentForm>,
  );
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const valueOf = (key: string, written = text()): Value => {
  const dot = key.indexOf(".");
  const parsed = parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>;
  return parsed[key.slice(0, dot)]![key.slice(dot + 1)]!;
};
/** A hint line, by its whole text. */
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

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${title}\\s*\\d*$`) }).at(-1)!);
}

/** A statement group's card, by its number. */
function groupCard(number: number): HTMLElement {
  return screen.getByRole("button", { name: `Statement Group ${number}` }).closest("div.rounded-lg") as HTMLElement;
}

/** A labelled field's block (its ConfigField), by its label. */
function fieldOf(label: string): HTMLElement {
  return screen.getByText(label, { selector: "label" }).closest("div.space-y-1\\.5") as HTMLElement;
}

/** The section's own Add Statement (after its cards'). */
const addFlat = () => screen.getAllByRole("button", { name: "Add Statement" }).at(-1)!;
const addGroup = () => screen.getByRole("button", { name: "Add Statement Group" });

// ── Sortable cards by keyboard ──

const ROW_HEIGHT = 40;

/** The sortable item an element is in: a child of a `space-y-3` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (parent?.classList.contains("space-y-3") && [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))) {
      return e;
    }
  }
  return null;
}

/** dnd-kit measures rows; jsdom's are all zero, so items are laid out 40 px apart. */
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

const handles = () => screen.getAllByRole("button", { name: "Drag to reorder" });

// ── Every field writes only its key ──

const KEEP_KEYS = '          - keep_keys(attributes, ["service.name", "service.namespace", "cloud.region"])\n';
const STATUS_500 = '          - set(span.status.code, STATUS_CODE_ERROR) where span.attributes["http.status_code"] >= 500\n';
const TRUNCATE = "      - truncate_all(span.attributes, 4096) # long values\n";
const LOG_FLAT = `      - 'set(log.attributes["source"], "app") where IsMatch(log.body, "^\\\\d+")'\n`;

interface FieldCase {
  name: string;
  key: string;
  /** The text the case runs on (LF); the corpus by default. */
  base?: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: Value) => void;
}

const statementsOf = (value: Value, key = "trace_statements") => value[key] as unknown[];
const groupOf = (value: Value, index: number, key = "trace_statements") => statementsOf(value, key)[index] as Value;

const CASES: FieldCase[] = [
  // transform
  {
    name: "Error Mode",
    key: TR,
    edit: (user) => pickIn(user, byId("error-mode"), "Propagate - Return error and drop data (strict)"),
    from: "    error_mode: ignore\n",
    to: "    error_mode: propagate\n",
    check: (v) => expect(v.error_mode).toBe("propagate"),
  },
  {
    name: "a group's Context",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await retypeInto(user, byId("transform-trace-group-0-context"), "scope");
    },
    from: "      - context: resource\n",
    to: "      - context: scope\n",
    check: (v) => expect(groupOf(v, 0).context).toBe("scope"),
  },
  {
    name: "a group's Context (unset), after its statements",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await typeInto(user, byId("transform-trace-group-1-context"), "span");
    },
    from: STATUS_500,
    to: `${STATUS_500}        context: span\n`,
    check: (v) => expect(groupOf(v, 1)).toEqual({ statements: [expect.stringContaining("STATUS_CODE_ERROR")], context: "span" }),
  },
  {
    name: "a group's Context cleared removes the key",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await retypeInto(user, byId("transform-trace-group-0-context"), "");
    },
    from: "      - context: resource\n        statements:\n",
    to: "      - statements:\n",
    check: (v) => expect(Object.keys(groupOf(v, 0))).toEqual(["statements"]),
  },
  {
    name: "a group's Error Mode (unset)",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await pickIn(user, byId("transform-trace-group-0-error-mode"), "Silent");
    },
    from: KEEP_KEYS,
    to: `${KEEP_KEYS}        error_mode: silent\n`,
    check: (v) => expect(groupOf(v, 0).error_mode).toBe("silent"),
  },
  {
    name: "a group's first condition (held until typed), written as typed",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await user.click(within(groupCard(1)).getByRole("button", { name: "Add Condition" }));
      await typeInto(user, byId("transform-trace-group-0-conditions"), 'attributes["service.name"] == "cart"');
    },
    from: KEEP_KEYS,
    to: `${KEEP_KEYS}        conditions:\n          - attributes["service.name"] == "cart"\n`,
    check: (v) => expect(groupOf(v, 0).conditions).toEqual(['attributes["service.name"] == "cart"']),
  },
  {
    name: "a group's statement",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await retypeInto(user, byId("transform-trace-group-0-statements"), 'keep_keys(attributes, ["service.name"])');
    },
    from: KEEP_KEYS,
    to: '          - keep_keys(attributes, ["service.name"])\n',
    check: (v) => expect(groupOf(v, 0).statements).toEqual(['keep_keys(attributes, ["service.name"])']),
  },
  {
    name: "a group's Add Statement (held until typed), appended to its statements",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await user.click(within(groupCard(1)).getByRole("button", { name: "Add Statement" }));
      const rows = within(groupCard(1)).getAllByRole("textbox").filter((e) => e.tagName === "TEXTAREA");
      await typeInto(user, rows.at(-1)!, 'delete_key(attributes, "cloud.region")');
    },
    from: KEEP_KEYS,
    to: `${KEEP_KEYS}          - delete_key(attributes, "cloud.region")\n`,
    check: (v) => expect((groupOf(v, 0).statements as string[]).at(-1)).toBe('delete_key(attributes, "cloud.region")'),
  },
  {
    name: "a flat statement, written as typed",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await retypeInto(user, byId("transform-trace-statement-2"), 'set(span.attributes["env"], "staging")');
    },
    from: '      - set(span.attributes["env"], "prod")\n',
    to: '      - set(span.attributes["env"], "staging")\n',
    check: (v) => expect(statementsOf(v)[2]).toBe('set(span.attributes["env"], "staging")'),
  },
  {
    name: "a flat statement, its comment kept",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await retypeInto(user, byId("transform-trace-statement-3"), "truncate_all(span.attributes, 2048)");
    },
    from: TRUNCATE,
    to: "      - truncate_all(span.attributes, 2048) # long values\n",
    check: (v) => expect(statementsOf(v)[3]).toBe("truncate_all(span.attributes, 2048)"),
  },
  {
    name: "Add Statement (held until typed), appended after the flat statements",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Trace Statements");
      await user.click(addFlat());
      await typeInto(user, byId("transform-trace-statement-4"), 'set(span.name, "checkout")');
    },
    from: TRUNCATE,
    to: `${TRUNCATE}      - set(span.name, "checkout")\n`,
    check: (v) => expect(statementsOf(v)[4]).toBe('set(span.name, "checkout")'),
  },
  {
    name: "a metric group's statement",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Metric Statements");
      await retypeInto(user, byId("transform-metric-group-0-statements"), 'set(attributes["host"], "h")');
    },
    from: '          - set(attributes["host"], resource.attributes["host.name"])\n',
    to: '          - set(attributes["host"], "h")\n',
    check: (v) => expect(groupOf(v, 0, "metric_statements").statements).toEqual(['set(attributes["host"], "h")']),
  },
  {
    name: "a single-quoted log statement keeps its quotes and its regex escape",
    key: TR,
    edit: async (user) => {
      await openSection(user, "Log Statements");
      await retypeInto(user, byId("transform-log-statement-1"), 'set(log.attributes["source"], "web") where IsMatch(log.body, "^\\\\d+")');
    },
    from: LOG_FLAT,
    to: `      - 'set(log.attributes["source"], "web") where IsMatch(log.body, "^\\\\d+")'\n`,
    check: (v) => expect(statementsOf(v, "log_statements")[1]).toBe('set(log.attributes["source"], "web") where IsMatch(log.body, "^\\\\d+")'),
  },
  {
    name: "transform/flat's statement",
    key: TR_FLAT,
    edit: async (user) => {
      await openSection(user, "Log Statements");
      await retypeInto(user, byId("transform-log-statement-0"), 'set(log.body, log.attributes["msg"])');
    },
    from: '      - set(log.body, log.attributes["message"]) where log.attributes["message"] != nil\n',
    to: '      - set(log.body, log.attributes["msg"])\n',
    check: (v) => expect(statementsOf(v, "log_statements")).toEqual(['set(log.body, log.attributes["msg"])']),
  },
  // logdedup
  {
    name: "Timezone",
    key: LD,
    edit: (user) => retypeInto(user, byId("timezone"), "Europe/Paris"),
    from: "    timezone: America/Los_Angeles\n",
    to: "    timezone: Europe/Paris\n",
    check: (v) => expect(v.timezone).toBe("Europe/Paris"),
  },
  {
    name: "Interval under a merge: the component's own key, the anchor left alone",
    key: LD,
    edit: (user) => retypeInto(user, byId("interval"), "30s"),
    from: '      - attributes["ID"] == 1\n  logdedup/include:\n',
    to: '      - attributes["ID"] == 1\n    interval: 30s\n  logdedup/include:\n',
    check: (v) => expect(v.interval).toBe("30s"),
  },
  {
    name: "an Exclude Fields item keeps its escaped dot",
    key: LD,
    edit: async (user) => {
      await openSection(user, "Match Scope");
      const rows = within(fieldOf("Exclude Fields")).getAllByRole("textbox");
      await retypeInto(user, rows[1]!, "attributes.host\\.domain");
    },
    from: "      - attributes.host\\.name\n",
    to: "      - attributes.host\\.domain\n",
    check: (v) => expect(v.exclude_fields).toEqual(["body.timestamp", "attributes.host\\.domain"]),
  },
  {
    name: "Exclude Fields' Add (held until typed)",
    key: LD,
    edit: async (user) => {
      await openSection(user, "Match Scope");
      await user.click(within(fieldOf("Exclude Fields")).getByRole("button", { name: "Add" }));
      await typeInto(user, within(fieldOf("Exclude Fields")).getAllByRole("textbox").at(-1)!, "body.level");
    },
    from: "      - attributes.host\\.name\n",
    to: "      - attributes.host\\.name\n      - body.level\n",
    check: (v) => expect(v.exclude_fields).toEqual(["body.timestamp", "attributes.host\\.name", "body.level"]),
  },
  {
    name: "a condition, written as typed",
    key: LD,
    edit: async (user) => {
      await openSection(user, "Conditions");
      await retypeInto(user, byId("conditions"), 'attributes["ID"] == 2');
    },
    from: '      - attributes["ID"] == 1\n',
    to: '      - attributes["ID"] == 2\n',
    check: (v) => expect(v.conditions).toEqual(['attributes["ID"] == 2']),
  },
  {
    name: "Include Fields' Add, into its flow list",
    key: LD_INCLUDE,
    edit: async (user) => {
      await openSection(user, "Match Scope");
      await user.click(within(fieldOf("Include Fields")).getByRole("button", { name: "Add" }));
      await typeInto(user, within(fieldOf("Include Fields")).getAllByRole("textbox").at(-1)!, "attributes.id");
    },
    from: "    include_fields: [attributes.error, body.message]\n",
    to: "    include_fields: [attributes.error, body.message, attributes.id]\n",
    check: (v) => expect(v.include_fields).toEqual(["attributes.error", "body.message", "attributes.id"]),
  },
  {
    name: "an Include Fields item removed from its flow list",
    key: LD_INCLUDE,
    edit: async (user) => {
      await openSection(user, "Match Scope");
      await user.click(within(fieldOf("Include Fields")).getAllByRole("button", { name: "Remove" })[0]!);
    },
    from: "    include_fields: [attributes.error, body.message]\n",
    to: "    include_fields: [body.message]\n",
    check: (v) => expect(v.include_fields).toEqual(["body.message"]),
  },
];

describe("every field writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const base = c.base ?? CORPUS;
      const before = crlf ? CRLF(base) : base;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf(c.key));
      expect(infoToasts()).toEqual([]);
      expect(errorToasts()).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

// ── Opening writes nothing ──

describe("opening writes nothing", () => {
  /** Opens every section and card, again until none is left. */
  async function openEverything(user: UserEvent) {
    for (let round = 0; round < 3; round++) {
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    }
  }

  // One test per text, each with its own time limit.
  it.each([
    // Error Mode; per group Context, Error Mode and its statements; the flat statements.
    ["transform, the OTTL corpus", TR, CORPUS, 18],
    ["transform, the OTTL corpus, CRLF", TR, CRLF(CORPUS), 18],
    ["transform/flat", TR_FLAT, CORPUS, 2],
    // Interval, Log Count Attribute, Timezone, the field lists' rows and the condition.
    ["logdedup", LD, CORPUS, 6],
    ["logdedup, CRLF", LD, CRLF(CORPUS), 6],
    ["logdedup/include", LD_INCLUDE, CORPUS, 5],
  ] as const)(
    "opening %s, every section and card, focusing every field, writes nothing and leaves the editor clean",
    async (_name, key, base, minimum) => {
      const user = renderForm(key, base);
      await openEverything(user);
      expect(screen.queryAllByRole("button", { expanded: false })).toEqual([]);
      const { textboxes, all } = formControls();
      expect(all).toBeGreaterThanOrEqual(minimum);
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

// ── Templates ──

const template = (name: string) => EXAMPLE_PATTERNS.find((example) => example.name === name)!;

/** Clicks a template's Add (or, for an All Signals one, its signal's button). */
async function addTemplate(user: UserEvent, name: string, signal?: "Traces" | "Metrics" | "Logs") {
  const card = screen.getByText(name, { selector: "p" }).closest("div.rounded-lg") as HTMLElement;
  await user.click(within(card).getByRole("button", { name: signal ?? "Add" }));
}

describe("templates: each its own group, before the flat statements", () => {
  it("two templates of different contexts both added give two groups before any flat statement, one entry each, with the toast", async () => {
    const user = renderForm(TR);
    await openSection(user, "Examples & Reference");
    await addTemplate(user, "Convert Sum to Gauge");
    expect(entries()).toBe(1);
    stepPastRuns();
    await addTemplate(user, "Limit Metric Labels");
    expect(entries()).toBe(2);
    expect(statementsOf(valueOf(TR), "metric_statements")).toEqual([
      { context: "datapoint", statements: ['set(attributes["host"], resource.attributes["host.name"])'] },
      { statements: ['convert_sum_to_gauge() where metric.name == "system.memory.usage"'] },
      {
        statements: [
          'keep_keys(resource.attributes, ["service.name", "service.namespace", "deployment.environment"])',
          'limit(datapoint.attributes, 100, ["host.name", "service.name"])',
        ],
      },
      'convert_sum_to_gauge() where metric.name == "system.processes.count"',
    ]);
    // The flat statement and its lines stay where they were, last.
    expect(LF(text())).toContain(
      [
        "      - statements:",
        '          - convert_sum_to_gauge() where metric.name == "system.memory.usage"',
        "      - statements:",
        '          - keep_keys(resource.attributes, ["service.name", "service.namespace", "deployment.environment"])',
        '          - limit(datapoint.attributes, 100, ["host.name", "service.name"])',
        '      - convert_sum_to_gauge() where metric.name == "system.processes.count"',
        "    log_statements:",
      ].join("\n"),
    );
    expect(vi.mocked(toast.success).mock.calls).toEqual([
      ["Added to Metric statements", { description: "Convert Sum to Gauge" }],
      ["Added to Metric statements", { description: "Limit Metric Labels" }],
    ]);
    // Each is one undo entry.
    act(() => void builderStore().undo());
    expect(statementsOf(valueOf(TR), "metric_statements")).toHaveLength(3);
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("a list of flat statements only gets the group first; a list of groups only, last; an absent or empty list, its first item", async () => {
    const flatOnly = ownText("transform", "    log_statements:\n      - set(log.body, \"x\") # flat\n", "logs");
    let user = renderForm(TR, flatOnly);
    await openSection(user, "Examples & Reference");
    await addTemplate(user, "Redact Log Secrets");
    expect(statementsOf(valueOf(TR), "log_statements")).toEqual([{ statements: [...template("Redact Log Secrets").statements] }, 'set(log.body, "x")']);
    expect(LF(text())).toContain('          - delete_key(log.attributes, "token") where log.attributes["token"] != nil\n      - set(log.body, "x") # flat\n');
    cleanup();

    user = renderForm(TR_FLAT);
    await openSection(user, "Examples & Reference");
    await addTemplate(user, "Add Environment Tags", "Traces");
    expect(statementsOf(valueOf(TR_FLAT), "trace_statements")).toEqual([{ statements: [...template("Add Environment Tags").statements] }]);
    expect(statementsOf(valueOf(TR_FLAT), "log_statements")).toHaveLength(1);
    cleanup();

    user = renderForm(TR, ownText("transform", "    error_mode: ignore\n    trace_statements: []\n    metric_statements: []\n    log_statements: []\n"));
    await openSection(user, "Examples & Reference");
    await addTemplate(user, "Set Error Status");
    expect(statementsOf(valueOf(TR))).toEqual([{ statements: [...template("Set Error Status").statements] }]);
    cleanup();

    const groupsOnly = ownText("transform", `    trace_statements:\n      - context: span\n        statements: ['set(span.name, "a")']\n`);
    user = renderForm(TR, groupsOnly);
    await openSection(user, "Examples & Reference");
    await addTemplate(user, "Redact Sensitive Headers");
    expect(statementsOf(valueOf(TR))).toEqual([
      { context: "span", statements: ['set(span.name, "a")'] },
      { statements: [...template("Redact Sensitive Headers").statements] },
    ]);
  });

  it("All Signals' Traces, Metrics and Logs each write their own section", async () => {
    const user = renderForm(TR_FLAT);
    await openSection(user, "Examples & Reference");
    for (const signal of ["Traces", "Metrics", "Logs"] as const) {
      stepPastRuns();
      await addTemplate(user, "Add Environment Tags", signal);
    }
    const value = valueOf(TR_FLAT);
    const group = { statements: [...template("Add Environment Tags").statements] };
    expect(value.trace_statements).toEqual([group]);
    expect(value.metric_statements).toEqual([group]);
    expect(value.log_statements).toEqual([group, 'set(log.body, log.attributes["message"]) where log.attributes["message"] != nil']);
    expect(vi.mocked(toast.success).mock.calls.map(([message]) => message)).toEqual([
      "Added to Trace statements",
      "Added to Metric statements",
      "Added to Log statements",
    ]);
  });

  it("a held row's typing still waiting (no blur) is written, then the template reads the list as that left it: the statement is kept", async () => {
    const base = ownText("transform", '    trace_statements:\n      - set(span.name, "a")\n');
    const user = renderForm(TR, base);
    await openSection(user, "Trace Statements");
    await openSection(user, "Examples & Reference");
    await user.click(addFlat());
    // Typed, not left: the write waits for the pause.
    fireEvent.change(byId("transform-trace-statement-1"), { target: { value: 'set(span.name, "typed")' } });
    expect(text()).toBe(base);
    const card = screen.getByText("Set Error Status", { selector: "p" }).closest("div.rounded-lg") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    expect(statementsOf(valueOf(TR))).toEqual([
      { statements: [...template("Set Error Status").statements] },
      'set(span.name, "a")',
      'set(span.name, "typed")',
    ]);
    expect(vi.mocked(toast.success).mock.calls).toEqual([["Added to Trace statements", { description: "Set Error Status" }]]);
  });

  it("a template's Add after an Instance Name typed and not left: the rename is written, and the group goes into the renamed component's list, before its statement", async () => {
    openText(ownText("transform", '    trace_statements:\n      - set(span.name, "a")\n'));
    const user = userEvent.setup();
    render(<ConfigurationPanel />);
    act(() => builderStore().selectNode(componentNamed(TR).id));
    await openSection(user, "Examples & Reference");
    await user.click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));
    // Typed, not left: the rename waits for its pause, and Add's flush writes it.
    fireEvent.change(byId("instance-name"), { target: { value: "x" } });
    const card = screen.getByText("Set Error Status", { selector: "p" }).closest("div.rounded-lg") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    expect(Object.keys((parseYaml(text()) as { processors: Value }).processors)).toEqual(["transform/x"]);
    expect(statementsOf(valueOf("processors.transform/x"))).toEqual([
      { statements: [...template("Set Error Status").statements] },
      'set(span.name, "a")',
    ]);
    expect(vi.mocked(toast.success).mock.calls).toEqual([["Added to Trace statements", { description: "Set Error Status" }]]);
  });

  it("a held row's typing is written to its own item before a template shifts the list", async () => {
    const user = renderForm(TR);
    await openSection(user, "Trace Statements");
    await openSection(user, "Examples & Reference");
    await user.clear(byId("transform-trace-statement-2"));
    await user.type(byId("transform-trace-statement-2"), escapeKeys('set(span.attributes["env"], "qa")'));
    await addTemplate(user, "Set Error Status");
    expect(statementsOf(valueOf(TR)).slice(2)).toEqual([
      { statements: [...template("Set Error Status").statements] },
      'set(span.attributes["env"], "qa")',
      "truncate_all(span.attributes, 4096)",
    ]);
  });
});

/*
 * The template table: each template's statements pinned, and each checked
 * against OTTL's grammar and the functions' signatures at contrib v0.162.0
 * (the web app has no OTTL parser). The lexer is
 * `pkg/ottl/grammar.go:583-609`'s rules, in
 * their order; the statement shape is `editor(args) [where condition]`
 * (grammar.go `parsedStatement`), comparisons only `==`, `!=`, `<`, `<=`,
 * `>`, `>=` (grammar.go:593, `compareOpTable`); so
 * `log.body contains "error"` doesn't parse.
 */
const LEXER: readonly (readonly [string, RegExp])[] = [
  ["Bytes", /^0x[a-fA-F0-9]+/],
  ["Float", /^(\d+\.\d*|\d*\.\d+)([eE][-+]?\d+)?/],
  ["Int", /^\d+/],
  ["String", /^"(\\.|[^\\"])*"/],
  ["Nil", /^\b(nil)\b/],
  ["OpNot", /^\b(not)\b/],
  ["OpOr", /^\b(or)\b/],
  ["OpAnd", /^\b(and)\b/],
  ["OpComparison", /^(==|!=|>=|<=|>|<)/],
  ["LambdaArrow", /^=>/],
  ["OpAddSub", /^(\+|-)/],
  ["OpMultDiv", /^(\/|\*)/],
  ["Boolean", /^\b(true|false)\b/],
  ["Equal", /^=/],
  ["LParen", /^\(/],
  ["RParen", /^\)/],
  ["LBrace", /^\{/],
  ["RBrace", /^\}/],
  ["Colon", /^:/],
  ["Punct", /^[,.[\]]/],
  ["Uppercase", /^[A-Z][A-Z0-9_]*/],
  ["Lowercase", /^[a-z][a-z0-9_]*/],
  ["whitespace", /^\s+/],
];

interface Token {
  type: string;
  value: string;
}

/**
 * A string's escapes, as Go's `strconv.Unquote` takes them: the lexer's
 * String rule takes any `\.`, and participle's Unquote then refuses the
 * rest (`pkg/ottl/parser.go:424`), so `"\d"` doesn't parse.
 */
const STRING_ESCAPE = /\\([abfnrtv\\"]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3})/g;

function lex(statement: string): Token[] {
  const tokens: Token[] = [];
  let rest = statement;
  while (rest !== "") {
    const rule = LEXER.map(([type, pattern]) => [type, pattern.exec(rest)] as const).find(([, match]) => match !== null);
    if (rule === undefined) throw new Error(`no token at: ${rest}`);
    const [type, match] = rule;
    if (type === "String" && match![0].slice(1, -1).replace(STRING_ESCAPE, "").includes("\\")) {
      throw new Error(`invalid escape in ${match![0]}`);
    }
    if (type !== "whitespace") tokens.push({ type, value: match![0] });
    rest = rest.slice(match![0].length);
  }
  return tokens;
}

/** Editors and converters the templates call, with their arguments' count (required, all), at v0.162.0. */
const SIGNATURES: Readonly<Record<string, readonly [number, number, string]>> = {
  set: [2, 2, "pkg/ottl/ottlfuncs/func_set.go:13-16"],
  delete_key: [2, 2, "pkg/ottl/ottlfuncs/func_delete_key.go:13-16"],
  keep_keys: [2, 2, "pkg/ottl/ottlfuncs/func_keep_keys.go:15-18"],
  truncate_all: [2, 4, "pkg/ottl/ottlfuncs/func_truncate_all.go:17-22"],
  replace_pattern: [3, 5, "pkg/ottl/ottlfuncs/func_replace_pattern.go:21-27"],
  limit: [3, 3, "pkg/ottl/ottlfuncs/func_limit.go:17-21"],
  convert_sum_to_gauge: [0, 0, "processor/transformprocessor/internal/metrics/func_convert_sum_to_gauge.go:16"],
  scale_metric: [1, 2, "processor/transformprocessor/internal/metrics/func_scale.go:17-20"],
  extract_count_metric: [1, 2, "processor/transformprocessor/internal/metrics/func_extract_count_metric.go:18-21"],
  extract_sum_metric: [1, 2, "processor/transformprocessor/internal/metrics/func_extract_sum_metric.go:19-22"],
  IsMap: [1, 1, "pkg/ottl/ottlfuncs/func_is_map.go:13-15"],
  IsMatch: [2, 2, "pkg/ottl/ottlfuncs/func_is_match.go:13-16"],
};

/** A recursive-descent parse of the OTTL the templates use; returns the paths' first segments. Throws on what OTTL's grammar refuses. */
function parseStatement(statement: string): string[] {
  const tokens = lex(statement);
  let at = 0;
  const contexts: string[] = [];
  const peek = () => tokens[at];
  const take = (type: string, value?: string) => {
    const token = tokens[at];
    if (token === undefined || token.type !== type || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? type} at ${at} in ${statement}, got ${token?.value ?? "the end"}`);
    }
    at++;
    return token;
  };
  const call = (name: string) => {
    take("LParen");
    let count = 0;
    if (peek()?.type !== "RParen") {
      value();
      count++;
      while (peek()?.value === ",") {
        take("Punct", ",");
        value();
        count++;
      }
    }
    take("RParen");
    const signature = SIGNATURES[name];
    if (signature === undefined) throw new Error(`unknown function ${name}`);
    if (count < signature[0] || count > signature[1]) throw new Error(`${name} takes ${signature[0]}-${signature[1]} arguments, got ${count}`);
  };
  const indexes = () => {
    while (peek()?.value === "[") {
      take("Punct", "[");
      if (peek()?.type === "String") take("String");
      else take("Int");
      take("Punct", "]");
    }
  };
  function value(): "call" | "other" {
    const token = peek();
    if (token === undefined) throw new Error(`expected a value in ${statement}`);
    if (["String", "Int", "Float", "Bytes", "Boolean", "Nil"].includes(token.type)) {
      at++;
      return "other";
    }
    if (token.value === "[") {
      take("Punct", "[");
      if (peek()?.value !== "]") {
        value();
        while (peek()?.value === ",") {
          take("Punct", ",");
          value();
        }
      }
      take("Punct", "]");
      return "other";
    }
    if (token.type === "Uppercase") {
      // A converter's name is its tokens run together (grammar.go:212, `Uppercase(Uppercase | Lowercase)*`: `IsMatch`
      // lexes as `I`, `s`, `M`, `atch`); an enum is one Uppercase not followed by a Lowercase (grammar.go:286).
      let name = take("Uppercase").value;
      while (peek()?.type === "Uppercase" || peek()?.type === "Lowercase") name += take(peek()!.type).value;
      if (peek()?.type === "LParen") {
        call(name);
        indexes();
        return "call";
      }
      if (name !== token.value) throw new Error(`${name} isn't an enum or a call in ${statement}`);
      return "other";
    }
    // A path: segments joined by `.`, then keys (grammar.go:325-359).
    contexts.push(take("Lowercase").value);
    while (peek()?.value === ".") {
      take("Punct", ".");
      take("Lowercase");
    }
    indexes();
    return "other";
  }
  const comparison = () => {
    if (peek()?.type === "OpNot") take("OpNot");
    if (peek()?.type === "LParen") {
      take("LParen");
      condition();
      take("RParen");
      return;
    }
    const left = value();
    if (peek()?.type === "OpComparison") {
      take("OpComparison");
      value();
    } else if (left !== "call") {
      throw new Error(`expected a comparison at ${at} in ${statement}, got ${peek()?.value ?? "the end"}`);
    }
  };
  function condition() {
    comparison();
    while (peek()?.type === "OpAnd" || peek()?.type === "OpOr") {
      at++;
      comparison();
    }
  }
  // The editor (grammar.go:197, `Lowercase(Uppercase | Lowercase)*`).
  call(take("Lowercase").value);
  if (peek() !== undefined) {
    take("Lowercase", "where");
    condition();
  }
  if (peek() !== undefined) throw new Error(`unexpected ${peek()!.value} in ${statement}`);
  return contexts;
}

/** The contexts each signal's statements may name (`processor/transformprocessor/README.md:59-66`). */
const SIGNAL_CONTEXTS: Readonly<Record<string, readonly string[]>> = {
  trace: ["resource", "scope", "span", "spanevent"],
  metric: ["resource", "scope", "metric", "datapoint", "exemplar"],
  log: ["resource", "scope", "log"],
  all: ["resource", "scope"],
};

describe("the template table", () => {
  const PINNED: Readonly<Record<string, readonly string[]>> = {
    "Redact Sensitive Headers": [
      'delete_key(span.attributes, "http.request.header.authorization")',
      'delete_key(span.attributes, "http.request.header.cookie")',
      'delete_key(span.attributes, "http.request.header.x-api-key")',
    ],
    // The regex library's patterns as OTTL strings (pkg/ottl/grammar.go:588; parser.go:424 unquotes Go-style).
    "Redact Passwords in URLs": [
      'replace_pattern(span.attributes["http.url"], "password=([^&]+)", "password=***")',
      'replace_pattern(span.attributes["process.command_line"], "password\\\\=([^\\\\s]*)", "password=***")',
    ],
    "Keep Essential Attributes": [
      'keep_keys(span.attributes, ["http.method", "http.status_code", "http.route", "service.name"])',
      "truncate_all(span.attributes, 1000)",
    ],
    "Set Error Status": [
      'set(span.status.code, STATUS_CODE_ERROR) where span.attributes["http.status_code"] >= 500',
      'set(span.status.message, "Server Error") where span.attributes["http.status_code"] >= 500',
    ],
    "Convert Sum to Gauge": ['convert_sum_to_gauge() where metric.name == "system.memory.usage"'],
    "Scale Time Units": ['scale_metric(0.001) where metric.unit == "ms"', 'set(metric.unit, "s") where metric.unit == "ms"'],
    "Limit Metric Labels": [
      'keep_keys(resource.attributes, ["service.name", "service.namespace", "deployment.environment"])',
      'limit(datapoint.attributes, 100, ["host.name", "service.name"])',
    ],
    "Extract Histogram Metrics": [
      'extract_count_metric(true, ".count") where metric.type == METRIC_DATA_TYPE_HISTOGRAM',
      'extract_sum_metric(true, ".sum") where metric.type == METRIC_DATA_TYPE_HISTOGRAM',
    ],
    "Redact Log Secrets": [
      'delete_key(log.attributes, "password") where log.attributes["password"] != nil',
      'delete_key(log.attributes, "api_key") where log.attributes["api_key"] != nil',
      'delete_key(log.attributes, "token") where log.attributes["token"] != nil',
    ],
    "Extract JSON Fields": [
      'set(log.attributes["http.method"], log.body["method"]) where IsMap(log.body)',
      'set(log.attributes["http.path"], log.body["path"]) where IsMap(log.body)',
      'set(log.attributes["http.status"], log.body["status"]) where IsMap(log.body)',
    ],
    // OTTL has no `contains` (grammar.go:593): a substring match is IsMatch, case-sensitive as the literal intends.
    "Set Log Severity": [
      'set(log.severity_text, "ERROR") where IsMatch(log.body, "error")',
      'set(log.severity_text, "WARN") where IsMatch(log.body, "warning")',
      'set(log.severity_text, "INFO") where IsMatch(log.body, "info")',
    ],
    "Add Environment Tags": ['set(resource.attributes["environment"], "production")', 'set(resource.attributes["region"], "us-west-2")'],
  };

  it("pins each of the twelve templates' statements", () => {
    expect(EXAMPLE_PATTERNS.map((example) => example.name)).toEqual(Object.keys(PINNED));
    for (const example of EXAMPLE_PATTERNS) expect(example.statements).toEqual(PINNED[example.name]);
  });

  it.each(EXAMPLE_PATTERNS.map((example) => [example.name, example] as const))(
    "%s: every statement parses under OTTL's grammar, its functions' signatures and its signal's contexts",
    (_name, example) => {
      for (const statement of example.statements) {
        const contexts = parseStatement(statement);
        expect(contexts.length).toBeGreaterThan(0);
        for (const context of contexts) expect(SIGNAL_CONTEXTS[example.signalType]).toContain(context);
      }
    },
  );

  it("the check refuses a `contains` comparison, an unknown function and a wrong argument count", () => {
    expect(() => parseStatement('set(log.severity_text, "ERROR") where log.body contains "error"')).toThrow(/expected a comparison/);
    expect(() => parseStatement("contains(log.body)")).toThrow(/unknown function/);
    expect(() => parseStatement("delete_key(log.attributes)")).toThrow(/takes 2-2/);
    // `\d` isn't one of Go's escapes: participle.Unquote (strconv.Unquote) refuses it (pkg/ottl/parser.go:424).
    expect(() => parseStatement('replace_pattern(span.name, "\\d", "x")')).toThrow(/escape/);
    expect(() => parseStatement('replace_pattern(span.name, "\\\\d", "x")')).not.toThrow();
    // An unescaped quote ends the string early: the rest doesn't lex as one.
    expect(lex('"a\\"b"')).toEqual([{ type: "String", value: '"a\\"b"' }]);
  });

  it("T2 is built with ottlString from the regex library, matching the hand-escaped pattern", () => {
    const [url, commandLine] = template("Redact Passwords in URLs").statements;
    expect(url).toBe(`replace_pattern(span.attributes["http.url"], ${ottlString(findPattern("Password in URL Query").pattern)}, "password=***")`);
    expect(commandLine).toBe(
      `replace_pattern(span.attributes["process.command_line"], "${findPattern("Password in Command Line").pattern.replace(/\\/g, "\\\\")}", "password=***")`,
    );
  });

  it("T10 says what its statements do; T11 never uses contains", () => {
    expect(template("Extract JSON Fields").description).toBe("Copy fields of a map log body (already-parsed JSON) into attributes.");
    for (const statement of template("Set Log Severity").statements) expect(statement).not.toContain("contains");
  });
});

// ── The statement lists, and their held rows and cards ──

describe("transform: held rows and cards", () => {
  it("Add Statement Group holds a card; what is typed before a statement is held with it; the first statement writes the group before the flat statements, one change, focus kept", async () => {
    const user = renderForm(TR);
    await openSection(user, "Trace Statements");
    await user.click(addGroup());
    // The held card shows where it goes: after the groups, before the flat statements.
    expect(screen.getAllByRole("button", { name: /^Statement Group \d$/ }).map((b) => b.textContent)).toEqual([
      "Statement Group 1",
      "Statement Group 2",
      "Statement Group 3",
    ]);
    expect(addGroup()).toBeDisabled();
    await typeInto(user, byId("transform-trace-group-2-context"), "span");
    await pickIn(user, byId("transform-trace-group-2-error-mode"), "Propagate");
    await user.click(within(groupCard(3)).getByRole("button", { name: "Add Condition" }));
    await typeInto(user, byId("transform-trace-group-2-conditions"), "span.kind == SPAN_KIND_SERVER");
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);

    const statement = byId("transform-trace-group-2-statements");
    await user.click(statement);
    await user.keyboard(escapeKeys('set(span.attributes["tier"], "web")'));
    await act(() => new Promise((resolve) => setTimeout(resolve, FIELD_WRITE_DELAY_MS + 50)));
    expect(entries()).toBe(1);
    expect(statementsOf(valueOf(TR))).toEqual([
      expect.objectContaining({ context: "resource" }),
      expect.objectContaining({ statements: [expect.stringContaining("STATUS_CODE_ERROR")] }),
      {
        context: "span",
        error_mode: "propagate",
        conditions: ["span.kind == SPAN_KIND_SERVER"],
        statements: ['set(span.attributes["tier"], "web")'],
      },
      'set(span.attributes["env"], "prod")',
      "truncate_all(span.attributes, 4096)",
    ]);
    expect(LF(text())).toContain(
      `${STATUS_500}      - context: span\n        error_mode: propagate\n        conditions:\n          - span.kind == SPAN_KIND_SERVER\n        statements:\n          - set(span.attributes["tier"], "web")\n      - set(span.attributes["env"], "prod")\n`,
    );
    // The same input, still focused: the held card became the group's.
    expect(byId("transform-trace-group-2-statements")).toBe(statement);
    expect(document.activeElement).toBe(statement);
    expect(addGroup()).toBeEnabled();
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("a held card's place is worked out from the list it is written into: a YAML box change keeping the list's length that turns the group into a flat statement puts the group first", async () => {
    const base = ownText("transform", '    trace_statements:\n      - statements:\n          - set(span.name, "g")\n      - set(span.name, "a")\n');
    const user = renderForm(TR, base);
    await openSection(user, "Trace Statements");
    await user.click(addGroup());
    expect(byId("transform-trace-group-1-statements")).toBeInTheDocument();
    // The YAML box (setComponentValue): the same length, the group now a flat statement.
    act(() => void builderStore().setComponentValue(componentNamed(TR).id, 'trace_statements:\n  - set(span.name, "z")\n  - set(span.name, "a")\n'));
    expect(statementsOf(valueOf(TR))).toEqual(['set(span.name, "z")', 'set(span.name, "a")']);
    // The held card stays, shown where it goes now: first.
    expect(screen.getAllByRole("button", { name: /^Statement Group \d$/ }).map((b) => b.textContent)).toEqual(["Statement Group 1"]);
    await typeInto(user, byId("transform-trace-group-0-statements"), 'set(span.name, "new")');
    expect(statementsOf(valueOf(TR))).toEqual([{ statements: ['set(span.name, "new")'] }, 'set(span.name, "z")', 'set(span.name, "a")']);
    expect(screen.queryByText(REFUSED_ORDER_HINT)).toBeNull();
  });

  it("a held card's place is worked out from the list it is written into: an undo keeping the list's length that turns a group back into a flat statement puts the group first", async () => {
    const base = ownText("transform", '    trace_statements:\n      - set(span.name, "a")\n      - set(span.name, "b")\n');
    const user = renderForm(TR, base);
    await openSection(user, "Trace Statements");
    act(() => void builderStore().setComponentValues(componentNamed(TR).id, [{ path: ["trace_statements", 0], value: { statements: ['set(span.name, "g")'] } }]));
    stepPastRuns();
    await user.click(addGroup());
    // Held after the group, before the flat statement.
    expect(byId("transform-trace-group-1-statements")).toBeInTheDocument();
    act(() => void builderStore().undo());
    expect(text()).toBe(base);
    await typeInto(user, byId("transform-trace-group-0-statements"), 'set(span.name, "new")');
    expect(statementsOf(valueOf(TR))).toEqual([{ statements: ['set(span.name, "new")'] }, 'set(span.name, "a")', 'set(span.name, "b")']);
    expect(screen.queryByText(REFUSED_ORDER_HINT)).toBeNull();
  });

  it("a held card writes nothing until a statement is typed: its Remove drops it; it never writes {}, conditions: [] or \"\"", async () => {
    const user = renderForm(TR);
    await openSection(user, "Trace Statements");
    await user.click(addGroup());
    await typeInto(user, byId("transform-trace-group-2-context"), "span");
    await retypeInto(user, byId("transform-trace-group-2-context"), "");
    await user.click(within(groupCard(3)).getByRole("button", { name: "Add Condition" }));
    await user.click(byId("transform-trace-group-2-conditions"));
    await user.tab();
    await user.click(byId("transform-trace-group-2-statements"));
    await user.tab();
    expect(text()).toBe(CORPUS);
    await user.click(within(groupCard(3)).getByRole("button", { name: "Remove statement group" }));
    expect(screen.queryByRole("button", { name: "Statement Group 3" })).toBeNull();
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
  });

  it("a held card in a list with no flat statements is appended; in an absent list, it writes the list", async () => {
    const user = renderForm(TR_FLAT);
    await openSection(user, "Trace Statements");
    expect(hint("No statements configured")).toBeInTheDocument();
    await user.click(addGroup());
    await typeInto(user, byId("transform-trace-group-0-statements"), 'set(span.name, "a")');
    expect(statementsOf(valueOf(TR_FLAT))).toEqual([{ statements: ['set(span.name, "a")'] }]);
    expect(LF(text())).toContain('  transform/flat:\n    log_statements:\n      - set(log.body, log.attributes["message"]) where log.attributes["message"] != nil\n    trace_statements:\n      - statements:\n          - set(span.name, "a")\n');
  });

  it("Add Statement holds a row; its first typing appends the statement; left empty it goes; emptied and left, a statement is removed, never written \"\"", async () => {
    const user = renderForm(TR);
    await openSection(user, "Trace Statements");
    await user.click(addFlat());
    expect(byId("transform-trace-statement-4")).toHaveValue("");
    // The held card and the held row are one at a time.
    expect(addGroup()).toBeDisabled();
    await user.click(byId("transform-trace-statement-4"));
    await user.tab();
    expect(document.getElementById("transform-trace-statement-4")).toBeNull();
    expect(text()).toBe(CORPUS);

    await retypeInto(user, byId("transform-trace-statement-3"), "");
    expect(statementsOf(valueOf(TR))).toHaveLength(3);
    expect(LF(text())).not.toContain("truncate_all");
    expect(LF(text())).not.toContain("''");
    expect(entries()).toBe(1);
  });

  it("a held row in an absent list writes the list with the statement", async () => {
    const user = renderForm(TR_FLAT);
    await openSection(user, "Metric Statements");
    await user.click(addFlat());
    await typeInto(user, byId("transform-metric-statement-0"), 'set(metric.unit, "s")');
    expect(statementsOf(valueOf(TR_FLAT), "metric_statements")).toEqual(['set(metric.unit, "s")']);
    expect(entries()).toBe(1);
  });

  it("a held row survives a write elsewhere in the form; a change of its list's length drops it", async () => {
    const user = renderForm(TR);
    await openSection(user, "Trace Statements");
    await user.click(addFlat());
    await pickIn(user, byId("error-mode"), "Silent - Suppress error logs");
    expect(byId("transform-trace-statement-4")).toBeInTheDocument();
    await user.click(within(groupCard(1)).getByRole("button", { name: "Remove statement group" }));
    // The flat statements are items 1 and 2 now; the held row (item 4's) went with the length.
    expect(byId("transform-trace-statement-2")).toHaveValue("truncate_all(span.attributes, 4096)");
    expect(document.getElementById("transform-trace-statement-3")).toBeNull();
  });

  it("a group's only statement can't be removed (never statements: [\"\"]); with two, Remove removes one; Remove statement group removes the group", async () => {
    const user = renderForm(TR);
    await openSection(user, "Trace Statements");
    const only = within(groupCard(1)).getByRole("button", { name: "Remove statement" });
    expect(only).toBeDisabled();
    // Emptied and left, the only statement stays.
    await retypeInto(user, byId("transform-trace-group-0-statements"), "");
    expect(text()).toBe(CORPUS);

    await openSection(user, "Trace Statements");
    await openSection(user, "Log Statements");
    const logGroup = groupCard(1);
    const removes = within(logGroup).getAllByRole("button", { name: "Remove statement" });
    expect(removes).toHaveLength(2);
    await user.click(removes[1]!);
    expect(groupOf(valueOf(TR), 0, "log_statements").statements).toEqual(['set(severity_text, "FAIL") where body == "request failed"']);
    expect(within(logGroup).getByRole("button", { name: "Remove statement" })).toBeDisabled();

    stepPastRuns();
    await openSection(user, "Log Statements");
    await openSection(user, "Trace Statements");
    await user.click(within(groupCard(2)).getByRole("button", { name: "Remove statement group" }));
    expect(statementsOf(valueOf(TR))).toEqual([expect.objectContaining({ context: "resource" }), 'set(span.attributes["env"], "prod")', "truncate_all(span.attributes, 4096)"]);
  });

  it("Conditions: the empty line; Add Condition holds a row; the last condition removed removes conditions", async () => {
    const text1 = ownText(
      "transform",
      [
        "    trace_statements:",
        "      - context: span",
        "        conditions:",
        "          - span.kind == SPAN_KIND_SERVER # servers",
        "        statements:",
        '          - set(span.name, "a")',
        "      - statements:",
        '          - set(span.name, "b")',
      ].join("\n"),
    );
    const user = renderForm(TR, text1);
    await openSection(user, "Trace Statements");
    expect(within(groupCard(2)).getByText(NO_CONDITIONS)).toBeInTheDocument();
    expect(within(groupCard(1)).queryByText(NO_CONDITIONS)).toBeNull();
    await user.click(within(groupCard(2)).getByRole("button", { name: "Add Condition" }));
    expect(within(groupCard(2)).queryByText(NO_CONDITIONS)).toBeNull();
    expect(text()).toBe(text1);
    await user.click(within(groupCard(1)).getByRole("button", { name: "Remove condition" }));
    expect(groupOf(valueOf(TR), 0)).toEqual({ context: "span", statements: ['set(span.name, "a")'] });
    expect(LF(text())).toContain("      - context: span\n        statements:\n");
  });

  it("a group's Error Mode: unset shows Inherited; Inherited chosen removes the key", async () => {
    const text1 = ownText("transform", "    trace_statements:\n      - error_mode: propagate # strict\n        statements:\n          - set(span.name, \"a\")\n");
    const user = renderForm(TR, text1);
    await openSection(user, "Trace Statements");
    expect(byId("transform-trace-group-0-error-mode")).toHaveTextContent("Propagate");
    await pickIn(user, byId("transform-trace-group-0-error-mode"), "Inherited");
    expect(groupOf(valueOf(TR), 0)).toEqual({ statements: ['set(span.name, "a")'] });
    expect(byId("transform-trace-group-0-error-mode")).toHaveTextContent("Inherited");
  });

  it("a collapsed group shows its summary as text; its state follows the group", async () => {
    const user = renderForm(TR);
    await openSection(user, "Log Statements");
    await user.click(screen.getByRole("button", { name: "Statement Group 1" }));
    expect(screen.getByRole("button", { name: "Statement Group 1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("2 statements · log")).toBeInTheDocument();
  });

  it("a group the form can't show is a card with the unshowable-value hint, still removable; a list it can't show, the hint", async () => {
    const text1 = ownText("transform", "    trace_statements:\n      - 5\n      - set(span.name, \"a\")\n    log_statements: oops\n");
    const user = renderForm(TR, text1);
    await openSection(user, "Trace Statements");
    expect(within(groupCard(1)).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    await openSection(user, "Log Statements");
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
    await user.click(within(groupCard(1)).getByRole("button", { name: "Remove statement group" }));
    expect(statementsOf(valueOf(TR))).toEqual(['set(span.name, "a")']);
  });

  it("Error Mode unset shows the collector's default, ignore (factory.go:174), as filter's; never propagate", () => {
    renderForm(TR_FLAT);
    expect(byId("error-mode")).toHaveTextContent("Ignore - Log errors and continue (recommended for production)");
    expect(hint("Default ignore")).toBeInTheDocument();
  });

  it("each signal's placeholders name its own paths", async () => {
    const text1 = ownText(
      "transform",
      ["trace", "metric", "log"]
        .map((signal) => `    ${signal}_statements:\n      - statements:\n          - x\n      - y`)
        .join("\n"),
    );
    const user = renderForm(TR, text1);
    for (const section of SECTIONS) {
      await openSection(user, section.title);
      const prefix = `transform-${section.signal}`;
      expect(byId(`${prefix}-statement-1`)).toHaveAttribute("placeholder", section.statement);
      expect(byId(`${prefix}-group-0-statements`)).toHaveAttribute("placeholder", section.groupStatement);
      expect(byId(`${prefix}-group-0-context`)).toHaveAttribute("placeholder", "e.g. span");
      await user.click(within(byId(`${prefix}-group-0-context`).closest("div.rounded-lg") as HTMLElement).getByRole("button", { name: "Add Condition" }));
      expect(byId(`${prefix}-group-0-conditions`)).toHaveAttribute("placeholder", section.condition);
    }
    expect(SECTIONS.map((s) => [s.statement, s.groupStatement, s.condition])).toEqual([
      ['e.g. set(span.name, "redacted") where span.attributes["sensitive"] == true', 'e.g. set(span.attributes["env"], "prod")', "e.g. span.kind == SPAN_KIND_SERVER"],
      [
        'e.g. set(metric.description, "CPU usage") where metric.name == "system.cpu.time"',
        'e.g. set(metric.description, "CPU usage")',
        "e.g. metric.type == METRIC_DATA_TYPE_SUM",
      ],
      [
        'e.g. set(log.severity_text, "WARN") where log.severity_number == SEVERITY_NUMBER_WARN',
        'e.g. set(log.attributes["env"], "prod")',
        "e.g. IsMap(log.body)",
      ],
    ]);
  });

  it("a statement over several lines is shown and kept (a Textarea, Enter a new line)", async () => {
    const text1 = ownText("transform", "    log_statements:\n      - |-\n        set(log.body, \"a\")\n        where IsMap(log.body)\n      - statements:\n          - \"set(log.body, \\\"b\\\")\\nwhere true\"\n");
    const user = renderForm(TR, text1);
    await openSection(user, "Log Statements");
    expect(byId("transform-log-statement-0")).toHaveValue('set(log.body, "a")\nwhere IsMap(log.body)');
    expect(byId("transform-log-group-1-statements")).toHaveValue('set(log.body, "b")\nwhere true');
    await user.click(byId("transform-log-statement-0"));
    await user.keyboard("{Control>}{End}{/Control}{Enter}and true");
    await user.tab();
    expect(statementsOf(valueOf(TR), "log_statements")[0]).toBe('set(log.body, "a")\nwhere IsMap(log.body)\nand true');
  });
});

describe("transform: the two runs, and a refused order", () => {
  it("dragging a group moves its own lines within the groups; the last group can't go past the flat statements", async () => {
    layOutRows();
    const user = renderForm(TR);
    await openSection(user, "Trace Statements");
    // Handles: two groups, then two flat statements.
    expect(handles()).toHaveLength(4);
    await dragByKeyboard(handles()[0]!, 1);
    // The comment above the first item is its own: it moves with it (text edits).
    const resource = `      # a group whose context is set, then one inferred, then flat statements\n      - context: resource\n        statements:\n${KEEP_KEYS}`;
    const status = `      - statements:\n${STATUS_500}`;
    expect(text()).toBe(CORPUS.replace(resource + status, status + resource));
    expect(entries()).toBe(1);

    await dragByKeyboard(handles()[1]!, 3);
    expect(entries()).toBe(1);
    expect(statementsOf(valueOf(TR)).map((item) => typeof item)).toEqual(["object", "object", "string", "string"]);
    void user;
  });

  it("dragging a flat statement moves it within the flat statements, its comment with it; never before a group", async () => {
    layOutRows();
    renderForm(TR);
    await openSection(userEvent.setup(), "Trace Statements");
    await dragByKeyboard(handles()[3]!, -1);
    expect(text()).toBe(CORPUS.replace(`      - set(span.attributes["env"], "prod")\n${TRUNCATE}`, `${TRUNCATE}      - set(span.attributes["env"], "prod")\n`));
    stepPastRuns();
    await dragByKeyboard(handles()[2]!, -3);
    expect(statementsOf(valueOf(TR)).map((item) => typeof item)).toEqual(["object", "object", "string", "string"]);
    expect(entries()).toBe(1);
  });

  it("moves in a multi-line flow list keep each statement's comment", async () => {
    layOutRows();
    const flow = ownText(
      "transform",
      ["    trace_statements: [", `      'set(span.name, "a")', # first`, `      'set(span.name, "b")' # second`, "    ]"].join("\n"),
    );
    renderForm(TR, flow);
    await openSection(userEvent.setup(), "Trace Statements");
    await dragByKeyboard(handles()[0]!, 1);
    expect(LF(text())).toContain("    trace_statements: [\n      'set(span.name, \"b\")', # second\n      'set(span.name, \"a\")' # first\n    ]\n");
    expect(statementsOf(valueOf(TR))).toEqual(['set(span.name, "b")', 'set(span.name, "a")']);
  });

  it("a text whose order is refused (config.go:110-123) shows as written, dragging off, with the hint; Add Statement Group and a template go before the first flat statement", async () => {
    const refused = ownText(
      "transform",
      ["    trace_statements:", '      - set(span.name, "flat") # first', "      - statements:", '          - set(span.name, "group")'].join("\n"),
    );
    const user = renderForm(TR, refused);
    await openSection(user, "Trace Statements");
    expect(hint(REFUSED_ORDER_HINT)).toBeInTheDocument();
    // As written: the flat statement, then the group (Statement Group 2, its list index).
    expect(byId("transform-trace-statement-0")).toHaveValue('set(span.name, "flat")');
    expect(screen.getByRole("button", { name: "Statement Group 2" })).toBeInTheDocument();
    for (const handle of handles()) expect(handle).toBeDisabled();

    await user.click(addGroup());
    await typeInto(user, byId("transform-trace-group-0-statements"), 'set(span.name, "new")');
    expect(statementsOf(valueOf(TR))).toEqual([{ statements: ['set(span.name, "new")'] }, 'set(span.name, "flat")', { statements: ['set(span.name, "group")'] }]);

    stepPastRuns();
    await openSection(user, "Examples & Reference");
    await addTemplate(user, "Set Error Status");
    expect(statementsOf(valueOf(TR)).map((item) => (typeof item === "string" ? "flat" : "group"))).toEqual(["group", "group", "flat", "group"]);
  });
});

// ── logdedup ──

const LD_SEED = ownText("logdedup", "    interval: 10s\n    log_count_attribute: log_count\n    timezone: UTC\n", "logs");

describe("LogDedupProcessorForm (7 cases)", () => {
  it("renders default config values in the form fields", () => {
    renderForm(LD, LD_SEED);
    expect(byId("interval")).toHaveValue("10s");
    expect(byId("log-count-attribute")).toHaveValue("log_count");
    expect(byId("timezone")).toHaveValue("UTC");
  });

  it("renders custom config values, including section fields", async () => {
    const custom = ownText(
      "logdedup",
      [
        "    interval: 60s",
        "    log_count_attribute: dedup_count",
        "    timezone: America/Los_Angeles",
        "    include_fields: [attributes.id]",
        "    conditions:",
        '      - resource.attributes["service.name"] == "my-service"',
      ].join("\n"),
      "logs",
    );
    const user = renderForm(LD, custom);
    expect(byId("interval")).toHaveValue("60s");
    expect(byId("log-count-attribute")).toHaveValue("dedup_count");
    expect(byId("timezone")).toHaveValue("America/Los_Angeles");
    await user.click(screen.getByText("Match Scope"));
    expect(screen.getByDisplayValue("attributes.id")).toBeInTheDocument();
    await user.click(screen.getByText("Conditions"));
    expect(screen.getByDisplayValue('resource.attributes["service.name"] == "my-service"')).toBeInTheDocument();
  });

  it("warns when include_fields and exclude_fields are both set (config.go:85-87), the section forced open", () => {
    renderForm(LD, ownText("logdedup", "    include_fields: [attributes.id]\n    exclude_fields: [body.timestamp]\n", "logs"));
    expect(screen.getByText("Conflicting field lists")).toBeInTheDocument();
    expect(screen.getByDisplayValue("attributes.id")).toBeInTheDocument();
  });

  it("does not warn when only one field list is set", () => {
    renderForm(LD, ownText("logdedup", "    exclude_fields: [body.timestamp]\n", "logs"));
    expect(screen.queryByText("Conflicting field lists")).not.toBeInTheDocument();
  });

  it("an edit changes only its own lines (and the YAML stays valid)", async () => {
    const user = renderForm(LD, LD_SEED);
    await retypeInto(user, byId("interval"), "20s");
    expect(text()).toBe(LD_SEED.replace("    interval: 10s\n", "    interval: 20s\n"));
  });

  it("survives a round trip with matching DOM values: opening writes nothing", () => {
    renderForm(LD, LD_SEED);
    expect(byId("interval")).toHaveValue("10s");
    expect(byId("log-count-attribute")).toHaveValue("log_count");
    expect(text()).toBe(LD_SEED);
  });

  it("the canonical log_dedup key is the logdedup palette component, and gets this form (metadata.yaml:2-3)", () => {
    const canonical = [
      "receivers:",
      "  filelog:",
      "    include:",
      "      - /var/log/app/*.log",
      "processors:",
      "  log_dedup:",
      "    interval: 60s",
      "    log_count_attribute: dedup_count",
      "    conditions:",
      '      - resource.attributes["service.name"] == "my-service"',
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    logs:",
      "      receivers: [filelog]",
      "      processors: [log_dedup]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    openText(canonical);
    const node = componentNamed("processors.log_dedup");
    expect(paletteSubType(node.data.componentSubType, "processor")).toBe("logdedup");
    expect(formFor(node.data.componentType as ComponentType, node.data.componentSubType)).toBe(LogDedupProcessorForm);
    renderForm("processors.log_dedup", canonical);
    expect(byId("interval")).toHaveValue("60s");
    expect(byId("log-count-attribute")).toHaveValue("dedup_count");
  });
});

describe("logdedup: the fixes", () => {
  it("Include Fields is locked while Exclude Fields has items, with the hint; its items can still be removed; and the mirror", async () => {
    const user = renderForm(LD);
    await openSection(user, "Match Scope");
    const include = fieldOf("Include Fields");
    expect(within(include).getByText(INCLUDE_LOCKED_HINT)).toBeInTheDocument();
    expect(within(include).getByRole("button", { name: "Add" })).toBeDisabled();
    expect(within(fieldOf("Exclude Fields")).getByRole("button", { name: "Add" })).toBeEnabled();
    expect(queryHint(EXCLUDE_LOCKED_HINT)).toBeNull();
    cleanup();

    const both = ownText("logdedup", "    include_fields: [attributes.id]\n    exclude_fields: [body.timestamp, body.level]\n", "logs");
    const user2 = renderForm(LD, both);
    for (const label of ["Include Fields", "Exclude Fields"]) {
      expect(within(fieldOf(label)).getByRole("button", { name: "Add" })).toBeDisabled();
      for (const row of within(fieldOf(label)).getAllByRole("textbox")) expect(row).toBeDisabled();
    }
    expect(hint(INCLUDE_LOCKED_HINT)).toBeInTheDocument();
    expect(hint(EXCLUDE_LOCKED_HINT)).toBeInTheDocument();
    // Removing the include item unlocks Exclude Fields; the alert goes.
    await user2.click(within(fieldOf("Include Fields")).getByRole("button", { name: "Remove" }));
    expect(valueOf(LD)).toEqual({ exclude_fields: ["body.timestamp", "body.level"] });
    expect(screen.queryByText("Conflicting field lists")).toBeNull();
    expect(within(fieldOf("Exclude Fields")).getByRole("button", { name: "Add" })).toBeEnabled();
    expect(within(fieldOf("Include Fields")).getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("the lists' Add holds a row (never \"\"): left empty it goes; the last item removed removes the key", async () => {
    const user = renderForm(LD);
    await openSection(user, "Conditions");
    await user.click(within(fieldOf("OTTL Conditions")).getByRole("button", { name: "Add" }));
    await user.click(within(fieldOf("OTTL Conditions")).getAllByRole("textbox").at(-1)!);
    await user.tab();
    expect(text()).toBe(CORPUS);
    await user.click(within(fieldOf("OTTL Conditions")).getByRole("button", { name: "Remove" }));
    expect(valueOf(LD).conditions).toBeUndefined();
    expect(LF(text())).toContain("      - attributes.host\\.name\n  logdedup/include:\n");
  });

  it("Metadata Cardinality Limit shows while Metadata Keys has items, a number field: 0 is written plain (config.go:51-53); cleared removes it", async () => {
    const user = renderForm(LD, LD_SEED);
    await openSection(user, "Metadata Partitioning");
    expect(document.getElementById("metadata-cardinality-limit")).toBeNull();
    await user.click(within(fieldOf("Metadata Keys")).getByRole("button", { name: "Add" }));
    await typeInto(user, byId("metadata-keys"), "tenant.id");
    expect(byId("metadata-cardinality-limit")).toHaveAttribute("placeholder", "0");
    expect(hint("Max distinct metadata combinations tracked simultaneously. · Default 0 (unlimited)")).toBeInTheDocument();
    await typeInto(user, byId("metadata-cardinality-limit"), "0");
    expect(LF(text())).toContain("    metadata_keys:\n      - tenant.id\n    metadata_cardinality_limit: 0\n");
    expect(valueOf(LD).metadata_cardinality_limit).toBe(0);
    await retypeInto(user, byId("metadata-cardinality-limit"), "");
    expect(valueOf(LD).metadata_cardinality_limit).toBeUndefined();
  });

  it("shows the defaults as hints and placeholders, and Exclude Fields' corrected copy", async () => {
    const user = renderForm(LD, ownText("logdedup", "", "logs"));
    expect(byId("interval")).toHaveAttribute("placeholder", "10s");
    expect(byId("log-count-attribute")).toHaveAttribute("placeholder", "log_count");
    expect(byId("timezone")).toHaveAttribute("placeholder", "e.g. America/Los_Angeles");
    expect(hint("IANA timezone for the first/last observed timestamps. · Default UTC")).toBeInTheDocument();
    await openSection(user, "Match Scope");
    expect(hint(EXCLUDE_FIELDS_DESCRIPTION)).toBeInTheDocument();
    expect(hint("Prefix with body. or attributes.; escape literal dots as \\.")).toBeInTheDocument();
  });

  it("clearing Log Count Attribute removes it (the collector refuses an empty one, config.go:71-105)", async () => {
    const user = renderForm(LD, LD_SEED);
    await retypeInto(user, byId("log-count-attribute"), "");
    expect(text()).toBe(LD_SEED.replace("    log_count_attribute: log_count\n", ""));
  });
});

// ── Privacy ──

describe("privacy", () => {
  it("puts no statement, condition, context or value in any attribute: every section and card open, a held row and card", async () => {
    const MARK = "zq-mark";
    const marked = ownText(
      "transform",
      [
        `    error_mode: ${MARK}-mode`,
        "    trace_statements:",
        `      - context: ${MARK}-context`,
        `        error_mode: ${MARK}-gmode`,
        `        conditions: [${MARK}-cond]`,
        `        statements: [${MARK}-gstmt]`,
        `      - ${MARK}-flat`,
        "    log_statements:",
        `      - ${MARK}-flat2`,
        `      - statements: [${MARK}-late]`,
      ].join("\n"),
    );
    const user = renderForm(TR, marked);
    for (let round = 0; round < 3; round++) {
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    }
    await user.click(screen.getAllByRole("button", { name: "Add Statement Group" })[0]!);
    await user.click(screen.getAllByRole("button", { name: "Add Statement" }).at(-1)!);
    await user.click(byId("transform-log-statement-2"));
    await user.keyboard(`${MARK}-typed`);
    const shown =
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();
    for (const what of ["mode", "context", "gmode", "cond", "gstmt", "flat", "flat2", "late", "typed"]) expect(shown).toContain(`${MARK}-${what}`);
    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      // A controlled field's value property is its content, not an attribute: the replay masks inputs.
      for (const attribute of element.attributes) {
        if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
      if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(MARK)) leaks.push("option value");
    }
    expect(leaks).toEqual([]);
    cleanup();

    const dedup = ownText(
      "logdedup",
      [`    interval: ${MARK}-i`, `    include_fields: [${MARK}-f]`, `    conditions: [${MARK}-c]`, `    metadata_keys: [${MARK}-k]`, `    metadata_cardinality_limit: ${MARK}-l`].join("\n"),
      "logs",
    );
    const user2 = renderForm(LD, dedup);
    for (const button of screen.queryAllByRole("button", { expanded: false })) await user2.click(button);
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(text()).toBe(dedup);
  });
});

// ── Copy ──

describe("the forms' copy", () => {
  it("the hints' words, exactly", () => {
    expect(REFUSED_ORDER_HINT).toBe("The collector refuses a statement group after a flat statement. Reorder them in the YAML below.");
    expect(NO_CONDITIONS).toBe("No conditions (statements always run)");
    expect(EXCLUDE_FIELDS_DESCRIPTION).toBe("Fields ignored when matching and removed from the emitted log; the entire body cannot be excluded.");
    expect(INCLUDE_LOCKED_HINT).toBe("Can't be used while Exclude Fields has items.");
    expect(EXCLUDE_LOCKED_HINT).toBe("Can't be used while Include Fields has items.");
  });
});
