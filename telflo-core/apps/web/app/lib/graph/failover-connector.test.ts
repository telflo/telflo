/**
 * Tests for the Failover connector.
 *
 * The failover connector routes telemetry of the *same* signal type to the
 * highest-priority level of pipelines that is healthy, dropping to the next
 * level when one fails. Like routing, its target pipelines are declared in
 * CONFIG (`priority_levels[][]`), not drawn as canvas edges: the model derives
 * each target pipeline's `receivers: [failover]` entry from the config, the
 * parser never creates outgoing edges, and the canvas shows derived read-only
 * route edges labeled by priority level. Only the incoming side (which
 * pipeline feeds the connector) is an edge.
 *
 * Generation is the model the graph describes (`deriveModel`); the round
 * trips read the corpus's YAML (failover-connector.yaml is the generated
 * YAML for buildFailoverScenario("metrics", "metrics"), with the target's
 * processor chain).
 */
import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { deriveModel, readTextModel } from "./model.js";
import { componentPalette } from "./palette.js";
import { parse } from "./parse.js";
import { buildRouteEdges, pushConfigTargetsRight, summarizeFailoverTargets } from "./routing-connector.js";
import type { FailoverConnectorConfig } from "./routing-connector.js";
import { buildNamedPipeline, createConnectorNode, mergePipelineGraphs } from "~/test/pipeline-builder.js";
import type { BuiltGraph } from "~/test/pipeline-builder.js";
import type { Graph, PipelineSignalType } from "./types.js";

function failoverConfig(outSignal: PipelineSignalType): FailoverConnectorConfig {
  return {
    priority_levels: [[`${outSignal}/primary`], [`${outSignal}/secondary`]],
    retry_interval: "30s",
  };
}

function parsed(text: string): Graph {
  const result = parse(text);
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

/**
 * Wire a failover connector between three pipelines:
 *   in-pipeline:        otlp receiver → failover (an edge, connector acts as exporter)
 *   primary/secondary:  targeted via the failover CONFIG only — no outgoing edge.
 */
function buildFailoverScenario(
  inSignal: PipelineSignalType,
  outSignal: PipelineSignalType,
  config: FailoverConnectorConfig = failoverConfig(outSignal),
): BuiltGraph {
  const inPipe = buildNamedPipeline({
    pipelineId: "pipeline_0",
    pipelineName: `${inSignal}/in`,
    signalType: inSignal,
    receiverSubTypes: [{ subType: "otlp" }],
    processorSubTypes: [],
    exporterSubTypes: [],
    nodePrefix: "in",
  });
  const primary = buildNamedPipeline({
    pipelineId: "pipeline_1",
    pipelineName: `${outSignal}/primary`,
    signalType: outSignal,
    receiverSubTypes: [],
    processorSubTypes: [],
    exporterSubTypes: [{ subType: "otlp" }],
    nodePrefix: "primary",
  });
  const secondary = buildNamedPipeline({
    pipelineId: "pipeline_2",
    pipelineName: `${outSignal}/secondary`,
    signalType: outSignal,
    receiverSubTypes: [],
    processorSubTypes: [],
    exporterSubTypes: [{ subType: "otlphttp" }],
    nodePrefix: "secondary",
  });

  const merged = mergePipelineGraphs(mergePipelineGraphs(inPipe, primary), secondary);
  const connector = createConnectorNode("conn-failover", "failover");
  connector.data.config = structuredClone(config);
  merged.nodes.push(connector);

  // receiver → failover (failover is the exporter of the in-pipeline)
  merged.edges.push({
    id: "in-receiver-0-conn-failover",
    source: "in-receiver-0",
    target: "conn-failover",
    type: "smoothstep",
    data: {},
  });

  return merged;
}

describe("Failover connector — palette", () => {
  it("is registered in the component palette as a connector", () => {
    const entry = componentPalette.find((c) => c.subType === "failover" && c.type === "connector");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Failover");
    // Failover is signal-agnostic — it must NOT carry a fixed signal mapping.
    expect(entry!.connectorSignals).toBeUndefined();
    // The default starts with no levels (the form guides the user to add them).
    expect(entry!.defaultConfig).toEqual({ priority_levels: [] });
  });
});

describe.each<PipelineSignalType>(["traces", "metrics", "logs"])("Failover connector — YAML generation (%s)", (signal) => {
  const model = deriveModel(buildFailoverScenario(signal, signal));

  it("emits the failover connector with its priority levels", () => {
    expect(model.components.get("connectors.failover")).toEqual({
      priority_levels: [[`${signal}/primary`], [`${signal}/secondary`]],
      retry_interval: "30s",
    });
  });

  it("lists failover as an exporter in the source pipeline", () => {
    expect(model.pipelines.get(`${signal}/in`)?.exporters).toContain("failover");
  });

  it("lists failover as a receiver in every target pipeline from config alone (no outgoing edges)", () => {
    expect(model.pipelines.get(`${signal}/primary`)?.receivers).toContain("failover");
    expect(model.pipelines.get(`${signal}/secondary`)?.receivers).toContain("failover");
  });
});

describe("Failover connector — YAML generation (config-driven targets)", () => {
  it("ignores stale manual outgoing edges — config is the source of truth", () => {
    const { nodes, edges, pipelines } = buildFailoverScenario("traces", "traces", {
      priority_levels: [["traces/primary"]],
    });
    edges.push({
      id: "conn-failover-secondary-exporter-0",
      source: "conn-failover",
      target: "secondary-exporter-0",
      type: "smoothstep",
      data: {},
    });

    const model = deriveModel({ nodes, edges, pipelines });
    expect(model.pipelines.get("traces/primary")?.receivers).toContain("failover");
    expect(model.pipelines.get("traces/secondary")?.receivers).not.toContain("failover");
  });

  it("orders a target pipeline's processor chain without an entry edge", () => {
    const inPipe = buildNamedPipeline({
      pipelineId: "pipeline_0",
      pipelineName: "traces/in",
      signalType: "traces",
      receiverSubTypes: [{ subType: "otlp" }],
      processorSubTypes: [],
      exporterSubTypes: [],
      nodePrefix: "in",
    });
    const primary = buildNamedPipeline({
      pipelineId: "pipeline_1",
      pipelineName: "traces/primary",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [{ subType: "batch" }, { subType: "transform" }],
      exporterSubTypes: [{ subType: "otlp" }],
      nodePrefix: "primary",
    });
    const merged = mergePipelineGraphs(inPipe, primary);
    const connector = createConnectorNode("conn-failover", "failover");
    connector.data.config = { priority_levels: [["traces/primary"]] };
    merged.nodes.push(connector);
    merged.edges.push({
      id: "in-receiver-0-conn-failover",
      source: "in-receiver-0",
      target: "conn-failover",
      type: "smoothstep",
      data: {},
    });

    expect(deriveModel(merged).pipelines.get("traces/primary")?.processors).toEqual(["batch", "transform"]);
  });
});

describe("Failover connector — round-trip", () => {
  const failoverYaml = corpusText("failover-connector.yaml");

  it("preserves the nested priority_levels through generate → parse", () => {
    const connectorNodes = parsed(failoverYaml).nodes.filter((n) => n.data.componentType === "connector");
    expect(connectorNodes).toHaveLength(1);
    expect(connectorNodes[0]!.data.componentSubType).toBe("failover");
    expect(connectorNodes[0]!.data.config).toEqual(failoverConfig("metrics"));
    // Signal-agnostic: the parser must not pin it to a signal pair.
    expect(connectorNodes[0]!.data.connectorSignals).toBeUndefined();
  });

  it("does not create stored outgoing edges (derived at render instead)", () => {
    const graph = parsed(failoverYaml);
    const connector = graph.nodes.find((n) => n.data.componentType === "connector")!;
    expect(graph.edges.filter((e) => e.source === connector.id)).toEqual([]);
    // The incoming side stays a real edge (source pipeline → failover).
    expect(graph.edges.filter((e) => e.target === connector.id).length).toBeGreaterThan(0);
  });

  it("keeps target receivers across generate → parse → generate", () => {
    const model = deriveModel(parsed(failoverYaml));
    expect(model.pipelines.get("metrics/primary")?.receivers).toContain("failover");
    expect(model.pipelines.get("metrics/secondary")?.receivers).toContain("failover");
    expect(model.pipelines.get("metrics/primary")?.processors).toEqual(["batch", "transform"]);
  });

  it("imports the upstream README example", () => {
    const graph = parsed(corpusText("failover-readme.yaml"));
    const connector = graph.nodes.find((n) => n.data.componentType === "connector")!;
    expect(connector.data.componentSubType).toBe("failover");
    expect((connector.data.config as FailoverConnectorConfig).priority_levels).toEqual([
      ["traces/first", "traces/also_first"],
      ["traces/second"],
    ]);

    const model = deriveModel(graph);
    for (const name of ["traces/first", "traces/also_first", "traces/second"]) {
      expect(model.pipelines.get(name)?.receivers).toContain("failover");
    }
  });
});

describe("Failover connector — derived route edges", () => {
  it("builds one read-only edge per target pipeline, labeled by priority", () => {
    const { nodes, pipelines } = buildFailoverScenario("traces", "traces");
    const routeEdges = buildRouteEdges(nodes, pipelines);

    expect(routeEdges).toHaveLength(2);
    expect(routeEdges[0]).toMatchObject({
      source: "conn-failover",
      target: "group_1",
      targetHandle: "route",
      type: "route",
      selectable: false,
      deletable: false,
      data: { label: "priority 1" },
    });
    expect(routeEdges[1]).toMatchObject({
      target: "group_2",
      data: { label: "priority 2" },
    });
  });

  it("merges a pipeline listed at several levels and skips unknown pipelines", () => {
    const { nodes, pipelines } = buildFailoverScenario("traces", "traces", {
      priority_levels: [["traces/primary"], ["traces/nope", "traces/primary"]],
    });
    const routeEdges = buildRouteEdges(nodes, pipelines);
    expect(routeEdges).toHaveLength(1);
    expect(routeEdges[0]!.data?.label).toBe("priority 1, 2");
  });
});

describe("Failover connector — target pipeline layout", () => {
  it("moves target pipeline groups to the right of the connector", () => {
    const { nodes, pipelines } = buildFailoverScenario("traces", "traces");
    const result = pushConfigTargetsRight(nodes, pipelines);
    const connector = result.find((n) => n.id === "conn-failover")!;
    for (const id of ["group_1", "group_2"]) {
      expect(result.find((n) => n.id === id)!.position.x).toBeGreaterThan(connector.position.x);
    }
    // The source pipeline (feeds the connector) stays where it was.
    expect(result.find((n) => n.id === "group_0")!.position.x).toBe(100);
  });
});

describe("Failover connector — reading a config the text holds", () => {
  it("reads no targets from a config that isn't failover's shape", () => {
    expect(summarizeFailoverTargets(undefined)).toEqual([]);
    expect(summarizeFailoverTargets({ priority_levels: "no" })).toEqual([]);
    expect(summarizeFailoverTargets({ priority_levels: [null, ["a", 3, " "], ["a"]] })).toEqual([
      { name: "a", levels: [2, 3] },
    ]);
  });
});

/*
 * With the text's order, the failover connector's receiver membership is the
 * text's own while it is a node; the cases above pass no order (the config's
 * derivation).
 */
describe("Failover connector — membership with the text's order", () => {
  const TEXT = [
    "receivers:",
    "  otlp:",
    "processors:",
    "  batch:",
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
    "      processors: [batch]",
    "      exporters: [debug]",
    "    traces/backup:",
    "      receivers: [otlp]",
    "      processors: [batch]",
    "      exporters: [debug]",
    "    traces/listed:",
    "      receivers: [failover]",
    "      processors: [batch]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  function read(text: string) {
    const result = parse(text);
    if (!result.ok) throw new Error(result.reason);
    return { graph: result.graph, order: readTextModel(result.document) };
  }

  it("keeps a level's pipeline unwired and an unnamed pipeline listed, each with its processors", () => {
    const { graph, order } = read(TEXT);
    const model = deriveModel(graph, order);
    expect(model.pipelines).toEqual(order.pipelines);
    expect(model.pipelines.get("traces/backup")).toEqual({ receivers: ["otlp"], processors: ["batch"], exporters: ["debug"] });
    expect(model.pipelines.get("traces/listed")).toEqual({ receivers: ["failover"], processors: ["batch"], exporters: ["debug"] });

    // The config's derivation, without an order, reads the levels instead.
    const fromConfig = deriveModel(graph);
    expect(fromConfig.pipelines.get("traces/backup")?.receivers).toEqual(["otlp", "failover"]);
    expect(fromConfig.pipelines.get("traces/listed")?.receivers).toEqual([]);
  });

  it("drops the connector from receivers once it is no longer a node", () => {
    const { graph, order } = read(TEXT);
    const model = deriveModel({ ...graph, nodes: graph.nodes.filter((n) => n.data.componentSubType !== "failover") }, order);
    expect(model.pipelines.get("traces/primary")).toEqual({ receivers: [], processors: ["batch"], exporters: ["debug"] });
    expect(model.pipelines.get("traces/in")?.exporters).toEqual([]);
  });
});
