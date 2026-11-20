import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  CheckboxField,
  CheckboxSetField,
  EscapedTextField,
  escapeText,
  FormProvider,
  MultiValueField,
  RadioField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  unescapeText,
  useComponentForm,
} from "./form-context.js";
import { OperatorPipeline } from "./operators/OperatorPipeline.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { hasHeldEdits } from "~/test/held-edits.js";

/*
 * The shared fields: what each shows of the text and what it writes, the
 * held rows, and privacy.
 */

const TEXT = `# The shared fields over a component's value.
receivers:
  filelog:
    priority: info
    start_at: beginning # from the start
    dmesg: true # kernel only
    units:
      - ssh # the daemon
      - sudo
    conditions:
      - Ready # the usual
      - CustomCondition
    empty_list: []
    two_characters: '\\n'
    newline: "\\n"
    crlf: "\\r\\n"
    bell: "a\\x07b"
    quoted: "x" # double-quoted
    odd_radio: somewhere
    map_radio: {a: 1}
    mixed:
      - Ready
      - {a: 1}
  filelog/unset: {}
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [filelog, filelog/unset]
      exporters: [debug]
`;

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
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const box = (name: string) => screen.getByRole("checkbox", { name });
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
const values = (key = "filelog") =>
  (parseYaml(text()) as { receivers: Record<string, Record<string, unknown>> }).receivers[key]!;

function pause(ms = FIELD_WRITE_DELAY_MS) {
  act(() => vi.advanceTimersByTime(ms));
}

describe("TextField's datalist", () => {
  it("offers fixed suggestions under a fixed id, and writes what is typed", () => {
    vi.useFakeTimers();
    const priorities = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];
    renderIn("receivers.filelog", <TextField path={["priority"]} id="priority" label="Priority" datalist={priorities} />);
    // An input with a list is a combobox to assistive technology.
    const priority = screen.getByRole("combobox", { name: "Priority" });
    expect(priority).toHaveAttribute("list", "priority-options");
    const list = document.getElementById("priority-options")!;
    expect(list.tagName).toBe("DATALIST");
    expect([...list.querySelectorAll("option")].map((option) => option.getAttribute("value"))).toEqual(priorities);

    fireEvent.change(priority, { target: { value: "warning" } });
    fireEvent.blur(priority);
    expect(text()).toBe(TEXT.replace("    priority: info\n", "    priority: warning\n"));
  });
});

describe("EscapedTextField", () => {
  it("shows a newline as \\n, and the two characters '\\n' as \\\\n; blurring either unchanged writes nothing", () => {
    const calls = spyWrites();
    renderIn(
      "receivers.filelog",
      <>
        <EscapedTextField path={["newline"]} id="newline" label="Newline" />
        <EscapedTextField path={["two_characters"]} id="two-characters" label="Two characters" />
        <EscapedTextField path={["missing"]} id="missing" label="Missing" defaultValue="\n" />
      </>,
    );
    expect(field("Newline")).toHaveValue("\\n");
    expect(field("Two characters")).toHaveValue("\\\\n");
    expect(field("Missing")).toHaveValue("");
    expect(field("Missing")).toHaveAttribute("placeholder", "\\n");
    for (const name of ["Newline", "Two characters", "Missing"]) {
      fireEvent.focus(field(name));
      fireEvent.blur(field(name));
    }
    expect(calls).toEqual([]);
  });

  it("typing \\n writes a newline, double-quoted; \\t a tab; \\\\ a backslash; any other backslash is itself", () => {
    vi.useFakeTimers();
    renderIn("receivers.filelog", <EscapedTextField path={["two_characters"]} id="combine-with" label="Combine With" />);
    // Single quotes can't hold a newline: the value is double-quoted from then on.
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["\\n", "\n", '"\\n"'],
      ["\\t", "\t", '"\\t"'],
      ["a\\\\b", "a\\b", '"a\\\\b"'],
      ["\\x", "\\x", '"\\\\x"'],
    ];
    for (const [typed, written, source] of cases) {
      fireEvent.change(field("Combine With"), { target: { value: typed } });
      fireEvent.blur(field("Combine With"));
      expect(values().two_characters).toBe(written);
      expect(text()).toContain(`    two_characters: ${source}\n    newline:`);
      expect(field("Combine With")).toHaveValue(escapeText(written));
    }
    expect(unescapeText(escapeText("a\\n\n\tb\\"))).toBe("a\\n\n\tb\\");
  });
});

describe("CheckboxField's uncheckedRemoves", () => {
  it("unticking removes the key, with its lines; ticking writes true", async () => {
    const user = userEvent.setup();
    renderIn(
      "receivers.filelog",
      <>
        <CheckboxField path={["dmesg"]} id="dmesg" label="Kernel Messages Only" defaultChecked={false} uncheckedRemoves />
        <CheckboxField path={["merge"]} id="merge" label="Merge Journals" defaultChecked={false} uncheckedRemoves />
      </>,
    );
    await user.click(box("Kernel Messages Only"));
    expect(text()).toBe(TEXT.replace("    dmesg: true # kernel only\n", ""));
    await user.click(box("Merge Journals"));
    expect(values().merge).toBe(true);
    await user.click(box("Merge Journals"));
    expect(values()).not.toHaveProperty("merge");
  });
});

const CONDITIONS = [
  { value: "Ready", label: "Ready" },
  { value: "MemoryPressure", label: "MemoryPressure" },
  { value: "DiskPressure", label: "DiskPressure" },
];

describe("CheckboxSetField", () => {
  it("ticks what the list holds, shows items outside its list after them, ticked, and the collector's default as the hint", () => {
    renderIn(
      "receivers.filelog",
      <CheckboxSetField path={["conditions"]} id="conditions" label="Node Conditions to Report" items={CONDITIONS} defaultHint="Ready" />,
    );
    expect(box("Ready")).toBeChecked();
    expect(box("MemoryPressure")).not.toBeChecked();
    expect(box("DiskPressure")).not.toBeChecked();
    expect(box("CustomCondition")).toBeChecked();
    expect([...document.querySelectorAll('[role="checkbox"]')].map((element) => element.id)).toEqual([
      "conditions-0",
      "conditions-1",
      "conditions-2",
      "conditions-3",
    ]);
    expect(screen.getByText("Ready", { selector: "span.font-mono" }).parentElement).toHaveTextContent("Default Ready");
  });

  it("ticking appends the item; unticking removes its lines; the last leaves [], or the key with emptyRemovesKey", async () => {
    const user = userEvent.setup();
    const { unmount } = renderIn(
      "receivers.filelog",
      <CheckboxSetField path={["conditions"]} id="conditions" label="Conditions" items={CONDITIONS} />,
    );
    await user.click(box("MemoryPressure"));
    expect(text()).toContain("      - Ready # the usual\n      - CustomCondition\n      - MemoryPressure\n    empty_list:");
    await user.click(box("CustomCondition"));
    expect(text()).toContain("      - Ready # the usual\n      - MemoryPressure\n    empty_list:");
    // An item no longer in the list and not a fixed one goes from the boxes.
    expect(screen.queryByRole("checkbox", { name: "CustomCondition" })).toBeNull();
    await user.click(box("Ready"));
    await user.click(box("MemoryPressure"));
    expect(text()).toContain("    conditions: []\n    empty_list:");
    unmount();

    renderIn(
      "receivers.filelog",
      <CheckboxSetField path={["conditions"]} id="conditions" label="Conditions" items={CONDITIONS} emptyRemovesKey />,
    );
    await user.click(box("Ready"));
    await user.click(box("CustomCondition"));
    expect(values()).not.toHaveProperty("conditions");
  });

  it("an empty [] takes its first item in block style", async () => {
    const user = userEvent.setup();
    renderIn("receivers.filelog", <CheckboxSetField path={["empty_list"]} id="empty" label="Empty" items={CONDITIONS} />);
    await user.click(box("DiskPressure"));
    expect(text()).toContain("    empty_list:\n      - DiskPressure\n    two_characters:");
  });

  it("unset shows unsetShows ticked, and the first toggle writes the list: unsetShows with the change, or the item alone", async () => {
    const user = userEvent.setup();
    const sources = [
      { value: "dns", label: "dns" },
      { value: "os", label: "os" },
      { value: "cname", label: "cname" },
    ];
    const { unmount } = renderIn(
      "receivers.filelog/unset",
      <CheckboxSetField path={["hostname_sources"]} id="sources" label="Hostname Sources" items={sources} unsetShows={["dns", "os"]} />,
    );
    expect(box("dns")).toBeChecked();
    expect(box("os")).toBeChecked();
    expect(box("cname")).not.toBeChecked();
    await user.click(box("cname"));
    expect(values("filelog/unset").hostname_sources).toEqual(["dns", "os", "cname"]);
    unmount();

    const again = renderIn(
      "receivers.filelog/unset",
      <CheckboxSetField path={["hostname_sources"]} id="sources" label="Hostname Sources" items={sources} unsetShows={["dns", "os"]} />,
    );
    await user.click(box("os"));
    expect(values("filelog/unset").hostname_sources).toEqual(["dns"]);
    again.unmount();

    renderIn("receivers.filelog/unset", <CheckboxSetField path={["conditions"]} id="c" label="Conditions" items={CONDITIONS} />);
    expect(box("Ready")).not.toBeChecked();
    await user.click(box("DiskPressure"));
    expect(text()).toContain("  filelog/unset:\n    conditions:\n      - DiskPressure\n");
  });

  it("a list that isn't plain scalars, or a value that isn't a list, is read-only with the hint", () => {
    renderIn(
      "receivers.filelog",
      <>
        <CheckboxSetField path={["mixed"]} id="mixed" label="Mixed" items={CONDITIONS} />
        <CheckboxSetField path={["map_radio"]} id="map" label="Map" items={CONDITIONS} />
      </>,
    );
    for (const element of screen.getAllByRole("checkbox")) expect(element).toBeDisabled();
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
  });
});

const START_AT = [
  { value: "end", label: "End" },
  { value: "beginning", label: "Beginning" },
];

describe("RadioField", () => {
  it("checks the value's radio and writes another at once, keeping the line's comment", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("receivers.filelog", <RadioField path={["start_at"]} id="start-at" label="Start At" defaultValue="end" options={START_AT} />);
    expect(radio("Beginning")).toBeChecked();
    expect(radio("End")).not.toBeChecked();
    expect(radio("End")).toHaveAttribute("name", "start-at");
    expect([radio("End").id, radio("Beginning").id]).toEqual(["start-at-0", "start-at-1"]);
    await user.click(radio("Beginning"));
    expect(calls).toEqual([]);
    await user.click(radio("End"));
    expect(calls).toEqual([[{ path: ["start_at"], value: "end" }]]);
    expect(text()).toBe(TEXT.replace("    start_at: beginning # from the start\n", "    start_at: end # from the start\n"));
    expect(radio("End")).toBeChecked();
  });

  it("unset shows the collector's default checked, or none where it has none", async () => {
    const user = userEvent.setup();
    renderIn(
      "receivers.filelog/unset",
      <>
        <RadioField path={["start_at"]} id="start-at" label="Start At" defaultValue="end" options={START_AT} />
        <RadioField
          path={["protocol"]}
          id="protocol"
          label="Protocol"
          options={[
            { value: "rfc3164", label: "RFC 3164 (BSD-syslog)" },
            { value: "rfc5424", label: "RFC 5424" },
          ]}
        />
      </>,
    );
    expect(radio("End")).toBeChecked();
    expect(screen.getByText("end", { selector: "span.font-mono" }).parentElement).toHaveTextContent("Default end");
    expect(radio("RFC 3164 (BSD-syslog)")).not.toBeChecked();
    expect(radio("RFC 5424")).not.toBeChecked();
    await user.click(radio("RFC 5424"));
    expect(values("filelog/unset").protocol).toBe("rfc5424");
  });

  it("onSelect overrides the write", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    const onSelect = vi.fn();
    renderIn(
      "receivers.filelog",
      <RadioField path={["start_at"]} id="start-at" label="Start At" options={START_AT} onSelect={onSelect} />,
    );
    await user.click(radio("End"));
    expect(onSelect).toHaveBeenCalledWith("end");
    expect(calls).toEqual([]);
  });

  it("a value outside the options checks none, adds no radio, and is read-only with the hint; so is a mapping", () => {
    renderIn(
      "receivers.filelog",
      <>
        <RadioField path={["odd_radio"]} id="odd" label="Odd" defaultValue="end" options={START_AT} />
        <RadioField path={["map_radio"]} id="map" label="Map" defaultValue="end" options={START_AT} />
      </>,
    );
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(4);
    for (const element of radios) {
      expect(element).not.toBeChecked();
      expect(element).toBeDisabled();
      expect(["end", "beginning"]).toContain(element.value);
    }
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
  });
});

describe("MultiValueField's addValue", () => {
  it("Add appends the seed", async () => {
    const user = userEvent.setup();
    renderIn(
      "receivers.filelog",
      <MultiValueField path={["units"]} label="Units" placeholder="e.g. ssh" addButtonText="Add unit" addValue="ssh" />,
    );
    await user.click(screen.getByRole("button", { name: "Add unit" }));
    expect(text()).toContain("      - ssh # the daemon\n      - sudo\n      - ssh\n    conditions:");
  });
});

describe("held empty rows", () => {
  const units = (addButtonText = "Add unit") => (
    <MultiValueField path={["units"]} label="Units" placeholder="e.g. ssh" addButtonText={addButtonText} holdEmpty />
  );
  const rows = () => screen.getAllByPlaceholderText("e.g. ssh") as HTMLInputElement[];

  it("Add shows a row that isn't in the text; its first typing appends the item, the row becoming the item's with focus kept", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderIn("receivers.filelog", units());
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    expect(rows()).toHaveLength(3);
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
    expect(hasHeldEdits()).toBe(false);

    const held = rows()[2]!;
    act(() => held.focus());
    fireEvent.change(held, { target: { value: "cron" } });
    expect(hasHeldEdits()).toBe(true);
    pause();
    expect(calls).toEqual([[{ path: ["units", 2], value: "cron" }]]);
    expect(text()).toContain("      - ssh # the daemon\n      - sudo\n      - cron\n    conditions:");
    // The same input, still focused: the held row became the item's row in place.
    expect(rows()).toHaveLength(3);
    expect(rows()[2]).toBe(held);
    expect(document.activeElement).toBe(held);

    // Typing on writes the item, not another.
    fireEvent.change(held, { target: { value: "crond" } });
    pause();
    expect(values().units).toEqual(["ssh", "sudo", "crond"]);
  });

  it("never writes an empty item: a held row left empty goes, and a row emptied is removed once it is left", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderIn("receivers.filelog", units());
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    fireEvent.focus(rows()[2]!);
    fireEvent.change(rows()[2]!, { target: { value: "x" } });
    fireEvent.change(rows()[2]!, { target: { value: "" } });
    pause(1000);
    fireEvent.blur(rows()[2]!);
    expect(calls).toEqual([]);
    expect(rows()).toHaveLength(2);

    // A written row emptied: nothing while it is being typed in, removed when left.
    fireEvent.change(rows()[1]!, { target: { value: "" } });
    pause(1000);
    expect(calls).toEqual([]);
    expect(rows()).toHaveLength(2);
    fireEvent.blur(rows()[1]!);
    expect(calls).toEqual([[{ path: ["units", 1], remove: true }]]);
    expect(text()).toContain("    units:\n      - ssh # the daemon\n    conditions:");
    expect(text()).not.toContain('""');
  });

  it("a held row's typing is written by Cmd/Ctrl+S, by the page's flush, and when the form goes", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    const { unmount } = renderIn("receivers.filelog", units());
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    fireEvent.change(rows()[2]!, { target: { value: "saved" } });
    fireEvent.keyDown(rows()[2]!, { key: "s", metaKey: true });
    expect(calls).toEqual([[{ path: ["units", 2], value: "saved" }]]);

    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    fireEvent.change(rows()[3]!, { target: { value: "flushed" } });
    act(() => flushHeldEdits());
    expect(values().units).toEqual(["ssh", "sudo", "saved", "flushed"]);

    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    fireEvent.change(rows()[4]!, { target: { value: "gone" } });
    unmount();
    expect(values().units).toEqual(["ssh", "sudo", "saved", "flushed", "gone"]);
  });

  it("a held row in an absent list, or an empty [], creates the list in block style; Remove drops it unwritten", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderIn(
      "receivers.filelog",
      <>
        <MultiValueField path={["namespaces"]} placeholder="e.g. default" addButtonText="Add Namespace" holdEmpty />
        <MultiValueField path={["empty_list"]} placeholder="e.g. empty" addButtonText="Add Empty" holdEmpty />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Namespace" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByPlaceholderText("e.g. default")).toBeNull();
    // The held row goes unwritten: nothing is sent (a row written as it was left is an item's row by then).
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
    expect(builderStore().history.past).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Add Namespace" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. default"), { target: { value: "default" } });
    fireEvent.blur(screen.getByPlaceholderText("e.g. default"));
    fireEvent.click(screen.getByRole("button", { name: "Add Empty" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. empty"), { target: { value: "one" } });
    fireEvent.keyDown(screen.getByPlaceholderText("e.g. empty"), { key: "Enter" });
    expect(text()).toContain("    empty_list:\n      - one\n");
    expect(text()).toContain("  filelog/unset: {}");
    expect(values().namespaces).toEqual(["default"]);
  });
});

describe("privacy", () => {
  it("no attribute holds a value: an extra checkbox item, an out-of-list radio value, an escaped text, a held row", () => {
    const MARK = "MARKER";
    openText(
      TEXT.replace("- CustomCondition", `- ${MARK}-condition`)
        .replace("odd_radio: somewhere", `odd_radio: ${MARK}-radio`)
        .replace("newline: \"\\n\"", `newline: "${MARK}\\n"`)
        .replace("priority: info", `priority: ${MARK}-priority`),
    );
    render(
      <ComponentForm nodeId={componentNamed("receivers.filelog").id}>
        <CheckboxSetField path={["conditions"]} id="conditions" label="Conditions" items={CONDITIONS} />
        <RadioField path={["odd_radio"]} id="odd" label="Odd" options={START_AT} />
        <EscapedTextField path={["newline"]} id="newline" label="Newline" />
        <TextField path={["priority"]} id="priority" label="Priority" datalist={["info"]} />
        <MultiValueField path={["units"]} label="Units" placeholder="e.g. ssh" addButtonText="Add unit" holdEmpty />
      </ComponentForm>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    fireEvent.change(screen.getAllByPlaceholderText("e.g. ssh")[2]!, { target: { value: `${MARK}-unit` } });
    expect(screen.getByText(`${MARK}-condition`)).toBeInTheDocument();

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      // A controlled field's value property is its content, not an attribute: the replay masks inputs.
      for (const attribute of element.attributes) {
        if (attribute.name === "value" && element instanceof HTMLInputElement && element.type !== "radio") continue;
        if (attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
  });
});

describe("control characters, and held rows when the length changes", () => {
  it("EscapedTextField shows a carriage return as \\r and writes it back; another control character is read-only", () => {
    vi.useFakeTimers();
    renderIn(
      "receivers.filelog",
      <>
        <EscapedTextField path={["crlf"]} id="crlf" label="CRLF" />
        <EscapedTextField path={["bell"]} id="bell" label="Bell" />
        <EscapedTextField path={["quoted"]} id="quoted" label="Quoted" />
      </>,
    );
    expect(field("CRLF")).toHaveValue("\\r\\n");
    fireEvent.change(field("CRLF"), { target: { value: "\\r\\nx" } });
    fireEvent.blur(field("CRLF"));
    expect(values().crlf).toBe("\r\nx");
    expect(text()).toContain('    crlf: "\\r\\nx"\n');
    expect(field("CRLF")).toHaveValue("\\r\\nx");

    expect(field("Bell")).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();

    // A double-quoted value stays double-quoted, its comment kept.
    fireEvent.change(field("Quoted"), { target: { value: "a\\nb" } });
    fireEvent.blur(field("Quoted"));
    expect(text()).toContain('    quoted: "a\\nb" # double-quoted\n');
  });

  it("a held row goes when the list's length changes elsewhere, and doesn't come back when it changes back", () => {
    renderIn("receivers.filelog", <MultiValueField path={["units"]} placeholder="e.g. ssh" addButtonText="Add unit" holdEmpty />);
    const rows = () => (screen.getAllByPlaceholderText("e.g. ssh") as HTMLInputElement[]).map((row) => row.value);
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    expect(rows()).toEqual(["ssh", "sudo", ""]);
    const nodeId = componentNamed("receivers.filelog").id;
    act(() => void builderStore().setComponentValues(nodeId, [{ path: ["units", 2], value: "cron" }]));
    expect(rows()).toEqual(["ssh", "sudo", "cron"]);
    act(() => void builderStore().setComponentValues(nodeId, [{ path: ["units", 2], remove: true }]));
    expect(rows()).toEqual(["ssh", "sudo"]);
  });
});

describe("strings the collector would read as another type are quoted", () => {
  it("a TextField typed 1_000 or 2024-01-01 writes a quoted string, not an integer or a time to yaml.v3", () => {
    vi.useFakeTimers();
    renderIn("receivers.filelog", <TextField path={["priority"]} id="priority" label="Priority" />);
    for (const typed of ["1_000", "2024-01-01", "-0x1F"]) {
      fireEvent.change(field("Priority"), { target: { value: typed } });
      fireEvent.blur(field("Priority"));
      expect(text()).toContain(`    priority: "${typed}"\n`);
      expect(values().priority).toBe(typed);
      expect(field("Priority")).toHaveValue(typed);
    }
  });

  it("add's Value typed 2024-01-01 or 0b101 writes a quoted string; 0750 stays plain", () => {
    vi.useFakeTimers();
    openText(TEXT.replace("    priority: info\n", '    operators:\n      - type: add\n        field: attributes.x\n        value: ""\n'));
    render(
      <ComponentForm nodeId={componentNamed("receivers.filelog").id}>
        <OperatorPipeline path={["operators"]} source="file" />
      </ComponentForm>,
    );
    const input = () => document.getElementById("op-0-add-value") as HTMLInputElement;
    const operator = () => (values().operators as Array<Record<string, unknown>>)[0]!;
    for (const [typed, written] of [
      ["2024-01-01", '"2024-01-01"'],
      ["0b101", '"0b101"'],
      ["0750", "0750"],
    ] as const) {
      fireEvent.change(input(), { target: { value: typed } });
      fireEvent.blur(input());
      expect(text()).toContain(`        value: ${written}\n`);
      expect(input()).toHaveValue(typed);
    }
    expect(operator().value).toBe(750);
  });

  it("add's Value typed as a flow collection holding such a string writes the collection, that string quoted, and shows it", () => {
    vi.useFakeTimers();
    openText(TEXT.replace("    priority: info\n", '    operators:\n      - type: add\n        field: attributes.x\n        value: ""\n'));
    render(
      <ComponentForm nodeId={componentNamed("receivers.filelog").id}>
        <OperatorPipeline path={["operators"]} source="file" />
      </ComponentForm>,
    );
    const input = () => document.getElementById("op-0-add-value") as HTMLInputElement;
    const operator = () => (values().operators as Array<Record<string, unknown>>)[0]!;
    fireEvent.change(input(), { target: { value: "[2024-01-01]" } });
    fireEvent.blur(input());
    expect(text()).toContain('        value: ["2024-01-01"]\n');
    expect(operator().value).toEqual(["2024-01-01"]);
    expect(input()).toHaveValue('["2024-01-01"]');
    expect(input()).toBeEnabled();
    fireEvent.change(input(), { target: { value: "{a: 1_000, b: 2}" } });
    fireEvent.blur(input());
    expect(text()).toContain('        value: {a: "1_000", b: 2}\n');
    expect(operator().value).toEqual({ a: "1_000", b: 2 });
  });
});
