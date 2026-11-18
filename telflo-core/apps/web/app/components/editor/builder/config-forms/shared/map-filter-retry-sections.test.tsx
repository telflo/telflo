import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, useComponentForm } from "../form-context.js";
import { IncludeExcludeSection } from "./IncludeExcludeSection.js";
import { KeyValueMapField, type KeyValueNouns } from "./KeyValueMapField.js";
import { StanzaRetrySection } from "./StanzaRetrySection.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { hasHeldEdits } from "~/test/held-edits.js";

/*
 * D9c's shared sections (D9c Task 1): KeyValueMapField's two layouts and its
 * held row (decision 9; Preflight rulings 4 and 8), IncludeExcludeSection
 * (decisions 3 and 9; Preflight ruling 5) and StanzaRetrySection (decision
 * 9), and privacy (decision 10). D9b's Headers tests, over the staging
 * layout, are in shared-sections.test.tsx, unchanged.
 */

const TEXT = `receivers:
  filelog:
    attributes:
      team: platform # who owns it
      tier: gold
    resource: {}
    matches:
      - _SYSTEMD_UNIT: ssh.service # the daemon
    retry_on_failure:
      initial_interval: 2s # longer
  filelog/unset: {}
  hostmetrics:
    scrapers:
      disk:
        include:
          devices: [sda] # the data disk
          match_type: strict
      network: {} # no filter yet
      process:
        include:
          names:
            - nginx
        exclude:
          names: [bash]
          match_type: regexp
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [filelog, filelog/unset]
      exporters: [debug]
    metrics:
      receivers: [hostmetrics]
      exporters: [debug]
`;

const ATTRIBUTE_NOUNS: KeyValueNouns = {
  key: "key",
  value: "value",
  addLabel: "Add Attribute",
  removeLabel: "Remove",
  exists: "An attribute with this key already exists.",
};

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
const receiver = (key: string) =>
  (parseYaml(text()) as { receivers: Record<string, Record<string, unknown>> }).receivers[key]!;
const scraper = (name: string) => (receiver("hostmetrics").scrapers as Record<string, Record<string, unknown>>)[name];

function pause(ms = FIELD_WRITE_DELAY_MS) {
  act(() => vi.advanceTimersByTime(ms));
}

describe("KeyValueMapField's rows layout (decision 9; Preflight rulings 4 and 8)", () => {
  const attributes = (path = ["attributes"], extra: { emptyRemovesKey?: boolean } = {}) => (
    <KeyValueMapField
      path={path}
      nouns={ATTRIBUTE_NOUNS}
      layout="rows"
      title="Log Attributes"
      emptyText="No log attributes configured"
      {...extra}
    />
  );
  const keys = () => screen.getAllByPlaceholderText("key") as HTMLInputElement[];
  const vals = () => screen.getAllByPlaceholderText("value") as HTMLInputElement[];

  it("shows its rows, label and empty state; Add shows a held row, written nowhere", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("receivers.filelog", attributes(["resource"]));
    expect(screen.getByText("Log Attributes")).toHaveClass("text-[13px]");
    expect(screen.getByText("No log attributes configured")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Attribute" }));
    expect(keys()).toHaveLength(1);
    expect(screen.queryByText("No log attributes configured")).toBeNull();
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
    expect(hasHeldEdits()).toBe(false);
  });

  it("a key then a value: the key is written on blur, with an empty value; then the value, after the pause", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderIn("receivers.filelog", attributes());
    fireEvent.click(screen.getByRole("button", { name: "Add Attribute" }));
    const [key, value] = [keys()[2]!, vals()[2]!];
    fireEvent.change(key, { target: { value: " region " } });
    pause(1000);
    expect(calls).toEqual([]);
    expect(hasHeldEdits()).toBe(true);
    fireEvent.blur(key);
    expect(calls).toEqual([[{ path: ["attributes", "region"], value: "" }]]);
    expect(text()).toContain('      tier: gold\n      region: ""\n    resource: {}\n');

    fireEvent.change(value, { target: { value: "eu" } });
    pause();
    expect(calls[1]).toEqual([{ path: ["attributes", "region"], value: "eu" }]);
    expect(receiver("filelog").attributes).toEqual({ team: "platform", tier: "gold", region: "eu" });
    // The held row became the key's row: the same inputs.
    expect(keys()[2]).toBe(key);
    expect(vals()[2]).toBe(value);
  });

  it("a value typed before the key stays in the row, isn't a held edit, and is written with the key; focus stays", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    renderIn("receivers.filelog", attributes());
    fireEvent.click(screen.getByRole("button", { name: "Add Attribute" }));
    const [key, value] = [keys()[2]!, vals()[2]!];
    fireEvent.change(value, { target: { value: "eu" } });
    pause(1000);
    expect(calls).toEqual([]);
    expect(hasHeldEdits()).toBe(false);
    // A save writes nothing: the row has no key.
    act(() => flushHeldEdits());
    expect(calls).toEqual([]);
    expect(value).toHaveValue("eu");

    act(() => key.focus());
    fireEvent.change(key, { target: { value: "region" } });
    fireEvent.keyDown(key, { key: "Enter" });
    expect(calls).toEqual([[{ path: ["attributes", "region"], value: "eu" }]]);
    expect(document.activeElement).toBe(key);
    expect(keys()[2]).toBe(key);
    expect(key).toHaveValue("region");
    expect(value).toHaveValue("eu");
  });

  it("a held row's key another row has is refused under it; a typed key is written by a save and when the form goes", () => {
    vi.useFakeTimers();
    const calls = spyWrites();
    const { unmount } = renderIn("receivers.filelog", attributes());
    fireEvent.click(screen.getByRole("button", { name: "Add Attribute" }));
    fireEvent.change(keys()[2]!, { target: { value: "team" } });
    fireEvent.blur(keys()[2]!);
    expect(calls).toEqual([]);
    expect(screen.getByText("An attribute with this key already exists.")).toHaveClass("text-fail");

    fireEvent.change(keys()[2]!, { target: { value: "saved" } });
    fireEvent.keyDown(keys()[2]!, { key: "s", ctrlKey: true });
    expect(calls).toEqual([[{ path: ["attributes", "saved"], value: "" }]]);

    fireEvent.click(screen.getByRole("button", { name: "Add Attribute" }));
    fireEvent.change(keys()[3]!, { target: { value: "gone" } });
    unmount();
    expect(Object.keys(receiver("filelog").attributes as object)).toEqual(["team", "tier", "saved", "gone"]);
  });

  it("renames a key in place, and removes the mapping with its last key, or leaves {} (journald's match)", async () => {
    const user = userEvent.setup();
    const { unmount } = renderIn("receivers.filelog", attributes());
    await user.clear(keys()[0]!);
    await user.type(keys()[0]!, "owner{Enter}");
    expect(text()).toContain("      owner: platform # who owns it\n");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(receiver("filelog")).not.toHaveProperty("attributes");
    unmount();

    renderIn(
      "receivers.filelog",
      <KeyValueMapField
        path={["matches", 0]}
        nouns={{ ...ATTRIBUTE_NOUNS, key: "_SYSTEMD_UNIT", value: "ssh.service", addLabel: "Add field", removeLabel: "Remove field" }}
        layout="rows"
        emptyRemovesKey={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove field" }));
    expect(text()).toContain("    matches:\n      - {} # the daemon\n");
  });
});

describe("KeyValueMapField's staging layout with other nouns (docker_stats' label maps)", () => {
  it("uses the form's nouns in D9b's markup", async () => {
    const user = userEvent.setup();
    renderIn(
      "receivers.filelog",
      <KeyValueMapField
        path={["attributes"]}
        nouns={{
          key: "Container label",
          value: "Metric label",
          addLabel: "Add label",
          removeLabel: "Remove label",
          exists: "A label with this name already exists.",
          newKey: "e.g. com.example.team",
          newValue: "e.g. team",
        }}
        layout="staging"
        title={null}
        description="Docker container label name → metric label key."
      />,
    );
    expect(screen.getAllByPlaceholderText("Container label")).toHaveLength(2);
    expect(screen.getByText("Press Enter to add.")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("e.g. com.example.team"), "team{Enter}");
    expect(screen.getByText("A label with this name already exists.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Remove label" })).toHaveLength(2);
  });
});

const FILTER = {
  title: "Device Filter",
  listKey: "devices",
  itemLabel: "Device",
  placeholder: "e.g. sda",
};

function renderFilter(scraperName: string, listKey = "devices") {
  return renderIn(
    "receivers.hostmetrics",
    <IncludeExcludeSection
      id="filter"
      {...FILTER}
      listKey={listKey}
      includePath={["scrapers", scraperName, "include"]}
      excludePath={["scrapers", scraperName, "exclude"]}
    />,
  );
}

const combos = () => screen.getAllByRole("combobox");
const rows = () => screen.queryAllByPlaceholderText("e.g. sda") as HTMLInputElement[];

async function pick(user: ReturnType<typeof userEvent.setup>, combo: HTMLElement, option: string) {
  await user.click(combo);
  await user.click(screen.getByRole("option", { name: option }));
}

describe("IncludeExcludeSection (decisions 3 and 9; Preflight ruling 5)", () => {
  it("with no filter, Include Only shows a held first row: nothing is written until something is typed", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderFilter("network");
    expect(combos()[0]).toHaveTextContent("No Filter");
    expect(rows()).toHaveLength(0);
    await pick(user, combos()[0]!, "Include Only");
    expect(combos()[0]).toHaveTextContent("Include Only");
    expect(combos()[1]).toHaveTextContent("Strict Match");
    expect(rows()).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(text()).toBe(TEXT);
  });

  it("the first include item is written with match_type: strict (the collector refuses a list without one)", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderFilter("network");
    await pick(user, combos()[0]!, "Include Only");
    await user.type(rows()[0]!, "eth0");
    await user.tab();
    expect(calls).toEqual([
      [
        { path: ["scrapers", "network", "include", "devices", 0], value: "eth0" },
        { path: ["scrapers", "network", "include", "match_type"], value: "strict" },
      ],
    ]);
    expect(scraper("network")).toEqual({ include: { devices: ["eth0"], match_type: "strict" } });
    expect(builderStore().history.past).toHaveLength(1);
    expect(combos()[0]).toHaveTextContent("Include Only");
  });

  // Its own time limit (D9c Rulings 54 and 80).
  it("the held first row becomes the item's row in place: typing on after the pause keeps focus and writes the same item", async () => {
    const user = userEvent.setup();
    // Radix's select needs real timers: the pause is waited for.
    const waitForPause = () => act(() => new Promise((resolve) => setTimeout(resolve, FIELD_WRITE_DELAY_MS + 50)));
    renderFilter("network");
    await pick(user, combos()[0]!, "Include Only");
    const first = rows()[0]!;
    act(() => first.focus());
    fireEvent.change(first, { target: { value: "eth" } });
    await waitForPause();
    expect(scraper("network")).toEqual({ include: { devices: ["eth"], match_type: "strict" } });
    expect(rows()[0]).toBe(first);
    expect(document.activeElement).toBe(first);
    fireEvent.change(first, { target: { value: "eth0" } });
    await waitForPause();
    expect(scraper("network")).toEqual({ include: { devices: ["eth0"], match_type: "strict" } });
  }, 20_000);

  it("a match chosen before the first item is written with it; later ones write their side's match_type", async () => {
    const user = userEvent.setup();
    renderFilter("network");
    await pick(user, combos()[0]!, "Exclude");
    await pick(user, combos()[1]!, "Regex Match");
    expect(text()).toBe(TEXT);
    await user.type(rows()[0]!, "lo{Enter}");
    expect(scraper("network")).toEqual({ exclude: { devices: ["lo"], match_type: "regexp" } });
    await pick(user, combos()[1]!, "Strict Match");
    expect(scraper("network")).toEqual({ exclude: { devices: ["lo"], match_type: "strict" } });
  });

  it("keeps the other side: picking Exclude beside an include list adds the exclude list, and both show", async () => {
    const user = userEvent.setup();
    renderFilter("disk");
    expect(rows().map((row) => row.value)).toEqual(["sda"]);
    await pick(user, combos()[0]!, "Exclude");
    expect(rows().map((row) => row.value)).toEqual(["sda", ""]);
    await user.type(rows()[1]!, "loop0");
    await user.tab();
    expect(scraper("disk")).toEqual({
      include: { devices: ["sda"], match_type: "strict" },
      exclude: { devices: ["loop0"], match_type: "strict" },
    });
    expect(text()).toContain("          devices: [sda] # the data disk\n          match_type: strict\n        exclude:\n");
    // The exclude list's own label, and the mode select reading the side last picked (Ruling 48).
    expect(screen.getAllByText("Exclude", { selector: "span" }).some((span) => span.classList.contains("w-[180px]"))).toBe(true);
    expect(combos()[0]).toHaveTextContent("Exclude");
  });

  it("both set: the include list with its Match select, then the exclude list with its own, each writing its own side", async () => {
    const user = userEvent.setup();
    renderFilter("process", "names");
    const names = () => screen.getAllByPlaceholderText("e.g. sda") as HTMLInputElement[];
    expect(names().map((row) => row.value)).toEqual(["nginx", "bash"]);
    // Include has no match_type: blank, the collector has no default; exclude's is regexp.
    expect(combos()).toHaveLength(3);
    expect(combos()[1]).toHaveTextContent("");
    expect(combos()[2]).toHaveTextContent("Regex Match");
    await pick(user, combos()[1]!, "Regex Match");
    expect(scraper("process")).toEqual({
      include: { names: ["nginx"], match_type: "regexp" },
      exclude: { names: ["bash"], match_type: "regexp" },
    });
    await pick(user, combos()[2]!, "Strict Match");
    expect((scraper("process")!.exclude as Record<string, unknown>).match_type).toBe("strict");
    expect((scraper("process")!.include as Record<string, unknown>).match_type).toBe("regexp");
  });

  it("No Filter removes both blocks, as one change", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderFilter("process", "names");
    await pick(user, combos()[0]!, "No Filter");
    expect(calls).toEqual([
      [
        { path: ["scrapers", "process", "include"], remove: true },
        { path: ["scrapers", "process", "exclude"], remove: true },
      ],
    ]);
    expect(scraper("process")).toEqual({});
    expect(builderStore().history.past).toHaveLength(1);
  });

  it("removing the last row removes its block; a row emptied and left does too; Add holds a row until typed", async () => {
    const user = userEvent.setup();
    const { unmount } = renderFilter("disk");
    await user.click(screen.getByRole("button", { name: "Add Device" }));
    expect(rows()).toHaveLength(2);
    expect(scraper("disk")).toEqual({ include: { devices: ["sda"], match_type: "strict" } });
    await user.type(rows()[1]!, "sdb");
    await user.tab();
    expect(scraper("disk")).toEqual({ include: { devices: ["sda", "sdb"], match_type: "strict" } });
    await user.click(screen.getAllByRole("button", { name: "Remove device" })[1]!);
    await user.click(screen.getByRole("button", { name: "Remove device" }));
    expect(scraper("disk")).toEqual({});
    expect(combos()[0]).toHaveTextContent("No Filter");
    unmount();

    renderFilter("disk");
    await user.clear(rows()[0]!);
    await user.tab();
    expect(scraper("disk")).toEqual({});
    expect(text()).not.toContain('""');
  });

  it("a held first row removed takes its side with it", async () => {
    const user = userEvent.setup();
    renderFilter("network");
    await pick(user, combos()[0]!, "Include Only");
    await user.click(screen.getByRole("button", { name: "Remove device" }));
    expect(combos()[0]).toHaveTextContent("No Filter");
    expect(rows()).toHaveLength(0);
    expect(text()).toBe(TEXT);
  });
});

describe("StanzaRetrySection (decision 9)", () => {
  it("unset is off; ticking writes enabled: true, adding the block; the intervals show their defaults as placeholders", async () => {
    const user = userEvent.setup();
    renderIn("receivers.filelog/unset", <StanzaRetrySection path={["retry_on_failure"]} />);
    expect(screen.getByRole("checkbox", { name: "Enable Retry" })).not.toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Initial Interval" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Enable Retry" }));
    expect(text()).toContain("  filelog/unset:\n    retry_on_failure:\n      enabled: true\n  hostmetrics:");
    for (const [name, placeholder] of [
      ["Initial Interval", "1s"],
      ["Max Interval", "30s"],
      ["Max Elapsed Time", "5m"],
    ] as const) {
      expect(screen.getByRole("textbox", { name })).toHaveValue("");
      expect(screen.getByRole("textbox", { name })).toHaveAttribute("placeholder", placeholder);
    }
    expect(screen.getByText(/^Wait before the first retry\./)).toBeInTheDocument();
  });

  it("a block without enabled is off; ticking and unticking write enabled into it, keeping its keys; never a multiplier", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn("receivers.filelog", <StanzaRetrySection path={["retry_on_failure"]} />);
    expect(screen.getByRole("checkbox", { name: "Enable Retry" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Enable Retry" }));
    expect(text()).toContain("    retry_on_failure:\n      initial_interval: 2s # longer\n      enabled: true\n");
    expect(screen.getByRole("textbox", { name: "Initial Interval" })).toHaveValue("2s");
    await user.clear(screen.getByRole("textbox", { name: "Max Elapsed Time" }));
    await user.type(screen.getByRole("textbox", { name: "Max Elapsed Time" }), "10m");
    await user.tab();
    await user.click(screen.getByRole("checkbox", { name: "Enable Retry" }));
    expect(text()).toContain(
      "    retry_on_failure:\n      initial_interval: 2s # longer\n      enabled: false\n      max_elapsed_time: 10m\n",
    );
    expect(text()).not.toContain("multiplier");
    expect(calls.flat().map((change) => change.path.join("."))).toEqual([
      "retry_on_failure.enabled",
      "retry_on_failure.max_elapsed_time",
      "retry_on_failure.enabled",
    ]);
  });
});

describe("privacy (decision 10)", () => {
  it("no attribute in the sections holds a value, and none sits inside a <form>", async () => {
    const user = userEvent.setup();
    const MARK = "MARKER";
    openText(
      TEXT.replace("team: platform", `${MARK}-key: ${MARK}-value`)
        .replace("devices: [sda]", `devices: [${MARK}-device]`)
        .replace("match_type: regexp", `match_type: ${MARK}-match`)
        .replace("initial_interval: 2s", `initial_interval: \${env:${MARK}}`),
    );
    render(
      <>
        <ComponentForm nodeId={componentNamed("receivers.filelog").id}>
          <KeyValueMapField path={["attributes"]} nouns={ATTRIBUTE_NOUNS} layout="rows" title="Log Attributes" />
          <StanzaRetrySection path={["retry_on_failure"]} />
        </ComponentForm>
        <ComponentForm nodeId={componentNamed("receivers.hostmetrics").id}>
          <IncludeExcludeSection
            id="disk"
            {...FILTER}
            includePath={["scrapers", "disk", "include"]}
            excludePath={["scrapers", "disk", "exclude"]}
          />
          <IncludeExcludeSection
            id="process"
            {...FILTER}
            listKey="names"
            includePath={["scrapers", "process", "include"]}
            excludePath={["scrapers", "process", "exclude"]}
          />
        </ComponentForm>
      </>,
    );
    await user.click(screen.getByRole("checkbox", { name: "Enable Retry" }));
    await user.click(screen.getByRole("button", { name: "Add Attribute" }));
    // The out-of-list match (the process filter's exclude side) shows as an extra option, as text.
    const process = combos()[4]!;
    await user.click(process);
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: `${MARK}-match` })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (attribute.name === "value" && element instanceof HTMLInputElement) continue;
        if (attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });
});

describe("the review's fixes (D9c Task 1)", () => {
  const NOUNS = ATTRIBUTE_NOUNS;

  it("a value typed in the held row before its key, and its clash, stay when a row above it is removed", () => {
    renderIn("receivers.filelog", <KeyValueMapField path={["attributes"]} nouns={NOUNS} layout="rows" />);
    const keys = () => screen.getAllByPlaceholderText("key") as HTMLInputElement[];
    const vals = () => screen.getAllByPlaceholderText("value") as HTMLInputElement[];
    fireEvent.click(screen.getByRole("button", { name: "Add Attribute" }));
    fireEvent.change(vals()[2]!, { target: { value: "eu" } });
    fireEvent.change(keys()[2]!, { target: { value: "tier" } });
    fireEvent.blur(keys()[2]!);
    expect(screen.getByText(NOUNS.exists)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(vals().map((input) => input.value)).toEqual(["gold", "eu"]);
    expect(screen.getByText(NOUNS.exists)).toBeInTheDocument();

    fireEvent.change(keys()[1]!, { target: { value: "region" } });
    expect(screen.queryByText(NOUNS.exists)).toBeNull();
    fireEvent.blur(keys()[1]!);
    expect(receiver("filelog").attributes).toEqual({ tier: "gold", region: "eu" });
  });

  it("a side picked is the form's only until it has items: filled elsewhere and emptied, it isn't shown as picked", async () => {
    const user = userEvent.setup();
    renderFilter("network");
    await pick(user, combos()[0]!, "Include Only");
    expect(rows()).toHaveLength(1);
    const nodeId = componentNamed("receivers.hostmetrics").id;
    act(
      () =>
        void builderStore().setComponentValues(nodeId, [
          { path: ["scrapers", "network", "include"], value: { devices: ["eth1"], match_type: "strict" } },
        ]),
    );
    expect(rows().map((row) => row.value)).toEqual(["eth1"]);
    await user.click(screen.getByRole("button", { name: "Remove device" }));
    expect(scraper("network")).toEqual({});
    expect(combos()[0]).toHaveTextContent("No Filter");
    expect(rows()).toHaveLength(0);
  });

  it("a held row added to a filter list goes when the list's length changes elsewhere", () => {
    renderFilter("disk");
    fireEvent.click(screen.getByRole("button", { name: "Add Device" }));
    expect(rows().map((row) => row.value)).toEqual(["sda", ""]);
    const nodeId = componentNamed("receivers.hostmetrics").id;
    act(() => void builderStore().setComponentValues(nodeId, [{ path: ["scrapers", "disk", "include", "devices", 1], value: "sdb" }]));
    act(() => void builderStore().setComponentValues(nodeId, [{ path: ["scrapers", "disk", "include", "devices", 1], remove: true }]));
    expect(rows().map((row) => row.value)).toEqual(["sda"]);
  });
});
