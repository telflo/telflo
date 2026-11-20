/**
 * Tests for the Routing connector.
 *
 * The routing connector routes telemetry to different pipelines of the *same*
 * signal type using OTTL conditions (split by tenant, environment, severity,
 * ...). Like forward it is signal-agnostic, but unlike forward it carries a
 * routing table configuration.
 *
 * Target pipelines are declared in the connector CONFIG (table[].pipelines and
 * default_pipelines), not drawn as canvas edges: the model derives each target
 * pipeline's `receivers: [routing]` entry from the config, the parser never
 * creates outgoing edges for routing, and the canvas shows derived read-only
 * route edges instead. Only the incoming side (which pipeline feeds the
 * router) is an edge, because it exists in YAML only as the source pipeline's
 * exporters entry.
 *
 * Generation is the model the graph describes (`deriveModel`), and the round
 * trips read the corpus's YAML, generated for these graphs. The store's test
 * is a pure one here.
 */
import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { deriveModel, readTextModel, renamedModel } from "./model.js";
import { componentPalette } from "./palette.js";
import { parse } from "./parse.js";
import {
  buildRouteEdges,
  connectorPipelineOptions,
  getConfigTargetNames,
  isConfigTargetedConnectorName,
  pushConfigTargetsRight,
  summarizeRoutingTargets,
  targetNamesOf,
  wireConnectorReceivers,
} from "./routing-connector.js";
import type { RoutingConnectorConfig } from "./routing-connector.js";
import { buildNamedPipeline, createConnectorNode, mergePipelineGraphs } from "~/test/pipeline-builder.js";
import type { BuiltGraph } from "~/test/pipeline-builder.js";
import type { Graph, PipelineSignalType } from "./types.js";

function routedConfig(targetPipeline: string): RoutingConnectorConfig {
  return {
    error_mode: "ignore",
    default_pipelines: [targetPipeline],
    table: [
      {
        context: "resource",
        condition: 'attributes["deployment.environment"] == "prod"',
        action: "copy",
        pipelines: [targetPipeline],
      },
    ],
  };
}

function parsed(text: string): Graph {
  const result = parse(text);
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

/**
 * Wire a routing connector between two pipelines of the given signal types:
 *   in-pipeline:  otlp receiver → routing (connector acts as exporter, an edge)
 *   out-pipeline: targeted via the routing CONFIG only — no outgoing edge.
 */
function buildRoutingScenario(
  inSignal: PipelineSignalType,
  outSignal: PipelineSignalType,
  config: RoutingConnectorConfig = routedConfig(`${outSignal}/out`),
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

  const outPipe = buildNamedPipeline({
    pipelineId: "pipeline_1",
    pipelineName: `${outSignal}/out`,
    signalType: outSignal,
    receiverSubTypes: [],
    processorSubTypes: [],
    exporterSubTypes: [{ subType: "otlp" }],
    nodePrefix: "out",
  });

  const merged = mergePipelineGraphs(inPipe, outPipe);
  const connector = createConnectorNode("conn-routing", "routing");
  connector.data.config = structuredClone(config);
  merged.nodes.push(connector);

  // receiver → routing (routing is the exporter of the in-pipeline)
  merged.edges.push({
    id: "in-receiver-0-conn-routing",
    source: "in-receiver-0",
    target: "conn-routing",
    type: "smoothstep",
    data: {},
  });

  return merged;
}

describe("Routing connector — palette", () => {
  it("is registered in the component palette as a connector", () => {
    const entry = componentPalette.find((c) => c.subType === "routing" && c.type === "connector");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Routing");
    // Routing is signal-agnostic — it must NOT carry a fixed signal mapping.
    expect(entry!.connectorSignals).toBeUndefined();
    // The default starts empty (the form guides the user to add routes) with
    // the production-safe error mode set explicitly.
    expect(entry!.defaultConfig).toEqual({ error_mode: "ignore", table: [] });
  });
});

describe.each<PipelineSignalType>(["traces", "metrics", "logs"])("Routing connector — YAML generation (%s)", (signal) => {
  const model = deriveModel(buildRoutingScenario(signal, signal));

  it("emits the routing connector with its table", () => {
    expect(model.components.get("connectors.routing")).toEqual(routedConfig(`${signal}/out`));
  });

  it("lists routing as an exporter in the source pipeline", () => {
    expect(model.pipelines.get(`${signal}/in`)?.exporters).toContain("routing");
  });

  it("lists routing as a receiver in the target pipeline from config alone (no outgoing edge)", () => {
    expect(model.pipelines.get(`${signal}/out`)?.receivers).toContain("routing");
  });
});

describe("Routing connector — YAML generation (config-driven targets)", () => {
  it("emits receivers for pipelines named only in default_pipelines", () => {
    const scenario = buildRoutingScenario("traces", "traces", {
      error_mode: "ignore",
      default_pipelines: ["traces/fallback"],
      table: [
        {
          context: "resource",
          condition: 'attributes["tenant"] == "acme"',
          pipelines: ["traces/out"],
        },
      ],
    });
    const fallbackPipe = buildNamedPipeline({
      pipelineId: "pipeline_2",
      pipelineName: "traces/fallback",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [],
      exporterSubTypes: [{ subType: "otlphttp" }],
      nodePrefix: "fb",
    });
    const model = deriveModel(mergePipelineGraphs(scenario, fallbackPipe));

    expect(model.pipelines.get("traces/out")?.receivers).toContain("routing");
    expect(model.pipelines.get("traces/fallback")?.receivers).toContain("routing");
  });

  it("ignores stale manual outgoing edges — config is the source of truth", () => {
    // A hand-drawn routing → node edge must not give a pipeline the config
    // doesn't name a receivers entry.
    const { nodes, edges, pipelines } = buildRoutingScenario("traces", "traces", { error_mode: "ignore", table: [] });
    edges.push({
      id: "conn-routing-out-exporter-0",
      source: "conn-routing",
      target: "out-exporter-0",
      type: "smoothstep",
      data: {},
    });

    expect(deriveModel({ nodes, edges, pipelines }).pipelines.get("traces/out")?.receivers).not.toContain("routing");
  });

  it("orders a target pipeline's processor chain without an entry edge", () => {
    // The target pipeline has batch → transform → exporter drawn internally,
    // but nothing feeds batch (the router targets the pipeline via config).
    const inPipe = buildNamedPipeline({
      pipelineId: "pipeline_0",
      pipelineName: "traces/in",
      signalType: "traces",
      receiverSubTypes: [{ subType: "otlp" }],
      processorSubTypes: [],
      exporterSubTypes: [],
      nodePrefix: "in",
    });
    const outPipe = buildNamedPipeline({
      pipelineId: "pipeline_1",
      pipelineName: "traces/out",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [{ subType: "batch" }, { subType: "transform" }],
      exporterSubTypes: [{ subType: "otlp" }],
      nodePrefix: "out",
    });
    const merged = mergePipelineGraphs(inPipe, outPipe);
    const connector = createConnectorNode("conn-routing", "routing");
    connector.data.config = routedConfig("traces/out");
    merged.nodes.push(connector);
    merged.edges.push({
      id: "in-receiver-0-conn-routing",
      source: "in-receiver-0",
      target: "conn-routing",
      type: "smoothstep",
      data: {},
    });

    expect(deriveModel(merged).pipelines.get("traces/out")?.processors).toEqual(["batch", "transform"]);
  });
});

describe("Routing connector — round-trip", () => {
  // routing-connector.yaml is the generated YAML for
  // buildRoutingScenario("traces", "traces").
  const routingYaml = corpusText("routing-connector.yaml");

  it("preserves the routing connector config through generate → parse", () => {
    const connectorNodes = parsed(routingYaml).nodes.filter((n) => n.data.componentType === "connector");
    expect(connectorNodes).toHaveLength(1);
    expect(connectorNodes[0]!.data.componentSubType).toBe("routing");
    expect(connectorNodes[0]!.data.config).toEqual(routedConfig("traces/out"));
  });

  it("does not create stored outgoing edges for routing (derived at render instead)", () => {
    const graph = parsed(routingYaml);
    const connector = graph.nodes.find((n) => n.data.componentType === "connector")!;
    expect(graph.edges.filter((e) => e.source === connector.id)).toEqual([]);
    // The incoming side stays a real edge (source pipeline → routing).
    expect(graph.edges.filter((e) => e.target === connector.id).length).toBeGreaterThan(0);
  });

  it("keeps target receivers across generate → parse → generate", () => {
    expect(deriveModel(parsed(routingYaml)).pipelines.get("traces/out")?.receivers).toContain("routing");
  });

  it("keeps a target pipeline's processors across parse → generate", () => {
    // Mirrors the playground LLM-routing flow: the target pipelines contain
    // processors that nothing but the routing connector (via config) feeds.
    const model = deriveModel(parsed(corpusText("routing-llm.yaml")));
    expect(model.pipelines.get("traces/llm")?.receivers).toContain("routing");
    expect(model.pipelines.get("traces/llm")?.processors).toEqual(["batch"]);
  });

  it("does not pin parsed signal-agnostic connectors to a signal pair", () => {
    const connector = parsed(routingYaml).nodes.find((n) => n.data.componentType === "connector");
    expect(connector).toBeDefined();
    expect(connector!.data.connectorSignals).toBeUndefined();
  });
});

describe("Routing connector — derived route edges", () => {
  it("builds one read-only edge per distinct target pipeline", () => {
    const { nodes, pipelines } = buildRoutingScenario("traces", "traces");
    const routeEdges = buildRouteEdges(nodes, pipelines);

    // routedConfig targets traces/out via one route AND default_pipelines →
    // a single deduplicated edge with a combined label.
    expect(routeEdges).toHaveLength(1);
    expect(routeEdges[0]).toMatchObject({
      id: "route-conn-routing-group_1",
      source: "conn-routing",
      target: "group_1",
      targetHandle: "route",
      type: "route",
      selectable: false,
      deletable: false,
      data: { label: "1 route + default" },
    });
  });

  it("counts routes per target and skips unknown pipelines", () => {
    const { nodes, pipelines } = buildRoutingScenario("traces", "traces", {
      error_mode: "ignore",
      table: [
        {
          context: "resource",
          condition: 'attributes["a"] == "1"',
          pipelines: ["traces/out"],
        },
        {
          context: "resource",
          condition: 'attributes["a"] == "2"',
          pipelines: ["traces/out", "traces/nope"],
        },
      ],
    });
    const routeEdges = buildRouteEdges(nodes, pipelines);

    // "traces/nope" has no pipeline on the canvas → no edge.
    expect(routeEdges).toHaveLength(1);
    expect(routeEdges[0]!.data?.label).toBe("2 routes");
  });

  it("builds no edges for non-routing connectors", () => {
    const { nodes, pipelines } = buildRoutingScenario("traces", "traces");
    const forward = createConnectorNode("conn-forward", "forward");
    const routeEdges = buildRouteEdges([...nodes, forward], pipelines);
    expect(routeEdges.every((e) => e.source === "conn-routing")).toBe(true);
  });
});

describe("Routing connector — target pipeline layout", () => {
  // In buildRoutingScenario the groups sit at x=100 and the connector floats
  // at x=600, so the target starts out on the connector's WRONG side.

  it("moves a target pipeline group to the right of the connector", () => {
    const { nodes, pipelines } = buildRoutingScenario("traces", "traces");
    const result = pushConfigTargetsRight(nodes, pipelines);

    const target = result.find((n) => n.id === "group_1")!;
    const source = result.find((n) => n.id === "group_0")!;
    expect(target.position.x).toBeGreaterThan(600);
    // The source pipeline (feeds the connector) stays where it was.
    expect(source.position.x).toBe(100);
  });

  it("is a no-op (same reference) when targets already sit to the right", () => {
    const { nodes, pipelines } = buildRoutingScenario("traces", "traces");
    const target = nodes.find((n) => n.id === "group_1")!;
    target.position = { ...target.position, x: 2000 };
    expect(pushConfigTargetsRight(nodes, pipelines)).toBe(nodes);
  });

  it("lays imported YAML out with targets right of the connector", () => {
    const graph = parsed(corpusText("routing-connector.yaml"));
    const connector = graph.nodes.find((n) => n.data.componentType === "connector")!;
    const groupOf = (name: string) => {
      const pipeline = graph.pipelines.find((p) => p.name === name)!;
      return graph.nodes.find((n) => n.data.pipelineId === pipeline.id)!;
    };
    expect(groupOf("traces/in").position.x).toBeLessThan(connector.position.x);
    expect(groupOf("traces/out").position.x).toBeGreaterThan(connector.position.x);
  });

  // The layout rule itself is pure.
  it("pushes a newly-selected target right of the connector", () => {
    const { nodes, pipelines } = buildRoutingScenario("traces", "traces", { error_mode: "ignore", table: [] });
    expect(pushConfigTargetsRight(nodes, pipelines)).toBe(nodes);

    const updated = nodes.map((n) =>
      n.id === "conn-routing" ? { ...n, data: { ...n.data, config: routedConfig("traces/out") } } : n,
    );
    const group = pushConfigTargetsRight(updated, pipelines).find((n) => n.id === "group_1")!;
    expect(group.position.x).toBeGreaterThan(600);
  });
});

describe("Routing connector — reading a config the text holds", () => {
  it("reads no targets from a config that isn't routing's shape", () => {
    expect(summarizeRoutingTargets(null)).toEqual([]);
    expect(summarizeRoutingTargets({ table: "no", default_pipelines: 5 })).toEqual([]);
    expect(summarizeRoutingTargets({ table: [null, { pipelines: [" traces/a ", 7, ""] }] })).toEqual([
      { name: "traces/a", routeCount: 1, isDefault: false },
    ]);
  });

  it("recognizes config-targeted connectors by name and by node", () => {
    expect(isConfigTargetedConnectorName("routing/tenants")).toBe(true);
    expect(isConfigTargetedConnectorName("failover")).toBe(true);
    expect(isConfigTargetedConnectorName("forward")).toBe(false);
    expect(getConfigTargetNames(createConnectorNode("conn-forward", "forward"))).toEqual(new Set());
  });
});

/*
 * With the text's order, as every change in the store passes it, the
 * routing connector's receiver membership is the text's own, while the
 * connector is a node; the config doesn't rewrite it. The cases above pass
 * no order: the config's derivation, kept for them.
 */
describe("Routing connector — membership with the text's order", () => {
  const TEXT = [
    "receivers:",
    "  otlp:",
    "processors:",
    "  batch:",
    "  memory_limiter:",
    "exporters:",
    "  debug:",
    "connectors:",
    "  routing:",
    "    default_pipelines: [traces/named]",
    "    table:",
    "      - condition: 'true'",
    "        pipelines: [traces/out]",
    "service:",
    "  pipelines:",
    "    traces/in:",
    "      receivers: [otlp]",
    "      exporters: [routing]",
    "    traces/out:",
    "      receivers: [routing]",
    "      processors: [batch]",
    "      exporters: [debug]",
    "    traces/listed:",
    "      receivers: [routing]",
    "      processors: [memory_limiter, batch]",
    "      exporters: [debug]",
    "    traces/named:",
    "      receivers: [otlp]",
    "      processors: [memory_limiter, batch]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  function read(text: string) {
    const result = parse(text);
    if (!result.ok) throw new Error(result.reason);
    return { graph: result.graph, order: readTextModel(result.document) };
  }

  it("keeps the text's receivers both ways, with each pipeline's processors", () => {
    const { graph, order } = read(TEXT);
    const model = deriveModel(graph, order);

    // Listed and unnamed: kept, its processors with it (no entry edge feeds them).
    expect(model.pipelines.get("traces/listed")).toEqual({
      receivers: ["routing"],
      processors: ["memory_limiter", "batch"],
      exporters: ["debug"],
    });
    // Named and unlisted: not wired, its processors as they are.
    expect(model.pipelines.get("traces/named")).toEqual({
      receivers: ["otlp"],
      processors: ["memory_limiter", "batch"],
      exporters: ["debug"],
    });
    expect(model.pipelines.get("traces/out")?.receivers).toEqual(["routing"]);
    expect(model.pipelines).toEqual(order.pipelines);

    // The derivation without an order reads the config instead.
    const fromConfig = deriveModel(graph);
    expect(fromConfig.pipelines.get("traces/listed")?.receivers).toEqual([]);
    expect(fromConfig.pipelines.get("traces/named")?.receivers).toEqual(["otlp", "routing"]);
  });

  it("drops the connector from receivers once it is no longer a node", () => {
    const { graph, order } = read(TEXT);
    const withoutRouting = { ...graph, nodes: graph.nodes.filter((n) => n.data.componentSubType !== "routing") };
    const model = deriveModel(withoutRouting, order);
    for (const name of ["traces/out", "traces/listed"]) {
      expect(model.pipelines.get(name)?.receivers).toEqual([]);
    }
    // A pipeline left with no receivers keeps its processor chain.
    expect(model.pipelines.get("traces/listed")?.processors).toEqual(["memory_limiter", "batch"]);
  });

  it("doesn't wire a duplicated connector, nor an added pipeline the config names", () => {
    const { graph, order } = read(TEXT);
    const routing = graph.nodes.find((n) => n.data.componentSubType === "routing")!;
    const duplicate: typeof routing = {
      ...routing,
      id: "node_dup",
      data: { ...routing.data, label: "Routing 2", instanceName: "2", config: structuredClone(routing.data.config) },
    };
    const audit = buildNamedPipeline({
      pipelineId: "pipeline_9",
      pipelineName: "traces/audit",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [],
      exporterSubTypes: [{ subType: "debug" }],
      nodePrefix: "audit",
    });
    const named = {
      ...routing,
      data: { ...routing.data, config: { default_pipelines: ["traces/named", "traces/audit"], table: [] } },
    };
    const changed: Graph = {
      nodes: [...graph.nodes.map((n) => (n.id === routing.id ? named : n)), duplicate, ...audit.nodes],
      edges: [...graph.edges, ...audit.edges],
      pipelines: [...graph.pipelines, ...audit.pipelines],
    };
    const model = deriveModel(changed, order);

    expect([...model.pipelines.values()].some((lists) => lists.receivers.includes("routing/2"))).toBe(false);
    expect(model.pipelines.get("traces/audit")?.receivers).toEqual([]);
    expect(model.pipelines.get("traces/named")?.receivers).toEqual(["otlp"]);
  });

  it("keeps a renamed connector's membership in its place", () => {
    const { graph, order } = read(TEXT);
    const routing = graph.nodes.find((n) => n.data.componentSubType === "routing")!;
    const renamed = { ...routing, data: { ...routing.data, instanceName: "tenants" } };
    const model = deriveModel(
      { ...graph, nodes: graph.nodes.map((n) => (n.id === routing.id ? renamed : n)) },
      renamedModel(order, [{ from: "connectors.routing", to: "connectors.routing/tenants" }]),
    );
    expect(model.pipelines.get("traces/listed")?.receivers).toEqual(["routing/tenants"]);
    expect(model.pipelines.get("traces/in")?.exporters).toEqual(["routing/tenants"]);
  });
});

describe("Routing connector — the targets a choice wires", () => {
  const lists = (receivers: string[]) => ({ receivers, processors: [], exporters: ["debug"] });
  const model = {
    components: new Map<string, unknown>(),
    pipelines: new Map([
      ["traces/in", { receivers: ["otlp"], processors: [], exporters: ["routing"] }],
      ["traces/a", lists(["otlp"])],
      ["traces/b", lists(["routing"])],
      ["traces/c", lists(["otlp", "routing"])],
      ["traces/d", lists([])],
    ]),
    extensions: [],
    undeclared: new Set<string>(),
  };

  it("reads a routing or failover config's targets by type, and nothing for another", () => {
    expect(targetNamesOf("routing", routedConfig("traces/out"))).toEqual(new Set(["traces/out"]));
    expect(targetNamesOf("failover", { priority_levels: [["a", "b"], ["c"]] })).toEqual(new Set(["a", "b", "c"]));
    expect(targetNamesOf("forward", { default_pipelines: ["a"] })).toEqual(new Set());
    expect(targetNamesOf("routing", null)).toEqual(new Set());
  });

  it("adds the connector to pipelines newly named, last, and not twice", () => {
    const wiring = wireConnectorReceivers(model, "routing", new Set(), new Set(["traces/a", "traces/b", "traces/d", "traces/nope"]));
    expect(wiring.added).toEqual(["traces/a", "traces/d"]);
    expect(wiring.removed).toEqual([]);
    expect(wiring.kept).toEqual([]);
    expect(wiring.model.pipelines.get("traces/a")?.receivers).toEqual(["otlp", "routing"]);
    expect(wiring.model.pipelines.get("traces/d")?.receivers).toEqual(["routing"]);
    expect(wiring.model.pipelines.get("traces/b")).toBe(model.pipelines.get("traces/b"));
    expect(wiring.model.pipelines.has("traces/nope")).toBe(false);
    expect(model.pipelines.get("traces/a")?.receivers).toEqual(["otlp"]);
  });

  it("removes it from pipelines no longer named, keeping it where it is the only receiver", () => {
    const wiring = wireConnectorReceivers(model, "routing", new Set(["traces/a", "traces/b", "traces/c"]), new Set(["traces/a"]));
    expect(wiring.added).toEqual([]);
    expect(wiring.removed).toEqual(["traces/c"]);
    expect(wiring.kept).toEqual(["traces/b"]);
    expect(wiring.model.pipelines.get("traces/c")?.receivers).toEqual(["otlp"]);
    expect(wiring.model.pipelines.get("traces/b")?.receivers).toEqual(["routing"]);
  });

  it("leaves pipelines named before and after, and returns the same model when nothing changes", () => {
    const same = wireConnectorReceivers(model, "routing", new Set(["traces/a", "traces/b"]), new Set(["traces/a", "traces/b"]));
    expect(same.model).toBe(model);
    expect(same).toMatchObject({ added: [], removed: [], kept: [] });
    // Only kept: the model is the same, and the keep is reported.
    const kept = wireConnectorReceivers(model, "routing", new Set(["traces/b"]), new Set());
    expect(kept.model).toBe(model);
    expect(kept.kept).toEqual(["traces/b"]);
  });

  it("replaces a with b: b gains it and a loses it", () => {
    const wiring = wireConnectorReceivers(model, "routing", new Set(["traces/c"]), new Set(["traces/a"]));
    expect(wiring.added).toEqual(["traces/a"]);
    expect(wiring.removed).toEqual(["traces/c"]);
  });

  it("offers the canvas's pipelines but the sources, of the sources' signal", () => {
    const canvas = [
      { id: "pipeline_0", name: "traces/in", signalType: "traces" as const },
      { id: "pipeline_1", name: "traces/a", signalType: "traces" as const },
      { id: "pipeline_2", name: "logs/a", signalType: "logs" as const },
      { id: "pipeline_3", name: "traces/b", signalType: "traces" as const },
    ];
    expect(connectorPipelineOptions(model, canvas, "routing").map((p) => p.name)).toEqual(["traces/a", "traces/b"]);
    // No source yet: every canvas pipeline.
    expect(connectorPipelineOptions(model, canvas, "routing/other").map((p) => p.name)).toEqual([
      "traces/in",
      "traces/a",
      "logs/a",
      "traces/b",
    ]);
  });
});
