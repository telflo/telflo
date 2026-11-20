import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";
import type { Document, Node as YamlNode, ParsedNode } from "yaml";

import { RENAMED_TYPES } from "../collector/renamed-types.js";

import { findPaletteEntry } from "./palette.js";
import {
  createDefaultGroupNodes,
  getDefaultPipelines,
  groupIdForPipeline,
  SIGNAL_TYPE_COLORS,
} from "./node-builders.js";
import { SECTION_OF_TYPE, sharedConfigIdOf, splitComponentName } from "./node-operations.js";
import { PIPELINE_GROUP_HEIGHT, PIPELINE_GROUP_WIDTH } from "./constants.js";
import { layoutPipelineGraph } from "./pipeline-layout.js";
import { isConfigTargetedConnectorName, pushConfigTargetsRight } from "./routing-connector.js";
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

/*
 * The graph from the text, on the `yaml` package's YAML 1.2 core schema:
 * - a text the canvas can't show is refused with a reason, never shown as
 *   empty default pipelines;
 * - a connector in a pipeline with no processors keeps its place there: when
 *   the pipeline has nothing else on that side to join, its edge ends at the
 *   pipeline's group;
 * - `service.extensions` is read: a declared extension it doesn't list is
 *   disabled, and one it lists that isn't declared is a node, still listed;
 * - a component a pipeline names but nobody declares is a node marked
 *   `declared: false`, with no config, so writing the text never declares
 *   it;
 * - renamed types (`otlp_grpc`) take their palette entry's label, icon and
 *   help, and the node's key keeps the text's spelling (the renames are the
 *   catalog's, by kind);
 * - every id is opaque: `node_<n>`, `group_<n>`, `pipeline_<n>`,
 *   `edge_<n>`, never a name.
 *
 * Pure: no store, no clock.
 */

/**
 * The options every reading of a configuration's text uses: YAML 1.2's core
 * schema, merge keys honored, duplicate keys refused (the collector refuses
 * them too), errors without a code frame (the reason is built from the
 * error's own fields), and the source tokens kept for the text edits.
 */
export const PARSE_OPTIONS = {
  merge: true,
  prettyErrors: false,
  uniqueKeys: true,
  keepSourceTokens: true,
} as const;

/** How many aliases one text may resolve before it is refused as an alias bomb (`yaml`'s default). */
const MAXIMUM_ALIAS_COUNT = 100;

export type ParsedText = Document.Parsed<ParsedNode, true>;

export type ParseResult = { ok: true; graph: Graph; document: ParsedText } | { ok: false; reason: string };

// Connector signal mappings - defines what signals each connector type consumes
// and produces. Only signal-FIXED connectors belong here; routing and forward
// are deliberately absent because they are signal-agnostic (same-signal in/out
// for whichever signal they are wired between).
const CONNECTOR_SIGNALS: Readonly<Record<string, ConnectorSignalMapping>> = {
  spanmetrics: { inputSignal: "traces", outputSignal: "metrics" },
  count: { inputSignal: "traces", outputSignal: "metrics" },
};

/**
 * The palette's spelling of a type the text spells `type`, for a component
 * of `kind`: the deprecated name when the collector renamed that kind's
 * `type` (`RENAMED_TYPES`, read from the catalog), else `type` itself.
 * Renames are kind-specific, so another kind keeps its spelling (an
 * `otlp_grpc` receiver has no palette entry).
 */
export function paletteSubType(type: string, kind: ComponentType): string {
  const renames = RENAMED_TYPES[kind];
  return Object.hasOwn(renames, type) ? renames[type]! : type;
}

// Placeholder spacing between groups before the layout runs; the layout
// keeps their top-to-bottom order.
const START_Y = 100;
const GROUP_SPACING = 300;

// Valid signal types for pipelines
const VALID_SIGNAL_TYPES: readonly PipelineSignalType[] = ["traces", "metrics", "logs"];

/**
 * Extracts and validates the signal type from a pipeline name.
 * Pipeline names can be "traces", "metrics", "logs" or "traces/production", etc.
 * Returns a valid signal type, defaulting to "traces" for invalid inputs.
 */
export function extractSignalType(pipelineName: string): PipelineSignalType {
  const prefix = pipelineName.split("/")[0]?.toLowerCase();
  return VALID_SIGNAL_TYPES.find((signal) => signal === prefix) ?? "traces";
}

/** The sections a component is declared in, in their conventional order. */
export const COMPONENT_SECTIONS = ["receivers", "processors", "exporters", "connectors", "extensions"] as const;

type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A section's components: `{}` for an absent or empty (`receivers:`) section. */
export function componentsOf(value: unknown): PlainObject {
  return isPlainObject(value) ? value : {};
}

/** A list of names: `[]` for an absent or empty (`receivers:`) list. */
export function namesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function hasOwn(object: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// ── Refusals ───────────────────────────────────────────────────────────────

class Refusal extends Error {}

function where(lineCounter: LineCounter, offset: number | undefined): string {
  if (offset === undefined) return "";
  const { line, col } = lineCounter.linePos(offset);
  return `Line ${line}, column ${col}: `;
}

function nodeOffset(node: unknown): number | undefined {
  if (node && typeof node === "object" && "range" in node) {
    const range = (node as { range?: [number, number, number] | null }).range;
    return range?.[0];
  }
  return undefined;
}

/** A syntax error's reason: its message and code, where it is. */
function syntaxReason(document: Document, lineCounter: LineCounter): string | undefined {
  const error = document.errors[0];
  if (!error) return undefined;
  if (error.code === "MULTIPLE_DOCS") {
    return `${where(lineCounter, error.pos[0])}The text holds more than one YAML document; a configuration is one.`;
  }
  return `${where(lineCounter, error.pos[0])}${error.message} (${error.code})`;
}

/** Why `toJS` refused the document: the alias or merge key at fault, where it is. */
function resolutionReason(document: Document, lineCounter: LineCounter, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Excessive alias count")) {
    return `The text resolves too many aliases (Excessive alias count), as an alias bomb does.`;
  }
  let reason: string | undefined;
  visit(document, {
    Alias(_key, alias) {
      if (alias.resolve(document) === undefined) {
        reason = `${where(lineCounter, nodeOffset(alias))}The alias *${alias.source} names no anchor set before it.`;
        return visit.BREAK;
      }
      return undefined;
    },
    Pair(_key, pair) {
      // With merge keys on, a plain `<<` key's value is the merge symbol.
      if (!isScalar(pair.key) || typeof pair.key.value !== "symbol") return undefined;
      const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
      const mergeable = sources.every((source) => {
        const resolved = isAlias(source) ? source.resolve(document) : source;
        return isMap(resolved);
      });
      if (!mergeable) {
        reason = `${where(lineCounter, nodeOffset(pair.value ?? pair.key))}A merge key (<<) must name a mapping, or a list of them.`;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return reason ?? `The YAML can't be read: ${message}`;
}

/** Whether `value` contains itself (an alias inside its own anchor). */
function hasCycle(value: unknown): boolean {
  const onPath = new Set<object>();
  const done = new Set<object>();
  const stack: Array<{ value: object; entered: boolean }> = [];
  if (typeof value === "object" && value !== null) stack.push({ value, entered: false });
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.entered) {
      onPath.delete(frame.value);
      done.add(frame.value);
      continue;
    }
    if (done.has(frame.value)) continue;
    if (onPath.has(frame.value)) return true;
    onPath.add(frame.value);
    stack.push({ value: frame.value, entered: true });
    for (const child of Object.values(frame.value)) {
      if (typeof child !== "object" || child === null) continue;
      if (onPath.has(child)) return true;
      if (!done.has(child)) stack.push({ value: child, entered: false });
    }
  }
  return false;
}

/**
 * The shapes the canvas needs: each section a mapping (or empty), each
 * pipeline a mapping of lists of names, `service.extensions` a list of
 * names. Positions come from the document where the value is written
 * directly; through an alias or a merge the reason has none.
 */
function checkShapes(config: PlainObject, document: Document, lineCounter: LineCounter): void {
  const at = (path: readonly string[]): string => where(lineCounter, nodeOffset(document.getIn(path, true)));
  const isEmpty = (value: unknown) => value === undefined || value === null;

  for (const section of [...COMPONENT_SECTIONS, "service"] as const) {
    const value = config[section];
    if (!isEmpty(value) && !isPlainObject(value)) {
      throw new Refusal(`${at([section])}${section} must be a mapping.`);
    }
  }
  const service = componentsOf(config.service);
  if (!isEmpty(service.pipelines) && !isPlainObject(service.pipelines)) {
    throw new Refusal(`${at(["service", "pipelines"])}service.pipelines must be a mapping of pipelines.`);
  }
  const isNameList = (value: unknown) =>
    isEmpty(value) || (Array.isArray(value) && value.every((item) => typeof item === "string"));
  if (!isNameList(service.extensions)) {
    throw new Refusal(`${at(["service", "extensions"])}service.extensions must be a list of extension names.`);
  }
  for (const [name, pipeline] of Object.entries(componentsOf(service.pipelines))) {
    if (isEmpty(pipeline)) continue;
    if (!isPlainObject(pipeline)) {
      throw new Refusal(`${at(["service", "pipelines", name])}A pipeline must be a mapping of receivers, processors and exporters.`);
    }
    for (const list of ["receivers", "processors", "exporters"] as const) {
      if (!isNameList(pipeline[list])) {
        throw new Refusal(`${at(["service", "pipelines", name, list])}A pipeline's ${list} must be a list of component names.`);
      }
    }
  }
}

/**
 * Reads the text into a document and its value, or says why the canvas
 * can't show it. Shared by `parse` and the model (model.ts), so both read
 * the same text the same way.
 */
export function readText(
  text: string,
): { ok: true; document: ParsedText; config: PlainObject } | { ok: false; reason: string } {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  const syntax = syntaxReason(document, lineCounter);
  if (syntax !== undefined) return { ok: false, reason: syntax };

  const contents: YamlNode | null = document.contents;
  if (contents !== null && !isMap(contents)) {
    return {
      ok: false,
      reason: `${where(lineCounter, nodeOffset(contents))}The top level must be a mapping of sections, such as receivers: and service:.`,
    };
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAXIMUM_ALIAS_COUNT });
  } catch (error) {
    return { ok: false, reason: resolutionReason(document, lineCounter, error) };
  }
  if (hasCycle(value)) {
    return { ok: false, reason: "An alias is used inside its own anchor, so the value never ends." };
  }
  const config = componentsOf(value);
  try {
    checkShapes(config, document, lineCounter);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
  return { ok: true, document, config };
}

// ── The graph ──────────────────────────────────────────────────────────────

/** The label a component's name gets: its palette entry's (or its type, uppercased), then its instance. */
export function labelFor(name: string, type: ComponentType): { label: string; subType: string; instanceName?: string } {
  const { type: spelled, instanceName } = splitComponentName(name);
  const subType = paletteSubType(spelled, type);
  const base = findPaletteEntry(type, subType)?.label ?? subType.toUpperCase();
  const label = instanceName === undefined ? base : `${base} (${instanceName})`;
  return instanceName === undefined ? { label, subType } : { label, subType, instanceName };
}

/** Builds the graph a configuration's value describes. */
export function buildGraph(config: PlainObject): Graph {
  const receiverConfigs = componentsOf(config.receivers);
  const processorConfigs = componentsOf(config.processors);
  const exporterConfigs = componentsOf(config.exporters);
  const connectorConfigs = componentsOf(config.connectors);
  const extensionConfigs = componentsOf(config.extensions);
  const configsOf: Record<ComponentType, PlainObject> = {
    receiver: receiverConfigs,
    processor: processorConfigs,
    exporter: exporterConfigs,
    connector: connectorConfigs,
    extension: extensionConfigs,
  };
  const service = componentsOf(config.service);
  const pipelineEntries = Object.entries(componentsOf(service.pipelines));

  const nodes: OTelNode[] = [];
  const edges: OTelEdge[] = [];
  const pipelines: Pipeline[] = [];

  let nodeCounter = 0;
  let edgeCounter = 0;
  const edgeKeys = new Set<string>();
  const createEdge = (source: string, target: string) => {
    const edgeKey = `${source}>${target}`;
    if (edgeKeys.has(edgeKey)) return;
    edgeKeys.add(edgeKey);
    edges.push({ id: `edge_${edgeCounter++}`, source, target, type: "smoothstep", data: {} });
  };

  const isConnector = (name: string) => hasOwn(connectorConfigs, name);

  const componentNode = (
    name: string,
    type: ComponentType,
    position: { x: number; y: number },
    pipeline?: { groupId: string; name: string },
  ): OTelNode => {
    const { label, subType, instanceName } = labelFor(name, type);
    const declared = hasOwn(configsOf[type], name);
    const data: OTelNodeData = {
      label,
      componentType: type,
      componentSubType: subType,
      config: declared ? configsOf[type][name] : null,
      key: `${SECTION_OF_TYPE[type]}.${name}`,
    };
    if (instanceName !== undefined) data.instanceName = instanceName;
    data.sharedConfigId = sharedConfigIdOf(data);
    if (pipeline) data.pipeline = pipeline.name;
    if (!declared) data.declared = false;
    const signals = type === "connector" ? CONNECTOR_SIGNALS[subType] : undefined;
    if (signals) data.connectorSignals = signals;
    return {
      id: `node_${nodeCounter++}`,
      type,
      position,
      ...(pipeline ? { parentId: pipeline.groupId } : {}),
      data,
    };
  };

  // Which receiver/processor/exporter names a pipeline references; the rest
  // are orphans, shown ungrouped.
  const referenced: Record<"receiver" | "processor" | "exporter", Set<string>> = {
    receiver: new Set(),
    processor: new Set(),
    exporter: new Set(),
  };

  // Step 1: pipelines, their groups and their children
  interface Membership {
    groupId: string;
    receivers: string[];
    processors: string[];
    exporters: string[];
    // The group's child node for each member: "receiver:otlp" → node id
    childIds: Map<string, string>;
  }
  const memberships: Membership[] = [];

  pipelineEntries.forEach(([pipelineName, rawPipeline], pipelineIndex) => {
    // Empty pipeline (`traces:` with no value) is still a pipeline, so the
    // person can build it.
    const pipeline = componentsOf(rawPipeline);
    const signalType = extractSignalType(pipelineName);
    const pipelineObj: Pipeline = {
      id: `pipeline_${pipelineIndex}`,
      name: pipelineName,
      signalType,
      color: SIGNAL_TYPE_COLORS[signalType],
    };
    pipelines.push(pipelineObj);
    const groupId = groupIdForPipeline(pipelineObj.id);

    nodes.push({
      id: groupId,
      type: "pipelineGroup",
      position: { x: 100, y: START_Y + pipelineIndex * GROUP_SPACING },
      data: {
        label: pipelineName,
        pipelineId: pipelineObj.id,
        signalType,
        color: pipelineObj.color ?? SIGNAL_TYPE_COLORS.traces,
        componentType: "pipelineGroup",
        componentSubType: "pipelineGroup",
        config: {},
      },
      style: { width: PIPELINE_GROUP_WIDTH, height: PIPELINE_GROUP_HEIGHT },
    });

    const membership: Membership = {
      groupId,
      receivers: namesOf(pipeline.receivers),
      processors: namesOf(pipeline.processors),
      exporters: namesOf(pipeline.exporters),
      childIds: new Map(),
    };
    memberships.push(membership);

    // Step 2: one child node per membership (connectors float outside)
    const addChild = (name: string, type: "receiver" | "processor" | "exporter") => {
      referenced[type].add(name);
      if (type !== "processor" && isConnector(name)) return;
      const childKey = `${type}:${name}`;
      if (membership.childIds.has(childKey)) return;
      const node = componentNode(name, type, { x: 0, y: 0 }, { groupId, name: pipelineName });
      membership.childIds.set(childKey, node.id);
      nodes.push(node);
    };
    membership.receivers.forEach((name) => addChild(name, "receiver"));
    membership.processors.forEach((name) => addChild(name, "processor"));
    membership.exporters.forEach((name) => addChild(name, "exporter"));

    // Step 3: edges within the group: receivers → processor chain → exporters
    const child = (type: string, name: string | undefined) =>
      name === undefined ? undefined : membership.childIds.get(`${type}:${name}`);
    const firstProcessor = child("processor", membership.processors[0]);
    const lastProcessor = child("processor", membership.processors[membership.processors.length - 1]);
    const exporterIds = membership.exporters.filter((name) => !isConnector(name)).map((name) => child("exporter", name));

    membership.receivers.forEach((name) => {
      if (isConnector(name)) return; // Connector edges handled separately
      const sourceId = child("receiver", name);
      if (!sourceId) return;
      if (firstProcessor) {
        createEdge(sourceId, firstProcessor);
      } else {
        exporterIds.forEach((targetId) => targetId && createEdge(sourceId, targetId));
      }
    });
    for (let i = 0; i < membership.processors.length - 1; i++) {
      const sourceId = child("processor", membership.processors[i]);
      const targetId = child("processor", membership.processors[i + 1]);
      if (sourceId && targetId) createEdge(sourceId, targetId);
    }
    if (lastProcessor) {
      exporterIds.forEach((targetId) => targetId && createEdge(lastProcessor, targetId));
    }
  });

  // Step 4: connector nodes (ungrouped, float between groups), and their
  // edges into and out of each pipeline that uses them
  const connectorNodeIds = new Map<string, string>();
  Object.keys(connectorConfigs).forEach((name) => {
    const node = componentNode(name, "connector", { x: 0, y: 0 });
    connectorNodeIds.set(name, node.id);
    nodes.push(node);
  });
  memberships.forEach((membership) => {
    const child = (type: string, name: string | undefined) =>
      name === undefined ? undefined : membership.childIds.get(`${type}:${name}`);
    const firstProcessor = child("processor", membership.processors[0]);
    const lastProcessor = child("processor", membership.processors[membership.processors.length - 1]);
    const plainExporters = membership.exporters.filter((name) => !isConnector(name));
    const plainReceivers = membership.receivers.filter((name) => !isConnector(name));

    // Connectors acting as receivers in this pipeline
    membership.receivers.forEach((name) => {
      const connectorId = connectorNodeIds.get(name);
      // Routing and failover target pipelines via their config; the canvas
      // derives read-only route edges from it, so no edge is stored.
      if (!connectorId || isConfigTargetedConnectorName(name)) return;
      if (firstProcessor) {
        createEdge(connectorId, firstProcessor);
      } else if (plainExporters.length > 0) {
        plainExporters.forEach((exporter) => {
          const targetId = child("exporter", exporter);
          if (targetId) createEdge(connectorId, targetId);
        });
      } else {
        // Nothing else in the pipeline to feed: the edge ends at its group.
        createEdge(connectorId, membership.groupId);
      }
    });

    // Connectors acting as exporters in this pipeline
    membership.exporters.forEach((name) => {
      const connectorId = connectorNodeIds.get(name);
      if (!connectorId) return;
      if (lastProcessor) {
        createEdge(lastProcessor, connectorId);
      } else if (plainReceivers.length > 0) {
        plainReceivers.forEach((receiver) => {
          const sourceId = child("receiver", receiver);
          if (sourceId) createEdge(sourceId, connectorId);
        });
      } else {
        // Nothing else in the pipeline feeds it: the edge starts at its group.
        createEdge(membership.groupId, connectorId);
      }
    });
  });

  // Step 5: orphans, declared but in no pipeline, ungrouped
  (["receiver", "processor", "exporter"] as const).forEach((type) => {
    Object.keys(configsOf[type]).forEach((name) => {
      if (!referenced[type].has(name)) nodes.push(componentNode(name, type, { x: 0, y: 0 }));
    });
  });

  // Step 6: extensions (ungrouped, below the groups): the declared ones,
  // enabled when `service.extensions` lists them, then the listed ones
  // nobody declares
  const listedExtensions = namesOf(service.extensions);
  const listed = new Set(listedExtensions);
  Object.keys(extensionConfigs).forEach((name) => {
    const node = componentNode(name, "extension", { x: 0, y: 0 });
    node.data.enabled = listed.has(name);
    nodes.push(node);
  });
  const undeclaredShown = new Set<string>();
  listedExtensions.forEach((name) => {
    if (hasOwn(extensionConfigs, name) || undeclaredShown.has(name)) return;
    undeclaredShown.add(name);
    const node = componentNode(name, "extension", { x: 0, y: 0 });
    node.data.enabled = true;
    nodes.push(node);
  });

  // A text without pipelines shows the three default pipelines, empty.
  if (pipelines.length === 0) {
    pipelines.push(...getDefaultPipelines());
    nodes.unshift(...createDefaultGroupNodes());
  }

  // Lay the graph out as layered columns (the final pass), then
  // keep every routing/failover target to its connector's right.
  const laidOutNodes = pushConfigTargetsRight(layoutPipelineGraph(nodes, edges, pipelines), pipelines);

  return { nodes: laidOutNodes, edges, pipelines };
}

/**
 * The graph a configuration's text describes, and its document; or why the
 * canvas can't show it. Empty text is the three empty default pipelines.
 */
export function parse(text: string): ParseResult {
  const read = readText(text);
  if (!read.ok) return read;
  return { ok: true, graph: buildGraph(read.config), document: read.document };
}
