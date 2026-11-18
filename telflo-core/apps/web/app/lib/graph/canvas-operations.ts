import { PIPELINE_GROUP_HEIGHT, PIPELINE_GROUP_WIDTH } from "./constants.js";
import { nextNodeId } from "./node-builders.js";
import {
  buildInstanceLabel,
  buildYamlName,
  componentKey,
  getNextInstanceName,
  SECTION_OF_TYPE,
  sharedConfigIdOf,
} from "./node-operations.js";
import { paletteDefaultConfig } from "./palette.js";
import { isConfigTargetedConnectorNode } from "./routing-connector.js";
import type { Graph, OTelNode, OTelNodeData, PaletteComponent } from "./types.js";

/*
 * The canvas's changes to the graph, as pure functions (D9a decision 8;
 * Preflight ruling 17): the canvas's handlers (drop, connect, drag into and
 * out of groups, group resize) and the store's layout rules,
 * so the editor's store runs them in its one place and the tests reach them
 * without React Flow. Nothing here writes the text.
 */

export interface Point {
  x: number;
  y: number;
}

function sizeOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A group's size: its style's, else the default size. */
export function groupSize(group: OTelNode): { width: number; height: number } {
  return {
    width: sizeOf(group.style?.width, PIPELINE_GROUP_WIDTH),
    height: sizeOf(group.style?.height, PIPELINE_GROUP_HEIGHT),
  };
}

export function isGroup(node: OTelNode): boolean {
  return node.type === "pipelineGroup";
}

/**
 * Parents before children: React Flow needs a group before the nodes in it.
 * The same array when already so.
 */
export function ensureParentChildOrder(nodes: OTelNode[]): OTelNode[] {
  let seenNonGroup = false;
  for (const node of nodes) {
    if (isGroup(node)) {
      if (seenNonGroup) return [...nodes.filter(isGroup), ...nodes.filter((n) => !isGroup(n))];
    } else {
      seenNonGroup = true;
    }
  }
  return nodes;
}

/** The first group whose bounds hold `point` (absolute), as drop and drag hit-test. */
export function groupAt(nodes: readonly OTelNode[], point: Point): OTelNode | undefined {
  return nodes.find((group) => {
    if (!isGroup(group)) return false;
    const { width, height } = groupSize(group);
    return (
      point.x >= group.position.x &&
      point.x <= group.position.x + width &&
      point.y >= group.position.y &&
      point.y <= group.position.y + height
    );
  });
}

/** A node's position on the canvas: its own, plus its group's when it has one. */
export function absolutePosition(node: OTelNode, nodes: readonly OTelNode[]): Point {
  const parent = node.parentId === undefined ? undefined : nodes.find((n) => n.id === node.parentId);
  return { x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0) };
}

/** `node` in `group` (or in none), at the same place on the canvas, with its pipeline's name. */
export function reparented(node: OTelNode, group: OTelNode | undefined, nodes: readonly OTelNode[]): OTelNode {
  const absolute = absolutePosition(node, nodes);
  const { pipeline: _pipeline, ...data } = node.data;
  const { parentId: _parentId, ...rest } = node;
  if (!group) return { ...rest, position: absolute, data: data as OTelNodeData };
  return {
    ...rest,
    parentId: group.id,
    position: { x: absolute.x - group.position.x, y: absolute.y - group.position.y },
    data: { ...data, pipeline: group.data.label } as OTelNodeData,
  };
}

/**
 * The nodes of a group resized to `width` × `height`, with its children
 * outside the new bounds taken out of it.
 * `detached` says whether any was.
 */
export function detachOutside(
  nodes: readonly OTelNode[],
  groupId: string,
  width: number,
  height: number,
): { nodes: OTelNode[]; detached: boolean } {
  const group = nodes.find((n) => n.id === groupId);
  if (!group) return { nodes: [...nodes], detached: false };
  let detached = false;
  const next = nodes.map((node) => {
    if (node.parentId !== groupId || isGroup(node)) return node;
    const { x, y } = node.position;
    if (x >= 0 && x <= width && y >= 0 && y <= height) return node;
    detached = true;
    return reparented(node, undefined, nodes);
  });
  return { nodes: next, detached };
}

/**
 * The node a palette entry dropped at `position` (absolute) makes: in the
 * group under it (relative to it), with "Label (n)" naming when
 * its type is already on the canvas (either spelling of it: the palette's
 * subtype is the same), and its own copy of the entry's default config
 * (never the palette's object). `spelledAs` is the type the text
 * writes it with (D13b decision 5: the store's `spelledType` for the pin;
 * the palette's own spelling by default): carried in `data.key` only, the
 * node's `componentSubType` staying the palette's, so its label, icon and
 * form are the entry's. Its `sharedConfigId` is the parser's for that key.
 */
export function droppedNode(
  entry: PaletteComponent,
  position: Point,
  nodes: readonly OTelNode[],
  spelledAs: string = entry.subType,
): OTelNode {
  const group = groupAt(nodes, position);
  const sameType = nodes.some(
    (n) => !isGroup(n) && n.data.componentType === entry.type && n.data.componentSubType === entry.subType,
  );
  // The first of its type has no instance name; the next ones are numbered as a duplicate is.
  const instanceName = sameType ? getNextInstanceName(nodes, entry.type, entry.subType) : undefined;
  const data: OTelNodeData = {
    label: instanceName === undefined ? entry.label : buildInstanceLabel(entry.label, instanceName),
    componentType: entry.type,
    componentSubType: entry.subType,
    config: paletteDefaultConfig(entry),
  };
  if (instanceName !== undefined) data.instanceName = instanceName;
  if (entry.connectorSignals) data.connectorSignals = { ...entry.connectorSignals };
  data.key = `${SECTION_OF_TYPE[entry.type]}.${buildYamlName(spelledAs, instanceName)}`;
  // As the parser sets it for the text's key: the stored graph reads the
  // text's spelling back from it, so a renamed type keeps its place (Ruling 60).
  data.sharedConfigId = sharedConfigIdOf(data);
  if (group) data.pipeline = group.data.label;
  return {
    id: nextNodeId(nodes.map((n) => n.id)),
    type: entry.type,
    position: group ? { x: position.x - group.position.x, y: position.y - group.position.y } : { ...position },
    ...(group ? { parentId: group.id } : {}),
    data,
  };
}

/** Why a connection is refused: nothing to say, or a connector signal warning. */
export type ConnectionRefusal = { warning?: { title: string; description: string } };

/**
 * The connection rules: undefined when
 * `source` may connect to `target`, else the refusal, with the warning a
 * signal-fixed connector gets when a pipeline carries another signal.
 */
export function connectionRefusal(
  source: OTelNode,
  target: OTelNode,
  nodes: readonly OTelNode[],
): ConnectionRefusal | undefined {
  if (isGroup(source) || isGroup(target)) return {};
  if (source.id === target.id) return {};
  // Routing and failover name their targets in config.
  if (isConfigTargetedConnectorNode(source)) return {};
  if (source.data.componentType === "exporter") return {};
  if (target.data.componentType === "receiver") return {};
  if (source.data.componentType === "extension" || target.data.componentType === "extension") return {};

  const signalOf = (node: OTelNode) =>
    node.parentId === undefined ? undefined : nodes.find((n) => n.id === node.parentId)?.data.signalType;

  if (target.data.componentType === "connector") {
    const inputSignal = target.data.connectorSignals?.inputSignal;
    const sourceSignal = signalOf(source);
    if (inputSignal && sourceSignal && sourceSignal !== inputSignal) {
      return {
        warning: {
          title: `${target.data.label} requires ${inputSignal} input`,
          description: `The source node is in a ${sourceSignal} pipeline`,
        },
      };
    }
  }
  if (source.data.componentType === "connector") {
    const outputSignal = source.data.connectorSignals?.outputSignal;
    const targetSignal = signalOf(target);
    if (outputSignal && targetSignal && targetSignal !== outputSignal) {
      return {
        warning: {
          title: `${source.data.label} outputs ${outputSignal}`,
          description: `The target node is in a ${targetSignal} pipeline`,
        },
      };
    }
  }
  return undefined;
}

const ADOPTED_PADDING = 50;
const ADOPTED_COLUMN_SPACING = 250;

/**
 * When one end of a connection is in a group and the other in none, the
 * ungrouped one joins the group, after its other children. Undefined when
 * neither or both are grouped.
 */
export function adoption(
  source: OTelNode,
  target: OTelNode,
  nodes: readonly OTelNode[],
): { node: OTelNode; group: OTelNode } | undefined {
  const [orphan, groupId] =
    source.parentId !== undefined && target.parentId === undefined
      ? [target, source.parentId]
      : source.parentId === undefined && target.parentId !== undefined
        ? [source, target.parentId]
        : [undefined, undefined];
  if (!orphan || groupId === undefined) return undefined;
  const group = nodes.find((n) => n.id === groupId);
  if (!group) return undefined;
  const column = nodes.filter((n) => n.parentId === group.id && !isGroup(n)).length;
  const { pipeline: _pipeline, ...data } = orphan.data;
  return {
    group,
    node: {
      ...orphan,
      parentId: group.id,
      position: { x: ADOPTED_PADDING + column * ADOPTED_COLUMN_SPACING, y: ADOPTED_PADDING + 20 },
      data: { ...data, pipeline: group.data.label } as OTelNodeData,
    },
  };
}

/**
 * The label a node gets for an instance name (its label
 * without a trailing " (…)", then " (name)"; the base alone for no name).
 */
export function instanceLabel(label: string, instanceName: string | undefined): string {
  const base = label.replace(/ \(.*\)$/, "");
  return instanceName ? buildInstanceLabel(base, instanceName) : base;
}

// ── The layout's signature ──────────────────────────────────────────────────

const signatures = new WeakMap<Graph, string>();

/**
 * What the layout is, for "dirty" (D9a decision 2): each node's position
 * (and a group's size), each pipeline's colour, rounded to whole pixels, by
 * what the text names (a group by its pipeline's name, a component by its
 * pipeline and key), so moving back is clean again and the ids a parse
 * gives don't count. Not selection, measurement or the viewport.
 */
export function layoutSignature(graph: Graph): string {
  const known = signatures.get(graph);
  if (known !== undefined) return known;
  const groups = new Map<string, string>();
  for (const node of graph.nodes) if (isGroup(node)) groups.set(node.id, node.data.label);
  const round = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : "-");
  const entries = graph.nodes.map((node) => {
    const at = `${round(node.position.x)},${round(node.position.y)}`;
    if (isGroup(node)) {
      return `g\u0000${node.data.label}\u0000${at}\u0000${round(node.style?.width)}x${round(node.style?.height)}`;
    }
    const pipeline = node.parentId === undefined ? "" : (groups.get(node.parentId) ?? node.parentId);
    return `c\u0000${pipeline}\u0000${componentKey(node.data) ?? ""}\u0000${at}`;
  });
  for (const pipeline of graph.pipelines) entries.push(`p\u0000${pipeline.name}\u0000${pipeline.color ?? ""}`);
  const signature = entries.sort().join("\u0001");
  signatures.set(graph, signature);
  return signature;
}
