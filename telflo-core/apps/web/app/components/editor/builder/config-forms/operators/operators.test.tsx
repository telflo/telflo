import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "../form-context.js";
import { OPERATOR_FORMS } from "./forms/index.js";
import { JsonParserForm } from "./forms/JsonParserForm.js";
import { OPERATORS, operatorSeed } from "./operator-catalog.js";
import { OperatorPipeline, type OperatorSource } from "./OperatorPipeline.js";
import { BRACKET_HINT } from "./shared/FieldSelector.js";
import { useUndoRedo } from "~/hooks/useUndoRedo.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The operator framework: the pipeline, its cards, the Add Operator dialog,
 * the FieldSelector and the severity and timestamp sections, over the form
 * contract. Driven as a person would (clicking, typing, picking, dragging by
 * pointer and by keyboard) on the logs corpus (comments, an anchor, flow
 * items, `0750`), and each change checked in the text: the item's own lines,
 * nothing else.
 *
 * The JSON parser's cards hold its real form, which holds the shared pieces
 * these tests drive (Parse From, a rootable Parse To, the timestamp and
 * severity sections); the parsers' own fields are
 * `forms/parser-forms.test.tsx`'s.
 *
 * Collector claims cite contrib v0.162.0 (`pkg/stanza/`).
 */

const CORPUS = corpusText("forms-logs-operators.yaml");

const FILELOG = "receivers.filelog";
const JOURNALD = "receivers.journald";
const SYSLOG = "receivers.syslog";

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

/** The info toasts shown so far: the forms' adjustments toast their messages. */
const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const SOURCE_OF: Record<string, OperatorSource> = { [FILELOG]: "file", [JOURNALD]: "journal", [SYSLOG]: "syslog" };

function renderPipeline(key = FILELOG, text = CORPUS, extra?: ReactNode) {
  openText(text);
  const user = userEvent.setup();
  render(
    <>
      <ComponentForm nodeId={componentNamed(key).id}>
        <OperatorPipeline path={["operators"]} source={SOURCE_OF[key]!} />
      </ComponentForm>
      {extra}
    </>,
  );
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
type Value = Record<string, unknown>;
const valueOf = (written: string, key: string): Value => {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>)[section]![name]!;
};
const operatorsOf = (written: string, key = FILELOG) => valueOf(written, key).operators as Value[];
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const hintIn = (container: HTMLElement, whole: string) =>
  within(container).getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
/** `typed` as user-event types it: `[` and `{` are its key descriptors, doubled to type them. */
const literal = (typed: string) => typed.replace(/[[{]/g, "$&$&");

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** The card whose field `id` is in it. */
const cardOf = (id: string) => byId(id).closest(".rounded-lg.bg-card") as HTMLElement;

// ── Sortable cards ──

const ROW_HEIGHT = 40;

/** The sortable row an element is in: a child of a `space-y-3` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (parent?.classList.contains("space-y-3") && [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))) {
      return e;
    }
  }
  return null;
}

/** The row being dragged: the drag overlay (the dragged card's header) is measured where its row is. */
let dragFrom = 0;

const rowIndex = (element: Element) => {
  const row = rowOf(element);
  return row ? [...row.parentElement!.children].indexOf(row) : 0;
};

/** dnd-kit measures rows; jsdom's are all zero, so rows are laid out 40 px apart. */
function layOutRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // SortableList's overlay wrapper (`ring-blue-400`) holds the dragged card's header.
    const index = this.closest(".ring-blue-400") ? dragFrom : rowIndex(this);
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

/** Drags `handle` by keyboard: Space, `steps` arrows, Space. */
async function dragByKeyboard(handle: HTMLElement, steps: number) {
  dragFrom = rowIndex(handle);
  act(() => handle.focus());
  await press(handle, " ", "Space");
  for (let i = 0; i < Math.abs(steps); i++) await press(handle, steps > 0 ? "ArrowDown" : "ArrowUp");
  await press(handle, " ", "Space");
}

/**
 * A pointer event at `y`. jsdom has no PointerEvent, so it is a mouse event of
 * the pointer's type, primary, as dnd-kit's PointerSensor reads one
 * (`isPrimary`, `button`, `clientX`/`clientY`).
 */
function pointerAt(type: string, target: EventTarget, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 20, clientY: y });
  Object.defineProperty(event, "isPrimary", { value: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target as Element, event);
}

/** Drags `handle` by pointer: pressed, moved past the 8 px threshold, then `rows` rows, and released. */
async function dragByPointer(handle: HTMLElement, rows: number) {
  dragFrom = rowIndex(handle);
  const start = dragFrom * ROW_HEIGHT + 20;
  const end = start + rows * ROW_HEIGHT;
  const steps: [string, EventTarget, number][] = [
    ["pointerdown", handle, start],
    ["pointermove", document, start + 10],
    ["pointermove", document, (start + end) / 2],
    ["pointermove", document, end],
    ["pointerup", document, end],
  ];
  for (const [type, target, y] of steps) {
    await act(async () => {
      pointerAt(type, target, y);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const handles = () => screen.getAllByRole("button", { name: "Drag to reorder" });

// The filelog corpus' operators, as written.
const PARSE_OP = [
  "      # parse the JSON body",
  "      - type: json_parser",
  "        id: parse",
  "        parse_from: body",
  "        timestamp:",
  "          parse_from: attributes.time",
  "          layout_type: strptime",
  "          layout: '%Y-%m-%d %H:%M:%S'",
  "        severity:",
  "          parse_from: attributes.level",
  "",
].join("\n");
const ROUTER_OP = [
  "      - type: router",
  "        routes:",
  "          - expr: 'attributes.level == \"error\"'",
  "            output: errors",
  "        default: move",
  "",
].join("\n");
const ADD_OP = ["      - type: add # a value typed as a number", "        id: errors", "        field: attributes.priority", "        value: 0750", ""].join("\n");
const MOVE_OP = "      - {type: move, id: move, from: attributes.msg, to: body}\n";
const RETAIN_TAIL = ["      - type: retain", "        fields:", "          - attributes.team", '          - resource["service.name"]', ""].join("\n");


/** The corpus' journald operators after its regex parser: the JSON parser, a type outside the 26, a scalar item. */
const JOURNALD_JSON = [
  "      # the message's JSON, with epoch time and a mapping as written",
  "      - type: json_parser",
  '        parse_from: body["message.json"]',
  "        parse_to: attributes",
  "        timestamp:",
  "          parse_from: attributes.time",
  "          layout_type: epoch",
  "          layout: s.us",
  "        severity:",
  "          parse_from: body.level",
  "          preset: otel",
  "          mapping:",
  "            WARN: [warning, W]",
  "            error: 5xx",
  "",
].join("\n");
const DROP_OP = "      - type: drop_output # not one of the 26\n        id: dropped\n";
const SCALAR_OP = "      - noop # not a mapping\n";

/** filelog with a second JSON parser (no sections set), fifth in the list. */
const TWO_PARSERS = CORPUS.replace(MOVE_OP, `${MOVE_OP}      - type: json_parser\n`);

/** syslog's retry block ends where its operators go. */
const SYSLOG_END = "      max_elapsed_time: 10m\n";
const withSyslog = (lines: string) => CORPUS.replace(SYSLOG_END, `${SYSLOG_END}${lines}`);

// ── The list: add, remove, move by item ──

describe("Add Operator appends the type's seed as one item", () => {
  const escape = (label: string) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Its own time limit.
  it.each(OPERATORS.map((op) => [op.label, op.type] as const))("%s: its seed, at the list's end; nothing else changes", async (label, type) => {
    const user = renderPipeline();
    await user.click(screen.getByRole("button", { name: "Add Operator" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: new RegExp(`^${escape(label)} `) }));

    const at = CORPUS.indexOf("  journald:");
    expect(text().startsWith(CORPUS.slice(0, at))).toBe(true);
    expect(text().slice(at - RETAIN_TAIL.length, at + "      - type: ".length)).toBe(`${RETAIN_TAIL}      - type: `);
    expect(text().endsWith(CORPUS.slice(at))).toBe(true);
    const operators = operatorsOf(text());
    expect(operators).toHaveLength(7);
    expect(operators[6]).toEqual(operatorSeed(type));
    expect(operators.slice(0, 6)).toEqual(operatorsOf(CORPUS));
    expect(entries()).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The new card is there, expanded, with the catalog's name as its ID placeholder.
    expect(byId("op-6-id")).toHaveAttribute("placeholder", type);
  }, 20_000);

  it.each([
    ["a missing key", CORPUS],
    ["operators: []", withSyslog("    operators: []\n")],
    ["a null operators:", withSyslog("    operators:\n")],
  ])("into %s, in block style", async (_name, base) => {
    const user = renderPipeline(SYSLOG, base);
    expect(screen.getByText("No operators configured")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Operator" }));
    await user.click(screen.getByRole("button", { name: /^No-Op / }));
    expect(text()).toBe(CORPUS.replace(SYSLOG_END, `${SYSLOG_END}    operators:\n      - type: noop\n`));
    expect(entries()).toBe(1);
  });

  // Its own time limit.
  it("the seeds are written as the collector takes them", async () => {
    const user = renderPipeline(SYSLOG);
    for (const label of ["Router", "Regex Replace", "Flatten", "Recombine", "JSON Array Parser"]) {
      await user.click(screen.getByRole("button", { name: "Add Operator" }));
      await user.click(screen.getByRole("button", { name: new RegExp(`^${label} `) }));
    }
    expect(text()).toBe(
      CORPUS.replace(
        SYSLOG_END,
        [
          SYSLOG_END + "    operators:",
          "      - type: router",
          "        routes:",
          '          - expr: "true"',
          "      - type: regex_replace",
          "        field: body",
          "        regex_name: ansi_control_sequences",
          '        replace_with: ""',
          "      - type: flatten",
          "        field: body.nested",
          "      - type: recombine",
          "        is_first_entry: body matches '^\\\\d{4}-\\\\d{2}-\\\\d{2}'",
          "        combine_field: body",
          "      - type: json_array_parser",
          "        parse_from: body",
          "        parse_to: body",
          "",
        ].join("\n"),
      ),
    );
  }, 20_000);
});

describe("removing an operator removes its lines", () => {
  it("the router's lines go; the others, their comments and their keys stay", async () => {
    const user = renderPipeline();
    await user.click(screen.getAllByRole("button", { name: "Remove operator" })[1]!);
    expect(text()).toBe(CORPUS.replace(ROUTER_OP, ""));
    expect(entries()).toBe(1);
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("the comment above a removed item stays", async () => {
    const user = renderPipeline();
    await user.click(screen.getAllByRole("button", { name: "Remove operator" })[0]!);
    expect(text()).toBe(CORPUS.replace(PARSE_OP, "      # parse the JSON body\n"));
  });

  it("removing the last operator removes operators", async () => {
    const user = renderPipeline(SYSLOG, withSyslog("    operators:\n      - type: noop\n"));
    await user.click(screen.getByRole("button", { name: "Remove operator" }));
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(1);
    expect(screen.getByText("No operators configured")).toBeInTheDocument();
  });

  it("what a card's field holds is written before its item goes, never after", async () => {
    const user = renderPipeline(SYSLOG, withSyslog("    operators:\n      - type: noop\n"));
    await user.type(byId("op-0-id"), "held");
    await user.click(screen.getByRole("button", { name: "Remove operator" }));
    expect(text()).toBe(CORPUS);
    expect(valueOf(text(), SYSLOG).operators).toBeUndefined();
  });

  it("the other cards keep their state", async () => {
    const user = renderPipeline();
    await user.click(screen.getAllByRole("button", { name: "Collapse operator" })[2]!);
    await user.click(screen.getAllByRole("button", { name: "Remove operator" })[0]!);
    // The add card, now second, is still collapsed; the others are expanded.
    expect(byId("op-1-id")).toBeNull();
    expect(byId("op-0-id")).toHaveAttribute("placeholder", "router");
    expect(byId("op-2-id")).toHaveAttribute("placeholder", "move");
  });
});

describe("moving an operator moves its lines, comments and keys no field shows", () => {
  beforeEach(layOutRows);

  const SWAPPED = CORPUS.replace(PARSE_OP + ROUTER_OP, ROUTER_OP + PARSE_OP);

  it.each([
    ["keyboard", (handle: HTMLElement) => dragByKeyboard(handle, 1)],
    ["pointer", (handle: HTMLElement) => dragByPointer(handle, 1)],
  ] as const)("by %s: the JSON parser, dragged down, takes its comment; the router keeps its output", async (_how, drag) => {
    renderPipeline();
    await drag(handles()[0]!);
    expect(text()).toBe(SWAPPED);
    expect(entries()).toBe(1);
    expect(operatorsOf(text())[0]).toMatchObject({ type: "router", routes: [{ output: "errors" }], default: "move" });
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("keys no field shows (the parser's body, its output) stay through an edit and a move", async () => {
    const kept = "        body: attributes.msg # the parser's own body\n        output: errors\n";
    const user = renderPipeline(FILELOG, CORPUS.replace("        id: parse\n", `        id: parse\n${kept}`));
    await retypeInto(user, byId("op-0-id"), "json");
    await dragByKeyboard(handles()[0]!, 1);
    expect(text()).toBe(CORPUS.replace(PARSE_OP + ROUTER_OP, ROUTER_OP + PARSE_OP.replace("        id: parse\n", `        id: json\n${kept}`)));
    expect(operatorsOf(text())[1]).toMatchObject({ id: "json", body: "attributes.msg", output: "errors" });
  });

  it("a flow item moves as written", async () => {
    renderPipeline();
    await dragByKeyboard(handles()[3]!, -1);
    expect(text()).toBe(CORPUS.replace(ADD_OP + MOVE_OP, MOVE_OP + ADD_OP));
  });

  it.each([
    ["keyboard", (handle: HTMLElement) => dragByKeyboard(handle, 1)],
    ["pointer", (handle: HTMLElement) => dragByPointer(handle, 1)],
  ] as const)("by %s: a collapsed card stays collapsed where it goes, and after the move's undo and redo", async (_how, drag) => {
    const user = renderPipeline();
    await user.click(screen.getAllByRole("button", { name: "Collapse operator" })[0]!);
    expect(byId("op-0-id")).toBeNull();

    await drag(handles()[0]!);
    expect(text()).toBe(SWAPPED);
    // The JSON parser, now second, is collapsed; the router, now first, expanded.
    expect(byId("op-1-id")).toBeNull();
    expect(byId("op-0-id")).toHaveAttribute("placeholder", "router");

    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
    expect(byId("op-0-id")).toBeNull();
    expect(byId("op-1-id")).toHaveAttribute("placeholder", "router");

    act(() => void builderStore().redo());
    expect(byId("op-1-id")).toBeNull();
    expect(byId("op-0-id")).toHaveAttribute("placeholder", "router");
  });

  it("a card's own state follows it: the timestamp's Custom... toggle", async () => {
    const user = renderPipeline();
    await pickIn(user, byId("op-0-ts-layout-preset"), "Custom...");
    expect(byId("op-0-ts-layout-custom")).toHaveValue("%Y-%m-%d %H:%M:%S");
    await dragByKeyboard(handles()[0]!, 1);
    expect(byId("op-0-ts-layout-custom")).toBeNull();
    expect(byId("op-1-ts-layout-custom")).toHaveValue("%Y-%m-%d %H:%M:%S");
  });

  it("after the YAML box reorders the operators, the collapsed card is still the JSON parser's", async () => {
    const user = renderPipeline();
    await user.click(screen.getAllByRole("button", { name: "Collapse operator" })[0]!);
    act(() => builderStore().setText(SWAPPED));
    act(() => void builderStore().apply());
    expect(text()).toBe(SWAPPED);
    expect(byId("op-1-id")).toBeNull();
    expect(byId("op-0-id")).toHaveAttribute("placeholder", "router");
  });

  it("the drag overlay draws the dragged card's header only: no field id twice", async () => {
    renderPipeline();
    const handle = handles()[0]!;
    act(() => handle.focus());
    await press(handle, " ", "Space");
    await press(handle, "ArrowDown");
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(ids.filter((id) => id.startsWith("op-")).length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // The overlay's header: the card's number and type, and no controls.
    expect(screen.getAllByText("JSON Parser")).toHaveLength(2);
    await press(handle, "Escape");
    expect(text()).toBe(CORPUS);
  });
});

// ── The cards ──

describe("each card's common fields write the operator's own keys", () => {
  it("Operator ID writes id in place; its placeholder is the type; cleared, the key goes", async () => {
    const user = renderPipeline();
    expect(byId("op-0-id")).toHaveValue("parse");
    expect(byId("op-0-id")).toHaveAttribute("placeholder", "json_parser");
    await retypeInto(user, byId("op-0-id"), "json");
    expect(text()).toBe(CORPUS.replace("        id: parse\n", "        id: json\n"));
    expect(screen.getByText("id: json")).toBeInTheDocument();
    await retypeInto(user, byId("op-0-id"), "");
    expect(text()).toBe(CORPUS.replace("        id: parse\n", ""));
  });

  it("On Error offers the collector's four; unset shows Default send; a pick writes on_error", async () => {
    const user = renderPipeline();
    expect(byId("op-0-on-error")).toHaveTextContent("Send (continue)");
    expect(hintIn(cardOf("op-0-id"), "Error handling behavior. · Default send")).toBeInTheDocument();
    await user.click(byId("op-0-on-error"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Send (continue)",
      "Send quietly (continue, debug log)",
      "Drop entry",
      "Drop quietly (debug log)",
    ]);
    await user.click(screen.getByRole("option", { name: "Send quietly (continue, debug log)" }));
    expect(text()).toBe(
      CORPUS.replace("          parse_from: attributes.level\n      - type: router", "          parse_from: attributes.level\n        on_error: send_quiet\n      - type: router"),
    );
    expect(operatorsOf(text())[0]!.on_error).toBe("send_quiet");
  });

  it("On Error shows silent as written, an extra option", async () => {
    const user = renderPipeline(FILELOG, CORPUS.replace("        id: errors\n", "        id: errors\n        on_error: silent\n"));
    expect(byId("op-2-on-error")).toHaveTextContent("silent");
    await user.click(byId("op-2-on-error"));
    expect(screen.getAllByRole("option")).toHaveLength(5);
  });

  it("Condition writes if", async () => {
    const user = renderPipeline();
    await retypeInto(user, byId("op-2-if"), 'body != "x"');
    const operators = operatorsOf(text());
    expect(operators[2]!.if).toBe('body != "x"');
    expect(text().replace(/^ {8}if: .*\n/m, "")).toBe(CORPUS);
  });

  it("a router shows neither On Error nor Condition", () => {
    renderPipeline();
    expect(byId("op-1-id")).toHaveAttribute("placeholder", "router");
    expect(byId("op-1-on-error")).toBeNull();
    expect(byId("op-1-if")).toBeNull();
    expect(byId("op-2-on-error")).not.toBeNull();
  });

  it("each edit is one undo entry named after the component", async () => {
    const user = renderPipeline();
    await retypeInto(user, byId("op-0-id"), "json");
    expect(entries()).toBe(1);
    expect(selectUndoDescription(builderStore())).toMatch(/^Update /);
  });
});

describe("items the catalog doesn't know", () => {
  it("a type outside the 26: its common fields, Unknown operator type, the ID placeholder Operator ID", () => {
    renderPipeline(JOURNALD);
    expect(byId("op-2-id")).toHaveValue("dropped");
    expect(byId("op-2-id")).toHaveAttribute("placeholder", "Operator ID");
    expect(byId("op-2-on-error")).not.toBeNull();
    expect(within(cardOf("op-2-id")).getByText("Unknown operator type")).toBeInTheDocument();
    expect(within(cardOf("op-2-id")).getByText("drop_output")).toBeInTheDocument();
  });

  it("an item that isn't a mapping: its number and Unknown operator type, no fields; removable", async () => {
    const user = renderPipeline(JOURNALD);
    expect(screen.getAllByText("Unknown operator type")).toHaveLength(2);
    expect(screen.getByText("4.")).toBeInTheDocument();
    expect(byId("op-3-id")).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Remove operator" })[3]!);
    expect(text()).toBe(CORPUS.replace(SCALAR_OP, ""));
  });

  it("both can be moved, and a card moves past them with its comment", async () => {
    layOutRows();
    renderPipeline(JOURNALD);
    await dragByKeyboard(handles()[3]!, -1);
    expect(text()).toBe(CORPUS.replace(DROP_OP + SCALAR_OP, SCALAR_OP + DROP_OP));
    act(() => void builderStore().undo());
    await dragByPointer(handles()[1]!, 1);
    expect(text()).toBe(CORPUS.replace(JOURNALD_JSON + DROP_OP, DROP_OP + JOURNALD_JSON));
  });

  it("operators that isn't a list is read-only with the hint; Add Operator is disabled", () => {
    renderPipeline(SYSLOG, withSyslog("    operators: parse\n"));
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Operator" })).toBeDisabled();
    expect(screen.queryByText(/operators?$/)).toBeNull();
  });
});

describe("the pipeline's chrome", () => {
  it.each([
    [FILELOG, "from file"],
    [JOURNALD, "from journal"],
    [SYSLOG, "from syslog"],
  ])("%s's input row says %s", (key, from) => {
    renderPipeline(key);
    expect(screen.getByText("Log Entry Input")).toBeInTheDocument();
    expect(screen.getByText(from)).toBeInTheDocument();
    expect(screen.getByText("Log Entry Output")).toBeInTheDocument();
  });

  it("no arrow is drawn after a router: the router's row has none; the others' do", () => {
    renderPipeline();
    expect(screen.getByText("6 operators")).toBeInTheDocument();
    const rows = [...document.querySelectorAll('[aria-roledescription="sortable"]')].map((handle) => rowOf(handle)!);
    expect(rows.map((row) => row.querySelectorAll(".lucide-arrow-down").length)).toEqual([1, 0, 1, 1, 1, 0]);
    // After the input row, the list, and Add Operator; 4 between cards: 7.
    expect(document.querySelectorAll(".lucide-arrow-down")).toHaveLength(7);
  });

  it("with a router last, none after the list or Add Operator", () => {
    renderPipeline(SYSLOG, withSyslog("    operators:\n      - type: router\n"));
    expect(screen.getByText("1 operator")).toBeInTheDocument();
    expect(document.querySelectorAll(".lucide-arrow-down")).toHaveLength(1);
  });
});

// ── Ids per card ──

describe("every id is the card's own", () => {
  it("the JSON parser's cards hold its real form", () => {
    expect(OPERATOR_FORMS.json_parser).toBe(JsonParserForm);
  });

  it("two JSON parsers: no id is drawn twice", () => {
    renderPipeline(FILELOG, TWO_PARSERS);
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(ids.filter((id) => id.startsWith("op-4-")).length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("two JSON parsers: a label toggles its own card's box", async () => {
    const user = renderPipeline(FILELOG, TWO_PARSERS);
    const severityLabels = screen.getAllByText("Parse Severity");
    expect(severityLabels).toHaveLength(2);
    await user.click(severityLabels[1]!);

    const operators = operatorsOf(text());
    expect(operators[4]).toEqual({ type: "json_parser", severity: { parse_from: "attributes.level", preset: "default" } });
    expect(operators[0]!.severity).toEqual({ parse_from: "attributes.level" });
    expect(byId("op-4-severity-enable")).toBeChecked();
    expect(byId("op-0-severity-enable")).toBeChecked();

    await user.click(screen.getAllByText("Parse Timestamp")[1]!);
    expect(operatorsOf(text())[4]!.timestamp).toEqual({ parse_from: "attributes.timestamp", layout: "%Y-%m-%d %H:%M:%S", layout_type: "strptime" });
    expect(operatorsOf(text())[0]!.timestamp).toEqual(operatorsOf(CORPUS)[0]!.timestamp);

    // The JSON parser's own box (its form's): its label ticks its own card's.
    await user.click(screen.getAllByText("Parse integers as int64 (instead of float64)")[1]!);
    expect(operatorsOf(text())[4]!.parse_ints).toBe(true);
    expect(operatorsOf(text())[0]!.parse_ints).toBeUndefined();
    expect(byId("op-4-json-parse-ints")).toBeChecked();
    expect(byId("op-0-json-parse-ints")).not.toBeChecked();
  });
});

// ── FieldSelector ──

describe("FieldSelector's fixes", () => {
  it("a body suffix is shown and editable", async () => {
    const base = CORPUS.replace("        parse_from: body\n        timestamp:", "        parse_from: body.message\n        timestamp:");
    const user = renderPipeline(FILELOG, base);
    expect(byId("op-0-json-parse-from")).toHaveTextContent("body");
    expect(byId("op-0-json-parse-from-suffix")).toHaveValue("message");
    await retypeInto(user, byId("op-0-json-parse-from-suffix"), "log");
    expect(text()).toBe(CORPUS.replace("        parse_from: body\n        timestamp:", "        parse_from: body.log\n        timestamp:"));
    // An empty body suffix writes the bare body, a field everywhere (entry/field.go:128-129).
    await retypeInto(user, byId("op-0-json-parse-from-suffix"), "");
    expect(text()).toBe(CORPUS);
  });

  it("switching to custom... keeps the path as written (not the suffix alone)", async () => {
    const user = renderPipeline();
    await pickIn(user, byId("op-0-sev-parse-from"), "custom...");
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
    expect(byId("op-0-sev-parse-from-custom")).toHaveValue("attributes.level");
    await user.type(byId("op-0-sev-parse-from-custom"), "2");
    await user.tab();
    expect(operatorsOf(text())[0]!.severity).toEqual({ parse_from: "attributes.level2" });
    // It stays custom... while its path is a prefix and suffix; picking a prefix shows them again.
    expect(byId("op-0-sev-parse-from")).toHaveTextContent("custom...");
    await pickIn(user, byId("op-0-sev-parse-from"), "resource");
    expect(operatorsOf(text())[0]!.severity).toEqual({ parse_from: "resource.level2" });
    expect(byId("op-0-sev-parse-from-suffix")).toHaveValue("level2");
  });

  it("an empty suffix removes the key where a bare root isn't a field; the prefix stays picked (entry/field.go:119-126)", async () => {
    const user = renderPipeline();
    await retypeInto(user, byId("op-0-ts-parse-from-suffix"), "");
    expect(text()).toBe(CORPUS.replace("          parse_from: attributes.time\n", ""));
    expect(byId("op-0-ts-parse-from")).toHaveTextContent("attributes");
    await user.type(byId("op-0-ts-parse-from-suffix"), "ts");
    await user.tab();
    expect(operatorsOf(text())[0]!.timestamp).toMatchObject({ parse_from: "attributes.ts" });
  });

  it("a rootable field writes the bare root (parse_to, helper/parser.go:35)", async () => {
    const user = renderPipeline();
    // Unset: the default's prefix as the placeholder, the custom input with the default.
    expect(byId("op-0-json-parse-to")).toHaveTextContent("attributes");
    expect(byId("op-0-json-parse-to-custom")).toHaveAttribute("placeholder", "attributes");
    await pickIn(user, byId("op-0-json-parse-to"), "resource");
    expect(text().replace("        parse_to: resource\n", "")).toBe(CORPUS);
    expect(operatorsOf(text())[0]!.parse_to).toBe("resource");
    await user.type(byId("op-0-json-parse-to-suffix"), "parsed");
    await user.tab();
    expect(operatorsOf(text())[0]!.parse_to).toBe("resource.parsed");
    await retypeInto(user, byId("op-0-json-parse-to-suffix"), "");
    expect(operatorsOf(text())[0]!.parse_to).toBe("resource");
  });

  it("a non-rootable field picked with no suffix writes nothing until one is typed", async () => {
    const user = renderPipeline(FILELOG, TWO_PARSERS);
    await pickIn(user, byId("op-4-json-parse-from"), "attributes");
    expect(text()).toBe(TWO_PARSERS);
    expect(byId("op-4-json-parse-from-suffix")).toHaveValue("");
    await user.type(byId("op-4-json-parse-from-suffix"), "msg");
    await user.tab();
    expect(operatorsOf(text())[4]).toEqual({ type: "json_parser", parse_from: "attributes.msg" });
  });

  it("a bracketed suffix reads back as written and is joined without a dot", async () => {
    const user = renderPipeline(JOURNALD);
    expect(byId("op-1-json-parse-from")).toHaveTextContent("body");
    expect(byId("op-1-json-parse-from-suffix")).toHaveValue('["message.json"]');
    await retypeInto(user, byId("op-1-json-parse-from-suffix"), literal('["log.file.path"]'));
    expect(text()).toBe(CORPUS.replace('parse_from: body["message.json"]', 'parse_from: body["log.file.path"]'));
    expect(operatorsOf(text(), JOURNALD)[1]!.parse_from).toBe('body["log.file.path"]');
  });

  it("a path the prefix and suffix wouldn't write back shows as custom..., as written", () => {
    renderPipeline(FILELOG, CORPUS.replace("          parse_from: attributes.time\n", '          parse_from: attributes.["time"]\n'));
    expect(byId("op-0-ts-parse-from")).toHaveTextContent("custom...");
    expect(byId("op-0-ts-parse-from-custom")).toHaveValue('attributes.["time"]');
  });

  it("a suffix with a dot shows the bracket hint", async () => {
    const user = renderPipeline();
    expect(screen.queryByText(BRACKET_HINT)).toBeNull();
    await user.clear(byId("op-0-ts-parse-from-suffix"));
    await user.type(byId("op-0-ts-parse-from-suffix"), "log.time");
    expect(screen.getByText(BRACKET_HINT)).toBeInTheDocument();
  });

  it("a value it can't show is read-only with the hint", () => {
    renderPipeline(FILELOG, CORPUS.replace("          parse_from: attributes.time\n", "          parse_from: [attributes.time]\n"));
    expect(byId("op-0-ts-parse-from")).toBeDisabled();
    expect(within(cardOf("op-0-id")).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });
});

// ── The severity section ──

describe("the severity section", () => {
  it("ticking writes its block; unticking removes it", async () => {
    const user = renderPipeline(FILELOG, TWO_PARSERS);
    await user.click(byId("op-4-severity-enable"));
    expect(text()).toBe(TWO_PARSERS.replace("      - type: json_parser\n      - type: recombine", "      - type: json_parser\n        severity:\n          parse_from: attributes.level\n          preset: default\n      - type: recombine"));
    await user.click(byId("op-0-severity-enable"));
    expect(operatorsOf(text())[0]!.severity).toBeUndefined();
    expect(text()).not.toContain("        severity:\n          parse_from: attributes.level\n      - type: router");
  });

  it("an unset Preset shows the collector's default; otel shows as written", async () => {
    renderPipeline(JOURNALD);
    expect(byId("op-1-sev-preset")).toHaveTextContent("otel");
    cleanup();
    useEditorStore.setState(initialState, true);
    renderPipeline();
    expect(byId("op-0-sev-preset")).toHaveTextContent("Default (common patterns: info, warn, error, etc.)");
    expect(hint("Predefined severity mappings. · Default default")).toBeInTheDocument();
  });

  it("mapping keys are read case-insensitively and written under the text's spelling", async () => {
    const user = renderPipeline(JOURNALD);
    expect(byId("op-1-sev-custom-mapping")).toBeChecked();
    expect(byId("op-1-sev-mapping-warn")).toHaveValue("warning, W");
    expect(byId("op-1-sev-mapping-error")).toHaveValue("5xx");
    await retypeInto(user, byId("op-1-sev-mapping-warn"), "WARNING");
    expect(text()).toBe(CORPUS.replace("            WARN: [warning, W]\n", "            WARN: WARNING\n"));
    expect((operatorsOf(text(), JOURNALD)[1]!.severity as Value).mapping).toEqual({ WARN: "WARNING", error: "5xx" });
  });

  it("several values are written as a list; none removes the level, and the last level removes mapping", async () => {
    const user = renderPipeline(JOURNALD);
    await retypeInto(user, byId("op-1-sev-mapping-fatal"), "crit, emerg");
    expect((operatorsOf(text(), JOURNALD)[1]!.severity as Value).mapping).toEqual({ WARN: ["warning", "W"], error: "5xx", fatal: ["crit", "emerg"] });
    await retypeInto(user, byId("op-1-sev-mapping-fatal"), "");
    await retypeInto(user, byId("op-1-sev-mapping-warn"), "");
    expect(text()).toBe(CORPUS.replace("            WARN: [warning, W]\n", ""));
    await retypeInto(user, byId("op-1-sev-mapping-error"), "");
    expect(text()).toBe(CORPUS.replace("          mapping:\n            WARN: [warning, W]\n            error: 5xx\n", ""));
    // The box stays on while its rows are typed in.
    expect(byId("op-1-sev-custom-mapping")).toBeChecked();
  });

  it.each([
    ["an alias key", "            warning: W\n"],
    ["a number", "            error: 5\n"],
    ["a range", "            error: {min: 3, max: 5}\n"],
    ["two spellings of a level", "            warn: w\n"],
  ])("a mapping with %s is read-only with the hint", (_name, line) => {
    renderPipeline(JOURNALD, CORPUS.replace("            error: 5xx\n", `            error: 5xx\n${line}`.replace(/^( {12}error: 5xx\n)( {12}error: .*\n)$/, "$2")));
    expect(byId("op-1-sev-mapping-trace")).toBeDisabled();
    expect(byId("op-1-sev-custom-mapping")).toBeDisabled();
    expect(within(cardOf("op-1-id")).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });

  it("the custom mapping box is on while mapping is there; ticked, it stays on until unticked; unticking removes mapping", async () => {
    const user = renderPipeline();
    expect(byId("op-0-sev-custom-mapping")).not.toBeChecked();
    await user.click(byId("op-0-sev-custom-mapping"));
    expect(text()).toBe(CORPUS);
    // Another change to the operator doesn't collapse it.
    await user.click(byId("op-0-sev-overwrite"));
    expect(byId("op-0-sev-custom-mapping")).toBeChecked();
    await user.type(byId("op-0-sev-mapping-error"), "E");
    await user.tab();
    expect(operatorsOf(text())[0]!.severity).toEqual({ parse_from: "attributes.level", overwrite_text: true, mapping: { error: "E" } });
    await user.click(byId("op-0-sev-custom-mapping"));
    expect(operatorsOf(text())[0]!.severity).toEqual({ parse_from: "attributes.level", overwrite_text: true });
    expect(byId("op-0-sev-mapping-error")).toBeNull();
  });
});

// ── The timestamp section ──

describe("the timestamp section", () => {
  it("ticking writes its block; unticking removes it", async () => {
    const user = renderPipeline(FILELOG, TWO_PARSERS);
    await user.click(byId("op-4-timestamp-enable"));
    expect(text()).toBe(
      TWO_PARSERS.replace(
        "      - type: json_parser\n      - type: recombine",
        "      - type: json_parser\n        timestamp:\n          parse_from: attributes.timestamp\n          layout: \"%Y-%m-%d %H:%M:%S\"\n          layout_type: strptime\n      - type: recombine",
      ),
    );
    await user.click(byId("op-4-timestamp-enable"));
    expect(text()).toBe(TWO_PARSERS);
  });

  it("switching Layout Type sets the new type's first preset, in one change, toasted once, with no inline alert", async () => {
    const user = renderPipeline();
    await pickIn(user, byId("op-0-ts-layout-type"), "Epoch (Unix timestamp)");
    // The layout keeps its quoting.
    expect(text()).toBe(CORPUS.replace("          layout_type: strptime\n          layout: '%Y-%m-%d %H:%M:%S'\n", "          layout_type: epoch\n          layout: 's'\n"));
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual(["Layout set to the first epoch preset."]);
    expect(screen.queryByText("Layout set to the first epoch preset.")).toBeNull();
    expect(byId("op-0-ts-layout-preset")).toHaveTextContent("Unix epoch (seconds)");

    // The switch is one entry: one undo restores the text.
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);

    // Switched again, it toasts again; the operator's next change toasts nothing more (Timezone is hidden under
    // epoch, so Parse From is the change).
    // (The undo toasted its own message between them.)
    const adjusted = () => infoToasts().filter((message) => message === "Layout set to the first epoch preset.");
    await pickIn(user, byId("op-0-ts-layout-type"), "Epoch (Unix timestamp)");
    expect(adjusted()).toHaveLength(2);
    expect(screen.queryByText("Layout set to the first epoch preset.")).toBeNull();
    const toasts = infoToasts().length;
    await retypeInto(user, byId("op-0-ts-parse-from-suffix"), "ts");
    expect(operatorsOf(text())[0]!.timestamp).toMatchObject({ parse_from: "attributes.ts", layout_type: "epoch", layout: "s" });
    expect(infoToasts()).toHaveLength(toasts);
  });

  it("the switch and its layout are one undo entry", async () => {
    const user = renderPipeline();
    await pickIn(user, byId("op-0-ts-layout-type"), "Go time format");
    expect(operatorsOf(text())[0]!.timestamp).toMatchObject({ layout_type: "gotime", layout: "2006-01-02 15:04:05" });
    expect(entries()).toBe(1);
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
  });

  it("a custom layout is kept across a switch, with no toast", async () => {
    const base = CORPUS.replace("          layout: '%Y-%m-%d %H:%M:%S'\n", "          layout: '%d.%m.%Y %H:%M'\n");
    const user = renderPipeline(FILELOG, base);
    expect(byId("op-0-ts-layout-custom")).toHaveValue("%d.%m.%Y %H:%M");
    await pickIn(user, byId("op-0-ts-layout-type"), "Go time format");
    expect(text()).toBe(base.replace("          layout_type: strptime\n", "          layout_type: gotime\n"));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  it("each layout type offers its own presets: strptime's first labeled with what it writes, Go layouts, epoch's s and s.us", async () => {
    const user = renderPipeline();
    expect(byId("op-0-ts-layout-preset")).toHaveTextContent("%Y-%m-%d %H:%M:%S");
    await user.click(byId("op-0-ts-layout-preset"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "%Y-%m-%d %H:%M:%S",
      "ISO 8601 with TZ",
      "ISO 8601 UTC",
      "Common Log Format",
      "Syslog (RFC 3164)",
      "Custom...",
    ]);
    await user.keyboard("{Escape}");
    await pickIn(user, byId("op-0-ts-layout-type"), "Go time format");
    await pickIn(user, byId("op-0-ts-layout-preset"), "Common Log Format");
    expect(operatorsOf(text())[0]!.timestamp).toMatchObject({ layout: "02/Jan/2006:15:04:05 -0700" });
    cleanup();
    useEditorStore.setState(initialState, true);

    const journald = renderPipeline(JOURNALD);
    expect(byId("op-1-ts-layout-preset")).toHaveTextContent("Unix epoch with fractional");
    await journald.click(byId("op-1-ts-layout-preset"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Unix epoch (seconds)", "Unix epoch with fractional", "Custom..."]);
    await journald.click(screen.getByRole("option", { name: "Unix epoch (seconds)" }));
    expect(text()).toBe(CORPUS.replace("          layout: s.us\n", "          layout: s\n"));
  });

  it("Custom... shows the layout's input and writes nothing; its typing writes layout", async () => {
    const user = renderPipeline();
    await pickIn(user, byId("op-0-ts-layout-preset"), "Custom...");
    expect(text()).toBe(CORPUS);
    await retypeInto(user, byId("op-0-ts-layout-custom"), "%H:%M");
    expect(operatorsOf(text())[0]!.timestamp).toMatchObject({ layout: "%H:%M" });
  });

  it("an unset Layout Type shows the collector's strptime (helper/time.go:62-64)", () => {
    renderPipeline(FILELOG, CORPUS.replace("          layout_type: strptime\n", ""));
    expect(byId("op-0-ts-layout-type")).toHaveTextContent("strptime (Python-style)");
    expect(hint("Time format specification type. · Default strptime")).toBeInTheDocument();
    expect(byId("op-0-ts-layout-preset")).toHaveTextContent("%Y-%m-%d %H:%M:%S");
  });

  it("clearing the custom layout removes the key, as time_parser's", async () => {
    const base = CORPUS.replace("          layout: '%Y-%m-%d %H:%M:%S'\n", "          layout: '%d.%m.%Y'\n");
    const user = renderPipeline(FILELOG, base);
    await retypeInto(user, byId("op-0-ts-layout-custom"), "");
    expect(text()).toBe(base.replace("          layout: '%d.%m.%Y'\n", ""));
    expect(operatorsOf(text())[0]!.timestamp).not.toHaveProperty("layout");
    // The input stays for the typing that follows.
    expect(byId("op-0-ts-layout-custom")).toHaveValue("");
    await user.type(byId("op-0-ts-layout-custom"), "%H:%M");
    await user.tab();
    expect(operatorsOf(text())[0]!.timestamp).toMatchObject({ layout: "%H:%M" });
  });

  it("Timezone is hidden under epoch, as time_parser's; a location in the text stays through an edit (time.go:114-117)", async () => {
    const base = CORPUS.replace("          layout: s.us\n", "          layout: s.us\n          location: UTC\n");
    const user = renderPipeline(JOURNALD, base);
    expect(byId("op-1-ts-location")).toBeNull();
    expect(screen.queryByText("Timezone for parsing (if not in timestamp).")).toBeNull();
    await pickIn(user, byId("op-1-ts-layout-preset"), "Unix epoch (seconds)");
    expect(operatorsOf(text(), JOURNALD)[1]!.timestamp).toMatchObject({ layout: "s", location: "UTC" });
    await pickIn(user, byId("op-1-ts-layout-type"), "Go time format");
    expect(byId("op-1-ts-location")).toHaveValue("UTC");
  });
});

// ── The Add Operator dialog ──

describe("the Add Operator dialog", () => {
  it("lists the four categories and 26 types, each with its icon", async () => {
    const user = renderPipeline();
    await user.click(screen.getByRole("button", { name: "Add Operator" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Format Parsers",
      "Field Parsers",
      "Transform",
      "Flow Control",
    ]);
    const types = within(dialog)
      .getAllByRole("button")
      .filter((button) => button.textContent !== "Close");
    expect(types).toHaveLength(26);
    for (const button of types) expect(button.querySelector("svg.lucide")).not.toBeNull();
    // Each of the six has its own icon, not FileText.
    expect(within(dialog).getByRole("button", { name: /^Container Parser / }).querySelector(".lucide-container")).not.toBeNull();
    expect(dialog).toHaveAttribute("data-own-keys", "");
  });

  it("Delete, Backspace and Cmd/Ctrl+D inside it don't delete or duplicate the selected node", async () => {
    function Shortcuts() {
      useUndoRedo();
      return null;
    }
    const user = renderPipeline(FILELOG, CORPUS, <Shortcuts />);
    const filelog = componentNamed(FILELOG);
    act(() => builderStore().selectNode(filelog.id));
    const nodes = builderStore().graph.nodes.length;
    await user.click(screen.getByRole("button", { name: "Add Operator" }));
    const target = screen.getByRole("button", { name: /^JSON Parser / });
    target.focus();
    for (const init of [{ key: "Delete" }, { key: "Backspace" }, { key: "d", ctrlKey: true }, { key: "d", metaKey: true }]) {
      fireEvent.keyDown(target, init);
    }
    expect(builderStore().pendingDelete).toBeNull();
    expect(builderStore().graph.nodes).toHaveLength(nodes);
    expect(builderStore().selectedNode?.id).toBe(filelog.id);
    expect(text()).toBe(CORPUS);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// ── Opening writes nothing ──

describe("opening and expanding every card writes nothing", () => {
  /** What each pipeline's cards show once expanded, at least: their text fields, every control, and a field each text shows. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [FILELOG]: { textboxes: 33, all: 56, field: "op-0-json-parse-from" },
    [JOURNALD]: { textboxes: 20, all: 39, field: "op-0-regex-pattern" },
  };
  // Each with its own time limit.
  it.each([
    [FILELOG, "LF"],
    [FILELOG, "CRLF"],
    [JOURNALD, "LF"],
    [JOURNALD, "CRLF"],
  ])(
    "%s, %s: collapsed, expanded, every field focused and left",
    async (key, ending) => {
      const base = ending === "CRLF" ? CRLF(CORPUS) : CORPUS;
      const user = renderPipeline(key, base);
      const collapse = screen.queryAllByRole("button", { name: "Collapse operator" });
      expect(collapse.length).toBeGreaterThan(0);
      for (const button of collapse) await user.click(button);
      expect(screen.queryAllByRole("textbox")).toHaveLength(0);
      for (const button of screen.queryAllByRole("button", { name: "Expand operator" })) await user.click(button);
      // Expanded, the cards show their fields.
      const { textboxes, all } = formControls();
      expect(screen.queryAllByRole("button", { name: "Expand operator" })).toHaveLength(0);
      expect(textboxes.length).toBeGreaterThanOrEqual(OPENED[key]!.textboxes);
      expect(all).toBeGreaterThanOrEqual(OPENED[key]!.all);
      expect(document.getElementById(OPENED[key]!.field)).not.toBeNull();
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

// ── Privacy ──

describe("privacy", () => {
  beforeEach(layOutRows);

  // Its own time limit.
  it("puts no config value in any attribute: every card expanded, the menus open, a drag in progress, the dialog open", async () => {
    const MARK = "zq-mark";
    const base = [
      "receivers:",
      "  filelog:",
      `    include: [/var/log/${MARK}.log]`,
      "    operators:",
      "      - type: json_parser",
      `        id: ${MARK}-id`,
      `        output: ${MARK}-output`,
      `        parse_from: attributes.${MARK}-from`,
      `        parse_to: ${MARK}-to`,
      `        on_error: ${MARK}-on-error`,
      `        if: ${MARK}-if`,
      "        timestamp:",
      `          parse_from: body["${MARK}.ts"]`,
      `          layout_type: ${MARK}-layout-type`,
      `          layout: ${MARK}-layout`,
      `          location: ${MARK}-location`,
      "        severity:",
      `          parse_from: resource.${MARK}-sev`,
      `          preset: ${MARK}-preset`,
      "          mapping:",
      `            warn: [${MARK}-warn, ${MARK}-w]`,
      `      - type: ${MARK}-type`,
      `        id: ${MARK}-id2`,
      `        ${MARK}-key: ${MARK}-value`,
      `      - ${MARK}-scalar`,
      "      - type: router",
      `        id: ${MARK}-router`,
      "        routes:",
      `          - expr: ${MARK}-expr`,
      `            output: ${MARK}-route`,
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    logs:",
      "      receivers: [filelog]",
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
      }
    };
    const shown = () =>
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    const user = renderPipeline(FILELOG, base);
    // A type outside the 26, a scalar item, a router: every card expanded; the values shown.
    for (const marker of ["-id", "-from", "-to", "-on-error", "-if", ".ts", "-layout-type", "-layout", "-location", "-sev", "-preset", "-warn", "-type", "-id2", "-router"]) {
      expect(shown()).toContain(`${MARK}${marker}`);
    }
    scan("cards");

    for (const menu of ["op-0-on-error", "op-0-ts-layout-type", "op-0-sev-preset", "op-0-json-parse-from", "op-0-ts-layout-preset"]) {
      await user.click(byId(menu));
      scan(`${menu} menu`);
      await user.keyboard("{Escape}");
    }

    // A drag in progress: the live region and the overlay name ids only.
    const handle = handles()[1]!;
    act(() => handle.focus());
    await press(handle, " ", "Space");
    await press(handle, "ArrowDown");
    scan("dragging");
    await press(handle, "Escape");

    await user.click(screen.getByRole("button", { name: "Add Operator" }));
    scan("dialog");
    await user.keyboard("{Escape}");

    expect(text()).toBe(base);
    expect(entries()).toBe(0);
    expect(leaks).toEqual([]);
  }, 20_000);
});

// ── Cards keyed by item, and more of FieldSelector ──

/** Waits past the fields' 300 ms pause, so what was typed is written. */
const pause = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 350))));

describe("cards keep their items when two read alike", () => {
  // Its own time limit.
  it("two JSON parsers added from the dialog: slow typing in the first card's Parse From suffix stays in the first", async () => {
    const user = renderPipeline(SYSLOG);
    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole("button", { name: "Add Operator" }));
      await user.click(screen.getByRole("button", { name: /^JSON Parser / }));
    }
    const suffix = byId("op-0-json-parse-from-suffix");
    await user.click(suffix);
    for (const key of ["m", "s", "g"]) {
      await user.keyboard(key);
      await pause();
    }
    expect((valueOf(text(), SYSLOG).operators as Value[]).map((op) => op.parse_from)).toEqual(["body.msg", "body"]);
    expect(document.activeElement).toBe(suffix);
    expect(byId("op-0-json-parse-from-suffix")).toBe(suffix);
  }, 20_000);

  it("clearing the first card's ID, making it read as the second, keeps each card's state", async () => {
    const base = withSyslog("    operators:\n      - type: noop\n        id: a\n      - type: noop\n");
    const user = renderPipeline(SYSLOG, base);
    await user.click(screen.getAllByRole("button", { name: "Collapse operator" })[1]!);
    await retypeInto(user, byId("op-0-id"), "");
    expect(text()).toBe(withSyslog("    operators:\n      - type: noop\n      - type: noop\n"));
    // The first card is still expanded, the second still collapsed.
    expect(byId("op-0-id")).not.toBeNull();
    expect(byId("op-1-id")).toBeNull();
  });
});

describe("a list with a commented-out item after its last", () => {
  beforeEach(layOutRows);

  const NOOP = "      - type: noop\n";
  const ADD = "      - type: add\n        field: body\n";
  const COMMENTED = "      # - type: regex_parser\n";
  const base = withSyslog(`    operators:\n${NOOP}${ADD}${COMMENTED}`);

  it("Add appends before the comment; remove and move leave it where it is", async () => {
    const user = renderPipeline(SYSLOG, base);
    await user.click(screen.getByRole("button", { name: "Add Operator" }));
    await user.click(screen.getByRole("button", { name: /^No-Op / }));
    expect(text()).toBe(withSyslog(`    operators:\n${NOOP}${ADD}${NOOP}${COMMENTED}`));
    act(() => void builderStore().undo());

    await user.click(screen.getAllByRole("button", { name: "Remove operator" })[1]!);
    expect(text()).toBe(withSyslog(`    operators:\n${NOOP}${COMMENTED}`));
    act(() => void builderStore().undo());
    expect(text()).toBe(base);

    await dragByKeyboard(handles()[1]!, -1);
    expect(text()).toBe(withSyslog(`    operators:\n${ADD}${NOOP}${COMMENTED}`));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("FieldSelector: prefixes, the bracket hint and Custom...", () => {
  const BRACKETED = CORPUS.replace("          parse_from: attributes.time\n", '          parse_from: attributes.["time"]\n');

  it("picking a prefix for a custom path that starts with one replaces it, never doubling it", async () => {
    const user = renderPipeline(FILELOG, BRACKETED);
    expect(byId("op-0-ts-parse-from")).toHaveTextContent("custom...");
    await pickIn(user, byId("op-0-ts-parse-from"), "resource");
    expect(text()).toBe(CORPUS.replace("          parse_from: attributes.time\n", '          parse_from: resource["time"]\n'));
    expect(byId("op-0-ts-parse-from-suffix")).toHaveValue('["time"]');
    // A custom path with no prefix is the suffix.
    await pickIn(user, byId("op-0-ts-parse-from"), "custom...");
    await retypeInto(user, byId("op-0-ts-parse-from-custom"), "time");
    await pickIn(user, byId("op-0-ts-parse-from"), "attributes");
    expect(text()).toBe(CORPUS);
  });

  it("the bracket hint counts only dots outside the brackets", async () => {
    const user = renderPipeline(JOURNALD);
    // body["message.json"]: the dot is inside the key.
    expect(byId("op-1-json-parse-from-suffix")).toHaveValue('["message.json"]');
    expect(screen.queryByText(BRACKET_HINT)).toBeNull();
    await user.type(byId("op-1-json-parse-from-suffix"), ".inner");
    expect(screen.getByText(BRACKET_HINT)).toBeInTheDocument();
  });

  it("a prefix picked for a key that is then set and removed from elsewhere doesn't come back", async () => {
    const user = renderPipeline(FILELOG, TWO_PARSERS);
    await pickIn(user, byId("op-4-json-parse-from"), "attributes");
    expect(byId("op-4-json-parse-from-suffix")).toHaveValue("");
    const set = TWO_PARSERS.replace("      - type: json_parser\n      - type: recombine", "      - type: json_parser\n        parse_from: body.x\n      - type: recombine");
    act(() => builderStore().setText(set));
    act(() => void builderStore().apply());
    expect(byId("op-4-json-parse-from")).toHaveTextContent("body");
    act(() => void builderStore().undo());
    expect(text()).toBe(TWO_PARSERS);
    // Unset again: the select empty, the custom input shown (not the stale attributes pick).
    expect(byId("op-4-json-parse-from-suffix")).toBeNull();
    expect(byId("op-4-json-parse-from-custom")).toHaveValue("");
  });

  it("custom... picked holds while its own typing is written", async () => {
    const user = renderPipeline();
    await pickIn(user, byId("op-0-sev-parse-from"), "custom...");
    await retypeInto(user, byId("op-0-sev-parse-from-custom"), "attributes.lvl");
    expect(operatorsOf(text())[0]!.severity).toEqual({ parse_from: "attributes.lvl" });
    expect(byId("op-0-sev-parse-from")).toHaveTextContent("custom...");
  });
});

describe("cards matched in order after a move's undo", () => {
  beforeEach(layOutRows);

  it("[noop, noop, add]: the add card moved to the top and undone, each card has its state back", async () => {
    const ops = "    operators:\n      - type: noop\n      - type: noop\n      - type: add\n        field: body\n";
    const user = renderPipeline(SYSLOG, withSyslog(ops));
    await user.click(screen.getAllByRole("button", { name: "Collapse operator" })[0]!);
    await dragByKeyboard(handles()[2]!, -2);
    expect(text()).toBe(withSyslog("    operators:\n      - type: add\n        field: body\n      - type: noop\n      - type: noop\n"));
    // The collapsed first noop is second now.
    expect(byId("op-1-id")).toBeNull();

    act(() => void builderStore().undo());
    expect(text()).toBe(withSyslog(ops));
    expect(byId("op-0-id")).toBeNull();
    expect(byId("op-1-id")).toHaveAttribute("placeholder", "noop");
    expect(byId("op-2-id")).toHaveAttribute("placeholder", "add");
  });
});
