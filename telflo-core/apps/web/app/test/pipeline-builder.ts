/**
 * Test helper utilities for building pipeline data structures.
 * Constructs valid OTelNode[], OTelEdge[], and Pipeline[] for use in tests.
 *
 * Pipelines and their groups take D9a's opaque ids (`pipeline_<n>`,
 * `group_<n>`, decision 7); component nodes keep the fixture's readable ids,
 * which are test data, not anything a person wrote. The configurations it
 * builds are also written as YAML in `lib/graph/corpus/`, for the round-trip
 * invariant.
 */
import { findPaletteEntry, paletteDefaultConfig } from "~/lib/graph/palette.js";
import { groupIdForPipeline } from "~/lib/graph/node-builders.js";
import { SECTION_OF_TYPE, buildYamlName } from "~/lib/graph/node-operations.js";
import type {
  ComponentConfig,
  ComponentType,
  OTelEdge,
  OTelNode,
  PaletteComponent,
  Pipeline,
  PipelineSignalType,
} from "~/lib/graph/types.js";
import { COMPONENT_TYPES } from "~/lib/graph/types.js";

const PIPELINE_GROUP_WIDTH = 1200;
const PIPELINE_GROUP_HEIGHT = 400;

const SIGNAL_COLORS: Record<PipelineSignalType, string> = {
  traces: "#f97316",
  metrics: "#3b82f6",
  logs: "#64748b",
};

export type BuiltGraph = { nodes: OTelNode[]; edges: OTelEdge[]; pipelines: Pipeline[] };

/**
 * Look up a component's default config from the palette.
 * When subTypes overlap across component types (e.g., "otlp" receiver vs exporter),
 * pass componentType to disambiguate.
 */
export function getDefaultConfig(subType: string, componentType?: ComponentType): ComponentConfig {
  return paletteDefaultConfig(getPaletteEntry(subType, componentType));
}

/**
 * Look up a palette entry by subType (and optionally componentType).
 */
export function getPaletteEntry(subType: string, componentType?: ComponentType): PaletteComponent {
  const entry = (componentType ? [componentType] : COMPONENT_TYPES)
    .map((type) => findPaletteEntry(type, subType))
    .find((found) => found !== undefined);
  if (!entry) {
    throw new Error(
      `Component subType "${subType}"${componentType ? ` (type: ${componentType})` : ""} not found in the palette`,
    );
  }
  return entry;
}

/**
 * Create a pipeline group node (the visual container for a pipeline).
 */
function createGroupNode(pipeline: Pipeline): OTelNode {
  return {
    id: groupIdForPipeline(pipeline.id),
    type: "pipelineGroup",
    position: { x: 100, y: 50 },
    data: {
      label: pipeline.name,
      pipelineId: pipeline.id,
      signalType: pipeline.signalType,
      color: pipeline.color ?? "#64748b",
      componentType: "pipelineGroup",
      componentSubType: "pipelineGroup",
      config: {},
    },
    style: { width: PIPELINE_GROUP_WIDTH, height: PIPELINE_GROUP_HEIGHT },
  };
}

/**
 * Create a component node that belongs to a pipeline group.
 */
function createComponentNode(
  id: string,
  subType: string,
  componentType: ComponentType,
  groupId: string,
  xPosition: number,
  instanceName?: string,
): OTelNode {
  const entry = getPaletteEntry(subType, componentType);
  const name = buildYamlName(entry.subType, instanceName);
  return {
    id,
    type: entry.type,
    parentId: groupId,
    position: { x: xPosition, y: 50 },
    data: {
      label: entry.label,
      componentType: entry.type,
      componentSubType: entry.subType,
      ...(instanceName === undefined ? {} : { instanceName }),
      config: paletteDefaultConfig(entry),
      sharedConfigId: `${entry.type}-${name}`,
      key: `${SECTION_OF_TYPE[entry.type]}.${name}`,
    },
  };
}

function chainEdges(chain: readonly OTelNode[]): OTelEdge[] {
  const edges: OTelEdge[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const source = chain[i]!;
    const target = chain[i + 1]!;
    edges.push({
      id: `${source.id}-${target.id}`,
      source: source.id,
      target: target.id,
      type: "smoothstep",
      data: {},
    });
  }
  return edges;
}

function signalPipeline(signalType: PipelineSignalType): Pipeline {
  return { id: "pipeline_0", name: signalType, signalType, color: SIGNAL_COLORS[signalType] };
}

/**
 * Build a minimal 2-node pipeline: receiver → exporter.
 */
export function buildMinimalPipeline(
  receiverSubType: string,
  exporterSubType: string,
  signalType: PipelineSignalType,
): BuiltGraph {
  const pipeline = signalPipeline(signalType);
  const groupNode = createGroupNode(pipeline);
  const groupId = groupNode.id;

  const receiverNode = createComponentNode("node-receiver-0", receiverSubType, "receiver", groupId, 50);
  const exporterNode = createComponentNode("node-exporter-0", exporterSubType, "exporter", groupId, 400);

  return {
    nodes: [groupNode, receiverNode, exporterNode],
    edges: chainEdges([receiverNode, exporterNode]),
    pipelines: [pipeline],
  };
}

/**
 * Build a pipeline with processors: receiver → processor1 → ... → processorN → exporter.
 */
export function buildPipelineWithProcessors(
  receiverSubType: string,
  processorSubTypes: string[],
  exporterSubType: string,
  signalType: PipelineSignalType,
): BuiltGraph {
  const pipeline = signalPipeline(signalType);
  const groupNode = createGroupNode(pipeline);
  const groupId = groupNode.id;

  const receiverNode = createComponentNode("node-receiver-0", receiverSubType, "receiver", groupId, 50);
  const processorNodes = processorSubTypes.map((subType, i) =>
    createComponentNode(`node-processor-${i}`, subType, "processor", groupId, 200 + i * 200),
  );
  const exporterNode = createComponentNode(
    "node-exporter-0",
    exporterSubType,
    "exporter",
    groupId,
    200 + processorSubTypes.length * 200,
  );

  return {
    nodes: [groupNode, receiverNode, ...processorNodes, exporterNode],
    edges: chainEdges([receiverNode, ...processorNodes, exporterNode]),
    pipelines: [pipeline],
  };
}

/**
 * Extract a component's config from a parsed graph by subType.
 * Pass componentType to disambiguate when subTypes overlap.
 */
export function extractComponentConfig(
  parsedGraph: { nodes: OTelNode[] },
  subType: string,
  componentType?: ComponentType,
): ComponentConfig | null {
  const node = parsedGraph.nodes.find(
    (n) =>
      n.data.componentSubType === subType &&
      n.type !== "pipelineGroup" &&
      (componentType ? n.data.componentType === componentType : true),
  );
  return node?.data.config ?? null;
}

type Member = { subType: string; instanceName?: string };

/**
 * Build a named pipeline with namespaced node IDs — safe for multi-pipeline configs.
 * Unlike buildPipelineWithProcessors, node IDs are prefixed to avoid collisions.
 */
export function buildNamedPipeline(opts: {
  pipelineId: string;
  pipelineName: string;
  signalType: PipelineSignalType;
  receiverSubTypes: Member[];
  processorSubTypes: Member[];
  exporterSubTypes: Member[];
  nodePrefix: string;
}): BuiltGraph {
  const pipeline: Pipeline = {
    id: opts.pipelineId,
    name: opts.pipelineName,
    signalType: opts.signalType,
    color: SIGNAL_COLORS[opts.signalType],
  };

  const groupNode = createGroupNode(pipeline);
  const groupId = groupNode.id;

  const receiverNodes = opts.receiverSubTypes.map((r, i) =>
    createComponentNode(`${opts.nodePrefix}-receiver-${i}`, r.subType, "receiver", groupId, 50 + i * 150, r.instanceName),
  );
  const processorNodes = opts.processorSubTypes.map((p, i) =>
    createComponentNode(`${opts.nodePrefix}-processor-${i}`, p.subType, "processor", groupId, 200 + i * 200, p.instanceName),
  );
  const exporterNodes = opts.exporterSubTypes.map((e, i) =>
    createComponentNode(
      `${opts.nodePrefix}-exporter-${i}`,
      e.subType,
      "exporter",
      groupId,
      200 + opts.processorSubTypes.length * 200 + i * 200,
      e.instanceName,
    ),
  );

  return {
    nodes: [groupNode, ...receiverNodes, ...processorNodes, ...exporterNodes],
    edges: chainEdges([...receiverNodes, ...processorNodes, ...exporterNodes]),
    pipelines: [pipeline],
  };
}

function createFloatingNode(id: string, subType: string, type: ComponentType, position: { x: number; y: number }) {
  const entry = getPaletteEntry(subType, type);
  const node: OTelNode = {
    id,
    type: entry.type,
    position,
    data: {
      label: entry.label,
      componentType: entry.type,
      componentSubType: entry.subType,
      config: paletteDefaultConfig(entry),
      sharedConfigId: `${entry.type}-${entry.subType}`,
      key: `${SECTION_OF_TYPE[entry.type]}.${entry.subType}`,
    },
  };
  if (entry.connectorSignals) node.data.connectorSignals = { ...entry.connectorSignals };
  return node;
}

/**
 * Create a standalone extension node (no parentId — floats outside pipeline groups).
 */
export function createExtensionNode(id: string, subType: string): OTelNode {
  return createFloatingNode(id, subType, "extension", { x: 50, y: 500 });
}

/**
 * Create a standalone connector node (no parentId — floats between pipeline groups).
 */
export function createConnectorNode(id: string, subType: string): OTelNode {
  return createFloatingNode(id, subType, "connector", { x: 600, y: 500 });
}

/**
 * Merge multiple pipeline graph results into one config.
 */
export function mergePipelineGraphs(...graphs: BuiltGraph[]): BuiltGraph {
  return {
    nodes: graphs.flatMap((g) => g.nodes),
    edges: graphs.flatMap((g) => g.edges),
    pipelines: graphs.flatMap((g) => g.pipelines),
  };
}

function nodeWith(nodes: readonly OTelNode[], predicate: (node: OTelNode) => boolean): OTelNode {
  const node = nodes.find(predicate);
  if (!node) throw new Error("The fixture has no such node");
  return node;
}

/**
 * Build the complex production-grade OTel Collector configuration.
 *
 * 3 pipelines (traces, metrics, logs), 3 extensions, 1 connector,
 * customized component configs. Its YAML is `corpus/complex-config.yaml`.
 */
export function buildComplexConfig(): BuiltGraph {
  // === TRACES PIPELINE ===
  const tracesPipeline = buildNamedPipeline({
    pipelineId: "pipeline_0",
    pipelineName: "traces",
    signalType: "traces",
    receiverSubTypes: [{ subType: "otlp" }],
    processorSubTypes: [
      { subType: "batch" },
      { subType: "tail_sampling" },
      { subType: "attributes" },
      { subType: "transform" },
    ],
    exporterSubTypes: [{ subType: "otlp" }],
    nodePrefix: "t",
  });

  nodeWith(tracesPipeline.nodes, (n) => n.data.componentSubType === "tail_sampling").data.config = {
    decision_wait: "30s",
    num_traces: 50000,
    expected_new_traces_per_sec: 0,
    policies: [
      {
        name: "sample-errors",
        type: "status_code",
        status_code: { status_codes: ["ERROR"] },
      },
      {
        name: "high-latency",
        type: "latency",
        latency: { threshold_ms: 1000 },
      },
      {
        name: "sample-10-percent",
        type: "probabilistic",
        probabilistic: { sampling_percentage: 10 },
      },
    ],
  };

  nodeWith(
    tracesPipeline.nodes,
    (n) => n.data.componentSubType === "otlp" && n.data.componentType === "exporter",
  ).data.config = {
    endpoint: "otelcol:4317",
    timeout: "5s",
    compression: "gzip",
    tls: {
      insecure: false,
      cert_file: "/certs/client.crt",
      key_file: "/certs/client.key",
      ca_file: "/certs/ca.crt",
    },
  };

  nodeWith(tracesPipeline.nodes, (n) => n.data.componentSubType === "transform").data.config = {
    error_mode: "ignore",
    trace_statements: [
      {
        context: "resource",
        statements: ['set(attributes["deployment.environment"], "production")'],
      },
    ],
    metric_statements: [],
    log_statements: [],
  };

  // === METRICS PIPELINE ===
  const metricsPipeline = buildNamedPipeline({
    pipelineId: "pipeline_1",
    pipelineName: "metrics",
    signalType: "metrics",
    receiverSubTypes: [{ subType: "hostmetrics" }],
    processorSubTypes: [{ subType: "batch" }, { subType: "memory_limiter" }, { subType: "resourcedetection" }],
    exporterSubTypes: [{ subType: "otlphttp" }],
    nodePrefix: "m",
  });

  // === LOGS PIPELINE ===
  const logsPipeline = buildNamedPipeline({
    pipelineId: "pipeline_2",
    pipelineName: "logs",
    signalType: "logs",
    receiverSubTypes: [{ subType: "filelog" }],
    processorSubTypes: [{ subType: "batch" }, { subType: "filter", instanceName: "logs" }, { subType: "redaction" }],
    exporterSubTypes: [{ subType: "otlphttp" }],
    nodePrefix: "l",
  });

  nodeWith(logsPipeline.nodes, (n) => n.data.componentSubType === "filter").data.config = {
    error_mode: "ignore",
    logs: {
      log_record: ["severity_number < SEVERITY_NUMBER_WARN"],
    },
  };

  nodeWith(logsPipeline.nodes, (n) => n.data.componentSubType === "redaction").data.config = {
    allow_all_keys: true,
    blocked_values: ["\\d{3}-\\d{2}-\\d{4}"],
    summary: "debug",
  };

  // === MERGE ===
  const merged = mergePipelineGraphs(tracesPipeline, metricsPipeline, logsPipeline);

  // === EXTENSIONS ===
  merged.nodes.push(
    createExtensionNode("ext-health", "health_check"),
    createExtensionNode("ext-pprof", "pprof"),
    createExtensionNode("ext-zpages", "zpages"),
  );

  // === CONNECTOR: spanmetrics (traces → metrics) ===
  merged.nodes.push(createConnectorNode("conn-spanmetrics", "spanmetrics"));

  merged.edges.push({
    id: "t-processor-3-conn-spanmetrics",
    source: "t-processor-3",
    target: "conn-spanmetrics",
    type: "smoothstep",
    data: {},
  });

  merged.edges.push({
    id: "conn-spanmetrics-m-processor-0",
    source: "conn-spanmetrics",
    target: "m-processor-0",
    type: "smoothstep",
    data: {},
  });

  return merged;
}
