import { describe, expect, it } from "vitest";

import { estimateNodeWidth, layoutPipelineGraph } from "./pipeline-layout.js";
import { CANVAS_GRID_SIZE } from "./constants.js";
import {
  CONNECTOR_NODE_WIDTH,
  ROUTE_TARGET_GAP,
  pushConfigTargetsRight,
} from "./routing-connector.js";
import {
  buildComplexConfig,
  buildNamedPipeline,
  createConnectorNode,
  createExtensionNode,
  mergePipelineGraphs,
} from "~/test/pipeline-builder.js";
import type { OTelNode } from "./types.js";

/*
 * The layered re-layout (D9a Parity Notes). The fixture's pipelines take
 * opaque ids, so a group is `group_<n>` for its pipeline's `pipeline_<n>`
 * (decision 7).
 */

/** The nodes at `ids`, which the fixture guarantees. */
function pick(nodes: readonly OTelNode[], ...ids: string[]): OTelNode[] {
  return ids.map((id) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
  });
}

const groupSize = (g: OTelNode) => ({
  width: g.style?.width as number,
  height: g.style?.height as number,
});

// Conservative card heights: the layout sizes stacks around the tallest
// variant (a node shared across pipelines), single-pipeline cards are shorter.
const CARD_H_TALL = 92;
const CARD_H_SHORT = 72;

function tracesPipeline() {
  return buildNamedPipeline({
    pipelineId: "pipeline_1",
    pipelineName: "traces",
    signalType: "traces",
    receiverSubTypes: [{ subType: "otlp" }, { subType: "jaeger" }],
    processorSubTypes: [{ subType: "memory_limiter" }, { subType: "batch" }],
    exporterSubTypes: [{ subType: "otlp" }, { subType: "debug" }],
    nodePrefix: "a",
  });
}

function metricsPipeline(y = 900) {
  const metrics = buildNamedPipeline({
    pipelineId: "pipeline_2",
    pipelineName: "metrics",
    signalType: "metrics",
    receiverSubTypes: [{ subType: "otlp" }],
    processorSubTypes: [{ subType: "batch" }],
    exporterSubTypes: [{ subType: "otlphttp" }],
    nodePrefix: "m",
  });
  // The parser emits groups top-to-bottom; the fixture parks every group at
  // the same y, so spread them the way the parser would.
  metrics.nodes[0]!.position = { x: 100, y };
  return metrics;
}

describe("layoutPipelineGraph - columns inside a pipeline group", () => {
  it("stacks receivers in one column, gives each processor its own, and stacks exporters last", () => {
    const { nodes, edges } = tracesPipeline();
    const laid = layoutPipelineGraph(nodes, edges);
    const byType = (t: string) => laid.filter((n) => n.type === t);
    const [r1, r2] = byType("receiver") as [OTelNode, OTelNode];
    const [p1, p2] = byType("processor") as [OTelNode, OTelNode];
    const [e1, e2] = byType("exporter") as [OTelNode, OTelNode];

    expect(r1.position.x).toBe(r2.position.x);
    expect(r1.position.y).not.toBe(r2.position.y);
    expect(e1.position.x).toBe(e2.position.x);
    expect(e1.position.y).not.toBe(e2.position.y);
    expect(p1.position.x).not.toBe(p2.position.x);

    // Columns march right with room for the widest card in each.
    const cols = [r1, p1, p2, e1];
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i]!.position.x).toBeGreaterThanOrEqual(
        cols[i - 1]!.position.x + estimateNodeWidth(cols[i - 1]!),
      );
    }
  });
});

describe("layoutPipelineGraph - group sizing and stacking", () => {
  it("resizes each group to contain its children and stacks groups apart, in input order", () => {
    const { nodes, edges } = mergePipelineGraphs(
      tracesPipeline(),
      metricsPipeline(),
    );

    const laid = layoutPipelineGraph(nodes, edges);
    const groups = laid.filter((n) => n.type === "pipelineGroup");

    expect(groups.map((g) => g.id)).toEqual([
      "group_1",
      "group_2",
    ]);
    for (const g of groups) {
      const { width, height } = groupSize(g);
      for (const child of laid.filter((n) => n.parentId === g.id)) {
        expect(child.position.x).toBeGreaterThanOrEqual(0);
        expect(child.position.y).toBeGreaterThanOrEqual(0);
        expect(child.position.x + estimateNodeWidth(child)).toBeLessThanOrEqual(
          width,
        );
        expect(child.position.y + CARD_H_TALL).toBeLessThanOrEqual(height);
      }
    }
    const [g1, g2] = groups as [OTelNode, OTelNode];
    expect(g2.position.y).toBeGreaterThanOrEqual(
      g1.position.y + groupSize(g1).height,
    );
  });

  it("returns a fresh array, leaves the input untouched, and keeps groups ahead of their children", () => {
    const { nodes, edges } = buildComplexConfig();
    const before = structuredClone(nodes);

    const laid = layoutPipelineGraph(nodes, edges);

    expect(laid).not.toBe(nodes);
    expect(nodes).toEqual(before);
    const index = new Map(laid.map((n, i) => [n.id, i]));
    for (const n of laid) {
      if (n.parentId) {
        expect(index.get(n.parentId)!).toBeLessThan(index.get(n.id)!);
      }
    }
  });
});

describe("layoutPipelineGraph - connectors", () => {
  it("seats a connector wired on both sides in the gap between the pipelines it bridges, target starting to its right", () => {
    // buildComplexConfig wires spanmetrics: traces -> connector -> metrics.
    const { nodes, edges } = buildComplexConfig();

    const laid = layoutPipelineGraph(nodes, edges);
    const conn = laid.find((n) => n.id === "conn-spanmetrics")!;
    const traces = laid.find((n) => n.id === "group_0")!;
    const metrics = laid.find((n) => n.id === "group_1")!;

    expect(conn.position.y).toBeGreaterThanOrEqual(
      traces.position.y + groupSize(traces).height,
    );
    expect(conn.position.y + CARD_H_SHORT).toBeLessThanOrEqual(
      metrics.position.y,
    );
    expect(metrics.position.x).toBeGreaterThan(
      conn.position.x + estimateNodeWidth(conn),
    );
  });
});

describe("layoutPipelineGraph - routing connectors (targets live in config)", () => {
  function routingScenario() {
    const source = buildNamedPipeline({
      pipelineId: "pipeline_10",
      pipelineName: "traces/in",
      signalType: "traces",
      receiverSubTypes: [{ subType: "otlp" }],
      processorSubTypes: [{ subType: "batch" }],
      exporterSubTypes: [],
      nodePrefix: "in",
    });
    const llm = buildNamedPipeline({
      pipelineId: "pipeline_11",
      pipelineName: "traces/llm",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [{ subType: "batch" }],
      exporterSubTypes: [{ subType: "otlp" }],
      nodePrefix: "llm",
    });
    const other = buildNamedPipeline({
      pipelineId: "pipeline_12",
      pipelineName: "traces/other",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [],
      exporterSubTypes: [{ subType: "debug" }],
      nodePrefix: "other",
    });
    llm.nodes[0]!.position = { x: 100, y: 400 };
    other.nodes[0]!.position = { x: 100, y: 700 };
    const merged = mergePipelineGraphs(source, llm, other);
    const conn = createConnectorNode("conn-routing", "routing");
    conn.data.config = {
      error_mode: "ignore",
      table: [
        {
          context: "span",
          condition: 'attributes["gen_ai.system"] != nil',
          pipelines: ["traces/llm"],
        },
      ],
      default_pipelines: ["traces/other"],
    };
    merged.nodes.push(conn);
    // The parser wires the source pipeline INTO the connector; the route
    // edges out of it are derived from config at render time.
    merged.edges.push({
      id: "in-processor-0-conn-routing",
      source: "in-processor-0",
      target: "conn-routing",
      type: "smoothstep",
      data: {},
    });
    return merged;
  }

  it("seats the connector below its source pipeline and starts every config target to its right", () => {
    const { nodes, edges, pipelines } = routingScenario();

    const laid = layoutPipelineGraph(nodes, edges, pipelines);
    const conn = laid.find((n) => n.id === "conn-routing")!;
    const source = laid.find((n) => n.id === "group_10")!;
    const minTargetX =
      conn.position.x + CONNECTOR_NODE_WIDTH + ROUTE_TARGET_GAP;

    expect(conn.position.y).toBeGreaterThanOrEqual(
      source.position.y + groupSize(source).height,
    );
    for (const id of ["group_11", "group_12"]) {
      expect(laid.find((n) => n.id === id)!.position.x).toBeGreaterThanOrEqual(
        minTargetX,
      );
    }
    // The parser's routing post-pass then has nothing left to do.
    expect(pushConfigTargetsRight(laid, pipelines)).toBe(laid);
  });
});

describe("layoutPipelineGraph - failover connectors (targets live in config)", () => {
  it("indents every priority-level pipeline to the connector's right, like routing", () => {
    const source = buildNamedPipeline({
      pipelineId: "pipeline_10",
      pipelineName: "traces/in",
      signalType: "traces",
      receiverSubTypes: [{ subType: "otlp" }],
      processorSubTypes: [{ subType: "batch" }],
      exporterSubTypes: [],
      nodePrefix: "in",
    });
    const primary = buildNamedPipeline({
      pipelineId: "pipeline_11",
      pipelineName: "traces/primary",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [],
      exporterSubTypes: [{ subType: "otlp" }],
      nodePrefix: "primary",
    });
    const backup = buildNamedPipeline({
      pipelineId: "pipeline_12",
      pipelineName: "traces/backup",
      signalType: "traces",
      receiverSubTypes: [],
      processorSubTypes: [],
      exporterSubTypes: [{ subType: "debug" }],
      nodePrefix: "backup",
    });
    primary.nodes[0]!.position = { x: 100, y: 400 };
    backup.nodes[0]!.position = { x: 100, y: 700 };
    const { nodes, edges, pipelines } = mergePipelineGraphs(
      source,
      primary,
      backup,
    );
    const conn = createConnectorNode("conn-failover", "failover");
    conn.data.config = {
      priority_levels: [["traces/primary"], ["traces/backup"]],
    };
    nodes.push(conn);
    edges.push({
      id: "in-processor-0-conn-failover",
      source: "in-processor-0",
      target: "conn-failover",
      type: "smoothstep",
      data: {},
    });

    const laid = layoutPipelineGraph(nodes, edges, pipelines);
    const laidConn = laid.find((n) => n.id === "conn-failover")!;
    const minTargetX =
      laidConn.position.x + CONNECTOR_NODE_WIDTH + ROUTE_TARGET_GAP;

    for (const id of ["group_11", "group_12"]) {
      expect(laid.find((n) => n.id === id)!.position.x).toBeGreaterThanOrEqual(
        minTargetX,
      );
    }
    expect(pushConfigTargetsRight(laid, pipelines)).toBe(laid);
  });
});

describe("layoutPipelineGraph - connectors that are not fully wired", () => {
  function halfWired() {
    const merged = mergePipelineGraphs(tracesPipeline(), metricsPipeline());
    // Fed by the traces pipeline, feeding nothing (yet).
    merged.nodes.push(createConnectorNode("conn-forward", "forward"));
    merged.edges.push({
      id: "a-exporter-0-conn-forward",
      source: "a-exporter-0",
      target: "conn-forward",
      type: "smoothstep",
      data: {},
    });
    // Declared but wired to nothing at all.
    merged.nodes.push(createConnectorNode("conn-loose", "spanmetrics"));
    return merged;
  }

  it("parks them right of every group instead of leaving them where the parser put them", () => {
    const { nodes, edges } = halfWired();

    const laid = layoutPipelineGraph(nodes, edges);
    const rightEdge = Math.max(
      ...laid
        .filter((n) => n.type === "pipelineGroup")
        .map((g) => g.position.x + groupSize(g).width),
    );
    const forward = laid.find((n) => n.id === "conn-forward")!;
    const loose = laid.find((n) => n.id === "conn-loose")!;

    expect(forward.position.x).toBeGreaterThanOrEqual(rightEdge);
    expect(loose.position.x).toBeGreaterThanOrEqual(rightEdge);
    // Side by side, not on top of each other.
    const [left, right] = [forward, loose].sort(
      (a, b) => a.position.x - b.position.x,
    ) as [OTelNode, OTelNode];
    expect(right.position.x).toBeGreaterThanOrEqual(
      left.position.x + estimateNodeWidth(left),
    );
  });

  it("centres a half-wired connector on the node that feeds it", () => {
    const { nodes, edges } = halfWired();

    const laid = layoutPipelineGraph(nodes, edges);
    const forward = laid.find((n) => n.id === "conn-forward")!;
    const traces = laid.find((n) => n.id === "group_1")!;
    const feeder = laid.find((n) => n.id === "a-exporter-0")!;
    const feederCenterY =
      traces.position.y + feeder.position.y + CARD_H_SHORT / 2;
    const connCenterY = forward.position.y + CARD_H_SHORT / 2;

    expect(Math.abs(connCenterY - feederCenterY)).toBeLessThanOrEqual(20);
  });
});

describe("layoutPipelineGraph - nodes outside pipeline groups", () => {
  function withFloatingNodes() {
    // Three stacked receivers make a tall group that the parser's fixed
    // extension row (groupCount * 300) would land inside.
    const { nodes, edges } = buildNamedPipeline({
      pipelineId: "pipeline_1",
      pipelineName: "traces",
      signalType: "traces",
      receiverSubTypes: [
        { subType: "otlp" },
        { subType: "jaeger" },
        { subType: "otlp", instanceName: "second" },
      ],
      processorSubTypes: [{ subType: "batch" }],
      exporterSubTypes: [{ subType: "otlp" }],
      nodePrefix: "a",
    });
    nodes.push(
      createExtensionNode("ext-health", "health_check"),
      createExtensionNode("ext-pprof", "pprof"),
    );
    // A component the user dragged out of every pipeline: no parentId.
    const { parentId: _parentId, ...exporter } = nodes.find((n) => n.id === "a-exporter-0")!;
    nodes.push({
      ...exporter,
      id: "loose-exporter",
      position: { x: 300, y: 300 },
    });
    return { nodes, edges };
  }

  it("re-seats extensions and ungrouped components below the last group without overlap", () => {
    const { nodes, edges } = withFloatingNodes();

    const laid = layoutPipelineGraph(nodes, edges);
    const groupBottom = Math.max(
      ...laid
        .filter((n) => n.type === "pipelineGroup")
        .map((g) => g.position.y + groupSize(g).height),
    );
    const floating = laid.filter(
      (n) => !n.parentId && n.type !== "pipelineGroup",
    );

    expect(floating.map((n) => n.id).sort()).toEqual([
      "ext-health",
      "ext-pprof",
      "loose-exporter",
    ]);
    for (const n of floating) {
      expect(n.position.y).toBeGreaterThanOrEqual(groupBottom);
    }
    // Extensions get their own row beneath the loose components.
    const looseRowY = laid.find((n) => n.id === "loose-exporter")!.position.y;
    for (const id of ["ext-health", "ext-pprof"]) {
      expect(laid.find((n) => n.id === id)!.position.y).toBeGreaterThan(
        looseRowY,
      );
    }
    const [e1, e2] = pick(laid, "ext-health", "ext-pprof") as [OTelNode, OTelNode];
    expect(e2.position.x).toBeGreaterThanOrEqual(
      e1.position.x + estimateNodeWidth(e1),
    );
  });
});

describe("layoutPipelineGraph - connectors dragged into a group", () => {
  it("lays a parented connector as one of its group's columns and keeps it group-relative", () => {
    const { nodes, edges } = mergePipelineGraphs(
      tracesPipeline(),
      metricsPipeline(),
    );
    const conn = createConnectorNode("conn-inside", "forward");
    conn.parentId = "group_1";
    conn.position = { x: 10, y: 10 };
    nodes.push(conn);
    // Wired on both sides, so a naive pass would try to re-seat it between
    // the groups in ABSOLUTE coordinates - wrong for a child node.
    edges.push(
      {
        id: "a-exporter-1-conn-inside",
        source: "a-exporter-1",
        target: "conn-inside",
        type: "smoothstep",
        data: {},
      },
      {
        id: "conn-inside-m-receiver-0",
        source: "conn-inside",
        target: "m-receiver-0",
        type: "smoothstep",
        data: {},
      },
    );

    const laid = layoutPipelineGraph(nodes, edges);
    const inside = laid.find((n) => n.id === "conn-inside")!;
    const group = laid.find((n) => n.id === "group_1")!;
    const lastExporter = laid.find((n) => n.id === "a-exporter-1")!;

    expect(inside.parentId).toBe("group_1");
    expect(inside.position.x).toBeGreaterThan(lastExporter.position.x);
    expect(inside.position.x + estimateNodeWidth(inside)).toBeLessThanOrEqual(
      groupSize(group).width,
    );
    expect(inside.position.y + CARD_H_SHORT).toBeLessThanOrEqual(
      groupSize(group).height,
    );
  });
});

describe("layoutPipelineGraph - stability", () => {
  it("is idempotent", () => {
    const { nodes, edges, pipelines } = buildComplexConfig();

    const once = layoutPipelineGraph(nodes, edges, pipelines);
    const twice = layoutPipelineGraph(once, edges, pipelines);

    expect(twice).toEqual(once);
  });

  it("aligns groups, connectors and extensions to the 20px canvas grid", () => {
    const { nodes, edges, pipelines } = buildComplexConfig();

    const laid = layoutPipelineGraph(nodes, edges, pipelines);

    for (const n of laid) {
      if (n.parentId) continue; // children are centred on their spine
      expect(n.position.x % CANVAS_GRID_SIZE, `${n.id} x`).toBe(0);
      expect(n.position.y % CANVAS_GRID_SIZE, `${n.id} y`).toBe(0);
      if (n.type === "pipelineGroup") {
        expect(groupSize(n).width % CANVAS_GRID_SIZE, `${n.id} w`).toBe(0);
        expect(groupSize(n).height % CANVAS_GRID_SIZE, `${n.id} h`).toBe(0);
      }
    }
  });
});
