import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, NumberField, TextField, UNSHOWABLE_VALUE_MESSAGE, useComponentForm, useForm } from "../form-context.js";
import { useCardKeys } from "./card-keys.js";
import { DimensionListField } from "./DimensionListField.js";
import { ItemScope, useHeldItem, type HeldItem } from "./held-item.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import { componentValueText, type ValueChange } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * Held cards and DimensionListField (D9d Task 2; decision 12; Preflight
 * ruling 22): a card that isn't in the text until its first field is
 * typed, then `seed ∪ typed` appended or inserted as one change, the card
 * becoming the item's in place; never an empty item.
 */

const TEXT = `processors:
  metricstransform:
    transforms:
      - include: first # the first
        action: update
      - include: second
        action: update
    other: keep
  metricstransform/empty: {}
connectors:
  spanmetrics:
    dimensions:
      - name: http.method # the method
        default: GET
      - name: http.status_code
      - glob: "http.*"
      - plain
exporters:
  debug: {}
receivers:
  otlp:
    protocols:
      grpc: {}
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [metricstransform, metricstransform/empty]
      exporters: [debug]
    traces:
      receivers: [otlp]
      exporters: [spanmetrics]
    metrics/out:
      receivers: [spanmetrics]
      exporters: [debug]
`;

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function spyWrites(): ValueChange[][] {
  const original = builderStore().setComponentValues;
  const calls: ValueChange[][] = [];
  useEditorStore.setState({
    setComponentValues: (nodeId, changes) => {
      calls.push([...changes]);
      return original(nodeId, changes);
    },
  });
  return calls;
}

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderIn(key: string, children: ReactNode, text = TEXT) {
  openText(text);
  return render(<ComponentForm nodeId={componentNamed(key).id}>{children}</ComponentForm>);
}

const text = () => builderStore().text;
const transforms = (key = "metricstransform") =>
  (parseYaml(text()) as { processors: Record<string, { transforms?: unknown[] }> }).processors[key]!.transforms;
const pause = () => act(() => vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS));

/** metricstransform's seed (Preflight ruling 8): `include` placed first, written once typed. */
const SEED = { include: undefined, match_type: "strict", action: "update" };

let latest: HeldItem | null = null;

/** A list of transform cards with a held card, as a form lays one out. */
function Transforms() {
  const form = useForm();
  const view = form.read(["transforms"]);
  const items = view.kind === "list" ? view.value : [];
  const cards = useCardKeys(items);
  const held = useHeldItem(["transforms"], { cards });
  latest = held;
  // Labelled and identified by position, as a form's cards are: the held card's is where it shows.
  const position = (index: number) => (held.held && index >= held.at ? index + 1 : index);
  const rows = cards.keys.map((key, index) => <Card key={key} index={index} position={position(index)} />);
  if (held.held) rows.splice(held.at, 0, <Card key={cards.next} index={held.at} position={held.at} held={held} />);
  return (
    <>
      {rows}
      <button type="button" onClick={() => held.hold()}>
        Add Transform
      </button>
      <button type="button" onClick={() => held.hold(0)}>
        Add First
      </button>
      <button type="button" onClick={held.drop}>
        Drop
      </button>
    </>
  );
}

function Card({ index, position, held }: { index: number; position: number; held?: HeldItem }) {
  return (
    <div data-testid="card">
      <ItemScope listPath={["transforms"]} index={index} held={held} seed={SEED}>
        <TextField path={["include"]} id={`transform-${position}-include`} label={`Include ${position}`} />
        <NumberField path={["count"]} id={`transform-${position}-count`} label={`Count ${position}`} />
      </ItemScope>
    </div>
  );
}

const include = (index: number) => screen.getByRole("textbox", { name: `Include ${index}` }) as HTMLInputElement;
const count = (index: number) => screen.getByRole("textbox", { name: `Count ${index}` }) as HTMLInputElement;

describe("held cards (decision 12; Preflight ruling 22)", () => {
  it("Add holds a card that isn't in the text; its first typing appends seed ∪ typed as one change, the card becoming the item's", () => {
    const calls = spyWrites();
    renderIn("processors.metricstransform", <Transforms />);
    fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));
    expect(screen.getAllByTestId("card")).toHaveLength(3);
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);

    const held = include(2);
    act(() => held.focus());
    fireEvent.change(held, { target: { value: "third" } });
    pause();
    expect(calls).toEqual([[{ path: ["transforms", 2], value: { include: "third", match_type: "strict", action: "update" } }]]);
    expect(text()).toContain("        action: update\n      - include: third\n        match_type: strict\n        action: update\n    other: keep");
    expect(builderStore().history.past).toHaveLength(1);
    // The same input, still focused.
    expect(include(2)).toBe(held);
    expect(document.activeElement).toBe(held);
    expect(latest?.held).toBe(false);

    // Typing on writes the item's key, not another item.
    fireEvent.change(held, { target: { value: "thirds" } });
    pause();
    expect(calls[1]).toEqual([{ path: ["transforms", 2, "include"], value: "thirds" }]);
  });

  it("a card held at an index is inserted there in one write (set at the length, moved); focus, caret and the other cards' elements stay", () => {
    const calls = spyWrites();
    renderIn("processors.metricstransform", <Transforms />);
    const firstBefore = include(0);
    fireEvent.click(screen.getByRole("button", { name: "Add First" }));
    // The held card shows first; the others follow.
    expect(include(1)).toBe(firstBefore);
    const held = include(0);
    act(() => held.focus());
    fireEvent.change(held, { target: { value: "zero" } });
    held.setSelectionRange(2, 2);
    pause();
    expect(calls).toEqual([
      [
        { path: ["transforms", 2], value: { include: "zero", match_type: "strict", action: "update" } },
        { path: ["transforms", 2], moveTo: 0 },
      ],
    ]);
    expect(transforms()).toEqual([
      { include: "zero", match_type: "strict", action: "update" },
      { include: "first", action: "update" },
      { include: "second", action: "update" },
    ]);
    expect(builderStore().history.past).toHaveLength(1);
    expect(include(0)).toBe(held);
    expect(document.activeElement).toBe(held);
    expect(held.selectionStart).toBe(2);
    expect(include(1)).toBe(firstBefore);
    expect(include(1)).toHaveValue("first");
  });

  it("never writes \"\", {} or []: a card typed and cleared writes nothing; write() with nothing typed is unchanged", () => {
    const calls = spyWrites();
    renderIn("processors.metricstransform/empty", <Transforms />);
    fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));
    fireEvent.change(include(0), { target: { value: "x" } });
    fireEvent.change(include(0), { target: { value: "" } });
    pause();
    fireEvent.blur(include(0));
    expect(calls).toEqual([]);
    expect(latest?.held).toBe(true);
    for (const typed of ["", {}, [], { include: "" }, { a: [] }, [""], null]) {
      let result: string | undefined;
      act(() => {
        result = latest!.write(SEED, typed);
      });
      expect(result).toBe("unchanged");
    }
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
  });

  it("holds one message per message and adjusted paths: the same message for another path stays when a change drops the first (D9d Ruling 45)", () => {
    vi.spyOn(toast, "info").mockImplementation(() => "");
    renderIn("processors.metricstransform/empty", <Transforms />);
    fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));
    const message = "Adjusted a setting.";
    act(() => latest!.notice([{ message, adjusted: [["count"]] }]));
    act(() => latest!.notice([{ message, adjusted: [["other"]] }]));
    // The same message for the same paths again is held once.
    act(() => latest!.notice([{ message, adjusted: [["other"]] }]));
    expect(toast.info).not.toHaveBeenCalled();
    // Count typed: the message adjusting count goes (Ruling 41d); the one adjusting other comes with the write, once.
    fireEvent.change(count(0), { target: { value: "3" } });
    fireEvent.blur(count(0));
    expect(transforms("metricstransform/empty")).toEqual([{ match_type: "strict", action: "update", count: 3 }]);
    expect(vi.mocked(toast.info).mock.calls).toEqual([[message]]);
  });

  it("a number typed into a held card is written plain under the item, in the same change", () => {
    const calls = spyWrites();
    renderIn("processors.metricstransform/empty", <Transforms />);
    fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));
    fireEvent.change(count(0), { target: { value: "0x10" } });
    fireEvent.blur(count(0));
    expect(calls).toEqual([
      [
        { path: ["transforms", 0], value: { match_type: "strict", action: "update", count: null } },
        { path: ["transforms", 0, "count"], plain: "0x10" },
      ],
    ]);
    expect(text()).toContain("  metricstransform/empty:\n    transforms:\n      - match_type: strict\n        action: update\n        count: 0x10\n");
  });

  /*
   * D9d Ruling 33a (refining Ruling 33, D9c Preflight ruling 8): a held card
   * belongs to its list's shape. An edit inside another card of its list,
   * and that edit's undo and redo, keep it (its index is worked out when it
   * is written). This test replaces 7be9be6's "is dropped when its own list
   * changes by a write it didn't make (another card's field, an undo of
   * it)", whose cases now keep it; Drop still drops it.
   */
  it("survives an edit of another card's field in its list, and that edit's undo and redo; Drop drops it; neither writes", () => {
    const calls = spyWrites();
    renderIn("processors.metricstransform", <Transforms />);
    fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));
    fireEvent.change(include(0), { target: { value: "renamed" } });
    fireEvent.blur(include(0));
    expect(calls).toEqual([[{ path: ["transforms", 0, "include"], value: "renamed" }]]);
    expect(screen.getAllByTestId("card")).toHaveLength(3);
    expect(latest?.held).toBe(true);

    act(() => builderStore().undo());
    expect(transforms()![0]).toEqual({ include: "first", action: "update" });
    expect(latest?.held).toBe(true);
    act(() => builderStore().redo());
    expect(transforms()![0]).toEqual({ include: "renamed", action: "update" });
    expect(latest?.held).toBe(true);
    expect(screen.getAllByTestId("card")).toHaveLength(3);

    // Its first typing writes the item at the list's end.
    fireEvent.change(include(2), { target: { value: "third" } });
    fireEvent.blur(include(2));
    expect(calls[1]).toEqual([{ path: ["transforms", 2], value: { include: "third", match_type: "strict", action: "update" } }]);

    fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(screen.getAllByTestId("card")).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("a card held at an index survives an edit of the card after it, and is still inserted there", () => {
    const calls = spyWrites();
    renderIn("processors.metricstransform", <Transforms />);
    fireEvent.click(screen.getByRole("button", { name: "Add First" }));
    // The list's first item shows second, after the held card.
    fireEvent.change(include(1), { target: { value: "renamed" } });
    fireEvent.blur(include(1));
    expect(calls).toEqual([[{ path: ["transforms", 0, "include"], value: "renamed" }]]);
    expect(latest?.held).toBe(true);
    fireEvent.change(include(0), { target: { value: "zero" } });
    fireEvent.blur(include(0));
    expect(calls[1]).toEqual([
      { path: ["transforms", 2], value: { include: "zero", match_type: "strict", action: "update" } },
      { path: ["transforms", 2], moveTo: 0 },
    ]);
    expect(transforms()!.map((item) => (item as { include: string }).include)).toEqual(["zero", "renamed", "second"]);
  });

  it("survives a write elsewhere: a sibling key of the same form, and an undo or a YAML-box edit that leaves its list as it was", () => {
    const calls = spyWrites();
    renderIn(
      "processors.metricstransform",
      <>
        <Transforms />
        <TextField path={["other"]} id="other" label="Other" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Other" }), { target: { value: "changed" } });
    pause();
    expect(calls).toEqual([[{ path: ["other"], value: "changed" }]]);
    expect(latest?.held).toBe(true);
    expect(screen.getAllByTestId("card")).toHaveLength(3);

    // An undo of that write: the list is as it was held.
    act(() => builderStore().undo());
    expect(text()).toContain("    other: keep\n");
    expect(latest?.held).toBe(true);

    // The YAML box rewriting another key.
    const nodeId = componentNamed("processors.metricstransform").id;
    act(() => {
      builderStore().setComponentValue(nodeId, componentValueText(text(), "processors.metricstransform").replace("other: keep", "other: boxed"));
    });
    expect(text()).toContain("    other: boxed\n");
    expect(latest?.held).toBe(true);

    // Its first typing still writes the item, at the list's end.
    fireEvent.change(include(2), { target: { value: "third" } });
    fireEvent.blur(include(2));
    expect(calls[1]).toEqual([{ path: ["transforms", 2], value: { include: "third", match_type: "strict", action: "update" } }]);
    expect(transforms()).toHaveLength(3);
  });

  /*
   * Ruling 33a: what drops it is its list's length changing, or the list
   * no longer being one. This test replaces 7be9be6's "is dropped by a
   * YAML-box edit of its list, and by an undo that changes its list", whose
   * edit inside an item (and its undo) now keeps it.
   */
  it("is dropped when another item is added or removed (a write, the YAML box, an undo, a redo) or the list is replaced; a YAML-box edit inside an item keeps it", () => {
    spyWrites();
    renderIn("processors.metricstransform", <Transforms />);
    const nodeId = componentNamed("processors.metricstransform").id;
    const box = (edit: (value: string) => string) =>
      act(() => {
        builderStore().setComponentValue(nodeId, edit(componentValueText(text(), "processors.metricstransform")));
      });
    const add = () => fireEvent.click(screen.getByRole("button", { name: "Add Transform" }));

    // The YAML box editing inside an item, and its undo: kept.
    add();
    box((value) => value.replace("include: second", "include: boxed"));
    expect(transforms()![1]).toEqual({ include: "boxed", action: "update" });
    expect(latest?.held).toBe(true);
    act(() => builderStore().undo());
    expect(transforms()![1]).toEqual({ include: "second", action: "update" });
    expect(latest?.held).toBe(true);
    expect(screen.getAllByTestId("card")).toHaveLength(3);

    // The YAML box removing an item: dropped.
    box((value) => value.replace(/\n *- include: second\n *action: update/, ""));
    expect(transforms()).toHaveLength(1);
    expect(latest?.held).toBe(false);
    expect(screen.getAllByTestId("card")).toHaveLength(1);

    // Its undo (the item back) and redo (gone again): each drops it.
    add();
    act(() => builderStore().undo());
    expect(transforms()).toHaveLength(2);
    expect(latest?.held).toBe(false);
    add();
    act(() => builderStore().redo());
    expect(transforms()).toHaveLength(1);
    expect(latest?.held).toBe(false);

    // Another item added by a write it didn't make.
    add();
    act(() => {
      builderStore().setComponentValues(nodeId, [{ path: ["transforms", 1], value: { include: "added" } }]);
    });
    expect(transforms()).toHaveLength(2);
    expect(latest?.held).toBe(false);

    // The list replaced by something that isn't a list.
    add();
    act(() => {
      builderStore().setComponentValues(nodeId, [{ path: ["transforms"], value: "none" }]);
    });
    expect(latest?.held).toBe(false);
  });

  it("write() puts a list item that is itself a list (a failover level), seeded or not", () => {
    const calls = spyWrites();
    renderIn("processors.metricstransform/empty", <Transforms />);
    act(() => {
      latest!.write(undefined, ["traces/a"]);
    });
    expect(calls).toEqual([[{ path: ["transforms", 0], value: ["traces/a"] }]]);
    expect(transforms("metricstransform/empty")).toEqual([["traces/a"]]);
  });
});

const dimensionsOf = () =>
  (parseYaml(text()) as { connectors: { spanmetrics: { dimensions: unknown[] } } }).connectors.spanmetrics.dimensions;
const nameAt = (index: number) => document.getElementById(`dims-${index}-name`) as HTMLInputElement;
const defaultAt = (index: number) => document.getElementById(`dims-${index}-default`) as HTMLInputElement;

describe("DimensionListField (decision 12)", () => {
  it("shows a row per dimension; a glob or a non-mapping is a read-only row with the hint, whose Remove works", () => {
    const calls = spyWrites();
    renderIn("connectors.spanmetrics", <DimensionListField path={["dimensions"]} id="dims" />);
    expect(nameAt(0)).toHaveValue("http.method");
    expect(defaultAt(0)).toHaveValue("GET");
    expect(nameAt(1)).toHaveValue("http.status_code");
    expect(defaultAt(1)).toHaveValue("");
    expect(nameAt(2)).toBeDisabled();
    expect(nameAt(3)).toBeDisabled();
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Remove dimension" })).toHaveLength(4);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove dimension" })[2]!);
    expect(calls).toEqual([[{ path: ["dimensions", 2], remove: true }]]);
    expect(dimensionsOf()).toEqual([{ name: "http.method", default: "GET" }, { name: "http.status_code" }, "plain"]);
  });

  it("Add holds a row until a name is typed; a Default typed first waits; the name writes both in one change, focus kept", () => {
    const calls = spyWrites();
    renderIn("connectors.spanmetrics", <DimensionListField path={["dimensions"]} id="dims" />);
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    expect(nameAt(4)).toHaveValue("");
    fireEvent.change(defaultAt(4), { target: { value: "unknown" } });
    fireEvent.blur(defaultAt(4));
    expect(calls).toEqual([]);
    expect(defaultAt(4)).toHaveValue("unknown");

    const name = nameAt(4);
    act(() => name.focus());
    fireEvent.change(name, { target: { value: "region" } });
    pause();
    expect(calls).toEqual([[{ path: ["dimensions", 4], value: { name: "region", default: "unknown" } }]]);
    expect(text()).toContain('      - plain\n      - name: region\n        default: unknown\nexporters:');
    expect(nameAt(4)).toBe(name);
    expect(document.activeElement).toBe(name);
  });

  it("a held row left with nothing in it is dropped (D9d Ruling 33, as MultiValueField's); focus moving within it keeps it", () => {
    const calls = spyWrites();
    renderIn("connectors.spanmetrics", <DimensionListField path={["dimensions"]} id="dims" />);
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    // A name typed and emptied before the pause, then left: the row goes, unwritten.
    act(() => nameAt(4).focus());
    fireEvent.change(nameAt(4), { target: { value: "region" } });
    fireEvent.change(nameAt(4), { target: { value: "" } });
    act(() => nameAt(4).blur());
    expect(nameAt(4)).toBeNull();
    expect(calls).toEqual([]);

    // A Default typed: focus moving to the name keeps the row; emptied and left, it goes.
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    act(() => defaultAt(4).focus());
    fireEvent.change(defaultAt(4), { target: { value: "unknown" } });
    act(() => nameAt(4).focus());
    expect(defaultAt(4)).toHaveValue("unknown");
    act(() => defaultAt(4).focus());
    fireEvent.change(defaultAt(4), { target: { value: "" } });
    act(() => nameAt(4).focus());
    expect(nameAt(4)).not.toBeNull();
    act(() => nameAt(4).blur());
    expect(nameAt(4)).toBeNull();
    expect(calls).toEqual([]);
    expect(dimensionsOf()).toHaveLength(4);
  });

  it("focus moving into a field's $ picker (a popover in <body>) keeps the held row; a pick lands in it (D9d Ruling 38)", () => {
    const calls = spyWrites();
    renderIn("connectors.spanmetrics", <DimensionListField path={["dimensions"]} id="dims" />);
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    const name = nameAt(4);
    act(() => name.focus());
    fireEvent.change(name, { target: { value: "$" } });
    const env = screen.getByRole("button", { name: /Environment variable/ });
    expect(env.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(document.body);
    // The picker's row takes focus mid-click: the name's blur is skipped, so nothing is written to the row yet.
    act(() => env.focus());
    expect(nameAt(4)).toBe(name);
    fireEvent.click(env);
    expect(nameAt(4)).toHaveValue("${env:}");
    act(() => name.focus());
    pause();
    expect(calls).toEqual([[{ path: ["dimensions", 4], value: { name: "${env:}" } }]]);

    // Focus leaving for anywhere else still drops an empty held row.
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    act(() => nameAt(5).focus());
    act(() => screen.getByRole("button", { name: "Add Dimension" }).focus());
    expect(nameAt(5)).toBeNull();
  });

  it("a held row survives an edit of another dimension and its undo; another dimension removed, or that undone, drops it (D9d Ruling 33a)", () => {
    const calls = spyWrites();
    renderIn("connectors.spanmetrics", <DimensionListField path={["dimensions"]} id="dims" />);
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    fireEvent.change(defaultAt(4), { target: { value: "unknown" } });
    fireEvent.blur(defaultAt(4));

    fireEvent.change(nameAt(0), { target: { value: "http.verb" } });
    fireEvent.blur(nameAt(0));
    expect(calls).toEqual([[{ path: ["dimensions", 0, "name"], value: "http.verb" }]]);
    expect(defaultAt(4)).toHaveValue("unknown");
    act(() => builderStore().undo());
    expect(dimensionsOf()[0]).toEqual({ name: "http.method", default: "GET" });
    expect(defaultAt(4)).toHaveValue("unknown");

    // Another dimension removed: the held row goes, unwritten.
    fireEvent.click(screen.getAllByRole("button", { name: "Remove dimension" })[2]!);
    expect(dimensionsOf()).toHaveLength(3);
    expect(defaultAt(3)).toBeNull();
    expect(defaultAt(4)).toBeNull();

    // Held again, and that removal undone: it goes.
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    expect(nameAt(3)).toHaveValue("");
    act(() => builderStore().undo());
    expect(dimensionsOf()).toHaveLength(4);
    expect(nameAt(4)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("a name cleared removes the dimension once left, never writing \"\"; Default cleared removes default", () => {
    const calls = spyWrites();
    renderIn("connectors.spanmetrics", <DimensionListField path={["dimensions"]} id="dims" />);
    fireEvent.change(defaultAt(0), { target: { value: "" } });
    fireEvent.blur(defaultAt(0));
    expect(calls).toEqual([[{ path: ["dimensions", 0, "default"], remove: true }]]);
    fireEvent.change(nameAt(1), { target: { value: "" } });
    pause();
    expect(calls).toHaveLength(1);
    fireEvent.blur(nameAt(1));
    expect(calls[1]).toEqual([{ path: ["dimensions", 1], remove: true }]);
    expect(dimensionsOf()).toEqual([{ name: "http.method" }, { glob: "http.*" }, "plain"]);
    expect(text()).not.toContain('""');
  });
});

describe("privacy (decision 13)", () => {
  it("no attribute holds a value: dimension rows, a held row's typing, a held card's", () => {
    const MARK = "MARKER";
    renderIn(
      "connectors.spanmetrics",
      <DimensionListField path={["dimensions"]} id="dims" />,
      TEXT.replace("name: http.method", `name: ${MARK}.method`).replace("default: GET", `default: ${MARK}-get`),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Dimension" }));
    fireEvent.change(defaultAt(4), { target: { value: `${MARK}-held` } });
    fireEvent.blur(defaultAt(4));
    expect(nameAt(0)).toHaveValue(`${MARK}.method`);
    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (attribute.name === "value" && element instanceof HTMLInputElement) continue;
        if (attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
  });
});
