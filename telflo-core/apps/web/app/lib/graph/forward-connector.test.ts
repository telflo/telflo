/**
 * Tests for the Forward connector.
 *
 * The forward connector forwards telemetry of the *same* signal type between
 * pipelines (merge several pipelines into one, or fan one out into many). It
 * has no configuration (an empty `forward: {}` block) and is signal-agnostic.
 *
 * Generation is the model the graph describes (`deriveModel`); the round trip
 * reads forward-connector.yaml, the generated YAML for
 * buildForwardScenario("logs", "logs"). The validation tests are the
 * collector validator's binary tests
 * (services/otelcol-validator/tests/test_binary_builder_texts.py).
 */
import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { deriveModel } from "./model.js";
import { componentPalette } from "./palette.js";
import { parse } from "./parse.js";
import { buildNamedPipeline, createConnectorNode, mergePipelineGraphs } from "~/test/pipeline-builder.js";
import type { BuiltGraph } from "~/test/pipeline-builder.js";
import type { PipelineSignalType } from "./types.js";

/**
 * Wire a forward connector between two pipelines of the given signal types:
 *   in-pipeline:  otlp receiver → forward (connector acts as exporter)
 *   out-pipeline: forward → otlp exporter (connector acts as receiver)
 */
function buildForwardScenario(inSignal: PipelineSignalType, outSignal: PipelineSignalType): BuiltGraph {
  const inPipe = buildNamedPipeline({
    pipelineId: "pipeline_0",
    pipelineName: `${inSignal}/in`,
    signalType: inSignal,
    receiverSubTypes: [{ subType: "otlp" }],
    processorSubTypes: [],
    exporterSubTypes: [],
    nodePrefix: "in",
  });

  const outPipe = buildNamedPipeline({
    pipelineId: "pipeline_1",
    pipelineName: `${outSignal}/out`,
    signalType: outSignal,
    receiverSubTypes: [],
    processorSubTypes: [],
    exporterSubTypes: [{ subType: "otlp" }],
    nodePrefix: "out",
  });

  const merged = mergePipelineGraphs(inPipe, outPipe);
  merged.nodes.push(createConnectorNode("conn-forward", "forward"));

  // receiver → forward (forward is the exporter of the in-pipeline)
  merged.edges.push({
    id: "in-receiver-0-conn-forward",
    source: "in-receiver-0",
    target: "conn-forward",
    type: "smoothstep",
    data: {},
  });

  // forward → exporter (forward is the receiver of the out-pipeline)
  merged.edges.push({
    id: "conn-forward-out-exporter-0",
    source: "conn-forward",
    target: "out-exporter-0",
    type: "smoothstep",
    data: {},
  });

  return merged;
}

describe("Forward connector — palette", () => {
  it("is registered in the component palette as a connector with empty config", () => {
    const entry = componentPalette.find((c) => c.subType === "forward" && c.type === "connector");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Forward");
    expect(entry!.defaultConfig).toEqual({});
    // Forward is signal-agnostic — it must NOT carry a fixed signal mapping.
    expect(entry!.connectorSignals).toBeUndefined();
  });
});

describe.each<PipelineSignalType>(["traces", "metrics", "logs"])("Forward connector — YAML generation (%s)", (signal) => {
  const model = deriveModel(buildForwardScenario(signal, signal));

  it("emits an empty forward connector block", () => {
    expect(model.components.get("connectors.forward")).toEqual({});
  });

  it("lists forward as an exporter in the source pipeline", () => {
    expect(model.pipelines.get(`${signal}/in`)?.exporters).toContain("forward");
  });

  it("lists forward as a receiver in the target pipeline", () => {
    expect(model.pipelines.get(`${signal}/out`)?.receivers).toContain("forward");
  });
});

describe("Forward connector — round-trip", () => {
  it("preserves the forward connector through generate → parse", () => {
    const result = parse(corpusText("forward-connector.yaml"));
    if (!result.ok) throw new Error(result.reason);

    const connectorNodes = result.graph.nodes.filter((n) => n.data.componentType === "connector");
    expect(connectorNodes).toHaveLength(1);
    expect(connectorNodes[0]!.data.componentSubType).toBe("forward");
    expect(connectorNodes[0]!.data.config).toEqual({});
  });
});
