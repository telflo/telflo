import type { Edge, Node } from "@xyflow/react";

/*
 * The builder's graph and its undo history. A component's config is whatever
 * JSON value the text holds.
 */

export type ComponentType = "receiver" | "processor" | "exporter" | "extension" | "connector";

export const COMPONENT_TYPES: readonly ComponentType[] = ["receiver", "processor", "exporter", "extension", "connector"];

export type PipelineSignalType = "traces" | "metrics" | "logs";

export const PIPELINE_SIGNAL_TYPES: readonly PipelineSignalType[] = ["traces", "metrics", "logs"];

/** A pipeline, one per `service.pipelines` entry. */
export interface Pipeline {
  /** Opaque: `pipeline_<n>`, never derived from the name. */
  id: string;
  /** The text's key: `traces`, `traces/production`. */
  name: string;
  signalType: PipelineSignalType;
  /** `#rrggbb`. */
  color?: string;
}

/** What a connector consumes and produces; set for the signal-fixed ones only. */
export interface ConnectorSignalMapping {
  inputSignal: PipelineSignalType;
  outputSignal: PipelineSignalType;
}

/** A component's value in the text, as JSON: an object, `null` for `debug:`, or anything the text holds. */
export type ComponentConfig = unknown;

/** A node's `type`: a component's kind, or a pipeline's group. */
export type NodeKind = ComponentType | "pipelineGroup";

/**
 * A node's data. A component's carries the builder's fields and its own
 * (its key, its pipeline, whether the text declares it, whether it is
 * enabled); a pipeline's group carries its pipeline's id, signal and color.
 */
export interface OTelNodeData extends Record<string, unknown> {
  label: string;
  componentType: NodeKind;
  /** The palette's spelling (`otlp` for the text's `otlp_grpc`), for the label, icon and help only. */
  componentSubType: string;
  /** `enricher` in `attributes/enricher`. */
  instanceName?: string;
  config: ComponentConfig;
  connectorSignals?: ConnectorSignalMapping;
  /** Links a component's nodes across pipelines: `<kind>-<name>`. */
  sharedConfigId?: string;
  /**
   * The component's key in the text, `receivers.otlp/2`, with the text's
   * own spelling of its type. Set by `parse`; a node added on the canvas
   * has none until the text has it.
   */
  key?: string;
  /** The name of the pipeline whose group holds the node. */
  pipeline?: string;
  /** False when a pipeline names the component but the text doesn't declare it. */
  declared?: boolean;
  /** An extension's: whether `service.extensions` lists it. */
  enabled?: boolean;
  /** A group's pipeline. */
  pipelineId?: string;
  signalType?: PipelineSignalType;
  color?: string;
}

export type OTelNode = Node<OTelNodeData>;

export interface OTelEdgeData extends Record<string, unknown> {
  /** Derived route edges only: the chip ("2 routes + default"). */
  label?: string;
}

export type OTelEdge = Edge<OTelEdgeData>;

/** The graph: the canvas's nodes and edges, and the pipelines they draw. */
export interface Graph {
  nodes: OTelNode[];
  edges: OTelEdge[];
  pipelines: Pipeline[];
}

/** A palette entry. */
export interface PaletteComponent {
  id: string;
  type: ComponentType;
  subType: string;
  label: string;
  /** A lucide icon's name. */
  icon: string;
  helpText: string;
  defaultConfig: ComponentConfig;
  connectorSignals?: ConnectorSignalMapping;
}

/** An undo entry's state: the text and the graph, together. */
export interface HistoryState {
  text: string;
  graph: Graph;
}

/** An undo entry. */
export interface HistorySnapshot {
  /** Human-readable, e.g. "Add OTLP"; shown in the undo toast, never in an attribute. */
  description: string;
  state: HistoryState;
}
