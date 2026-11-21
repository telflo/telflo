import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { matchLayout } from "./layout-match.js";
import { componentKey } from "./node-operations.js";
import { parse } from "./parse.js";
import { fromStored, toStored } from "./stored-graph.js";
import type { Graph, OTelNode } from "./types.js";

function parsed(text: string): Graph {
  const result = parse(text);
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

function group(graph: Graph, name: string): OTelNode {
  return graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === name)!;
}

function component(graph: Graph, key: string, pipeline?: string): OTelNode {
  const parent = pipeline === undefined ? undefined : group(graph, pipeline).id;
  return graph.nodes.find((n) => n.type !== "pipelineGroup" && componentKey(n.data) === key && n.parentId === parent)!;
}

/** `graph` with one node moved. */
function moved(graph: Graph, id: string, position: { x: number; y: number }): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, position } : n)) };
}

const STARTER = corpusText("starter.yaml");

describe("matchLayout", () => {
  it("keeps the parser's whole layout when nothing was stored", () => {
    const graph = parsed(STARTER);
    expect(matchLayout(graph, null)).toBe(graph);
    expect(matchLayout(graph, undefined)).toBe(graph);
    expect(matchLayout(graph, { nodes: [], edges: [], pipelines: [] })).toBe(graph);
  });

  it("takes positions, group sizes and colors by pipeline name and component key, never by id", () => {
    const graph = parsed(STARTER);
    let layout = moved(graph, group(graph, "logs").id, { x: 7, y: 9 });
    layout = moved(layout, component(graph, "exporters.otlp", "logs").id, { x: 31, y: 42 });
    layout = {
      ...layout,
      nodes: layout.nodes.map((n) =>
        n.id === group(graph, "logs").id ? { ...n, style: { width: 1234, height: 567 }, data: { ...n.data, color: "#84cc16" } } : n,
      ),
      pipelines: layout.pipelines.map((p) => (p.name === "logs" ? { ...p, color: "#06b6d4" } : p)),
    };
    // Stored under other ids, as another writer might number them.
    const stored = fromStored(
      JSON.parse(JSON.stringify(toStored(layout)).replaceAll('"node_', '"node_1').replaceAll("group_2", "group_8")),
    );

    const matched = matchLayout(graph, stored);

    expect(group(matched, "logs")).toMatchObject({ position: { x: 7, y: 9 }, style: { width: 1234, height: 567 } });
    // The pipeline's color wins over its group's.
    expect(group(matched, "logs").data.color).toBe("#06b6d4");
    expect(matched.pipelines.find((p) => p.name === "logs")?.color).toBe("#06b6d4");
    expect(component(matched, "exporters.otlp", "logs").position).toEqual({ x: 31, y: 42 });
    expect(matched.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
    expect(matched.edges).toEqual(graph.edges);
  });

  it("uses each stored node once, and ignores one whose group isn't stored", () => {
    const graph = parsed(STARTER);
    const stored = toStored(graph);
    const otlp = stored.nodes.find((n) => n.type === "receiver")!;
    const layout = fromStored({
      ...stored,
      nodes: [
        ...stored.nodes.filter((n) => n.id !== otlp.id),
        { ...otlp, id: "node_500", position: { x: 1, y: 1 } },
        { ...otlp, id: "node_501", position: { x: 2, y: 2 } },
        { ...otlp, id: "node_502", parentId: "group_77", position: { x: 3, y: 3 } },
      ],
    });

    const matched = matchLayout(graph, layout);

    expect(component(matched, "receivers.otlp", "traces").position).toEqual({ x: 1, y: 1 });
  });

  it("drops what the text no longer names, keeps the parser's place for what's new, and puts a new pipeline below", () => {
    const before = parsed(STARTER);
    const layout = moved(before, component(before, "receivers.otlp", "logs").id, { x: 600, y: 10 });
    const text = STARTER.replace("    logs:\n      receivers: [otlp]", "    logs/new:\n      receivers: [otlp]");
    const graph = parsed(text);

    const matched = matchLayout(graph, layout);

    expect(matched.nodes.some((n) => n.data.label === "logs")).toBe(false);
    const fresh = group(matched, "logs/new");
    const others = matched.nodes.filter((n) => n.type === "pipelineGroup" && n !== fresh);
    expect(fresh.position.y).toBeGreaterThan(Math.max(...others.map((g) => g.position.y + (g.style!.height as number))));
    // Its components are the parser's, relative to their group.
    expect(component(matched, "receivers.otlp", "logs/new").position).toEqual(
      component(graph, "receivers.otlp", "logs/new").position,
    );
  });

  it("matches an ungrouped component by its key alone", () => {
    const text = `${STARTER}connectors:\n  forward: {}\n`;
    const graph = parsed(text);
    const forward = component(graph, "connectors.forward");
    const layout = moved(graph, forward.id, { x: -400, y: 900 });

    expect(component(matchLayout(graph, layout), "connectors.forward").position).toEqual({ x: -400, y: 900 });
  });

  it("brings back a component dragged out of a pipeline while others still use it, where it was left", () => {
    const before = parsed(STARTER);
    const otlp = component(before, "receivers.otlp", "traces");
    const { parentId: _parent, ...ungrouped } = { ...otlp, position: { x: 1500, y: 40 } };
    const layout = fromStored(toStored({ ...before, nodes: before.nodes.map((n) => (n.id === otlp.id ? ungrouped : n)) }));
    // The text after the drag: traces no longer lists otlp; metrics and logs still do.
    const text = STARTER.replace("    traces:\n      receivers: [otlp]", "    traces:\n      receivers: []");

    const matched = matchLayout(parsed(text), layout);

    const receivers = matched.nodes.filter((n) => componentKey(n.data) === "receivers.otlp");
    expect(receivers).toHaveLength(3);
    const outside = component(matched, "receivers.otlp");
    expect(outside.position).toEqual({ x: 1500, y: 40 });
    expect(outside.data.pipeline).toBeUndefined();
    expect(outside.data.sharedConfigId).toBe(component(matched, "receivers.otlp", "metrics").data.sharedConfigId);
    expect(new Set(matched.nodes.map((n) => n.id)).size).toBe(matched.nodes.length);
  });

  it("doesn't bring back a stored copy of a component the text no longer declares", () => {
    const before = parsed(STARTER);
    const otlp = component(before, "receivers.otlp", "traces");
    const { parentId: _parent, ...ungrouped } = { ...otlp, position: { x: 1500, y: 40 } };
    const layout = fromStored(toStored({ ...before, nodes: before.nodes.map((n) => (n.id === otlp.id ? ungrouped : n)) }));
    const text = `exporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      exporters: [debug]\n`;

    expect(matchLayout(parsed(text), layout).nodes.some((n) => componentKey(n.data) === "receivers.otlp")).toBe(false);
  });

  it("drops edges whose ends aren't there", () => {
    const graph = parsed(STARTER);
    const withDangling = { ...graph, edges: [...graph.edges, { id: "edge_99", source: "node_404", target: "node_0" }] };
    const layout = moved(graph, group(graph, "traces").id, { x: 1, y: 1 });
    expect(matchLayout(withDangling, layout).edges).toEqual(graph.edges);
  });
});
