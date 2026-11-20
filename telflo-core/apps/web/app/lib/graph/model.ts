import type { Document } from "yaml";

import { groupIdForPipeline } from "./node-builders.js";
import { componentKey, componentName } from "./node-operations.js";
import { COMPONENT_SECTIONS, componentsOf, hasOwn, namesOf } from "./parse.js";
import { getConfigTargetNames, isConfigTargetedConnectorNode } from "./routing-connector.js";
import type { Graph, OTelNode } from "./types.js";

/*
 * The configuration a graph describes, and the one a text describes, in one
 * shape, so the text edits can write only their differences.
 *
 * `deriveModel` is the model half of a generator, without printing
 * anything: the rules for each pipeline's membership and for the order of
 * its processors.
 * `readTextModel` reads the same shape straight from the document.
 *
 * The round-trip invariant (corpus.test.ts): for a text with pipelines,
 * `deriveModel(parse(text).graph, readTextModel(document))` equals
 * `readTextModel(document)`.
 */

export interface PipelineLists {
  receivers: string[];
  processors: string[];
  exporters: string[];
}

export interface Model {
  /** Each declared component's value, by key (`receivers.otlp/2`). */
  components: Map<string, unknown>;
  /** Each pipeline's lists, by name. */
  pipelines: Map<string, PipelineLists>;
  /** `service.extensions`: the enabled extensions' names. */
  extensions: string[];
  /**
   * The keys a pipeline or `service.extensions` names that nobody declares:
   * shown, never declared by an edit.
   */
  undeclared: Set<string>;
}

// ── The text's own model ────────────────────────────────────────────────────

/** The model of a configuration's value (the document's `toJS()`). */
export function modelOfValue(value: unknown): Model {
  const config = componentsOf(value);
  const components = new Map<string, unknown>();
  for (const section of COMPONENT_SECTIONS) {
    for (const [name, component] of Object.entries(componentsOf(config[section]))) {
      components.set(`${section}.${name}`, component);
    }
  }

  const connectors = componentsOf(config.connectors);
  const undeclared = new Set<string>();
  const note = (section: string, name: string) => {
    if (!components.has(`${section}.${name}`)) undeclared.add(`${section}.${name}`);
  };
  // A name in a receivers or exporters list is a connector's when the
  // connectors section declares it, as the collector reads it.
  const sideSection = (side: "receivers" | "exporters", name: string) =>
    hasOwn(connectors, name) ? "connectors" : side;

  const service = componentsOf(config.service);
  const pipelines = new Map<string, PipelineLists>();
  for (const [name, rawPipeline] of Object.entries(componentsOf(service.pipelines))) {
    const pipeline = componentsOf(rawPipeline);
    const lists: PipelineLists = {
      receivers: namesOf(pipeline.receivers),
      processors: namesOf(pipeline.processors),
      exporters: namesOf(pipeline.exporters),
    };
    lists.receivers.forEach((member) => note(sideSection("receivers", member), member));
    lists.processors.forEach((member) => note("processors", member));
    lists.exporters.forEach((member) => note(sideSection("exporters", member), member));
    pipelines.set(name, lists);
  }

  const extensions = namesOf(service.extensions);
  extensions.forEach((name) => note("extensions", name));

  return { components, pipelines, extensions, undeclared };
}

/**
 * The model the text itself describes, read straight from its document (a
 * document `parse` accepted).
 */
export function readTextModel(document: Document): Model {
  return modelOfValue(document.toJS({ maxAliasCount: 100 }));
}

/**
 * `model`'s lists with renamed components (`receivers.otlp` to
 * `receivers.otlp/edge`) named where the text lists them, as the text edits
 * rename them: a pipeline's receivers or exporters (a connector's in both),
 * and `service.extensions`. As `deriveModel`'s `order`, it keeps a renamed
 * component in its place, not last.
 */
export function renamedModel(model: Model, renames: readonly { from: string; to: string }[]): Model {
  const renamedIn = (sections: readonly string[]) => {
    const names = new Map<string, string>();
    for (const { from, to } of renames) {
      const [fromSection, fromName] = splitAtDot(from);
      const [toSection, toName] = splitAtDot(to);
      if (fromSection === toSection && sections.includes(fromSection)) names.set(fromName, toName);
    }
    // The new name takes the old one's place, and the old stays just after it,
    // for the pipelines that keep it (one node of a shared component renamed).
    return (list: string[]) =>
      names.size === 0 ? list : list.flatMap((name) => (names.has(name) ? [names.get(name)!, name] : [name]));
  };
  const receivers = renamedIn(["receivers", "connectors"]);
  const exporters = renamedIn(["exporters", "connectors"]);
  const extensions = renamedIn(["extensions"]);
  return {
    ...model,
    pipelines: new Map(
      [...model.pipelines].map(([name, lists]) => [
        name,
        { receivers: receivers(lists.receivers), processors: lists.processors, exporters: exporters(lists.exporters) },
      ]),
    ),
    extensions: extensions(model.extensions),
  };
}

function splitAtDot(key: string): [string, string] {
  const dot = key.indexOf(".");
  return dot === -1 ? [key, ""] : [key.slice(0, dot), key.slice(dot + 1)];
}

// ── The graph's model ───────────────────────────────────────────────────────

/**
 * `items` in `reference`'s order, then those it doesn't hold in their own
 * order: a list the graph derives keeps the text's order, and what the
 * graph adds comes last.
 */
function inOrderOf(items: string[], reference: readonly string[] | undefined): string[] {
  if (!reference || reference.length === 0) return items;
  const rank = new Map<string, number>();
  reference.forEach((item, index) => {
    if (!rank.has(item)) rank.set(item, index);
  });
  const known = items.filter((item) => rank.has(item)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...known, ...items.filter((item) => !rank.has(item))];
}

function isComponent(node: OTelNode): boolean {
  return node.type !== "pipelineGroup" && node.data.componentType !== "pipelineGroup";
}

/**
 * The configuration the graph describes: the rules for membership and
 * processor order, and these:
 * - a component is keyed with the text's spelling of its type (its node's
 *   key), and its value is its config as it is (`null` stays `null`);
 * - a node marked `declared: false` is undeclared, never a component;
 * - `service.extensions` is the enabled extensions (a node with no
 *   `enabled` is enabled);
 * - a connector's edge to or from a pipeline's group makes it a member
 *   (a pipeline with nothing else to join it to);
 * - a pipeline with no receivers at all keeps the processor chain nothing
 *   feeds, as a routed pipeline does (dropped, the text's next edit would
 *   remove the person's processors);
 * - receivers, exporters and extensions keep `order`'s order where it
 *   has them (the text's own model, so an edit doesn't reorder a list).
 *
 * Routing and failover: with `order` (the text's model, as every change in
 * the store passes), such a connector is in a pipeline's receivers exactly
 * when `order` lists it there and it is still a node. An unrelated canvas
 * change leaves those receivers as the text has them, both ways: a pipeline
 * the config names without listing the connector, and one listing it
 * unnamed. Only the forms' target choices wire them (the store's
 * `setComponentValues`). A duplicated connector, and an added pipeline the
 * config already names, are not wired. Without `order`, the config's
 * targets (tests only). Either way, a pipeline with such a member, or with
 * no receivers, keeps the processor chain nothing feeds (parse stores no
 * edge from routing or failover into it).
 */
export function deriveModel(graph: Graph, order?: Model): Model {
  const { nodes, edges, pipelines } = graph;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const components = new Map<string, unknown>();
  const undeclaredCandidates = new Set<string>();
  const extensions: string[] = [];

  for (const node of nodes) {
    const key = isComponent(node) ? componentKey(node.data) : undefined;
    if (key === undefined) continue;
    if (node.data.declared === false) {
      undeclaredCandidates.add(key);
    } else {
      // When several nodes share a key (one per pipeline), the last wins.
      components.set(key, node.data.config ?? null);
    }
    if (node.data.componentType === "extension" && node.data.enabled !== false) {
      const name = componentName(node.data);
      if (!extensions.includes(name)) extensions.push(name);
    }
  }
  const undeclared = new Set([...undeclaredCandidates].filter((key) => !components.has(key)));

  const connectors = nodes.filter((node) => isComponent(node) && node.data.componentType === "connector");
  const derivedPipelines = new Map<string, PipelineLists>();

  for (const pipeline of pipelines) {
    const groupId = groupIdForPipeline(pipeline.id);
    const childNodes = nodes.filter((n) => n.parentId === groupId && isComponent(n));
    const childNodeIds = new Set(childNodes.map((n) => n.id));

    const receiverSet = new Set<string>(
      childNodes.filter((n) => n.data.componentType === "receiver").map((n) => componentName(n.data)),
    );
    const exporterSet = new Set<string>(
      childNodes.filter((n) => n.data.componentType === "exporter").map((n) => componentName(n.data)),
    );

    // Connectors connected to or from this pipeline's nodes, or its group.
    for (const edge of edges) {
      const sourceNode = byId.get(edge.source);
      const targetNode = byId.get(edge.target);
      if (!sourceNode || !targetNode) continue;

      // Connector acting as exporter: an edge from a child, or the group, to it.
      if (
        (childNodeIds.has(edge.source) || edge.source === groupId) &&
        targetNode.data.componentType === "connector"
      ) {
        exporterSet.add(componentName(targetNode.data));
      }

      // Connector acting as receiver: an edge from it to a child, or the
      // group. Routing and failover are excluded: their targets come from
      // config below, and a stale drawn edge must not resurrect a pipeline
      // the config no longer names.
      if (
        (childNodeIds.has(edge.target) || edge.target === groupId) &&
        sourceNode.data.componentType === "connector" &&
        !isConfigTargetedConnectorNode(sourceNode)
      ) {
        receiverSet.add(componentName(sourceNode.data));
      }
    }

    // Routing and failover: the text's own membership with `order`, the
    // config's targets without it.
    const listed = order?.pipelines.get(pipeline.name)?.receivers;
    let routedIn = false;
    for (const node of connectors) {
      if (!isConfigTargetedConnectorNode(node)) continue;
      const name = componentName(node.data);
      if (order ? (listed?.includes(name) ?? false) : getConfigTargetNames(node).has(pipeline.name)) {
        receiverSet.add(name);
        routedIn = true;
      }
    }

    // Order processors by walking edges within this group.
    const processorOutgoing = new Map<string, string>();
    const firstProcessors = new Set<string>();
    for (const edge of edges) {
      const sourceNode = byId.get(edge.source);
      const targetNode = byId.get(edge.target);
      if (!sourceNode || !targetNode) continue;
      if (
        sourceNode.data.componentType === "processor" &&
        targetNode.data.componentType === "processor" &&
        childNodeIds.has(edge.source) &&
        childNodeIds.has(edge.target)
      ) {
        processorOutgoing.set(edge.source, edge.target);
      }
      if (
        (sourceNode.data.componentType === "receiver" || sourceNode.data.componentType === "connector") &&
        targetNode.data.componentType === "processor" &&
        childNodeIds.has(edge.target)
      ) {
        firstProcessors.add(edge.target);
      }
    }

    // A pipeline a routing or failover connector feeds, or with no receivers
    // at all, has no entry edge into its processor chain: seed the walk with
    // the processors nothing feeds.
    if (routedIn || receiverSet.size === 0) {
      childNodes
        .filter((n) => n.data.componentType === "processor")
        .filter((n) => !edges.some((e) => e.target === n.id))
        .forEach((n) => firstProcessors.add(n.id));
    }

    const orderedProcessors: string[] = [];
    const visited = new Set<string>();
    for (const startId of firstProcessors) {
      let currentId: string | undefined = startId;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const node = byId.get(currentId);
        if (node) orderedProcessors.push(componentName(node.data));
        currentId = processorOutgoing.get(currentId);
      }
    }

    const reference = order?.pipelines.get(pipeline.name);
    derivedPipelines.set(pipeline.name, {
      receivers: inOrderOf([...receiverSet], reference?.receivers),
      processors: orderedProcessors,
      exporters: inOrderOf([...exporterSet], reference?.exporters),
    });
  }

  return {
    components,
    pipelines: derivedPipelines,
    extensions: inOrderOf(extensions, order?.extensions),
    undeclared,
  };
}
