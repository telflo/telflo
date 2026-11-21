import {
  GRAPH_COLUMN_MAXIMUM_BYTES,
  GRAPH_MAXIMUM_NODES,
  graphColumnByteLength,
  GraphEdgesSchema,
  GraphNodesSchema,
  GraphPipelinesSchema,
  SaveConfigurationVersionRequestSchema,
} from "@telflo/contracts";
import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { parse } from "./parse.js";
import { fromStored, toStored } from "./stored-graph.js";
import type { Graph, OTelNode } from "./types.js";

function parsed(text: string): Graph {
  const result = parse(text);
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

function passes(stored: ReturnType<typeof toStored>) {
  return (
    GraphNodesSchema.safeParse(stored.nodes).success &&
    GraphEdgesSchema.safeParse(stored.edges).success &&
    GraphPipelinesSchema.safeParse(stored.pipelines).success
  );
}

const RUNTIME_FIELDS = ["measured", "selected", "dragging", "width", "height", "positionAbsolute", "resizing"];
const D9A_FIELDS = ["key", "pipeline", "declared", "enabled"];

describe("toStored: the graph's shapes without React Flow's runtime fields", () => {
  it("stores the starter's graph as the contract's columns", () => {
    const graph = parsed(corpusText("starter.yaml"));
    const stored = toStored(graph);

    expect(passes(stored)).toBe(true);
    expect(stored.pipelines).toEqual([
      { id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316" },
      { id: "pipeline_1", name: "metrics", signalType: "metrics", color: "#3b82f6" },
      { id: "pipeline_2", name: "logs", signalType: "logs", color: "#64748b" },
    ]);
    const group = stored.nodes.find((n) => n.id === "group_0");
    expect(group).toEqual({
      id: "group_0",
      type: "pipelineGroup",
      position: graph.nodes.find((n) => n.id === "group_0")!.position,
      style: {
        width: graph.nodes.find((n) => n.id === "group_0")!.style!.width,
        height: graph.nodes.find((n) => n.id === "group_0")!.style!.height,
      },
      data: {
        label: "traces",
        pipelineId: "pipeline_0",
        signalType: "traces",
        color: "#f97316",
        componentType: "pipelineGroup",
        componentSubType: "pipelineGroup",
        config: {},
      },
    });
    const receiver = stored.nodes.find((n) => n.type === "receiver");
    expect(receiver).toMatchObject({
      type: "receiver",
      parentId: "group_0",
      data: {
        label: "OTLP",
        componentType: "receiver",
        componentSubType: "otlp",
        sharedConfigId: "receiver-otlp",
        config: { protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } },
      },
    });
    expect(stored.edges[0]).toEqual({ id: "edge_0", source: expect.any(String), target: expect.any(String), type: "smoothstep" });
  });

  it("never stores React Flow's runtime fields, or the builder's own", () => {
    const graph = parsed(corpusText("extensions-undeclared.yaml"));
    const withRuntime: Graph = {
      ...graph,
      nodes: graph.nodes.map((n) => ({
        ...n,
        measured: { width: 200, height: 72 },
        selected: true,
        dragging: false,
        width: 200,
        height: 72,
        resizing: false,
        positionAbsolute: { x: 1, y: 2 },
      })) as OTelNode[],
      edges: graph.edges.map((e) => ({ ...e, selected: true, animated: true })),
    };
    const stored = toStored(withRuntime);

    expect(passes(stored)).toBe(true);
    for (const storedNode of stored.nodes) {
      for (const field of RUNTIME_FIELDS) expect(storedNode).not.toHaveProperty(field);
      for (const field of D9A_FIELDS) expect(storedNode.data).not.toHaveProperty(field);
    }
    for (const storedEdge of stored.edges) {
      expect(Object.keys(storedEdge).sort()).toEqual(["id", "source", "target", "type"]);
    }
    expect(SaveConfigurationVersionRequestSchema.safeParse({ yamlContent: "", ...stored }).success).toBe(true);
  });

  it("leaves out an edge ending at a group, and the derived route edges", () => {
    const graph = parsed(corpusText("connector-memberships.yaml"));
    expect(graph.edges.some((e) => e.target.startsWith("group_") || e.source.startsWith("group_"))).toBe(true);

    const stored = toStored({
      ...graph,
      edges: [...graph.edges, { id: "route-node_1-group_0", source: "node_1", target: "group_0", type: "route" }],
    });
    expect(stored.edges.every((e) => e.source.startsWith("node_") && e.target.startsWith("node_"))).toBe(true);
    expect(stored.edges).toHaveLength(graph.edges.filter((e) => !e.source.startsWith("group_") && !e.target.startsWith("group_")).length);
  });
});

describe("toStored is best effort: the graph never stops the text from saving", () => {
  it('stores config: null for a node whose config holds "\\0", and the rest as they are', () => {
    const graph = parsed('receivers:\n  otlp:\n    note: "a\\0b"\n  jaeger: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp, jaeger]\n');
    const stored = toStored(graph);

    expect(passes(stored)).toBe(true);
    const config = (key: string) => stored.nodes.find((n) => n.type === "receiver" && n.data.sharedConfigId === key)?.data;
    expect(config("receiver-otlp")).toMatchObject({ config: null });
    expect(config("receiver-jaeger")).toMatchObject({ config: {} });
  });

  it("stores config: null for a lone surrogate or a number JSON can't hold", () => {
    const graph = parsed(
      'exporters:\n  debug:\n    bad: "\\ud800"\n  file:\n    size: .inf\nservice:\n  pipelines:\n    logs:\n      exporters: [debug, file]\n',
    );
    const stored = toStored(graph);
    expect(passes(stored)).toBe(true);
    expect(stored.nodes.filter((n) => n.type === "exporter").map((n) => n.data.config)).toEqual([null, null]);
  });

  it("stores every config as null when the copies would be over the column's bound, keeping the layout", () => {
    const big = "x".repeat(400_000);
    const graph = parsed(
      `processors:\n  batch:\n    note: ${big}\nservice:\n  pipelines:\n    traces:\n      processors: [batch]\n    metrics:\n      processors: [batch]\n    logs:\n      processors: [batch]\n`,
    );
    const stored = toStored(graph);

    expect(passes(stored)).toBe(true);
    expect(stored.nodes).toHaveLength(graph.nodes.length);
    expect(stored.nodes.filter((n) => n.type === "processor").every((n) => n.data.config === null)).toBe(true);
    expect(graphColumnByteLength(stored.nodes)).toBeLessThanOrEqual(GRAPH_COLUMN_MAXIMUM_BYTES);
  });

  it("stores [] for a column the contract still refuses", () => {
    // A name longer than the contract's bounds: the nodes column can't be stored.
    const long = "a".repeat(400);
    const graph = parsed(`receivers:\n  otlp/${long}: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp/${long}]\n`);
    const stored = toStored(graph);
    expect(stored.nodes).toEqual([]);
    expect(stored.pipelines).toHaveLength(1);
    expect(passes(stored)).toBe(true);

    // A pipeline name the contract's rule doesn't allow: the pipelines column.
    const odd = toStored(parsed("service:\n  pipelines:\n    Traces Upper: {}\n"));
    expect(odd.pipelines).toEqual([]);
    expect(odd.nodes).toHaveLength(1);

    // More nodes than the bound.
    const nodes = Array.from({ length: GRAPH_MAXIMUM_NODES + 1 }, (_, i) => ({
      id: `node_${i}`,
      type: "receiver",
      position: { x: 0, y: 0 },
      data: { label: "OTLP", componentType: "receiver" as const, componentSubType: "otlp", config: null },
    }));
    expect(toStored({ nodes, edges: [], pipelines: [] }).nodes).toEqual([]);
  });

  it("stores [] for a column holding a position that isn't finite", () => {
    const graph = parsed(corpusText("starter.yaml"));
    graph.nodes[0]!.position = { x: Number.NaN, y: 0 };
    expect(toStored(graph).nodes).toEqual([]);
  });
});

describe("fromStored reads back what it can", () => {
  it("reads toStored's columns back: positions, sizes, colors, keys and pipelines", () => {
    const graph = parsed(corpusText("renamed-types.yaml"));
    graph.pipelines[0]!.color = "#8b5cf6";
    const back = fromStored(toStored(graph));

    expect(back.pipelines).toEqual(graph.pipelines);
    expect(back.nodes.map((n) => [n.id, n.position, n.parentId, n.data.key, n.data.pipeline])).toEqual(
      graph.nodes.map((n) => [n.id, n.position, n.parentId, n.data.key, n.data.pipeline]),
    );
    expect(back.nodes.find((n) => n.id === "group_0")?.style).toEqual(graph.nodes.find((n) => n.id === "group_0")?.style);
    expect(back.edges.map((e) => [e.id, e.source, e.target])).toEqual(graph.edges.map((e) => [e.id, e.source, e.target]));
    // The key keeps the text's spelling of a renamed type, through sharedConfigId.
    expect(back.nodes.find((n) => n.data.componentSubType === "otlp")?.data.key).toBe("exporters.otlp_grpc");
  });

  it("reads stored rows, ignoring React Flow's runtime fields", () => {
    const back = fromStored({
      nodes: [
        {
          id: "node_0",
          type: "processor",
          position: { x: 10, y: 20 },
          positionAbsolute: { x: 110, y: 120 },
          measured: { width: 200, height: 72 },
          selected: true,
          parentId: "group_0",
          data: {
            label: "Batch (b)",
            componentType: "processor",
            componentSubType: "batch",
            instanceName: "b",
            config: { timeout: "1s" },
            sharedConfigId: "processor-batch-b",
          },
        },
        {
          id: "group_0",
          type: "pipelineGroup",
          position: { x: 100, y: 100 },
          style: { width: 900, height: 200 },
          data: { label: "traces", pipelineId: "pipeline_0", signalType: "traces", color: "#f97316" },
        },
      ],
      edges: [{ id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep", selected: true }],
      pipelines: [{ id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316", extra: 1 }],
    });

    const processor = back.nodes.find((n) => n.id === "node_0")!;
    expect(Object.keys(processor).sort()).toEqual(["data", "id", "parentId", "position", "type"]);
    // A sharedConfigId that doesn't name the component isn't taken for its key.
    expect(processor.data.key).toBe("processors.batch/b");
    expect(processor.data.pipeline).toBe("traces");
    expect(back.edges).toEqual([{ id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep", data: {} }]);
    expect(back.pipelines).toEqual([{ id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316" }]);
  });

  it("drops what it can't read, and reads a column that isn't an array as empty", () => {
    const back = fromStored({
      nodes: [
        null,
        "node_0",
        { id: "node_1", position: { x: 0, y: 0 }, data: { label: "x" } },
        { id: "node_2", type: "receiver", position: { x: "0", y: 0 }, data: { label: "x", componentSubType: "otlp" } },
        { id: "group_1", type: "pipelineGroup", position: { x: 0, y: 0 }, data: { label: "logs" } },
        {
          id: "group_2",
          type: "pipelineGroup",
          position: { x: 0, y: 0 },
          style: { width: "wide" },
          data: { label: "logs/x", pipelineId: "pipeline_2", signalType: "nope" },
        },
        { id: "node_3", type: "receiver", position: { x: 1, y: 2 }, data: { label: "OTLP", componentSubType: "otlp" } },
      ],
      edges: [{ id: "edge_0", source: "node_0" }, 5],
      pipelines: { not: "an array" },
    });

    expect(back.nodes.map((n) => n.id)).toEqual(["group_2", "node_3"]);
    expect(back.nodes[0]?.data).toMatchObject({ signalType: "logs", color: "#64748b" });
    expect(back.nodes[0]?.style).toEqual({ width: 900, height: 200 });
    expect(back.nodes[1]?.data).toEqual({
      label: "OTLP",
      componentType: "receiver",
      componentSubType: "otlp",
      config: null,
      key: "receivers.otlp",
    });
    expect(back.edges).toEqual([]);
    expect(back.pipelines).toEqual([]);
    expect(fromStored({ nodes: [], edges: [], pipelines: [{ id: "pipeline_0", name: "metrics/x" }] }).pipelines).toEqual([
      { id: "pipeline_0", name: "metrics/x", signalType: "metrics" },
    ]);
  });
});
