/**
 * parseYAMLToGraph layout: imported YAML (flows, CLI-created versions, AI
 * edits, YAML Apply) must land on the canvas without overlapping cards.
 *
 * On `parse` (D9a Parity Notes). Its two texts are corpus files
 * (layout-wide.yaml, layout-routing.yaml).
 */
import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { groupIdForPipeline } from "./node-builders.js";
import { parse } from "./parse.js";
import { estimateNodeWidth } from "./pipeline-layout.js";
import { CONNECTOR_NODE_WIDTH, ROUTE_TARGET_GAP } from "./routing-connector.js";
import type { Graph, OTelNode } from "./types.js";

function parseYAMLToGraph(text: string): Graph {
  const result = parse(text);
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

/** A pipeline's group, by the pipeline's name. */
function groupIdOf(graph: Graph, name: string): string {
  return groupIdForPipeline(graph.pipelines.find((p) => p.name === name)!.id);
}

const wideYaml = corpusText("layout-wide.yaml");
const routingYaml = corpusText("layout-routing.yaml");

const CARD_H = 92;

const rect = (n: OTelNode) => ({
  left: n.position.x,
  top: n.position.y,
  right:
    n.position.x +
    (n.type === "pipelineGroup"
      ? (n.style?.width as number)
      : estimateNodeWidth(n)),
  bottom:
    n.position.y +
    (n.type === "pipelineGroup" ? (n.style?.height as number) : CARD_H),
});

const overlaps = (a: OTelNode, b: OTelNode) => {
  const ra = rect(a);
  const rb = rect(b);
  return (
    ra.left < rb.right &&
    rb.left < ra.right &&
    ra.top < rb.bottom &&
    rb.top < ra.bottom
  );
};

// A wide pipeline (five components, a long instance name) plus a connector
// and an extension: the shape that used to pile connectors onto the group.
describe("parseYAMLToGraph lays imported YAML out without overlaps", () => {
  it("stacks a pipeline's receivers in one column", () => {
    const graph = parseYAMLToGraph(wideYaml);
    const receivers = graph.nodes.filter(
      (n) => n.type === "receiver" && n.parentId === groupIdOf(graph, "traces"),
    );

    expect(receivers).toHaveLength(2);
    expect(receivers[0]!.position.x).toBe(receivers[1]!.position.x);
    expect(receivers[0]!.position.y).not.toBe(receivers[1]!.position.y);
  });

  it("gives a long-named processor real room instead of a fixed column pitch", () => {
    const graph = parseYAMLToGraph(wideYaml);
    const { nodes } = graph;
    const group = nodes.find((n) => n.id === groupIdOf(graph, "traces"))!;
    const children = nodes.filter((n) => n.parentId === group.id);

    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        expect(overlaps(children[i]!, children[j]!), `${children[i]!.id} overlaps ${children[j]!.id}`).toBe(false);
      }
    }
    const rightmost = Math.max(
      ...children.map((c) => c.position.x + estimateNodeWidth(c)),
    );
    expect(group.style?.width as number).toBeGreaterThanOrEqual(rightmost);
  });

  it("keeps the connector, the extensions and both groups clear of each other", () => {
    const { nodes } = parseYAMLToGraph(wideYaml);
    const floating = nodes.filter((n) => !n.parentId);

    for (let i = 0; i < floating.length; i++) {
      for (let j = i + 1; j < floating.length; j++) {
        expect(overlaps(floating[i]!, floating[j]!), `${floating[i]!.id} overlaps ${floating[j]!.id}`).toBe(false);
      }
    }
  });

  it("puts extensions below every pipeline group", () => {
    const { nodes } = parseYAMLToGraph(wideYaml);
    const groupsBottom = Math.max(
      ...nodes
        .filter((n) => n.type === "pipelineGroup")
        .map((g) => g.position.y + (g.style?.height as number)),
    );

    const extensions = nodes.filter((n) => n.type === "extension");
    expect(extensions).toHaveLength(2);
    for (const ext of extensions) {
      expect(ext.position.y).toBeGreaterThanOrEqual(groupsBottom);
    }
  });

  it("seats a routing connector under its source with every target pipeline to its right", () => {
    const graph = parseYAMLToGraph(routingYaml);
    const { nodes } = graph;
    const conn = nodes.find((n) => n.data.componentType === "connector")!;
    const groupOf = (name: string) => nodes.find((n) => n.id === groupIdOf(graph, name))!;
    const source = groupOf("traces/in");

    expect(conn.position.y).toBeGreaterThanOrEqual(
      source.position.y + (source.style?.height as number),
    );
    for (const name of ["traces/llm", "traces/other"]) {
      expect(groupOf(name).position.x).toBeGreaterThanOrEqual(
        conn.position.x + CONNECTOR_NODE_WIDTH + ROUTE_TARGET_GAP,
      );
    }
  });
});
