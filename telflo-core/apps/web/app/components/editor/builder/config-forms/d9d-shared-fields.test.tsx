import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  CheckboxField,
  CheckboxSetField,
  FormProvider,
  FormScope,
  MultiValueField,
  NumberField,
  SelectField,
  TextField,
  UNSET_OPTION,
  UNSHOWABLE_VALUE_MESSAGE,
  useComponentForm,
  useForm,
  WRITTEN_OPTION,
} from "./form-context.js";
import { NativeSelectField } from "./shared/NativeSelectField.js";
import { StringListField } from "./shared/StringListField.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The shared fields in `form-context.tsx` and the promoted native select:
 * the pruning scope, SelectField's unset option, NativeSelectField,
 * CheckboxField's checkedRemoves, CheckboxSetField's `""` item,
 * NumberField's writeSame, numeric list rows, StringListField's extra
 * writes, and privacy.
 */

const TEXT = `# The shared fields.
exporters:
  file:
    path: /var/log/out.json
    rotation:
      max_megabytes: 100 # keep it small
    empty_rotation: {}
    kept:
      max_days: 3
      unshown: yes # no field shows this
    outer:
      inner:
        leaf: 1
    level: detailed # how much
    odd: __unset__
    off_list: sometimes
    socket_permissions: "0622" # quoted
    plain_mode: 0750
    compression:
      - gzip
      - ""
    nulls:
      - gzip
      - ~
    ports:
      - 4317
    filters:
      services:
        - api
    expect_type: false
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
const values = (key = "file") => (parseYaml(text()) as { exporters: Record<string, Record<string, unknown>> }).exporters[key]!;

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

async function pick(user: UserEvent, name: string, option: string) {
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(screen.getByRole("option", { name: option }));
}

describe("the pruning scope", () => {
  it("clearing the block's last key removes the block in the same write", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <FormScope path={["rotation"]} prune>
        <NumberField path={["max_megabytes"]} id="max-megabytes" label="Max Megabytes" />
      </FormScope>,
    );
    await retypeInto(user, field("Max Megabytes"), "");
    expect(calls).toEqual([[{ path: ["rotation"], remove: true }]]);
    expect(text()).toBe(TEXT.replace("    rotation:\n      max_megabytes: 100 # keep it small\n", ""));
    expect(builderStore().history.past).toHaveLength(1);
  });

  it("keeps a block holding a key no field shows: only the cleared key goes", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <FormScope path={["kept"]} prune>
        <NumberField path={["max_days"]} id="max-days" label="Max Days" />
      </FormScope>,
    );
    await retypeInto(user, field("Max Days"), "");
    expect(calls).toEqual([[{ path: ["kept", "max_days"], remove: true }]]);
    expect(text()).toBe(TEXT.replace("      max_days: 3\n", ""));
  });

  it("nested scopes prune each level: the outermost emptied block's removal is the one change", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <FormScope path={["outer"]} prune>
        <FormScope path={["inner"]} prune>
          <NumberField path={["leaf"]} id="leaf" label="Leaf" />
        </FormScope>
      </FormScope>,
    );
    await retypeInto(user, field("Leaf"), "");
    expect(calls).toEqual([[{ path: ["outer"], remove: true }]]);
    expect(values()).not.toHaveProperty("outer");
  });

  it("a block the text had empty stays until a key typed into it is cleared; then it goes", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <FormScope path={["empty_rotation"]} prune>
        <NumberField path={["max_backups"]} id="max-backups" label="Max Backups" />
      </FormScope>,
    );
    // Focusing and leaving writes nothing, so the empty block stays.
    await user.click(field("Max Backups"));
    await user.tab();
    expect(calls).toEqual([]);
    await retypeInto(user, field("Max Backups"), "5");
    expect(values().empty_rotation).toEqual({ max_backups: 5 });
    await retypeInto(user, field("Max Backups"), "");
    expect(calls[1]).toEqual([{ path: ["empty_rotation"], remove: true }]);
    expect(values()).not.toHaveProperty("empty_rotation");
  });

  it("a set beside the removal keeps the block", async () => {
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <FormScope path={["rotation"]} prune>
        <SetAndClear />
      </FormScope>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    expect(calls).toEqual([
      [
        { path: ["rotation", "max_megabytes"], remove: true },
        { path: ["rotation", "max_days"], plain: "2" },
      ],
    ]);
    expect(values().rotation).toEqual({ max_days: 2 });
  });
});

function SetAndClear() {
  const form = useForm();
  return (
    <button
      type="button"
      onClick={() =>
        form.apply([
          { path: ["max_megabytes"], remove: true },
          { path: ["max_days"], plain: "2" },
        ])
      }
    >
      Swap
    </button>
  );
}

describe("SelectField's unset option", () => {
  const LEVELS = [
    { value: "basic", label: "Basic" },
    { value: "detailed", label: "Detailed" },
  ];

  it("is listed first and shown while the key is unset; choosing it removes the key; its token is never written", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <>
        <SelectField path={["level"]} id="level" label="Level" options={LEVELS} unsetOption={{ label: "Unset" }} />
        <SelectField path={["other"]} id="other" label="Other" options={LEVELS} unsetOption={{ label: "Inherited" }} />
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Other" })).toHaveTextContent("Inherited");
    await user.click(screen.getByRole("combobox", { name: "Level" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Unset", "Basic", "Detailed"]);
    await user.click(screen.getByRole("option", { name: "Unset" }));
    expect(calls).toEqual([[{ path: ["level"], remove: true }]]);
    expect(text()).toBe(TEXT.replace("    level: detailed # how much\n", ""));
    expect(screen.getByRole("combobox", { name: "Level" })).toHaveTextContent("Unset");

    // Choosing it while unset writes nothing.
    await pick(user, "Level", "Unset");
    expect(calls).toHaveLength(1);
    await pick(user, "Level", "Basic");
    expect(calls[1]).toEqual([{ path: ["level"], value: "basic" }]);
    // The token is only where the text had it.
    expect(text().split(UNSET_OPTION)).toHaveLength(2);
  });

  it("a text value equal to the token shows as an extra option, as written, not as unset", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("exporters.file", <SelectField path={["odd"]} id="odd" label="Odd" options={LEVELS} unsetOption={{ label: "Unset" }} />);
    expect(screen.getByRole("combobox", { name: "Odd" })).toHaveTextContent(UNSET_OPTION);
    await user.click(screen.getByRole("combobox", { name: "Odd" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Unset", "Basic", "Detailed", UNSET_OPTION]);
    // Unset is another option here: choosing it removes the key.
    await user.click(screen.getByRole("option", { name: "Unset" }));
    expect(calls).toEqual([[{ path: ["odd"], remove: true }]]);
  });

  it("onUnset replaces the removal", async () => {
    const user = userEvent.setup();
    const onUnset = vi.fn();
    renderIn(
      "exporters.file",
      <SelectField path={["level"]} id="level" label="Level" options={LEVELS} unsetOption={{ label: "Unset" }} onUnset={onUnset} />,
    );
    await pick(user, "Level", "Unset");
    expect(onUnset).toHaveBeenCalledTimes(1);
    expect(text()).toBe(TEXT);
  });
});

describe("SelectField's disabled options and ignoreCase", () => {
  const LEVELS = [
    { value: "basic", label: "Basic" },
    { value: "detailed", label: "Detailed", disabled: true },
  ];

  it("a disabled option is listed but can't be chosen; a text holding it still shows it", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <>
        <SelectField path={["level"]} id="level" label="Level" options={LEVELS} />
        <SelectField path={["other"]} id="other" label="Other" options={LEVELS} />
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Level" })).toHaveTextContent("Detailed");
    await user.click(screen.getByRole("combobox", { name: "Other" }));
    expect(screen.getByRole("option", { name: "Detailed" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Basic" })).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByRole("option", { name: "Detailed" }));
    expect(calls).toEqual([]);
    // The list stays open: a disabled option isn't a choice.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await pick(user, "Other", "Basic");
    expect(calls).toEqual([[{ path: ["other"], value: "basic" }]]);
  });

  it("with ignoreCase, a value in another case shows as its option and isn't an extra one; choosing another writes the option's value", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <SelectField path={["level"]} id="level" label="Level" options={[{ value: "DETAILED", label: "All" }, { value: "basic", label: "Basic" }]} ignoreCase />,
    );
    expect(screen.getByRole("combobox", { name: "Level" })).toHaveTextContent("All");
    await user.click(screen.getByRole("combobox", { name: "Level" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["All", "Basic"]);
    await user.click(screen.getByRole("option", { name: "All" }));
    expect(calls).toEqual([]);
    await pick(user, "Level", "Basic");
    expect(calls).toEqual([[{ path: ["level"], value: "basic" }]]);
  });

  it("without ignoreCase, a value in another case is an extra option, as written", async () => {
    const user = userEvent.setup();
    renderIn("exporters.file", <SelectField path={["level"]} id="level" label="Level" options={[{ value: "DETAILED", label: "All" }]} />);
    expect(screen.getByRole("combobox", { name: "Level" })).toHaveTextContent("detailed");
    await user.click(screen.getByRole("combobox", { name: "Level" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["All", "detailed"]);
  });
});

describe("NativeSelectField", () => {
  const OPTIONS = [
    { value: "always", label: "Always" },
    { value: "never", label: "Never" },
  ];
  const select = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
  const optionValues = (name: string) => [...select(name).options].map((option) => option.value);

  it("shows a value outside its options as written, under the fixed token; choosing that writes nothing", () => {
    const calls = spyWrites();
    renderIn("exporters.file", <NativeSelectField path={["off_list"]} id="off-list" label="Off List" options={OPTIONS} unset="always" />);
    expect(select("Off List").value).toBe(WRITTEN_OPTION);
    expect(optionValues("Off List")).toEqual(["always", "never", WRITTEN_OPTION]);
    expect(screen.getByRole("option", { name: "sometimes" })).toBeInTheDocument();
    fireEvent.change(select("Off List"), { target: { value: WRITTEN_OPTION } });
    expect(calls).toEqual([]);
    fireEvent.change(select("Off List"), { target: { value: "never" } });
    expect(calls).toEqual([[{ path: ["off_list"], value: "never" }]]);
  });

  it("an unset option is listed first while unset, and choosing it removes the key; without `unset`, a blank one", () => {
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <>
        <NativeSelectField path={["off_list"]} id="mode" label="Mode" options={OPTIONS} unsetOption={{ label: "Inherited" }} />
        <NativeSelectField path={["missing"]} id="missing" label="Missing" options={OPTIONS} />
      </>,
    );
    expect(optionValues("Mode")).toEqual([UNSET_OPTION, "always", "never", WRITTEN_OPTION]);
    expect(select("Missing").value).toBe(UNSET_OPTION);
    expect(select("Missing").options[0]!.textContent).toBe("");
    fireEvent.change(select("Mode"), { target: { value: UNSET_OPTION } });
    expect(calls).toEqual([[{ path: ["off_list"], remove: true }]]);
    expect(select("Mode").value).toBe(UNSET_OPTION);
    // Unset already: nothing.
    fireEvent.change(select("Missing"), { target: { value: UNSET_OPTION } });
    expect(calls).toHaveLength(1);
  });

  it("a text value equal to the unset token is an off-list value; onSelect replaces the write", () => {
    const onSelect = vi.fn();
    renderIn(
      "exporters.file",
      <NativeSelectField path={["odd"]} id="odd" label="Odd" options={OPTIONS} unsetOption={{ label: "Unset" }} onSelect={onSelect} />,
    );
    expect(select("Odd").value).toBe(WRITTEN_OPTION);
    expect(screen.getByRole("option", { name: UNSET_OPTION })).toHaveAttribute("value", WRITTEN_OPTION);
    fireEvent.change(select("Odd"), { target: { value: "never" } });
    expect(onSelect).toHaveBeenCalledWith("never");
    expect(text()).toBe(TEXT);
    // The unset option is another option here: choosing it removes the key.
    fireEvent.change(select("Odd"), { target: { value: UNSET_OPTION } });
    expect(values()).not.toHaveProperty("odd");
  });

  it("a mapping is read-only with the hint", () => {
    renderIn("exporters.file", <NativeSelectField path={["rotation"]} id="rotation" label="Rotation" options={OPTIONS} unset="always" />);
    expect(select("Rotation")).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });
});

describe("CheckboxField's checkedRemoves", () => {
  it("ticking removes the key (the default is true); unticking writes false", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <>
        <CheckboxField path={["expect_type"]} id="expect" label="Expect Type" defaultChecked checkedRemoves />
        <CheckboxField path={["other_box"]} id="other" label="Other Box" defaultChecked checkedRemoves />
      </>,
    );
    expect(box("Expect Type")).not.toBeChecked();
    expect(box("Other Box")).toBeChecked();
    await user.click(box("Expect Type"));
    expect(calls).toEqual([[{ path: ["expect_type"], remove: true }]]);
    expect(box("Expect Type")).toBeChecked();
    await user.click(box("Other Box"));
    expect(calls[1]).toEqual([{ path: ["other_box"], value: false }]);
    expect(values().other_box).toBe(false);
  });
});

describe("CheckboxSetField's empty item", () => {
  const ALGORITHMS = [
    { value: "gzip", label: "gzip" },
    { value: "zstd", label: "zstd" },
    { value: "", label: "none (uncompressed)" },
  ];

  it("a list holding \"\" stays showable with \"\" ticked; ticking it appends \"\", unticking removes it", async () => {
    const user = userEvent.setup();
    renderIn("exporters.file", <CheckboxSetField path={["compression"]} id="compression" label="Compression" items={ALGORITHMS} />);
    expect(box("gzip")).toBeChecked();
    expect(box("none (uncompressed)")).toBeChecked();
    expect(box("zstd")).not.toBeChecked();
    expect(screen.queryByText(UNSHOWABLE_VALUE_MESSAGE)).toBeNull();
    await user.click(box("none (uncompressed)"));
    expect(values().compression).toEqual(["gzip"]);
    await user.click(box("none (uncompressed)"));
    expect(values().compression).toEqual(["gzip", ""]);
    expect(text()).toContain('      - gzip\n      - ""\n');
  });

  it("without a \"\" item, a list holding \"\" is read-only, as before; a null item always is", () => {
    renderIn(
      "exporters.file",
      <>
        <CheckboxSetField path={["compression"]} id="without" label="Without" items={ALGORITHMS.slice(0, 2)} />
        <CheckboxSetField path={["nulls"]} id="nulls" label="Nulls" items={ALGORITHMS} />
      </>,
    );
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
  });
});

describe("NumberField's writeSame", () => {
  it("retyping a quoted number writes it plain, a splice keeping the comment; without it, nothing", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <>
        <NumberField path={["socket_permissions"]} id="socket" label="Socket Permissions" writeSame />
        <NumberField path={["plain_mode"]} id="plain" label="Plain Mode" />
      </>,
    );
    expect(field("Socket Permissions")).toHaveValue("0622");
    // Focusing and leaving writes nothing: only typing makes a draft.
    await user.click(field("Socket Permissions"));
    await user.tab();
    expect(calls).toEqual([]);
    await retypeInto(user, field("Socket Permissions"), "0622");
    expect(calls).toEqual([[{ path: ["socket_permissions"], plain: "0622" }]]);
    expect(text()).toBe(TEXT.replace('socket_permissions: "0622" # quoted', "socket_permissions: 0622 # quoted"));

    await retypeInto(user, field("Plain Mode"), "0750");
    expect(calls).toHaveLength(1);
  });
});

describe("MultiValueField's numeric rows", () => {
  it("a row typed as a number is written plain as typed; a reference as a string; held rows too", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <MultiValueField path={["ports"]} placeholder="4317" addButtonText="Add Port" holdEmpty numeric removeLabel="Remove port" />,
    );
    const rows = () => screen.getAllByPlaceholderText("4317") as HTMLInputElement[];
    expect(rows()[0]).toHaveAttribute("inputmode", "decimal");
    fireEvent.change(rows()[0]!, { target: { value: "0x10E1" } });
    act(() => vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS));
    fireEvent.click(screen.getByRole("button", { name: "Add Port" }));
    fireEvent.change(rows()[1]!, { target: { value: "${env:PORT}" } });
    fireEvent.blur(rows()[1]!);
    expect(calls).toEqual([[{ path: ["ports", 0], plain: "0x10E1" }], [{ path: ["ports", 1], value: "${env:PORT}" }]]);
    expect(text()).toContain("    ports:\n      - 0x10E1\n      - ${env:PORT}\n");
  });
});

describe("StringListField's extra writes", () => {
  it("alsoOnAppend's changes go in the append's write; onEmptied's replace the last removal", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.file",
      <FormScope path={["filters"]}>
        <StringListField
          path={["services"]}
          label="Services"
          placeholder="e.g. api"
          alsoOnAppend={() => [{ path: ["match_type"], value: "strict" }]}
          onEmptied={() => [{ path: [], remove: true }]}
        />
      </FormScope>,
    );
    await user.type(screen.getByPlaceholderText("e.g. api"), "web{Enter}");
    expect(calls).toEqual([
      [
        { path: ["filters", "services", 1], value: "web" },
        { path: ["filters", "match_type"], value: "strict" },
      ],
    ]);
    expect(values().filters).toEqual({ services: ["api", "web"], match_type: "strict" });
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    expect(calls[1]).toEqual([{ path: ["filters", "services", 1], remove: true }]);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(calls[2]).toEqual([{ path: ["filters"], remove: true }]);
    expect(values()).not.toHaveProperty("filters");
  });
});

describe("privacy", () => {
  it("no attribute holds a value: an off-list native select, an unset-token text, a numeric row, a pruned scope's field", () => {
    const MARK = "MARKER";
    openText(
      TEXT.replace("off_list: sometimes", `off_list: ${MARK}-select`)
        .replace("odd: __unset__", `odd: ${MARK}-odd`)
        .replace("      - 4317", `      - ${MARK}-port`)
        .replace("max_megabytes: 100", `max_megabytes: ${MARK}-mb`),
    );
    render(
      <ComponentForm nodeId={componentNamed("exporters.file").id}>
        <NativeSelectField path={["off_list"]} id="off-list" label="Off List" options={[{ value: "a", label: "A" }]} unsetOption={{ label: "Unset" }} />
        <SelectField path={["odd"]} id="odd" label="Odd" options={[{ value: "a", label: "A" }]} unsetOption={{ label: "Unset" }} />
        <MultiValueField path={["ports"]} placeholder="4317" numeric holdEmpty />
        <FormScope path={["rotation"]} prune>
          <TextField path={["max_megabytes"]} id="mb" label="MB" />
        </FormScope>
      </ComponentForm>,
    );
    expect(screen.getByText(`${MARK}-select`)).toBeInTheDocument();
    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        // A controlled text field's value property is its content, not an attribute: the replay masks inputs.
        if (attribute.name === "value" && element instanceof HTMLInputElement) continue;
        if (attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
  });
});
