import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Canvas, MANUAL_EDIT_OVERLAY_MESSAGE, UNREADABLE_OVERLAY_MESSAGE } from "./Canvas.js";
import { answerValidation, attributeValues, REFUSAL } from "~/test/validation.js";
import { PALETTE_DRAG_TYPE, VIEWPORT_SAVE_DELAY_MS, VIEWPORT_STORAGE_KEY, writeViewport } from "./canvas-handlers.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { findPaletteEntry } from "~/lib/graph/palette.js";
import type { OTelNode } from "~/lib/graph/types.js";
import { PlaygroundContext } from "~/lib/playground/context.js";
import { sampleVisitor } from "~/lib/playground/sample/types.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, versionFixture } from "~/test/configurations.js";
import { installReactFlowMocks } from "~/test/react-flow-jsdom.js";

/*
 * The canvas in jsdom, with React Flow's documented mocks installed for this
 * file only. Dragging nodes and handles is pointer work jsdom can't do; the
 * browser tests and manual checks do it.
 */

const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

const VERSION_ID = "0199c000-0000-7000-8000-000000000001";
const OTHER_VERSION_ID = "0199c000-0000-7000-8000-000000000002";

function open(yamlContent: string, id = VERSION_ID, published = false) {
  const version = versionFixture({ id, yamlContent, ...(published ? PUBLISHED_FIELDS : {}) });
  store().load({ organizationId: GROUP_ID, configuration: MINE, version });
}

/** A drop at a point on the screen (jsdom's drag events carry no coordinates). */
function dropAt(target: Element, dataTransfer: object, clientX: number, clientY: number) {
  const event = createEvent.drop(target, { dataTransfer });
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } });
  fireEvent(target, event);
}

/** Lets React Flow measure the nodes (the mock observer reports after each commit) and draw the edges. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderCanvas() {
  const view = render(
    <div style={{ width: "1200px", height: "800px" }}>
      <Canvas />
    </div>,
  );
  await settle();
  return view;
}

function groupOf(name: string): OTelNode {
  const found = store().graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === name);
  if (!found) throw new Error(`no group ${name}`);
  return found;
}

function nodeOf(key: string, pipeline?: string): OTelNode {
  const groupId = pipeline === undefined ? undefined : groupOf(pipeline).id;
  const found = store().graph.nodes.find(
    (n) => n.type !== "pipelineGroup" && componentKey(n.data) === key && n.parentId === groupId,
  );
  if (!found) throw new Error(`no node ${key}`);
  return found;
}

function nodeElement(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!element) throw new Error(`node ${id} isn't drawn`);
  return element;
}

function handlesOf(id: string) {
  const handles = [...nodeElement(id).querySelectorAll<HTMLElement>(".react-flow__handle")];
  return {
    source: handles.filter((h) => h.classList.contains("source")),
    target: handles.filter((h) => h.classList.contains("target")),
  };
}

let restoreReactFlow: () => void;
beforeAll(() => {
  restoreReactFlow = installReactFlowMocks();
});
afterAll(() => restoreReactFlow());

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  window.localStorage.clear();
  vi.spyOn(toast, "warning").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the nodes", () => {
  it("render their label, subtitle, handles and the shared line", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();

    const receiver = nodeOf("receivers.otlp", "traces");
    const card = within(nodeElement(receiver.id));
    expect(card.getByText("OTLP")).toBeInTheDocument();
    expect(card.getByText("otlp")).toBeInTheDocument();
    // One component in three pipelines: the "N pipelines" line.
    expect(card.getByText("3 pipelines")).toBeInTheDocument();
    expect(handlesOf(receiver.id).source).toHaveLength(1);
    expect(handlesOf(receiver.id).target).toHaveLength(0);

    const batch = nodeOf("processors.batch", "traces");
    expect(within(nodeElement(batch.id)).getByText("Batch")).toBeInTheDocument();
    expect(handlesOf(batch.id).source).toHaveLength(1);
    expect(handlesOf(batch.id).target).toHaveLength(1);

    const exporter = nodeOf("exporters.otlp", "traces");
    expect(handlesOf(exporter.id).source).toHaveLength(0);
    expect(handlesOf(exporter.id).target).toHaveLength(1);

    const extension = nodeOf("extensions.health_check");
    expect(within(nodeElement(extension.id)).getByText("health_check")).toBeInTheDocument();
    expect(handlesOf(extension.id).source).toHaveLength(0);
    expect(handlesOf(extension.id).target).toHaveLength(0);
    expect(nodeElement(extension.id).querySelector(".border-dashed")).not.toBeNull();
    // Extensions are never shared across pipelines.
    expect(within(nodeElement(extension.id)).queryByText(/pipelines$/)).toBeNull();
  });

  it("shows no shared line for a component in one pipeline", async () => {
    open(corpusText("routing-connector.yaml"));
    await renderCanvas();
    const receiver = nodeOf("receivers.otlp", "traces/in");
    expect(within(nodeElement(receiver.id)).queryByText(/pipelines$/)).toBeNull();
  });

  it("gives connectors their signals, or '(same signal)', and routing an anchor-only port", async () => {
    open(corpusText("connector-memberships.yaml"));
    await renderCanvas();
    const spanmetrics = nodeOf("connectors.spanmetrics");
    expect(within(nodeElement(spanmetrics.id)).getByText("traces → metrics")).toBeInTheDocument();
    const forward = nodeOf("connectors.forward");
    expect(within(nodeElement(forward.id)).getByText("forward (same signal)")).toBeInTheDocument();
    expect(handlesOf(forward.id).source[0]).toHaveClass("connectable");
    expect(handlesOf(forward.id).target).toHaveLength(1);
  });

  it("makes a routing connector's outgoing port an anchor that can't be dragged from", async () => {
    open(corpusText("routing-connector.yaml"));
    await renderCanvas();
    const routing = nodeOf("connectors.routing");
    const [source] = handlesOf(routing.id).source;
    expect(source).not.toHaveClass("connectable");
    expect(source).toHaveClass("opacity-60");
  });

  it("gives groups their badge: the signal for a plain pipeline, the name for a named one", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();
    expect(within(nodeElement(groupOf("traces").id)).getByText("Traces")).toBeInTheDocument();
    expect(within(nodeElement(groupOf("metrics").id)).getByText("Metrics")).toBeInTheDocument();
    expect(within(nodeElement(groupOf("logs").id)).getByText("Logs")).toBeInTheDocument();
  });

  it("gives a named pipeline's group its name, and invisible anchors that can't be connected", async () => {
    open(corpusText("routing-connector.yaml"));
    await renderCanvas();
    const group = nodeElement(groupOf("traces/out").id);
    expect(within(group).getByText("traces/out")).toBeInTheDocument();
    const handles = [...group.querySelectorAll(".react-flow__handle")];
    expect(handles.map((h) => h.getAttribute("data-handleid")).sort()).toEqual(["anchor", "route"]);
    for (const handle of handles) {
      expect(handle).not.toHaveClass("connectable");
      expect(handle).toHaveClass("!opacity-0");
    }
  });
});

describe("the edges", () => {
  it("draw the pipelines' connections, and route edges with their chip, read-only", async () => {
    open(corpusText("routing-connector.yaml"));
    await renderCanvas();
    const routing = nodeOf("connectors.routing");
    const route = document.querySelector(`[data-testid="rf__edge-route-${routing.id}-${groupOf("traces/out").id}"]`);
    expect(route).not.toBeNull();
    expect(route).not.toHaveClass("selectable");
    expect(screen.getByText("1 route + default")).toBeInTheDocument();

    const plain = document.querySelectorAll(".react-flow__edge-smoothstep");
    expect(plain.length).toBeGreaterThan(0);
    for (const edge of plain) expect(edge).toHaveClass("selectable");
    expect(document.querySelectorAll(".tf-edge-flow").length).toBe(plain.length);
  });

  it("draw a connector's edge to its pipeline's group read-only", async () => {
    open(corpusText("connector-memberships.yaml"));
    await renderCanvas();
    const group = groupOf("traces/building");
    const edge = store().graph.edges.find((e) => e.target === group.id);
    expect(edge).toBeDefined();
    const drawn = document.querySelector(`[data-testid="rf__edge-${edge!.id}"]`);
    expect(drawn).not.toBeNull();
    expect(drawn).not.toHaveClass("selectable");
  });

  it("show a selected connection in the brand colour with a halo", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();
    const edge = store().graph.edges[0]!;
    act(() => store().applyEdgeChanges([{ type: "select", id: edge.id, selected: true }]));
    await settle();
    const drawn = document.querySelector(`[data-testid="rf__edge-${edge.id}"]`)!;
    expect(drawn.querySelector(`[id="${edge.id}-halo"]`)).not.toBeNull();
    expect(drawn.querySelector(".tf-edge-flow")?.getAttribute("style")).toContain("var(--color-brand");
  });
});

describe("dropping from the toolbox", () => {
  it("puts the component in the group under the pointer, relative to it, named 'Label (2)', selected", async () => {
    open(corpusText("starter.yaml"));
    // A remembered viewport at the origin: screen and canvas coordinates agree.
    writeViewport(VERSION_ID, { x: 0, y: 0, zoom: 1 });
    await renderCanvas();
    const traces = groupOf("traces");
    const payload = JSON.stringify(findPaletteEntry("receiver", "otlp"));
    const dataTransfer = { getData: (type: string) => (type === PALETTE_DRAG_TYPE ? payload : ""), dropEffect: "none" };
    const pane = document.querySelector(".react-flow")!;

    expect(fireEvent.dragOver(pane, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("move");
    dropAt(pane, dataTransfer, traces.position.x + 300, traces.position.y + 120);
    await settle();

    const dropped = store().graph.nodes.find((n) => n.data.label === "OTLP (2)");
    expect(dropped).toBeDefined();
    expect(dropped!.parentId).toBe(traces.id);
    expect(dropped!.position).toEqual({ x: 300, y: 120 });
    expect(dropped!.data.config).toEqual(findPaletteEntry("receiver", "otlp")!.defaultConfig);
    expect(store().selectedNode?.id).toBe(dropped!.id);
    expect(within(nodeElement(dropped!.id)).getByText("OTLP (2)")).toBeInTheDocument();
    expect(nodeElement(dropped!.id)).toHaveClass("selected");
  });

  it("ignores a drop that isn't a palette entry", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();
    const before = store().graph;
    dropAt(document.querySelector(".react-flow")!, { getData: () => "plain text" }, 10, 10);
    expect(store().graph).toBe(before);
  });
});

describe("selecting and deleting", () => {
  it("selects a clicked node, and a click on the pane clears it", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();
    const batch = nodeOf("processors.batch", "traces");
    fireEvent.click(nodeElement(batch.id));
    await settle();
    expect(store().selectedNode?.id).toBe(batch.id);
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    await settle();
    expect(store().selectedNode).toBeNull();
  });

  it("leaves Backspace and Delete to the delete dialog: React Flow deletes nothing", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();
    const batch = nodeOf("processors.batch", "traces");
    act(() => store().applyNodeChanges([{ type: "select", id: batch.id, selected: true }]));
    await settle();
    const nodes = store().graph.nodes.length;
    const text = store().text;
    fireEvent.keyDown(nodeElement(batch.id), { key: "Backspace" });
    fireEvent.keyDown(document.body, { key: "Delete" });
    await settle();
    expect(store().graph.nodes).toHaveLength(nodes);
    expect(store().text).toBe(text);
  });
});

describe("the overlays", () => {
  it("shows manual edit mode's message, with its validation chip, and locks the nodes", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();
    const batch = nodeOf("processors.batch", "traces");
    expect(nodeElement(batch.id)).toHaveClass("draggable");
    expect(nodeElement(batch.id)).toHaveClass("selectable");
    expect(nodeElement(batch.id)).toHaveAttribute("tabindex", "0");

    act(() => store().setText(`${store().text}# typed\n`));
    await settle();

    expect(screen.getByText(MANUAL_EDIT_OVERLAY_MESSAGE)).toBeInTheDocument();
    // The typed text is due to be checked.
    expect(screen.getByText("Validating...")).toBeInTheDocument();
    expect(screen.queryByText(UNREADABLE_OVERLAY_MESSAGE)).toBeNull();
    const locked = nodeElement(batch.id);
    expect(locked).not.toHaveClass("draggable");
    expect(locked).not.toHaveClass("selectable");
    expect(locked).not.toHaveAttribute("tabindex");
    for (const handle of locked.querySelectorAll(".react-flow__handle")) expect(handle).not.toHaveClass("connectable");

    act(() => store().undoAll());
    await settle();
    expect(screen.queryByText(MANUAL_EDIT_OVERLAY_MESSAGE)).toBeNull();
    expect(nodeElement(batch.id)).toHaveClass("draggable");
  });


  it("its chip says what the validator made of the typed text: hidden while idle, then its four texts", async () => {
    open(corpusText("starter.yaml"));
    const { container } = await renderCanvas();
    const chips = ["Validating...", "Yaml is Valid", "Validation unavailable — YAML not checked.", "Errors must be corrected."];
    const shown = () => chips.filter((chip) => screen.queryByText(chip) !== null);

    // Out of manual edit mode: no overlay, no chip.
    answerValidation({ status: "valid", collectorVersion: "0.162.0", requirements: [] });
    await settle();
    expect(shown()).toEqual([]);

    act(() => store().setText(""));
    await settle();
    // Idle (empty text): the overlay, no chip.
    expect(screen.getByText(MANUAL_EDIT_OVERLAY_MESSAGE)).toBeInTheDocument();
    expect(shown()).toEqual([]);

    act(() => store().setText(`${corpusText("starter.yaml")}# typed\n`));
    await settle();
    expect(shown()).toEqual(["Validating..."]);

    act(() => answerValidation({ status: "valid", collectorVersion: "0.162.0", requirements: [] }));
    expect(shown()).toEqual(["Yaml is Valid"]);

    act(() => answerValidation({ status: "unavailable", message: "Validation is unavailable. Your YAML was not checked — retry shortly." }));
    expect(shown()).toEqual(["Validation unavailable — YAML not checked."]);

    act(() => answerValidation({ status: "retired", collectorVersion: "0.155.0" }));
    expect(shown()).toEqual(["Validation unavailable — YAML not checked."]);

    act(() => answerValidation({ status: "invalid", collectorVersion: "0.162.0", errors: [REFUSAL], requirements: [] }));
    expect(shown()).toEqual(["Errors must be corrected."]);
    // The chip says nothing of the message or the path, in text or in an attribute.
    expect(container).not.toHaveTextContent("marker-message-9c2e");
    expect(attributeValues(container).filter((value) => /marker-(message|path)/.test(value))).toEqual([]);

    act(() => answerValidation({ status: "idle" }));
    expect(shown()).toEqual([]);
  });

  it("says the text can't be shown, with the reason as text, never in an attribute", async () => {
    open("receivers:\n  otlp: {}\n  otlp: {}\n");
    await renderCanvas();
    const reason = store().graphStatus;
    expect(reason).not.toBe("ready");
    const why = (reason as { unreadable: string }).unreadable;

    expect(screen.getByText(UNREADABLE_OVERLAY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(why)).toBeInTheDocument();
    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of element.attributes) expect(attribute.value).not.toContain(why);
    }
    expect(screen.queryByText(MANUAL_EDIT_OVERLAY_MESSAGE)).toBeNull();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });
});

describe("a published version: read-only, its own mode", () => {
  it("has no overlay; nodes can be selected and focused, never dragged or connected", async () => {
    open(corpusText("starter.yaml"), VERSION_ID, true);
    await renderCanvas();
    const batch = nodeOf("processors.batch", "traces");

    expect(screen.queryByText(MANUAL_EDIT_OVERLAY_MESSAGE)).toBeNull();
    expect(screen.queryByText(UNREADABLE_OVERLAY_MESSAGE)).toBeNull();
    const node = nodeElement(batch.id);
    expect(node).not.toHaveClass("draggable");
    expect(node).toHaveClass("selectable");
    expect(node).toHaveAttribute("tabindex", "0");
    for (const handle of node.querySelectorAll(".react-flow__handle")) expect(handle).not.toHaveClass("connectable");

    fireEvent.click(node);
    await settle();
    expect(store().selectedNode?.id).toBe(batch.id);
    expect(nodeElement(batch.id)).toHaveClass("selected");
  });

  it("shows no resizer on a selected group", async () => {
    open(corpusText("starter.yaml"), VERSION_ID, true);
    await renderCanvas();
    const traces = groupOf("traces");
    act(() => store().applyNodeChanges([{ type: "select", id: traces.id, selected: true }]));
    await settle();
    expect(nodeElement(traces.id)).toHaveClass("selected");
    expect(nodeElement(traces.id).querySelector(".react-flow__resize-control")).toBeNull();
  });

  it("a draft's selected group shows its resizer (what the test above refuses)", async () => {
    open(corpusText("starter.yaml"));
    await renderCanvas();
    const traces = groupOf("traces");
    act(() => store().applyNodeChanges([{ type: "select", id: traces.id, selected: true }]));
    await settle();
    expect(nodeElement(traces.id).querySelector(".react-flow__resize-control")).not.toBeNull();
  });

  it("takes no drop from the toolbox", async () => {
    open(corpusText("starter.yaml"), VERSION_ID, true);
    writeViewport(VERSION_ID, { x: 0, y: 0, zoom: 1 });
    await renderCanvas();
    const traces = groupOf("traces");
    const payload = JSON.stringify(findPaletteEntry("receiver", "otlp"));
    const dataTransfer = { getData: (type: string) => (type === PALETTE_DRAG_TYPE ? payload : ""), dropEffect: "none" };
    const pane = document.querySelector(".react-flow")!;
    const before = store().graph;

    fireEvent.dragOver(pane, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    dropAt(pane, dataTransfer, traces.position.x + 300, traces.position.y + 120);
    await settle();

    expect(store().graph).toBe(before);
    expect(store().text).toBe(store().savedText);
  });

  it("deletes nothing on Backspace or Delete", async () => {
    open(corpusText("starter.yaml"), VERSION_ID, true);
    await renderCanvas();
    const batch = nodeOf("processors.batch", "traces");
    fireEvent.click(nodeElement(batch.id));
    await settle();
    const nodes = store().graph.nodes.length;
    fireEvent.keyDown(nodeElement(batch.id), { key: "Backspace" });
    fireEvent.keyDown(document.body, { key: "Delete" });
    act(() => store().requestDelete());
    await settle();
    expect(store().graph.nodes).toHaveLength(nodes);
    expect(store().pendingDelete).toBeNull();
  });
});

describe("privacy", () => {
  const LABEL = "zqlabelmarkerzq";
  const INSTANCE = "zqinstancemarkerzq";
  const PIPELINE = "zqpipelinemarkerzq";
  const VALUE = "zqvaluemarkerzq";
  const TEXT = [
    "receivers:",
    `  otlp/${INSTANCE}:`,
    "    protocols:",
    "      grpc:",
    `        endpoint: ${VALUE}:4317`,
    "processors:",
    "  batch:",
    "exporters:",
    "  debug:",
    `    verbosity: ${VALUE}`,
    "connectors:",
    "  routing:",
    "    default_pipelines:",
    `      - traces/${PIPELINE}`,
    "service:",
    "  pipelines:",
    `    traces/${PIPELINE}:`,
    `      receivers: [otlp/${INSTANCE}, routing]`,
    "      processors: [batch]",
    "      exporters: [debug]",
    "    traces:",
    `      receivers: [otlp/${INSTANCE}]`,
    "      exporters: [routing]",
    "",
  ].join("\n");

  it("puts no label, instance name, pipeline name or config value in any attribute", async () => {
    open(TEXT);
    // A label a person could give (the component forms, or a future rename).
    const batch = nodeOf("processors.batch", `traces/${PIPELINE}`);
    useEditorStore.setState({
      graph: {
        ...store().graph,
        nodes: store().graph.nodes.map((n) => (n.id === batch.id ? { ...n, data: { ...n.data, label: LABEL } } : n)),
      },
    });
    await renderCanvas();

    // Selected things draw more: the resizer, the halo.
    const group = groupOf(`traces/${PIPELINE}`);
    act(() => {
      store().applyNodeChanges([
        { type: "select", id: group.id, selected: true },
        { type: "select", id: batch.id, selected: true },
      ]);
      store().applyEdgeChanges(store().graph.edges.map((e) => ({ type: "select" as const, id: e.id, selected: true })));
    });
    await settle();

    // The markers are on the canvas, as text.
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getAllByText(`OTLP (${INSTANCE})`).length).toBeGreaterThan(0);
    expect(screen.getByText(`traces/${PIPELINE}`)).toBeInTheDocument();
    expect(document.querySelector(".react-flow__minimap-node")).not.toBeNull();
    expect(document.querySelector(".react-flow__resize-control")).not.toBeNull();
    expect(document.querySelectorAll(".react-flow__edge").length).toBeGreaterThan(2);

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        for (const marker of [LABEL, INSTANCE, PIPELINE, VALUE]) {
          if (attribute.value.includes(marker)) leaks.push(`${element.tagName}[${attribute.name}] has ${marker}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    // A config value isn't shown on the canvas at all.
    expect(document.body.textContent).not.toContain(VALUE);
  });
});

describe("the viewport", () => {
  function viewportTransform(): string {
    return document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
  }

  it("opens at the viewport remembered for the version, and remembers a zoom", async () => {
    open(corpusText("starter.yaml"));
    writeViewport(VERSION_ID, { x: 12, y: -40, zoom: 1.25 });
    await renderCanvas();
    expect(viewportTransform()).toBe("translate(12px,-40px) scale(1.25)");

    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(VIEWPORT_STORAGE_KEY)!)[VERSION_ID];
      expect(saved.zoom).toBeGreaterThan(1.25);
    });
  });

  it("inside the playground, neither opens at a remembered viewport nor remembers one", async () => {
    open(corpusText("starter.yaml"));
    writeViewport(VERSION_ID, { x: 12, y: -40, zoom: 1.25 });
    const before = window.localStorage.getItem(VIEWPORT_STORAGE_KEY);
    const value = { visitor: sampleVisitor(), lock: () => undefined, catalogue: [], openSignInToSave: () => undefined };
    render(
      <PlaygroundContext.Provider value={value}>
        <div style={{ width: "1200px", height: "800px" }}>
          <Canvas />
        </div>
      </PlaygroundContext.Provider>,
    );
    await settle();
    expect(viewportTransform()).not.toBe("translate(12px,-40px) scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    // Past the save's delay, by which a signed-in zoom is written (the test above).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, VIEWPORT_SAVE_DELAY_MS * 2));
    });
    expect(window.localStorage.getItem(VIEWPORT_STORAGE_KEY)).toBe(before);
  });

  it("opens another version at its own viewport", async () => {
    open(corpusText("starter.yaml"));
    writeViewport(VERSION_ID, { x: 12, y: -40, zoom: 1.25 });
    writeViewport(OTHER_VERSION_ID, { x: -300, y: 20, zoom: 0.75 });
    await renderCanvas();
    expect(viewportTransform()).toBe("translate(12px,-40px) scale(1.25)");
    act(() => open(corpusText("routing-connector.yaml"), OTHER_VERSION_ID));
    await settle();
    expect(viewportTransform()).toBe("translate(-300px,20px) scale(0.75)");
  });

  it("fits the view when none is remembered, and again after Tidy up", async () => {
    open(corpusText("starter.yaml"));
    writeViewport(VERSION_ID, { x: 12, y: -40, zoom: 1.25 });
    await renderCanvas();
    act(() => {
      store().tidyUp();
    });
    await waitFor(() => expect(viewportTransform()).not.toBe("translate(12px,-40px) scale(1.25)"));

    window.localStorage.clear();
    act(() => open(corpusText("starter.yaml"), OTHER_VERSION_ID));
    await settle();
    await waitFor(() => expect(viewportTransform()).not.toBe("translate(0px,0px) scale(1)"));
  });
});
