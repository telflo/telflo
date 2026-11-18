import {
  GRAPH_EDGE_ID_PATTERN,
  GRAPH_GROUP_ID_PATTERN,
  GRAPH_NODE_ID_PATTERN,
  GRAPH_PIPELINE_ID_PATTERN,
  GraphEdgesSchema,
  GraphNodesSchema,
  GraphPipelinesSchema,
} from "@telflo/contracts";
import { describe, expect, it } from "vitest";

import { deriveModel, readTextModel } from "../model.js";
import { componentName } from "../node-operations.js";
import { parse } from "../parse.js";
import { toStored } from "../stored-graph.js";
import { CORPUS, corpusText } from "./corpus.js";

function parsed(text: string) {
  const result = parse(text);
  if (!result.ok) throw new Error(`The corpus text doesn't parse: ${result.reason}`);
  return result;
}

/** Receivers, exporters and extensions are sets to the collector; processors are an order. */
function withoutListOrder(model: ReturnType<typeof readTextModel>) {
  return {
    components: model.components,
    undeclared: model.undeclared,
    extensions: [...model.extensions].sort(),
    pipelines: new Map(
      [...model.pipelines].map(([name, lists]) => [
        name,
        { receivers: [...lists.receivers].sort(), processors: lists.processors, exporters: [...lists.exporters].sort() },
      ]),
    ),
  };
}

describe("the corpus", () => {
  it("holds the starter, the builder tests' configurations and the hand-written cases", () => {
    expect(CORPUS.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "starter.yaml",
        "complex-config.yaml",
        "routing-connector.yaml",
        "failover-connector.yaml",
        "forward-connector.yaml",
        "service-telemetry.yaml",
        "connector-memberships.yaml",
        "extensions-disabled.yaml",
        "extensions-undeclared.yaml",
        "undeclared-references.yaml",
        "anchors-merges.yaml",
        "unknown-keys.yaml",
        "comments.yaml",
        "renamed-types-canonical.yaml",
        "crlf.yaml",
        "indent-four.yaml",
        "sequences-unindented.yaml",
        "layout-preserved.yaml",
        "flow-style.yaml",
        "no-final-newline.yaml",
        "anchors-owned.yaml",
        "item-lists.yaml",
        "anchored-items.yaml",
        "forms-kubernetes.yaml",
        "forms-host.yaml",
        "forms-logs-operators.yaml",
        "forms-metrics.yaml",
        "forms-traces.yaml",
        "forms-ottl.yaml",
        "forms-routing.yaml",
        "forms-storage.yaml",
        "forms-vendors.yaml",
        "routing-inconsistent.yaml",
        "flow-spread.yaml",
      ]),
    );
  });

  it.each(["crlf.yaml", "forms-host.yaml", "forms-routing.yaml", "forms-vendors.yaml", "routing-inconsistent.yaml", "flow-spread.yaml"])("keeps %s's CRLF line endings", (name) => {
    const text = corpusText(name);
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it.each(CORPUS.map((entry) => [entry.name, entry.text] as const))("%s parses", (_name, text) => {
    expect(parse(text).ok).toBe(true);
  });
});

// D9d Task 1: each of D9d's form families has its corpus text, with comments, an anchor, CRLF or `0750`, and
// pipelines; each D9d component is in one of them (the collector's current spellings too).
describe("D9d's corpus texts", () => {
  const D9D = ["forms-metrics.yaml", "forms-traces.yaml", "forms-ottl.yaml", "forms-routing.yaml", "forms-storage.yaml", "forms-vendors.yaml"];

  it.each(D9D)("%s has comments, an anchor, CRLF or 0750, and service.pipelines", (name) => {
    const text = corpusText(name);
    expect(text).toMatch(/^\s*#/m);
    expect(text).toMatch(/&[\w-]+/);
    expect(text.includes("\r\n") || /: 0750\b/.test(text)).toBe(true);
    expect(readTextModel(parsed(text).document).pipelines.size).toBeGreaterThan(0);
  });

  it("holds every D9d component", () => {
    const types = new Set(
      D9D.flatMap((name) => [...readTextModel(parsed(corpusText(name)).document).components.keys()]).map((key) => {
        const [section, name] = key.split(".") as [string, string];
        return `${section}.${name.split("/")[0]!}`;
      }),
    );
    expect([...types]).toEqual(
      expect.arrayContaining([
        "receivers.prometheus",
        "exporters.prometheus",
        "exporters.prometheusremotewrite",
        "exporters.prometheus_remote_write",
        "receivers.statsd",
        "processors.cumulativetodelta",
        "processors.cumulative_to_delta",
        "processors.metricstransform",
        "processors.groupbyattrs",
        "receivers.jaeger",
        "receivers.zipkin",
        "exporters.zipkin",
        "connectors.spanmetrics",
        "connectors.span_metrics",
        "processors.tail_sampling",
        "processors.probabilistic_sampler",
        "processors.span",
        "processors.transform",
        "processors.redaction",
        "processors.logdedup",
        "connectors.routing",
        "connectors.failover",
        "exporters.loadbalancing",
        "exporters.load_balancing",
        "exporters.datadog",
        "receivers.datadog",
        "exporters.awss3",
        "receivers.awss3",
        "receivers.aws_s3",
        "exporters.clickhouse",
        "exporters.file",
      ]),
    );
  });
});

/*
 * Texts whose routing or failover receivers disagree with the connector's
 * config (D9d spec decision 8): with the text's order, the canvas keeps the
 * receivers as the text lists them, so the invariant holds; D9a's
 * derivation without an order reads them from the config, so they differ.
 */
const INCONSISTENT_CONNECTOR_TEXTS: readonly string[] = ["routing-inconsistent.yaml"];

describe("the round-trip invariant: deriveModel(parse(text).graph) is the text's own model", () => {
  const withPipelines = CORPUS.filter((entry) => readTextModel(parsed(entry.text).document).pipelines.size > 0);

  it("covers every corpus text that has pipelines", () => {
    expect(withPipelines.map((entry) => entry.name).sort()).toEqual(
      CORPUS.map((entry) => entry.name)
        .filter((name) => !["empty.yaml", "no-pipelines.yaml"].includes(name))
        .sort(),
    );
  });

  it.each(withPipelines.map((entry) => [entry.name, entry.text] as const))("%s", (name, text) => {
    const { graph, document } = parsed(text);
    const textModel = readTextModel(document);

    expect(deriveModel(graph, textModel)).toEqual(textModel);
    // Without the text's order to follow, only the order of the sets differs.
    if (!INCONSISTENT_CONNECTOR_TEXTS.includes(name)) {
      expect(withoutListOrder(deriveModel(graph))).toEqual(withoutListOrder(textModel));
    }
  });

  it("routing-inconsistent.yaml disagrees with its configs both ways, and keeps every pipeline's processors", () => {
    const { graph, document } = parsed(corpusText("routing-inconsistent.yaml"));
    const textModel = readTextModel(document);
    const fromConfig = deriveModel(graph);

    // D9a's derivation would rewrite the receivers; the text's order keeps them, with the processors.
    expect(fromConfig.pipelines.get("traces/listed")?.receivers).toEqual([]);
    expect(fromConfig.pipelines.get("traces/named")?.receivers).toContain("routing");
    expect(fromConfig.pipelines.get("traces/backup")?.receivers).toContain("failover");
    const derived = deriveModel(graph, textModel);
    expect(derived.pipelines.get("traces/listed")).toEqual({
      receivers: ["routing"],
      processors: ["memory_limiter", "batch"],
      exporters: ["debug/audit"],
    });
    expect(derived.pipelines.get("traces/named")).toEqual({
      receivers: ["otlp"],
      processors: ["memory_limiter", "batch"],
      exporters: ["debug"],
    });
    expect(derived.pipelines.get("traces/backup")).toEqual({ receivers: ["otlp"], processors: ["batch"], exporters: ["debug"] });
  });

  it.each(["empty.yaml", "no-pipelines.yaml"])(
    "%s has no pipelines: the graph shows the three default pipelines, empty",
    (name) => {
      const { graph, document } = parsed(corpusText(name));
      const textModel = readTextModel(document);
      const derived = deriveModel(graph, textModel);

      expect(textModel.pipelines.size).toBe(0);
      expect([...derived.pipelines]).toEqual([
        ["traces", { receivers: [], processors: [], exporters: [] }],
        ["metrics", { receivers: [], processors: [], exporters: [] }],
        ["logs", { receivers: [], processors: [], exporters: [] }],
      ]);
      expect(derived.components).toEqual(textModel.components);
      expect(derived.extensions).toEqual(textModel.extensions);
    },
  );
});

describe("ids never carry a name (decision 7)", () => {
  it.each(CORPUS.map((entry) => [entry.name, entry.text] as const))("%s", (_name, text) => {
    const { graph } = parsed(text);
    const names = new Set<string>();
    for (const node of graph.nodes) {
      names.add(node.data.label);
      if (node.data.key) names.add(node.data.key);
      if (node.type !== "pipelineGroup") names.add(componentName(node.data));
      if (node.data.instanceName) names.add(node.data.instanceName);
    }
    for (const pipeline of graph.pipelines) names.add(pipeline.name);
    names.delete("");

    const ids = [...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id), ...graph.pipelines.map((p) => p.id)];
    for (const id of ids) {
      for (const name of names) expect(id.includes(name), `${id} contains ${name}`).toBe(false);
    }
    for (const node of graph.nodes) {
      const pattern = node.type === "pipelineGroup" ? GRAPH_GROUP_ID_PATTERN : GRAPH_NODE_ID_PATTERN;
      expect(node.id).toMatch(pattern);
    }
    for (const edge of graph.edges) expect(edge.id).toMatch(GRAPH_EDGE_ID_PATTERN);
    for (const pipeline of graph.pipelines) expect(pipeline.id).toMatch(GRAPH_PIPELINE_ID_PATTERN);
  });
});

describe("toStored passes the contract's column schemas for the whole corpus", () => {
  it.each(CORPUS.map((entry) => [entry.name, entry.text] as const))("%s", (_name, text) => {
    const { graph } = parsed(text);
    const stored = toStored(graph);

    expect(GraphNodesSchema.safeParse(stored.nodes).success).toBe(true);
    expect(GraphEdgesSchema.safeParse(stored.edges).success).toBe(true);
    expect(GraphPipelinesSchema.safeParse(stored.pipelines).success).toBe(true);
    // Stored in full, not by the fallbacks.
    expect(stored.nodes).toHaveLength(graph.nodes.length);
    expect(stored.pipelines).toHaveLength(graph.pipelines.length);
    expect(stored.edges.length).toBeGreaterThanOrEqual(
      graph.edges.filter((e) => e.source.startsWith("node_") && e.target.startsWith("node_")).length,
    );
  });
});
