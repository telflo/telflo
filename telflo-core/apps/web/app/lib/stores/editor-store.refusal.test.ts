import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANT_EDIT_ON_CANVAS_MESSAGE, useEditorStore, type EditorState } from "./editor-store.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import type * as TextEdits from "~/lib/graph/text-edits.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { componentPalette } from "~/lib/graph/palette.js";
import type { OTelNode } from "~/lib/graph/types.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

/*
 * A change the text edits refuse is refused whole, whatever the action. The
 * edits refuse only rare texts (editor-store.builder.test.ts has two real
 * ones); here they are made to refuse every change, so each action's refusal
 * is shown.
 */

const refuse = vi.hoisted(() => ({ on: false, bug: false }));

vi.mock("~/lib/graph/text-edits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TextEdits>();
  const fail = () => {
    if (refuse.bug) throw new Error("a bug, not a refusal");
    if (refuse.on) throw new actual.TextEditError("refused for the test");
  };
  return {
    ...actual,
    editText: (...args: Parameters<typeof actual.editText>) => {
      fail();
      return actual.editText(...args);
    },
    writeComponentValue: (...args: Parameters<typeof actual.writeComponentValue>) => {
      fail();
      return actual.writeComponentValue(...args);
    },
  };
});

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

function nodeOf(key: string, pipeline: string): OTelNode {
  const { nodes } = store().graph;
  const group = nodes.find((n) => n.type === "pipelineGroup" && n.data.label === pipeline)!;
  return nodes.find((n) => n.parentId === group.id && componentKey(n.data) === key)!;
}

function groupId(pipeline: string): string {
  return store().graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === pipeline)!.id;
}

let now = 5_000_000;

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.restoreAllMocks();
  refuse.on = false;
  refuse.bug = false;
  now = 5_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  useEditorStore.getState().load({
    organizationId: GROUP_ID,
    configuration: MINE,
    version: versionFixture({ yamlContent: STARTER }),
  });
});

function expectRefused(before: EditorState) {
  expect(store().text).toBe(before.text);
  expect(store().graph).toBe(before.graph);
  expect(store().history).toBe(before.history);
  expect(store().document).toBe(before.document);
}

describe("a change the text edits refuse", () => {
  const actions: [string, () => unknown][] = [
    ["a drop", () => store().dropComponent(componentPalette[0]!.id, { x: 0, y: 0 })],
    ["a connection", () => store().connect({ source: nodeOf("receivers.otlp", "traces").id, target: nodeOf("exporters.otlp", "traces").id })],
    ["a delete", () => store().deleteNodes([nodeOf("processors.batch", "traces").id])],
    ["a connection's delete", () => store().deleteEdges([store().graph.edges[0]!.id])],
    ["a duplicate", () => store().duplicateNode(nodeOf("processors.batch", "traces").id)],
    ["a link", () => store().linkNodeToGroup(nodeOf("exporters.otlp", "traces").id, groupId("logs"))],
    ["a move out of a group", () => store().moveNodeToGroup(nodeOf("exporters.otlp", "traces").id, null)],
    ["a new pipeline", () => store().addPipeline("logs/more")],
    ["a pipeline's delete", () => store().deletePipeline(store().graph.pipelines[0]!.id)],
    ["an instance rename", () => store().renameInstance(nodeOf("processors.batch", "traces").id, "x")],
    ["Clear canvas", () => store().clearCanvas()],
  ];

  it.each(actions)("%s: graph, text and history stay as they were, with the toast", (_name, act) => {
    const error = vi.spyOn(toast, "error");
    const before = store();
    refuse.on = true;

    act();

    expectRefused(before);
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
  });

  it("layout changes don't reach the edits: a move, a colour and Tidy up still work", () => {
    refuse.on = true;
    store().setPipelineColor(store().graph.pipelines[0]!.id, "#10b981");
    now += 1000;
    store().tidyUp();
    const otlp = nodeOf("receivers.otlp", "traces");
    store().applyNodeChanges([{ id: otlp.id, type: "position", position: { x: 5, y: 5 } }]);
    expect(store().history.past.map((e) => e.description)).toEqual(["Change color of traces", "Tidy up layout", "Move OTLP"]);
    expect(store().text).toBe(STARTER);
  });

  it("a drag into another group is undone whole, its entry dropped", () => {
    vi.spyOn(toast, "error");
    const before = store();
    const otlp = nodeOf("exporters.otlp", "logs");
    const traces = store().graph.nodes.find((n) => n.id === groupId("traces"))!;
    const logs = store().graph.nodes.find((n) => n.id === groupId("logs"))!;
    const into = { x: traces.position.x + 700 - logs.position.x, y: traces.position.y + 60 - logs.position.y };

    store().applyNodeChanges([{ id: otlp.id, type: "position", position: into, dragging: true }]);
    expect(store().history.past).toHaveLength(1);
    refuse.on = true;
    expect(store().finishMove([otlp.id])).toBe(false);

    expect(store().graph).toBe(before.graph);
    expect(store().history.past).toEqual([]);
    expect(store().text).toBe(STARTER);
  });

  it("a group resize that leaves a child outside is refused whole", () => {
    const error = vi.spyOn(toast, "error");
    const before = store();
    refuse.on = true;

    store().applyNodeChanges([
      { id: groupId("traces"), type: "dimensions", dimensions: { width: 20, height: 20 }, resizing: true, setAttributes: true },
    ]);

    expectRefused(before);
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
  });

  it("the YAML box: nothing written, with the toast", () => {
    const error = vi.spyOn(toast, "error");
    const before = store();
    refuse.on = true;

    expect(store().setComponentValue(nodeOf("processors.batch", "traces").id, "timeout: 1s\n")).toBe("refused");

    expectRefused(before);
    expect(error).toHaveBeenCalledWith(CANT_EDIT_ON_CANVAS_MESSAGE);
  });

  it("anything else the edits throw is a bug, and isn't hidden as a refusal", () => {
    const error = vi.spyOn(toast, "error");
    const before = store();
    refuse.bug = true;

    expect(() => store().deleteNodes([nodeOf("processors.batch", "traces").id])).toThrow("a bug, not a refusal");
    expect(() => store().setComponentValue(nodeOf("processors.batch", "traces").id, "timeout: 1s\n")).toThrow(
      "a bug, not a refusal",
    );

    expectRefused(before);
    expect(error).not.toHaveBeenCalled();
  });
});
