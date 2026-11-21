import type { ConfigurationVersion } from "@telflo/contracts";
import { renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  CANT_EDIT_ON_CANVAS_MESSAGE,
  EDIT_SELF_MONITORING,
  HISTORY_DEPTH,
  selectCanRedo,
  selectCanUndo,
  selectIsCanvasLocked,
  selectIsDirty,
  selectRedoDescription,
  selectUndoDescription,
  useEditorStore,
  type EditorState,
} from "./editor-store.js";
import { layoutSignature } from "~/lib/graph/canvas-operations.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { deriveModel, readTextModel, renamedModel } from "~/lib/graph/model.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import { editText, modelsEqual, type ValueChange } from "~/lib/graph/text-edits.js";
import type { Graph, OTelNode } from "~/lib/graph/types.js";
import { useSharedCount } from "~/hooks/useSharedCount.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";
import { lineDiff } from "~/test/text-edit-checks.js";

const STARTER = corpusText("starter.yaml");

const initialState = useEditorStore.getState();

function versionOf(yamlContent: string, stored: Partial<Pick<ConfigurationVersion, "nodes" | "edges" | "pipelines">> = {}) {
  return versionFixture({ yamlContent, ...stored });
}

function open(yaml: string, stored?: Partial<Pick<ConfigurationVersion, "nodes" | "edges" | "pipelines">>) {
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: versionOf(yaml, stored) });
}

const store = () => useEditorStore.getState();

function isDirty(): boolean {
  return selectIsDirty(store());
}

/** A component node, by its key and its pipeline's name (none for an ungrouped one). */
function nodeOf(key: string, pipeline?: string, graph: Graph = store().graph): OTelNode {
  const groups = new Map(graph.nodes.filter((n) => n.type === "pipelineGroup").map((n) => [n.id, n.data.label]));
  const found = graph.nodes.find(
    (n) =>
      n.type !== "pipelineGroup" &&
      componentKey(n.data) === key &&
      (n.parentId === undefined ? undefined : groups.get(n.parentId)) === pipeline,
  );
  if (!found) throw new Error(`no node ${key} in ${pipeline ?? "no pipeline"}`);
  return found;
}

function groupOf(name: string, graph: Graph = store().graph): OTelNode {
  const found = graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === name);
  if (!found) throw new Error(`no group ${name}`);
  return found;
}

function paletteId(type: string, subType: string): string {
  const entry = componentPalette.find((e) => e.type === type && e.subType === subType);
  if (!entry) throw new Error("no palette entry");
  return entry.id;
}

/** A point inside a group, absolute. */
function inside(group: OTelNode, dx = 20, dy = 20) {
  return { x: group.position.x + dx, y: group.position.y + dy };
}

/** The text describes the graph: reading it back gives the graph's model. */
function expectTextDescribesGraph(state: EditorState = store()) {
  const parsed = parse(state.text);
  if (!parsed.ok) throw new Error(parsed.reason);
  const textModel = readTextModel(parsed.document);
  expect(modelsEqual(textModel, deriveModel(state.graph, textModel))).toBe(true);
}

/** A graph's edges as `source > target` by component key and pipeline, sorted: ids aside, what's drawn. */
function edgeSignatures(graph: Graph): string[] {
  const groups = new Map(graph.nodes.filter((n) => n.type === "pipelineGroup").map((n) => [n.id, n.data.label]));
  const name = (id: string) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return `?${id}`;
    if (node.type === "pipelineGroup") return `[${node.data.label}]`;
    return node.parentId === undefined ? componentKey(node.data) : `${componentKey(node.data)}@${groups.get(node.parentId)}`;
  };
  return graph.edges.map((e) => `${name(e.source)} > ${name(e.target)}`).sort();
}

/** The store's edges are the ones a fresh parse of its text draws. */
function expectEdgesAsParsed(state: EditorState = store()) {
  const parsed = parse(state.text);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(edgeSignatures(state.graph)).toEqual(edgeSignatures(parsed.graph));
}

/** One entry was taken, holding what was before, with `description`. */
function expectOneEntry(before: EditorState, description: string) {
  const { past, future } = store().history;
  expect(past).toHaveLength(before.history.past.length + 1);
  expect(past.at(-1)).toEqual({ text: before.text, graph: before.graph, description });
  expect(past.at(-1)!.graph).toBe(before.graph);
  expect(future).toEqual([]);
}

/**
 * The text the change must have written: `editText` from the text's
 * own model to the graph's.
 */
function expectWrittenByEditText(before: EditorState, renames: { from: string; to: string }[] = []) {
  const parsed = parse(before.text);
  if (!parsed.ok) throw new Error(parsed.reason);
  const textModel = readTextModel(parsed.document);
  const order = renames.length > 0 ? renamedModel(textModel, renames) : textModel;
  expect(store().text).toBe(editText(before.text, textModel, deriveModel(store().graph, order), { renames }).text);
}

let now = 1_000_000;

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.restoreAllMocks();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets the throttle's run end. */
function pause(ms = 1000) {
  now += ms;
}

describe("load", () => {
  it("never changes the text, and nothing is dirty, undoable or selected", () => {
    const crlf = corpusText("crlf.yaml");
    for (const text of [STARTER, crlf, corpusText("comments.yaml"), ""]) {
      open(text);
      const state = store();
      expect(state.text).toBe(text);
      expect(state.savedText).toBe(text);
      expect(state.graphStatus).toBe("ready");
      expect(state.document).not.toBeNull();
      expect(isDirty()).toBe(false);
      expect(state.history).toEqual({ past: [], future: [] });
      expect(state.selectedNode).toBeNull();
      expect(state.selectedNodes).toEqual([]);
      expect(state.isYamlEditing).toBe(false);
    }
  });

  it("lays out a version with '[]' in the three columns as the parser does", () => {
    open(STARTER);
    const parsed = parse(STARTER);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(store().graph).toEqual(parsed.graph);
    expect(store().graph.pipelines.map((p) => p.name)).toEqual(["traces", "metrics", "logs"]);
  });

  it("applies a stored layout by pipeline name and component key, even after the pipeline's id changed", () => {
    open(STARTER);
    store().applyNodeChanges([
      { id: groupOf("metrics").id, type: "position", position: { x: 1500, y: 40 } },
      { id: nodeOf("processors.batch", "metrics").id, type: "position", position: { x: 333, y: 77 } },
    ]);
    store().setPipelineColor(store().graph.pipelines.find((p) => p.name === "metrics")!.id, "#ec4899");
    const stored = toStored(store().graph);
    // Another writer numbered the pipelines differently.
    const renumbered = JSON.parse(
      JSON.stringify(stored).replace(/"(group|pipeline)_(\d)"/g, (_match, prefix: string, n: string) => `"${prefix}_${Number(n) + 7}"`),
    ) as typeof stored;
    expect(renumbered.pipelines.map((p) => p.id)).toEqual(["pipeline_7", "pipeline_8", "pipeline_9"]);

    open(STARTER, renumbered);

    expect(store().text).toBe(STARTER);
    expect(groupOf("metrics").position).toEqual({ x: 1500, y: 40 });
    expect(groupOf("metrics").data.color).toBe("#ec4899");
    expect(store().graph.pipelines.find((p) => p.name === "metrics")?.color).toBe("#ec4899");
    expect(nodeOf("processors.batch", "metrics").position).toEqual({ x: 333, y: 77 });
    expect(isDirty()).toBe(false);
  });

  it("drops stored entries the text no longer names, and places what the layout lacks by the parser's layout", () => {
    open(STARTER);
    const stored = toStored(store().graph);
    const extraGroup = { ...stored.nodes.find((n) => n.type === "pipelineGroup")!, id: "group_9" };
    const staleGroup = { ...extraGroup, data: { ...extraGroup.data, label: "logs/gone", pipelineId: "pipeline_9" } };
    const staleNode = {
      ...stored.nodes.find((n) => n.data.componentSubType === "otlp" && n.type === "receiver")!,
      id: "node_99",
      parentId: "group_9",
    };
    const withDebug = STARTER.replace("extensions:\n  health_check:", "  debug: {}\nextensions:\n  health_check:");

    open(withDebug, {
      ...stored,
      nodes: [...stored.nodes, staleGroup, staleNode],
      edges: [...stored.edges, { id: "edge_90", source: "node_99", target: "node_98", type: "smoothstep" }],
      pipelines: [...stored.pipelines, { id: "pipeline_9", name: "logs/gone", signalType: "logs", color: "#ef4444" }],
    });

    const graph = store().graph;
    expect(graph.nodes.some((n) => n.data.label === "logs/gone")).toBe(false);
    expect(graph.pipelines.map((p) => p.name)).toEqual(["traces", "metrics", "logs"]);
    const parsed = parse(withDebug);
    if (!parsed.ok) throw new Error(parsed.reason);
    // The new exporter, unknown to the layout, is where the parser put it.
    expect(nodeOf("exporters.debug").position).toEqual(nodeOf("exporters.debug", undefined, parsed.graph).position);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  it("puts a pipeline the layout doesn't hold below the groups it does", () => {
    open(STARTER);
    const stored = toStored(store().graph);
    const withNew = STARTER.replace("    logs:\n", "    logs/extra:\n      receivers: [otlp]\n      exporters: [otlp]\n    logs:\n");

    open(withNew, stored);

    const groups = store().graph.nodes.filter((n) => n.type === "pipelineGroup");
    const extra = groupOf("logs/extra");
    const bottom = Math.max(
      ...groups.filter((g) => g !== extra).map((g) => g.position.y + (g.style?.height as number)),
    );
    expect(extra.position.y).toBeGreaterThan(bottom);
  });

  it("text the canvas can't show: its reason, an empty graph, the text untouched, and the canvas locked", () => {
    const unreadable = "receivers: [otlp]\n";
    open(unreadable);

    const state = store();
    expect(state.text).toBe(unreadable);
    expect(state.graphStatus).toEqual({ unreadable: expect.stringContaining("receivers must be a mapping") });
    expect(state.graph).toEqual({ nodes: [], edges: [], pipelines: [] });
    expect(state.document).toBeNull();
    expect(selectIsCanvasLocked(state)).toBe(true);
    expect(isDirty()).toBe(false);

    expect(store().dropComponent(paletteId("receiver", "otlp"), { x: 0, y: 0 })).toBeNull();
    expect(store().addPipeline("traces/more")).toBeNull();
    expect(store().tidyUp()).toBe(false);
    expect(store().text).toBe(unreadable);
    expect(store().history.past).toEqual([]);
  });

  it("clears the history and the selection of what was open before", () => {
    open(STARTER);
    store().selectNode(nodeOf("receivers.otlp", "traces").id);
    store().tidyUp();
    store().undo();
    expect(store().history.future).toHaveLength(1);

    open(STARTER);

    expect(store().history).toEqual({ past: [], future: [] });
    expect(store().selectedNode).toBeNull();
  });
});

describe("every change writes the text through the text edits, and takes one entry", () => {
  it("drops a palette entry into the group under it, relative to it, named 'Label (n)', with its own config, selected", () => {
    open(STARTER);
    const traces = groupOf("traces");
    const before = store();

    const node = store().dropComponent(paletteId("receiver", "otlp"), inside(traces, 40, 60))!;

    expect(node.parentId).toBe(traces.id);
    expect(node.position).toEqual({ x: 40, y: 60 });
    expect(node.data.label).toBe("OTLP (2)");
    expect(node.data.instanceName).toBe("2");
    const entry = componentPalette.find((e) => e.id === paletteId("receiver", "otlp"))!;
    expect(node.data.config).toEqual(entry.defaultConfig);
    expect(node.data.config).not.toBe(entry.defaultConfig);
    expect(Object.isFrozen(node.data.config)).toBe(false);
    expect(store().selectedNode?.id).toBe(node.id);
    expect(store().selectedNodes.map((n) => n.id)).toEqual([node.id]);
    expect(store().graph.nodes.find((n) => n.id === node.id)?.selected).toBe(true);

    expectOneEntry(before, "Add OTLP (2)");
    expectWrittenByEditText(before);
    expect(store().text).toContain("  otlp/2:\n");
    expect(store().text).toContain("receivers: [otlp, otlp/2]");
    expect(store().text.startsWith("# OpenTelemetry Collector Configuration\n# Generated by Telflo\n")).toBe(true);
    expect(isDirty()).toBe(true);

    const second = store().dropComponent(paletteId("receiver", "otlp"), { x: -5000, y: -5000 })!;
    expect(second.parentId).toBeUndefined();
    expect(second.data.label).toBe("OTLP (3)");
    expect(second.data.config).not.toBe(node.data.config);
  });

  it("an empty new configuration's first drop writes all three default pipelines, and reopening shows three groups", () => {
    open("");
    expect(store().graph.pipelines.map((p) => p.name)).toEqual(["traces", "metrics", "logs"]);

    store().dropComponent(paletteId("receiver", "otlp"), inside(groupOf("metrics")));

    expectTextDescribesGraph();
    const text = store().text;
    expect(text).toMatch(/pipelines:\n {4}traces:/);
    expect(text).toMatch(/metrics:\n {6}receivers: \[otlp\]/);
    expect(text).toMatch(/logs:/);

    open(text, toStored(store().graph));
    expect(store().graph.nodes.filter((n) => n.type === "pipelineGroup").map((n) => n.data.label)).toEqual([
      "traces",
      "metrics",
      "logs",
    ]);
    expect(nodeOf("receivers.otlp", "metrics")).toBeDefined();
  });

  it("connects two nodes (one entry, 'Connect nodes'), and refuses the connections the canvas refuses", () => {
    open(corpusText("minimal-pipeline.yaml"));
    const receiver = store().graph.nodes.find((n) => n.data.componentType === "receiver")!;
    const exporter = store().graph.nodes.find((n) => n.data.componentType === "exporter")!;
    const group = groupOf(store().graph.pipelines[0]!.name);
    store().dropComponent(paletteId("processor", "batch"), inside(group, 400, 100));
    const processor = store().graph.nodes.find((n) => n.data.componentType === "processor")!;
    pause();

    expect(store().connect({ source: exporter.id, target: processor.id })).toEqual({ ok: false });
    expect(store().connect({ source: processor.id, target: receiver.id })).toEqual({ ok: false });
    expect(store().connect({ source: group.id, target: processor.id })).toEqual({ ok: false });
    expect(store().connect({ source: receiver.id, target: receiver.id })).toEqual({ ok: false });

    const before = store();
    expect(store().connect({ source: receiver.id, target: processor.id })).toEqual({ ok: true });
    expectOneEntry(before, "Connect nodes");
    expectWrittenByEditText(before);
    expect(store().graph.edges.at(-1)).toMatchObject({ source: receiver.id, target: processor.id, type: "smoothstep" });
    expect(store().graph.edges.at(-1)!.id).toMatch(/^edge_\d+$/);
    // Already connected.
    expect(store().connect({ source: receiver.id, target: processor.id })).toEqual({ ok: false });
  });

  it("refuses an extension and a routing connector's drawn edge", () => {
    open(corpusText("routing-connector.yaml"));
    const routing = store().graph.nodes.find((n) => n.data.componentSubType === "routing")!;
    const exporter = store().graph.nodes.find((n) => n.data.componentType === "exporter")!;
    expect(store().connect({ source: routing.id, target: exporter.id })).toEqual({ ok: false });

    open(STARTER);
    const extension = store().graph.nodes.find((n) => n.data.componentType === "extension")!;
    expect(store().connect({ source: extension.id, target: nodeOf("exporters.otlp", "traces").id })).toEqual({ ok: false });
    expect(store().connect({ source: nodeOf("receivers.otlp", "traces").id, target: extension.id })).toEqual({ ok: false });
    expect(store().history.past).toEqual([]);
  });

  it("returns the connector signal warnings for the canvas to toast", () => {
    open(STARTER);
    const spanmetrics = store().dropComponent(paletteId("connector", "spanmetrics"), { x: -3000, y: -3000 })!;
    pause();

    expect(store().connect({ source: nodeOf("processors.batch", "metrics").id, target: spanmetrics.id })).toEqual({
      ok: false,
      warning: { title: "Spanmetrics requires traces input", description: "The source node is in a metrics pipeline" },
    });
    expect(store().connect({ source: spanmetrics.id, target: nodeOf("exporters.otlp", "logs").id })).toEqual({
      ok: false,
      warning: { title: "Spanmetrics outputs metrics", description: "The target node is in a logs pipeline" },
    });
    const before = store();
    expect(store().connect({ source: nodeOf("processors.batch", "traces").id, target: spanmetrics.id })).toEqual({ ok: true });
    // The group adopts the ungrouped end, a connector included. The
    // version is pinned to 0.162.0, which knows spanmetrics as span_metrics
    // (since 0.151.0): the palette writes that.
    expectOneEntry(before, "Add Spanmetrics to traces");
    expect(store().text).toContain("exporters: [otlp, span_metrics]");
  });

  it("adopts an ungrouped end into the other's group on connect, in the same entry", () => {
    open(STARTER);
    const debug = store().dropComponent(paletteId("exporter", "debug"), { x: -3000, y: -3000 })!;
    pause();
    const before = store();

    expect(store().connect({ source: nodeOf("processors.batch", "logs").id, target: debug.id })).toEqual({ ok: true });

    expectOneEntry(before, `Add ${debug.data.label} to logs`);
    expect(store().graph.nodes.find((n) => n.id === debug.id)?.parentId).toBe(groupOf("logs").id);
    expectWrittenByEditText(before);
    expect(store().text).toContain("exporters: [otlp, debug]");
  });

  it("moves a component into another group, and out of every group", () => {
    open(STARTER);
    const before = store();
    const otlp = nodeOf("exporters.otlp", "logs");

    expect(store().moveNodeToGroup(otlp.id, null)).toBe(true);
    expectOneEntry(before, "Move OTLP");
    expectWrittenByEditText(before);
    expect(store().graph.nodes.find((n) => n.id === otlp.id)?.parentId).toBeUndefined();
    const logs = parse(store().text);
    if (!logs.ok) throw new Error(logs.reason);
    expect(readTextModel(logs.document).pipelines.get("logs")?.exporters).toEqual([]);
    expectTextDescribesGraph();

    pause();
    expect(store().moveNodeToGroup(otlp.id, groupOf("traces").id)).toBe(true);
    expectTextDescribesGraph();
  });

  it("a drag is one entry: its moves, and the group it ends in", () => {
    open(STARTER);
    const otlp = nodeOf("exporters.otlp", "logs");
    const traces = groupOf("traces");
    const logs = groupOf("logs");
    const before = store();
    const into = { x: traces.position.x + 700 - logs.position.x, y: traces.position.y + 60 - logs.position.y };

    for (let step = 1; step <= 5; step++) {
      store().applyNodeChanges([
        { id: otlp.id, type: "position", position: { x: into.x * (step / 5), y: into.y * (step / 5) }, dragging: true },
      ]);
      now += 100;
    }
    store().applyNodeChanges([{ id: otlp.id, type: "position", position: into, dragging: false }]);
    expect(store().text).toBe(STARTER);
    expect(store().finishMove([otlp.id])).toBe(true);

    expectOneEntry(before, "Move OTLP");
    expect(store().graph.nodes.find((n) => n.id === otlp.id)?.parentId).toBe(traces.id);
    expectTextDescribesGraph();
    expect(store().text).not.toBe(STARTER);
  });

  it("resizes a group: layout only, or a change of the text when a child is left outside", () => {
    open(STARTER);
    const traces = groupOf("traces");
    const before = store();

    store().applyNodeChanges([
      { id: traces.id, type: "dimensions", dimensions: { width: 2000, height: 600 }, resizing: true, setAttributes: true },
    ]);
    expectOneEntry(before, "Resize traces");
    expect(store().text).toBe(STARTER);
    expect(groupOf("traces").style).toMatchObject({ width: 2000, height: 600 });
    expect(isDirty()).toBe(true);

    pause();
    const shrinking = store();
    expect(store().resizeGroup(traces.id, { width: 20, height: 20 })).toBe(true);
    expectOneEntry(shrinking, "Resize traces");
    expect(store().graph.nodes.filter((n) => n.parentId === traces.id)).toEqual([]);
    expectWrittenByEditText(shrinking);
    expect(store().text).toMatch(/traces:\n\s+receivers: \[\]/);
  });

  it("keeps a resized group's size in its style alone, so Tidy up's size is the one drawn and saved", () => {
    open(STARTER);
    const traces = groupOf("traces");
    const laidOut = { width: traces.style?.width, height: traces.style?.height };

    // React Flow's resizer sets the node's own width and height, which it draws before the style.
    store().applyNodeChanges([
      { id: traces.id, type: "dimensions", dimensions: { width: 2000, height: 600 }, resizing: true, setAttributes: true },
    ]);
    expect(groupOf("traces")).not.toHaveProperty("width");
    expect(groupOf("traces")).not.toHaveProperty("height");
    expect(groupOf("traces").style).toMatchObject({ width: 2000, height: 600 });

    pause();
    store().tidyUp();

    expect(groupOf("traces")).not.toHaveProperty("width");
    expect(groupOf("traces").style).toMatchObject(laidOut);
    expect(toStored(store().graph).nodes.find((n) => n.id === traces.id)).toMatchObject({ style: laidOut });
  });

  it("deletes components through the dialog: asking deletes nothing, Cancel keeps them, Delete removes them", () => {
    open(STARTER);
    const success = vi.spyOn(toast, "success");
    const batch = nodeOf("processors.batch", "traces");
    store().setSelection([batch.id]);

    store().requestDelete();
    expect(store().pendingDelete).toEqual({ kind: "nodes", nodeIds: [batch.id] });
    expect(store().text).toBe(STARTER);
    store().cancelDelete();
    expect(store().pendingDelete).toBeNull();
    expect(store().graph.nodes.some((n) => n.id === batch.id)).toBe(true);

    store().requestDelete();
    const before = store();
    store().confirmDelete();

    expect(store().pendingDelete).toBeNull();
    expect(store().graph.nodes.some((n) => n.id === batch.id)).toBe(false);
    expect(store().graph.edges.some((e) => e.source === batch.id || e.target === batch.id)).toBe(false);
    expect(store().selectedNodes).toEqual([]);
    expectOneEntry(before, "Delete Batch");
    expectWrittenByEditText(before);
    expect(success).toHaveBeenCalledWith("Deleted 1 node");
  });

  it("deletes several components in one entry, 'Deleted N nodes'", () => {
    open(STARTER);
    const success = vi.spyOn(toast, "success");
    store().setSelection([nodeOf("processors.batch", "traces").id, nodeOf("exporters.otlp", "logs").id]);
    const before = store();

    store().requestDelete();
    store().confirmDelete();

    expectOneEntry(before, "Delete 2 nodes");
    expectTextDescribesGraph();
    expect(success).toHaveBeenCalledWith("Deleted 2 nodes");
  });

  it("deletes a pipeline with its components through the same dialog", () => {
    open(STARTER);
    const success = vi.spyOn(toast, "success");
    const metrics = store().graph.pipelines.find((p) => p.name === "metrics")!;
    store().selectNode(groupOf("metrics").id);

    store().requestDelete();
    expect(store().pendingDelete).toEqual({ kind: "pipeline", pipelineId: metrics.id });
    const before = store();
    store().confirmDelete();

    expectOneEntry(before, "Delete pipeline metrics");
    expect(store().graph.pipelines.map((p) => p.name)).toEqual(["traces", "logs"]);
    expect(store().graph.nodes.some((n) => n.data.pipeline === "metrics")).toBe(false);
    expect(store().text).not.toContain("    metrics:");
    expectTextDescribesGraph();
    expect(success).toHaveBeenCalledWith('Pipeline "metrics" deleted', { className: "ph-no-capture" });
  });

  it("a selected connection alone is deleted at once, and undoably", () => {
    open(STARTER);
    const edge = store().graph.edges[0]!;
    store().applyEdgeChanges([{ id: edge.id, type: "select", selected: true }]);
    expect(store().history.past).toEqual([]);
    const before = store();

    store().requestDelete();

    expect(store().pendingDelete).toBeNull();
    expect(store().graph.edges.some((e) => e.id === edge.id)).toBe(false);
    expectOneEntry(before, "Delete connection");
    expectTextDescribesGraph();
    store().undo();
    expect(store().text).toBe(STARTER);
    expect(store().graph.edges.some((e) => e.id === edge.id)).toBe(true);
  });

  it("duplicates in place, into a pipeline, and several at once", () => {
    open(STARTER);
    const batch = nodeOf("processors.batch", "traces");
    let before = store();

    const copy = store().duplicateNode(batch.id, batch.parentId)!;
    expect(copy.data.label).toBe("Batch (2)");
    expect(copy.parentId).toBe(batch.parentId);
    expect(store().selectedNode?.id).toBe(copy.id);
    expectOneEntry(before, "Duplicate Batch");
    expectWrittenByEditText(before);
    expect(store().text).toContain("  batch/2:\n");

    before = store();
    const into = store().duplicateNode(nodeOf("exporters.otlp", "traces").id, groupOf("logs").id)!;
    expect(into.parentId).toBe(groupOf("logs").id);
    expectOneEntry(before, "Duplicate OTLP");
    expect(store().text).toContain("exporters: [otlp, otlp/2]");

    before = store();
    store().setSelection([nodeOf("receivers.otlp", "traces").id, nodeOf("exporters.otlp", "metrics").id]);
    expect(store().duplicateSelectedNodes()).toHaveLength(2);
    expectOneEntry(before, "Duplicate 2 nodes");
    expectTextDescribesGraph();

    expect(store().duplicateNode(groupOf("traces").id)).toBeNull();
  });

  it("links a component into another pipeline: one entry in the text, and the pipeline names it", () => {
    open(STARTER.replace("    logs:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [otlp]\n", "    logs:\n      receivers: [otlp]\n      exporters: [otlp]\n"));
    const before = store();
    const batch = nodeOf("processors.batch", "traces");

    const linked = store().linkNodeToGroup(batch.id, groupOf("logs").id)!;

    expect(linked.parentId).toBe(groupOf("logs").id);
    expect(componentKey(linked.data)).toBe("processors.batch");
    expectOneEntry(before, "Link Batch to logs");
    expectWrittenByEditText(before);
    expect(store().text.match(/^ {2}batch:/gm)).toHaveLength(1);
  });

  it('counts a link at once, for an instance and a renamed type: the "N pipelines" line shows 2 without a reload', () => {
    const text = [
      "processors:",
      "  batch/2: {}",
      "exporters:",
      "  otlp_grpc:",
      "    endpoint: collector:4317",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [batch/2]",
      "      exporters: [otlp_grpc]",
      // No receivers: a linked processor joins it unconnected (a processor joins a fed pipeline by its edges).
      "    logs:",
      "      exporters: [debug]",
      "",
    ].join("\n");
    open(text);

    for (const key of ["processors.batch/2", "exporters.otlp_grpc"]) {
      const source = nodeOf(key, "traces");
      const linked = store().linkNodeToGroup(source.id, groupOf("logs").id)!;
      pause();

      expect(componentKey(linked.data)).toBe(key);
      expect(linked.data.sharedConfigId).toBe(nodeOf(key, "traces").data.sharedConfigId);
      const { result } = renderHook(() => useSharedCount(linked.data.sharedConfigId));
      expect(result.current).toBe(2);
      // The same id a load gives them.
      const reloaded = parse(store().text);
      if (!reloaded.ok) throw new Error(reloaded.reason);
      expect(nodeOf(key, "logs", reloaded.graph).data.sharedConfigId).toBe(linked.data.sharedConfigId);
    }
    expect(nodeOf("exporters.otlp_grpc", "logs").data.sharedConfigId).toBe("exporter-otlp_grpc");
    expect(nodeOf("processors.batch/2", "logs").data.sharedConfigId).toBe("processor-batch/2");
  });

  it("adds a pipeline with the first unused color, refuses a name in use, and is undoable", () => {
    open(STARTER);
    const before = store();

    const pipeline = store().addPipeline("traces/production")!;

    expect(pipeline).toMatchObject({ name: "traces/production", signalType: "traces", color: "#8b5cf6" });
    expect(pipeline.id).toMatch(/^pipeline_\d+$/);
    expect(groupOf("traces/production").id).toBe(`group_${pipeline.id.slice("pipeline_".length)}`);
    expectOneEntry(before, "Add pipeline traces/production");
    expectWrittenByEditText(before);
    expect(store().text).toContain("    traces/production:");
    expect(store().addPipeline("traces/production")).toBeNull();

    store().undo();
    expect(store().text).toBe(STARTER);
    expect(store().graph.pipelines).toHaveLength(3);
  });

  it("recolors a pipeline: layout only, dirty, undoable", () => {
    open(STARTER);
    const metrics = store().graph.pipelines.find((p) => p.name === "metrics")!;
    const before = store();

    expect(store().setPipelineColor(metrics.id, "#10b981")).toBe(true);

    expectOneEntry(before, "Change color of metrics");
    expect(store().text).toBe(STARTER);
    expect(groupOf("metrics").data.color).toBe("#10b981");
    expect(isDirty()).toBe(true);
    store().undo();
    expect(isDirty()).toBe(false);
  });

  it("renames an instance: its label, its key in the text and every reference, the entry's comments kept", () => {
    const text = [
      "extensions:",
      "  # the probe",
      "  health_check:",
      "    # where it listens",
      "    endpoint: 0.0.0.0:13133 # all interfaces",
      "service:",
      "  extensions: [health_check]",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [debug]",
      "receivers:",
      "  otlp: {}",
      "exporters:",
      "  debug: {}",
      "",
    ].join("\n");
    open(text);
    const before = store();
    const health = nodeOf("extensions.health_check");

    expect(store().renameInstance(health.id, "probe")).toBe(true);

    const renamed = store().graph.nodes.find((n) => n.id === health.id)!;
    expect(renamed.data.label).toBe("Health Check (probe)");
    expect(componentKey(renamed.data)).toBe("extensions.health_check/probe");
    expectOneEntry(before, "Update Health Check");
    expectWrittenByEditText(before, [{ from: "extensions.health_check", to: "extensions.health_check/probe" }]);
    expect(store().text).toBe(
      text.replace("  health_check:\n", "  health_check/probe:\n").replace("[health_check]", "[health_check/probe]"),
    );

    // Typing on: the same run, one entry.
    now += 200;
    store().renameInstance(health.id, "probe2");
    expect(store().history.past).toHaveLength(1);
    expect(store().text).toContain("  health_check/probe2:\n    # where it listens\n");

    // Emptied: the base label and the bare type.
    now += 200;
    store().renameInstance(health.id, "");
    expect(store().graph.nodes.find((n) => n.id === health.id)!.data.label).toBe("Health Check");
    expect(store().text).toBe(text);
  });

  it("keeps a renamed component where every list names it: a pipeline's receivers and exporters, service.extensions", () => {
    const text = [
      "receivers:",
      "  otlp: {}",
      "  filelog: {}",
      "exporters:",
      "  debug: {}",
      "  otlphttp: {}",
      "connectors:",
      "  forward: {}",
      "extensions:",
      "  health_check: {}",
      "  pprof: {}",
      "service:",
      "  extensions: [health_check, pprof]",
      "  pipelines:",
      "    logs:",
      "      receivers: [otlp, filelog]",
      "      exporters: [debug, forward, otlphttp]",
      "    logs/out:",
      "      receivers: [forward, filelog]",
      "      exporters: [debug, otlphttp]",
      "",
    ].join("\n");
    open(text);

    const before = store();
    expect(store().renameInstance(nodeOf("receivers.otlp", "logs").id, "a")).toBe(true);
    expectWrittenByEditText(before, [{ from: "receivers.otlp", to: "receivers.otlp/a" }]);
    pause();
    store().renameInstance(nodeOf("exporters.debug", "logs").id, "b");
    pause();
    store().renameInstance(nodeOf("extensions.health_check").id, "c");
    pause();
    for (const node of store().graph.nodes.filter((n) => componentKey(n.data) === "connectors.forward")) {
      store().renameInstance(node.id, "d");
      pause();
    }

    expect(store().text).toContain("      receivers: [otlp/a, filelog]\n");
    expect(store().text).toContain("      exporters: [debug/b, forward/d, otlphttp]\n");
    expect(store().text).toContain("      receivers: [forward/d, filelog]\n");
    // The pipeline whose node kept the shared name keeps its order.
    expect(store().text).toContain("      exporters: [debug, otlphttp]\n");
    expect(store().text).toContain("  extensions: [health_check/c, pprof]\n");
    expectTextDescribesGraph();
  });

  it("renaming onto another instance's name links the two: one component, the text's value", () => {
    open(STARTER);
    const copy = store().duplicateNode(nodeOf("processors.batch", "traces").id, groupOf("logs").id)!;
    pause();
    store().setComponentValue(copy.id, "timeout: 1s\n");
    pause();
    const before = store();

    expect(store().renameInstance(copy.id, "")).toBe(true);

    const linked = store().graph.nodes.find((n) => n.id === copy.id)!;
    expect(componentKey(linked.data)).toBe("processors.batch");
    expect(linked.data.sharedConfigId).toBe("processor-batch");
    expect(linked.data.config).toEqual(nodeOf("processors.batch", "traces").data.config);
    expect(store().text).not.toContain("batch/2");
    expectOneEntry(before, "Update Batch (2)");
    expectTextDescribesGraph();
  });

  it("writes the YAML box's value, comments included, into every node of the component", () => {
    open(STARTER);
    const batch = nodeOf("processors.batch", "traces");
    const before = store();

    expect(store().setComponentValue(batch.id, "# tuned\ntimeout: 5s # shorter\n")).toBe("written");

    expect(store().text).toContain("  batch:\n    # tuned\n    timeout: 5s # shorter\n");
    for (const pipeline of ["traces", "metrics", "logs"]) {
      expect(nodeOf("processors.batch", pipeline).data.config).toEqual({ timeout: "5s" });
    }
    expectOneEntry(before, "Update Batch");
    expectTextDescribesGraph();

    now += 300;
    expect(store().setComponentValue(batch.id, "timeout: 6s\n")).toBe("written");
    expect(store().history.past).toHaveLength(1);

    const written = store().text;
    expect(store().setComponentValue(batch.id, "timeout: [")).toBe("refused");
    expect(store().setComponentValue(batch.id, "- a\n")).toBe("refused");
    expect(store().text).toBe(written);
  });

  it("clears the canvas: three empty default pipelines, telemetry and unknown keys kept, one entry", () => {
    const text = corpusText("service-telemetry.yaml");
    open(text);
    const before = store();

    expect(store().clearCanvas()).toBe(true);

    expect(store().graph.pipelines.map((p) => p.name)).toEqual(["traces", "metrics", "logs"]);
    expect(store().graph.nodes.every((n) => n.type === "pipelineGroup")).toBe(true);
    expect(store().canvasKey).toBe(before.canvasKey + 1);
    expectOneEntry(before, "Clear canvas");
    expectWrittenByEditText(before);
    const telemetry = text.slice(text.indexOf("  telemetry:"), text.indexOf("  pipelines:"));
    expect(store().text).toContain(`service:\n${telemetry}`);
    const parsed = parse(store().text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(readTextModel(parsed.document).components.size).toBe(0);
  });

  it("refuses a change the text edits can't write: graph and text as they were, no entry, and the refusal toast", () => {
    const text =
      "receivers:\n  otlp: &block\n    protocols:\n      grpc: {}\nexporters:\n  debug:\n    samples: [*block]\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
    open(text);
    const error = vi.spyOn(toast, "error");
    const before = store();

    expect(store().deleteNodes([nodeOf("receivers.otlp", "traces").id])).toBe(false);

    expect(store().text).toBe(text);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toEqual(before.history);
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
    expect(CANT_EDIT_ON_CANVAS_MESSAGE).toBe("This change can't be made on the canvas. Edit the YAML directly.");
  });

  it("refuses a YAML box the text edits can't write, with the same toast", () => {
    const text = "exporters: {debug: {verbosity: basic}}\nservice:\n  pipelines:\n    traces:\n      exporters: [debug]\n";
    open(text);
    const error = vi.spyOn(toast, "error");

    expect(store().setComponentValue(nodeOf("exporters.debug", "traces").id, "verbosity: detailed\nsampling: 1")).toBe("refused");

    expect(store().text).toBe(text);
    expect(store().history.past).toEqual([]);
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
  });
});

describe("deleting a processor closes its pipeline's chain", () => {
  const CHAINS = [
    "receivers:",
    "  otlp:",
    "processors:",
    "  memory_limiter:",
    "  attributes:",
    "  batch:",
    "exporters:",
    "  debug:",
    "connectors:",
    "  forward:",
    "  forward/2:",
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      processors: [memory_limiter, attributes, batch]",
    "      exporters: [debug, forward]",
    "    metrics:",
    "      receivers: [otlp]",
    "      processors: [memory_limiter, batch]",
    "      exporters: [debug]",
    "    traces/through:",
    "      receivers: [forward]",
    "      processors: [batch]",
    "      exporters: [forward/2]",
    "    traces/end:",
    "      receivers: [forward/2]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  /** The pipeline's lists as the text has them. */
  function pipelineOf(name: string) {
    const parsed = parse(store().text);
    if (!parsed.ok) throw new Error(parsed.reason);
    return readTextModel(parsed.document).pipelines.get(name);
  }

  /** Deletes `ids` (one entry, the text the graph describes), and returns the pipelines' processors; undo restores both. */
  function deleting(text: string, ids: () => string[], description: string, pipelines: string[]) {
    open(text);
    const before = store();
    expect(store().deleteNodes(ids())).toBe(true);
    expectOneEntry(before, description);
    expectWrittenByEditText(before);
    expectTextDescribesGraph();
    expectEdgesAsParsed();
    const processors = Object.fromEntries(pipelines.map((name) => [name, pipelineOf(name)?.processors]));
    const after = store().text;
    store().undo();
    expect(store().text).toBe(text);
    expect(store().graph).toEqual(before.graph);
    expectTextDescribesGraph();
    store().redo();
    expect(store().text).toBe(after);
    return processors;
  }

  it("the first, a middle and the last processor: only it leaves processors; the others' pipelines are as they were", () => {
    expect(deleting(CHAINS, () => [nodeOf("processors.memory_limiter", "traces").id], "Delete Memory Limiter", ["traces", "metrics"])).toEqual({
      traces: ["attributes", "batch"],
      metrics: ["memory_limiter", "batch"],
    });
    expect(store().text).toContain("      processors: [attributes, batch]\n      exporters: [debug, forward]\n");
    // The receiver feeds what the deleted processor fed.
    const receiver = nodeOf("receivers.otlp", "traces").id;
    const attributes = nodeOf("processors.attributes", "traces").id;
    expect(store().graph.edges.filter((e) => e.source === receiver).map((e) => e.target)).toEqual([attributes]);

    expect(deleting(CHAINS, () => [nodeOf("processors.attributes", "traces").id], "Delete Attributes", ["traces"])).toEqual({
      traces: ["memory_limiter", "batch"],
    });
    expect(store().text).not.toContain("  attributes:");

    expect(deleting(CHAINS, () => [nodeOf("processors.batch", "traces").id], "Delete Batch", ["traces", "metrics"])).toEqual({
      traces: ["memory_limiter", "attributes"],
      metrics: ["memory_limiter", "batch"],
    });
    // The last processor's exporters, a connector among them, are fed by the one before it.
    expect(pipelineOf("traces")?.exporters).toEqual(["debug", "forward"]);
    expect(pipelineOf("traces/through")?.receivers).toEqual(["forward"]);
  });

  it("two adjacent processors deleted at once (a multi-select delete), and a whole chain", () => {
    const both = () => [nodeOf("processors.memory_limiter", "traces").id, nodeOf("processors.attributes", "traces").id];
    expect(deleting(CHAINS, both, "Delete 2 nodes", ["traces"])).toEqual({ traces: ["batch"] });
    const reversed = () => [nodeOf("processors.batch", "traces").id, nodeOf("processors.attributes", "traces").id];
    expect(deleting(CHAINS, reversed, "Delete 2 nodes", ["traces"])).toEqual({ traces: ["memory_limiter"] });
    expect(pipelineOf("traces")?.exporters).toEqual(["debug", "forward"]);

    const all = () => ["memory_limiter", "attributes", "batch"].map((name) => nodeOf(`processors.${name}`, "traces").id);
    deleting(CHAINS, all, "Delete 3 nodes", ["traces"]);
    expect(pipelineOf("traces")).toEqual({ receivers: ["otlp"], processors: [], exporters: ["debug", "forward"] });
    expect(pipelineOf("metrics")?.processors).toEqual(["memory_limiter", "batch"]);
  });

  it("a processor shared by several pipelines (a node in each): each pipeline's chain closes", () => {
    const shared = () => ["traces", "metrics"].map((pipeline) => nodeOf("processors.memory_limiter", pipeline).id);
    expect(deleting(CHAINS, shared, "Delete 2 nodes", ["traces", "metrics"])).toEqual({
      traces: ["attributes", "batch"],
      metrics: ["batch"],
    });
    expect(store().text).not.toContain("  memory_limiter:");

    const batches = () => ["traces", "metrics", "traces/through"].map((pipeline) => nodeOf("processors.batch", pipeline).id);
    expect(deleting(CHAINS, batches, "Delete 3 nodes", ["traces", "metrics", "traces/through"])).toEqual({
      traces: ["memory_limiter", "attributes"],
      metrics: ["memory_limiter"],
      "traces/through": [],
    });
    // A connector that fed the only processor, which fed a connector: both stay in the pipeline, through its group.
    expect(pipelineOf("traces/through")).toEqual({ receivers: ["forward"], processors: [], exporters: ["forward/2"] });
  });

  it("a routed pipeline (its chain seeded from the processor nothing feeds) closes the same way", () => {
    const routed = [
      "receivers:",
      "  otlp:",
      "processors:",
      "  memory_limiter:",
      "  attributes:",
      "  batch:",
      "exporters:",
      "  debug:",
      "connectors:",
      "  routing:",
      "    default_pipelines: [traces/out]",
      "    table: []",
      "service:",
      "  pipelines:",
      "    traces/in:",
      "      receivers: [otlp]",
      "      exporters: [routing]",
      "    traces/out:",
      "      receivers: [routing]",
      "      processors: [memory_limiter, attributes, batch]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    const out = (name: string) => () => [nodeOf(`processors.${name}`, "traces/out").id];
    expect(deleting(routed, out("memory_limiter"), "Delete Memory Limiter", ["traces/out"])).toEqual({ "traces/out": ["attributes", "batch"] });
    expect(deleting(routed, out("attributes"), "Delete Attributes", ["traces/out"])).toEqual({ "traces/out": ["memory_limiter", "batch"] });
    expect(deleting(routed, out("batch"), "Delete Batch", ["traces/out"])).toEqual({ "traces/out": ["memory_limiter", "attributes"] });
    expect(pipelineOf("traces/out")?.receivers).toEqual(["routing"]);
  });

  it("deleting a receiver or an exporter joins nothing: only its own edges go", () => {
    for (const key of ["receivers.otlp", "exporters.debug"]) {
      open(CHAINS);
      const before = store();
      const node = nodeOf(key, "traces");
      expect(store().deleteNodes([node.id])).toBe(true);
      expect(store().graph.edges).toEqual(before.graph.edges.filter((e) => e.source !== node.id && e.target !== node.id));
      expect(pipelineOf("traces")?.processors).toEqual(["memory_limiter", "attributes", "batch"]);
      expectWrittenByEditText(before);
      expectTextDescribesGraph();
      expectEdgesAsParsed();
    }
  });

  describe("a connector beside a plain receiver or exporter joins the group only as parse draws it", () => {
    const MIXED = [
      "receivers:",
      "  otlp:",
      "processors:",
      "  batch:",
      "exporters:",
      "  debug:",
      "connectors:",
      "  forward/in:",
      "  forward/out:",
      "service:",
      "  pipelines:",
      "    traces/both:",
      "      receivers: [otlp, forward/in]",
      "      processors: [batch]",
      "      exporters: [debug, forward/out]",
      "    traces/receivers:",
      "      receivers: [otlp, forward/in]",
      "      processors: [batch]",
      "      exporters: [forward/out]",
      "    traces/exporters:",
      "      receivers: [forward/in]",
      "      processors: [batch]",
      "      exporters: [debug, forward/out]",
      "    traces/mirror:",
      "      receivers: [forward/in, otlp]",
      "      processors: [batch]",
      "      exporters: [forward/out, debug]",
      "    traces/src:",
      "      receivers: [otlp]",
      "      exporters: [forward/in]",
      "    traces/sink:",
      "      receivers: [forward/out]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    it.each([
      ["traces/both", { receivers: ["otlp", "forward/in"], processors: [], exporters: ["debug", "forward/out"] }],
      ["traces/receivers", { receivers: ["otlp", "forward/in"], processors: [], exporters: ["forward/out"] }],
      ["traces/exporters", { receivers: ["forward/in"], processors: [], exporters: ["debug", "forward/out"] }],
      ["traces/mirror", { receivers: ["forward/in", "otlp"], processors: [], exporters: ["forward/out", "debug"] }],
    ])("%s: the edges are the ones its text draws", (pipeline, lists) => {
      const processors = deleting(MIXED, () => [nodeOf("processors.batch", pipeline).id], "Delete Batch", [pipeline]);
      expect(processors).toEqual({ [pipeline]: [] });
      expect(pipelineOf(pipeline)).toEqual(lists);
      const group = groupOf(pipeline).id;
      const connectors = store().graph.edges.filter((e) => e.source === group || e.target === group);
      // Only where nothing in the group is on the connector's other side.
      expect(connectors).toHaveLength(pipeline === "traces/both" || pipeline === "traces/mirror" ? 0 : 1);
    });

    it("a later delete of a joined edge writes it", () => {
      open(MIXED);
      store().deleteNodes([nodeOf("processors.batch", "traces/both").id]);
      const otlp = nodeOf("receivers.otlp", "traces/both").id;
      const out = nodeOf("connectors.forward/out").id;
      const edge = store().graph.edges.find((e) => e.source === otlp && e.target === out);
      expect(edge).toBeDefined();
      const before = store();
      expect(store().deleteEdges([edge!.id])).toBe(true);
      expectWrittenByEditText(before);
      expect(store().text).not.toBe(before.text);
      expect(pipelineOf("traces/both")?.exporters).toEqual(["debug"]);
      expectTextDescribesGraph();
      expectEdgesAsParsed();
    });
  });
});

describe("layout changes don't touch the text", () => {
  it("a move dirties the editor; moving back to the saved position cleans it", () => {
    open(STARTER);
    const otlp = nodeOf("receivers.otlp", "traces");
    const home = otlp.position;

    store().applyNodeChanges([{ id: otlp.id, type: "position", position: { x: home.x + 40, y: home.y }, dragging: true }]);
    expect(store().text).toBe(STARTER);
    expect(isDirty()).toBe(true);
    expect(store().history.past.at(-1)?.description).toBe("Move OTLP");

    store().applyNodeChanges([{ id: otlp.id, type: "position", position: { x: home.x + 0.3, y: home.y }, dragging: false }]);
    expect(isDirty()).toBe(false);
    expect(store().history.past).toHaveLength(1);
  });

  it("an arrow-key move is a move: an entry, and a layout change", () => {
    open(STARTER);
    const otlp = nodeOf("receivers.otlp", "traces");

    store().applyNodeChanges([{ id: otlp.id, type: "position", position: { x: otlp.position.x + 20, y: otlp.position.y } }]);

    expect(store().history.past.at(-1)?.description).toBe("Move OTLP");
    expect(isDirty()).toBe(true);
    // Held down: the same run.
    now += 100;
    store().applyNodeChanges([{ id: otlp.id, type: "position", position: { x: otlp.position.x + 40, y: otlp.position.y } }]);
    expect(store().history.past).toHaveLength(1);
    // After a pause, another entry.
    pause();
    store().applyNodeChanges([{ id: otlp.id, type: "position", position: { x: otlp.position.x + 60, y: otlp.position.y } }]);
    expect(store().history.past).toHaveLength(2);
  });

  it("moving several nodes is 'Move N nodes'", () => {
    open(STARTER);
    const a = nodeOf("receivers.otlp", "traces");
    const b = nodeOf("exporters.otlp", "traces");
    store().applyNodeChanges([
      { id: a.id, type: "position", position: { x: a.position.x + 20, y: a.position.y }, dragging: true },
      { id: b.id, type: "position", position: { x: b.position.x + 20, y: b.position.y }, dragging: true },
    ]);
    expect(store().history.past.at(-1)?.description).toBe("Move 2 nodes");
  });

  it("selection and measurement take no entry and never dirty, even in manual edit mode", () => {
    open(STARTER);
    const otlp = nodeOf("receivers.otlp", "traces");

    store().applyNodeChanges([
      { id: otlp.id, type: "select", selected: true },
      { id: otlp.id, type: "dimensions", dimensions: { width: 212, height: 72 } },
    ]);
    store().applyEdgeChanges([{ id: store().graph.edges[0]!.id, type: "select", selected: true }]);
    store().applyEdgeChanges([{ id: store().graph.edges[0]!.id, type: "remove" }]);
    store().setSelection([otlp.id]);
    store().selectNode(otlp.id);

    expect(store().history.past).toEqual([]);
    expect(isDirty()).toBe(false);
    expect(store().graph.nodes.find((n) => n.id === otlp.id)?.measured).toEqual({ width: 212, height: 72 });
    expect(store().graph.edges).toHaveLength(store().savedGraph.edges.length);

    store().setText(`${STARTER}# typed\n`);
    store().applyNodeChanges([{ id: otlp.id, type: "dimensions", dimensions: { width: 300, height: 72 } }]);
    expect(store().graph.nodes.find((n) => n.id === otlp.id)?.measured).toEqual({ width: 300, height: 72 });
    // Moves are refused while the canvas is locked.
    store().applyNodeChanges([{ id: otlp.id, type: "position", position: { x: 999, y: 999 } }]);
    expect(nodeOf("receivers.otlp", "traces").position).toEqual(otlp.position);
    expect(store().history.past).toEqual([]);
  });

  it("a React Flow removal never deletes: deleting goes through the dialog", () => {
    open(STARTER);
    const otlp = nodeOf("receivers.otlp", "traces");
    store().applyNodeChanges([{ id: otlp.id, type: "remove" }]);
    expect(store().graph.nodes.some((n) => n.id === otlp.id)).toBe(true);
  });
});

describe("tidy up", () => {
  /** Two receivers on the same spot: what a messy import or a careless drag leaves. */
  function seedOverlapping() {
    open("receivers:\n  otlp: {}\n  jaeger: {}\nprocessors:\n  batch: {}\nexporters:\n  otlp: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp, jaeger]\n      processors: [batch]\n      exporters: [otlp]\n");
    const receivers = store().graph.nodes.filter((n) => n.type === "receiver").map((n) => n.id);
    store().applyNodeChanges(receivers.map((id) => ({ id, type: "position" as const, position: { x: 50, y: 50 } })));
    store().markSaved(store().text, store().version!, store().graph);
    store().selectNode(receivers[0]!);
    useEditorStore.setState({ history: { past: [], future: [] }, historyRun: null, layoutRevision: 0 });
    return store();
  }

  it("moves overlapping nodes apart", () => {
    seedOverlapping();
    store().tidyUp();
    const [r1, r2] = store().graph.nodes.filter((n) => n.type === "receiver");
    expect(r1!.position).not.toEqual(r2!.position);
  });

  it("records an undoable history entry, marks the editor dirty and bumps layoutRevision", () => {
    seedOverlapping();
    expect(isDirty()).toBe(false);
    store().tidyUp();
    expect(store().history.past.at(-1)?.description).toBe("Tidy up layout");
    expect(isDirty()).toBe(true);
    expect(store().layoutRevision).toBe(1);
  });

  it("leaves the YAML unchanged (positions are not part of the config)", () => {
    const { text } = seedOverlapping();
    store().tidyUp();
    expect(store().text).toBe(text);
  });

  it("re-points selectedNode at the moved copy of the same node", () => {
    const seeded = seedOverlapping();
    store().tidyUp();
    const { graph, selectedNode } = store();
    expect(selectedNode?.id).toBe(seeded.selectedNode!.id);
    expect(selectedNode).toBe(graph.nodes.find((n) => n.id === seeded.selectedNode!.id));
    expect(selectedNode).not.toBe(seeded.selectedNode);
  });

  it("can be undone back to the previous positions", () => {
    const before = seedOverlapping();
    store().tidyUp();
    store().undo();
    const positions = (graph: Graph) => graph.nodes.map((n) => ({ id: n.id, position: n.position }));
    expect(positions(store().graph)).toEqual(positions(before.graph));
    expect(isDirty()).toBe(false);
  });
});

describe("manual edit mode", () => {
  it("typing enters it once, with its toast, keeping the text from before", () => {
    open(STARTER);
    const info = vi.spyOn(toast, "info");

    store().setText(`${STARTER}# one\n`);
    store().setText(`${STARTER}# one two\n`);

    expect(store().isYamlEditing).toBe(true);
    expect(store().preEditText).toBe(STARTER);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Entered manual edit mode");
    expect(isDirty()).toBe(true);
    expect(selectIsCanvasLocked(store())).toBe(true);
  });

  it("a change made by the store (a canvas edit, an undo) never enters it", () => {
    open(STARTER);
    const info = vi.spyOn(toast, "info");
    store().dropComponent(paletteId("exporter", "debug"), inside(groupOf("traces")));
    store().undo();
    store().redo();
    expect(store().isYamlEditing).toBe(false);
    expect(info).not.toHaveBeenCalledWith("Entered manual edit mode");
  });

  it("refuses graph actions and undo/redo while in it", () => {
    open(STARTER);
    store().tidyUp();
    store().setText(`${STARTER}# typed\n`);
    const before = store();

    expect(store().dropComponent(paletteId("exporter", "debug"), inside(groupOf("traces")))).toBeNull();
    expect(store().connect({ source: nodeOf("receivers.otlp", "traces").id, target: nodeOf("exporters.otlp", "traces").id })).toEqual({ ok: false });
    expect(store().addPipeline("logs/more")).toBeNull();
    expect(store().deletePipeline(store().graph.pipelines[0]!.id)).toBe(false);
    expect(store().tidyUp()).toBe(false);
    expect(store().clearCanvas()).toBe(false);
    expect(store().renameInstance(nodeOf("processors.batch", "traces").id, "x")).toBe(false);
    expect(store().setComponentValue(nodeOf("processors.batch", "traces").id, "timeout: 1s\n")).toBe("refused");
    expect(store().duplicateNode(nodeOf("processors.batch", "traces").id)).toBeNull();
    store().requestDelete({ kind: "nodes", nodeIds: [nodeOf("processors.batch", "traces").id] });
    expect(store().pendingDelete).toBeNull();
    expect(store().undo()).toBe(false);
    expect(store().redo()).toBe(false);
    expect(selectCanUndo(store())).toBe(false);

    expect(store().text).toBe(before.text);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toBe(before.history);
  });

  it("Apply puts the text on the canvas, keeping matched positions, in one entry; undo after Apply restores both", () => {
    open(STARTER);
    const success = vi.spyOn(toast, "success");
    const batch = nodeOf("processors.batch", "traces");
    store().applyNodeChanges([{ id: batch.id, type: "position", position: { x: 444, y: 88 } }]);
    pause();
    const beforeTyping = store();
    const typed = STARTER.replace("exporters:\n  otlp:", "exporters:\n  debug: {}\n  otlp:").replace(
      "    logs:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [otlp]",
      "    logs:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [otlp, debug]",
    );
    store().setText(typed);

    expect(store().apply()).toEqual({ ok: true });

    expect(store().isYamlEditing).toBe(false);
    expect(store().preEditText).toBeNull();
    expect(store().text).toBe(typed);
    expect(nodeOf("exporters.debug", "logs")).toBeDefined();
    expect(nodeOf("processors.batch", "traces").position).toEqual({ x: 444, y: 88 });
    expect(success).toHaveBeenCalledWith("Changes applied");
    expectOneEntry(beforeTyping, "Edit YAML");

    store().undo();
    expect(store().text).toBe(STARTER);
    expect(store().graph).toEqual(beforeTyping.graph);
    expect(() => nodeOf("exporters.debug", "logs")).toThrow();

    store().redo();
    expect(store().text).toBe(typed);
    expect(nodeOf("exporters.debug", "logs")).toBeDefined();
  });

  it("Apply refuses text that doesn't read, with the reason, and stays in the mode", () => {
    open(STARTER);
    store().setText("receivers: [otlp]\n");

    const result = store().apply();

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("receivers must be a mapping") });
    expect(store().isYamlEditing).toBe(true);
    expect(store().history.past).toEqual([]);
  });

  it("Apply outside the mode does nothing", () => {
    open(STARTER);
    expect(store().apply()).toMatchObject({ ok: false });
    expect(store().history.past).toEqual([]);
  });

  it("Apply of text the canvas couldn't show when opened lays it all out", () => {
    open("receivers: [otlp]\n");
    store().setText(STARTER);
    expect(store().apply()).toEqual({ ok: true });
    expect(store().graphStatus).toBe("ready");
    expect(store().graph.pipelines).toHaveLength(3);

    store().undo();
    expect(store().text).toBe("receivers: [otlp]\n");
    expect(store().graphStatus).toEqual({ unreadable: expect.any(String) });
    expect(store().graph.nodes).toEqual([]);
  });

  it("Undo All puts back the text from before the typing and leaves the mode", () => {
    open(STARTER);
    const info = vi.spyOn(toast, "info");
    store().setText("anything: [\n");

    store().undoAll();

    expect(store().text).toBe(STARTER);
    expect(store().isYamlEditing).toBe(false);
    expect(store().preEditText).toBeNull();
    expect(info).toHaveBeenLastCalledWith("Changes reverted");
    expect(isDirty()).toBe(false);
    // The canvas works again, from the same document.
    expect(store().tidyUp()).toBe(true);

    info.mockClear();
    store().undoAll();
    expect(info).not.toHaveBeenCalled();
  });
});

describe("undo and redo", () => {
  it("restore the text and the graph together, toast their description, and redo keeps it", () => {
    open(STARTER);
    const info = vi.spyOn(toast, "info");
    const before = store();
    store().dropComponent(paletteId("exporter", "debug"), inside(groupOf("traces")));
    const after = store();

    expect(selectUndoDescription(store())).toBe("Add Debug");
    expect(store().undo()).toBe(true);
    expect(store().text).toBe(before.text);
    expect(store().graph.nodes.map((n) => n.id)).toEqual(before.graph.nodes.map((n) => n.id));
    expect(info).toHaveBeenLastCalledWith("Undo: Add Debug", { className: "ph-no-capture" });
    expect(selectCanRedo(store())).toBe(true);
    expect(selectRedoDescription(store())).toBe("Add Debug");

    expect(store().redo()).toBe(true);
    expect(store().text).toBe(after.text);
    expect(info).toHaveBeenLastCalledWith("Redo: Add Debug", { className: "ph-no-capture" });
    expect(selectUndoDescription(store())).toBe("Add Debug");

    store().undo();
    expect(info).toHaveBeenLastCalledWith("Undo: Add Debug", { className: "ph-no-capture" });
    expect(isDirty()).toBe(false);
  });

  it("does nothing with nothing to undo or redo", () => {
    open(STARTER);
    expect(store().undo()).toBe(false);
    expect(store().redo()).toBe(false);
  });

  it("keeps the selection where its nodes still are", () => {
    open(STARTER);
    const otlp = nodeOf("receivers.otlp", "traces");
    store().setSelection([otlp.id]);
    store().tidyUp();
    store().undo();
    expect(store().selectedNode?.id).toBe(otlp.id);
    expect(store().selectedNode).toBe(store().graph.nodes.find((n) => n.id === otlp.id));
    expect(store().graph.nodes.find((n) => n.id === otlp.id)?.selected).toBe(true);
  });

  it("keeps 50 entries, the oldest dropped", () => {
    open(STARTER);
    const pipelines = store().graph.pipelines;
    for (let i = 0; i < HISTORY_DEPTH + 10; i++) {
      store().setPipelineColor(pipelines[0]!.id, i % 2 === 0 ? "#10b981" : "#ef4444");
    }
    expect(HISTORY_DEPTH).toBe(50);
    expect(store().history.past).toHaveLength(50);
    let undone = 0;
    while (store().undo()) undone++;
    expect(undone).toBe(50);
    expect(store().history.future).toHaveLength(50);
    // The ten oldest are gone: undoing everything kept stops after the tenth change.
    expect(groupOf("traces").data.color).toBe("#ef4444");
  });

  it("a new change after an undo clears what could be redone", () => {
    open(STARTER);
    store().tidyUp();
    store().undo();
    expect(store().history.future).toHaveLength(1);
    store().setPipelineColor(store().graph.pipelines[0]!.id, "#10b981");
    expect(store().history.future).toEqual([]);
  });
});

describe("saving and discarding", () => {
  it("markSaved records the layout sent, so it's clean until the next move", () => {
    open(STARTER);
    store().moveNodeToGroup(nodeOf("exporters.otlp", "logs").id, null);
    store().applyNodeChanges([{ id: groupOf("logs").id, type: "position", position: { x: 5, y: 5 } }]);
    expect(isDirty()).toBe(true);
    const sent = store().graph;

    store().markSaved(store().text, store().version!, sent);
    expect(store().savedLayout).toBe(layoutSignature(sent));
    expect(isDirty()).toBe(false);
    store().applyNodeChanges([{ id: groupOf("logs").id, type: "position", position: { x: 45, y: 5 } }]);
    expect(isDirty()).toBe(true);
  });

  it("discardChanges goes back to the saved text and layout, out of manual edit mode", () => {
    open(STARTER);
    store().tidyUp();
    store().setText("typed: [\n");

    store().discardChanges();

    expect(store().text).toBe(STARTER);
    expect(store().isYamlEditing).toBe(false);
    expect(store().graph).toBe(store().savedGraph);
    expect(store().graphStatus).toBe("ready");
    expect(store().document).not.toBeNull();
    expect(isDirty()).toBe(false);
    expect(store().history).toEqual({ past: [], future: [] });
  });

  it("discardChanges after a save in manual edit mode shows the saved text on the canvas, as a reload would", () => {
    open(STARTER);
    const typed = STARTER.replace("    logs:\n", "    logs/typed:\n      receivers: [otlp]\n      exporters: [otlp]\n    logs:\n");
    store().setText(typed);
    // The save sends the typed text with the graph from before the typing.
    store().markSaved(typed, store().version!, store().graph);

    store().discardChanges();

    expect(store().text).toBe(typed);
    expect(store().isYamlEditing).toBe(false);
    expect(store().graph.pipelines.map((p) => p.name)).toContain("logs/typed");
    expectTextDescribesGraph();
    const reloaded = parse(typed);
    if (!reloaded.ok) throw new Error(reloaded.reason);
    expect(modelsEqual(readTextModel(store().document!), readTextModel(reloaded.document))).toBe(true);
    expect(isDirty()).toBe(false);
  });

  it("reset forgets the graph, the history and manual edit mode", () => {
    open(STARTER);
    store().tidyUp();
    store().setText("typed\n");
    store().reset();
    expect(store()).toMatchObject({
      graph: { nodes: [], edges: [], pipelines: [] },
      history: { past: [], future: [] },
      isYamlEditing: false,
      preEditText: null,
      document: null,
      pendingDelete: null,
    });
    expect(isDirty()).toBe(false);
  });
});

/*
 * A form's changes and self-monitoring's, written by key path through
 * `writeValues`.
 */
describe("a form's changes, written by key path", () => {
  it("writes only the changed lines, one entry per component within 800 ms (shared with the YAML box), and undo restores text and graph together", () => {
    open(STARTER);
    const batch = nodeOf("processors.batch", "traces");
    const before = store();

    expect(store().setComponentValues(batch.id, [{ path: ["timeout"], value: "5s" }])).toBe("written");

    expect(lineDiff(STARTER, store().text)).toEqual({ removed: ["    timeout: '10s'"], added: ["    timeout: '5s'"] });
    expectOneEntry(before, "Update Batch");
    expectTextDescribesGraph();
    expect(isDirty()).toBe(true);

    now += 300;
    expect(store().setComponentValues(batch.id, [{ path: ["send_batch_size"], plain: "2e3" }])).toBe("written");
    now += 300;
    expect(store().setComponentValue(batch.id, "timeout: '5s'\nsend_batch_size: 2e3\nmetadata_cardinality_limit: 7\n")).toBe(
      "written",
    );
    now += 300;
    expect(store().setComponentValues(batch.id, [{ path: ["metadata_cardinality_limit"], remove: true }])).toBe("written");
    expect(store().history.past).toHaveLength(1);
    expect(lineDiff(STARTER, store().text)).toEqual({
      removed: ["    timeout: '10s'", "    send_batch_size: 1024"],
      added: ["    timeout: '5s'", "    send_batch_size: 2e3"],
    });

    // Another component within the 800 ms takes its own entry.
    now += 300;
    const otlp = nodeOf("exporters.otlp", "traces");
    expect(store().setComponentValues(otlp.id, [{ path: ["tls", "insecure"], value: false }])).toBe("written");
    expect(store().history.past.map((entry) => entry.description)).toEqual(["Update Batch", "Update OTLP"]);
    pause();
    expect(store().setComponentValues(batch.id, [{ path: ["timeout"], value: "6s" }])).toBe("written");
    expect(store().history.past).toHaveLength(3);

    store().undo();
    store().undo();
    store().undo();
    expect(store().text).toBe(STARTER);
    expect(store().graph.nodes).toEqual(before.graph.nodes);
    expect(nodeOf("processors.batch", "logs").data.config).toEqual({ timeout: "10s", send_batch_size: 1024 });
    expect(isDirty()).toBe(false);
  });

  it("gives every node of a shared component the new config, so the next canvas change doesn't write a stale one back", () => {
    open(STARTER);
    const batch = nodeOf("processors.batch", "metrics");

    expect(
      store().setComponentValues(batch.id, [
        { path: ["timeout"], value: "1s" },
        { path: ["send_batch_max_size"], plain: "0x10" },
      ]),
    ).toBe("written");

    for (const pipeline of ["traces", "metrics", "logs"]) {
      expect(nodeOf("processors.batch", pipeline).data.config).toEqual({ timeout: "1s", send_batch_size: 1024, send_batch_max_size: 16 });
    }
    const written = store().text;
    expect(written).toContain("    send_batch_max_size: 0x10\n");
    // A canvas change derives the model from the nodes' config: the form's value stays as written.
    pause();
    expect(store().deleteNodes([nodeOf("exporters.otlp", "logs").id])).toBe(true);
    expect(store().text).toContain("    timeout: '1s'\n    send_batch_size: 1024\n    send_batch_max_size: 0x10\n");
    expectTextDescribesGraph();
  });

  it("keeps a routing connector's target pipelines to its right, as the YAML box does", () => {
    open(corpusText("routing-connector.yaml"));
    const routing = store().graph.nodes.find((n) => n.data.componentSubType === "routing")!;
    const pipeline = store().addPipeline("traces/audit")!;
    const group = store().graph.nodes.find((n) => n.data.pipelineId === pipeline.id)!;
    pause();
    store().applyNodeChanges([{ id: group.id, type: "position", position: { x: 0, y: group.position.y } }]);
    pause();

    expect(store().setComponentValues(routing.id, [{ path: ["default_pipelines", 1], value: "traces/audit" }])).toBe("written");

    const parent = store().graph.nodes.find((n) => n.id === routing.parentId);
    const connectorX = routing.position.x + (parent?.position.x ?? 0);
    const moved = store().graph.nodes.find((n) => n.id === group.id)!;
    expect(moved.position.x).toBeGreaterThan(connectorX);
    expect(store().text).toContain("    default_pipelines:\n      - 'traces/out'\n      - traces/audit\n");
  });

  it("refuses while locked, for a group, for an undeclared component, and a change it can't splice (the toast; nothing changes)", () => {
    const error = vi.spyOn(toast, "error");
    open(corpusText("undeclared-references.yaml"));
    const undeclared = nodeOf("processors.batch", "traces");
    expect(undeclared.data.declared).toBe(false);
    let before = store();
    expect(store().setComponentValues(undeclared.id, [{ path: ["timeout"], value: "1s" }])).toBe("refused");
    expect(store().setComponentValues(groupOf("traces").id, [{ path: ["timeout"], value: "1s" }])).toBe("refused");
    expect(store().setComponentValues("no-such-node", [{ path: ["timeout"], value: "1s" }])).toBe("refused");
    expect(store().text).toBe(before.text);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toEqual(before.history);

    open(STARTER);
    const batch = nodeOf("processors.batch", "traces");
    before = store();
    for (const change of [
      { path: ["send_batch_size"], plain: "abc" },
      { path: ["timeout", "nested"], value: 1 },
    ]) {
      expect(store().setComponentValues(batch.id, [{ path: ["timeout"], value: "2s" }, change])).toBe("refused");
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
    expect(store().text).toBe(STARTER);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toEqual(before.history);
    expect(isDirty()).toBe(false);

    vi.spyOn(toast, "info").mockImplementation(() => "");
    store().setText(`${STARTER}# typed\n`);
    expect(selectIsCanvasLocked(store())).toBe(true);
    expect(store().setComponentValues(batch.id, [{ path: ["timeout"], value: "2s" }])).toBe("refused");
    expect(store().text).toBe(`${STARTER}# typed\n`);
    expect(store().history.past).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("refuses a move that would change another value of the component, an alias re-bound: the toast; nothing changes", () => {
    const error = vi.spyOn(toast, "error");
    const text = [
      "receivers:",
      "  otlp:",
      "processors:",
      "  attributes:",
      "    list: [",
      "      &x a, # ca",
      "      b,",
      "      &x c # cc",
      "    ]",
      "    ref: *x",
      "exporters:",
      "  debug:",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [attributes]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    open(text);
    const attributes = nodeOf("processors.attributes", "traces");
    const before = store();

    expect(store().setComponentValues(attributes.id, [{ path: ["list", 2], moveTo: 0 }])).toBe("refused");
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
    expect(store().text).toBe(text);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toEqual(before.history);
    expect(isDirty()).toBe(false);

    // Another move in the same list leaves `ref` as it was, and is written.
    expect(store().setComponentValues(attributes.id, [{ path: ["list", 1], moveTo: 0 }])).toBe("written");
    expect(store().text).toContain("    list: [\n      b,\n      &x a, # ca\n      &x c # cc\n    ]\n    ref: *x\n");
    expect(nodeOf("processors.attributes", "traces").data.config).toEqual({ list: ["b", "a", "c"], ref: "c" });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("a write that changes nothing is unchanged: no entry, not dirty, the graph as it was", () => {
    open(STARTER);
    const batch = nodeOf("processors.batch", "traces");
    const before = store();

    expect(store().setComponentValues(batch.id, [])).toBe("unchanged");
    expect(store().setComponentValues(batch.id, [{ path: ["timeout"], value: "10s" }])).toBe("unchanged");
    expect(store().setComponentValues(batch.id, [{ path: ["send_batch_size"], plain: "1024" }])).toBe("unchanged");
    expect(store().setComponentValues(batch.id, [{ path: ["absent_key"], remove: true }])).toBe("unchanged");

    expect(store().text).toBe(STARTER);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toEqual(before.history);
    expect(store().historyRun).toBeNull();
    expect(isDirty()).toBe(false);
  });
});

/*
 * A form's routing or failover target choice writes the connector's entry and
 * the pipeline's receivers in one change, one undo entry, with a toast; an
 * unrelated canvas change leaves the receivers, and the processors, as the
 * text has them.
 */
describe("routing and failover targets wired into receivers", () => {
  const head = (connector = "routing") =>
    [
      "receivers:",
      "  otlp:",
      "processors:",
      "  batch:",
      "exporters:",
      "  debug: # d",
      "connectors:",
      `  ${connector}:`,
      "    default_pipelines: [traces/out]",
      "    table: []",
      "service:",
      "  pipelines:",
      "    traces/in:",
      "      receivers: [otlp]",
      `      exporters: [${connector}]`,
      "    traces/out:",
      `      receivers: [${connector}]`,
      "      exporters: [debug]",
      "",
    ].join("\n");
  const CHOOSE_AUDIT: ValueChange[] = [{ path: ["default_pipelines", 1], value: "traces/audit" }];
  const DEFAULTS_BEFORE = "    default_pipelines: [traces/out]";
  const DEFAULTS_AFTER = "    default_pipelines: [traces/out, traces/audit]";

  function textModel(text: string = store().text) {
    const parsed = parse(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    return readTextModel(parsed.document);
  }

  /** The form's write: one entry, the text the graph describes, one toast, and undo restoring the text. */
  function expectWired(text: string, key: string, changes: readonly ValueChange[], toastText: string) {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    open(text);
    const before = store();
    expect(store().setComponentValues(nodeOf(key).id, changes)).toBe("written");
    expectOneEntry(before, `Update ${nodeOf(key).data.label}`);
    expectTextDescribesGraph();
    expect(info).toHaveBeenCalledTimes(1);
    // Inside ph-no-capture: it names pipelines.
    expect(info).toHaveBeenCalledWith(toastText, { className: "ph-no-capture" });
    const written = store().text;
    store().undo();
    expect(store().text).toBe(text);
    return written;
  }

  it.each([
    {
      style: "a flow list",
      audit: ["    traces/audit:", "      receivers: [otlp] # r", "      exporters: [debug]", ""],
      removed: [DEFAULTS_BEFORE, "      receivers: [otlp] # r"],
      added: [DEFAULTS_AFTER, "      receivers: [otlp, routing] # r"],
    },
    {
      // Its lines and comments kept, not joined onto one line.
      style: "a flow list spread over lines",
      audit: ["    traces/audit:", "      receivers: [ # open", "        # the edge", "        otlp # r", "      ]", "      exporters: [debug]", ""],
      removed: [DEFAULTS_BEFORE, "        otlp # r"],
      added: [DEFAULTS_AFTER, "        otlp, routing # r"],
    },
    {
      style: "a block list",
      audit: ["    traces/audit:", "      receivers:", "        - otlp # r", "      exporters: [debug]", ""],
      removed: [DEFAULTS_BEFORE],
      added: [DEFAULTS_AFTER, "        - routing"],
    },
    {
      style: "a missing receivers key",
      audit: ["    traces/audit:", "      exporters: [debug]", ""],
      removed: [DEFAULTS_BEFORE],
      added: [DEFAULTS_AFTER, "      receivers: [routing]"],
    },
    {
      style: "a null pipeline",
      audit: ["    traces/audit: # a", ""],
      removed: [DEFAULTS_BEFORE],
      added: [DEFAULTS_AFTER, "      receivers: [routing]"],
    },
  ])("choosing a pipeline writes the target and the receiver in one entry: $style", ({ audit, removed, added }) => {
    const text = head() + audit.join("\n");
    const written = expectWired(text, "connectors.routing", CHOOSE_AUDIT, "Added routing to the receivers of traces/audit.");
    expect(lineDiff(text, written)).toEqual({ removed, added });
    expect(textModel(written).pipelines.get("traces/audit")?.receivers).toContain("routing");
  });

  it("wires an instance-named connector by its name", () => {
    const text = head("routing/tenants") + "    traces/audit:\n      receivers: [otlp]\n      exporters: [debug]\n";
    const written = expectWired(text, "connectors.routing/tenants", CHOOSE_AUDIT, "Added routing/tenants to the receivers of traces/audit.");
    expect(lineDiff(text, written).added).toEqual([DEFAULTS_AFTER, "      receivers: [otlp, routing/tenants]"]);
  });

  it("keeps CRLF line endings", () => {
    const text = (head() + "    traces/audit:\n      receivers:\n        - otlp\n      exporters: [debug]\n").replace(/\n/g, "\r\n");
    const written = expectWired(text, "connectors.routing", CHOOSE_AUDIT, "Added routing to the receivers of traces/audit.");
    expect(written.replace(/\r\n/g, "")).not.toContain("\n");
    expect(written).toContain("        - otlp\r\n        - routing\r\n");
  });

  it("gives another pipeline sharing the list by an alias its own copy", () => {
    const text =
      head() +
      ["    traces/audit:", "      receivers: &rs [otlp]", "      exporters: [debug]", "    traces/z:", "      receivers: *rs", "      exporters: [debug]", ""].join(
        "\n",
      );
    const written = expectWired(text, "connectors.routing", CHOOSE_AUDIT, "Added routing to the receivers of traces/audit.");
    expect(textModel(written).pipelines.get("traces/audit")?.receivers).toEqual(["otlp", "routing"]);
    expect(textModel(written).pipelines.get("traces/z")?.receivers).toEqual(["otlp"]);
    expect(lineDiff(text, written)).toEqual({
      removed: [DEFAULTS_BEFORE, "      receivers: &rs [otlp]", "      receivers: *rs"],
      added: [DEFAULTS_AFTER, "      receivers: &rs [otlp, routing]", "      receivers: [otlp]"],
    });
  });

  it("wires a failover level's pipeline", () => {
    const text = [
      "receivers:",
      "  otlp:",
      "exporters:",
      "  debug:",
      "connectors:",
      "  failover:",
      "    priority_levels:",
      "      - [traces/primary]",
      "service:",
      "  pipelines:",
      "    traces/in:",
      "      receivers: [otlp]",
      "      exporters: [failover]",
      "    traces/primary:",
      "      receivers: [failover]",
      "      exporters: [debug]",
      "    traces/backup:",
      "      receivers: [otlp]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    const written = expectWired(
      text,
      "connectors.failover",
      [{ path: ["priority_levels", 1], value: ["traces/backup"] }],
      "Added failover to the receivers of traces/backup.",
    );
    expect(lineDiff(text, written)).toEqual({
      removed: ["      receivers: [otlp]"],
      added: ["      - - traces/backup", "      receivers: [otlp, failover]"],
    });
  });

  it("a run of choices within 800 ms is one entry with the form's other writes, and undo restores both places", () => {
    vi.spyOn(toast, "info").mockImplementation(() => "");
    const text = head() + "    traces/audit:\n      receivers: [otlp]\n      exporters: [debug]\n    traces/more:\n      receivers: [otlp]\n      exporters: [debug]\n";
    open(text);
    const routing = nodeOf("connectors.routing");
    expect(store().setComponentValues(routing.id, CHOOSE_AUDIT)).toBe("written");
    now += 300;
    expect(store().setComponentValues(routing.id, [{ path: ["default_pipelines", 2], value: "traces/more" }])).toBe("written");
    now += 300;
    expect(store().setComponentValues(routing.id, [{ path: ["error_mode"], value: "ignore" }])).toBe("written");
    expect(store().history.past).toHaveLength(1);
    expect(textModel().pipelines.get("traces/audit")?.receivers).toEqual(["otlp", "routing"]);
    expect(textModel().pipelines.get("traces/more")?.receivers).toEqual(["otlp", "routing"]);
    store().undo();
    expect(store().text).toBe(text);
  });

  it("removing a pipeline another route still names leaves its receivers alone, without a toast", () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    open(corpusText("routing-connector.yaml"));
    const before = store();
    // traces/out is a route's target and the default: removing the default keeps it named.
    expect(store().setComponentValues(nodeOf("connectors.routing").id, [{ path: ["default_pipelines"], remove: true }])).toBe("written");
    expect(lineDiff(before.text, store().text)).toEqual({ removed: ["    default_pipelines:", "      - 'traces/out'"], added: [] });
    expect(info).not.toHaveBeenCalled();
    expectTextDescribesGraph();
  });

  it("removing the only receiver's last mention keeps it, with its toast", () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    open(corpusText("routing-connector.yaml"));
    const routing = nodeOf("connectors.routing");
    expect(
      store().setComponentValues(routing.id, [
        { path: ["default_pipelines"], remove: true },
        { path: ["table", 0], remove: true },
      ]),
    ).toBe("written");
    expect(textModel().pipelines.get("traces/out")?.receivers).toEqual(["routing"]);
    expect(store().history.past).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Kept routing in traces/out's receivers: it's the pipeline's only receiver.", { className: "ph-no-capture" });
  });

  it("replacing a with b moves the receiver", () => {
    const text = [
      "receivers:",
      "  otlp:",
      "exporters:",
      "  debug:",
      "connectors:",
      "  routing:",
      "    default_pipelines: [traces/a]",
      "service:",
      "  pipelines:",
      "    traces/in:",
      "      receivers: [otlp]",
      "      exporters: [routing]",
      "    traces/a:",
      "      receivers: [otlp, routing]",
      "      exporters: [debug]",
      "    traces/b:",
      "      receivers: [otlp]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    const written = expectWired(
      text,
      "connectors.routing",
      [{ path: ["default_pipelines", 0], value: "traces/b" }],
      "Added routing to the receivers of traces/b. Removed routing from the receivers of traces/a.",
    );
    expect(lineDiff(text, written)).toEqual({
      removed: ["    default_pipelines: [traces/a]", "      receivers: [otlp, routing]", "      receivers: [otlp]"],
      added: ["    default_pipelines: [traces/b]", "      receivers: [otlp]", "      receivers: [otlp, routing]"],
    });
  });

  it("removing a route or a level unwires what only it named", () => {
    const routes = [
      "receivers:",
      "  otlp:",
      "exporters:",
      "  debug:",
      "connectors:",
      "  routing:",
      "    default_pipelines: [traces/a]",
      "    table:",
      "      - condition: 'true'",
      "        pipelines: [traces/a, traces/b, traces/c]",
      "service:",
      "  pipelines:",
      "    traces/in:",
      "      receivers: [otlp]",
      "      exporters: [routing]",
      "    traces/a:",
      "      receivers: [otlp, routing]",
      "      exporters: [debug]",
      "    traces/b:",
      "      receivers: [otlp, routing]",
      "      exporters: [debug]",
      "    traces/c:",
      "      receivers:",
      "        - otlp",
      "        - routing # c",
      "      exporters: [debug]",
      "",
    ].join("\n");
    const written = expectWired(
      routes,
      "connectors.routing",
      [{ path: ["table", 0], remove: true }],
      "Removed routing from the receivers of traces/b, traces/c.",
    );
    expect(textModel(written).pipelines.get("traces/a")?.receivers).toEqual(["otlp", "routing"]);
    expect(lineDiff(routes, written)).toEqual({
      removed: [
        "    table:",
        "      - condition: 'true'",
        "        pipelines: [traces/a, traces/b, traces/c]",
        "      receivers: [otlp, routing]",
        "        - routing # c",
      ],
      added: ["    table: []", "      receivers: [otlp]"],
    });

    const levels = [
      "receivers:",
      "  otlp:",
      "exporters:",
      "  debug:",
      "connectors:",
      "  failover:",
      "    priority_levels:",
      "      - [traces/primary]",
      "      - [traces/backup]",
      "service:",
      "  pipelines:",
      "    traces/in:",
      "      receivers: [otlp]",
      "      exporters: [failover]",
      "    traces/primary:",
      "      receivers: [failover]",
      "      exporters: [debug]",
      "    traces/backup:",
      "      receivers: [otlp, failover]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    const unwired = expectWired(
      levels,
      "connectors.failover",
      [{ path: ["priority_levels", 1], remove: true }],
      "Removed failover from the receivers of traces/backup.",
    );
    expect(lineDiff(levels, unwired)).toEqual({
      removed: ["      - [traces/backup]", "      receivers: [otlp, failover]"],
      added: ["      receivers: [otlp]"],
    });
  });

  it("an unrelated canvas change leaves an inconsistent text's receivers and processors as they are, both ways", () => {
    const text = corpusText("routing-inconsistent.yaml");
    open(text);
    const services = () => {
      const model = textModel();
      return ["traces/acme", "traces/listed", "traces/named", "traces/primary", "traces/backup"].map((name) => model.pipelines.get(name));
    };
    const before = services();
    expect(before[1]).toEqual({ receivers: ["routing"], processors: ["memory_limiter", "batch"], exporters: ["debug/audit"] });
    expect(before[2]).toEqual({ receivers: ["otlp"], processors: ["memory_limiter", "batch"], exporters: ["debug"] });
    expect(before[4]).toEqual({ receivers: ["otlp"], processors: ["batch"], exporters: ["debug"] });

    const added = store().addPipeline("logs/extra")!;
    expect(services()).toEqual(before);
    expect(lineDiff(text.replace(/\r\n/g, "\n"), store().text.replace(/\r\n/g, "\n")).removed).toEqual([]);
    pause();
    // Another canvas change, then removing the added pipeline again: the text as it was.
    store().applyNodeChanges([{ id: groupOf("logs/extra").id, type: "position", position: { x: 5, y: 5 } }]);
    pause();
    expect(store().deletePipeline(added.id)).toBe(true);
    expect(services()).toEqual(before);
    expect(store().text).toBe(text);
  });

  it("duplicating a connector, and adding a pipeline the config names, don't wire", () => {
    const text = corpusText("routing-connector.yaml").replace("      - 'traces/out'\n    table", "      - 'traces/out'\n      - traces/audit\n    table");
    open(text);
    const copy = store().duplicateNode(nodeOf("connectors.routing").id)!;
    expect(componentKey(copy.data)).toBe("connectors.routing/2");
    expect([...textModel().pipelines.values()].some((lists) => lists.receivers.includes("routing/2"))).toBe(false);
    expect(textModel().components.get("connectors.routing/2")).toEqual(textModel().components.get("connectors.routing"));
    pause();
    store().addPipeline("traces/audit");
    expect(textModel().pipelines.get("traces/audit")?.receivers).toEqual([]);
    expect(textModel().pipelines.get("traces/out")?.receivers).toEqual(["routing"]);
  });

  it("deleting the connector still drops it from every pipeline", () => {
    open(corpusText("routing-connector.yaml"));
    expect(store().deleteNodes([nodeOf("connectors.routing").id])).toBe(true);
    const model = textModel();
    expect(model.components.has("connectors.routing")).toBe(false);
    expect(model.pipelines.get("traces/in")?.exporters).toEqual([]);
    expect(model.pipelines.get("traces/out")?.receivers).toEqual([]);
  });

  it("the YAML box doesn't wire: it writes what is typed", () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    const text = head() + "    traces/audit:\n      receivers: [otlp]\n      exporters: [debug]\n";
    open(text);
    const routing = nodeOf("connectors.routing");
    expect(store().setComponentValue(routing.id, "default_pipelines: [traces/out, traces/audit]\ntable: []\n")).toBe("written");
    expect(lineDiff(text, store().text)).toEqual({ removed: [DEFAULTS_BEFORE], added: [DEFAULTS_AFTER] });
    expect(info).not.toHaveBeenCalled();
    // A later form write that doesn't change the targets wires nothing either.
    pause();
    expect(store().setComponentValues(routing.id, [{ path: ["error_mode"], value: "ignore" }])).toBe("written");
    expect(textModel().pipelines.get("traces/audit")?.receivers).toEqual(["otlp"]);
    expect(info).not.toHaveBeenCalled();
  });

  it("a wiring the text edits can't write refuses the whole change, with the store's message", () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    // A pipeline merged into `service.pipelines` from an anchor: the text edits can't add a key to it.
    const text =
      ["x-p: &p", "  traces/audit:", "    receivers: [otlp]", "    exporters: [debug]", ""].join("\n") +
      head().replace("  pipelines:\n", "  pipelines:\n    <<: *p\n");
    open(text);
    expect(textModel().pipelines.get("traces/audit")?.receivers).toEqual(["otlp"]);
    const before = store();
    expect(store().setComponentValues(nodeOf("connectors.routing").id, CHOOSE_AUDIT)).toBe("refused");
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
    expect(info).not.toHaveBeenCalled();
    expect(store().text).toBe(before.text);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toEqual(before.history);
  });
});

/*
 * The self-monitoring dialog's Apply writes the draft's changes under
 * `service.telemetry` by key path (never replacing the whole section), and
 * Remove Section removes its lines.
 */
describe("self-monitoring's telemetry", () => {
  const BASE = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  debug:
    verbosity: basic
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;

  const TELEMETRY = {
    metrics: {
      level: "detailed",
      readers: [{ pull: { exporter: { prometheus: { host: "0.0.0.0", port: 8888 } } } }],
    },
    logs: { level: "info", encoding: "json" },
    traces: { level: "none" },
    resource: { "service.name": "my-collector", "service.instance.id": null },
  };

  const APPLY = Object.entries(TELEMETRY).map(([key, value]) => ({ path: [key], value }));

  const telemetryOf = (text: string) =>
    (parseYaml(text) as { service?: { telemetry?: unknown } } | null)?.service?.telemetry;

  it("writes telemetry into the text and marks dirty; null survives, as it unsets an automatic attribute", () => {
    open(BASE);
    const before = store();

    expect(store().setTelemetryValues(APPLY)).toBe(true);

    const telemetry = telemetryOf(store().text) as typeof TELEMETRY;
    expect(telemetry).toEqual(TELEMETRY);
    expect(telemetry.resource["service.instance.id"]).toBeNull();
    expect(isDirty()).toBe(true);
    // Only lines were added, and the graph is as it was (telemetry isn't in the model).
    expect(lineDiff(BASE, store().text).removed).toEqual([]);
    expect(store().graph).toEqual(before.graph);
    expectTextDescribesGraph();
  });

  it("takes one entry, \"Edit self-monitoring\", holding the text from before, and undo restores it", () => {
    open(BASE);
    const before = store();

    store().setTelemetryValues(APPLY);

    expectOneEntry(before, "Edit self-monitoring");
    expect(EDIT_SELF_MONITORING).toBe("Edit self-monitoring");
    expect(telemetryOf(store().history.past.at(-1)!.text)).toBeUndefined();
    // Each Apply is its own entry, however soon.
    expect(store().setTelemetryValues([{ path: ["logs", "level"], value: "debug" }])).toBe(true);
    expect(store().history.past).toHaveLength(2);
    expect(store().setTelemetryValues([{ path: ["logs", "level"], value: "warn" }], "Convert to Prometheus reader")).toBe(true);
    expect(selectUndoDescription(store())).toBe("Convert to Prometheus reader");

    store().undo();
    store().undo();
    store().undo();
    expect(store().text).toBe(BASE);
    expect(store().graph.nodes).toEqual(before.graph.nodes);
    expect(isDirty()).toBe(false);
  });

  it("keeps telemetry through the canvas's changes that follow", () => {
    open(BASE);
    store().setTelemetryValues(APPLY);

    expect(store().addPipeline("metrics")).not.toBeNull();
    store().dropComponent(paletteId("processor", "batch"), inside(groupOf("traces")));
    store().deleteNodes([nodeOf("exporters.debug", "traces").id]);
    store().clearCanvas();

    expect(telemetryOf(store().text)).toEqual(TELEMETRY);
    expectTextDescribesGraph();
  });

  it("does nothing for an empty change list, or one that writes what is there: false, no entry, not dirty", () => {
    open(corpusText("service-telemetry.yaml"));
    const before = store();

    expect(store().setTelemetryValues([])).toBe(false);
    expect(store().setTelemetryValues([{ path: ["metrics", "level"], value: "detailed" }])).toBe(false);

    expect(store().text).toBe(before.text);
    expect(store().graph).toBe(before.graph);
    expect(store().history).toEqual(before.history);
    expect(isDirty()).toBe(false);
  });

  it("removeTelemetry removes only its lines, as one undoable entry; false when there is none", () => {
    const text = corpusText("service-telemetry.yaml");
    open(text);
    const before = store();

    expect(store().removeTelemetry()).toBe(true);

    const telemetry = text.slice(text.indexOf("  telemetry:"), text.indexOf("  pipelines:"));
    expect(store().text).toBe(text.replace(telemetry, ""));
    expectOneEntry(before, "Edit self-monitoring");
    expect(store().removeTelemetry()).toBe(false);
    expect(store().history.past).toHaveLength(1);

    store().undo();
    expect(store().text).toBe(text);

    // A `service` holding only telemetry is left as an empty mapping; an explicit null is still removed.
    open("service:\n  telemetry:\n    logs:\n      level: info\n");
    expect(store().removeTelemetry()).toBe(true);
    expect(store().text).toBe("service: {}\n");
    open("service:\n  telemetry:\n  pipelines: {}\n");
    expect(store().removeTelemetry()).toBe(true);
    expect(store().text).toBe("service:\n  pipelines: {}\n");
    open(BASE);
    expect(store().removeTelemetry()).toBe(false);
    expect(store().text).toBe(BASE);
  });

  it("refuses while locked, and a change it can't splice (the toast; nothing changes)", () => {
    const error = vi.spyOn(toast, "error");
    vi.spyOn(toast, "info").mockImplementation(() => "");
    open(corpusText("service-telemetry.yaml"));
    const before = store();

    expect(store().setTelemetryValues([{ path: ["metrics", "level", "x"], value: 1 }])).toBe(false);
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
    expect(store().text).toBe(before.text);
    expect(store().history).toEqual(before.history);

    store().setText(`${before.text}# typed\n`);
    expect(store().setTelemetryValues(APPLY)).toBe(false);
    expect(store().removeTelemetry()).toBe(false);
    expect(store().text).toBe(`${before.text}# typed\n`);
    expect(store().history.past).toEqual([]);
  });
});
