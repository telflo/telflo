import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "../form-context.js";
import { ListTextField, NumberListField } from "./ListTextField.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * ListTextField and NumberListField (D9d Task 2; decision 12; Preflight
 * rulings 5 and 20): what they show, what they write by item, the pause
 * that never drops a typed separator or line break, and what they can't
 * show.
 */

const TEXT = `exporters:
  file:
    values:
      - GET /health # the probe
      - POST /login
    commas: [a, b]
    with_comma:
      - "a,b"
    spaced:
      - " padded"
    blank:
      - ""
    nested:
      - {a: 1}
    lines:
      - "one\\ntwo"
    not_a_list: text
    histogram:
      explicit:
        buckets: [2ms, 4ms]
      unit: ms
    percentiles: [50, 99]
  file/unset: {}
receivers:
  otlp:
    protocols:
      grpc: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file, file/unset]
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
const values = (key = "file") => (parseYaml(text()) as { exporters: Record<string, Record<string, unknown>> }).exporters[key]!;
const input = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement | HTMLTextAreaElement;
const pause = (ms = FIELD_WRITE_DELAY_MS) => act(() => vi.advanceTimersByTime(ms));
const type = (name: string, value: string) => fireEvent.change(input(name), { target: { value } });

const comma = (path = ["commas"], extra: Partial<Parameters<typeof ListTextField>[0]> = {}) => (
  <ListTextField path={path} id="commas" label="Commas" separator="," {...extra} />
);
const lines = (path = ["values"], extra: Partial<Parameters<typeof ListTextField>[0]> = {}) => (
  <ListTextField path={path} id="values" label="Values" separator={"\n"} {...extra} />
);

describe("what it shows", () => {
  it("items joined by the separator (`,` by default, `join` for the comma field), or one per line in a textarea", () => {
    renderIn(
      "exporters.file",
      <>
        {comma()}
        {lines()}
        <ListTextField path={["histogram", "explicit", "buckets"]} id="buckets" label="Buckets" separator="," join=", " />
      </>,
    );
    expect(input("Commas")).toHaveValue("a,b");
    expect(input("Commas").tagName).toBe("INPUT");
    expect(input("Values")).toHaveValue("GET /health\nPOST /login");
    expect(input("Values").tagName).toBe("TEXTAREA");
    expect(input("Buckets")).toHaveValue("2ms, 4ms");
  });

  it("an item it can't show makes it read-only with the hint: a comma in a comma field, spaces around (either variant), empty, a mapping, a line break, not a list", () => {
    renderIn(
      "exporters.file",
      <>
        <ListTextField path={["with_comma"]} id="f1" label="With Comma" separator="," />
        <ListTextField path={["with_comma"]} id="f2" label="With Comma Lines" separator={"\n"} />
        <ListTextField path={["spaced"]} id="f3" label="Spaced" separator="," />
        <ListTextField path={["spaced"]} id="f8" label="Spaced Lines" separator={"\n"} />
        <ListTextField path={["blank"]} id="f4" label="Blank" separator={"\n"} />
        <ListTextField path={["nested"]} id="f5" label="Nested" separator="," />
        <ListTextField path={["lines"]} id="f6" label="Lines" separator={"\n"} />
        <ListTextField path={["not_a_list"]} id="f7" label="Not A List" separator="," />
      </>,
    );
    // A comma is only a separator in the comma field.
    expect(input("With Comma Lines")).toHaveValue("a,b");
    expect(input("With Comma Lines")).toBeEnabled();
    // An untrimmed line too (Task 2's review): a line is written trimmed, so it can't be shown as it is.
    for (const name of ["With Comma", "Spaced", "Spaced Lines", "Blank", "Nested", "Lines", "Not A List"]) expect(input(name)).toBeDisabled();
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(7);
  });
});

describe("the pause keeps a typed separator (Preflight ruling 5)", () => {
  it("comma: `a,` and a wait keep the comma; `b` then writes two items", () => {
    const calls = spyWrites();
    renderIn("exporters.file/unset", comma(["items"]));
    type("Commas", "a,");
    pause(400);
    expect(calls).toEqual([]);
    expect(input("Commas")).toHaveValue("a,");
    type("Commas", "a,b");
    pause(400);
    expect(calls).toEqual([[{ path: ["items"], value: ["a", "b"] }]]);
    expect(input("Commas")).toHaveValue("a,b");
  });

  it("newline: `a` and a line break and a wait keep the line break; `b` then writes two items; Enter is a line break, not a write", () => {
    const calls = spyWrites();
    renderIn("exporters.file/unset", lines(["items"]));
    type("Values", "a\n");
    fireEvent.keyDown(input("Values"), { key: "Enter" });
    pause(400);
    expect(calls).toEqual([]);
    expect(input("Values")).toHaveValue("a\n");
    type("Values", "a\nb");
    pause(400);
    expect(calls).toEqual([[{ path: ["items"], value: ["a", "b"] }]]);
    expect(input("Values")).toHaveValue("a\nb");
  });

  it("the pause also waits out an empty item, a trailing space, a cleared field and spacing the list wouldn't show", () => {
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <>
        {comma()}
        {lines()}
      </>,
    );
    for (const draft of ["a,,b", "a ", "a, ", "", " a,b", "a, b"]) {
      type("Commas", draft);
      pause(400);
      expect(input("Commas")).toHaveValue(draft);
    }
    for (const draft of ["GET /health\n\nPOST /login", "GET \n", "GET /health\n  "]) {
      type("Values", draft);
      pause(400);
      expect(input("Values")).toHaveValue(draft);
    }
    expect(calls).toEqual([]);
  });

  it("blur after a trailing separator writes one item, both variants", () => {
    const calls = spyWrites();
    renderIn(
      "exporters.file/unset",
      <>
        {comma(["first"])}
        {lines(["second"])}
      </>,
    );
    type("Commas", "a,");
    fireEvent.blur(input("Commas"));
    type("Values", "x\n");
    fireEvent.blur(input("Values"));
    expect(calls).toEqual([[{ path: ["first"], value: ["a"] }], [{ path: ["second"], value: ["x"] }]]);
    expect(input("Commas")).toHaveValue("a");
    expect(input("Values")).toHaveValue("x");
  });

  it("Enter in the comma field, Cmd/Ctrl+S, the page's flush and the field going write the draft", () => {
    const calls = spyWrites();
    const { unmount } = renderIn(
      "exporters.file/unset",
      <>
        {comma(["first"])}
        {lines(["second"])}
      </>,
    );
    type("Commas", "a,");
    fireEvent.keyDown(input("Commas"), { key: "Enter" });
    type("Values", "x\n");
    fireEvent.keyDown(input("Values"), { key: "s", metaKey: true });
    type("Commas", "a,b,");
    act(() => flushHeldEdits());
    type("Values", "x\ny\n");
    unmount();
    expect(calls).toEqual([
      [{ path: ["first"], value: ["a"] }],
      [{ path: ["second"], value: ["x"] }],
      [{ path: ["first", 1], value: "b" }],
      [{ path: ["second", 1], value: "y" }],
    ]);
  });
});

describe("written by item", () => {
  it("a changed item is set, keeping the others' lines and comments; extra items go from the last; new ones are appended", () => {
    const calls = spyWrites();
    renderIn("exporters.file", lines());
    type("Values", "GET /health\nPUT /login\nDELETE /x");
    fireEvent.blur(input("Values"));
    expect(calls).toEqual([
      [
        { path: ["values", 1], value: "PUT /login" },
        { path: ["values", 2], value: "DELETE /x" },
      ],
    ]);
    expect(text()).toContain("    values:\n      - GET /health # the probe\n      - PUT /login\n      - DELETE /x\n");
    type("Values", "GET /health");
    fireEvent.blur(input("Values"));
    expect(calls[1]).toEqual([
      { path: ["values", 2], remove: true },
      { path: ["values", 1], remove: true },
    ]);
    expect(text()).toContain("    values:\n      - GET /health # the probe\n    commas:");
  });

  it("emptied: the items go, leaving []; with emptyRemovesKey the key; with removePathWhenEmpty that path", () => {
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <>
        {comma()}
        {lines(["values"], { emptyRemovesKey: true })}
        <ListTextField
          path={["histogram", "explicit", "buckets"]}
          id="buckets"
          label="Buckets"
          separator=","
          removePathWhenEmpty={["histogram", "explicit"]}
        />
      </>,
    );
    type("Commas", "");
    pause(1000);
    expect(calls).toEqual([]);
    fireEvent.blur(input("Commas"));
    type("Values", "");
    fireEvent.blur(input("Values"));
    type("Buckets", "");
    fireEvent.blur(input("Buckets"));
    expect(calls).toEqual([
      [
        { path: ["commas", 1], remove: true },
        { path: ["commas", 0], remove: true },
      ],
      [{ path: ["values"], remove: true }],
      [{ path: ["histogram", "explicit"], remove: true }],
    ]);
    expect(values().commas).toEqual([]);
    expect(values()).not.toHaveProperty("values");
    expect(values().histogram).toEqual({ unit: "ms" });
  });

  it("plainNumbers writes an item reading as a number plain, as typed, and any other as a string", () => {
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <ListTextField path={["histogram", "explicit", "buckets"]} id="buckets" label="Buckets" separator="," join=", " plainNumbers />,
    );
    type("Buckets", "2ms, 100, 1e3");
    fireEvent.blur(input("Buckets"));
    expect(calls).toEqual([
      [
        { path: ["histogram", "explicit", "buckets", 1], plain: "100" },
        { path: ["histogram", "explicit", "buckets", 2], plain: "1e3" },
      ],
    ]);
    expect(text()).toContain("        buckets: [2ms, 100, 1e3]\n");
    expect(input("Buckets")).toHaveValue("2ms, 100, 1e3");
  });

  it("NumberListField: numbers plain as typed, a reference as a string, emptied removes the key", () => {
    const calls = spyWrites();
    renderIn("exporters.file", <NumberListField path={["percentiles"]} id="percentiles" label="Percentiles" join=", " />);
    expect(input("Percentiles")).toHaveValue("50, 99");
    expect(input("Percentiles")).toHaveAttribute("inputmode", "decimal");
    type("Percentiles", "50, 99.9, ${env:P}");
    fireEvent.blur(input("Percentiles"));
    expect(calls).toEqual([
      [
        { path: ["percentiles", 1], plain: "99.9" },
        { path: ["percentiles", 2], value: "${env:P}" },
      ],
    ]);
    type("Percentiles", "");
    fireEvent.blur(input("Percentiles"));
    expect(calls[1]).toEqual([{ path: ["percentiles"], remove: true }]);
  });
});

describe("privacy (decision 13)", () => {
  it("no attribute holds an item, either variant; no field sits in a <form>", () => {
    const MARK = "MARKER";
    renderIn(
      "exporters.file",
      <>
        {comma()}
        {lines()}
      </>,
      TEXT.replace("commas: [a, b]", `commas: [${MARK}-a, b]`).replace("- POST /login", `- ${MARK} /login`),
    );
    type("Commas", `${MARK}-typed,`);
    expect(input("Values")).toHaveValue(`GET /health\n${MARK} /login`);
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
