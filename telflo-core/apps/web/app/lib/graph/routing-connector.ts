import type { Model, PipelineLists } from "./model.js";
import { groupIdForPipeline } from "./node-builders.js";
import type { OTelEdge, OTelNode, Pipeline } from "./types.js";

/**
 * Config-targeted connectors: routing and failover declare their target
 * pipelines in CONFIG (routing: table[].pipelines + default_pipelines;
 * failover: priority_levels[][]) rather than as canvas edges — the config
 * already names every target, so a manual arrow would be redundant data entry
 * that can drift out of sync. These helpers are the one place that reads
 * targets out of such a config; the model, the layout, and the canvas
 * (derived route edges) all share them. Forward/spanmetrics/count keep
 * ordinary drawn edges — their targets genuinely are edge-decided.
 *
 * The config is read defensively, since it is whatever the text holds (a
 * `table` that isn't a list is no targets), and finds a pipeline's group by
 * its opaque id.
 */

const CONFIG_TARGETED_CONNECTORS: ReadonlySet<string> = new Set(["routing", "failover"]);

/** The part of a routing connector's config the canvas reads. */
export interface RoutingConnectorConfig {
  table?: Array<{ pipelines?: string[]; [key: string]: unknown }>;
  default_pipelines?: string[];
  [key: string]: unknown;
}

/** The part of a failover connector's config the canvas reads. */
export interface FailoverConnectorConfig {
  priority_levels?: string[][];
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The strings in `value` if it is a list; nothing otherwise. */
function stringsIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isRoutingConnectorNode(node: OTelNode): boolean {
  return node.data.componentType === "connector" && node.data.componentSubType === "routing";
}

export function isFailoverConnectorNode(node: OTelNode): boolean {
  return node.data.componentType === "connector" && node.data.componentSubType === "failover";
}

/** A connector whose target pipelines live in its config, not on the canvas. */
export function isConfigTargetedConnectorNode(node: OTelNode): boolean {
  return node.data.componentType === "connector" && CONFIG_TARGETED_CONNECTORS.has(node.data.componentSubType);
}

/** Same test on a YAML component name ("failover", "routing/tenants", ...). */
export function isConfigTargetedConnectorName(name: string): boolean {
  return CONFIG_TARGETED_CONNECTORS.has(name.split("/")[0] ?? "");
}

// ── Routing ──────────────────────────────────────────────────────────────

export interface RoutingTargetSummary {
  /** Pipeline name as it appears in service.pipelines (e.g. "traces/out"). */
  name: string;
  /** How many table routes send telemetry to this pipeline. */
  routeCount: number;
  /** Whether the pipeline is also (or only) a default_pipelines fallback. */
  isDefault: boolean;
}

/** Distinct target pipelines of a routing config, with per-target route counts. */
export function summarizeRoutingTargets(config: unknown): RoutingTargetSummary[] {
  const byName = new Map<string, RoutingTargetSummary>();
  const touch = (rawName: string): RoutingTargetSummary | null => {
    const name = rawName.trim();
    if (!name) return null;
    let entry = byName.get(name);
    if (!entry) {
      entry = { name, routeCount: 0, isDefault: false };
      byName.set(name, entry);
    }
    return entry;
  };

  const record = isRecord(config) ? config : {};
  const table = Array.isArray(record.table) ? record.table : [];
  table.forEach((route) => {
    stringsIn(isRecord(route) ? route.pipelines : undefined).forEach((name) => {
      const entry = touch(name);
      if (entry) entry.routeCount += 1;
    });
  });
  stringsIn(record.default_pipelines).forEach((name) => {
    const entry = touch(name);
    if (entry) entry.isDefault = true;
  });

  return Array.from(byName.values());
}

/** Distinct pipeline names a routing config targets (routes + defaults). */
export function getRoutingTargetNames(config: unknown): Set<string> {
  return new Set(summarizeRoutingTargets(config).map((t) => t.name));
}

// ── Failover ─────────────────────────────────────────────────────────────

export interface FailoverTargetSummary {
  /** Pipeline name as it appears in service.pipelines (e.g. "traces/primary"). */
  name: string;
  /** 1-based priority levels the pipeline appears in (1 = tried first). */
  levels: number[];
}

/** Distinct target pipelines of a failover config, with their priority levels. */
export function summarizeFailoverTargets(config: unknown): FailoverTargetSummary[] {
  const byName = new Map<string, FailoverTargetSummary>();
  const levels = isRecord(config) && Array.isArray(config.priority_levels) ? config.priority_levels : [];
  levels.forEach((level: unknown, index: number) => {
    stringsIn(level).forEach((rawName) => {
      const name = rawName.trim();
      if (!name) return;
      let entry = byName.get(name);
      if (!entry) {
        entry = { name, levels: [] };
        byName.set(name, entry);
      }
      if (!entry.levels.includes(index + 1)) entry.levels.push(index + 1);
    });
  });
  return Array.from(byName.values());
}

/** Distinct pipeline names a failover config targets (all priority levels). */
export function getFailoverTargetNames(config: unknown): Set<string> {
  return new Set(summarizeFailoverTargets(config).map((t) => t.name));
}

// ── Shared ───────────────────────────────────────────────────────────────

/**
 * Distinct target pipeline names declared in a config-targeted connector's
 * config. Empty for every other node, so callers can apply it blindly.
 */
export function getConfigTargetNames(node: OTelNode): Set<string> {
  if (isRoutingConnectorNode(node)) {
    return getRoutingTargetNames(node.data.config);
  }
  if (isFailoverConnectorNode(node)) {
    return getFailoverTargetNames(node.data.config);
  }
  return new Set();
}

/**
 * The pipelines a config-targeted connector's config names, by its type
 * (`routing`, `failover`): the readers above. Nothing for any other type.
 */
export function targetNamesOf(subType: string, value: unknown): Set<string> {
  if (subType === "routing") return getRoutingTargetNames(value);
  if (subType === "failover") return getFailoverTargetNames(value);
  return new Set();
}

// ── Wiring the targets into receivers ────────────────────────────────────

export interface ConnectorWiring {
  /** `model` with the connector added to, or removed from, the pipelines below. */
  model: Model;
  /** Pipelines newly named that now list the connector in their receivers. */
  added: string[];
  /** Pipelines no longer named whose receivers no longer list it. */
  removed: string[];
  /** Pipelines no longer named that still list it: their only receiver. */
  kept: string[];
}

/**
 * The receivers a form's target choice wires. `before` and `after` are the
 * pipelines the connector's config named before the change and after it
 * (`targetNamesOf`):
 * - each pipeline in `after` but not `before` whose receivers lack the
 *   connector gets it, last;
 * - each in `before` but not `after` whose receivers list it loses it,
 *   unless it is that pipeline's only receiver: `receivers: []` is refused
 *   (core `service/pipelines/config.go:59-61`), while a receiver the
 *   connector doesn't name is accepted (core `graph.go:189-199`,
 *   `connector/traces_router.go:26-34`), so it is `kept`;
 * - a name with no pipeline, and every other pipeline, is left as it is;
 * - with nothing added or removed, `model` itself is returned.
 * The collector refuses a target whose receivers don't list the connector
 * (routing `router.go:208-211, 314-317`; failover `failover.go:77-84`).
 */
export function wireConnectorReceivers(
  model: Model,
  connector: string,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): ConnectorWiring {
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  const pipelines = new Map<string, PipelineLists>();
  for (const [name, lists] of model.pipelines) {
    const listed = lists.receivers.includes(connector);
    if (after.has(name) && !before.has(name) && !listed) {
      pipelines.set(name, { ...lists, receivers: [...lists.receivers, connector] });
      added.push(name);
    } else if (before.has(name) && !after.has(name) && listed) {
      const receivers = lists.receivers.filter((receiver) => receiver !== connector);
      if (receivers.length === 0) {
        pipelines.set(name, lists);
        kept.push(name);
      } else {
        pipelines.set(name, { ...lists, receivers });
        removed.push(name);
      }
    } else {
      pipelines.set(name, lists);
    }
  }
  // Nothing to wire: the same model, so a caller can tell.
  if (added.length === 0 && removed.length === 0) return { model, added, removed, kept };
  return { model: { ...model, pipelines }, added, removed, kept };
}

/**
 * The pipelines a routing or failover connector's pickers offer (from the
 * text): the sources are the
 * pipelines whose `exporters` list the connector in `textModel`; the options
 * are the canvas's `pipelines` that aren't sources, of a source's signal
 * when there are any (a connector's two sides carry one signal), in the
 * canvas's order.
 */
export function connectorPipelineOptions(textModel: Model, pipelines: readonly Pipeline[], connector: string): Pipeline[] {
  const sources = new Set(
    [...textModel.pipelines].filter(([, lists]) => lists.exporters.includes(connector)).map(([name]) => name),
  );
  const signals = new Set(pipelines.filter((p) => sources.has(p.name)).map((p) => p.signalType));
  return pipelines.filter((p) => !sources.has(p.name) && (signals.size === 0 || signals.has(p.signalType)));
}

/** Per-target chip text for the derived route edge. */
function describeConfigTargets(node: OTelNode): Array<{ name: string; label: string }> {
  if (isRoutingConnectorNode(node)) {
    return summarizeRoutingTargets(node.data.config).map((target) => ({
      name: target.name,
      label: [
        target.routeCount > 0 ? `${target.routeCount} route${target.routeCount > 1 ? "s" : ""}` : null,
        target.isDefault ? "default" : null,
      ]
        .filter(Boolean)
        .join(" + "),
    }));
  }
  if (isFailoverConnectorNode(node)) {
    return summarizeFailoverTargets(node.data.config).map((target) => ({
      name: target.name,
      label: `priority ${target.levels.join(", ")}`,
    }));
  }
  return [];
}

// NodeCard renders min-w-[200px]; treat the connector as ~220px wide and keep
// a gap so a derived route edge has room to read left → right.
export const CONNECTOR_NODE_WIDTH = 220;
export const ROUTE_TARGET_GAP = 80;

/**
 * Canvas invariant: a config-targeted connector's target pipelines sit to its
 * RIGHT, so the derived route edges read left → right instead of looping
 * backwards. Any config-targeted group left of the connector is moved to just
 * past it (children follow automatically — they are positioned relative to
 * the group). Groups already right of the connector, non-target groups, and
 * the group the connector itself lives in (moving it would drag the connector
 * along and chase itself) are untouched. Returns the same array reference
 * when nothing moves.
 */
export function pushConfigTargetsRight(nodes: OTelNode[], pipelines: readonly Pipeline[]): OTelNode[] {
  // group id → minimum x demanded by some connector targeting it
  const minXByGroupId = new Map<string, number>();

  nodes.forEach((node) => {
    if (node.type === "pipelineGroup" || !isConfigTargetedConnectorNode(node)) return;
    // Connectors may sit inside a group; work in absolute coordinates.
    const parent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined;
    const absX = node.position.x + (parent?.position.x ?? 0);
    const minX = absX + CONNECTOR_NODE_WIDTH + ROUTE_TARGET_GAP;
    getConfigTargetNames(node).forEach((name) => {
      const pipeline = pipelines.find((p) => p.name === name);
      if (!pipeline) return;
      const groupId = groupIdForPipeline(pipeline.id);
      if (groupId === node.parentId) return;
      minXByGroupId.set(groupId, Math.max(minXByGroupId.get(groupId) ?? -Infinity, minX));
    });
  });

  let moved = false;
  const result = nodes.map((node) => {
    if (node.type !== "pipelineGroup") return node;
    const minX = minXByGroupId.get(node.id);
    if (minX === undefined || node.position.x >= minX) return node;
    moved = true;
    return { ...node, position: { ...node.position, x: minX } };
  });
  return moved ? result : nodes;
}

/**
 * Derived, read-only canvas edges: config-targeted connector → target
 * pipeline group (anchored on the group's "route" handle), one per config
 * target. Computed from config at render time — never stored, saved, or
 * undoable — so they cannot drift from what the connector actually does.
 * Targets naming a pipeline that doesn't exist yield no edge. Their ids are
 * built from the two opaque node ids.
 */
export function buildRouteEdges(nodes: readonly OTelNode[], pipelines: readonly Pipeline[]): OTelEdge[] {
  const routeEdges: OTelEdge[] = [];
  nodes.forEach((node) => {
    if (node.type === "pipelineGroup" || !isConfigTargetedConnectorNode(node)) return;
    describeConfigTargets(node).forEach((target) => {
      const pipeline = pipelines.find((p) => p.name === target.name);
      if (!pipeline) return;
      const groupId = groupIdForPipeline(pipeline.id);
      routeEdges.push({
        id: `route-${node.id}-${groupId}`,
        source: node.id,
        target: groupId,
        targetHandle: "route",
        type: "route",
        selectable: false,
        deletable: false,
        focusable: false,
        data: { label: target.label },
      });
    });
  });
  return routeEdges;
}
