import { describe, it, expect } from "vitest";
import type { OTelEdge, OTelNode, OTelNodeData } from "./types.js";
import {
  buildDuplicateNode,
  buildDuplicateNodes,
  buildLinkedNode,
  componentKey,
  componentName,
  pruneGroupChildren,
  sharedConfigIdOf,
  splitComponentName,
} from "./node-operations.js";

function makeNode(overrides: { id: string; type?: string; parentId?: string; data?: Partial<OTelNodeData> }): OTelNode {
  return {
    id: overrides.id,
    type: overrides.type ?? "processor",
    position: { x: 0, y: 0 },
    ...(overrides.parentId === undefined ? {} : { parentId: overrides.parentId }),
    data: {
      label: "Batch",
      componentType: "processor",
      componentSubType: "batch",
      config: {},
      ...overrides.data,
    },
  };
}

function edge(id: string, source: string, target: string): OTelEdge {
  return { id, source, target };
}

describe("pruneGroupChildren", () => {
  it("removes the group node, its children, and edges referencing those children", () => {
    const group = makeNode({ id: "group_0", type: "pipelineGroup" });
    const child1 = makeNode({ id: "c1", parentId: "group_0" });
    const child2 = makeNode({ id: "c2", parentId: "group_0" });
    const outsider = makeNode({ id: "other" });
    const nodes = [group, child1, child2, outsider];
    const edges: OTelEdge[] = [edge("e1", "c1", "c2"), edge("e2", "c2", "other"), edge("e3", "other", "other")];

    const result = pruneGroupChildren(nodes, edges, "group_0");

    expect(result.nodes.map((n) => n.id)).toEqual(["other"]);
    expect(result.edges.map((e) => e.id)).toEqual(["e3"]);
  });

  it("returns nodes/edges unchanged (minus the group itself) when the group has no children", () => {
    const group = makeNode({ id: "group_1", type: "pipelineGroup" });
    const outsider = makeNode({ id: "other" });
    const nodes = [group, outsider];
    const edges: OTelEdge[] = [edge("e1", "other", "other")];

    const result = pruneGroupChildren(nodes, edges, "group_1");

    expect(result.nodes.map((n) => n.id)).toEqual(["other"]);
    expect(result.edges).toEqual(edges);
  });

  it("removes a connector's edge to or from the group itself (D9a)", () => {
    const group = makeNode({ id: "group_0", type: "pipelineGroup" });
    const connector = makeNode({ id: "conn", type: "connector" });
    const edges = [edge("e1", "conn", "group_0"), edge("e2", "group_0", "conn")];

    expect(pruneGroupChildren([group, connector], edges, "group_0").edges).toEqual([]);
  });
});

// Sanity checks preserving pre-existing coverage for functions already in this module.
describe("existing node-operations exports remain callable", () => {
  it("buildDuplicateNode / buildDuplicateNodes / buildLinkedNode still exported", () => {
    expect(typeof buildDuplicateNode).toBe("function");
    expect(typeof buildDuplicateNodes).toBe("function");
    expect(typeof buildLinkedNode).toBe("function");
  });
});

describe("component names and keys (D9a)", () => {
  it("splits a name at its first slash, as the collector does", () => {
    expect(splitComponentName("otlp")).toEqual({ type: "otlp" });
    expect(splitComponentName("otlp/2")).toEqual({ type: "otlp", instanceName: "2" });
    expect(splitComponentName("otlp/team/eu")).toEqual({ type: "otlp", instanceName: "team/eu" });
  });

  it("keeps the text's spelling of a renamed type", () => {
    const data = { componentType: "exporter" as const, componentSubType: "otlp", key: "exporters.otlp_grpc/first", instanceName: "first" };
    expect(componentName(data)).toBe("otlp_grpc/first");
    expect(componentKey(data)).toBe("exporters.otlp_grpc/first");
  });

  it("follows a renamed instance, and spells a new node the palette's way", () => {
    expect(componentName({ componentSubType: "otlp", key: "exporters.otlp_grpc", instanceName: "backup" })).toBe(
      "otlp_grpc/backup",
    );
    expect(componentName({ componentSubType: "batch", instanceName: "x" })).toBe("batch/x");
    expect(componentKey({ componentType: "pipelineGroup", componentSubType: "pipelineGroup" })).toBeUndefined();
  });

  it("gives a duplicate its own key, config and pipeline, unlinked (its own sharedConfigId, the parser's for its key: Ruling 60) and declared", () => {
    const original = makeNode({
      id: "node_0",
      parentId: "group_0",
      data: {
        componentType: "exporter",
        componentSubType: "otlp",
        label: "OTLP",
        key: "exporters.otlp_grpc",
        pipeline: "traces",
        declared: false,
        sharedConfigId: "exporter-otlp_grpc",
        config: { endpoint: "a:4317" },
      },
    });
    const group = makeNode({ id: "group_1", type: "pipelineGroup", data: { label: "traces/other", componentType: "pipelineGroup" } });

    const copy = buildDuplicateNode(original, [original, group], "group_1");

    expect(copy.id).toBe("node_1");
    expect(copy.parentId).toBe("group_1");
    expect(copy.data).toEqual({
      label: "OTLP (2)",
      componentType: "exporter",
      componentSubType: "otlp",
      instanceName: "2",
      key: "exporters.otlp_grpc/2",
      sharedConfigId: "exporter-otlp_grpc/2",
      pipeline: "traces/other",
      config: { endpoint: "a:4317" },
    });
    expect(copy.data.config).not.toBe(original.data.config);

    const [inPlace] = buildDuplicateNodes([original], [original]);
    expect(inPlace?.parentId).toBe("group_0");
    expect(inPlace?.data.pipeline).toBe("traces");
    expect(inPlace?.position).toEqual({ x: 50, y: 50 });
  });

  it("links a node into another pipeline with one shared config", () => {
    const source = makeNode({ id: "node_0", parentId: "group_0", data: { key: "processors.batch", pipeline: "traces" } });
    const group = makeNode({ id: "group_1", type: "pipelineGroup", data: { label: "logs", componentType: "pipelineGroup" } });

    const { linkedNode, updatedNodes } = buildLinkedNode(source, "group_1", [source, group]);

    expect(linkedNode.id).toBe("node_1");
    expect(linkedNode.data.pipeline).toBe("logs");
    expect(linkedNode.data.key).toBe("processors.batch");
    expect(linkedNode.data.sharedConfigId).toBe("processor-batch");
    expect(updatedNodes.find((n) => n.id === "node_0")?.data.sharedConfigId).toBe("processor-batch");
  });

  it("makes the shared id from the kind and the name in the text's spelling, as the parser does", () => {
    expect(sharedConfigIdOf({ componentType: "processor", componentSubType: "batch", key: "processors.batch" })).toBe(
      "processor-batch",
    );
    expect(
      sharedConfigIdOf({ componentType: "processor", componentSubType: "batch", instanceName: "2", key: "processors.batch/2" }),
    ).toBe("processor-batch/2");
    expect(sharedConfigIdOf({ componentType: "exporter", componentSubType: "otlp", key: "exporters.otlp_grpc" })).toBe(
      "exporter-otlp_grpc",
    );
    // A node the text doesn't have yet: the palette's spelling.
    expect(sharedConfigIdOf({ componentType: "receiver", componentSubType: "otlp", instanceName: "a" })).toBe("receiver-otlp/a");
  });

  it("links an instance and a renamed type with the source's own shared id", () => {
    const group = makeNode({ id: "group_1", type: "pipelineGroup", data: { label: "logs", componentType: "pipelineGroup" } });
    for (const data of [
      { key: "processors.batch/2", instanceName: "2", sharedConfigId: "processor-batch/2" },
      {
        componentType: "exporter" as const,
        componentSubType: "otlp",
        key: "exporters.otlp_grpc",
        sharedConfigId: "exporter-otlp_grpc",
      },
    ]) {
      const source = makeNode({ id: "node_0", parentId: "group_0", data: { ...data, pipeline: "traces" } });

      const { linkedNode, updatedNodes } = buildLinkedNode(source, "group_1", [source, group]);

      expect(linkedNode.data.key).toBe(data.key);
      expect(linkedNode.data.sharedConfigId).toBe(data.sharedConfigId);
      expect(updatedNodes.find((n) => n.id === "node_0")?.data.sharedConfigId).toBe(data.sharedConfigId);
    }
  });
});

describe("instance names for copies", () => {
  it("counts past numbered instances, and a named one as none", () => {
    const nodes = [
      makeNode({ id: "a", data: {} }),
      makeNode({ id: "b", data: { instanceName: "4" } }),
      makeNode({ id: "c", data: { instanceName: "enricher" } }),
    ];
    const [copy] = buildDuplicateNodes([nodes[0]!], nodes);
    expect(copy?.data.instanceName).toBe("5");
    expect(copy?.data.label).toBe("Batch (5)");
    expect(copy?.data.key).toBe("processors.batch/5");
  });

  it("places an ungrouped copy beside its original", () => {
    const original = { ...makeNode({ id: "node_0", type: "connector", data: { componentType: "connector", componentSubType: "forward" } }), position: { x: 10, y: 20 } };
    const copy = buildDuplicateNode(original, [original]);
    expect(copy.position).toEqual({ x: 60, y: 70 });
    expect(copy.parentId).toBeUndefined();
    expect(copy.data.pipeline).toBeUndefined();
  });
});
