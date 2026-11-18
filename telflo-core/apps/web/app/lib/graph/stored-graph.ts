import {
  GRAPH_COLUMN_MAXIMUM_BYTES,
  GRAPH_NODE_ID_PATTERN,
  graphColumnByteLength,
  GraphEdgesSchema,
  GraphNodesSchema,
  GraphPipelinesSchema,
  isStorableJsonValue,
} from "@telflo/contracts";
import type { GraphEdge, GraphNode, GraphPipeline } from "@telflo/contracts";

import { PIPELINE_GROUP_HEIGHT, PIPELINE_GROUP_WIDTH } from "./constants.js";
import { DEFAULT_GROUP_COLOR, SIGNAL_TYPE_COLORS } from "./node-builders.js";
import { buildYamlName, SECTION_OF_TYPE, splitComponentName } from "./node-operations.js";
import { extractSignalType, paletteSubType } from "./parse.js";
import type {
  ComponentType,
  ConnectorSignalMapping,
  Graph,
  OTelEdge,
  OTelNode,
  OTelNodeData,
  Pipeline,
  PipelineSignalType,
} from "./types.js";
import { COMPONENT_TYPES, PIPELINE_SIGNAL_TYPES } from "./types.js";

/*
 * The graph as the version's three columns store it (D9a decision 6):
 * the graph's shapes without React Flow's runtime fields (`measured`,
 * `selected`, `dragging`, `width`, `height`, `positionAbsolute`,
 * `resizing`) and without D9a's own node fields (`key`, `pipeline`,
 * `declared`, `enabled`), which the text gives back on every load.
 *
 * `toStored` is best effort (Preflight ruling 4): the graph never stops the
 * text from saving. A node whose config Postgres can't store (U+0000, a lone
 * surrogate, a non-finite number, nesting too deep) keeps `config: null`;
 * when `nodes` would be over its bound, every node's config is `null`; and a
 * column the contract's own schema still refuses is stored as `[]`, to be
 * laid out on the next open.
 *
 * `fromStored` reads back whatever it can (Preflight ruling 14): an item it
 * can't read is dropped, never an error.
 */

export interface StoredGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  pipelines: GraphPipeline[];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function storedNode(node: OTelNode, keepConfig: boolean): GraphNode {
  const { data } = node;
  const position = { x: node.position.x, y: node.position.y };
  if (node.type === "pipelineGroup" || data.componentType === "pipelineGroup") {
    return {
      id: node.id,
      type: "pipelineGroup",
      position,
      style: {
        width: finiteOr(node.style?.width, PIPELINE_GROUP_WIDTH),
        height: finiteOr(node.style?.height, PIPELINE_GROUP_HEIGHT),
      },
      data: {
        label: data.label,
        pipelineId: data.pipelineId ?? "",
        signalType: data.signalType ?? "traces",
        color: data.color ?? DEFAULT_GROUP_COLOR,
        componentType: "pipelineGroup",
        componentSubType: "pipelineGroup",
        config: {},
      },
    };
  }
  const config = data.config === undefined ? null : data.config;
  return {
    id: node.id,
    type: data.componentType,
    position,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    data: {
      label: data.label,
      componentType: data.componentType,
      componentSubType: data.componentSubType,
      ...(data.instanceName === undefined ? {} : { instanceName: data.instanceName }),
      config: keepConfig && isStorableJsonValue(config) ? config : null,
      ...(data.connectorSignals === undefined ? {} : { connectorSignals: { ...data.connectorSignals } }),
      ...(data.sharedConfigId === undefined ? {} : { sharedConfigId: data.sharedConfigId }),
    },
  };
}

function storedNodes(nodes: readonly OTelNode[]): GraphNode[] {
  // Every config kept is a JSON value within the contract's depth, so the
  // column prints.
  let stored = nodes.map((node) => storedNode(node, true));
  // A component shared by three pipelines is stored three times: when the
  // copies are too many to keep, the layout is still worth keeping.
  if (graphColumnByteLength(stored) > GRAPH_COLUMN_MAXIMUM_BYTES) stored = nodes.map((node) => storedNode(node, false));
  return GraphNodesSchema.safeParse(stored).success ? stored : [];
}

function storedEdges(edges: readonly OTelEdge[]): GraphEdge[] {
  const stored: GraphEdge[] = edges
    // The contract's edges join components. An edge to or from a pipeline's
    // group (a connector with nothing else to join) and the derived route
    // edges are left out: edges are never read back (decision 5); the text
    // gives them on every load.
    .filter((edge) => GRAPH_NODE_ID_PATTERN.test(edge.source) && GRAPH_NODE_ID_PATTERN.test(edge.target))
    .filter((edge) => edge.type === undefined || edge.type === "smoothstep")
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep" }));
  return GraphEdgesSchema.safeParse(stored).success ? stored : [];
}

function storedPipelines(pipelines: readonly Pipeline[]): GraphPipeline[] {
  const stored: GraphPipeline[] = pipelines.map((pipeline) => ({
    id: pipeline.id,
    name: pipeline.name,
    signalType: pipeline.signalType,
    color: pipeline.color ?? SIGNAL_TYPE_COLORS[pipeline.signalType],
  }));
  return GraphPipelinesSchema.safeParse(stored).success ? stored : [];
}

/** The three columns a save sends: what passes the contract, and `[]` for a column that can't. */
export function toStored(graph: Graph): StoredGraph {
  return {
    nodes: storedNodes(graph.nodes),
    edges: storedEdges(graph.edges),
    pipelines: storedPipelines(graph.pipelines),
  };
}

// ── Reading back ────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;

function isLoose(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function signalOf(value: unknown): PipelineSignalType | undefined {
  return PIPELINE_SIGNAL_TYPES.find((signal) => signal === value);
}

function componentTypeOf(value: unknown): ComponentType | undefined {
  return COMPONENT_TYPES.find((type) => type === value);
}

function positionOf(value: unknown): { x: number; y: number } | undefined {
  if (!isLoose(value)) return undefined;
  const { x, y } = value;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

function signalsOf(value: unknown): ConnectorSignalMapping | undefined {
  if (!isLoose(value)) return undefined;
  const inputSignal = signalOf(value.inputSignal);
  const outputSignal = signalOf(value.outputSignal);
  return inputSignal && outputSignal ? { inputSignal, outputSignal } : undefined;
}

/**
 * A stored component's name in the text: from its `sharedConfigId`
 * (`<kind>-<name>`, which keeps the text's spelling of the type) when that
 * names the same component, else its type and instance.
 */
function storedName(type: ComponentType, subType: string, instanceName: string | undefined, sharedConfigId?: string) {
  const prefix = `${type}-`;
  if (sharedConfigId?.startsWith(prefix)) {
    const name = sharedConfigId.slice(prefix.length);
    const parts = splitComponentName(name);
    if (paletteSubType(parts.type, type) === subType && parts.instanceName === instanceName) return name;
  }
  return buildYamlName(subType, instanceName);
}

function readNode(value: unknown): OTelNode | undefined {
  if (!isLoose(value) || !isLoose(value.data)) return undefined;
  const id = stringOf(value.id);
  const position = positionOf(value.position);
  const label = stringOf(value.data.label);
  if (id === undefined || position === undefined || label === undefined) return undefined;
  const data = value.data;

  if (value.type === "pipelineGroup") {
    const pipelineId = stringOf(data.pipelineId);
    if (pipelineId === undefined) return undefined;
    const style = isLoose(value.style) ? value.style : {};
    return {
      id,
      type: "pipelineGroup",
      position,
      style: {
        width: finiteOr(style.width, PIPELINE_GROUP_WIDTH),
        height: finiteOr(style.height, PIPELINE_GROUP_HEIGHT),
      },
      data: {
        label,
        pipelineId,
        signalType: signalOf(data.signalType) ?? extractSignalType(label),
        color: stringOf(data.color) ?? DEFAULT_GROUP_COLOR,
        componentType: "pipelineGroup",
        componentSubType: "pipelineGroup",
        config: {},
      },
    };
  }

  const type = componentTypeOf(value.type) ?? componentTypeOf(data.componentType);
  const subType = stringOf(data.componentSubType);
  if (type === undefined || subType === undefined) return undefined;
  const instanceName = stringOf(data.instanceName);
  const sharedConfigId = stringOf(data.sharedConfigId);
  const connectorSignals = signalsOf(data.connectorSignals);
  const parentId = stringOf(value.parentId);
  const nodeData: OTelNodeData = {
    label,
    componentType: type,
    componentSubType: subType,
    config: "config" in data ? data.config : null,
    key: `${SECTION_OF_TYPE[type]}.${storedName(type, subType, instanceName, sharedConfigId)}`,
  };
  if (instanceName !== undefined) nodeData.instanceName = instanceName;
  if (sharedConfigId !== undefined) nodeData.sharedConfigId = sharedConfigId;
  if (connectorSignals !== undefined) nodeData.connectorSignals = connectorSignals;
  return { id, type, position, ...(parentId === undefined ? {} : { parentId }), data: nodeData };
}

function readEdge(value: unknown): OTelEdge | undefined {
  if (!isLoose(value)) return undefined;
  const id = stringOf(value.id);
  const source = stringOf(value.source);
  const target = stringOf(value.target);
  if (id === undefined || source === undefined || target === undefined) return undefined;
  return { id, source, target, type: "smoothstep", data: {} };
}

function readPipeline(value: unknown): Pipeline | undefined {
  if (!isLoose(value)) return undefined;
  const id = stringOf(value.id);
  const name = stringOf(value.name);
  if (id === undefined || name === undefined) return undefined;
  const color = stringOf(value.color);
  return {
    id,
    name,
    signalType: signalOf(value.signalType) ?? extractSignalType(name),
    ...(color === undefined ? {} : { color }),
  };
}

function readAll<Item>(column: unknown, read: (value: unknown) => Item | undefined): Item[] {
  if (!Array.isArray(column)) return [];
  const items: Item[] = [];
  for (const value of column) {
    const item = read(value);
    if (item !== undefined) items.push(item);
  }
  return items;
}

/**
 * The stored graph, as far as it reads: the graph's shapes, with React
 * Flow's runtime fields or anything else unknown ignored, and items missing
 * what the layout needs dropped. Components get back their key (from their
 * `sharedConfigId` where it names them) and their pipeline's name, which
 * the layout is matched by (decision 5).
 */
export function fromStored(stored: { nodes: unknown; edges: unknown; pipelines: unknown }): Graph {
  const nodes = readAll(stored.nodes, readNode);
  const groupLabels = new Map(nodes.filter((n) => n.type === "pipelineGroup").map((n) => [n.id, n.data.label]));
  for (const node of nodes) {
    const pipeline = node.parentId === undefined ? undefined : groupLabels.get(node.parentId);
    if (pipeline !== undefined && node.type !== "pipelineGroup") node.data.pipeline = pipeline;
  }
  return {
    nodes,
    edges: readAll(stored.edges, readEdge),
    pipelines: readAll(stored.pipelines, readPipeline),
  };
}
