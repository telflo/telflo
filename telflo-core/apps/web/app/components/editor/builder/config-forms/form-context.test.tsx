import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  CheckboxField,
  DurationField,
  FormProvider,
  FormScope,
  MultiValueField,
  NumberField,
  SelectField,
  TextareaField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useComponentForm,
  useForm,
  useTelemetryDraft,
  type FormSource,
  type TelemetryDraft,
} from "./form-context.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import { CANT_EDIT_ON_CANVAS_MESSAGE, selectIsDirty, useEditorStore, type ValuesResult } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { hasHeldEdits } from "~/test/held-edits.js";

/*
 * The form hook and the fields: what each field shows of the text, and how
 * typing is written.
 */

const TEXT = `# Fields over a component's value.
x-defaults: &defaults
  timeout: 5s
x-comp: &comp gzip
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: localhost:4317 # the endpoint
exporters:
  debug:
    verbosity: basic # how much
    sampling_initial: 0750
    sampling_thereafter: ~
    exponent: 1e3
    hex: 0x1F
    reference: \${env:X}
    quoted: "0750"
    nested:
      a: 1
    items: [a, b]
    script: |
      line one
      line two
    enabled: true
    flag: "yes"
    level: loud
    keys:
      - one # first
      - two
    timeout: 1m30s
    nanos: 5
  otlp:
    <<: *defaults
    compression: *comp
    endpoint: backend:4317
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug, otlp, logging]
`;

const ERROR = "Invalid duration format. Use: 1ns, 1us, 1ms, 1s, 1m, or 1h";
const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Records every change list a form sends the store, and passes it on. */
function spyWrites(result?: ValuesResult): ValueChange[][] {
  const original = builderStore().setComponentValues;
  const calls: ValueChange[][] = [];
  useEditorStore.setState({
    setComponentValues: (nodeId, changes) => {
      calls.push([...changes]);
      return result ?? original(nodeId, changes);
    },
  });
  return calls;
}

function ComponentForm({ nodeId, children, probe }: { nodeId: string; children: ReactNode; probe?: (form: FormSource) => void }) {
  const form = useComponentForm(nodeId);
  probe?.(form);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderComponent(key: string, children: ReactNode, probe?: (form: FormSource) => void) {
  openText(TEXT);
  const nodeId = componentNamed(key).id;
  const view = render(
    <ComponentForm nodeId={nodeId} {...(probe ? { probe } : {})}>
      {children}
    </ComponentForm>,
  );
  return { nodeId, ...view };
}

const renderDebug = (children: ReactNode, probe?: (form: FormSource) => void) =>
  renderComponent("exporters.debug", children, probe);

const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const text = () => builderStore().text;
const debugValue = () => (parseYaml(text()) as { exporters: { debug: Record<string, unknown> } }).exporters.debug;

/** The lines of `after` that differ from `before`'s, when the count is the same. */
function changedLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b).toHaveLength(a.length);
  return b.filter((line, index) => line !== a[index]);
}

function pause(ms = FIELD_WRITE_DELAY_MS) {
  act(() => vi.advanceTimersByTime(ms));
}

describe("what a field shows", () => {
  it("shows plain non-strings as written and strings as their value", () => {
    renderDebug(
      <>
        <NumberField path={["sampling_initial"]} id="sampling-initial" label="Sampling Initial" />
        <NumberField path={["exponent"]} id="exponent" label="Exponent" />
        <NumberField path={["hex"]} id="hex" label="Hex" />
        <TextField path={["reference"]} id="reference" label="Reference" />
        <TextField path={["quoted"]} id="quoted" label="Quoted" />
        <TextField path={["enabled"]} id="enabled-text" label="Enabled as text" />
        <DurationField path={["timeout"]} id="timeout" label="Timeout" />
        <TextareaField path={["script"]} id="script" label="Script" />
      </>,
    );
    expect(field("Sampling Initial")).toHaveValue("0750");
    expect(field("Exponent")).toHaveValue("1e3");
    expect(field("Hex")).toHaveValue("0x1F");
    expect(field("Reference")).toHaveValue("${env:X}");
    expect(field("Quoted")).toHaveValue("0750");
    expect(field("Enabled as text")).toHaveValue("true");
    expect(field("Timeout")).toHaveValue("1m30s");
    expect(field("Script")).toHaveValue("line one\nline two\n");
    expect(field("Sampling Initial")).toHaveAttribute("id", "sampling-initial");
  });

  it("shows an explicit null and a missing key as unset: empty, the default as placeholder and hint", () => {
    renderDebug(
      <>
        <NumberField path={["sampling_thereafter"]} id="sampling-thereafter" label="Sampling Thereafter" defaultValue="1" />
        <DurationField path={["missing"]} id="missing" label="Missing" defaultValue="200ms" />
        <NumberField path={["other"]} id="other" label="Other" defaultValue="0 (no limit)" placeholder="0" />
      </>,
    );
    expect(field("Sampling Thereafter")).toHaveValue("");
    expect(field("Sampling Thereafter")).toHaveAttribute("placeholder", "1");
    expect(screen.getByText("1", { selector: "span.font-mono" }).parentElement).toHaveTextContent("Default 1");
    expect(field("Missing")).toHaveValue("");
    expect(field("Missing")).toHaveAttribute("placeholder", "200ms");
    expect(screen.getByText("200ms", { selector: "span.font-mono" })).toBeInTheDocument();
    expect(field("Other")).toHaveAttribute("placeholder", "0");
    expect(screen.getByText("0 (no limit)", { selector: "span.font-mono" })).toBeInTheDocument();
  });

  it("shows what an alias and a merge key resolve to", () => {
    renderComponent(
      "exporters.otlp",
      <>
        <DurationField path={["timeout"]} id="timeout" label="Timeout" />
        <TextField path={["compression"]} id="compression" label="Compression" />
        <TextField path={["endpoint"]} id="endpoint" label="Endpoint" />
      </>,
    );
    expect(field("Timeout")).toHaveValue("5s");
    expect(field("Compression")).toHaveValue("gzip");
    expect(field("Endpoint")).toHaveValue("backend:4317");
  });

  it("makes a field that can't show its value read-only, with the hint as text; the rest of the form works", () => {
    renderDebug(
      <>
        <TextField path={["nested"]} id="nested" label="Nested" />
        <NumberField path={["items"]} id="items" label="Items" />
        <TextField path={["script"]} id="script" label="Script" />
        <MultiValueField path={["nested"]} label="Nested list" />
        <MultiValueField path={["items", 0]} label="Item as list" />
        <TextField path={["reference"]} id="reference" label="Reference" />
      </>,
    );
    expect(field("Nested")).toBeDisabled();
    expect(field("Nested")).toHaveValue("");
    expect(field("Items")).toBeDisabled();
    expect(field("Script")).toBeDisabled();
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(5);
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)[0]).toHaveClass("text-[11px]", "text-muted-foreground");
    expect(UNSHOWABLE_VALUE_MESSAGE).toBe("This value is written in a form this field can't show. Edit it in the YAML below.");
    expect(field("Reference")).toBeEnabled();
  });

  it("a select shows its option, the default as placeholder when unset, and a value outside its options as an extra option", async () => {
    const user = userEvent.setup();
    const options = [
      { value: "basic", label: "Basic" },
      { value: "normal", label: "Normal" },
      { value: "detailed", label: "Detailed" },
    ];
    renderDebug(
      <>
        <SelectField path={["verbosity"]} id="verbosity" label="Verbosity" defaultValue="basic" options={options} />
        <SelectField path={["level"]} id="level" label="Level" defaultValue="basic" options={options} />
        <SelectField path={["unset"]} id="unset" label="Unset" defaultValue="normal" options={options} />
        <SelectField path={["nested"]} id="nested" label="Nested" options={options} />
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Verbosity" })).toHaveTextContent("Basic");
    expect(screen.getByRole("combobox", { name: "Level" })).toHaveTextContent("loud");
    expect(screen.getByRole("combobox", { name: "Unset" })).toHaveTextContent("Normal");
    expect(screen.getByRole("combobox", { name: "Unset" })).toHaveAttribute("data-placeholder");
    expect(screen.getByRole("combobox", { name: "Nested" })).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Level" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Basic", "Normal", "Detailed", "loud"]);
  });

  it("a checkbox shows its value, the collector's default when unset, and can't show a string", () => {
    renderDebug(
      <>
        <CheckboxField path={["enabled"]} id="enabled" label="Enabled" defaultChecked={false} description="On or off." />
        <CheckboxField path={["unset_on"]} id="unset-on" label="Unset on" defaultChecked />
        <CheckboxField path={["unset_off"]} id="unset-off" label="Unset off" defaultChecked={false} />
        <CheckboxField path={["flag"]} id="flag" label="Flag" defaultChecked />
      </>,
    );
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeChecked();
    expect(screen.getByText("On or off.")).toHaveClass("ml-6");
    expect(screen.getByRole("checkbox", { name: "Unset on" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Unset off" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Flag" })).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });

  it("follows the text when it changes elsewhere", () => {
    renderDebug(<NumberField path={["sampling_initial"]} id="sampling-initial" label="Sampling Initial" />);
    act(() => void builderStore().setComponentValues(componentNamed("exporters.debug").id, [{ path: ["sampling_initial"], plain: "12" }]));
    expect(field("Sampling Initial")).toHaveValue("12");
    act(() => builderStore().undo());
    expect(field("Sampling Initial")).toHaveValue("0750");
  });
});

describe("how typing is written", () => {
  it("writes once, 300 ms after the last keystroke, only that key's line", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderDebug(<TextField path={["reference"]} id="reference" label="Reference" />);
    const before = text();

    for (const typed of ["${env:X}a", "${env:X}ab", "${env:X}abc"]) {
      fireEvent.change(field("Reference"), { target: { value: typed } });
      pause(FIELD_WRITE_DELAY_MS - 1);
    }
    expect(calls).toHaveLength(0);
    expect(hasHeldEdits()).toBe(true);
    pause(1);

    expect(calls).toEqual([[{ path: ["reference"], value: "${env:X}abc" }]]);
    expect(changedLines(before, text())).toEqual(["    reference: ${env:X}abc"]);
    expect(field("Reference")).toHaveValue("${env:X}abc");
    expect(hasHeldEdits()).toBe(false);
    expect(selectIsDirty(builderStore())).toBe(true);
  });

  it("writes at once on blur, and on Enter", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderDebug(
      <>
        <TextField path={["reference"]} id="reference" label="Reference" />
        <NumberField path={["exponent"]} id="exponent" label="Exponent" />
      </>,
    );
    fireEvent.change(field("Reference"), { target: { value: "a" } });
    fireEvent.blur(field("Reference"));
    expect(calls).toHaveLength(1);
    expect(debugValue().reference).toBe("a");

    fireEvent.change(field("Exponent"), { target: { value: "2e3" } });
    fireEvent.keyDown(field("Exponent"), { key: "Enter" });
    expect(calls).toHaveLength(2);
    expect(text()).toContain("    exponent: 2e3\n");

    // Nothing is left waiting.
    pause(1000);
    expect(calls).toHaveLength(2);
  });

  it("a held edit is written by Cmd/Ctrl+S in the field, and by the page's flush", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderDebug(
      <>
        <TextField path={["reference"]} id="reference" label="Reference" />
        <TextareaField path={["script"]} id="script" label="Script" />
      </>,
    );
    fireEvent.change(field("Reference"), { target: { value: "meta" } });
    fireEvent.keyDown(field("Reference"), { key: "s", metaKey: true });
    expect(calls).toHaveLength(1);
    fireEvent.change(field("Reference"), { target: { value: "ctrl" } });
    fireEvent.keyDown(field("Reference"), { key: "S", ctrlKey: true });
    expect(calls).toHaveLength(2);
    expect(debugValue().reference).toBe("ctrl");

    // A textarea's Enter is a new line; the save still writes it.
    fireEvent.change(field("Script"), { target: { value: "one\n" } });
    fireEvent.keyDown(field("Script"), { key: "Enter" });
    expect(calls).toHaveLength(2);
    act(() => flushHeldEdits());
    expect(calls).toHaveLength(3);
    expect(debugValue().script).toBe("one\n");
  });

  it("writes what a field holds when it goes", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    const { unmount } = renderDebug(<TextField path={["reference"]} id="reference" label="Reference" />);
    fireEvent.change(field("Reference"), { target: { value: "gone" } });
    unmount();
    expect(calls).toHaveLength(1);
    expect(debugValue().reference).toBe("gone");
  });

  it("a number field writes 0, a number as typed, and a reference as a string", () => {
    vi.useFakeTimers();
    renderDebug(<NumberField path={["sampling_initial"]} id="sampling-initial" label="Sampling Initial" />);
    const before = text();

    fireEvent.change(field("Sampling Initial"), { target: { value: "0" } });
    fireEvent.blur(field("Sampling Initial"));
    expect(changedLines(before, text())).toEqual(["    sampling_initial: 0"]);
    expect(debugValue().sampling_initial).toBe(0);

    fireEvent.change(field("Sampling Initial"), { target: { value: "${env:N}" } });
    fireEvent.blur(field("Sampling Initial"));
    expect(changedLines(before, text())).toEqual(["    sampling_initial: ${env:N}"]);
    expect(field("Sampling Initial")).toHaveValue("${env:N}");

    fireEvent.change(field("Sampling Initial"), { target: { value: "0x10" } });
    fireEvent.blur(field("Sampling Initial"));
    expect(changedLines(before, text())).toEqual(["    sampling_initial: 0x10"]);
    expect(field("Sampling Initial")).toHaveValue("0x10");

    // Characters that don't read as a number are a string, quoted as the text needs.
    fireEvent.change(field("Sampling Initial"), { target: { value: "12 # not a comment" } });
    fireEvent.blur(field("Sampling Initial"));
    expect(debugValue().sampling_initial).toBe("12 # not a comment");

    // A number field asks for a number only: a boolean or a collection typed is a string.
    for (const typed of ["True", "[1]"]) {
      fireEvent.change(field("Sampling Initial"), { target: { value: typed } });
      fireEvent.blur(field("Sampling Initial"));
      expect(debugValue().sampling_initial).toBe(typed);
    }
  });

  it("a duration field takes 1m30s, 0 and references, and shows the error for what the collector refuses, still writing it", () => {
    vi.useFakeTimers();
    renderDebug(
      <>
        <DurationField path={["timeout"]} id="timeout" label="Timeout" />
        <DurationField path={["nanos"]} id="nanos" label="Nanos" />
      </>,
    );
    // A plain integer in the text is nanoseconds to the collector.
    expect(field("Nanos")).toHaveValue("5");
    expect(screen.queryByText(ERROR)).toBeNull();

    for (const typed of ["1h30m", "0", "${env:TIMEOUT}", "1m30s"]) {
      fireEvent.change(field("Timeout"), { target: { value: typed } });
      expect(screen.queryByText(ERROR)).toBeNull();
      fireEvent.blur(field("Timeout"));
      expect(debugValue().timeout).toBe(typed);
      expect(screen.queryByText(ERROR)).toBeNull();
    }

    fireEvent.change(field("Timeout"), { target: { value: "10" } });
    expect(screen.getByText(ERROR)).toBeInTheDocument();
    fireEvent.blur(field("Timeout"));
    expect(debugValue().timeout).toBe("10");
    expect(screen.getByText(ERROR)).toBeInTheDocument();

    // Typing into the nanoseconds field is a string, which the collector refuses without a unit.
    fireEvent.change(field("Nanos"), { target: { value: "6" } });
    expect(screen.getAllByText(ERROR)).toHaveLength(2);
  });

  it("clearing a field removes its key's lines", () => {
    vi.useFakeTimers();
    renderDebug(
      <>
        <TextField path={["reference"]} id="reference" label="Reference" defaultValue="none" />
        <TextareaField path={["script"]} id="script" label="Script" />
      </>,
    );
    fireEvent.change(field("Reference"), { target: { value: "" } });
    fireEvent.blur(field("Reference"));
    expect(text()).not.toContain("reference:");
    expect(text().split("\n")).toHaveLength(TEXT.split("\n").length - 1);
    expect(field("Reference")).toHaveValue("");
    expect(field("Reference")).toHaveAttribute("placeholder", "none");

    fireEvent.change(field("Script"), { target: { value: "" } });
    fireEvent.blur(field("Script"));
    expect(text()).not.toContain("script:");
    expect(text()).not.toContain("line one");
  });

  it("a draft equal to what the field shows writes nothing: no entry, not dirty", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderDebug(
      <>
        <NumberField path={["sampling_initial"]} id="sampling-initial" label="Sampling Initial" />
        <TextField path={["sampling_thereafter"]} id="sampling-thereafter" label="Sampling Thereafter" />
      </>,
    );
    act(() => field("Sampling Initial").focus());
    fireEvent.blur(field("Sampling Initial"));
    fireEvent.change(field("Sampling Initial"), { target: { value: "0751" } });
    fireEvent.change(field("Sampling Initial"), { target: { value: "0750" } });
    expect(hasHeldEdits()).toBe(false);
    pause();
    fireEvent.keyDown(field("Sampling Initial"), { key: "Enter" });
    // An explicit null shows empty; an empty draft over it is what it shows.
    fireEvent.change(field("Sampling Thereafter"), { target: { value: "x" } });
    fireEvent.change(field("Sampling Thereafter"), { target: { value: "" } });
    fireEvent.blur(field("Sampling Thereafter"));

    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
    expect(builderStore().history.past).toHaveLength(0);
    expect(selectIsDirty(builderStore())).toBe(false);
  });

  it("a refused write shows the text's value again", () => {
    vi.useFakeTimers();
    const calls = spyWrites("refused");
    renderDebug(<NumberField path={["sampling_initial"]} id="sampling-initial" label="Sampling Initial" />);
    fireEvent.change(field("Sampling Initial"), { target: { value: "9" } });
    expect(field("Sampling Initial")).toHaveValue("9");
    fireEvent.blur(field("Sampling Initial"));
    expect(calls).toHaveLength(1);
    expect(field("Sampling Initial")).toHaveValue("0750");
    expect(hasHeldEdits()).toBe(false);
  });

  it("a change the text edits refuse toasts the can't-edit message, and the field shows the text", () => {
    vi.useFakeTimers();
    renderDebug(<TextField path={["items", 5]} id="far-item" label="Far item" />);
    fireEvent.change(field("Far item"), { target: { value: "x" } });
    fireEvent.blur(field("Far item"));
    expect(toast.error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
    expect(text()).toBe(TEXT);
    expect(field("Far item")).toHaveValue("");
  });

  it("never writes a draft into a configuration loaded after it began", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    const { nodeId } = renderDebug(<TextField path={["reference"]} id="reference" label="Reference" />);
    fireEvent.change(field("Reference"), { target: { value: "stale" } });
    act(() => openText(TEXT));
    spyWrites();
    expect(componentNamed("exporters.debug").id).toBe(nodeId);
    pause();
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
  });

  it("nothing writes on mount, render or focus", () => {
    const calls = spyWrites();
    renderDebug(
      <>
        <NumberField path={["sampling_initial"]} id="sampling-initial" label="Sampling Initial" />
        <DurationField path={["timeout"]} id="timeout" label="Timeout" />
        <SelectField path={["level"]} id="level" label="Level" options={[{ value: "a", label: "A" }]} />
        <CheckboxField path={["enabled"]} id="enabled" label="Enabled" defaultChecked={false} />
        <MultiValueField path={["keys"]} label="Keys" />
      </>,
    );
    for (const element of document.querySelectorAll<HTMLElement>("input, button, textarea")) {
      act(() => element.focus());
      fireEvent.blur(element);
    }
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
  });
});

describe("the other controls write at once", () => {
  it("a select writes the option picked, and nothing when it's the one shown", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    const options = [
      { value: "basic", label: "Basic" },
      { value: "detailed", label: "Detailed" },
    ];
    renderDebug(<SelectField path={["verbosity"]} id="verbosity" label="Verbosity" options={options} />);
    const before = text();

    await user.click(screen.getByRole("combobox", { name: "Verbosity" }));
    await user.click(screen.getByRole("option", { name: "Basic" }));
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("combobox", { name: "Verbosity" }));
    await user.click(screen.getByRole("option", { name: "Detailed" }));
    expect(calls).toEqual([[{ path: ["verbosity"], value: "detailed" }]]);
    expect(changedLines(before, text())).toEqual(["    verbosity: detailed # how much"]);
    expect(screen.getByRole("combobox", { name: "Verbosity" })).toHaveTextContent("Detailed");
  });

  it("a checkbox writes its new state, over the default too", async () => {
    const user = userEvent.setup();
    renderDebug(
      <>
        <CheckboxField path={["enabled"]} id="enabled" label="Enabled" defaultChecked={false} />
        <CheckboxField path={["unset_on"]} id="unset-on" label="Unset on" defaultChecked />
      </>,
    );
    const before = text();
    await user.click(screen.getByRole("checkbox", { name: "Enabled" }));
    expect(changedLines(before, text())).toEqual(["    enabled: false"]);
    expect(screen.getByRole("checkbox", { name: "Enabled" })).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Unset on" }));
    expect(debugValue().unset_on).toBe(false);
    expect(screen.getByRole("checkbox", { name: "Unset on" })).not.toBeChecked();
  });

  it("a list writes by item: a row's typing, Add and Remove", async () => {
    const user = userEvent.setup();
    renderDebug(
      <>
        <MultiValueField path={["keys"]} id="keys" label="Keys" placeholder="key" addButtonText="Add Key" helpText="Keys." />
        <MultiValueField path={["absent"]} label="Absent" addButtonText="Add Absent" />
      </>,
    );
    const rows = () => screen.getAllByPlaceholderText("key") as HTMLInputElement[];
    expect(rows().map((row) => row.value)).toEqual(["one", "two"]);

    fireEvent.change(rows()[0]!, { target: { value: "uno" } });
    fireEvent.blur(rows()[0]!);
    expect(text()).toContain("      - uno # first\n      - two\n");

    await user.click(screen.getByRole("button", { name: "Add Key" }));
    expect(debugValue().keys).toEqual(["uno", "two", ""]);

    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    expect(debugValue().keys).toEqual(["uno", ""]);

    await user.click(screen.getByRole("button", { name: "Add Absent" }));
    expect(debugValue().absent).toEqual([""]);
  });

  it("a move or an item's removal writes what fields hold first, onto their own items", () => {
    vi.useFakeTimers();
    let form: FormSource | undefined;
    renderDebug(<MultiValueField path={["keys"]} label="Keys" placeholder="key" />, (f) => (form = f));
    const rows = () => screen.getAllByPlaceholderText("key") as HTMLInputElement[];

    fireEvent.change(rows()[1]!, { target: { value: "held" } });
    act(() => void form!.move(["keys"], 1, 0));
    expect(debugValue().keys).toEqual(["held", "one"]);
    expect(text()).toContain("      - held\n      - one # first\n");

    fireEvent.change(rows()[0]!, { target: { value: "held again" } });
    act(() => void form!.remove(["keys", 1]));
    expect(debugValue().keys).toEqual(["held again"]);

    act(() => void form!.rename(["keys"], "names"));
    expect(debugValue().names).toEqual(["held again"]);
    act(() => void form!.apply([{ path: ["names", 0], value: "x" }]));
    expect(debugValue().names).toEqual(["x"]);
  });

  it("editing a merged key writes the component's own, leaving what it merges from", () => {
    vi.useFakeTimers();
    renderComponent("exporters.otlp", <DurationField path={["timeout"]} id="timeout" label="Timeout" />);
    fireEvent.change(field("Timeout"), { target: { value: "7s" } });
    fireEvent.blur(field("Timeout"));
    const config = parseYaml(text()) as { "x-defaults": { timeout: string }; exporters: { otlp: { timeout: string } } };
    expect(config.exporters.otlp.timeout).toBe("7s");
    expect(config["x-defaults"].timeout).toBe("5s");
    expect(field("Timeout")).toHaveValue("7s");
  });

  it("FormScope addresses paths under its own", () => {
    vi.useFakeTimers();
    renderComponent(
      "receivers.otlp",
      <FormScope path={["protocols", "grpc"]}>
        <TextField path={["endpoint"]} id="grpc-endpoint" label="Endpoint" />
      </FormScope>,
    );
    const before = text();
    expect(field("Endpoint")).toHaveValue("localhost:4317");
    fireEvent.change(field("Endpoint"), { target: { value: "0.0.0.0:4317" } });
    fireEvent.blur(field("Endpoint"));
    expect(changedLines(before, text())).toEqual(["        endpoint: 0.0.0.0:4317 # the endpoint"]);
  });
});

describe("a form that can't write", () => {
  it("is disabled while the canvas is locked", () => {
    renderDebug(
      <>
        <TextField path={["reference"]} id="reference" label="Reference" />
        <CheckboxField path={["enabled"]} id="enabled" label="Enabled" defaultChecked={false} />
        <SelectField path={["verbosity"]} id="verbosity" label="Verbosity" options={[{ value: "basic", label: "Basic" }]} />
        <MultiValueField path={["keys"]} label="Keys" addButtonText="Add Key" />
      </>,
    );
    act(() => builderStore().setText(`${TEXT}# typed\n`));
    expect(builderStore().isYamlEditing).toBe(true);
    expect(field("Reference")).toBeDisabled();
    expect(field("Reference")).toHaveValue("${env:X}");
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Verbosity" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Key" })).toBeDisabled();
  });

  it("is disabled for a component the text doesn't declare, and for a node that isn't there", () => {
    openText(TEXT);
    const undeclared = componentNamed("exporters.logging");
    expect(undeclared.data.declared).toBe(false);
    let form: FormSource | undefined;
    const { unmount } = render(
      <ComponentForm nodeId={undeclared.id} probe={(f) => (form = f)}>
        <TextField path={["endpoint"]} id="endpoint" label="Endpoint" />
      </ComponentForm>,
    );
    expect(field("Endpoint")).toBeDisabled();
    expect(form!.set(["endpoint"], "x")).toBe("refused");
    unmount();

    render(
      <ComponentForm nodeId="no-such-node" probe={(f) => (form = f)}>
        <TextField path={["endpoint"]} id="endpoint" label="Endpoint" />
      </ComponentForm>,
    );
    expect(field("Endpoint")).toBeDisabled();
    expect(form!.read(["endpoint"])).toEqual({ kind: "absent", value: undefined });
  });

  it("a field outside a FormProvider is a mistake", () => {
    function Orphan() {
      useForm();
      return null;
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow("A form field is outside a FormProvider.");
  });
});

describe("privacy", () => {
  it("no field puts a value into an attribute, and none sits inside a <form>", async () => {
    const user = userEvent.setup();
    const MARK = "MARKER";
    openText(
      TEXT.replace("backend:4317", `${MARK}-endpoint`)
        .replace("level: loud", `level: ${MARK}-level`)
        .replace("- one # first", `- ${MARK}-item # first`)
        .replace("timeout: 1m30s", `timeout: ${MARK}-timeout`)
        .replace("line one", `${MARK}-script`)
        .replace("exponent: 1e3", `exponent: ${MARK}-number`),
    );
    render(
      <>
        <ComponentForm nodeId={componentNamed("exporters.otlp").id}>
          <TextField path={["endpoint"]} id="endpoint" label="Endpoint" />
        </ComponentForm>
        <ComponentForm nodeId={componentNamed("exporters.debug").id}>
          <SelectField path={["level"]} id="level" label="Level" options={[{ value: "basic", label: "Basic" }]} />
          <MultiValueField path={["keys"]} label="Keys" />
          <DurationField path={["timeout"]} id="timeout" label="Timeout" />
          <TextareaField path={["script"]} id="script" label="Script" />
          <NumberField path={["exponent"]} id="exponent" label="Exponent" />
          <CheckboxField path={["enabled"]} id="enabled" label="Enabled" defaultChecked={false} />
        </ComponentForm>
      </>,
    );
    await user.type(field("Endpoint"), "$");
    expect(await screen.findByText("No matching variables")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Level" }));
    expect(screen.getByRole("option", { name: `${MARK}-level` })).toBeInTheDocument();

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      // A controlled field's value property is its content, not an attribute: the replay masks inputs.
      for (const attribute of element.attributes) {
        if (attribute.name === "value" && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) continue;
        if (attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });
});

const TELEMETRY = `receivers:
  otlp: {}
exporters:
  debug: {}
service:
  telemetry:
    metrics:
      level: detailed # how much
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: 0750
    logs:
      level: info
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;

function Dialog({ open, onDraft }: { open: boolean; onDraft: (draft: TelemetryDraft) => void }) {
  const draft = useTelemetryDraft(open);
  onDraft(draft);
  return (
    <FormProvider form={draft}>
      {open && (
        <>
          <TextField path={["logs", "level"]} id="logs-level" label="Logs level" />
          <NumberField path={["metrics", "readers", 0, "pull", "exporter", "prometheus", "port"]} id="port" label="Port" />
        </>
      )}
    </FormProvider>
  );
}

describe("the Self-monitoring dialog's draft", () => {
  function renderDialog(yamlContent = TELEMETRY, open = true) {
    openText(yamlContent);
    let draft: TelemetryDraft | undefined;
    const view = render(<Dialog open={open} onDraft={(d) => (draft = d)} />);
    return { draft: () => draft!, ...view };
  }

  it("reads the text when it opens, and writes into the draft, not the text; Apply's changes write the same", () => {
    vi.useFakeTimers();
    const { draft } = renderDialog();
    expect(field("Logs level")).toHaveValue("info");
    expect(field("Port")).toHaveValue("0750");
    expect(draft().changed).toBe(false);
    expect(draft().disabled).toBe(false);

    fireEvent.change(field("Logs level"), { target: { value: "debug" } });
    fireEvent.blur(field("Logs level"));
    fireEvent.change(field("Port"), { target: { value: "8888" } });
    pause();

    expect(field("Logs level")).toHaveValue("debug");
    expect(field("Port")).toHaveValue("8888");
    expect(text()).toBe(TELEMETRY);
    expect(draft().changed).toBe(true);
    expect(draft().changes).toEqual([
      { path: ["logs", "level"], value: "debug" },
      { path: ["metrics", "readers", 0, "pull", "exporter", "prometheus", "port"], plain: "8888" },
    ]);

    expect(builderStore().setTelemetryValues(draft().changes)).toBe(true);
    expect(changedLines(TELEMETRY, text())).toEqual(["                port: 8888", "      level: debug"]);
  });

  it("a draft that reads as the text again is unchanged, and Apply writes nothing", () => {
    vi.useFakeTimers();
    const { draft } = renderDialog();
    fireEvent.change(field("Logs level"), { target: { value: "debug" } });
    fireEvent.blur(field("Logs level"));
    fireEvent.change(field("Logs level"), { target: { value: "info" } });
    fireEvent.blur(field("Logs level"));
    expect(draft().changes).toHaveLength(2);
    expect(draft().changed).toBe(false);
    expect(draft().apply([])).toBe("unchanged");
    expect(draft().set(["logs", "level"], "info")).toBe("unchanged");
    expect(builderStore().setTelemetryValues(draft().changes)).toBe(false);
    expect(builderStore().history.past).toHaveLength(0);
  });

  it("is taken again each time it opens, and never while open", () => {
    vi.useFakeTimers();
    const { draft, rerender } = renderDialog();
    fireEvent.change(field("Logs level"), { target: { value: "debug" } });
    fireEvent.blur(field("Logs level"));
    act(() => void builderStore().setTelemetryValues([{ path: ["logs", "level"], value: "warn" }]));
    // Open: still the draft.
    expect(field("Logs level")).toHaveValue("debug");

    rerender(<Dialog open={false} onDraft={() => {}} />);
    let reopened: TelemetryDraft | undefined;
    rerender(<Dialog open onDraft={(d) => (reopened = d)} />);
    expect(field("Logs level")).toHaveValue("warn");
    expect(reopened!.changes).toEqual([]);
    expect(draft().changes).toHaveLength(1);
  });

  it("closed, keeps the draft until the body unmounts but takes no write; its latest changes are read through its ref", () => {
    const { draft, rerender } = renderDialog();
    act(() => void draft().set(["logs", "level"], "debug"));
    const open = draft();
    expect(open.latest()).toEqual({ changes: [{ path: ["logs", "level"], value: "debug" }], changed: true });

    let closed: TelemetryDraft | undefined;
    rerender(<Dialog open={false} onDraft={(d) => (closed = d)} />);
    expect(closed!.read(["logs", "level"])).toEqual({ kind: "scalar", value: "debug" });
    expect(closed!.set(["logs", "level"], "warn")).toBe("refused");
    expect(closed!.latest().changes).toHaveLength(1);
    expect(text()).toBe(TELEMETRY);
  });

  it("is read-only when service.telemetry isn't a mapping, and writable when it's unset or null", () => {
    const list = renderDialog(TELEMETRY.replace(/ {2}telemetry:\n[\s\S]*?(?= {2}pipelines:)/, "  telemetry: [a]\n"));
    expect(list.draft().disabled).toBe(true);
    expect(field("Logs level")).toBeDisabled();
    expect(list.draft().set(["logs", "level"], "x")).toBe("refused");
    list.unmount();

    const none = renderDialog(TELEMETRY.replace(/ {2}telemetry:\n[\s\S]*?(?= {2}pipelines:)/, "  telemetry:\n"));
    expect(none.draft().disabled).toBe(false);
    let result: ValuesResult | undefined;
    act(() => {
      result = none.draft().set(["logs", "level"], "debug");
    });
    expect(result).toBe("written");
    expect(field("Logs level")).toHaveValue("debug");
    none.unmount();

    const closed = renderDialog(TELEMETRY, false);
    expect(closed.draft().disabled).toBe(true);
    expect(closed.draft().read(["logs", "level"])).toEqual({ kind: "absent", value: undefined });
  });

  it("refuses a change the text edits can't write, with the can't-edit toast, and is read-only while locked", () => {
    const { draft } = renderDialog();
    expect(draft().apply([{ path: ["logs"], moveTo: 0 }])).toBe("refused");
    expect(toast.error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
    expect(draft().changes).toEqual([]);

    act(() => builderStore().setText(`${TELEMETRY}# typed\n`));
    expect(draft().disabled).toBe(true);
    expect(field("Logs level")).toBeDisabled();
  });
});
