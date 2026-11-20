import type { Connection, Viewport, XYPosition } from "@xyflow/react";
import { toast } from "sonner";

import { GROUP_SOURCE_HANDLE, GROUP_TARGET_HANDLE } from "./nodes/PipelineGroupNode.js";
import { useEditorStore, type ConnectResult } from "~/lib/stores/editor-store.js";
import { isGroup } from "~/lib/graph/canvas-operations.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { buildRouteEdges, isConfigTargetedConnectorNode } from "~/lib/graph/routing-connector.js";
import type { Graph, OTelEdge, OTelNode, PaletteComponent } from "~/lib/graph/types.js";

/*
 * The canvas's handlers, outside the component, so they are tested without
 * React Flow's pointer events: what a drop carries and where it lands, a
 * connection and its warning, the edges the canvas draws, the minimap's
 * colours, and the viewport remembered per version. The graph's changes
 * themselves are the editor store's, on the pure functions of
 * `lib/graph/canvas-operations.ts`.
 */

/** The drag payload's type: the palette entry as JSON (static data only). */
export const PALETTE_DRAG_TYPE = "application/reactflow";

/** Starts a palette chip's drag: the static palette entry, never anything a person wrote. */
export function writePaletteDrag(dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">, entry: PaletteComponent): void {
  dataTransfer.setData(PALETTE_DRAG_TYPE, JSON.stringify(entry));
  dataTransfer.effectAllowed = "move";
}

/** The palette entry a drop carries, by its id; null for anything else (another app's drag, text, a stale id). */
export function readPaletteDrop(dataTransfer: Pick<DataTransfer, "getData">): string | null {
  const data = dataTransfer.getData(PALETTE_DRAG_TYPE);
  if (!data) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const id = (payload as { id?: unknown }).id;
  if (typeof id !== "string") return null;
  return componentPalette.some((entry) => entry.id === id) ? id : null;
}

/** Read-only: not selectable, deletable or focusable (a derived or group-anchored edge). */
const READ_ONLY = { selectable: false, deletable: false, focusable: false } as const;

/**
 * The edges the canvas draws:
 * - the stored edges, with those leaving a routing or failover connector
 *   hidden (their targets are its config's, drawn as route edges);
 * - an edge to or from a pipeline's group (a connector with nothing else in
 *   the pipeline to join) drawn read-only, on the group's invisible anchors:
 *   it shows a membership the text holds, and goes when that does;
 * - the route edges derived from routing and failover connectors' configs.
 */
export function displayedEdges(graph: Pick<Graph, "nodes" | "pipelines" | "edges">): OTelEdge[] {
  const groups = new Set<string>();
  const configTargeted = new Set<string>();
  for (const node of graph.nodes) {
    if (isGroup(node)) groups.add(node.id);
    else if (isConfigTargetedConnectorNode(node)) configTargeted.add(node.id);
  }
  const stored = graph.edges.map((edge): OTelEdge => {
    if (groups.has(edge.source) || groups.has(edge.target)) {
      return {
        ...edge,
        ...READ_ONLY,
        ...(groups.has(edge.source) ? { sourceHandle: GROUP_SOURCE_HANDLE } : {}),
        ...(groups.has(edge.target) ? { targetHandle: GROUP_TARGET_HANDLE } : {}),
      };
    }
    return configTargeted.has(edge.source) ? { ...edge, hidden: true } : edge;
  });
  return [...stored, ...buildRouteEdges(graph.nodes, graph.pipelines)];
}

const MINIMAP_COLORS: Readonly<Record<string, string>> = {
  receiver: "var(--color-node-receiver)",
  processor: "var(--color-node-processor)",
  exporter: "var(--color-node-exporter)",
  extension: "var(--color-node-extension)",
  connector: "var(--color-node-connector)",
};

/**
 * The minimap's fill: a group in its pipeline's colour, a component in its
 * type's. From the type and the colour only, never a name.
 */
const confined = new WeakMap<OTelNode, OTelNode>();

/**
 * The node as the canvas is given it. A component in a pipeline's group
 * can't be dragged out of it: React Flow's `extent: "parent"` keeps it
 * inside while it moves, and the group's resizer can't shrink past it. So a
 * node never leaves its pipeline by a drag, even partly; one outside every
 * pipeline can still be dragged into one. The same object comes back for
 * the same node, so React Flow's per-node memo holds while one node is
 * dragged.
 */
export function displayedNode(node: OTelNode): OTelNode {
  if (node.parentId === undefined || isGroup(node)) return node;
  let shown = confined.get(node);
  if (!shown) {
    shown = { ...node, extent: "parent" };
    confined.set(node, shown);
  }
  return shown;
}

export function minimapNodeColor(node: Pick<OTelNode, "type" | "data">): string {
  if (node.type === "pipelineGroup") {
    const color = node.data.color;
    return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "#374151";
  }
  const type = node.data.componentType;
  return Object.hasOwn(MINIMAP_COLORS, type) ? MINIMAP_COLORS[type]! : "var(--color-gray-300)";
}

/** A refused connection's warning, a two-line `toast.warning` (title, then description). */
export function warnRefusedConnection(
  result: ConnectResult,
  warn: (title: string, options: { description: string }) => unknown,
): void {
  if (!result.ok && result.warning) warn(result.warning.title, { description: result.warning.description });
}

/**
 * The canvas's `onConnect`: the store draws the connection (with its undo
 * entry, and adopting an ungrouped end), or refuses it; a connector's signal
 * refusal toasts a warning.
 */
export function connectOnCanvas(connection: Connection): ConnectResult {
  const result = useEditorStore.getState().connect(connection);
  // The title names the nodes (configuration text): out of replay.
  warnRefusedConnection(result, (title, options) => toast.warning(title, { ...options, className: "ph-no-capture" }));
  return result;
}

/**
 * The canvas's `onDrop`: a palette entry dropped at a point on the screen
 * joins the canvas there (in the group under it, "Label (2)" naming, its
 * own copy of the entry's default config, selected). `toFlow` is React
 * Flow's `screenToFlowPosition`, which also snaps to the grid.
 */
export function dropOnCanvas(
  dataTransfer: Pick<DataTransfer, "getData">,
  screen: XYPosition,
  toFlow: (screen: XYPosition) => XYPosition,
): OTelNode | null {
  const paletteId = readPaletteDrop(dataTransfer);
  if (paletteId === null) return null;
  return useEditorStore.getState().dropComponent(paletteId, toFlow(screen));
}

/** The ids of React Flow's selected nodes, for the store's `setSelection`. */
export function selectionIds(nodes: readonly Pick<OTelNode, "id">[]): string[] {
  return nodes.map((node) => node.id);
}

// ── The viewport, per version ─────────────────────────────────────────────

/**
 * Where the canvas's viewport is remembered, per version, in this browser
 * (under the product's own key): `{ [versionId]: { x, y, zoom } }`, keyed by
 * the version's opaque id; positions only.
 */
export const VIEWPORT_STORAGE_KEY = "telflo-canvas-viewports";

/** How many versions' viewports are kept; the least recently written go first. */
export const VIEWPORTS_KEPT = 50;

/** How long the canvas waits after the last pan or zoom before remembering it. */
export const VIEWPORT_SAVE_DELAY_MS = 150;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike {
  return window.localStorage;
}

function isViewport(value: unknown): value is Viewport {
  if (typeof value !== "object" || value === null) return false;
  const { x, y, zoom } = value as Record<string, unknown>;
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom > 0
  );
}

function readAll(storage: StorageLike): Record<string, unknown> {
  const raw = storage.getItem(VIEWPORT_STORAGE_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** The viewport remembered for a version; null when none is (or storage can't be read: never throw). */
export function readViewport(versionId: string | undefined, storage: () => StorageLike = browserStorage): Viewport | null {
  if (!versionId) return null;
  try {
    const all = readAll(storage());
    const saved = Object.hasOwn(all, versionId) ? all[versionId] : undefined;
    return isViewport(saved) ? { x: saved.x, y: saved.y, zoom: saved.zoom } : null;
  } catch {
    return null;
  }
}

/** Remembers a version's viewport; storage that can't be written is ignored (the viewport lasts until the page is left). */
export function writeViewport(
  versionId: string | undefined,
  viewport: Viewport,
  storage: () => StorageLike = browserStorage,
): void {
  if (!versionId || !isViewport(viewport)) return;
  try {
    const target = storage();
    let all: Record<string, unknown>;
    try {
      all = readAll(target);
    } catch {
      all = {};
    }
    delete all[versionId];
    all[versionId] = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    const kept = Object.entries(all).slice(-VIEWPORTS_KEPT);
    target.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage disabled or full: nothing to do.
  }
}
