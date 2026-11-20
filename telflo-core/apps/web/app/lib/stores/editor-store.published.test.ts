import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  selectCanRedo,
  selectCanUndo,
  selectIsCanvasLocked,
  selectIsDirty,
  selectIsEditingLocked,
  selectIsVersionPublished,
  summaryOf,
  useEditorStore,
} from "./editor-store.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import type { OTelNode } from "~/lib/graph/types.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, versionFixture, versionSummaryOf } from "~/test/configurations.js";

/*
 * A published version is read-only: its own mode, driven by
 * `selectIsVersionPublished`, in which selection works and every change is
 * refused in the store. And the summary a publish answers replaces the open
 * version's without a reload.
 */

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

const DRAFT = versionFixture({ yamlContent: STARTER });
const PUBLISHED = versionFixture({ yamlContent: STARTER, ...PUBLISHED_FIELDS });
const OTHER = versionFixture({ id: "0199c000-0000-7000-8000-000000000012", versionNumber: 2, yamlContent: "" });

function open(version = PUBLISHED) {
  store().load({
    organizationId: GROUP_ID,
    configuration: MINE,
    version,
    versions: [versionSummaryOf(OTHER), versionSummaryOf(version)],
  });
}

function nodeOf(key: string, pipeline: string): OTelNode {
  const { nodes } = store().graph;
  const group = nodes.find((n) => n.type === "pipelineGroup" && n.data.label === pipeline)!;
  return nodes.find((n) => n.parentId === group.id && componentKey(n.data) === key)!;
}

const groupOf = (pipeline: string) =>
  store().graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === pipeline)!;

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectIsVersionPublished", () => {
  it("is true only while the open version has a publishedAt", () => {
    expect(selectIsVersionPublished(store())).toBe(false);
    open(DRAFT);
    expect(selectIsVersionPublished(store())).toBe(false);
    open(PUBLISHED);
    expect(selectIsVersionPublished(store())).toBe(true);
  });

  it("is its own mode: the canvas isn't locked (it can be inspected), but editing is", () => {
    open(PUBLISHED);
    expect(selectIsCanvasLocked(store())).toBe(false);
    expect(selectIsEditingLocked(store())).toBe(true);
    open(DRAFT);
    expect(selectIsEditingLocked(store())).toBe(false);
  });
});

describe("a published version in the store", () => {
  /** Runs `change` and expects the text, the graph and the history untouched, and nothing toasted. */
  function expectRefused(change: () => unknown) {
    const { text, graph, history } = store();
    change();
    expect(store().text).toBe(text);
    expect(store().graph).toBe(graph);
    expect(store().history).toBe(history);
    expect(selectIsDirty(store())).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  }

  beforeEach(() => open(PUBLISHED));

  it("refuses typing: setText, which never enters manual edit mode", () => {
    expectRefused(() => store().setText(`${STARTER}# typed\n`));
    expect(store().isYamlEditing).toBe(false);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("refuses dropping a component, connecting, and deleting through the dialog or directly", () => {
    const batch = nodeOf("processors.batch", "traces");
    const otlp = nodeOf("receivers.otlp", "logs");
    const exporter = nodeOf("exporters.otlp", "logs");
    expectRefused(() => expect(store().dropComponent("otlp-receiver", { x: 100, y: 100 })).toBeNull());
    expectRefused(() => expect(store().connect({ source: otlp.id, target: exporter.id })).toEqual({ ok: false }));
    expectRefused(() => store().requestDelete({ kind: "nodes", nodeIds: [batch.id] }));
    expect(store().pendingDelete).toBeNull();
    expectRefused(() => expect(store().deleteNodes([batch.id])).toBe(false));
    expectRefused(() => expect(store().deleteEdges(store().graph.edges.map((e) => e.id))).toBe(false));
    expectRefused(() => expect(store().deletePipeline(groupOf("traces").data.pipelineId!)).toBe(false));
  });

  it("refuses the selection's delete (the Delete key) too", () => {
    const batch = nodeOf("processors.batch", "traces");
    store().selectNode(batch.id);
    expectRefused(() => store().requestDelete());
    expect(store().pendingDelete).toBeNull();
  });

  it("refuses moves and resizes from React Flow, keeping the selection it reports", () => {
    const batch = nodeOf("processors.batch", "traces");
    const traces = groupOf("traces");
    const { graph } = store();
    store().applyNodeChanges([
      { type: "position", id: batch.id, position: { x: batch.position.x + 200, y: batch.position.y }, dragging: false },
      { type: "dimensions", id: traces.id, dimensions: { width: 1400, height: 600 }, resizing: true, setAttributes: true },
      { type: "select", id: batch.id, selected: true },
    ]);
    expect(store().graph.nodes.find((n) => n.id === batch.id)!.position).toEqual(batch.position);
    expect(store().graph.nodes.find((n) => n.id === batch.id)!.selected).toBe(true);
    expect(store().graph.pipelines).toBe(graph.pipelines);
    expect(selectIsDirty(store())).toBe(false);
    expect(store().history.past).toHaveLength(0);
    expectRefused(() => expect(store().finishMove([batch.id])).toBe(false));
    expectRefused(() => expect(store().moveNodeToGroup(batch.id, null)).toBe(false));
    expectRefused(() => expect(store().resizeGroup(traces.id, { width: 1400, height: 600 })).toBe(false));
  });

  it("refuses the toolbox's, the canvas actions' and the Configuration tab's changes", () => {
    const batch = nodeOf("processors.batch", "traces");
    expectRefused(() => expect(store().addPipeline("traces/two")).toBeNull());
    expectRefused(() => expect(store().tidyUp()).toBe(false));
    expectRefused(() => expect(store().clearCanvas()).toBe(false));
    expectRefused(() => expect(store().setPipelineColor(groupOf("traces").data.pipelineId!, "#000000")).toBe(false));
    const exporter = nodeOf("exporters.otlp", "logs");
    expectRefused(() => expect(store().duplicateNode(nodeOf("processors.batch", "metrics").id)).toBeNull());
    expectRefused(() => expect(store().linkNodeToGroup(nodeOf("processors.batch", "metrics").id, groupOf("traces").id)).toBeNull());
    expectRefused(() => expect(store().renameInstance(batch.id, "renamed")).toBe(false));
    expectRefused(() => expect(store().setComponentValues(exporter.id, [{ path: ["timeout"], value: "5s" }])).toBe("refused"));
    expectRefused(() => expect(store().setComponentValue(exporter.id, "endpoint: x:1\n")).toBe("refused"));
    expectRefused(() => expect(store().setTelemetryValues([{ path: ["logs", "level"], value: "debug" }])).toBe(false));
  });

  it("selects and inspects: selectNode, setSelection and React Flow's selection all work, never dirtying it", () => {
    const batch = nodeOf("processors.batch", "traces");
    const otlp = nodeOf("receivers.otlp", "traces");
    store().selectNode(batch.id);
    expect(store().selectedNode?.id).toBe(batch.id);
    store().setSelection([batch.id, otlp.id]);
    expect(store().selectedNodes.map((n) => n.id)).toEqual([batch.id, otlp.id]);
    store().selectNode(groupOf("traces").id);
    expect(store().selectedNode?.id).toBe(groupOf("traces").id);
    expect(selectIsDirty(store())).toBe(false);
  });
});

describe("the same changes on a draft", () => {
  it("are made, so the refusals above are the read-only mode's", () => {
    const changes: [string, () => unknown][] = [
      ["drop", () => store().dropComponent("otlp-receiver", { x: 100, y: 100 })],
      ["connect", () => store().connect({ source: nodeOf("receivers.otlp", "logs").id, target: nodeOf("exporters.otlp", "logs").id }).ok || null],
      ["delete", () => store().deleteNodes([nodeOf("processors.batch", "traces").id]) || null],
      ["add pipeline", () => store().addPipeline("traces/two")],
      ["tidy up", () => store().tidyUp() || null],
      ["duplicate", () => store().duplicateNode(nodeOf("processors.batch", "metrics").id)],
      ["link", () => store().linkNodeToGroup(nodeOf("processors.batch", "metrics").id, groupOf("traces").id)],
      ["rename", () => store().renameInstance(nodeOf("processors.batch", "logs").id, "renamed") || null],
      ["form", () => (store().setComponentValues(nodeOf("exporters.otlp", "logs").id, [{ path: ["timeout"], value: "5s" }]) === "written" ? true : null)],
      ["box", () => (store().setComponentValue(nodeOf("exporters.otlp", "logs").id, "endpoint: x:1\n") === "written" ? true : null)],
      ["telemetry", () => store().setTelemetryValues([{ path: ["logs", "level"], value: "debug" }]) || null],
      ["typing", () => (store().setText(`${store().text}# typed\n`), store().isYamlEditing || null)],
    ];
    for (const [name, change] of changes) {
      open(DRAFT);
      expect(change(), name).not.toBeNull();
    }
  });
});

describe("undo and redo on a version published under the editor", () => {
  it("are inert: the history is kept, but undo and redo refuse and say so nowhere", () => {
    open(DRAFT);
    const batch = nodeOf("processors.batch", "traces");
    expect(store().setComponentValues(batch.id, [{ path: ["timeout"], value: "5s" }])).toBe("written");
    expect(store().addPipeline("traces/two")).not.toBeNull();
    expect(store().undo()).toBe(true);
    expect(selectCanUndo(store())).toBe(true);
    expect(selectCanRedo(store())).toBe(true);
    vi.mocked(toast.info).mockClear();

    store().replaceVersionSummary({ ...summaryOf(DRAFT), ...PUBLISHED_FIELDS });

    expect(selectCanUndo(store())).toBe(false);
    expect(selectCanRedo(store())).toBe(false);
    const { text, history } = store();
    expect(store().redo()).toBe(false);
    expect(store().undo()).toBe(false);
    expect(store().text).toBe(text);
    expect(store().history).toBe(history);
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe("replaceVersionSummary", () => {
  it("puts the summary in the list and in the open version, keeping its text, graph, history and canvas: no reload", () => {
    open(DRAFT);
    const batch = nodeOf("processors.batch", "traces");
    store().setComponentValues(batch.id, [{ path: ["timeout"], value: "5s" }]);
    const before = store();
    const published = { ...summaryOf(DRAFT), ...PUBLISHED_FIELDS };

    store().replaceVersionSummary(published);

    const after = store();
    expect(after.versions).toEqual([versionSummaryOf(OTHER), published]);
    expect(after.version).toEqual({ ...DRAFT, ...PUBLISHED_FIELDS });
    expect(selectIsVersionPublished(after)).toBe(true);
    for (const key of ["text", "savedText", "graph", "history", "canvasKey", "loadCount", "selectedNode"] as const) {
      expect(after[key]).toBe(before[key]);
    }
    // Unsaved text stays on screen (a stale tab): still dirty.
    expect(selectIsDirty(after)).toBe(true);
  });

  it("replaces another version's row alone, leaving the open version as it is", () => {
    open(DRAFT);
    const other = { ...versionSummaryOf(OTHER), ...PUBLISHED_FIELDS };
    store().replaceVersionSummary(other);
    expect(store().versions).toEqual([other, versionSummaryOf(DRAFT)]);
    expect(store().version).toEqual(DRAFT);
    expect(selectIsVersionPublished(store())).toBe(false);
  });

  it("copies only a summary's fields, whatever else the object carries", () => {
    open(DRAFT);
    store().replaceVersionSummary({ ...DRAFT, ...PUBLISHED_FIELDS, yamlContent: "other: text\n" } as never);
    expect(store().versions[1]).toEqual({ ...versionSummaryOf(DRAFT), ...PUBLISHED_FIELDS });
    expect(store().version?.yamlContent).toBe(STARTER);
  });

  it("ends a clean manual edit mode, with the saved text on the canvas, as opening the version would show it", () => {
    open(DRAFT);
    const typed = STARTER.replace("timeout: '10s'", "timeout: '3s'");
    store().setText(typed);
    // A save in manual edit mode: clean, still in the mode.
    store().markSaved(typed, { ...DRAFT, yamlContent: typed });
    expect(store().isYamlEditing).toBe(true);
    expect(selectIsDirty(store())).toBe(false);

    store().replaceVersionSummary({ ...summaryOf(DRAFT), ...PUBLISHED_FIELDS });

    expect(store().isYamlEditing).toBe(false);
    expect(store().text).toBe(typed);
    expect(nodeOf("processors.batch", "traces").data.config).toMatchObject({ timeout: "3s" });
    expect(selectIsDirty(store())).toBe(false);
    expect(selectIsCanvasLocked(store())).toBe(false);
  });

  it("keeps manual edit mode and its typed text when they are unsaved (a stale tab)", () => {
    open(DRAFT);
    const typed = `${STARTER}# typed\n`;
    store().setText(typed);
    store().replaceVersionSummary({ ...summaryOf(DRAFT), ...PUBLISHED_FIELDS });
    expect(store().isYamlEditing).toBe(true);
    expect(store().text).toBe(typed);
    // Apply changes nothing on a published version.
    expect(store().apply()).toEqual({ ok: false, reason: "This version is published and can't be changed." });
    expect(store().text).toBe(typed);
    expect(store().isYamlEditing).toBe(true);
  });

  it("takes Undo All in a stale tab's manual edit mode: the screen goes back to the published text, out of the mode, and the canvas can be inspected", () => {
    open(DRAFT);
    const typed = `${STARTER}# typed\n`;
    store().setText(typed);
    store().replaceVersionSummary({ ...summaryOf(DRAFT), ...PUBLISHED_FIELDS });
    expect(selectIsCanvasLocked(store())).toBe(true);

    store().undoAll();

    expect(store().text).toBe(STARTER);
    expect(store().isYamlEditing).toBe(false);
    expect(selectIsDirty(store())).toBe(false);
    expect(selectIsCanvasLocked(store())).toBe(false);
    // Still published, still read-only: typing again and Apply change nothing.
    expect(selectIsVersionPublished(store())).toBe(true);
    store().setText(typed);
    expect(store().text).toBe(STARTER);
    expect(store().isYamlEditing).toBe(false);
    expect(store().apply()).toEqual({ ok: false, reason: "There are no typed changes to apply." });
  });

  it("Undo All on a published version puts back what was published, text and graph, not a canvas change made before the typing and never saved: clean, out of the mode, still locked", () => {
    open(DRAFT);
    const published = { text: store().savedText, graph: store().savedGraph };
    // A canvas change, unsaved: the text and the graph both change.
    expect(store().deleteNodes([nodeOf("processors.batch", "traces").id])).toBe(true);
    const canvasEdited = store().text;
    expect(canvasEdited).not.toBe(STARTER);
    expect(selectIsDirty(store())).toBe(true);
    // Then typing in the YAML tab: manual edit mode, from the canvas-edited text.
    store().setText(`${canvasEdited}# typed\n`);
    expect(store().preEditText).toBe(canvasEdited);
    // A teammate publishes it: a stale tab's refused save reads the summary again.
    store().replaceVersionSummary({ ...summaryOf(DRAFT), ...PUBLISHED_FIELDS });
    expect(selectIsCanvasLocked(store())).toBe(true);
    const { history } = store();

    store().undoAll();

    expect(store().text).toBe(STARTER);
    expect(store().text).toBe(store().savedText);
    expect(store().graph).toEqual(published.graph);
    expect(store().savedGraph).toEqual(published.graph);
    expect(store().graph.nodes.some((n) => n.data.componentSubType === "batch")).toBe(true);
    expect(store().graphStatus).toBe("ready");
    expect(selectIsDirty(store())).toBe(false);
    expect(store()).toMatchObject({ isYamlEditing: false, preEditText: null });
    expect(selectIsCanvasLocked(store())).toBe(false);
    // Still published and read-only; the undo history stays, inert.
    expect(selectIsVersionPublished(store())).toBe(true);
    expect(selectIsEditingLocked(store())).toBe(true);
    expect(store().history).toBe(history);
    expect(store().undo()).toBe(false);
    expect(store().text).toBe(STARTER);
    expect(toast.info).toHaveBeenLastCalledWith("Changes reverted");
  });

  it("Undo All on a draft still puts back the text from before the typing, canvas changes kept", () => {
    open(DRAFT);
    store().deleteNodes([nodeOf("processors.batch", "traces").id]);
    const canvasEdited = store().text;
    store().setText(`${canvasEdited}# typed\n`);

    store().undoAll();

    expect(store().text).toBe(canvasEdited);
    expect(store().isYamlEditing).toBe(false);
    expect(selectIsDirty(store())).toBe(true);
  });
});

describe("replaceVersion: a re-read after a teammate's publish", () => {
  // A teammate edited the version, saved and published it: content this tab never loaded.
  const TEAMMATE_TEXT = STARTER.replace("timeout: '10s'", "timeout: '3s'");
  const TEAMMATE_PUBLISHED = {
    ...DRAFT,
    ...PUBLISHED_FIELDS,
    yamlContent: TEAMMATE_TEXT,
    updatedAt: "2026-10-04T11:30:00.000Z",
  };

  it("a clean tab takes the published content as its baseline and shows it, as a clean load would: clean, locked, no reload", () => {
    expect(TEAMMATE_TEXT).not.toBe(STARTER);
    open(DRAFT);
    // A save in manual edit mode, then a node selected: clean, still in the mode.
    const typed = `${STARTER}# typed and saved\n`;
    store().setText(typed);
    store().markSaved(typed, { ...DRAFT, yamlContent: typed });
    store().selectNode(nodeOf("processors.batch", "traces").id);
    expect(store().isYamlEditing).toBe(true);
    expect(selectIsDirty(store())).toBe(false);
    const before = store();

    store().replaceVersion(TEAMMATE_PUBLISHED);

    const after = store();
    expect(after).toMatchObject({
      text: TEAMMATE_TEXT,
      savedText: TEAMMATE_TEXT,
      graphStatus: "ready",
      isYamlEditing: false,
      preEditText: null,
      selectedNode: null,
      selectedNodes: [],
    });
    expect(nodeOf("processors.batch", "traces").data.config).toMatchObject({ timeout: "3s" });
    expect(after.savedGraph).toBe(after.graph);
    expect(selectIsDirty(after)).toBe(false);
    expect(selectIsVersionPublished(after)).toBe(true);
    expect(selectIsCanvasLocked(after)).toBe(false);
    expect(after.version).toEqual(TEAMMATE_PUBLISHED);
    expect(after.versions).toEqual([versionSummaryOf(OTHER), versionSummaryOf(TEAMMATE_PUBLISHED)]);
    // No reload: the canvas isn't mounted afresh, and the history stays, inert.
    for (const key of ["history", "canvasKey", "loadCount", "activeTab"] as const) {
      expect(after[key]).toBe(before[key]);
    }
    expect(store().undo()).toBe(false);
    expect(store().text).toBe(TEAMMATE_TEXT);
  });

  it("a stale tab keeps its unsaved text, dirty against what was published; Undo All then puts back the published content, clean", () => {
    open(DRAFT);
    const typed = `${STARTER}# typed before the teammate published\n`;
    store().setText(typed);
    const { graph, history } = store();

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({ text: typed, savedText: TEAMMATE_TEXT, isYamlEditing: true, preEditText: STARTER });
    expect(store().graph).toBe(graph);
    expect(selectIsDirty(store())).toBe(true);
    expect(selectIsVersionPublished(store())).toBe(true);
    expect(selectIsCanvasLocked(store())).toBe(true);

    store().undoAll();

    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, savedText: TEAMMATE_TEXT, isYamlEditing: false, preEditText: null });
    expect(nodeOf("processors.batch", "traces").data.config).toMatchObject({ timeout: "3s" });
    expect(selectIsDirty(store())).toBe(false);
    expect(selectIsVersionPublished(store())).toBe(true);
    expect(store().history).toBe(history);
  });

  it("a stale tab's unsaved canvas change stays, dirty; Discard puts back the published content", () => {
    open(DRAFT);
    expect(store().deleteNodes([nodeOf("processors.batch", "traces").id])).toBe(true);
    const canvasEdited = store().text;

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({ text: canvasEdited, savedText: TEAMMATE_TEXT, isYamlEditing: false });
    expect(selectIsDirty(store())).toBe(true);

    store().discardChanges();

    expect(store().text).toBe(TEAMMATE_TEXT);
    expect(nodeOf("processors.batch", "traces").data.config).toMatchObject({ timeout: "3s" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("unsaved text that is what was published anyway: shown as published, clean, out of manual edit mode", () => {
    open(DRAFT);
    store().setText(TEAMMATE_TEXT);
    expect(selectIsDirty(store())).toBe(true);

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, savedText: TEAMMATE_TEXT, isYamlEditing: false });
    expect(nodeOf("processors.batch", "traces").data.config).toMatchObject({ timeout: "3s" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("another version: its row's summary alone, the open version as it is", () => {
    open(DRAFT);
    store().setText(`${STARTER}# typed\n`);
    const before = store();
    const other = { ...OTHER, ...PUBLISHED_FIELDS, yamlContent: TEAMMATE_TEXT };

    store().replaceVersion(other);

    expect(store().versions).toEqual([versionSummaryOf(other), versionSummaryOf(DRAFT)]);
    for (const key of ["version", "text", "savedText", "savedGraph", "savedLayout", "graph", "isYamlEditing"] as const) {
      expect(store()[key]).toBe(before[key]);
    }
    expect(selectIsVersionPublished(store())).toBe(false);
  });
});

describe("isPublishing", () => {
  it("is set and cleared, and a load clears it", () => {
    open(DRAFT);
    store().setPublishing(true);
    expect(store().isPublishing).toBe(true);
    open(DRAFT);
    expect(store().isPublishing).toBe(false);
  });
});
