import { nextNodeId } from "./node-builders.js";
import type { ComponentType, OTelEdge, OTelNode, OTelNodeData } from "./types.js";

/*
 * The graph's node operations, with component keys: a node records
 * the key the text gives its component (`receivers.otlp/2`), and a copy
 * records its own.
 */

const INSTANCE_SUFFIX = / \(\d+\)$/;
const GROUP_CHILD_X_OFFSET = 50;
const GROUP_CHILD_X_STRIDE = 230;
const GROUP_CHILD_Y = 50;
const DUPLICATE_POSITION_OFFSET = 50;

/** Each kind's section in the text. */
export const SECTION_OF_TYPE: Readonly<Record<ComponentType, string>> = {
  receiver: "receivers",
  processor: "processors",
  exporter: "exporters",
  extension: "extensions",
  connector: "connectors",
};

export function generateUniqueNodeId(existingIds: Iterable<string>): string {
  return nextNodeId(existingIds);
}

/**
 * A component's name split as the collector splits it, at the first `/`:
 * `otlp/a/b` is the type `otlp` with the name `a/b`.
 */
export function splitComponentName(name: string): { type: string; instanceName?: string } {
  const slash = name.indexOf("/");
  if (slash === -1) return { type: name };
  return { type: name.slice(0, slash), instanceName: name.slice(slash + 1) };
}

/** The name in a key: `otlp/2` in `receivers.otlp/2`. */
export function nameOfKey(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(dot + 1);
}

/**
 * A component node's name in the text: its type as the text spells it (from
 * its key; the palette's spelling for a node the text doesn't have yet),
 * then `/` and its instance name.
 */
export function componentName(data: Pick<OTelNodeData, "componentSubType" | "instanceName" | "key">): string {
  if (data.key !== undefined) {
    const keyName = nameOfKey(data.key);
    const { type, instanceName } = splitComponentName(keyName);
    if (instanceName === data.instanceName) return keyName;
    return buildYamlName(type, data.instanceName);
  }
  return buildYamlName(data.componentSubType, data.instanceName);
}

/** A component node's key: `receivers.otlp/2`. Undefined for a group. */
export function componentKey(
  data: Pick<OTelNodeData, "componentType" | "componentSubType" | "instanceName" | "key">,
): string | undefined {
  if (data.componentType === "pipelineGroup") return undefined;
  return `${SECTION_OF_TYPE[data.componentType]}.${componentName(data)}`;
}

export function getNextInstanceName(
  nodes: readonly OTelNode[],
  componentType: OTelNodeData["componentType"],
  componentSubType: OTelNodeData["componentSubType"],
): string {
  const siblings = nodes.filter(
    (n) => n.data.componentType === componentType && n.data.componentSubType === componentSubType,
  );
  const numbers = siblings.map((n) => {
    const name = n.data.instanceName;
    if (!name) return 1;
    const num = parseInt(name, 10);
    return isNaN(num) ? 0 : num;
  });
  return String(Math.max(...numbers, 1) + 1);
}

export function buildInstanceLabel(baseLabel: string, instanceName: string): string {
  return `${baseLabel.replace(INSTANCE_SUFFIX, "")} (${instanceName})`;
}

export function buildYamlName(componentSubType: string, instanceName?: string): string {
  return instanceName ? `${componentSubType}/${instanceName}` : componentSubType;
}

/**
 * The id the nodes of one component share (`processor-batch/2`): its kind
 * and its name in the text's spelling (`exporter-otlp_grpc`), so the parser,
 * Link to Instance and a rename agree, and the "N pipelines" line counts a
 * link at once. The only place it is made.
 */
export function sharedConfigIdOf(
  data: Pick<OTelNodeData, "componentType" | "componentSubType" | "instanceName" | "key">,
): string {
  return `${data.componentType}-${componentName(data)}`;
}

function cloneConfig(config: OTelNodeData["config"]): OTelNodeData["config"] {
  return config == null ? config : structuredClone(config);
}

function positionInsideGroup(childIndex: number): { x: number; y: number } {
  return {
    x: GROUP_CHILD_X_OFFSET + childIndex * GROUP_CHILD_X_STRIDE,
    y: GROUP_CHILD_Y,
  };
}

function countChildrenInGroup(nodes: readonly OTelNode[], groupId: string): number {
  return nodes.filter((n) => n.parentId === groupId && n.type !== "pipelineGroup").length;
}

function pipelineNameOfGroup(nodes: readonly OTelNode[], groupId: string | undefined): string | undefined {
  if (groupId === undefined) return undefined;
  return nodes.find((n) => n.id === groupId)?.data.label;
}

/**
 * A copy's data: the original's, renamed to `instanceName`, with its own
 * config, key and pipeline, not linked to the original, and declared (it is
 * a new component).
 */
function copyData(
  original: OTelNodeData,
  instanceName: string,
  pipeline: string | undefined,
): OTelNodeData {
  const { sharedConfigId: _shared, declared: _declared, pipeline: _pipeline, key: _key, ...rest } = original;
  const data: OTelNodeData = {
    ...rest,
    label: buildInstanceLabel(original.label, instanceName),
    instanceName,
    config: cloneConfig(original.config),
  };
  // The copy's key keeps the original's spelling of its type, and its
  // sharedConfigId is the parser's for that key: the stored graph reads the
  // spelling back from it, so the copy keeps its place.
  const key = componentKey({ ...data, ...(original.key === undefined ? {} : { key: original.key }) });
  if (key !== undefined) {
    data.key = key;
    data.sharedConfigId = sharedConfigIdOf(data);
  }
  if (pipeline !== undefined) data.pipeline = pipeline;
  return data;
}

export function buildDuplicateNodes(originals: readonly OTelNode[], existingNodes: readonly OTelNode[]): OTelNode[] {
  const newNodes: OTelNode[] = [];

  for (const original of originals) {
    const pool = [...existingNodes, ...newNodes];
    const newId = generateUniqueNodeId(pool.map((n) => n.id));
    const instanceName = getNextInstanceName(pool, original.data.componentType, original.data.componentSubType);

    newNodes.push({
      id: newId,
      ...(original.type === undefined ? {} : { type: original.type }),
      position: {
        x: original.position.x + DUPLICATE_POSITION_OFFSET,
        y: original.position.y + DUPLICATE_POSITION_OFFSET,
      },
      ...(original.parentId === undefined ? {} : { parentId: original.parentId }),
      data: copyData(original.data, instanceName, original.data.pipeline),
    });
  }

  return newNodes;
}

export function buildDuplicateNode(original: OTelNode, allNodes: readonly OTelNode[], groupId?: string): OTelNode {
  const newId = generateUniqueNodeId(allNodes.map((n) => n.id));
  const instanceName = getNextInstanceName(allNodes, original.data.componentType, original.data.componentSubType);
  const position = groupId
    ? positionInsideGroup(countChildrenInGroup(allNodes, groupId))
    : {
        x: original.position.x + DUPLICATE_POSITION_OFFSET,
        y: original.position.y + DUPLICATE_POSITION_OFFSET,
      };

  return {
    id: newId,
    ...(original.type === undefined ? {} : { type: original.type }),
    position,
    ...(groupId === undefined ? {} : { parentId: groupId }),
    data: copyData(original.data, instanceName, pipelineNameOfGroup(allNodes, groupId)),
  };
}

export interface LinkNodeResult {
  linkedNode: OTelNode;
  updatedNodes: OTelNode[];
}

/**
 * The component linked into another pipeline: a node of the same component
 * (the same key, so one entry in the text) in `groupId`, sharing the
 * source's `sharedConfigId`, which the source's other nodes then carry too.
 */
export function buildLinkedNode(sourceNode: OTelNode, groupId: string, allNodes: readonly OTelNode[]): LinkNodeResult {
  const sharedConfigId = sourceNode.data.sharedConfigId ?? sharedConfigIdOf(sourceNode.data);
  const sourceKey = componentKey(sourceNode.data);
  const pipeline = pipelineNameOfGroup(allNodes, groupId);
  const { pipeline: _pipeline, ...sourceData } = sourceNode.data;

  const linkedNode: OTelNode = {
    id: generateUniqueNodeId(allNodes.map((n) => n.id)),
    ...(sourceNode.type === undefined ? {} : { type: sourceNode.type }),
    position: positionInsideGroup(countChildrenInGroup(allNodes, groupId)),
    parentId: groupId,
    data: {
      ...sourceData,
      config: cloneConfig(sourceNode.data.config),
      sharedConfigId,
      ...(pipeline === undefined ? {} : { pipeline }),
    },
  };

  const updatedNodes = allNodes.map((node) => {
    if (node.type === "pipelineGroup") return node;
    if (componentKey(node.data) === sourceKey && node.data.sharedConfigId !== sharedConfigId) {
      return { ...node, data: { ...node.data, sharedConfigId } };
    }
    return node;
  });

  return { linkedNode, updatedNodes };
}

// Remove a group node's children, plus the group node itself, and prune any
// edges that reference those children, or the group (a connector's place
// in a pipeline with nothing else to join is an edge to its group).
// Used for cascade-deleting a pipeline.
export function pruneGroupChildren(
  nodes: readonly OTelNode[],
  edges: readonly OTelEdge[],
  groupId: string,
): { nodes: OTelNode[]; edges: OTelEdge[] } {
  const removedIds = new Set([groupId, ...nodes.filter((n) => n.parentId === groupId).map((n) => n.id)]);

  const updatedNodes = nodes.filter((n) => !removedIds.has(n.id));
  const updatedEdges = edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target));

  return { nodes: updatedNodes, edges: updatedEdges };
}

/**
 * Edges once `processorIds`, deleted, leave their pipelines' chains: each
 * processor in a group is spliced out, every edge into it (from a
 * receiver, connector, processor or the group) joined to each node it fed,
 * so the processors after it stay reachable and only it leaves
 * `processors`. Several are spliced one after another, so a run of
 * adjacent ones closes over all of them. An end outside the group (a
 * connector) is joined through the group only when nothing in the group is
 * on the other side, as `parse` draws a connector's edge to its group only
 * when the pipeline has nothing else to feed it or be fed by: a connector
 * that fed the processor joins the group when it fed only nodes outside
 * it, the group joins a connector it fed when only nodes outside it fed
 * the processor. The processors' own edges go.
 */
export function closedChains(
  nodes: readonly OTelNode[],
  edges: readonly OTelEdge[],
  processorIds: ReadonlySet<string>,
): OTelEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // The edges in order (a Set keeps it: removed ones go, joined ones are added
  // last), indexed by their ends once, so a splice doesn't scan every edge.
  const result = new Set(edges);
  const bySource = new Map<string, Set<OTelEdge>>();
  const byTarget = new Map<string, Set<OTelEdge>>();
  const pairs = new Map<string, number>();
  const pairKey = (source: string, target: string) => `${source}\u0000${target}`;
  const index = (edge: OTelEdge) => {
    for (const [map, end] of [[bySource, edge.source], [byTarget, edge.target]] as const) {
      const set = map.get(end);
      if (set) set.add(edge);
      else map.set(end, new Set([edge]));
    }
    const key = pairKey(edge.source, edge.target);
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  };
  const unindex = (edge: OTelEdge) => {
    result.delete(edge);
    bySource.get(edge.source)?.delete(edge);
    byTarget.get(edge.target)?.delete(edge);
    const key = pairKey(edge.source, edge.target);
    const count = (pairs.get(key) ?? 0) - 1;
    if (count > 0) pairs.set(key, count);
    else pairs.delete(key);
  };
  for (const edge of edges) index(edge);
  // A running counter for the joined edges' ids (`edge_<n>`): never one an edge has, nor one given here.
  const ids = new Set(edges.map((edge) => edge.id));
  let nextId = 0;
  const newEdgeId = () => {
    while (ids.has(`edge_${nextId}`)) nextId++;
    const id = `edge_${nextId++}`;
    ids.add(id);
    return id;
  };
  for (const id of processorIds) {
    const processor = byId.get(id);
    const groupId = processor?.parentId;
    if (processor?.data.componentType !== "processor" || groupId === undefined || processorIds.has(groupId)) continue;
    const into = [...(byTarget.get(id) ?? [])].filter((edge) => edge.source !== id);
    const from = [...(bySource.get(id) ?? [])].filter((edge) => edge.target !== id);
    for (const edge of [...into, ...from]) unindex(edge);
    const inGroup = (nodeId: string) => byId.get(nodeId)?.parentId === groupId;
    const join = (incoming: OTelEdge | undefined, outgoing: OTelEdge | undefined, source: string, target: string) => {
      if (source === target || pairs.has(pairKey(source, target))) return;
      const edge: OTelEdge = {
        id: newEdgeId(),
        source,
        target,
        type: "smoothstep",
        data: {},
        ...(typeof incoming?.sourceHandle === "string" ? { sourceHandle: incoming.sourceHandle } : {}),
        ...(typeof outgoing?.targetHandle === "string" ? { targetHandle: outgoing.targetHandle } : {}),
      };
      result.add(edge);
      index(edge);
    };
    for (const incoming of into) {
      for (const outgoing of from) {
        if (inGroup(incoming.source) || inGroup(outgoing.target)) join(incoming, outgoing, incoming.source, outgoing.target);
      }
    }
    if (!from.some((edge) => inGroup(edge.target))) {
      for (const incoming of into) if (!inGroup(incoming.source)) join(incoming, undefined, incoming.source, groupId);
    }
    if (!into.some((edge) => inGroup(edge.source))) {
      for (const outgoing of from) if (!inGroup(outgoing.target)) join(undefined, outgoing, groupId, outgoing.target);
    }
  }
  return [...result];
}
