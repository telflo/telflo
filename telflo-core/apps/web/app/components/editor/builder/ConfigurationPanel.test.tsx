import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  ANCHOR_CLASH_MESSAGE,
  BOX_WRITE_DELAY_MS,
  ConfigurationPanel,
  FALLBACK_BOX_HINT,
  FORM_BOX_HINT,
  RAW_YAML_UNREADABLE_MESSAGE,
  UNDECLARED_COMPONENT_MESSAGE,
} from "./ConfigurationPanel.js";
import { formFor } from "./config-forms/registry.js";
import { useUndoRedo } from "~/hooks/useUndoRedo.js";
import { CORPUS, corpusText } from "~/lib/graph/corpus/corpus.js";
import { isSaveShortcut } from "~/lib/editor/unsaved-guard.js";
import { isGroup } from "~/lib/graph/canvas-operations.js";
import type { ComponentType } from "~/lib/graph/types.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { BUILDER_VERSION_ID, builderStore, componentNamed, groupNamed, openText } from "~/test/builder-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";
import { componentPalette } from "~/lib/graph/palette.js";

const STARTER = corpusText("starter.yaml");
const COMMENTS = corpusText("comments.yaml");
/*
 * The fallback layout's cases use `count`, a type outside the palette (the
 * collector's count is a connector; here, as a receiver, processor or
 * exporter, it stands for any component without a form): every palette
 * entry gets a form, so only such a type keeps the fallback.
 */
/** The instance-names corpus with its attributes processor spelled `count` (the attributes processor has a form). */
const INSTANCE_NAMES = corpusText("instance-names.yaml").replaceAll("attributes/enricher", "count/enricher");
/** The starter with a `count` processor in batch's place, so the box shows at once. */
const COUNT = STARTER.replace(
  "  batch:\n    timeout: '10s'\n    send_batch_size: 1024\n",
  "  count:\n    error_mode: 'ignore'\n    flatten_data: false\n",
).replaceAll("processors: [batch]", "processors: [count]");
/** The count processor's box, as COUNT writes it. */
const COUNT_BOX = "error_mode: 'ignore'\nflatten_data: false";
/** The comments corpus with its receiver spelled `count` (the OTLP receiver has a form): its box shows at once, comments and all. */
const COMMENTS_COUNT = COMMENTS.replace("  otlp:\n", "  count:\n").replace("receivers: [otlp]", "receivers: [count]");
const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function select(nodeId: string) {
  act(() => builderStore().selectNode(nodeId));
}

const box = () => screen.getByRole("textbox", { name: "Raw YAML" }) as HTMLTextAreaElement;

/** Types into the box as one change, as a keystroke does. */
function typeInBox(value: string) {
  fireEvent.change(box(), { target: { value } });
}

function pause(ms = BOX_WRITE_DELAY_MS) {
  act(() => vi.advanceTimersByTime(ms));
}

const configOf = (text: string) => parseYaml(text) as Record<string, Record<string, unknown>>;

describe("ConfigurationPanel's states", () => {
  it('says "No node selected" with nothing selected', () => {
    openText(STARTER);
    render(<ConfigurationPanel />);

    expect(screen.getByText("No node selected")).toHaveClass("text-[13px]");
    expect(screen.getByText("Select a node to configure it")).toHaveClass("text-xs");
  });

  it("summarizes a multi-selection: the count, five labels, how many more, and the hint", () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    const components = builderStore().graph.nodes.filter((n) => n.type !== "pipelineGroup");
    expect(components.length).toBeGreaterThan(6);

    act(() => builderStore().setSelection(components.slice(0, 7).map((n) => n.id)));

    expect(screen.getByText("7 nodes selected")).toBeInTheDocument();
    const labels = document.querySelectorAll(".tf-dot + .font-mono");
    expect([...labels].map((l) => l.textContent)).toEqual(components.slice(0, 5).map((n) => n.data.label));
    expect(document.querySelector(".tf-dot")).toHaveClass("bg-node-receiver");
    expect(screen.getByText("…and 2 more")).toBeInTheDocument();
    expect(screen.getByText("Delete removes the selection, Ctrl+D duplicates it")).toBeInTheDocument();
  });

  it("lists every label, without the overflow line, for five or fewer", () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    act(() =>
      builderStore().setSelection([
        componentNamed("receivers.otlp", "traces").id,
        componentNamed("exporters.otlp", "traces").id,
      ]),
    );

    expect(screen.getByText("2 nodes selected")).toBeInTheDocument();
    expect(screen.queryByText(/…and/)).toBeNull();
    expect([...document.querySelectorAll(".tf-dot")].map((d) => d.className)).toEqual([
      "tf-dot bg-node-receiver",
      "tf-dot bg-node-exporter",
    ]);
  });

  it("shows the pipeline panel for a selected group", () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    select(groupNamed("logs").id);

    expect(screen.getByRole("heading", { level: 3, name: "logs" })).toBeInTheDocument();
    expect(screen.getByText("Signal Type")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Raw YAML" })).toBeNull();
  });

  it("shows the OTLP receiver's header: icon chip, title, Docs link and help text", () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    select(componentNamed("receivers.otlp", "traces").id);

    const title = screen.getByRole("heading", { level: 3, name: "OTLP" });
    expect(title).toHaveClass("text-[15px]", "font-semibold", "truncate");
    const chip = title.previousElementSibling as HTMLElement;
    expect(chip).toHaveClass("h-6", "w-6");
    expect(chip.style.color).toBe("var(--color-node-receiver)");
    expect(chip.querySelector("svg")).not.toBeNull();

    const docs = screen.getByRole("link", { name: "Docs" });
    expect(docs).toHaveAttribute(
      "href",
      "https://github.com/open-telemetry/opentelemetry-collector/tree/main/receiver/otlpreceiver",
    );
    expect(docs).toHaveAttribute("target", "_blank");
    expect(docs).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Accepts OpenTelemetry data over gRPC \(4317\)/)).toBeInTheDocument();
  });

  it("shows help text's `code` in mono, and no Docs link for a component without one", () => {
    // The memory_limiter extension keeps the fallback layout (bearertokenauth has a form).
    openText("receivers:\n  count: {}\nextensions:\n  memory_limiter:\n    check_interval: 1s\n");
    render(<ConfigurationPanel />);
    select(componentNamed("extensions.memory_limiter").id);

    expect(formFor("extension", "memory_limiter")).toBeUndefined();
    expect(screen.getByText("No form for this component yet. Edit its YAML directly.")).toBeInTheDocument();
    const code = screen.getByText("memory_limiter");
    expect(code.tagName).toBe("SPAN");
    expect(code).toHaveClass("font-mono", "text-[11px]");

    select(componentNamed("receivers.count").id);
    expect(screen.getByRole("heading", { level: 3, name: "COUNT" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Docs" })).toBeNull();
  });

  it("lays a component without a form out as the fallback: the Raw YAML box, its hint, then Advanced, collapsed", async () => {
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);

    expect(box()).toHaveClass("font-mono", "text-xs", "h-[360px]");
    expect(screen.getByText("No form for this component yet. Edit its YAML directly.")).toBeInTheDocument();
    const advanced = screen.getByRole("button", { name: "Advanced" });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Instance Name")).toBeNull();

    await userEvent.setup().click(advanced);

    expect(advanced).toHaveAttribute("aria-expanded", "true");
    const field = screen.getByRole("textbox", { name: "Instance Name" });
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "e.g. enricher, high-priority");
    expect(screen.getByText("Appended to the YAML id as count/<name>.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Advanced: Instance & YAML" })).toBeNull();
  });

  it("disables the box and the instance name while the canvas is locked", async () => {
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);
    await userEvent.setup().click(screen.getByRole("button", { name: "Advanced" }));

    act(() => builderStore().setText(`${COUNT}# typed\n`));

    expect(box()).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Instance Name" })).toBeDisabled();
    // The box still shows the component's text from before the typing.
    expect(box().value).toBe(COUNT_BOX);
  });
});

describe("the Raw YAML box", () => {
  it("shows the component's own text, its comments included", () => {
    openText(COMMENTS_COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("receivers.count").id);

    expect(box().value).toBe(
      "protocols:\n  grpc:\n    endpoint: 0.0.0.0:4317 # gRPC\n  http: # HTTP\n    endpoint: 0.0.0.0:4318",
    );
  });

  it("writes a valid change 300 ms after the typing stops, keeping the comments, as one undo entry", () => {
    vi.useFakeTimers();
    openText(COMMENTS_COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("receivers.count").id);
    const typed = box().value.replace("4318", "4319");

    typeInBox(typed);
    pause(BOX_WRITE_DELAY_MS - 1);
    expect(builderStore().text).toBe(COMMENTS_COUNT);

    pause(1);
    const text = builderStore().text;
    expect(text).toBe(COMMENTS_COUNT.replace("endpoint: 0.0.0.0:4318", "endpoint: 0.0.0.0:4319"));
    expect(text).toContain("endpoint: 0.0.0.0:4317 # gRPC");
    expect(text).toContain("http: # HTTP");
    expect(box().value).toBe(typed);
    expect(builderStore().history.past).toHaveLength(1);
    expect(selectUndoDescription(builderStore())).toBe("Update COUNT");
    expect(componentNamed("receivers.count").data.config).toEqual({
      protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4319" } },
    });
    expect(screen.queryByText(RAW_YAML_UNREADABLE_MESSAGE)).toBeNull();
  });

  it("waits for the last keystroke: each keystroke restarts the pause", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);

    typeInBox("error_mode: s");
    pause(200);
    typeInBox("error_mode: silent");
    pause(200);
    expect(builderStore().text).toBe(COUNT);
    pause(100);

    expect(configOf(builderStore().text).processors!.count).toEqual({ error_mode: "silent" });
  });

  it("says an unreadable box doesn't parse, as text under the box, keeps what was typed and writes nothing", () => {
    vi.useFakeTimers();
    openText(COMMENTS_COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("receivers.count").id);

    typeInBox("protocols: [grpc");
    pause();

    const message = screen.getByText(RAW_YAML_UNREADABLE_MESSAGE);
    expect(message.tagName).toBe("P");
    expect(RAW_YAML_UNREADABLE_MESSAGE).toBe("Raw YAML doesn't parse. Fix the syntax to apply the edit.");
    expect(box().value).toBe("protocols: [grpc");
    expect(builderStore().text).toBe(COMMENTS_COUNT);
    expect(builderStore().history.past).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();

    // A value that isn't a mapping doesn't read as a component's either.
    typeInBox("- a list");
    pause();
    expect(screen.getByText(RAW_YAML_UNREADABLE_MESSAGE)).toBeInTheDocument();
    expect(builderStore().text).toBe(COMMENTS_COUNT);

    // Fixed, it writes, and the message goes.
    typeInBox("protocols:\n  grpc: {}");
    pause();
    expect(screen.queryByText(RAW_YAML_UNREADABLE_MESSAGE)).toBeNull();
    expect(configOf(builderStore().text).receivers!.count).toEqual({ protocols: { grpc: {} } });
  });

  it("leaves the component with no value when the box is emptied", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);

    typeInBox("");
    pause();

    const text = builderStore().text;
    expect(text).toContain("processors:\n  count:\nexporters:");
    expect(configOf(text).processors!.count).toBeNull();
    expect(componentNamed("processors.count", "metrics").data.config).toBeNull();
    expect(box().value).toBe("");
  });

  it("writes at once when the box loses focus", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);

    typeInBox("error_mode: propagate");
    fireEvent.blur(box());

    expect(configOf(builderStore().text).processors!.count).toEqual({ error_mode: "propagate" });
    pause();
    expect(builderStore().history.past).toHaveLength(1);
  });

  it("writes a waiting edit to its own component when another node is selected", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);

    typeInBox("error_mode: silent");
    select(componentNamed("exporters.otlp", "traces").id);

    expect(configOf(builderStore().text).processors!.count).toEqual({ error_mode: "silent" });
    // The OTLP exporter has a form: its box is under "Advanced: Instance & YAML".
    fireEvent.click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));
    expect(box().value).toBe("endpoint: 'otelcol:4317'\ntls:\n  insecure: true");
  });

  it("isn't overwritten while the person types, by an unrelated change or by one to its own component", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    const count = componentNamed("processors.count", "traces");
    select(count.id);

    typeInBox("error_mode: silent # typed");
    // Another component's value changes, then this one's, from elsewhere.
    act(() => {
      builderStore().setComponentValue(componentNamed("exporters.otlp", "traces").id, "endpoint: 'elsewhere:4317'");
      builderStore().setComponentValue(count.id, "error_mode: propagate");
    });
    expect(configOf(builderStore().text).processors!.count).toEqual({ error_mode: "propagate" });
    expect(box().value).toBe("error_mode: silent # typed");

    // The person's text is written after the pause.
    pause();
    expect(builderStore().text).toContain("  count:\n    error_mode: silent # typed\n");
    expect(configOf(builderStore().text).exporters!.otlp).toEqual({ endpoint: "elsewhere:4317" });
    expect(box().value).toBe("error_mode: silent # typed");
  });

  it("follows the text when the component's value changes elsewhere while nobody types (undo, redo)", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);

    typeInBox("error_mode: silent\n");
    pause();
    // The write doesn't reformat what was typed (the text holds it without the last line break).
    expect(box().value).toBe("error_mode: silent\n");

    act(() => void builderStore().undo());
    expect(box().value).toBe(COUNT_BOX);

    act(() => void builderStore().redo());
    expect(box().value).toBe("error_mode: silent");
  });

  it("disables the box of a component the text doesn't declare, and says why as text", () => {
    const text = "exporters:\n  count: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [count]\n      exporters: [count]\n";
    openText(text);
    render(<ConfigurationPanel />);
    select(componentNamed("receivers.count").id);

    expect(box().value).toBe("");
    expect(box()).toBeDisabled();
    const hint = screen.getByText(UNDECLARED_COMPONENT_MESSAGE);
    expect(hint.tagName).toBe("P");
    expect(UNDECLARED_COMPONENT_MESSAGE).toBe(
      "This component isn't declared in the YAML. Declare it in the YAML tab to edit it here.",
    );
    expect(builderStore().text).toBe(text);

    // A declared one has an enabled box and no hint.
    select(componentNamed("exporters.count").id);
    expect(box()).toBeEnabled();
    expect(screen.queryByText(UNDECLARED_COMPONENT_MESSAGE)).toBeNull();
  });

  it("never writes an edit into a configuration loaded after it began, whose nodes have the same ids", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    const count = componentNamed("processors.count", "traces");
    select(count.id);
    typeInBox("error_mode: silent");

    // Another configuration opens with the same text: the same node ids.
    act(() => openText(COUNT, "0199c000-0000-7000-8000-0000000000ff"));
    expect(componentNamed("processors.count", "traces").id).toBe(count.id);
    // Its box flushes when it goes (nothing is selected in the new load); a
    // box still showing (the node selected again) waits out its pause.
    select(count.id);
    pause();
    fireEvent.blur(box());

    expect(builderStore().text).toBe(COUNT);
    expect(selectIsDirty(builderStore())).toBe(false);
    expect(builderStore().history.past).toHaveLength(0);
  });

  it("says, as text under the box, that a box reusing an anchor name defined elsewhere isn't written", () => {
    vi.useFakeTimers();
    const text =
      "receivers:\n  otlp: &common\n    protocols:\n      grpc: {}\nexporters:\n  count: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [count]\n";
    openText(text);
    render(<ConfigurationPanel />);
    select(componentNamed("exporters.count").id);

    typeInBox("format: &common json");
    pause();

    const message = screen.getByText(ANCHOR_CLASH_MESSAGE);
    expect(message.tagName).toBe("P");
    expect(ANCHOR_CLASH_MESSAGE).toBe(
      "This YAML reuses an anchor name defined elsewhere in the configuration. Rename the anchor to apply the edit.",
    );
    expect(box().value).toBe("format: &common json");
    expect(builderStore().text).toBe(text);
    expect(screen.queryByText(RAW_YAML_UNREADABLE_MESSAGE)).toBeNull();

    // Renamed, it writes, and the message goes.
    typeInBox("format: &mine json");
    pause();
    expect(screen.queryByText(ANCHOR_CLASH_MESSAGE)).toBeNull();
    expect(configOf(builderStore().text).exporters!.count).toEqual({ format: "json" });
  });
});

describe("the instance name", () => {
  /** Opens "Advanced", or a form's "Advanced: Instance & YAML". */
  async function openAdvanced() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Advanced/ }));
    return { user, field: screen.getByRole("textbox", { name: "Instance Name" }) };
  }

  it('labels the node "Base (name)" and renames its key in the text and its pipeline\'s list', async () => {
    openText(INSTANCE_NAMES);
    render(<ConfigurationPanel />);
    const enricher = componentNamed("processors.count/enricher");
    select(enricher.id);
    const { user, field } = await openAdvanced();
    expect(field).toHaveValue("enricher");
    expect(screen.getByRole("heading", { level: 3, name: "COUNT (enricher)" })).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "tagger");
    // Nothing is renamed while the name is typed.
    expect(builderStore().text).toBe(INSTANCE_NAMES);
    expect(screen.getByRole("heading", { level: 3, name: "COUNT (enricher)" })).toBeInTheDocument();

    await user.keyboard("{Enter}");

    const text = builderStore().text;
    expect(text).toBe(
      INSTANCE_NAMES.replace("  count/enricher:", "  count/tagger:").replace(
        "processors: [count/enricher,",
        "processors: [count/tagger,",
      ),
    );
    expect(screen.getByRole("heading", { level: 3, name: "COUNT (tagger)" })).toBeInTheDocument();
    expect(field).toHaveValue("tagger");
    const node = builderStore().graph.nodes.find((n) => n.id === enricher.id)!;
    expect(node.data).toMatchObject({ label: "COUNT (tagger)", instanceName: "tagger" });
    // One rename, one entry.
    expect(builderStore().history.past).toHaveLength(1);
    expect(selectUndoDescription(builderStore())).toBe("Update COUNT (enricher)");
  });

  it("under a form, in \"Advanced: Instance & YAML\": renames an extension's key and its service.extensions entry; an empty name leaves the base label", async () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    const health = componentNamed("extensions.health_check");
    select(health.id);
    expect(screen.getByRole("button", { name: "Advanced: Instance & YAML" })).toHaveAttribute("aria-expanded", "false");
    const { user, field } = await openAdvanced();

    await user.type(field, "main{Enter}");

    let text = builderStore().text;
    expect(text).toContain("  health_check/main:\n    endpoint: '0.0.0.0:13133'\n");
    expect(text).toContain("extensions: [health_check/main, pprof, zpages]");
    expect(screen.getByRole("heading", { level: 3, name: "Health Check (main)" })).toBeInTheDocument();

    await user.clear(field);
    // Losing focus commits too.
    await user.tab();
    text = builderStore().text;
    expect(text).toBe(STARTER);
    expect(screen.getByRole("heading", { level: 3, name: "Health Check" })).toBeInTheDocument();
  });

  it("links two nodes that come to share a name: one entry in the text, named by both pipelines", async () => {
    const text = [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc: {}",
      "  otlp/2:",
      "    protocols:",
      "      http: {}",
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [debug]",
      "    metrics:",
      "      receivers: [otlp/2]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    openText(text);
    render(<ConfigurationPanel />);
    const second = componentNamed("receivers.otlp/2");
    select(second.id);
    const { user, field } = await openAdvanced();

    await user.clear(field);
    await user.keyboard("{Enter}");

    const after = builderStore().text;
    expect(after).not.toContain("otlp/2");
    expect(configOf(after).receivers).toEqual({ otlp: { protocols: { grpc: {} } } });
    expect(after).toContain("    metrics:\n      receivers: [otlp]\n");
    const linked = builderStore().graph.nodes.filter((n) => n.data.componentType === "receiver");
    expect(linked.map((n) => n.data.sharedConfigId)).toEqual(["receiver-otlp", "receiver-otlp"]);
    expect(linked.map((n) => n.data.config)).toEqual([{ protocols: { grpc: {} } }, { protocols: { grpc: {} } }]);
    // The box shows the one entry's value.
    expect(box().value).toBe("protocols:\n  grpc: {}");
  });
});

describe("the instance name commits on blur or Enter", () => {
  /** Opens "Advanced", or a form's "Advanced: Instance & YAML". */
  async function openAdvanced() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Advanced/ }));
    return { user, field: screen.getByRole("textbox", { name: "Instance Name" }) };
  }

  it("clear the field, then type a new name: the component keeps its own value and comments, not its sibling's", async () => {
    // count/2 passes through `count` (an empty name) on the way to its new name.
    const text = [
      "processors:",
      "  count:",
      "    error_mode: ignore",
      "  count/2: # the second",
      "    # tuned for logs",
      "    error_mode: silent",
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    traces:",
      "      processors: [count]",
      "      exporters: [debug]",
      "    logs:",
      "      processors: [count/2]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    openText(text);
    render(<ConfigurationPanel />);
    const second = componentNamed("processors.count/2");
    select(second.id);
    const { user, field } = await openAdvanced();

    await user.clear(field);
    await user.type(field, "tuned");
    await user.tab();

    expect(builderStore().text).toBe(
      text
        .replace("  count/2: # the second", "  count/tuned: # the second")
        .replace("[count/2]", "[count/tuned]"),
    );
    const node = builderStore().graph.nodes.find((n) => n.id === second.id)!;
    expect(node.data).toMatchObject({ label: "COUNT (tuned)", instanceName: "tuned", config: { error_mode: "silent" } });
    expect(componentNamed("processors.count").data.config).toEqual({ error_mode: "ignore" });
    expect(builderStore().history.past).toHaveLength(1);
    expect(box().value).toBe("# tuned for logs\nerror_mode: silent");
  });

  it("Escape puts the name back and renames nothing", async () => {
    openText(INSTANCE_NAMES);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count/enricher").id);
    const { user, field } = await openAdvanced();

    await user.clear(field);
    await user.type(field, "tagger{Escape}");

    expect(field).toHaveValue("enricher");
    await user.tab();
    expect(builderStore().text).toBe(INSTANCE_NAMES);
    expect(builderStore().history.past).toHaveLength(0);
  });

  it("an unchanged name commits nothing, and an undo shows in the field", async () => {
    openText(INSTANCE_NAMES);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count/enricher").id);
    const { user, field } = await openAdvanced();

    await user.click(field);
    await user.tab();
    expect(builderStore().history.past).toHaveLength(0);

    await user.clear(field);
    await user.type(field, "tagger{Enter}");
    expect(field).toHaveValue("tagger");
    act(() => void builderStore().undo());
    expect(field).toHaveValue("enricher");
  });

  it("a name still being typed is committed when another node is selected", async () => {
    openText(INSTANCE_NAMES);
    render(<ConfigurationPanel />);
    const enricher = componentNamed("processors.count/enricher");
    select(enricher.id);
    const { user, field } = await openAdvanced();

    await user.clear(field);
    await user.type(field, "tagger");
    const other = builderStore().graph.nodes.find((n) => n.type !== "pipelineGroup" && n.id !== enricher.id)!;
    select(other.id);

    expect(builderStore().graph.nodes.find((n) => n.id === enricher.id)!.data.instanceName).toBe("tagger");
  });
});

describe("an edit a field holds is saved by Cmd/Ctrl+S and guarded", () => {
  /**
   * The page's Cmd/Ctrl+S, as routes/editor.tsx listens on `window`: it
   * saves the store's text then (recorded here, and marked saved as a save
   * does), and prevents the browser's save dialog.
   */
  function listenLikeThePage() {
    const saved: string[] = [];
    const prevented: boolean[] = [];
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      const state = builderStore();
      saved.push(state.text);
      state.markSaved(state.text, state.version!, state.graph);
      prevented.push(event.defaultPrevented);
    };
    window.addEventListener("keydown", handleKeyDown);
    return { saved, prevented, stop: () => window.removeEventListener("keydown", handleKeyDown) };
  }

  /** Whether closing or reloading the tab would ask now. */
  function unloadAsks(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("Cmd/Ctrl+S in the instance name commits it first: the save has the new name, and the editor is clean after", async () => {
    openText(INSTANCE_NAMES);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count/enricher").id);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const field = screen.getByRole("textbox", { name: "Instance Name" });
    const page = listenLikeThePage();

    await user.clear(field);
    await user.type(field, "tagger");
    fireEvent.keyDown(field, { key: "s", ctrlKey: true });

    expect(page.saved).toHaveLength(1);
    expect(page.saved[0]).toContain("  count/tagger:");
    expect(page.saved[0]).not.toContain("count/enricher");
    expect(page.prevented).toEqual([true]);
    // Leaving the field afterwards changes nothing: the save had it all.
    await user.tab();
    expect(selectIsDirty(builderStore())).toBe(false);
    expect(builderStore().history.past).toHaveLength(1);
    page.stop();
  });

  it("Cmd/Ctrl+S in the YAML box writes it at once, within its 300 ms: the save has it, and the editor is clean after", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);
    const page = listenLikeThePage();

    typeInBox("error_mode: silent");
    pause(100);
    fireEvent.keyDown(box(), { key: "s", metaKey: true });

    expect(page.saved).toHaveLength(1);
    expect(configOf(page.saved[0]!).processors!.count).toEqual({ error_mode: "silent" });
    expect(page.prevented).toEqual([true]);
    pause();
    fireEvent.blur(box());
    expect(selectIsDirty(builderStore())).toBe(false);
    expect(builderStore().history.past).toHaveLength(1);
    page.stop();
  });

  it("a name not yet committed makes closing the tab ask; committing it hands that to the store's dirty state", async () => {
    openText(INSTANCE_NAMES);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count/enricher").id);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const field = screen.getByRole("textbox", { name: "Instance Name" });
    expect(unloadAsks()).toBe(false);

    await user.type(field, "x");
    expect(selectIsDirty(builderStore())).toBe(false);
    expect(unloadAsks()).toBe(true);

    await user.keyboard("{Escape}");
    expect(unloadAsks()).toBe(false);

    await user.type(field, "y{Enter}");
    // Committed: the store is dirty (the page asks for that), and the field no longer does.
    expect(selectIsDirty(builderStore())).toBe(true);
    expect(unloadAsks()).toBe(false);
  });

  it("a YAML box edit waiting for its pause, or refused, makes closing the tab ask; written, it doesn't", () => {
    vi.useFakeTimers();
    openText(COUNT);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.count", "traces").id);
    expect(unloadAsks()).toBe(false);

    typeInBox("error_mode: [");
    expect(unloadAsks()).toBe(true);
    pause();
    // Refused (it doesn't read): still only in the box.
    expect(screen.getByText(RAW_YAML_UNREADABLE_MESSAGE)).toBeInTheDocument();
    expect(unloadAsks()).toBe(true);

    typeInBox("error_mode: silent");
    pause();
    expect(unloadAsks()).toBe(false);
    expect(selectIsDirty(builderStore())).toBe(true);
  });
});

describe("privacy", () => {
  // The fallback layout (`count`, outside the palette), and a form's layout (batch's; its box is
  // under "Advanced: Instance & YAML").
  it.each([
    ["the fallback layout", "receivers", "count", "include", "Advanced"],
    ["a form's layout", "processors", "batch", "timeout", "Advanced: Instance & YAML"],
  ])("puts no label, instance name or config value in any attribute: %s", async (_layout, section, type, key, advanced) => {
    const LABEL = "zq-label-marker";
    const INSTANCE = "zq-instance-marker";
    const VALUE = "zq-value-marker";
    const list = section === "receivers" ? "receivers" : "processors";
    openText(
      `${section}:\n  ${type}/${INSTANCE}:\n    ${key}: ${VALUE}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      ${list}: [${type}/${INSTANCE}]\n      exporters: [debug]\n`,
    );
    const node = componentNamed(`${section}.${type}/${INSTANCE}`);
    useEditorStore.setState({
      graph: {
        ...builderStore().graph,
        nodes: builderStore().graph.nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, label: LABEL } } : n)),
      },
    });
    render(<ConfigurationPanel />);
    select(node.id);
    expect(formFor(node.data.componentType as ComponentType, node.data.componentSubType) !== undefined).toBe(type === "batch");
    await userEvent.setup().click(screen.getByRole("button", { name: advanced }));

    expect(screen.getByRole("heading", { level: 3, name: LABEL })).toBeInTheDocument();
    expect(box().value).toContain(VALUE);
    expect(screen.getByRole("textbox", { name: "Instance Name" })).toHaveValue(INSTANCE);
    if (type === "batch") expect(screen.getByRole("textbox", { name: "Timeout" })).toHaveValue(VALUE);

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      // A controlled field's value property is its content, not an attribute: the replay masks inputs.
      for (const attribute of element.attributes) {
        if (attribute.name === "value") continue;
        for (const marker of [LABEL, INSTANCE, VALUE]) {
          if (attribute.value.includes(marker)) leaks.push(`${element.tagName}[${attribute.name}] has ${marker}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe("the layout with a form", () => {
  /** A form's hint line, by its whole text ("… · Default 200ms" spans elements). */
  const hintLine = (whole: string) =>
    screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

  it("shows the form, then \"Advanced: Instance & YAML\", collapsed, holding the instance name and the box at 260 px with its hint", async () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.batch", "traces").id);

    const timeout = screen.getByRole("textbox", { name: "Timeout" });
    expect(timeout).toHaveValue("10s");
    const advanced = screen.getByRole("button", { name: "Advanced: Instance & YAML" });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    // The form comes before the section, both under the header.
    const heading = screen.getByRole("heading", { level: 3, name: "Batch" });
    expect(heading.compareDocumentPosition(timeout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timeout.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(advanced.parentElement).toHaveClass("mt-4");
    expect(screen.queryByRole("textbox", { name: "Raw YAML" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Instance Name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Advanced" })).toBeNull();

    await userEvent.setup().click(advanced);

    const name = screen.getByRole("textbox", { name: "Instance Name" });
    expect(name).toHaveAttribute("placeholder", "e.g. enricher, high-priority");
    expect(screen.getByText("Appended to the YAML id as batch/<name>.")).toBeInTheDocument();
    expect(box()).toHaveClass("font-mono", "text-xs", "h-[260px]");
    expect(box().value).toBe("timeout: '10s'\nsend_batch_size: 1024");
    expect(name.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(FORM_BOX_HINT).tagName).toBe("P");
    expect(FORM_BOX_HINT).toBe("Edits sync with the form fields above.");
    expect(FALLBACK_BOX_HINT).toBe("No form for this component yet. Edit its YAML directly.");
    expect(screen.queryByText(FALLBACK_BOX_HINT)).toBeNull();
  });

  it.each([
    ["processors.batch", "Send Batch Size"],
    ["processors.memory_limiter", "Check Interval"],
    ["exporters.debug", "Sampling Initial"],
    ["connectors.forward", null],
    ["extensions.health_check", "Endpoint"],
    ["extensions.pprof", "Endpoint"],
    ["extensions.zpages", "Endpoint"],
  ])("gives %s its form", (key, field) => {
    const text = [
      "processors:",
      "  batch: {}",
      "  memory_limiter: {}",
      "exporters:",
      "  debug: {}",
      "connectors:",
      "  forward: {}",
      "extensions:",
      "  health_check: {}",
      "  pprof: {}",
      "  zpages: {}",
      "service:",
      "  extensions: [health_check, pprof, zpages]",
      "  pipelines:",
      "    traces:",
      "      processors: [memory_limiter, batch]",
      "      exporters: [forward]",
      "    traces/2:",
      "      receivers: [forward]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    openText(text);
    render(<ConfigurationPanel />);
    select(componentNamed(key).id);

    expect(screen.getByRole("button", { name: "Advanced: Instance & YAML" })).toBeInTheDocument();
    if (field === null) expect(screen.getByText(/Routing is defined by the pipeline wiring on the canvas\./)).toBeInTheDocument();
    else expect(screen.getByRole("textbox", { name: field })).toBeInTheDocument();
    expect(builderStore().text).toBe(text);
  });

  it("gives the pprof and zpages endpoints the collector's default, localhost", () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    const cases = [
      ["extensions.pprof", "Address the pprof HTTP server listens on. · Default localhost:1777", "localhost:1777"],
      ["extensions.zpages", "Address the zPages HTTP server listens on. · Default localhost:55679", "localhost:55679"],
    ] as const;
    for (const [key, hint, placeholder] of cases) {
      select(componentNamed(key).id);
      expect(hintLine(hint)).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Endpoint" })).toHaveAttribute("placeholder", placeholder);
    }
  });

  it("keeps the fallback for the memory_limiter extension, which has no form (the processor's isn't its)", () => {
    const text = [
      "processors:",
      "  memory_limiter:",
      "    check_interval: 1s",
      "extensions:",
      "  memory_limiter:",
      "    check_interval: 2s",
      "service:",
      "  extensions: [memory_limiter]",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [memory_limiter]",
      "",
    ].join("\n");
    openText(text);
    render(<ConfigurationPanel />);

    select(componentNamed("extensions.memory_limiter").id);
    expect(screen.getByRole("heading", { level: 3, name: "Memory Limiter" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Check Interval" })).toBeNull();
    expect(box()).toHaveClass("h-[360px]");
    expect(box().value).toBe("check_interval: 2s");
    expect(screen.getByText(FALLBACK_BOX_HINT)).toBeInTheDocument();

    // The processor of the same name has its form.
    select(componentNamed("processors.memory_limiter").id);
    expect(screen.getByRole("textbox", { name: "Check Interval" })).toHaveValue("1s");
    expect(builderStore().text).toBe(text);
  });

  it.each([
    ["a list", "[timeout, 1s]"],
    ["a number", "5"],
    ["a string", "fast"],
  ])("keeps the fallback for a component whose value is %s: its box is the way to fix it", (_what, value) => {
    const text = `processors:\n  batch: ${value}\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [debug]\n`;
    openText(text);
    render(<ConfigurationPanel />);

    select(componentNamed("processors.batch").id);
    expect(screen.queryByRole("textbox", { name: "Timeout" })).toBeNull();
    expect(box().value).toBe(value);
    expect(screen.getByText(FALLBACK_BOX_HINT)).toBeInTheDocument();

    // An empty value (`debug:`) has its form.
    select(componentNamed("exporters.debug").id);
    expect(screen.getByRole("combobox", { name: "Verbosity" })).toBeInTheDocument();
    expect(builderStore().text).toBe(text);
  });

  it("disables an undeclared component's form, and says why under its header, as text", async () => {
    const text = "exporters:\n  file: {}\nservice:\n  pipelines:\n    traces:\n      processors: [batch]\n      exporters: [file]\n";
    openText(text);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.batch").id);

    const message = screen.getByText(UNDECLARED_COMPONENT_MESSAGE);
    expect(message.tagName).toBe("P");
    const heading = screen.getByRole("heading", { level: 3, name: "Batch" });
    const timeout = screen.getByRole("textbox", { name: "Timeout" });
    expect(heading.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(message.compareDocumentPosition(timeout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timeout).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Send Batch Size" })).toBeDisabled();

    await userEvent.setup().click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));
    expect(box()).toBeDisabled();
    // Said once, under the header: not again under the box.
    expect(screen.getAllByText(UNDECLARED_COMPONENT_MESSAGE)).toEqual([message]);
    expect(builderStore().text).toBe(text);
  });

  it("disables the form while the canvas is locked", () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.batch", "traces").id);
    expect(screen.getByRole("textbox", { name: "Timeout" })).toBeEnabled();

    act(() => builderStore().setText(`${STARTER}# typed\n`));

    expect(screen.getByRole("textbox", { name: "Timeout" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Timeout" })).toHaveValue("10s");
  });

  it("the form follows a YAML box edit, and the box follows a form edit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openText(STARTER);
    render(<ConfigurationPanel />);
    select(componentNamed("processors.batch", "traces").id);
    fireEvent.click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));

    typeInBox("timeout: 1m30s # typed\nsend_batch_size: 1024");
    pause();
    expect(builderStore().text).toContain("  batch:\n    timeout: 1m30s # typed\n    send_batch_size: 1024\n");
    expect(screen.getByRole("textbox", { name: "Timeout" })).toHaveValue("1m30s");

    const size = screen.getByRole("textbox", { name: "Send Batch Size" });
    fireEvent.change(size, { target: { value: "2048" } });
    fireEvent.blur(size);
    expect(builderStore().text).toContain("  batch:\n    timeout: 1m30s # typed\n    send_batch_size: 2048\n");
    expect(box().value).toBe("timeout: 1m30s # typed\nsend_batch_size: 2048");
  });
});

describe("opening a form writes nothing", () => {
  /** Opens every collapsed section, again until none is left (a section can hold another). */
  function openEverySection() {
    for (let round = 0; round < 5; round++) {
      const closed = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]:not([role])')];
      if (closed.length === 0) return;
      for (const button of closed) fireEvent.click(button);
    }
  }

  /** Focuses and leaves every field, as tabbing through the form does. */
  function visitEveryField() {
    for (const field of document.querySelectorAll<HTMLElement>("input, textarea, button[role]")) {
      fireEvent.focus(field);
      fireEvent.blur(field);
    }
  }

  it.each(CORPUS.map((entry) => [entry.name, entry.text] as const))(
    "%s: selecting each component with a form, opening its sections and visiting its fields leaves the text byte for byte and the editor clean",
    (_name, text) => {
      openText(text);
      render(<ConfigurationPanel />);
      const withForms = builderStore().graph.nodes.filter(
        (n) => !isGroup(n) && formFor(n.data.componentType as ComponentType, n.data.componentSubType) !== undefined,
      );

      for (const node of withForms) {
        select(node.id);
        openEverySection();
        visitEveryField();
      }

      expect(builderStore().text).toBe(text);
      expect(selectIsDirty(builderStore())).toBe(false);
      expect(builderStore().history.past).toHaveLength(0);
    },
    // The logs corpus opens the logs forms and their operator cards: its own time limit.
    20_000,
  );

  it("the corpus opens the batch, memory_limiter, debug, forward, health_check, pprof and zpages forms", () => {
    const opened = new Set<string>();
    for (const { text } of CORPUS) {
      openText(text);
      for (const node of builderStore().graph.nodes) {
        if (!isGroup(node) && formFor(node.data.componentType as ComponentType, node.data.componentSubType)) {
          opened.add(`${node.data.componentType}:${node.data.componentSubType}`);
        }
      }
    }
    expect([...opened]).toEqual(
      expect.arrayContaining([
        "processor:batch",
        "processor:memory_limiter",
        "exporter:debug",
        "connector:forward",
        "extension:health_check",
        "extension:pprof",
        "extension:zpages",
      ]),
    );
  });
});

describe("the canvas's shortcuts stay out of the tab", () => {
  function WithShortcuts() {
    useUndoRedo();
    return <ConfigurationPanel />;
  }

  it("Delete, Backspace and Cmd/Ctrl+D on a focused checkbox in a form don't delete or duplicate the selected node", () => {
    const text =
      "exporters:\n  debug:\n    verbosity: basic\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
    openText(text);
    render(<WithShortcuts />);
    const debug = componentNamed("exporters.debug");
    select(debug.id);
    const nodes = builderStore().graph.nodes.length;
    const checkbox = screen.getByRole("checkbox", { name: "Use Internal Logger" });
    checkbox.focus();

    for (const init of [{ key: "Delete" }, { key: "Backspace" }, { key: "d", ctrlKey: true }, { key: "d", metaKey: true }]) {
      fireEvent.keyDown(checkbox, init);
    }

    expect(builderStore().pendingDelete).toBeNull();
    expect(builderStore().graph.nodes).toHaveLength(nodes);
    expect(builderStore().text).toBe(text);
    expect(builderStore().selectedNode?.id).toBe(debug.id);
    expect(toast.success).not.toHaveBeenCalled();

    // Outside the tab the keys are the canvas's still.
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(builderStore().pendingDelete).toEqual({ kind: "nodes", nodeIds: [debug.id] });
  });
});

describe("a component dropped from the palette opens its form on either spelling", () => {
  const BASE = [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc: {}",
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  // The OTLP exporter became otlp_grpc in 0.144.0.
  it.each([
    ["0.143.0", "otlp"],
    ["0.162.0", "otlp_grpc"],
  ])("pinned to %s, the OTLP exporter is written %s, and its form edits it there", async (pin, written) => {
    const version = versionFixture({ id: BUILDER_VERSION_ID, yamlContent: BASE, collectorVersion: pin });
    act(() => builderStore().load({ organizationId: GROUP_ID, configuration: MINE, version }));
    const entry = componentPalette.find((candidate) => candidate.type === "exporter" && candidate.subType === "otlp")!;
    let node: ReturnType<ReturnType<typeof builderStore>["dropComponent"]> = null;
    act(() => {
      node = builderStore().dropComponent(entry.id, { x: -3000, y: -3000 });
    });
    expect(Object.keys(configOf(builderStore().text).exporters!)).toEqual(["debug", written]);
    render(<ConfigurationPanel />);
    select(node!.id);

    expect(screen.getByRole("heading", { level: 3, name: "OTLP" })).toBeInTheDocument();
    const endpoint = document.getElementById("otlp-endpoint") as HTMLInputElement;
    expect(endpoint).toHaveValue("otelcol:4317");
    const user = userEvent.setup();
    await user.clear(endpoint);
    await user.type(endpoint, "collector:4317");
    await user.tab();

    const exporters = configOf(builderStore().text).exporters!;
    expect(Object.keys(exporters)).toEqual(["debug", written]);
    expect((exporters[written] as Record<string, unknown>).endpoint).toBe("collector:4317");
  });
});
