import { CANVAS_GRID_SIZE, PIPELINE_GROUP_WIDTH } from "./constants.js";
import { groupIdForPipeline } from "./node-builders.js";
import {
  CONNECTOR_NODE_WIDTH,
  ROUTE_TARGET_GAP,
  getConfigTargetNames,
  isConfigTargetedConnectorNode,
} from "./routing-connector.js";
import type { OTelEdge, OTelNode, Pipeline } from "./types.js";

// Layered re-layout of a parsed pipeline graph. A group is
// found by its pipeline's opaque id (D9a decision 7), and a connector's edge
// may end at a group (a connector in a pipeline with nothing else to join).
//
// parseYAMLToGraph builds nodes in YAML order with fixed arithmetic positions
// (one row per pipeline, a fixed column pitch), which overlaps wide cards and
// crosses edges as soon as a pipeline has several receivers or exporters.
// This re-positions each pipeline group as proper columns:
//
//   [ receivers ]   [ proc ] [ proc ] [ proc ]   [ exporters ]
//   stacked + centered on a shared spine, so merges and forks render as clean
//   short diagonals and the straight runs stay perfectly horizontal.
//
// Connector nodes (spanmetrics, forward, routing, …) live OUTSIDE the
// pipeline groups: they are the exporter of one pipeline and the receiver of
// another. Each connector is re-seated in a widened gap between the two
// groups it bridges, under the tail of the pipeline that feeds it. Routing and
// failover connectors name their targets in config rather than with edges, so
// those are resolved from `pipelines`; connectors we can only resolve on one
// side (or neither) hang off the right edge of the canvas instead of keeping
// whatever spot the parser gave them.
//
// Extensions and components that belong to no pipeline get rows of their own
// beneath the last group. Groups, connectors and those floating nodes are
// aligned to the canvas grid; children stay centered on their spine so the
// edges between mixed-height cards stay straight.
//
// Runs as the parser's final pass and behind the canvas' "Tidy up" action;
// the caller follows it with pushRoutingTargetsRight, which is then a no-op.

const NODE_MIN_W = 200; // min-w-[200px] on the node cards
// Node cards render at two heights: nodes shared across multiple pipelines
// show a "{n} pipelines" line (taller); single-pipeline nodes (e.g. filelog,
// attributes, debug) don't. Handles sit at each node's vertical center, so we
// must position by the real height or the centers — and the edges between
// them — go wonky.
const NODE_H_TALL = 92; // shows the "{n} pipelines" line
const NODE_H_SHORT = 72; // single-pipeline node, no count line
const COL_GAP = 60; // horizontal air between column edges
const ROW_STEP = 140; // center-to-center vertical spacing for stacked nodes
const PAD_LEFT = 56;
const PAD_TOP = 56; // clears the pipeline-group label badge
const PAD_RIGHT = 56;
const PAD_BOTTOM = 40;
const START_X = 100; // matches the parser's group x (START_X - GROUP_PADDING)
const START_Y = 100;
const GROUP_GAP = 90; // vertical gap between pipeline groups
// Gap between two groups a connector sits between: the connector card plus
// breathing room above and below it.
const CONNECTOR_GROUP_GAP = 180;

type Col = OTelNode[];

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" ? value : fallback;

const snap = (v: number) => Math.round(v / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
const snapUp = (v: number) => Math.ceil(v / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;

// Cards are min-width 200 with px-6 padding, a leading icon, and a text-sm
// title, so named instances ("Transform (sanitize_spans)") stretch past the
// minimum. Estimate the rendered width from the label so columns get real
// air between them instead of assuming every card is exactly 200 wide.
export function estimateNodeWidth(n: OTelNode): number {
  const label = typeof n.data.label === "string" ? n.data.label : "";
  return Math.max(NODE_MIN_W, Math.round(76 + label.length * 7.3));
}

interface ConnectorLink {
  conn: OTelNode;
  sourceNode: OTelNode | undefined;
  targetNode: OTelNode | undefined;
  sourceGroupId: string | undefined;
  /** Groups this connector feeds: the edge target's group plus, for routing
   *  connectors, every pipeline its route table / defaults name. */
  targetGroupIds: string[];
}

/** Returns a new node array with pipeline groups laid out as neat layered
 * columns and resized to fit, connectors re-seated between the groups they
 * bridge, and extensions / ungrouped components in rows below the groups.
 * Nodes this doesn't understand pass through. */
export function layoutPipelineGraph(
  nodes: OTelNode[],
  edges: OTelEdge[] = [],
  pipelines: Pipeline[] = [],
): OTelNode[] {
  // Work on shallow clones so we never mutate the caller's nodes in place.
  const next: OTelNode[] = nodes.map((n) => ({
    ...n,
    position: { ...n.position },
    style: { ...(n.style ?? {}) },
  }));
  const byId = new Map(next.map((n) => [n.id, n]));

  // A node shows the "{n} pipelines" line (and is taller) when it's shared
  // across more than one pipeline. sharedCount = how many groups carry a copy
  // of the same sharedConfigId — mirrors useSharedCount in the node cards.
  const sharedCounts = new Map<string, number>();
  for (const n of next) {
    const id = n.data.sharedConfigId;
    if (id) sharedCounts.set(id, (sharedCounts.get(id) ?? 0) + 1);
  }
  const nodeHeight = (n: OTelNode): number => {
    const id = n.data.sharedConfigId;
    return id && (sharedCounts.get(id) ?? 0) > 1 ? NODE_H_TALL : NODE_H_SHORT;
  };
  const groupWidthOf = (g: OTelNode) => numberOr(g.style?.width, 0);
  const groupHeightOf = (g: OTelNode) => numberOr(g.style?.height, 0);
  // The group an edge's end lives in: its parent, or the group itself when
  // the edge ends at a group.
  const groupSideOf = (n: OTelNode | undefined): string | undefined =>
    n?.type === "pipelineGroup" ? n.id : n?.parentId;

  const groups = next.filter((n) => n.type === "pipelineGroup");
  // Preserve the parser's top-to-bottom order (traces, metrics, logs, …).
  groups.sort((a, b) => a.position.y - b.position.y);
  const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
  const groupIdByPipelineName = new Map(
    pipelines.map((p) => [p.name, groupIdForPipeline(p.id)]),
  );

  // Resolve each floating connector to the node that feeds it and the groups
  // it feeds. parentId tells us which group each side lives in. A connector
  // the user dragged INTO a group is that group's child and is laid out as
  // one of its columns below — its position is group-relative, so it must
  // not be re-seated in absolute coordinates here.
  const connectorLinks: ConnectorLink[] = next
    .filter((n) => n.type === "connector" && !n.parentId)
    .map((conn) => {
      const sourceNode = byId.get(
        edges.find((e) => e.target === conn.id)?.source ?? "",
      );
      const targetNode = byId.get(
        edges.find((e) => e.source === conn.id)?.target ?? "",
      );
      const sourceGroupId = groupSideOf(sourceNode);
      const targetGroupIds: string[] = [];
      const addTarget = (gid: string | undefined) => {
        if (!gid || gid === sourceGroupId || !groupIndex.has(gid)) return;
        if (!targetGroupIds.includes(gid)) targetGroupIds.push(gid);
      };
      addTarget(groupSideOf(targetNode));
      // Empty for connectors whose targets are canvas edges, so safe to apply
      // to every connector.
      getConfigTargetNames(conn).forEach((name) =>
        addTarget(groupIdByPipelineName.get(name)),
      );
      return { conn, sourceNode, targetNode, sourceGroupId, targetGroupIds };
    });

  // The group a connector is seated against: the target adjacent to its
  // source (so it can sit in the gap between them), else the topmost target.
  const bridgeTargetOf = (link: ConnectorLink): string | undefined => {
    const ia = link.sourceGroupId
      ? groupIndex.get(link.sourceGroupId)
      : undefined;
    const sorted = [...link.targetGroupIds].sort(
      (a, b) => groupIndex.get(a)! - groupIndex.get(b)!,
    );
    if (ia === undefined) return sorted[0];
    return (
      sorted.find((gid) => Math.abs(groupIndex.get(gid)! - ia) === 1) ??
      sorted[0]
    );
  };

  // Widen the gap below the upper group of each adjacent pair a connector
  // bridges, so the connector has a shelf to sit on instead of overlapping
  // a group's exporter column.
  const widenGapBelow = new Set<string>();
  for (const link of connectorLinks) {
    const a = link.sourceGroupId;
    const b = bridgeTargetOf(link);
    if (!a || !b) continue;
    const ia = groupIndex.get(a)!;
    const ib = groupIndex.get(b)!;
    if (Math.abs(ia - ib) !== 1) continue;
    const upper = groups[Math.min(ia, ib)];
    if (upper) widenGapBelow.add(upper.id);
  }

  let runningY = START_Y;

  // Group-relative center x of each group's last column, so connectors can
  // sit under the pipeline's tail (where their feeding edge originates).
  const lastColCenterByGroup = new Map<string, number>();

  for (const group of groups) {
    const children = next.filter((n) => n.parentId === group.id);
    const receivers = children.filter((n) => n.type === "receiver");
    const processors = children.filter((n) => n.type === "processor");
    const exporters = children.filter((n) => n.type === "exporter");
    const others = children.filter(
      (n) =>
        n.type !== "receiver" &&
        n.type !== "processor" &&
        n.type !== "exporter",
    );

    // One column for the receiver stack, one per processor, one for the
    // exporter stack. Skip empty ends so a receiver-less pipeline doesn't
    // open with a blank column.
    const cols: Col[] = [];
    if (receivers.length) cols.push(receivers);
    for (const p of processors) cols.push([p]);
    if (exporters.length) cols.push(exporters);
    // Park anything unexpected (e.g. a connector dragged into the group) in
    // its own trailing column rather than dropping it.
    for (const o of others) cols.push([o]);

    const gapBelow = widenGapBelow.has(group.id)
      ? CONNECTOR_GROUP_GAP
      : GROUP_GAP;

    if (cols.length === 0) {
      // Nothing to lay out — still stack the (empty) group cleanly.
      const emptyH = snapUp(PAD_TOP + NODE_H_TALL + PAD_BOTTOM);
      group.position = { x: START_X, y: runningY };
      group.style = {
        ...group.style,
        width: PIPELINE_GROUP_WIDTH,
        height: emptyH,
      };
      runningY = snapUp(runningY + emptyH + gapBelow);
      continue;
    }

    // Column x positions accumulate by each column's widest card, so a wide
    // named node pushes its neighbors over instead of butting against them.
    const colWidths = cols.map((col) =>
      Math.max(...col.map(estimateNodeWidth)),
    );
    const colX: number[] = [];
    let cursorX = PAD_LEFT;
    for (const w of colWidths) {
      colX.push(cursorX);
      cursorX += w + COL_GAP;
    }
    const contentRight = cursorX - COL_GAP;
    lastColCenterByGroup.set(
      group.id,
      (colX[colX.length - 1] ?? 0) + (colWidths[colWidths.length - 1] ?? 0) / 2,
    );

    const maxStack = Math.max(1, ...cols.map((c) => c.length));
    // Size around the tallest node so every column has room.
    const contentHeight = (maxStack - 1) * ROW_STEP + NODE_H_TALL;
    const centerY = PAD_TOP + contentHeight / 2;

    cols.forEach((col, colIndex) => {
      const m = col.length;
      col.forEach((node, i) => {
        // Center the stack on the shared spine. Offset by each node's OWN
        // height so the handles (which sit at the node's vertical center)
        // all land on the spine — short and tall nodes alike — keeping the
        // connecting edges straight instead of wavy. Center each card within
        // its column so mixed widths stay aligned on the column's center.
        const nodeCenterY = centerY + (i - (m - 1) / 2) * ROW_STEP;
        node.position = {
          x: (colX[colIndex] ?? 0) + ((colWidths[colIndex] ?? 0) - estimateNodeWidth(node)) / 2,
          y: nodeCenterY - nodeHeight(node) / 2,
        };
      });
    });

    const groupWidth = snapUp(contentRight + PAD_RIGHT);
    const groupHeight = snapUp(PAD_TOP + contentHeight + PAD_BOTTOM);

    group.position = { x: START_X, y: runningY };
    group.style = { ...group.style, width: groupWidth, height: groupHeight };

    runningY = snapUp(runningY + groupHeight + gapBelow);
  }

  const absCenterY = (g: OTelNode, n: OTelNode) =>
    n === g
      ? g.position.y + groupHeightOf(g) / 2
      : g.position.y + n.position.y + nodeHeight(n) / 2;
  const groupsRightEdge = () =>
    groups.length
      ? Math.max(...groups.map((g) => g.position.x + groupWidthOf(g)))
      : START_X;
  const groupsBottom = () =>
    groups.length
      ? Math.max(...groups.map((g) => g.position.y + groupHeightOf(g)))
      : START_Y;

  // Seat each connector as a cascade step between the groups it bridges:
  // vertically centered in the (widened) gap, horizontally under the source
  // pipeline's tail — then indent the target group to START right of the
  // connector, so the connector feeds forward into the target's first column
  // instead of sweeping backward across the canvas. Processed top-down so a
  // chained connector reads its source group's final position. Connectors
  // without a shelf to sit on (non-adjacent pipelines, or a side we can't
  // resolve) hang off the right edge of the canvas instead.
  const placedUnderGroup = new Map<string, number>();
  const sourceY = (link: ConnectorLink) =>
    link.sourceGroupId
      ? (byId.get(link.sourceGroupId)?.position.y ?? Infinity)
      : Infinity;
  [...connectorLinks]
    .sort((a, b) => sourceY(a) - sourceY(b))
    .forEach((link) => {
      const { conn, sourceNode, targetNode, sourceGroupId } = link;
      const connW = estimateNodeWidth(conn);
      const connH = nodeHeight(conn);
      const groupA = sourceGroupId ? byId.get(sourceGroupId) : undefined;
      const bridgeId = bridgeTargetOf(link);
      const groupB = bridgeId ? byId.get(bridgeId) : undefined;

      let seated = false;
      if (groupA && groupB) {
        const upper = groupA.position.y <= groupB.position.y ? groupA : groupB;
        const lower = upper === groupA ? groupB : groupA;
        const upperBottom = upper.position.y + groupHeightOf(upper);
        const gapHeight = lower.position.y - upperBottom;

        if (gapHeight >= connH + 24) {
          // Adjacent groups with a shelf between them (the widened gap
          // above). Stack siblings from the same source group side by side.
          const siblings = placedUnderGroup.get(groupA.id) ?? 0;
          placedUnderGroup.set(groupA.id, siblings + 1);
          const tailCenterX =
            groupA.position.x + (lastColCenterByGroup.get(groupA.id) ?? 0);
          conn.position = {
            x: snap(
              Math.max(
                START_X,
                tailCenterX - connW / 2 + siblings * (connW + COL_GAP),
              ),
            ),
            y: snap(upperBottom + (gapHeight - connH) / 2),
          };
          // Cascade: the group the connector feeds begins right of it.
          if (lower === groupB) {
            lower.position = {
              ...lower.position,
              x: Math.max(
                lower.position.x,
                snapUp(conn.position.x + connW + COL_GAP),
              ),
            };
          }
          seated = true;
        }
      }

      if (!seated) {
        // Hang the connector off the right edge of the canvas, level with
        // whichever side(s) we could resolve — midway between the two when
        // both are known, else at the top.
        const targetGroupId = groupSideOf(targetNode);
        const targetGroup = targetGroupId ? byId.get(targetGroupId) : undefined;
        const anchors: number[] = [];
        if (groupA && sourceNode) anchors.push(absCenterY(groupA, sourceNode));
        if (targetGroup && targetNode) {
          anchors.push(absCenterY(targetGroup, targetNode));
        }
        const centerY = anchors.length
          ? anchors.reduce((s, y) => s + y, 0) / anchors.length
          : START_Y + connH / 2;
        const siblings = placedUnderGroup.get("__right__") ?? 0;
        placedUnderGroup.set("__right__", siblings + 1);
        conn.position = {
          x: snap(groupsRightEdge() + COL_GAP + siblings * (connW + COL_GAP)),
          y: snap(centerY - connH / 2),
        };
      }

      // Canvas invariant (see pushConfigTargetsRight): every pipeline a
      // routing/failover connector targets sits to its right, so the derived
      // route edges read left → right. Settle it here so that pass is a no-op.
      if (isConfigTargetedConnectorNode(conn)) {
        const minX = snapUp(
          conn.position.x +
            Math.max(connW, CONNECTOR_NODE_WIDTH) +
            ROUTE_TARGET_GAP,
        );
        for (const gid of link.targetGroupIds) {
          const g = byId.get(gid);
          if (g && g.position.x < minX) {
            g.position = { ...g.position, x: minX };
          }
        }
      }
    });

  // Rows beneath the groups: components that belong to no pipeline first,
  // then extensions (which never join a pipeline). The parser parks these at
  // a fixed offset from the group count, which lands inside a group once the
  // groups above have grown to fit stacked columns.
  const floating = next.filter(
    (n) => !n.parentId && n.type !== "pipelineGroup" && n.type !== "connector",
  );
  const looseComponents = floating.filter((n) => n.type !== "extension");
  const extensions = floating.filter((n) => n.type === "extension");
  let rowY = snapUp(groupsBottom() + GROUP_GAP);
  const layRow = (row: OTelNode[]) => {
    let x = START_X;
    for (const n of row) {
      n.position = { x: snap(x), y: rowY };
      x += estimateNodeWidth(n) + COL_GAP;
    }
    rowY = snapUp(rowY + ROW_STEP);
  };
  if (looseComponents.length) layRow(looseComponents);
  if (extensions.length) layRow(extensions);

  return next;
}
