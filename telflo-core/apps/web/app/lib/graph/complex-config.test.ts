/**
 * Complex production-grade OTel Collector configuration — unit tests.
 *
 * Construction (D9a Parity Notes); generation is the text edits (Task 4),
 * and the round trip the round-trip invariant over
 * `corpus/complex-config.yaml`, the YAML generated for this graph; the last
 * test here ties the two.
 */

import { describe, expect, it, beforeAll } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { deriveModel, readTextModel } from "./model.js";
import { parse } from "./parse.js";
import type { OTelEdge, OTelNode, Pipeline } from "./types.js";
import {
  buildComplexConfig,
  buildMinimalPipeline,
  buildPipelineWithProcessors,
  extractComponentConfig,
  getDefaultConfig,
  getPaletteEntry,
} from "~/test/pipeline-builder.js";

// ── Shared state ──

let nodes: OTelNode[];
let edges: OTelEdge[];
let pipelines: Pipeline[];

beforeAll(() => {
  const config = buildComplexConfig();
  nodes = config.nodes;
  edges = config.edges;
  pipelines = config.pipelines;
});

// ══════════════════════════════════════════════════════════════
// PHASE 1: Config Construction
// ══════════════════════════════════════════════════════════════

describe("Phase 1: config construction", () => {
  it("has 3 pipeline groups", () => {
    const groups = nodes.filter((n) => n.type === "pipelineGroup");
    expect(groups).toHaveLength(3);
  });

  it("has 3 pipelines with correct signal types", () => {
    expect(pipelines).toHaveLength(3);
    const signals = pipelines.map((p) => p.signalType).sort();
    expect(signals).toEqual(["logs", "metrics", "traces"]);
  });

  it("traces pipeline has correct child nodes", () => {
    const tracesGroupId = "group_0";
    const children = nodes.filter((n) => n.parentId === tracesGroupId);
    // 1 receiver (otlp) + 4 processors (batch, tail_sampling, attributes, transform) + 1 exporter (otlp)
    expect(children).toHaveLength(6);
  });

  it("metrics pipeline has correct child nodes", () => {
    const metricsGroupId = "group_1";
    const children = nodes.filter((n) => n.parentId === metricsGroupId);
    // 1 receiver (hostmetrics) + 3 processors (batch, memory_limiter, resourcedetection) + 1 exporter (otlphttp)
    expect(children).toHaveLength(5);
  });

  it("logs pipeline has correct child nodes", () => {
    const logsGroupId = "group_2";
    const children = nodes.filter((n) => n.parentId === logsGroupId);
    // 1 receiver (filelog) + 3 processors (batch, filter/logs, redaction) + 1 exporter (otlphttp)
    expect(children).toHaveLength(5);
  });

  it("has 3 extension nodes without parentId", () => {
    const exts = nodes.filter(
      (n) => n.data.componentType === "extension" && !n.parentId,
    );
    expect(exts).toHaveLength(3);
    const subTypes = exts.map((n) => n.data.componentSubType).sort();
    expect(subTypes).toEqual(["health_check", "pprof", "zpages"]);
  });

  it("has 1 connector node without parentId", () => {
    const conns = nodes.filter(
      (n) => n.data.componentType === "connector" && !n.parentId,
    );
    expect(conns).toHaveLength(1);
    expect(conns[0]!.data.componentSubType).toBe("spanmetrics");
  });

  it("has connector edges linking traces to metrics", () => {
    const toConnector = edges.find((e) => e.target === "conn-spanmetrics");
    const fromConnector = edges.find((e) => e.source === "conn-spanmetrics");
    expect(toConnector).toBeDefined();
    expect(fromConnector).toBeDefined();
    expect(toConnector!.source).toBe("t-processor-3"); // traces transform
    expect(fromConnector!.target).toBe("m-processor-0"); // metrics batch
  });

  it("tail_sampling has 3 diverse policies", () => {
    const node = nodes.find(
      (n) => n.data.componentSubType === "tail_sampling",
    )!;
    const policies = (node.data.config as { policies: Array<{ type: string }> }).policies;
    expect(policies).toHaveLength(3);
    const types = policies.map((p) => p.type).sort();
    expect(types).toEqual(["latency", "probabilistic", "status_code"]);
  });

  it("OTLP exporter has TLS config", () => {
    const node = nodes.find(
      (n) =>
        n.data.componentSubType === "otlp" &&
        n.data.componentType === "exporter",
    )!;
    const tls = (node.data.config as { tls: Record<string, unknown> }).tls;
    expect(tls.insecure).toBe(false);
    expect(tls.cert_file).toBe("/certs/client.crt");
    expect(tls.key_file).toBe("/certs/client.key");
  });

  it("filter/logs has log-specific OTTL config", () => {
    const node = nodes.find(
      (n) =>
        n.data.componentSubType === "filter" &&
        n.data.instanceName === "logs",
    )!;
    expect((node.data.config as { logs: { log_record: string[] } }).logs.log_record).toContain(
      "severity_number < SEVERITY_NUMBER_WARN",
    );
  });
});

describe("the corpus's complex-config.yaml", () => {
  it("is the configuration this graph describes", () => {
    const result = parse(corpusText("complex-config.yaml"));
    if (!result.ok) throw new Error(result.reason);
    expect(deriveModel({ nodes, edges, pipelines })).toEqual(readTextModel(result.document));
  });
});

describe("the corpus's YAML for pipeline-builder's other graphs", () => {
  it.each([
    ["minimal-pipeline.yaml", () => buildMinimalPipeline("otlp", "debug", "traces")],
    ["pipeline-with-processors.yaml", () => buildPipelineWithProcessors("otlp", ["memory_limiter", "batch"], "otlphttp", "metrics")],
  ] as const)("%s is the configuration its builder describes", (name, build) => {
    const result = parse(corpusText(name));
    if (!result.ok) throw new Error(result.reason);
    expect(deriveModel(build())).toEqual(readTextModel(result.document));
    expect(extractComponentConfig(result.graph, "otlp", "receiver")).toEqual(getDefaultConfig("otlp", "receiver"));
    expect(extractComponentConfig(result.graph, "zipkin")).toBeNull();
  });

  it("refuses a palette entry that doesn't exist", () => {
    expect(() => getPaletteEntry("mysterious")).toThrow('Component subType "mysterious" not found in the palette');
    expect(() => getPaletteEntry("otlp", "extension")).toThrow("(type: extension)");
    expect(getPaletteEntry("health_check").type).toBe("extension");
  });
});
