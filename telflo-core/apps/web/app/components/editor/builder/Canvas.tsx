import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type EdgeTypes,
  type NodeTypes,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";

import {
  connectOnCanvas,
  displayedEdges,
  displayedNode,
  dropOnCanvas,
  minimapNodeColor,
  readViewport,
  selectionIds,
  VIEWPORT_SAVE_DELAY_MS,
  writeViewport,
} from "./canvas-handlers.js";
import { PipelineEdge } from "./edges/PipelineEdge.js";
import { RouteEdge } from "./edges/RouteEdge.js";
import { ConnectorNode } from "./nodes/ConnectorNode.js";
import { ExporterNode } from "./nodes/ExporterNode.js";
import { ExtensionNode } from "./nodes/ExtensionNode.js";
import { PipelineGroupNode } from "./nodes/PipelineGroupNode.js";
import { ProcessorNode } from "./nodes/ProcessorNode.js";
import { ReceiverNode } from "./nodes/ReceiverNode.js";
import { CANVAS_GRID_SIZE } from "~/lib/graph/constants.js";
import { usePlayground } from "~/lib/playground/context.js";
import type { OTelEdge, OTelNode } from "~/lib/graph/types.js";
import {
  selectCollectorValidation,
  selectIsVersionPublished,
  useEditorStore,
  type CollectorValidationOutcome,
} from "~/lib/stores/editor-store.js";

/** The manual-edit overlay. */
export const MANUAL_EDIT_OVERLAY_MESSAGE = "In Manual Edit Mode. Exit Manual Edit mode to resume canvas updates.";

/** The overlay's validation chip. */
export const CHIP_VALIDATING = "Validating...";
export const CHIP_VALID = "Yaml is Valid";
export const CHIP_UNCHECKED = "Validation unavailable — YAML not checked.";
export const CHIP_ERRORS = "Errors must be corrected.";

/** The chip's text and colours for an outcome; none while idle. */
function chipOf(validation: CollectorValidationOutcome): { text: string; className: string } | null {
  switch (validation.status) {
    case "idle":
      return null;
    case "validating":
      return { text: CHIP_VALIDATING, className: "border-border bg-card/95 text-muted-foreground" };
    case "valid":
      return { text: CHIP_VALID, className: "border-ok/25 bg-ok-soft text-ok" };
    case "unavailable":
    case "retired":
      return { text: CHIP_UNCHECKED, className: "border-warn/25 bg-warn-soft text-warn" };
    case "invalid":
      return { text: CHIP_ERRORS, className: "border-fail/25 bg-fail-soft text-fail" };
  }
}
/** The overlay while the text can't be shown; the reason follows it, as text. */
export const UNREADABLE_OVERLAY_MESSAGE = "The canvas can't show this YAML until it reads as a configuration.";

const nodeTypes: NodeTypes = {
  receiver: ReceiverNode,
  processor: ProcessorNode,
  exporter: ExporterNode,
  extension: ExtensionNode,
  connector: ConnectorNode,
  pipelineGroup: PipelineGroupNode,
};

const edgeTypes: EdgeTypes = {
  smoothstep: PipelineEdge,
  route: RouteEdge,
};

const SNAP_GRID: [number, number] = [CANVAS_GRID_SIZE, CANVAS_GRID_SIZE];

/**
 * The canvas, reading and writing the editor's store: every change goes
 * through the store's actions, which take the undo entry and write the
 * text. React Flow's own delete is off (`deleteKeyCode={null}`); deleting
 * goes through the store's one path.
 *
 * Over the canvas: manual edit mode's overlay, with a chip saying what the
 * collector validator made of the typed text (hidden while idle), or, when
 * the text can't be read as a configuration, one saying so, with the
 * reason as text. Either way nodes can't be dragged, connected, selected
 * or focused beneath it.
 *
 * A published version is read-only, its own mode, with no overlay: nodes
 * can be selected and focused, and the canvas panned and zoomed, but
 * nothing dragged, connected, dropped or resized (a group's resizer doesn't
 * show). The store refuses each change too, and deleting.
 *
 * React Flow mounts on the client only: the remembered viewport lives in
 * this browser's storage, so a server render couldn't match it.
 */
export function Canvas() {
  const canvasKey = useEditorStore((state) => state.canvasKey);
  const versionId = useEditorStore((state) => state.version?.id);
  const isYamlEditing = useEditorStore((state) => state.isYamlEditing);
  const graphStatus = useEditorStore((state) => state.graphStatus);
  const unreadable = graphStatus === "ready" ? null : graphStatus.unreadable;
  const locked = isYamlEditing || unreadable !== null;
  const readOnly = useEditorStore(selectIsVersionPublished);
  const chip = chipOf(useEditorStore(selectCollectorValidation));

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="flex-1 h-full relative">
      {isYamlEditing ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/40">
          <p className="rounded-md border border-border bg-card/95 px-4 py-2 text-[13px] font-medium text-foreground">
            {MANUAL_EDIT_OVERLAY_MESSAGE}
          </p>
          {chip !== null && (
            <p className={`rounded-md border px-3 py-1.5 text-xs font-medium ${chip.className}`}>{chip.text}</p>
          )}
        </div>
      ) : unreadable !== null ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/40 p-4">
          <div className="max-w-lg rounded-md border border-border bg-card/95 px-4 py-3 text-center">
            <p className="text-[13px] font-medium text-foreground">{UNREADABLE_OVERLAY_MESSAGE}</p>
            <p className="mt-1.5 break-words font-mono text-[11px] leading-4 text-muted-foreground">{unreadable}</p>
          </div>
        </div>
      ) : null}
      {mounted && <FlowCanvas key={canvasKey} versionId={versionId} locked={locked} readOnly={readOnly} />}
    </div>
  );
}

/**
 * Fits the view once, when nothing is remembered for the version: after the
 * nodes are measured and the canvas has a size. React Flow's own `fitView`
 * prop can run before it has recorded the canvas's size (its resize handler
 * skips an element `checkVisibility()` calls hidden at mount), and a fit into
 * 0 × 0 leaves the graph off to the top left at the smallest zoom; WebKit
 * did so with the production build.
 */
function FitOnOpen() {
  const { fitView } = useReactFlow<OTelNode, OTelEdge>();
  const measured = useNodesInitialized();
  const sized = useStore((state) => state.width > 0 && state.height > 0);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !measured || !sized) return;
    fitted.current = true;
    void fitView();
  }, [measured, sized, fitView]);
  return null;
}

/**
 * React Flow itself, mounted afresh for each load and each Clear canvas (the
 * store's `canvasKey`). `locked`: nothing can be touched (the overlays);
 * `readOnly`: a published version, inspected but never changed.
 */
function FlowCanvas({
  versionId,
  locked,
  readOnly,
}: {
  versionId: string | undefined;
  locked: boolean;
  readOnly: boolean;
}) {
  const graph = useEditorStore((state) => state.graph);
  const layoutRevision = useEditorStore((state) => state.layoutRevision);

  // The playground's surfaces remember nothing in storage beyond their own
  // named keys: no viewport read or written.
  const remembers = usePlayground() === null;
  // Read once, at mount, so React Flow's first paint is already at the
  // remembered viewport (no zoom flicker on load).
  const [initialViewport] = useState(() => (remembers ? readViewport(versionId) : null));
  const instance = useRef<ReactFlowInstance<OTelNode, OTelEdge> | null>(null);
  const edges = useMemo(() => displayedEdges(graph), [graph]);
  const nodes = useMemo(() => graph.nodes.map(displayedNode), [graph.nodes]);

  // After Tidy up, bring the new layout into view: two frames out, once the
  // groups' new sizes have been measured.
  const revisionAtMount = useRef(layoutRevision);
  useEffect(() => {
    if (layoutRevision === revisionAtMount.current) return;
    let inner: number | null = null;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        void instance.current?.fitView({ padding: 0.15, duration: 250 });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner !== null) cancelAnimationFrame(inner);
    };
  }, [layoutRevision]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );
  const onMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      if (!remembers) return;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => writeViewport(versionId, viewport), VIEWPORT_SAVE_DELAY_MS);
    },
    [versionId, remembers],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = readOnly ? "none" : "move";
    },
    [readOnly],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const flow = instance.current;
      if (!flow || readOnly) return;
      dropOnCanvas(event.dataTransfer, { x: event.clientX, y: event.clientY }, (screen) => flow.screenToFlowPosition(screen));
    },
    [readOnly],
  );

  const onSelectionChange = useCallback(({ nodes }: OnSelectionChangeParams<OTelNode, OTelEdge>) => {
    useEditorStore.getState().setSelection(selectionIds(nodes));
  }, []);

  const onNodeClick = useCallback((event: MouseEvent, node: OTelNode) => {
    if (!event.shiftKey) useEditorStore.getState().selectNode(node.id);
  }, []);

  return (
    <ReactFlow<OTelNode, OTelEdge>
      nodes={nodes}
      edges={edges}
      onNodesChange={(changes) => useEditorStore.getState().applyNodeChanges(changes)}
      onEdgesChange={(changes) => useEditorStore.getState().applyEdgeChanges(changes)}
      onConnect={connectOnCanvas}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onNodeClick={onNodeClick}
      onPaneClick={() => useEditorStore.getState().selectNode(null)}
      onNodeDragStop={(_event, _node, nodes) => useEditorStore.getState().finishMove(selectionIds(nodes))}
      onSelectionDragStop={(_event, nodes) => useEditorStore.getState().finishMove(selectionIds(nodes))}
      onSelectionChange={onSelectionChange}
      onInit={(flow) => {
        instance.current = flow;
      }}
      onMove={onMove}
      deleteKeyCode={null}
      selectionKeyCode="Shift"
      multiSelectionKeyCode="Shift"
      selectionMode={SelectionMode.Partial}
      // Nodes snap to the dot grid while dragged, dropped and resized, so
      // hand-placed nodes line up the way the layout's do.
      snapToGrid
      snapGrid={SNAP_GRID}
      nodesDraggable={!locked && !readOnly}
      nodesConnectable={!locked && !readOnly}
      elementsSelectable={!locked}
      nodesFocusable={!locked}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      {...(initialViewport ? { defaultViewport: initialViewport } : {})}
      className="dark:bg-gray-900"
    >
      {/* No background classes: app.css's tf-app canvas rules own the floor and the dots. */}
      {initialViewport === null && <FitOnOpen />}
      <Background gap={CANVAS_GRID_SIZE} size={1.6} />
      <Controls className="dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300 [&>button]:dark:bg-gray-800 [&>button]:dark:border-gray-700 [&>button]:dark:text-gray-300 [&>button:hover]:dark:bg-gray-700" />
      <MiniMap<OTelNode> className="dark:bg-gray-800!" maskColor="rgba(0, 0, 0, 0.1)" nodeColor={minimapNodeColor} />
    </ReactFlow>
  );
}
