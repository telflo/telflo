import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { CanvasActions } from "./CanvasActions.js";
import { CollapsibleToolbox } from "./CollapsibleToolbox.js";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.js";
import { PipelineGroupConfigPanel } from "./PipelineGroupConfigPanel.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { CUSTOM_PIPELINE_COLORS } from "~/lib/graph/node-builders.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentsIn, groupNamed, openText } from "~/test/builder-store.js";

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The panel, with the one delete dialog the page mounts beside it. */
function renderPanel() {
  render(
    <>
      <PipelineGroupConfigPanel />
      <DeleteConfirmDialog />
    </>,
  );
  return userEvent.setup();
}

function selectGroup(name: string) {
  act(() => builderStore().selectNode(groupNamed(name).id));
}

const pipelineNames = (text: string) =>
  Object.keys((parseYaml(text) as { service: { pipelines: Record<string, unknown> } }).service.pipelines);

describe("PipelineGroupConfigPanel", () => {
  it("shows nothing without a selected group", () => {
    openText(STARTER);
    const { container } = render(<PipelineGroupConfigPanel />);
    expect(container).toBeEmptyDOMElement();
    act(() => builderStore().selectNode(builderStore().graph.nodes.find((n) => n.type === "receiver")!.id));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the pipeline's name, signal badge and twelve swatches, the current one pressed", () => {
    openText(STARTER);
    renderPanel();
    selectGroup("metrics");

    expect(screen.getByRole("heading", { level: 3, name: "metrics" })).toBeInTheDocument();
    expect(screen.getByText("Signal Type")).toBeInTheDocument();
    expect(screen.getByText("metrics", { selector: "div" })).toHaveClass("uppercase");
    expect(screen.getByText("Color")).toBeInTheDocument();
    const swatches = screen.getAllByRole("button", { pressed: false }).concat(screen.getAllByRole("button", { pressed: true }));
    expect(swatches).toHaveLength(12);
    expect(screen.getByRole("button", { pressed: true })).toHaveAttribute("title", "#3b82f6");
    expect(screen.getByRole("button", { name: "Delete pipeline" })).toBeEnabled();
  });

  it("says so when the group's pipeline is missing", () => {
    openText(STARTER);
    const group = groupNamed("logs");
    useEditorStore.setState({ selectedNode: { ...group, data: { ...group.data, pipelineId: "pipeline_99" } } });
    render(<PipelineGroupConfigPanel />);
    expect(screen.getByText("Pipeline not found")).toBeInTheDocument();
  });

  it("changes the color as a layout change, with its toast, and the change undoes", async () => {
    openText(STARTER);
    const user = renderPanel();
    selectGroup("traces");
    const pink = CUSTOM_PIPELINE_COLORS[4];

    await user.click(screen.getByTitle(pink));

    const pipeline = builderStore().graph.pipelines.find((p) => p.name === "traces")!;
    expect(pipeline.color).toBe(pink);
    expect(groupNamed("traces").data.color).toBe(pink);
    expect(screen.getByTitle(pink)).toHaveAttribute("aria-pressed", "true");
    expect(toast.success).toHaveBeenCalledWith("Pipeline color updated");
    expect(builderStore().text).toBe(STARTER);
    expect(selectIsDirty(builderStore())).toBe(true);
    expect(builderStore().history.past.map((e) => e.description)).toEqual(["Change color of traces"]);

    act(() => void builderStore().undo());
    expect(groupNamed("traces").data.color).toBe(CUSTOM_PIPELINE_COLORS[0]);
    expect(screen.getByTitle(CUSTOM_PIPELINE_COLORS[0])).toHaveAttribute("aria-pressed", "true");
    expect(selectIsDirty(builderStore())).toBe(false);
  });

  it("clicking the current color changes nothing", async () => {
    openText(STARTER);
    const user = renderPanel();
    selectGroup("traces");
    await user.click(screen.getByTitle(CUSTOM_PIPELINE_COLORS[0]));
    expect(toast.success).not.toHaveBeenCalled();
    expect(builderStore().history.past).toHaveLength(0);
  });

  it("deletes the pipeline and its components through the delete dialog, and the delete undoes", async () => {
    openText(STARTER);
    const user = renderPanel();
    selectGroup("traces");
    const traces = groupNamed("traces");
    expect(componentsIn(traces)).toEqual(["exporters.otlp", "processors.batch", "receivers.otlp"]);

    await user.click(screen.getByRole("button", { name: "Delete pipeline" }));

    const dialog = await screen.findByRole("alertdialog", { name: 'Delete pipeline "traces"?' });
    expect(dialog).toHaveAccessibleDescription("Its components and connections will be removed.");
    expect(builderStore().graph.pipelines).toHaveLength(3);

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(builderStore().graph.pipelines.map((p) => p.name)).toEqual(["metrics", "logs"]);
    expect(builderStore().graph.nodes.some((n) => n.id === traces.id || n.parentId === traces.id)).toBe(false);
    expect(pipelineNames(builderStore().text)).toEqual(["metrics", "logs"]);
    expect(toast.success).toHaveBeenCalledWith('Pipeline "traces" deleted', { className: "ph-no-capture" });
    expect(builderStore().selectedNode).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(builderStore().history.past.map((e) => e.description)).toEqual(["Delete pipeline traces"]);

    act(() => void builderStore().undo());
    expect(builderStore().text).toBe(STARTER);
    expect(componentsIn(groupNamed("traces"))).toEqual(["exporters.otlp", "processors.batch", "receivers.otlp"]);
  });

  it("Cancel in the dialog deletes nothing", async () => {
    openText(STARTER);
    const user = renderPanel();
    selectGroup("logs");
    await user.click(screen.getByRole("button", { name: "Delete pipeline" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    expect(builderStore().pendingDelete).toBeNull();
    expect(builderStore().text).toBe(STARTER);
    expect(builderStore().graph.pipelines).toHaveLength(3);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("is read-only while the canvas is locked", () => {
    openText(STARTER);
    renderPanel();
    selectGroup("logs");
    act(() => builderStore().setText(`${STARTER}# typing\n`));
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("privacy", () => {
  const PIPELINE = "zqpipelinemarkerzq";
  const LABEL = "zqlabelmarkerzq";
  const TEXT = [
    "receivers:",
    "  otlp:",
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    `    traces/${PIPELINE}:`,
    "      receivers: [otlp]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  function leaks(): string[] {
    const found: string[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        for (const marker of [PIPELINE, LABEL]) {
          if (attribute.value.includes(marker)) found.push(`${element.tagName}[${attribute.name}] has ${marker}`);
        }
      }
    }
    return found;
  }

  it("puts no pipeline name or label in any attribute: toolbox, actions, the group panel and the delete dialog", async () => {
    openText(TEXT);
    const receiver = builderStore().graph.nodes.find((n) => n.type === "receiver")!;
    useEditorStore.setState({
      graph: {
        ...builderStore().graph,
        nodes: builderStore().graph.nodes.map((n) => (n.id === receiver.id ? { ...n, data: { ...n.data, label: LABEL } } : n)),
      },
    });
    const user = userEvent.setup();
    render(
      <>
        <CollapsibleToolbox />
        <CanvasActions />
        <PipelineGroupConfigPanel />
      </>,
    );
    selectGroup(`traces/${PIPELINE}`);
    expect(screen.getByRole("heading", { level: 3, name: `traces/${PIPELINE}` })).toBeInTheDocument();
    expect(leaks()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Delete pipeline" }));
    expect(await screen.findByRole("alertdialog", { name: `Delete pipeline "traces/${PIPELINE}"?` })).toBeInTheDocument();
    expect(leaks()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    act(() => builderStore().requestDelete({ kind: "nodes", nodeIds: [receiver.id] }));
    expect(await screen.findByRole("alertdialog", { name: `Delete "${LABEL}"?` })).toBeInTheDocument();
    expect(leaks()).toEqual([]);
  });
});
