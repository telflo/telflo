import type {
  Configuration,
  ConfigurationValidationError,
  ConfigurationValidationRequirement,
  ConfigurationVersion,
  ConfigurationVersionSummary,
} from "@telflo/contracts";
import { applyEdgeChanges as applyFlowEdgeChanges, applyNodeChanges as applyFlowNodeChanges } from "@xyflow/react";
import type { Connection, EdgeChange, NodeChange } from "@xyflow/react";
import { toast } from "sonner";
import { create } from "zustand";

import {
  absolutePosition,
  adoption,
  connectionRefusal,
  detachOutside,
  droppedNode,
  ensureParentChildOrder,
  groupAt,
  instanceLabel,
  isGroup,
  layoutSignature,
  reparented,
  type Point,
} from "~/lib/graph/canvas-operations.js";
import { spelledType } from "~/lib/collector/renamed-types.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { matchLayout } from "~/lib/graph/layout-match.js";
import { deriveModel, readTextModel, renamedModel, type Model } from "~/lib/graph/model.js";
import {
  createDefaultGroupNodes,
  createGroupNode,
  generatePipelineColor,
  getDefaultPipelines,
  groupIdForPipeline,
  nextEdgeId,
  nextGroupYPosition,
  nextPipelineId,
} from "~/lib/graph/node-builders.js";
import {
  buildDuplicateNode,
  buildDuplicateNodes,
  buildLinkedNode,
  closedChains,
  componentKey,
  pruneGroupChildren,
  sharedConfigIdOf,
} from "~/lib/graph/node-operations.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { extractSignalType, parse, readText, type ParsedText } from "~/lib/graph/parse.js";
import { layoutPipelineGraph } from "~/lib/graph/pipeline-layout.js";
import {
  isConfigTargetedConnectorNode,
  pushConfigTargetsRight,
  targetNamesOf,
  wireConnectorReceivers,
  type ConnectorWiring,
} from "~/lib/graph/routing-connector.js";
import { fromStored } from "~/lib/graph/stored-graph.js";
import {
  editText,
  splitKey,
  TextEditError,
  writeComponentValue,
  writeValues,
  type ComponentRename,
  type EditedText,
  type ValueChange,
  type ValuePath,
} from "~/lib/graph/text-edits.js";
import type { Graph, OTelEdge, OTelNode, Pipeline } from "~/lib/graph/types.js";
import { nodeAt } from "~/lib/graph/value-view.js";
import { HISTORY_THROTTLE_MS } from "~/lib/stores/history-throttle.js";

/**
 * The panel's width when the editor opens: 400 px, now that the canvas
 * shares the page (D9a decision 9; D8 used 640 until it came).
 */
export const DEFAULT_PANEL_WIDTH = 400;

/** How many undo entries are kept (D9a decision 11). */
export const HISTORY_DEPTH = 50;

/** A run of changes to one node within this many milliseconds is one undo entry. */
export { HISTORY_THROTTLE_MS };

/** A change the text edits can't write (D9a decision 4). */
export const CANT_EDIT_ON_CANVAS_MESSAGE = "This change can't be made on the canvas. Edit the YAML directly.";
/** The toasts for manual edit mode. */
export const ENTERED_MANUAL_EDIT_MESSAGE = "Entered manual edit mode";
export const CHANGES_APPLIED_MESSAGE = "Changes applied";
export const CHANGES_REVERTED_MESSAGE = "Changes reverted";

/**
 * What a routing or failover target choice did to the pipelines' receivers
 * (D9d decision 8; the plan's toasts), one message each: shown in one toast,
 * as text, never an attribute.
 */
export function receiverWiringMessages(connector: string, wiring: Pick<ConnectorWiring, "added" | "removed" | "kept">): string[] {
  return [
    ...(wiring.added.length > 0 ? [`Added ${connector} to the receivers of ${wiring.added.join(", ")}.`] : []),
    ...(wiring.removed.length > 0 ? [`Removed ${connector} from the receivers of ${wiring.removed.join(", ")}.`] : []),
    ...wiring.kept.map((pipeline) => `Kept ${connector} in ${pipeline}'s receivers: it's the pipeline's only receiver.`),
  ];
}

/** Whether the canvas can show the text: `ready`, or why not (D9a decision 3). The reason is text, never an attribute. */
export type GraphStatus = "ready" | { unreadable: string };

/**
 * An undo entry (D9a decision 11): the text and the graph together, so
 * undoing restores both, and what it undoes ("Add OTLP"), shown in the undo
 * toast, never in an attribute.
 */
export interface HistoryEntry {
  text: string;
  graph: Graph;
  description: string;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

/** What the delete dialog asks about (D9a decision 8): components, or a pipeline with its components. */
export type DeleteTarget = { kind: "nodes"; nodeIds: string[] } | { kind: "pipeline"; pipelineId: string };

/** A connection drawn on the canvas: made, or refused, with a warning for the canvas to toast. */
export type ConnectResult = { ok: true } | { ok: false; warning?: { title: string; description: string } };

export type ApplyResult = { ok: true } | { ok: false; reason: string };

/**
 * What became of a YAML box write: written; refused (a box that doesn't
 * read, a locked canvas, an undeclared component, or a change the text
 * edits can't write, which toasts); or refused because the box defines an
 * anchor the text defines elsewhere, which the box says under itself.
 */
export type ComponentValueResult = "written" | "refused" | "anchor-clash";

/**
 * What became of a form's changes (D9b decision 2): written; unchanged (the
 * text would read the same: no entry, not dirty; Preflight ruling 12); or
 * refused (a locked canvas, a group, an undeclared component, or a change
 * the text edits can't write, which toasts).
 */
export type ValuesResult = "written" | "unchanged" | "refused";

/** Where self-monitoring lives in the text (D9b decision 7). */
export const TELEMETRY_BASE: ValuePath = ["service", "telemetry"];

/** The undo entry of the Self-monitoring dialog's Apply and Remove Section. */
export const EDIT_SELF_MONITORING = "Edit self-monitoring";

/** A graph with nothing on it: before a load, and for text the canvas can't show when opened. */
export const EMPTY_GRAPH: Graph = { nodes: [], edges: [], pipelines: [] };

/**
 * A version's summary, as the picker lists it (D10 decision 4): the version
 * without its content, with whether it is published (D11b decision 10) and
 * its collector version, deprecated or not (D13a decisions 4 and 8).
 */
export function summaryOf({
  id,
  versionNumber,
  label,
  createdBy,
  createdAt,
  updatedAt,
  publishedAt,
  publishedBy,
  collectorVersion,
  collectorVersionDeprecated,
  collectorVersionDeprecatedNote,
}: ConfigurationVersionSummary): ConfigurationVersionSummary {
  return {
    id,
    versionNumber,
    label,
    createdBy,
    createdAt,
    updatedAt,
    publishedAt,
    publishedBy,
    collectorVersion,
    collectorVersionDeprecated,
    collectorVersionDeprecatedNote,
  };
}

/**
 * What the collector validator said about a text (D13b decisions 2, 4, 12
 * and 14), as the status bar, Apply's gate and the overlay's chip read it
 * (`selectCollectorValidation`):
 * - `idle`: nothing to check (no version, empty text, or text that doesn't
 *   parse), and nothing shown;
 * - `validating`: a check is due or under way for the text on screen;
 * - `valid` / `invalid`: the collector `collectorVersion` checked it;
 *   `invalid` has at least one error;
 * - `retired`: the pin is deprecated, so the text wasn't checked;
 * - `unavailable`: it wasn't checked; `message` says why (the API's words,
 *   or the editor's own when the API couldn't be reached). `retryAt`, when
 *   set, is when a rate-limited text is asked about again (epoch ms): the
 *   anonymous validate's 429, which the status bar shows as a countdown
 *   (D31-1 decision 3); the signed-in editor never sets it.
 * The messages and paths echo the configuration: text only, never an
 * attribute (ADR 0024).
 */
export type CollectorValidationOutcome =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid"; collectorVersion: string; requirements: ConfigurationValidationRequirement[] }
  | {
      status: "invalid";
      collectorVersion: string;
      errors: ConfigurationValidationError[];
      requirements: ConfigurationValidationRequirement[];
    }
  | { status: "retired"; collectorVersion: string }
  | { status: "unavailable"; message: string; retryAt?: number };

/** An outcome, with exactly what it is for: the version, the text and the pin on screen when it was asked. */
export interface CollectorValidation {
  versionId: string;
  text: string;
  collectorVersion: string | null;
  outcome: CollectorValidationOutcome;
}

/** The two outcomes the selector makes itself, one object each (a selector must answer the same object for the same state). */
export const VALIDATION_IDLE: CollectorValidationOutcome = Object.freeze({ status: "idle" });
export const VALIDATION_VALIDATING: CollectorValidationOutcome = Object.freeze({ status: "validating" });

export type EditorState = {
  /** The configuration open in the editor; null until one is loaded. */
  configuration: Configuration | null;
  /** The version the editor opened, whose YAML a save overwrites. */
  version: ConfigurationVersion | null;
  /**
   * Every version of the configuration, highest number first, as the picker
   * lists them (D10 decisions 4 and 10); empty until one is loaded.
   */
  versions: ConfigurationVersionSummary[];
  /**
   * The organization the configuration was loaded in. Saves name it, never
   * the session's current active organization, which another tab can switch
   * (Preflight ruling 4); the API then refuses the save and the text stays.
   */
  organizationId: string | null;
  /**
   * How many times a configuration has been loaded, ever; `reset` keeps it.
   * A save compares it to tell a late answer from the open configuration's:
   * leaving and opening the same configuration again loads the same version
   * in the same organization, but not the same load.
   */
  loadCount: number;
  /** The YAML as it is in the editor now: the content (D9a decision 2). */
  text: string;
  /**
   * The YAML as last loaded or saved, or as a re-read found it
   * (`replaceVersion`). On a published version it is what was published:
   * this tab's own publish published its save (Ruling 30), and a re-read
   * after a teammate's publish takes the version's content (Ruling 35).
   */
  savedText: string;
  /**
   * The open version's collector version as it is on screen (D13a decision
   * 8): the toolbar's pick, which Save stores with the text; null until a
   * version is loaded. A pick differing from `savedCollectorVersion` is an
   * unsaved change (`selectIsDirty`), and is what "this tab picked one"
   * means (Ruling 37): only then does a save or a create send it. Otherwise
   * the picker is untouched, and it follows the server's pin: a save's
   * answer's (`markSaved`) and a re-read's (`replaceVersion`).
   */
  collectorVersion: string | null;
  /**
   * The collector version as last loaded or saved, or as a re-read found it
   * (`replaceVersion`), as `savedText` is the text's.
   */
  savedCollectorVersion: string | null;
  /**
   * How many picks this load has seen (`setCollectorVersion`). A save
   * notes it when it sends, so its answer can tell a pick made meanwhile,
   * even one that picked the old saved pin back, from an untouched picker
   * (`markSaved`; Ruling 37). A load starts it again at 0.
   */
  collectorVersionPicks: number;
  isSaving: boolean;
  /**
   * Whether the picker's create is under way (`useCreateVersion`): a save
   * meanwhile does nothing, as a create does while a save is under way (D10
   * decision 10, Ruling 30). A load clears it, as it clears `isSaving`.
   */
  isCreatingVersion: boolean;
  /**
   * Whether a publish is under way (`usePublishVersion`; D11b decision 5): a
   * save or a create meanwhile does nothing, as one does while the other is
   * under way, except the save the publish itself makes first. A load
   * clears it.
   */
  isPublishing: boolean;
  /** The panel's tab, by id; null for the layout's first. */
  activeTab: string | null;
  panelCollapsed: boolean;
  panelWidth: number;

  // ── The builder (D9a) ──
  /** The canvas's nodes, edges and pipelines: a view of the text, with the layout. */
  graph: Graph;
  /**
   * The parse of the text the graph was last written from or read from,
   * reused by the next change (a parse of a very large text costs about
   * 220 ms). In manual edit mode it is still the text from before the
   * typing; null while the canvas can't show the text.
   */
  document: ParsedText | null;
  graphStatus: GraphStatus;
  /** `layoutSignature` of the graph as last loaded or saved (or re-read: `savedText`). */
  savedLayout: string;
  /** The graph as last loaded or saved (or re-read: `savedText`), for Discard. */
  savedGraph: Graph;
  /** The selected node (a component or a group), as the Configuration tab reads it. */
  selectedNode: OTelNode | null;
  /** The selected components (never groups), for multi-selection. */
  selectedNodes: OTelNode[];
  /** Manual edit mode: the text was typed in the YAML tab and isn't on the canvas yet. */
  isYamlEditing: boolean;
  /** The text from before the typing began, which Undo All puts back on a draft. */
  preEditText: string | null;
  history: History;
  /** The run of changes the last undo entry covers, for the throttle. */
  historyRun: { key: string; at: number } | null;
  /** Bumped by Tidy up, so the canvas fits the view to the new layout. */
  layoutRevision: number;
  /** Bumped when the canvas should mount afresh (a load, Clear canvas). */
  canvasKey: number;
  /** What the delete dialog is asking about; null while it's closed. */
  pendingDelete: DeleteTarget | null;
  /**
   * The collector validator's last answer kept (D13b decision 13), for the
   * text, pin and version it was asked about; null before any. Written by
   * `useCollectorValidation` alone; read through `selectCollectorValidation`,
   * which shows it only while exactly that text and pin are on screen.
   */
  validation: CollectorValidation | null;

  /**
   * Opens a version: the text and layout are its own, and everything about
   * the one open before goes (the undo history, manual edit mode, the
   * selection; D10 decision 13); the panel stays. `versions` is the list to
   * show, the version's own summary alone when not given.
   */
  load: (loaded: {
    organizationId: string;
    configuration: Configuration;
    version: ConfigurationVersion;
    versions?: ConfigurationVersionSummary[];
  }) => void;
  /**
   * Opens a version the page itself just created from the open one (D10
   * decision 11), as a load in the same configuration and organization: its
   * saved text and layout are what was sent, so it is clean; the undo
   * history is cleared and the canvas mounts afresh. Its summary goes first
   * in `versions`. A save still under way is forgotten: its answer is for
   * the source (Preflight ruling 14). Does nothing with no configuration
   * open.
   */
  adoptCreatedVersion: (version: ConfigurationVersion) => void;
  /** A rename's label (D10 decision 12): in the version's summary, and in the open version when it is that one. */
  setVersionLabel: (versionId: string, label: string | null) => void;
  /**
   * Typing in the YAML tab (Monaco's own changes, never a value the store
   * set): the text changes and, the first time, manual edit mode begins.
   */
  setText: (text: string) => void;
  /**
   * The toolbar's collector version pick (D13a decision 8): on screen, an
   * unsaved change until Save stores it. Refused (nothing changes) on a
   * published version, which is read-only (D11b decision 4), and with no
   * version open. It isn't an undo entry, and changes neither the text nor
   * the canvas. Each pick counts (`collectorVersionPicks`).
   */
  setCollectorVersion: (collectorVersion: string) => void;
  /**
   * Records a save. `text` is the text that was sent, not the editor's text
   * now: typing during the save leaves the editor dirty (D8 decision 5).
   * `graph` is the graph that was sent (the editor's now when not given).
   * The open version's summary takes the save's time (the picker's "last
   * saved"; D10 decision 10). The open version keeps the label it shows: a
   * rename answered before the save's answer must not be undone by it.
   * The saved collector version is the answer's: the pin that was sent, or,
   * when none was (an untouched picker), the one the server kept, which may
   * be a teammate's (Ruling 37). An untouched picker then shows it; a pick
   * made during the save (`collectorVersionPicks` moved past `picks`, the
   * count when the save was sent; by default no pick) stays on screen,
   * unsaved, as typing does, even one that picked the old saved pin back.
   */
  markSaved: (text: string, version: ConfigurationVersion, graph?: Graph, picks?: number) => void;
  setSaving: (isSaving: boolean) => void;
  setCreatingVersion: (isCreatingVersion: boolean) => void;
  setPublishing: (isPublishing: boolean) => void;
  /**
   * A version's summary as the API answered it since (a publish's 200; D11b
   * Preflight rulings 11 and 12): in `versions`, and in the open version
   * when it is that one, whose text, graph, history and canvas stay as they
   * are (no reload). The saved text stays the baseline: this tab's publish
   * published exactly its save (Ruling 30). A version it makes published
   * locks the editor (`selectIsVersionPublished`). If the editor is clean
   * and in manual edit mode then (a save in the mode, then the publish), the
   * mode ends with the saved text on the canvas, as opening the version
   * would show it; text typed since is kept, as it is.
   */
  replaceVersionSummary: (summary: ConfigurationVersionSummary) => void;
  /**
   * A version as a re-read answered it whole (`rereadVersion`, after a 409
   * `configuration_version_published`: a teammate published it; Ruling 35).
   * Its summary goes in `versions`. When it is the open version, it becomes
   * the open version and its content the saved baseline (`savedText`, the
   * saved graph and layout, and its collector version), read as opening it
   * reads them, since what this
   * tab last loaded or saved may not be what was published. The text and
   * layout are decided apart from the pin (D13a Ruling 41). Clean text and
   * layout then show that content, as a clean load would (out of manual edit
   * mode, nothing selected), whatever the pin; unsaved text or layout (a
   * stale tab, Preflight ruling 12) stays on screen, dirty against it, for
   * the banner's create to carry, and Undo All and Discard put back the
   * published content. The collector version follows whoever last picked it
   * (D13a Rulings 35 and 37): a pick this tab made stays on screen, with the
   * unsaved text or with the version's, while an untouched picker takes the
   * version's pin, even with unsaved text (a teammate's pick, which the
   * banner's create then carries). So a tab that only picked shows a
   * teammate's published text with its pick, which the banner's create
   * carries together. Either way the undo history stays, inert while the
   * version is published, and the canvas isn't mounted afresh (no reload).
   */
  replaceVersion: (version: ConfigurationVersion) => void;
  renameConfiguration: (name: string) => void;
  /**
   * Shows another tab of the panel. Every held edit is written first
   * (`flushHeldEdits`; Rulings 86 and 89), whoever switches (the tab list,
   * the rail, a selection, the tour): the Configuration tab stays mounted
   * while hidden, so its fields no longer write by going, and the YAML tab
   * never shows text missing an edit a field holds. Naming the tab already
   * named does nothing. A flush that throws holds the switch.
   */
  setActiveTab: (activeTab: string | null) => void;
  setPanelCollapsed: (collapsed: boolean) => void;
  setPanelWidth: (width: number) => void;
  /** Forgets the configuration and its text; the layout's state stays. */
  reset: () => void;
  /** Back to the text, layout and collector version last loaded or saved (the Unsaved Changes dialog's Discard). */
  discardChanges: () => void;

  /** Manual edit mode's Apply: the typed text onto the canvas, keeping the layout where it matches. */
  apply: () => ApplyResult;
  /**
   * Manual edit mode's Undo All: the text from before the typing, and out of
   * the mode. A published version takes it too (Ruling 31), so a stale tab
   * locked in the mode can leave it: there it puts back the published text
   * and graph, clean (Ruling 34). It changes only what is on screen.
   */
  undoAll: () => void;
  /** Undoes the last change, text and graph together. False when there was nothing to undo, or in manual edit mode. */
  undo: () => boolean;
  /** Redoes the last undone change. */
  redo: () => boolean;

  /** React Flow's node changes: selection and measurement as they come; moves and group resizes as changes. */
  applyNodeChanges: (changes: NodeChange<OTelNode>[]) => void;
  /** React Flow's edge changes: selection only (removals go through the delete path). */
  applyEdgeChanges: (changes: EdgeChange<OTelEdge>[]) => void;
  /** A drag's end: each dragged component joins the group it was dropped on, or leaves its own. */
  finishMove: (nodeIds: readonly string[]) => boolean;
  /** Puts a component in a group (or in none, for null), where it is on the canvas. */
  moveNodeToGroup: (nodeId: string, groupId: string | null) => boolean;
  /** Resizes a group; its children left outside leave it. */
  resizeGroup: (groupId: string, size: { width: number; height: number }) => boolean;
  /** Drops a palette entry at an absolute canvas position, into the group there; the new node is selected. */
  dropComponent: (paletteId: string, position: Point) => OTelNode | null;
  /** Draws a connection, adopting an ungrouped end into the other's group. */
  connect: (connection: Pick<Connection, "source" | "target"> & Partial<Connection>) => ConnectResult;
  /** Opens the delete dialog for `target`, or for the selection; a selected connection alone is deleted at once. */
  requestDelete: (target?: DeleteTarget) => void;
  /** The delete dialog's Delete. */
  confirmDelete: () => void;
  /** The delete dialog's Cancel: nothing is deleted. */
  cancelDelete: () => void;
  /** Deletes components (a group among them deletes its pipeline, with its components). */
  deleteNodes: (nodeIds: readonly string[]) => boolean;
  /** Deletes connections. */
  deleteEdges: (edgeIds: readonly string[]) => boolean;
  /** Duplicates a component: into `groupId`'s pipeline, or in place beside it when none. Never a group. */
  duplicateNode: (nodeId: string, groupId?: string) => OTelNode | null;
  /** Duplicates the selected components in place. */
  duplicateSelectedNodes: () => OTelNode[];
  /** Adds the component to another pipeline, as the same component (one entry in the text). */
  linkNodeToGroup: (nodeId: string, groupId: string) => OTelNode | null;
  /** Adds an empty pipeline, with the first unused colour unless one is given. Null for a name already used. */
  addPipeline: (name: string, color?: string) => Pipeline | null;
  setPipelineColor: (pipelineId: string, color: string) => boolean;
  /** Deletes a pipeline, its group and its components. */
  deletePipeline: (pipelineId: string) => boolean;
  /** Renames a component's instance: its label and its key in the text, linking nodes that come to share it. */
  renameInstance: (nodeId: string, instanceName: string) => boolean;
  /** The Configuration tab's YAML box: the component's value becomes the box's. */
  setComponentValue: (nodeId: string, boxText: string) => ComponentValueResult;
  /**
   * A component's form: `changes` written by key path under the
   * component's value, in place (D9b decision 2). One entry per run of
   * changes to the node within 800 ms, shared with the YAML box.
   *
   * A routing or failover connector's target choices are wired into the
   * pipelines' receivers in the same write (D9d decision 8;
   * `wireConnectorReceivers`), with a toast; a wiring the text edits can't
   * write refuses the whole change. The YAML box doesn't wire.
   */
  setComponentValues: (nodeId: string, changes: readonly ValueChange[]) => ValuesResult;
  /**
   * The Self-monitoring dialog's Apply: `changes` written by key path under
   * `service.telemetry` (D9b decision 7), one entry. False when nothing was
   * written: no changes, a text that would read the same, a locked canvas,
   * or a change the text edits can't write (which toasts).
   */
  setTelemetryValues: (changes: readonly ValueChange[], description?: string) => boolean;
  /** Remove Section: `service.telemetry`'s lines removed, one entry. False when there is none, or locked. */
  removeTelemetry: () => boolean;
  /** Lays the canvas out again; the text isn't touched. */
  tidyUp: () => boolean;
  /** Removes every component and pipeline, leaving the three empty defaults (D9a decision 15). */
  clearCanvas: () => boolean;
  /** The validator's answer for a text (`useCollectorValidation`'s); nothing else changes. */
  setValidation: (validation: CollectorValidation) => void;
  /** Selects one node (a component or a group), or none. */
  selectNode: (nodeId: string | null) => void;
  /** React Flow's selection (`onSelectionChange`). */
  setSelection: (nodeIds: readonly string[]) => void;
};

const NOTHING_LOADED = {
  configuration: null,
  version: null,
  versions: [],
  organizationId: null,
  text: "",
  savedText: "",
  collectorVersion: null,
  savedCollectorVersion: null,
  collectorVersionPicks: 0,
  isSaving: false,
  isCreatingVersion: false,
  isPublishing: false,
  graph: EMPTY_GRAPH,
  document: null,
  graphStatus: "ready",
  savedLayout: layoutSignature(EMPTY_GRAPH),
  savedGraph: EMPTY_GRAPH,
  selectedNode: null,
  selectedNodes: [],
  isYamlEditing: false,
  preEditText: null,
  history: { past: [], future: [] },
  historyRun: null,
  pendingDelete: null,
  validation: null,
} satisfies Partial<EditorState>;

// The model each document describes, read once.
const models = new WeakMap<ParsedText, Model>();

function modelOf(document: ParsedText): Model {
  let model = models.get(document);
  if (!model) {
    model = readTextModel(document);
    models.set(document, model);
  }
  return model;
}

/** The text read for the canvas: its document, or why it can't be shown. */
function readFor(text: string): { document: ParsedText | null; graphStatus: GraphStatus } {
  const read = readText(text);
  return read.ok ? { document: read.document, graphStatus: "ready" } : { document: null, graphStatus: { unreadable: read.reason } };
}

function labelOf(node: OTelNode): string {
  return node.data.label || node.data.componentSubType;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The selection, pointed at `graph`'s nodes: those still there. */
function selectionIn(
  graph: Graph,
  selectedNodeId: string | null | undefined,
  selectedIds: readonly string[],
): Pick<EditorState, "selectedNode" | "selectedNodes"> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const selectedNodes = selectedIds.map((id) => byId.get(id)).filter((n): n is OTelNode => n !== undefined && !isGroup(n));
  return {
    selectedNode: selectedNodeId == null ? null : (byId.get(selectedNodeId) ?? null),
    selectedNodes,
  };
}

/**
 * A version's text and graph as opening it shows them (`load`): the graph
 * read from its text, arranged by its stored layout; none when the canvas
 * can't show the text.
 */
function openedFrom(version: ConfigurationVersion): Pick<EditorState, "text" | "graph" | "document" | "graphStatus"> {
  const text = version.yamlContent;
  const parsed = parse(text);
  const graph = parsed.ok ? matchLayout(parsed.graph, fromStored(version)) : EMPTY_GRAPH;
  return {
    text,
    graph,
    document: parsed.ok ? parsed.document : null,
    graphStatus: parsed.ok ? "ready" : { unreadable: parsed.reason },
  };
}

/** The saved baseline a text and graph opened (`openedFrom`) are clean against. */
function savedFrom({
  text,
  graph,
}: Pick<EditorState, "text" | "graph">): Pick<EditorState, "savedText" | "savedGraph" | "savedLayout"> {
  return { savedText: text, savedGraph: graph, savedLayout: layoutSignature(graph) };
}

/**
 * Whether the text or the layout on screen differs from a baseline's
 * (`selectIsDirty` without the pin; Ruling 41).
 */
function textOrLayoutDiffers(
  { text, graph }: Pick<EditorState, "text" | "graph">,
  { savedText, savedLayout }: Pick<EditorState, "savedText" | "savedLayout">,
): boolean {
  return text !== savedText || layoutSignature(graph) !== savedLayout;
}

/** A version's collector version, on screen and as its saved baseline (D13a decision 8). */
function pinnedFrom(version: ConfigurationVersion): Pick<EditorState, "collectorVersion" | "savedCollectorVersion"> {
  return { collectorVersion: version.collectorVersion, savedCollectorVersion: version.collectorVersion };
}

/**
 * A published version out of manual edit mode: the saved text on the
 * canvas, arranged by the saved layout, as opening the version would show it
 * (`discardChanges`' reading), so the editor is clean. The saved text is
 * what was published (`savedText`; Rulings 30 and 35). The undo history
 * stays, inert while the version is read-only.
 */
function backToPublished(state: EditorState): Partial<EditorState> {
  const parsed = parse(state.savedText);
  const graph = parsed.ok ? matchLayout(parsed.graph, state.savedGraph) : state.savedGraph;
  return {
    text: state.savedText,
    graph,
    document: parsed.ok ? parsed.document : null,
    graphStatus: parsed.ok ? "ready" : { unreadable: parsed.reason },
    savedGraph: graph,
    savedLayout: layoutSignature(graph),
    // The published pin, as the text: an unsaved pick (a stale tab's) goes too.
    collectorVersion: state.savedCollectorVersion,
    isYamlEditing: false,
    preEditText: null,
    historyRun: null,
    ...selectionIn(graph, state.selectedNode?.id, state.selectedNodes.map((n) => n.id)),
  };
}

/** `nodes` with exactly `ids` selected (React Flow shows the flags). */
function withSelectedFlags(nodes: OTelNode[], ids: ReadonlySet<string>): OTelNode[] {
  return nodes.map((node) => {
    const selected = ids.has(node.id);
    return (node.selected ?? false) === selected ? node : { ...node, selected };
  });
}

/** A change to the graph, for `commit`. */
interface Change {
  graph: Graph;
  /** Only the layout changed (a move, a resize, a colour, Tidy up): the text isn't touched. */
  layoutOnly?: boolean;
  /** Instance renames, which the text edits write in place (a model's difference can't tell them). */
  renames?: ComponentRename[];
  /** The text as another writer already edited it (the YAML box). */
  written?: EditedText;
  /** The node to select alone afterwards; otherwise the selection stays where its nodes do. */
  select?: string | null;
  /** More state to set with the change. */
  extra?: Partial<EditorState>;
}

/**
 * The editor's shared memory (D8 decision 8): the YAML tab, the toolbar, the
 * page and the canvas read and write it, and no editor state is threaded
 * through props between them.
 *
 * The builder's half (D9a decisions 2, 4, 5, 8, 11, 15): every change to the
 * graph runs in one place (`commit`): it takes an undo entry holding the
 * text and the graph from before (one per run of changes to one node within
 * 800 ms), applies the change to the graph, and writes it into the text as a
 * targeted edit, from the text's own model (Preflight ruling 5). A change
 * the edits can't write is refused whole: the graph and the text stay as
 * they were, no entry is kept, and a toast says to edit the YAML. Layout
 * changes (moves, resizes, colours, Tidy up) don't touch the text. Nothing
 * else writes the text but typing, Apply, Undo All, undo and redo; opening a
 * version never does.
 *
 * Deliberately not persisted, like the UI state store. It is written only
 * from effects and event handlers, so a server render never writes it.
 *
 * `reset` keeps the load count, the active tab and the panel's collapse and
 * width: opening another configuration, or coming back to the editor, finds
 * the panel as it was left, for the whole session.
 */
export const useEditorStore = create<EditorState>()((set, get) => {
  /**
   * Every change is refused: manual edit mode, text the canvas can't show, or
   * a published version, which is read-only (D11b decision 4; Preflight
   * ruling 11): its selection, focus, pan and zoom still work.
   */
  const locked = (state: EditorState) =>
    state.isYamlEditing || state.document === null || selectIsVersionPublished(state);

  /**
   * The one place a change to the graph happens. False when it was refused
   * (locked, or the text edits can't write it; that one toasts).
   */
  const commit = (description: string, throttle: string | undefined, change: Change | null): boolean => {
    const state = get();
    if (!change || locked(state) || state.document === null) return false;

    let edited = change.written;
    if (!edited && !change.layoutOnly) {
      const textModel = modelOf(state.document);
      // A renamed component keeps its place in the lists that name it.
      const order = change.renames?.length ? renamedModel(textModel, change.renames) : textModel;
      try {
        edited = editText(state.text, textModel, deriveModel(change.graph, order), {
          renames: change.renames ?? [],
          document: state.document,
        });
      } catch (error) {
        if (!(error instanceof TextEditError)) throw error;
        toast.error(CANT_EDIT_ON_CANVAS_MESSAGE);
        return false;
      }
    }
    if (edited) models.set(edited.document, edited.model);

    const now = Date.now();
    const run = state.historyRun;
    const continues = throttle !== undefined && run?.key === throttle && now - run.at < HISTORY_THROTTLE_MS;
    const past = continues
      ? state.history.past
      : [...state.history.past, { text: state.text, graph: state.graph, description }].slice(-HISTORY_DEPTH);

    let nodes = ensureParentChildOrder(change.graph.nodes);
    let selection: Pick<EditorState, "selectedNode" | "selectedNodes">;
    if (change.select !== undefined) {
      const ids = new Set(change.select === null ? [] : [change.select]);
      nodes = withSelectedFlags(nodes, ids);
      selection = selectionIn({ ...change.graph, nodes }, change.select, [...ids]);
    } else {
      selection = selectionIn(
        { ...change.graph, nodes },
        state.selectedNode?.id,
        state.selectedNodes.map((n) => n.id),
      );
    }
    set({
      ...change.extra,
      graph: { ...change.graph, nodes },
      ...(edited ? { text: edited.text, document: edited.document } : {}),
      history: { past, future: [] },
      historyRun: throttle === undefined ? null : { key: throttle, at: now },
      ...selection,
    });
    return true;
  };

  /** Sets the graph without an entry: selection and measurement, which never dirty the editor. */
  const passive = (nodes: OTelNode[], edges: OTelEdge[]) => {
    const state = get();
    if (nodes === state.graph.nodes && edges === state.graph.edges) return;
    const graph = { ...state.graph, nodes, edges };
    set({ graph, ...selectionIn(graph, state.selectedNode?.id, state.selectedNodes.map((n) => n.id)) });
  };

  /** Restores an entry (undo, redo): its text and graph, the selection kept where its nodes are. */
  const restore = (entry: HistoryEntry, history: History) => {
    const state = get();
    const selectedIds = new Set([
      ...state.selectedNodes.map((n) => n.id),
      ...(state.selectedNode ? [state.selectedNode.id] : []),
    ]);
    const graph = { ...entry.graph, nodes: withSelectedFlags(entry.graph.nodes, selectedIds) };
    set({
      text: entry.text,
      graph,
      ...readFor(entry.text),
      history,
      historyRun: null,
      ...selectionIn(graph, state.selectedNode?.id, state.selectedNodes.map((n) => n.id)),
    });
  };

  const findNode = (id: string) => get().graph.nodes.find((node) => node.id === id);

  /**
   * `changes` written under `base` in the text, for a form or the dialog:
   * the edited text, or "unchanged" when there are none or the text would
   * read the same (Preflight ruling 12), or "refused" when the text edits
   * can't write them (the toast; D9a decision 4). The caller has checked
   * that the canvas isn't locked.
   */
  const writeUnder = (
    state: EditorState,
    document: ParsedText,
    base: ValuePath,
    changes: readonly ValueChange[],
  ): EditedText | "unchanged" | "refused" => {
    if (changes.length === 0) return "unchanged";
    let written: EditedText;
    try {
      written = writeValues(state.text, base, changes, document);
    } catch (error) {
      if (!(error instanceof TextEditError)) throw error;
      toast.error(CANT_EDIT_ON_CANVAS_MESSAGE);
      return "refused";
    }
    return written.text === state.text ? "unchanged" : written;
  };

  /** Telemetry isn't in the model: the graph stays as it is, and the entry holds it with the text. */
  const writeTelemetry = (description: string, base: ValuePath, changes: readonly ValueChange[]): boolean => {
    const state = get();
    if (locked(state) || state.document === null) return false;
    const written = writeUnder(state, state.document, base, changes);
    if (typeof written === "string") return false;
    return commit(description, undefined, { graph: state.graph, written });
  };

  /**
   * Deleting nodes: a group takes its pipeline and its components with it;
   * a processor in a pipeline's chain closes it, its neighbours joined in
   * the same change (D9d Ruling 36).
   */
  const withoutNodes = (graph: Graph, nodeIds: ReadonlySet<string>): Graph => {
    let { nodes, pipelines } = graph;
    let edges = closedChains(nodes, graph.edges, nodeIds);
    for (const group of graph.nodes.filter((n) => isGroup(n) && nodeIds.has(n.id))) {
      ({ nodes, edges } = pruneGroupChildren(nodes, edges, group.id));
      pipelines = pipelines.filter((p) => p.id !== group.data.pipelineId);
    }
    nodes = nodes.filter((n) => !nodeIds.has(n.id));
    const kept = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
    return { nodes, edges, pipelines };
  };

  const moveToGroup = (graph: Graph, nodeIds: readonly string[], pick: (node: OTelNode) => OTelNode | undefined) => {
    let changed = false;
    const nodes = graph.nodes.map((node) => {
      if (!nodeIds.includes(node.id) || isGroup(node)) return node;
      const group = pick(node);
      if ((group?.id ?? undefined) === node.parentId) return node;
      changed = true;
      return reparented(node, group, graph.nodes);
    });
    return changed ? { ...graph, nodes } : undefined;
  };

  return {
    ...NOTHING_LOADED,
    loadCount: 0,
    activeTab: null,
    panelCollapsed: false,
    panelWidth: DEFAULT_PANEL_WIDTH,
    layoutRevision: 0,
    canvasKey: 0,

    load: ({ organizationId, configuration, version, versions = [summaryOf(version)] }) => {
      const opened = openedFrom(version);
      set(({ loadCount, canvasKey }) => ({
        ...NOTHING_LOADED,
        organizationId,
        configuration,
        version,
        versions,
        loadCount: loadCount + 1,
        canvasKey: canvasKey + 1,
        ...opened,
        ...savedFrom(opened),
        ...pinnedFrom(version),
      }));
    },
    setText: (text) => {
      const state = get();
      if (text === state.text || selectIsVersionPublished(state)) return;
      if (state.isYamlEditing) {
        set({ text });
        return;
      }
      set({ text, isYamlEditing: true, preEditText: state.text, historyRun: null });
      toast.info(ENTERED_MANUAL_EDIT_MESSAGE);
    },
    setCollectorVersion: (collectorVersion) => {
      const state = get();
      if (state.version === null || selectIsVersionPublished(state) || collectorVersion === state.collectorVersion) return;
      set({ collectorVersion, collectorVersionPicks: state.collectorVersionPicks + 1 });
    },
    adoptCreatedVersion: (version) => {
      const { organizationId, configuration, versions } = get();
      if (organizationId === null || configuration === null) return;
      get().load({
        organizationId,
        configuration,
        version,
        versions: [summaryOf(version), ...versions.filter((summary) => summary.id !== version.id)],
      });
    },
    setVersionLabel: (versionId, label) =>
      set(({ version, versions }) => ({
        versions: versions.map((summary) => (summary.id === versionId ? { ...summary, label } : summary)),
        ...(version?.id === versionId ? { version: { ...version, label } } : {}),
      })),
    markSaved: (text, version, graph, picks) => {
      const saved = graph ?? get().graph;
      set(({ versions, version: open, collectorVersion, collectorVersionPicks }) => ({
        savedText: text,
        savedCollectorVersion: version.collectorVersion,
        // Untouched during the save: the server's pin (Ruling 37); a pick made meanwhile stays.
        collectorVersion: collectorVersionPicks === (picks ?? collectorVersionPicks) ? version.collectorVersion : collectorVersion,
        // The label shown now: a rename answered before this save's answer
        // is newer than the label the save read (D10 Ruling 25).
        version: open?.id === version.id ? { ...version, label: open.label } : version,
        versions: versions.map((summary) =>
          summary.id === version.id ? { ...summary, updatedAt: version.updatedAt } : summary,
        ),
        savedLayout: layoutSignature(saved),
        savedGraph: saved,
      }));
    },
    setSaving: (isSaving) => set({ isSaving }),
    setCreatingVersion: (isCreatingVersion) => set({ isCreatingVersion }),
    setPublishing: (isPublishing) => set({ isPublishing }),
    replaceVersionSummary: (summary) => {
      const state = get();
      const replaced = summaryOf(summary);
      const opensIt = state.version?.id === replaced.id;
      const leavesManualEdit =
        opensIt && replaced.publishedAt !== null && state.isYamlEditing && !selectIsDirty(state);
      set({
        versions: state.versions.map((row) => (row.id === replaced.id ? replaced : row)),
        ...(opensIt && state.version !== null ? { version: { ...state.version, ...replaced } } : {}),
      });
      if (leavesManualEdit) set(backToPublished(state));
    },
    replaceVersion: (version) => {
      const state = get();
      if (state.version?.id !== version.id) {
        state.replaceVersionSummary(version);
        return;
      }
      const opened = openedFrom(version);
      const saved = { ...savedFrom(opened), savedCollectorVersion: version.collectorVersion };
      // A pick (the pin on screen isn't the saved one) stays on screen, for
      // the banner's create to carry (Ruling 30); an untouched picker takes
      // the version's pin, whoever picked it (Rulings 35 and 37).
      const picked = state.collectorVersion !== state.savedCollectorVersion;
      const collectorVersion = picked ? state.collectorVersion : version.collectorVersion;
      // The text and layout apart from the pin (Ruling 41): clean before, or
      // what is on screen is the version's content anyway, the screen shows
      // the version's, as a clean load would, a pick or not.
      const showsIt = !textOrLayoutDiffers(state, state) || !textOrLayoutDiffers(state, saved);
      const summary = summaryOf(version);
      set({
        versions: state.versions.map((row) => (row.id === summary.id ? summary : row)),
        version,
        ...saved,
        collectorVersion,
        ...(showsIt
          ? {
              ...opened,
              isYamlEditing: false,
              preEditText: null,
              historyRun: null,
              selectedNode: null,
              selectedNodes: [],
              pendingDelete: null,
            }
          : {}),
      });
    },
    renameConfiguration: (name) =>
      set(({ configuration }) => (configuration === null ? {} : { configuration: { ...configuration, name } })),
    setActiveTab: (activeTab) => {
      if (activeTab === get().activeTab) return;
      flushHeldEdits();
      set({ activeTab });
    },
    setPanelCollapsed: (panelCollapsed) => set({ panelCollapsed }),
    setPanelWidth: (panelWidth) => set({ panelWidth }),
    reset: () => set(NOTHING_LOADED),
    discardChanges: () => {
      const { savedText, savedGraph, savedCollectorVersion } = get();
      // The graph from the saved text, arranged by the saved layout, as a
      // reload would show them: a save in manual edit mode saved the typed
      // text with the graph from before the typing.
      const parsed = parse(savedText);
      const graph = parsed.ok ? matchLayout(parsed.graph, savedGraph) : savedGraph;
      set({
        text: savedText,
        graph,
        document: parsed.ok ? parsed.document : null,
        graphStatus: parsed.ok ? "ready" : { unreadable: parsed.reason },
        savedGraph: graph,
        savedLayout: layoutSignature(graph),
        collectorVersion: savedCollectorVersion,
        isYamlEditing: false,
        preEditText: null,
        history: { past: [], future: [] },
        historyRun: null,
        selectedNode: null,
        selectedNodes: [],
        pendingDelete: null,
      });
    },

    // ── Manual edit mode ──

    apply: () => {
      const state = get();
      if (!state.isYamlEditing) return { ok: false, reason: "There are no typed changes to apply." };
      if (selectIsVersionPublished(state)) return { ok: false, reason: "This version is published and can't be changed." };
      const parsed = parse(state.text);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const graph = matchLayout(parsed.graph, state.graph);
      // The entry holds the text from before the typing with the graph from
      // before Apply, so undoing Apply restores both (decision 11), never the
      // old graph with the new text.
      const entry: HistoryEntry = { text: state.preEditText ?? state.text, graph: state.graph, description: "Edit YAML" };
      set({
        graph,
        document: parsed.document,
        graphStatus: "ready",
        isYamlEditing: false,
        preEditText: null,
        history: { past: [...state.history.past, entry].slice(-HISTORY_DEPTH), future: [] },
        historyRun: null,
        selectedNode: null,
        selectedNodes: [],
      });
      toast.success(CHANGES_APPLIED_MESSAGE);
      return { ok: true };
    },
    undoAll: () => {
      const state = get();
      if (!state.isYamlEditing) return;
      if (selectIsVersionPublished(state)) {
        // Allowed on a published version too (Ruling 31), so a stale tab
        // locked in manual edit mode (Preflight ruling 12) can leave it and
        // inspect the canvas. It puts back what was published, text and
        // graph, not the text from before the typing, which may hold canvas
        // changes never saved: those could never be saved now, and would
        // leave the editor dirty for good (Ruling 34). Nothing stored changes.
        set(backToPublished(state));
      } else {
        // The document is still the one from before the typing.
        set({ text: state.preEditText ?? "", isYamlEditing: false, preEditText: null, historyRun: null });
      }
      toast.info(CHANGES_REVERTED_MESSAGE);
    },

    // ── Undo and redo ──

    undo: () => {
      const state = get();
      const entry = state.history.past.at(-1);
      if (state.isYamlEditing || selectIsVersionPublished(state) || !entry) return false;
      restore(entry, {
        past: state.history.past.slice(0, -1),
        future: [...state.history.future, { text: state.text, graph: state.graph, description: entry.description }],
      });
      toast.info(`Undo: ${entry.description}`, { className: "ph-no-capture" });
      return true;
    },
    redo: () => {
      const state = get();
      const entry = state.history.future.at(-1);
      if (state.isYamlEditing || selectIsVersionPublished(state) || !entry) return false;
      restore(entry, {
        past: [...state.history.past, { text: state.text, graph: state.graph, description: entry.description }].slice(
          -HISTORY_DEPTH,
        ),
        future: state.history.future.slice(0, -1),
      });
      toast.info(`Redo: ${entry.description}`, { className: "ph-no-capture" });
      return true;
    },

    // ── React Flow's changes ──

    applyNodeChanges: (changes) => {
      const isResize = (change: NodeChange<OTelNode>) =>
        change.type === "dimensions" && (typeof change.resizing === "boolean" || Boolean(change.setAttributes));
      const quiet = changes.filter((c) => c.type === "select" || (c.type === "dimensions" && !isResize(c)));
      const moves = changes.filter((c) => c.type === "position" || isResize(c));

      const state = get();
      const before = state.graph;
      const quietNodes = quiet.length > 0 ? applyFlowNodeChanges(quiet, before.nodes) : before.nodes;
      if (moves.length === 0 || locked(state)) {
        passive(quietNodes, before.edges);
        return;
      }

      let nodes = applyFlowNodeChanges(moves, quietNodes);
      let detached = false;
      const resized: OTelNode[] = [];
      for (const change of moves) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const group = nodes.find((n) => n.id === change.id);
        if (!group || !isGroup(group)) continue;
        const { width, height } = change.dimensions;
        // The size lives in `style` alone. React Flow's resizer also sets the
        // node's `width` and `height`, which it draws in preference to
        // `style`: left there, a later size in `style` (Tidy up's, an undo's)
        // would be saved but not drawn.
        nodes = nodes.map((n) => {
          if (n.id !== group.id) return n;
          const { width: _drawnWidth, height: _drawnHeight, ...rest } = n;
          return { ...rest, style: { ...n.style, width, height } };
        });
        const result = detachOutside(nodes, group.id, width, height);
        nodes = result.nodes;
        detached ||= result.detached;
        resized.push(group);
      }

      const graph = { ...before, nodes };
      if (!detached && layoutSignature(graph) === layoutSignature({ ...before, nodes: quietNodes })) {
        passive(nodes, before.edges);
        return;
      }
      const ids = [...new Set(moves.map((c) => ("id" in c ? c.id : "")))].sort();
      const moved = ids.map((id) => before.nodes.find((n) => n.id === id)).filter((n): n is OTelNode => n !== undefined);
      const description =
        resized.length > 0
          ? `Resize ${labelOf(resized[0]!)}`
          : moved.length === 1
            ? `Move ${labelOf(moved[0]!)}`
            : `Move ${plural(moved.length, "node")}`;
      commit(description, `layout:${ids.join(",")}`, { graph, layoutOnly: !detached });
    },
    applyEdgeChanges: (changes) => {
      const selections = changes.filter((c) => c.type === "select");
      if (selections.length === 0) return;
      const { graph } = get();
      passive(graph.nodes, applyFlowEdgeChanges(selections, graph.edges));
    },
    finishMove: (nodeIds) => {
      const state = get();
      const moved = nodeIds.map((id) => state.graph.nodes.find((n) => n.id === id)).filter((n): n is OTelNode => !!n);
      const graph = moveToGroup(state.graph, nodeIds, (node) => groupAt(state.graph.nodes, absolutePosition(node, state.graph.nodes)));
      if (!graph) return false;
      const description = moved.length === 1 ? `Move ${labelOf(moved[0]!)}` : `Move ${plural(moved.length, "node")}`;
      const key = `layout:${[...nodeIds].sort().join(",")}`;
      if (commit(description, key, { graph })) return true;
      // Refused: the whole drag is undone, and its entry dropped (decision 4).
      const after = get();
      const run = after.historyRun;
      const entry = after.history.past.at(-1);
      if (entry && run?.key === key && !locked(after)) {
        set({
          graph: entry.graph,
          history: { past: after.history.past.slice(0, -1), future: after.history.future },
          historyRun: null,
          ...selectionIn(entry.graph, after.selectedNode?.id, after.selectedNodes.map((n) => n.id)),
        });
      }
      return false;
    },
    moveNodeToGroup: (nodeId, groupId) => {
      const { graph } = get();
      const node = findNode(nodeId);
      const group = groupId === null ? undefined : graph.nodes.find((n) => n.id === groupId && isGroup(n));
      if (!node || (groupId !== null && !group)) return false;
      const moved = moveToGroup(graph, [nodeId], () => group);
      return commit(`Move ${labelOf(node)}`, undefined, moved ? { graph: moved } : null);
    },
    resizeGroup: (groupId, { width, height }) => {
      const { graph } = get();
      const group = graph.nodes.find((n) => n.id === groupId && isGroup(n));
      if (!group) return false;
      const sized = graph.nodes.map((n) => (n.id === groupId ? { ...n, style: { ...n.style, width, height } } : n));
      const { nodes, detached } = detachOutside(sized, groupId, width, height);
      return commit(`Resize ${labelOf(group)}`, `layout:${groupId}`, {
        graph: { ...graph, nodes },
        layoutOnly: !detached,
      });
    },

    // ── Building ──

    dropComponent: (paletteId, position) => {
      const entry = componentPalette.find((candidate) => candidate.id === paletteId);
      const { graph, configuration, collectorVersion } = get();
      if (!entry) return null;
      // The spelling the pin on screen knows (D13b decision 5); a later pin change rewrites nothing.
      const spelledAs = spelledType(entry.type, entry.subType, configuration?.collectorDistribution ?? null, collectorVersion);
      const node = droppedNode(entry, position, graph.nodes, spelledAs);
      const done = commit(`Add ${node.data.label}`, undefined, {
        graph: { ...graph, nodes: [...graph.nodes, node] },
        select: node.id,
      });
      return done ? (findNode(node.id) ?? null) : null;
    },
    connect: (connection) => {
      const state = get();
      if (locked(state)) return { ok: false };
      const { graph } = state;
      const source = findNode(connection.source);
      const target = findNode(connection.target);
      if (!source || !target) return { ok: false };
      const refusal = connectionRefusal(source, target, graph.nodes);
      if (refusal) return refusal.warning ? { ok: false, warning: refusal.warning } : { ok: false };
      if (graph.edges.some((e) => e.source === source.id && e.target === target.id)) return { ok: false };

      const adopted = adoption(source, target, graph.nodes);
      const nodes = adopted ? graph.nodes.map((n) => (n.id === adopted.node.id ? adopted.node : n)) : graph.nodes;
      const edge: OTelEdge = {
        id: nextEdgeId(graph.edges.map((e) => e.id)),
        source: source.id,
        target: target.id,
        type: "smoothstep",
        data: {},
        ...(typeof connection.sourceHandle === "string" ? { sourceHandle: connection.sourceHandle } : {}),
        ...(typeof connection.targetHandle === "string" ? { targetHandle: connection.targetHandle } : {}),
      };
      const description = adopted ? `Add ${adopted.node.data.label} to ${adopted.group.data.label}` : "Connect nodes";
      return commit(description, undefined, { graph: { ...graph, nodes, edges: [...graph.edges, edge] } })
        ? { ok: true }
        : { ok: false };
    },

    // ── Deleting: one path, through the dialog (decision 8) ──

    requestDelete: (target) => {
      const state = get();
      if (locked(state)) return;
      if (target) {
        set({ pendingDelete: target });
        return;
      }
      if (state.selectedNodes.length > 0) {
        set({ pendingDelete: { kind: "nodes", nodeIds: state.selectedNodes.map((n) => n.id) } });
        return;
      }
      const group = state.selectedNode && isGroup(state.selectedNode) ? state.selectedNode : undefined;
      if (group?.data.pipelineId !== undefined) {
        set({ pendingDelete: { kind: "pipeline", pipelineId: group.data.pipelineId } });
        return;
      }
      // A selected connection is deleted without asking, and can be undone.
      const edges = state.graph.edges.filter((e) => e.selected);
      if (edges.length > 0) get().deleteEdges(edges.map((e) => e.id));
    },
    confirmDelete: () => {
      const target = get().pendingDelete;
      set({ pendingDelete: null });
      if (!target) return;
      if (target.kind === "pipeline") {
        const pipeline = get().graph.pipelines.find((p) => p.id === target.pipelineId);
        if (pipeline && get().deletePipeline(pipeline.id)) toast.success(`Pipeline "${pipeline.name}" deleted`, { className: "ph-no-capture" });
        return;
      }
      const count = target.nodeIds.length;
      if (get().deleteNodes(target.nodeIds)) toast.success(`Deleted ${plural(count, "node")}`);
    },
    cancelDelete: () => set({ pendingDelete: null }),
    deleteNodes: (nodeIds) => {
      const { graph } = get();
      const nodes = nodeIds.map((id) => findNode(id)).filter((n): n is OTelNode => n !== undefined);
      if (nodes.length === 0) return false;
      const description =
        nodes.length === 1
          ? isGroup(nodes[0]!)
            ? `Delete pipeline ${nodes[0]!.data.label}`
            : `Delete ${labelOf(nodes[0]!)}`
          : `Delete ${plural(nodes.length, "node")}`;
      return commit(description, undefined, { graph: withoutNodes(graph, new Set(nodes.map((n) => n.id))) });
    },
    deleteEdges: (edgeIds) => {
      const { graph } = get();
      const ids = new Set(edgeIds);
      const edges = graph.edges.filter((e) => !ids.has(e.id));
      const removed = graph.edges.length - edges.length;
      if (removed === 0) return false;
      return commit(removed === 1 ? "Delete connection" : `Delete ${plural(removed, "connection")}`, undefined, {
        graph: { ...graph, edges },
      });
    },

    // ── Duplicating and linking ──

    duplicateNode: (nodeId, groupId) => {
      const { graph } = get();
      const original = findNode(nodeId);
      if (!original || isGroup(original)) return null;
      if (groupId !== undefined && !graph.nodes.some((n) => n.id === groupId && isGroup(n))) return null;
      const copy = buildDuplicateNode(original, graph.nodes, groupId);
      const done = commit(`Duplicate ${labelOf(original)}`, undefined, {
        graph: { ...graph, nodes: [...graph.nodes, copy] },
        select: copy.id,
      });
      return done ? (findNode(copy.id) ?? null) : null;
    },
    duplicateSelectedNodes: () => {
      const { graph, selectedNodes } = get();
      const originals = selectedNodes.filter((n) => !isGroup(n));
      if (originals.length === 0) return [];
      const copies = buildDuplicateNodes(originals, graph.nodes);
      const done = commit(`Duplicate ${plural(originals.length, "node")}`, undefined, {
        graph: { ...graph, nodes: [...graph.nodes, ...copies] },
      });
      if (!done) return [];
      const ids = new Set(copies.map((c) => c.id));
      return get().graph.nodes.filter((n) => ids.has(n.id));
    },
    linkNodeToGroup: (nodeId, groupId) => {
      const { graph } = get();
      const source = findNode(nodeId);
      const group = graph.nodes.find((n) => n.id === groupId && isGroup(n));
      if (!source || isGroup(source) || !group) return null;
      const { linkedNode, updatedNodes } = buildLinkedNode(source, groupId, graph.nodes);
      const done = commit(`Link ${labelOf(source)} to ${group.data.label}`, undefined, {
        graph: { ...graph, nodes: [...updatedNodes, linkedNode] },
        select: linkedNode.id,
      });
      return done ? (findNode(linkedNode.id) ?? null) : null;
    },

    // ── Pipelines ──

    addPipeline: (name, color) => {
      const { graph } = get();
      if (graph.pipelines.some((p) => p.name === name)) return null;
      const pipeline: Pipeline = {
        id: nextPipelineId(graph.pipelines.map((p) => p.id)),
        name,
        signalType: extractSignalType(name),
        color:
          color ??
          generatePipelineColor(graph.pipelines.map((p) => p.color).filter((c): c is string => c !== undefined)),
      };
      const group = createGroupNode(pipeline, nextGroupYPosition(graph.nodes.filter(isGroup)));
      const done = commit(`Add pipeline ${name}`, undefined, {
        graph: { nodes: [...graph.nodes, group], edges: graph.edges, pipelines: [...graph.pipelines, pipeline] },
      });
      return done ? pipeline : null;
    },
    setPipelineColor: (pipelineId, color) => {
      const { graph } = get();
      const pipeline = graph.pipelines.find((p) => p.id === pipelineId);
      if (!pipeline || pipeline.color === color) return false;
      const groupId = groupIdForPipeline(pipelineId);
      return commit(`Change color of ${pipeline.name}`, undefined, {
        graph: {
          nodes: graph.nodes.map((n) => (n.id === groupId ? { ...n, data: { ...n.data, color } } : n)),
          edges: graph.edges,
          pipelines: graph.pipelines.map((p) => (p.id === pipelineId ? { ...p, color } : p)),
        },
        layoutOnly: true,
      });
    },
    deletePipeline: (pipelineId) => {
      const { graph } = get();
      const pipeline = graph.pipelines.find((p) => p.id === pipelineId);
      if (!pipeline) return false;
      const groupId = groupIdForPipeline(pipelineId);
      const { nodes, edges } = pruneGroupChildren(graph.nodes, graph.edges, groupId);
      return commit(`Delete pipeline ${pipeline.name}`, undefined, {
        graph: { nodes, edges, pipelines: graph.pipelines.filter((p) => p.id !== pipelineId) },
      });
    },

    // ── The Configuration tab ──

    renameInstance: (nodeId, typed) => {
      const { graph } = get();
      const node = findNode(nodeId);
      if (!node || isGroup(node)) return false;
      const instanceName = typed === "" ? undefined : typed;
      if (instanceName === node.data.instanceName) return false;
      const from = componentKey(node.data)!;
      const { instanceName: _old, sharedConfigId: _shared, ...rest } = node.data;
      const data = { ...rest, label: instanceLabel(node.data.label, instanceName), ...(instanceName ? { instanceName } : {}) };
      const to = componentKey(data)!;
      data.key = to;

      // Nodes that come to share its key are one component (linked): one
      // entry in the text, so the text's value holds for all.
      const siblings = graph.nodes.filter((n) => n.id !== nodeId && !isGroup(n) && componentKey(n.data) === to);
      const sharedConfigId = sharedConfigIdOf(data);
      const renamed: OTelNode = {
        ...node,
        data: siblings.length > 0 ? { ...data, sharedConfigId, config: siblings[0]!.data.config } : { ...data, sharedConfigId },
      };
      const nodes = graph.nodes.map((n) => {
        if (n.id === nodeId) return renamed;
        if (siblings.includes(n) && n.data.sharedConfigId !== sharedConfigId) {
          return { ...n, data: { ...n.data, sharedConfigId } };
        }
        return n;
      });
      return commit(`Update ${labelOf(node)}`, `rename:${nodeId}`, {
        graph: { ...graph, nodes },
        renames: [{ from, to }],
      });
    },
    setComponentValue: (nodeId, boxText) => {
      const state = get();
      const node = findNode(nodeId);
      if (!node || isGroup(node) || node.data.declared === false || locked(state) || state.document === null) {
        return "refused";
      }
      const key = componentKey(node.data)!;
      let written: ReturnType<typeof writeComponentValue>;
      try {
        written = writeComponentValue(state.text, key, boxText, state.document);
      } catch (error) {
        if (!(error instanceof TextEditError)) throw error;
        toast.error(CANT_EDIT_ON_CANVAS_MESSAGE);
        return "refused";
      }
      if (!written.ok) return written.reason === "anchor-clash" ? "anchor-clash" : "refused";
      const value = written.model.components.get(key) ?? null;
      let nodes = state.graph.nodes.map((n) =>
        !isGroup(n) && componentKey(n.data) === key ? { ...n, data: { ...n.data, config: value } } : n,
      );
      // Routing and failover pick their targets in config: keep them to the connector's right.
      if (isConfigTargetedConnectorNode(node)) nodes = pushConfigTargetsRight(nodes, state.graph.pipelines);
      const done = commit(`Update ${labelOf(node)}`, `value:${nodeId}`, {
        graph: { ...state.graph, nodes },
        written,
      });
      return done ? "written" : "refused";
    },
    setComponentValues: (nodeId, changes) => {
      const state = get();
      const node = findNode(nodeId);
      if (!node || isGroup(node) || node.data.declared === false || locked(state) || state.document === null) {
        return "refused";
      }
      const key = componentKey(node.data);
      if (key === undefined) return "refused";
      const base = splitKey(key);
      let written = writeUnder(state, state.document, base, changes);
      if (typeof written === "string") return written;
      // Every node of the component gets the text's new value: `deriveModel`
      // reads `config`, so a stale one would be written back by the next change.
      const value = written.model.components.get(key) ?? null;
      let nodes = state.graph.nodes.map((n) =>
        !isGroup(n) && componentKey(n.data) === key ? { ...n, data: { ...n.data, config: value } } : n,
      );
      let wired: string[] = [];
      if (isConfigTargetedConnectorNode(node)) {
        // Routing and failover pick their targets in config: keep them to the connector's right.
        nodes = pushConfigTargetsRight(nodes, state.graph.pipelines);
        // The pipelines a choice names or no longer names: the connector in their
        // receivers, in the same write (decision 8). `deriveModel` keeps the
        // text's membership, so the next canvas change keeps this one.
        const subType = node.data.componentSubType;
        const connector = base[1];
        const wiring = wireConnectorReceivers(
          written.model,
          connector,
          targetNamesOf(subType, modelOf(state.document).components.get(key)),
          targetNamesOf(subType, value),
        );
        if (wiring.model !== written.model) {
          try {
            written = editText(written.text, written.model, wiring.model, { document: written.document });
          } catch (error) {
            if (!(error instanceof TextEditError)) throw error;
            toast.error(CANT_EDIT_ON_CANVAS_MESSAGE);
            return "refused";
          }
        }
        wired = receiverWiringMessages(connector, wiring);
      }
      const done = commit(`Update ${labelOf(node)}`, `value:${nodeId}`, {
        graph: { ...state.graph, nodes },
        written,
      });
      // The messages name pipelines (configuration text): never recorded by replay (Ruling 301).
      if (done && wired.length > 0) toast.info(wired.join(" "), { className: "ph-no-capture" });
      return done ? "written" : "refused";
    },
    setTelemetryValues: (changes, description = EDIT_SELF_MONITORING) =>
      writeTelemetry(description, TELEMETRY_BASE, changes),
    removeTelemetry: () => {
      const { document } = get();
      // An explicit `telemetry:` (null) is still a key with lines to remove.
      if (document === null || nodeAt(document, TELEMETRY_BASE) === undefined) return false;
      return writeTelemetry(EDIT_SELF_MONITORING, TELEMETRY_BASE.slice(0, -1), [
        { path: TELEMETRY_BASE.slice(-1), remove: true },
      ]);
    },

    // ── Canvas actions ──

    tidyUp: () => {
      const { graph, layoutRevision } = get();
      const nodes = pushConfigTargetsRight(layoutPipelineGraph(graph.nodes, graph.edges, graph.pipelines), graph.pipelines);
      return commit("Tidy up layout", undefined, {
        graph: { ...graph, nodes },
        layoutOnly: true,
        extra: { layoutRevision: layoutRevision + 1 },
      });
    },
    clearCanvas: () => {
      const { canvasKey } = get();
      return commit("Clear canvas", undefined, {
        graph: { nodes: createDefaultGroupNodes(), edges: [], pipelines: getDefaultPipelines() },
        select: null,
        extra: { canvasKey: canvasKey + 1 },
      });
    },

    setValidation: (validation) => set({ validation }),

    // ── Selection: never an entry, never dirty ──

    selectNode: (nodeId) => {
      const node = nodeId === null ? undefined : findNode(nodeId);
      set({ selectedNode: node ?? null, selectedNodes: node && !isGroup(node) ? [node] : [] });
    },
    setSelection: (nodeIds) => {
      const { graph } = get();
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const selected = nodeIds.map((id) => byId.get(id)).filter((n): n is OTelNode => n !== undefined);
      const components = selected.filter((n) => !isGroup(n));
      if (components.length === 1) {
        set({ selectedNodes: components, selectedNode: components[0]! });
      } else if (components.length === 0 && selected.length === 1) {
        set({ selectedNodes: [], selectedNode: selected[0]! });
      } else {
        set({ selectedNodes: components, selectedNode: null });
      }
    },
  };
});

/**
 * Whether the editor differs from what was last loaded or saved: the text
 * (D8 decision 5), the layout (D9a decision 2), or the collector version
 * (D13a decision 8). Selection, measurement and the viewport never count.
 */
export function selectIsDirty(
  state: Pick<EditorState, "text" | "savedText" | "graph" | "savedLayout" | "collectorVersion" | "savedCollectorVersion">,
): boolean {
  return state.collectorVersion !== state.savedCollectorVersion || textOrLayoutDiffers(state, state);
}

/** Whether `text` is empty or only YAML's whitespace (spaces, tabs, line breaks): never checked (Ruling 57). */
export function isBlank(text: string): boolean {
  return /^[ \t\r\n]*$/.test(text);
}

/**
 * The validator's outcome for the text and pin on screen (D13b decisions 2,
 * 13 and 14): idle with no version open or with empty or whitespace-only
 * text (never checked);
 * the kept answer when it is for exactly this version, text and pin; else
 * validating, a check being due (the 2 s after typing) or under way. So an
 * answer for another text or pin is never shown, and a text typed back to
 * the checked one (an undo inside the debounce) shows its answer again, never
 * a stuck "validating".
 */
export function selectCollectorValidation(
  state: Pick<EditorState, "version" | "text" | "collectorVersion" | "validation">,
): CollectorValidationOutcome {
  if (state.version === null || state.collectorVersion === null || isBlank(state.text)) return VALIDATION_IDLE;
  const kept = state.validation;
  if (
    kept !== null &&
    kept.versionId === state.version.id &&
    kept.text === state.text &&
    kept.collectorVersion === state.collectorVersion
  ) {
    return kept.outcome;
  }
  return VALIDATION_VALIDATING;
}

export function selectCanUndo(state: Pick<EditorState, "history" | "isYamlEditing" | "version">): boolean {
  return !state.isYamlEditing && !selectIsVersionPublished(state) && state.history.past.length > 0;
}

export function selectCanRedo(state: Pick<EditorState, "history" | "isYamlEditing" | "version">): boolean {
  return !state.isYamlEditing && !selectIsVersionPublished(state) && state.history.future.length > 0;
}

/** What the next undo undoes, for the toolbar (its toast; never its title, decision 7). */
export function selectUndoDescription(state: Pick<EditorState, "history">): string | null {
  return state.history.past.at(-1)?.description ?? null;
}

export function selectRedoDescription(state: Pick<EditorState, "history">): string | null {
  return state.history.future.at(-1)?.description ?? null;
}

/**
 * Whether the canvas, the toolbox and the Configuration tab are locked: manual
 * edit mode, or text the canvas can't show. Nothing can be selected or
 * inspected on the canvas then, and the Configuration tab is disabled. A
 * published version isn't locked this way: it is read-only
 * (`selectIsVersionPublished`, `selectIsEditingLocked`).
 */
export function selectIsCanvasLocked(state: Pick<EditorState, "isYamlEditing" | "graphStatus">): boolean {
  return state.isYamlEditing || state.graphStatus !== "ready";
}

/**
 * Whether the open version is published, and so read-only for everyone (D11b
 * decision 4; Preflight ruling 11): the one selector the read-only mode
 * follows. Monaco takes no typing; the canvas can be selected, focused,
 * panned and zoomed, never changed; the toolbox, the canvas actions and the
 * Configuration tab's forms are disabled (the tab itself opens); undo, redo,
 * Save and Publish are off; the store refuses every change.
 */
export function selectIsVersionPublished(state: Pick<EditorState, "version">): boolean {
  return state.version !== null && state.version.publishedAt !== null;
}

/**
 * Whether the builder's controls take no change: the canvas is locked (manual
 * edit mode, text it can't show) or the version is published. The toolbox,
 * the canvas actions, the toolbar's Duplicate and Delete, and the
 * Configuration tab's forms follow it.
 */
export function selectIsEditingLocked(state: Pick<EditorState, "isYamlEditing" | "graphStatus" | "version">): boolean {
  return selectIsCanvasLocked(state) || selectIsVersionPublished(state);
}
