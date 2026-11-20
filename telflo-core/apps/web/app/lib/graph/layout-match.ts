import { nextGroupYPosition, nextNodeId } from "./node-builders.js";
import { componentKey } from "./node-operations.js";
import type { Graph, OTelNode } from "./types.js";

/*
 * A saved layout onto a graph parsed from the text: the text gives the
 * components, pipelines and edges; the layout gives only positions, the
 * pipelines' group sizes and their colors.
 *
 * Matching is by what the text names, never by stored ids: a pipeline's group
 * by the pipeline's name, a component by its pipeline's name and its key
 * (`receivers.otlp/2`). What matches keeps its saved position (a component in
 * a group relative to it, as React Flow keeps it). What doesn't keeps the
 * place the parser's layout gave it, and a pipeline new to the layout goes
 * below the groups that matched. With no layout at all (a version saved
 * without one), the parser's whole layout stands.
 *
 * Stored entries the text no longer names are dropped, and so is any edge
 * whose end is gone.
 *
 * Also used by Apply, against the graph on screen, so applying text keeps the
 * canvas's arrangement where it can, rather than laying everything out again.
 */

/** A group's pipeline name: its label (`createGroupNode` and the parser set it to the name). */
function groupNames(nodes: readonly OTelNode[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of nodes) if (node.type === "pipelineGroup") names.set(node.id, node.data.label);
  return names;
}

/**
 * What a component is called for matching: its pipeline's name (empty for
 * one outside every group) and its key. Undefined for a group, and for a
 * node in a group the layout doesn't hold.
 */
function componentIdentity(node: OTelNode, groups: ReadonlyMap<string, string>): string | undefined {
  const key = componentKey(node.data);
  if (key === undefined) return undefined;
  if (node.parentId === undefined) return `\u0000${key}`;
  const pipeline = groups.get(node.parentId);
  return pipeline === undefined ? undefined : `${pipeline}\u0000${key}`;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `parsed` (from `parse`) arranged by `layout` (the stored graph, read by
 * `fromStored`, or the graph on screen). `parsed` isn't changed.
 */
export function matchLayout(parsed: Graph, layout: Graph | null | undefined): Graph {
  if (!layout || (layout.nodes.length === 0 && layout.pipelines.length === 0)) return parsed;

  const colours = new Map<string, string>();
  for (const node of layout.nodes) {
    if (node.type === "pipelineGroup" && typeof node.data.color === "string") colours.set(node.data.label, node.data.color);
  }
  for (const pipeline of layout.pipelines) if (pipeline.color !== undefined) colours.set(pipeline.name, pipeline.color);

  const storedGroups = new Map<string, OTelNode>();
  for (const node of layout.nodes) {
    if (node.type === "pipelineGroup" && !storedGroups.has(node.data.label)) storedGroups.set(node.data.label, node);
  }
  const storedGroupNames = groupNames(layout.nodes);
  const storedComponents = new Map<string, OTelNode[]>();
  for (const node of layout.nodes) {
    if (node.type === "pipelineGroup") continue;
    const identity = componentIdentity(node, storedGroupNames);
    if (identity === undefined) continue;
    const same = storedComponents.get(identity);
    if (same) same.push(node);
    else storedComponents.set(identity, [node]);
  }

  const parsedGroupNames = groupNames(parsed.nodes);
  const matchedGroups: OTelNode[] = [];
  const unmatchedGroups: OTelNode[] = [];
  const nodes = parsed.nodes.map((node): OTelNode => {
    if (node.type === "pipelineGroup") {
      const stored = storedGroups.get(node.data.label);
      const colour = colours.get(node.data.label);
      const data = colour === undefined ? node.data : { ...node.data, color: colour };
      if (!stored) {
        const unmatched = { ...node, data };
        unmatchedGroups.push(unmatched);
        return unmatched;
      }
      const width = finite(stored.style?.width) ?? node.style?.width;
      const height = finite(stored.style?.height) ?? node.style?.height;
      const matched: OTelNode = {
        ...node,
        position: { x: stored.position.x, y: stored.position.y },
        style: { ...node.style, width, height },
        data,
      };
      matchedGroups.push(matched);
      return matched;
    }
    const identity = componentIdentity(node, parsedGroupNames);
    const stored = identity === undefined ? undefined : storedComponents.get(identity)?.shift();
    return stored ? { ...node, position: { x: stored.position.x, y: stored.position.y } } : node;
  });

  // A pipeline the layout doesn't hold goes below the ones it does.
  if (matchedGroups.length > 0) {
    const placed = [...matchedGroups];
    for (const group of unmatchedGroups) {
      group.position = { x: group.position.x, y: nextGroupYPosition(placed) };
      placed.push(group);
    }
  }

  // A component dragged out of its pipelines onto the canvas, while other
  // pipelines still use it, has no place of its own in the text: the text
  // only lists it where it is used. Its stored copy comes back where it was
  // left, a node of the same component. A copy of a component the text no
  // longer declares stays dropped.
  const byKey = new Map<string, OTelNode>();
  for (const node of nodes) {
    const key = componentKey(node.data);
    if (key !== undefined && node.data.declared !== false && !byKey.has(key)) byKey.set(key, node);
  }
  for (const [identity, leftovers] of storedComponents) {
    if (!identity.startsWith("\u0000")) continue;
    const sibling = byKey.get(identity.slice(1));
    if (!sibling) continue;
    for (const stored of leftovers) {
      const id = nextNodeId(nodes.map((node) => node.id));
      const { pipeline: _pipeline, ...data } = sibling.data;
      const { parentId: _parent, ...rest } = sibling;
      nodes.push({ ...rest, id, data, position: { x: stored.position.x, y: stored.position.y }, selected: false });
    }
  }

  const pipelines = parsed.pipelines.map((pipeline) => {
    const colour = colours.get(pipeline.name);
    return colour === undefined ? pipeline : { ...pipeline, color: colour };
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = parsed.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges, pipelines };
}
