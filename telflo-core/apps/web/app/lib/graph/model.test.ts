import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { deriveModel, modelOfValue, readTextModel } from "./model.js";
import { parse } from "./parse.js";
import type { Graph, OTelNode } from "./types.js";
import { buildNamedPipeline, createConnectorNode, createExtensionNode, mergePipelineGraphs } from "~/test/pipeline-builder.js";

function parsed(text: string) {
  const result = parse(text);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

function node(graph: Graph, id: string): OTelNode {
  const found = graph.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

function tracesPipeline() {
  return buildNamedPipeline({
    pipelineId: "pipeline_0",
    pipelineName: "traces",
    signalType: "traces",
    receiverSubTypes: [{ subType: "otlp" }, { subType: "jaeger" }],
    processorSubTypes: [{ subType: "memory_limiter" }, { subType: "batch" }],
    exporterSubTypes: [{ subType: "debug" }],
    nodePrefix: "t",
  });
}

describe("readTextModel: the text's own model", () => {
  it("keys every declared component by section and name, with its value", () => {
    const model = readTextModel(parsed(corpusText("starter.yaml")).document);
    expect([...model.components.keys()]).toEqual([
      "receivers.otlp",
      "processors.batch",
      "exporters.otlp",
      "extensions.health_check",
      "extensions.pprof",
      "extensions.zpages",
    ]);
    expect(model.components.get("processors.batch")).toEqual({ timeout: "10s", send_batch_size: 1024 });
    expect(model.extensions).toEqual(["health_check", "pprof", "zpages"]);
    expect(model.pipelines.get("traces")).toEqual({ receivers: ["otlp"], processors: ["batch"], exporters: ["otlp"] });
    expect(model.undeclared).toEqual(new Set());
  });

  it("marks what a pipeline or service.extensions names but nobody declares", () => {
    const model = readTextModel(parsed(corpusText("undeclared-references.yaml")).document);
    expect(model.undeclared).toEqual(
      new Set([
        "receivers.zipkin",
        "processors.batch",
        "processors.memory_limiter",
        "exporters.debug",
        "exporters.spanmetrics",
      ]),
    );
    expect(model.components.has("processors.batch")).toBe(false);

    const extensions = readTextModel(parsed(corpusText("extensions-undeclared.yaml")).document);
    expect(extensions.undeclared).toEqual(new Set(["extensions.basicauth/server", "extensions.oauth2client"]));
  });

  it("reads a name in a receivers or exporters list as a connector's when connectors declares it", () => {
    const model = modelOfValue({
      connectors: { forward: {} },
      service: { pipelines: { traces: { receivers: ["forward"], exporters: ["forward"] } } },
    });
    expect(model.undeclared).toEqual(new Set());
  });

  it("reads an empty pipeline and empty lists as empty", () => {
    const model = readTextModel(parsed(corpusText("null-values.yaml")).document);
    expect(model.pipelines.get("logs")).toEqual({ receivers: [], processors: [], exporters: [] });
    expect(model.pipelines.get("metrics")).toEqual({ receivers: [], processors: [], exporters: ["debug"] });
    expect(model.components.get("exporters.debug")).toBeNull();
    expect(modelOfValue(null)).toEqual({
      components: new Map(),
      pipelines: new Map(),
      extensions: [],
      undeclared: new Set(),
    });
  });
});

describe("deriveModel: the configuration the graph describes (yaml-generator.ts:109-241)", () => {
  it("lists a pipeline's receivers and exporters by group, and its processors by the chain", () => {
    expect(deriveModel(tracesPipeline()).pipelines.get("traces")).toEqual({
      receivers: ["otlp", "jaeger"],
      processors: ["memory_limiter", "batch"],
      exporters: ["debug"],
    });
  });

  it("leaves out a processor no edge reaches, while declaring it", () => {
    const graph = tracesPipeline();
    graph.edges = graph.edges.filter((e) => e.target !== "t-processor-1");

    const model = deriveModel(graph);
    expect(model.pipelines.get("traces")?.processors).toEqual(["memory_limiter"]);
    expect(model.components.has("processors.batch")).toBe(true);
  });

  it("keeps the chain nothing feeds in a pipeline with no receivers", () => {
    const graph = buildNamedPipeline({
      pipelineId: "pipeline_0",
      pipelineName: "logs",
      signalType: "logs",
      receiverSubTypes: [],
      processorSubTypes: [{ subType: "batch" }, { subType: "memory_limiter" }],
      exporterSubTypes: [{ subType: "debug" }],
      nodePrefix: "l",
    });
    expect(deriveModel(graph).pipelines.get("logs")?.processors).toEqual(["batch", "memory_limiter"]);
  });

  it("makes a connector a member through an edge to or from the pipeline's group", () => {
    const empty = buildNamedPipeline({
      pipelineId: "pipeline_0",
      pipelineName: "traces/bridge",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [],
      exporterSubTypes: [],
      nodePrefix: "b",
    });
    const graph = mergePipelineGraphs(empty, {
      nodes: [createConnectorNode("conn-forward", "forward"), createConnectorNode("conn-spanmetrics", "spanmetrics")],
      edges: [
        { id: "e1", source: "conn-forward", target: "group_0" },
        { id: "e2", source: "group_0", target: "conn-spanmetrics" },
      ],
      pipelines: [],
    });
    expect(deriveModel(graph).pipelines.get("traces/bridge")).toEqual({
      receivers: ["forward"],
      processors: [],
      exporters: ["spanmetrics"],
    });
  });

  it("never declares a node marked undeclared, and keeps it named", () => {
    const graph = tracesPipeline();
    node(graph, "t-receiver-1").data.declared = false;

    const model = deriveModel(graph);
    expect(model.components.has("receivers.jaeger")).toBe(false);
    expect(model.undeclared).toEqual(new Set(["receivers.jaeger"]));
    expect(model.pipelines.get("traces")?.receivers).toContain("jaeger");
  });

  it("declares a component some node declares, even if another is marked undeclared", () => {
    const graph = mergePipelineGraphs(tracesPipeline(), {
      ...buildNamedPipeline({
        pipelineId: "pipeline_1",
        pipelineName: "logs",
        signalType: "logs",
        receiverSubTypes: [{ subType: "jaeger" }],
        processorSubTypes: [],
        exporterSubTypes: [],
        nodePrefix: "l",
      }),
    });
    node(graph, "l-receiver-0").data.declared = false;
    expect(deriveModel(graph).undeclared).toEqual(new Set());
  });

  it("lists the enabled extensions: a node without `enabled` is enabled", () => {
    const graph = mergePipelineGraphs(tracesPipeline(), {
      nodes: [createExtensionNode("ext-a", "health_check"), createExtensionNode("ext-b", "pprof")],
      edges: [],
      pipelines: [],
    });
    expect(deriveModel(graph).extensions).toEqual(["health_check", "pprof"]);

    node(graph, "ext-b").data.enabled = false;
    const model = deriveModel(graph);
    expect(model.extensions).toEqual(["health_check"]);
    expect(model.components.has("extensions.pprof")).toBe(true);
  });

  it("keys a component with the text's spelling of its type, and keeps a null value", () => {
    const graph = tracesPipeline();
    Object.assign(node(graph, "t-exporter-0").data, { key: "exporters.debug_v2", config: null });
    const model = deriveModel(graph);
    expect(model.components.get("exporters.debug_v2")).toBeNull();
    expect(model.pipelines.get("traces")?.exporters).toEqual(["debug_v2"]);
  });

  it("takes the last node's config when several nodes share a component", () => {
    const graph = mergePipelineGraphs(
      tracesPipeline(),
      buildNamedPipeline({
        pipelineId: "pipeline_1",
        pipelineName: "logs",
        signalType: "logs",
        receiverSubTypes: [{ subType: "otlp" }],
        processorSubTypes: [],
        exporterSubTypes: [],
        nodePrefix: "l",
      }),
    );
    node(graph, "l-receiver-0").data.config = { last: true };
    expect(deriveModel(graph).components.get("receivers.otlp")).toEqual({ last: true });
  });

  it("orders receivers, exporters and extensions as the text does, what the graph adds last", () => {
    const graph = tracesPipeline();
    const order = modelOfValue({
      service: {
        extensions: [],
        pipelines: { traces: { receivers: ["jaeger", "otlp"], processors: ["batch"], exporters: [] } },
      },
    });
    graph.nodes.push(
      {
        ...node(graph, "t-receiver-0"),
        id: "t-receiver-new",
        data: { ...node(graph, "t-receiver-0").data, instanceName: "new", key: "receivers.otlp/new" },
      },
    );

    expect(deriveModel(graph, order).pipelines.get("traces")).toEqual({
      receivers: ["jaeger", "otlp", "otlp/new"],
      // Processor order is the chain's, whatever the text says.
      processors: ["memory_limiter", "batch"],
      exporters: ["debug"],
    });
  });

  it("ignores edges to nodes the graph doesn't have", () => {
    const graph = tracesPipeline();
    graph.edges.push({ id: "dangling", source: "gone", target: "t-processor-0" });
    expect(deriveModel(graph).pipelines.get("traces")?.processors).toEqual(["memory_limiter", "batch"]);
  });
});
