import { describe, expect, it } from "vitest";

import {
  adoption,
  connectionRefusal,
  detachOutside,
  droppedNode,
  ensureParentChildOrder,
  groupAt,
  groupSize,
  instanceLabel,
  layoutSignature,
  reparented,
} from "./canvas-operations.js";
import { corpusText } from "./corpus/corpus.js";
import { PIPELINE_GROUP_HEIGHT, PIPELINE_GROUP_WIDTH } from "./constants.js";
import { createGroupNode } from "./node-builders.js";
import { componentPalette } from "./palette.js";
import { parse } from "./parse.js";
import type { Graph, OTelNode } from "./types.js";

const GROUP = createGroupNode({ id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316" }, 100);

function component(id: string, type: "receiver" | "processor" | "exporter" | "extension" | "connector", parentId?: string): OTelNode {
  return {
    id,
    type,
    position: { x: 10, y: 10 },
    ...(parentId ? { parentId } : {}),
    data: { label: id, componentType: type, componentSubType: "otlp", config: {} },
  };
}

function starter(): Graph {
  const result = parse(corpusText("starter.yaml"));
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

describe("canvas operations", () => {
  it("sizes a group by its style, else the default size", () => {
    expect(groupSize(GROUP)).toEqual({ width: PIPELINE_GROUP_WIDTH, height: PIPELINE_GROUP_HEIGHT });
    expect(groupSize({ ...GROUP, style: { width: "50%", height: -3 } })).toEqual({
      width: PIPELINE_GROUP_WIDTH,
      height: PIPELINE_GROUP_HEIGHT,
    });
  });

  it("hit-tests a group by its bounds, edges included", () => {
    const nodes = [component("node_0", "receiver"), GROUP];
    expect(groupAt(nodes, { x: GROUP.position.x, y: GROUP.position.y })).toBe(GROUP);
    expect(groupAt(nodes, { x: GROUP.position.x + PIPELINE_GROUP_WIDTH, y: GROUP.position.y + PIPELINE_GROUP_HEIGHT })).toBe(GROUP);
    expect(groupAt(nodes, { x: GROUP.position.x - 1, y: GROUP.position.y })).toBeUndefined();
  });

  it("puts groups before their children, and leaves an ordered list as it is", () => {
    const child = component("node_0", "receiver", GROUP.id);
    const ordered = [GROUP, child];
    expect(ensureParentChildOrder(ordered)).toBe(ordered);
    expect(ensureParentChildOrder([child, GROUP])).toEqual([GROUP, child]);
  });

  it("re-parents a node where it is on the canvas, with its pipeline's name", () => {
    const child = component("node_0", "receiver", GROUP.id);
    const out = reparented(child, undefined, [GROUP, child]);
    expect(out.parentId).toBeUndefined();
    expect(out.position).toEqual({ x: GROUP.position.x + 10, y: GROUP.position.y + 10 });
    expect(out.data.pipeline).toBeUndefined();
    const back = reparented(out, GROUP, [GROUP, out]);
    expect(back).toMatchObject({ parentId: GROUP.id, position: { x: 10, y: 10 }, data: { pipeline: "traces" } });
  });

  it("detaches only the children outside a resized group", () => {
    const inside = component("node_0", "receiver", GROUP.id);
    const outside = { ...component("node_1", "exporter", GROUP.id), position: { x: 500, y: 10 } };
    const result = detachOutside([GROUP, inside, outside], GROUP.id, 300, 150);
    expect(result.detached).toBe(true);
    expect(result.nodes[1]).toBe(inside);
    expect(result.nodes[2]!.parentId).toBeUndefined();
    expect(detachOutside([inside], "group_404", 1, 1)).toEqual({ nodes: [inside], detached: false });
  });

  it("drops a connector with its signals and its own config, outside every group", () => {
    const spanmetrics = componentPalette.find((e) => e.subType === "spanmetrics")!;
    const node = droppedNode(spanmetrics, { x: -10, y: -10 }, [GROUP]);
    expect(node).toMatchObject({ type: "connector", position: { x: -10, y: -10 } });
    expect(node.parentId).toBeUndefined();
    expect(node.data.connectorSignals).toEqual({ inputSignal: "traces", outputSignal: "metrics" });
    expect(node.data.connectorSignals).not.toBe(spanmetrics.connectorSignals);
    expect(node.data.key).toBe("connectors.spanmetrics");
  });

  it("numbers a drop after the named instances, counting an unnumbered one as 0", () => {
    const otlp = componentPalette.find((e) => e.type === "receiver" && e.subType === "otlp")!;
    const named = { ...component("node_0", "receiver"), data: { ...component("node_0", "receiver").data, instanceName: "edge" } };
    const fifth = { ...component("node_1", "receiver"), data: { ...component("node_1", "receiver").data, instanceName: "5" } };
    expect(droppedNode(otlp, { x: 0, y: 0 }, [named]).data.instanceName).toBe("2");
    expect(droppedNode(otlp, { x: 0, y: 0 }, [named, fifth]).data.label).toBe("OTLP (6)");
  });

  it("refuses a connection to itself, and allows one it has no signal to check", () => {
    const receiver = component("node_0", "receiver");
    const connector = { ...component("node_1", "connector"), data: { ...component("node_1", "connector").data, connectorSignals: { inputSignal: "traces" as const, outputSignal: "metrics" as const } } };
    expect(connectionRefusal(receiver, receiver, [receiver])).toEqual({});
    // Neither end is in a pipeline: no signal to compare.
    expect(connectionRefusal(receiver, connector, [receiver, connector])).toBeUndefined();
    expect(connectionRefusal(connector, component("node_2", "exporter"), [connector])).toBeUndefined();
  });

  it("adopts nothing when both ends are grouped, or neither, or the group is gone", () => {
    const a = component("node_0", "receiver", GROUP.id);
    const b = component("node_1", "exporter", GROUP.id);
    expect(adoption(a, b, [GROUP, a, b])).toBeUndefined();
    expect(adoption(component("node_2", "receiver"), component("node_3", "exporter"), [])).toBeUndefined();
    expect(adoption(component("node_4", "receiver", "group_404"), component("node_5", "exporter"), [])).toBeUndefined();
  });

  it("labels an instance with its name in brackets after the base label", () => {
    expect(instanceLabel("OTLP", "edge")).toBe("OTLP (edge)");
    expect(instanceLabel("OTLP (edge)", "core")).toBe("OTLP (core)");
    expect(instanceLabel("OTLP (edge)", undefined)).toBe("OTLP");
  });

  describe("the layout's signature", () => {
    it("ignores selection, measurement, sub-pixel moves and the ids a parse gives", () => {
      const graph = starter();
      const signature = layoutSignature(graph);
      expect(layoutSignature(graph)).toBe(signature);
      const noisy: Graph = {
        ...graph,
        nodes: graph.nodes.map((n) => ({
          ...n,
          selected: true,
          measured: { width: 200, height: 72 },
          position: { x: n.position.x + 0.2, y: n.position.y - 0.3 },
        })),
      };
      expect(layoutSignature(noisy)).toBe(signature);
      // The same layout under other ids.
      const renumbered: Graph = {
        ...graph,
        nodes: graph.nodes.map((n) => ({ ...n, id: `${n.id}9`, ...(n.parentId ? { parentId: `${n.parentId}9` } : {}) })),
      };
      expect(layoutSignature(renumbered)).toBe(signature);
    });

    it("changes with a position, a group's size and a pipeline's color", () => {
      const graph = starter();
      const signature = layoutSignature(graph);
      const [first, ...rest] = graph.nodes;
      expect(layoutSignature({ ...graph, nodes: [{ ...first!, position: { x: first!.position.x + 1, y: 0 } }, ...rest] })).not.toBe(signature);
      expect(layoutSignature({ ...graph, nodes: [{ ...first!, style: { width: 1, height: 1 } }, ...rest] })).not.toBe(signature);
      expect(layoutSignature({ ...graph, pipelines: graph.pipelines.map((p) => ({ ...p, color: "#000000" })) })).not.toBe(signature);
      const orphan = { ...graph, nodes: graph.nodes.map((n) => (n.parentId ? { ...n, parentId: "group_404" } : n)) };
      expect(layoutSignature(orphan)).not.toBe(signature);
      const noNumbers = { ...graph, nodes: [{ ...first!, position: { x: Number.NaN, y: 0 } }, ...rest] };
      expect(layoutSignature(noNumbers)).not.toBe(signature);
    });
  });
});
