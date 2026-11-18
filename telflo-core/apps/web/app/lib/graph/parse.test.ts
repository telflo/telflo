import { describe, expect, it } from "vitest";

import { corpusText } from "./corpus/corpus.js";
import { groupIdForPipeline } from "./node-builders.js";
import { findPaletteEntry } from "./palette.js";
import { labelFor, parse, paletteSubType } from "./parse.js";
import type { Graph, OTelNode } from "./types.js";

/*
 * The parser's cases on `parse` and the `yaml` package (D9a Parity Notes),
 * then D9a's own: each refusal
 * (Preflight ruling 9), YAML 1.2's numbers (ruling 2), merge keys, renamed
 * types, and decision 3's fixes. Its text is the corpus's
 * parser-kubernetes.yaml; renamedYaml is renamed-types.yaml.
 */

function parseYAMLToGraph(text: string): Graph {
  const result = parse(text);
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

function reasonFor(text: string): string {
  const result = parse(text);
  if (result.ok) throw new Error("expected a refusal");
  return result.reason;
}

const testYaml = corpusText("parser-kubernetes.yaml");

/** A pipeline's group id, by the pipeline's name (ids are opaque, decision 7). */
function groupOf(result: Graph, pipelineName: string): string {
  const pipeline = result.pipelines.find((p) => p.name === pipelineName);
  if (!pipeline) throw new Error(`no pipeline ${pipelineName}`);
  return groupIdForPipeline(pipeline.id);
}

function componentNodes(graph: Graph): OTelNode[] {
  return graph.nodes.filter((n) => n.type !== "pipelineGroup");
}

describe("parseYAMLToGraph", () => {
  it("should parse YAML without errors", () => {
    const result = parse(testYaml);

    expect(result.ok).toBe(true);
  });

  it("should create correct number of receiver nodes", () => {
    const result = parseYAMLToGraph(testYaml);

    const receiverNodes = result.nodes.filter((n) => n.type === "receiver");
    expect(receiverNodes).toHaveLength(4); // otlp, k8s_events, kubeletstats, k8s_cluster
  });

  it("should create one processor node per pipeline membership", () => {
    const result = parseYAMLToGraph(testYaml);

    // Nodes are duplicated per pipeline group:
    // metrics/node (4) + metrics (3) + logs (1) + traces (2) = 10
    const processorNodes = result.nodes.filter((n) => n.type === "processor");
    expect(processorNodes).toHaveLength(10);

    // ...but instances of the same component share one config via sharedConfigId
    const sharedIds = new Set(processorNodes.map((n) => n.data.sharedConfigId));
    expect(sharedIds).toEqual(
      new Set([
        "processor-cumulativetodelta",
        "processor-filter",
        "processor-transform",
        "processor-k8sattributes",
      ]),
    );
  });

  it("should create one exporter node per pipeline membership", () => {
    const result = parseYAMLToGraph(testYaml);

    // otlphttp is referenced by all 4 pipelines → 4 nodes, 1 shared config
    const exporterNodes = result.nodes.filter((n) => n.type === "exporter");
    expect(exporterNodes).toHaveLength(4);
    expect(new Set(exporterNodes.map((n) => n.data.sharedConfigId))).toEqual(new Set(["exporter-otlphttp"]));
  });

  it("should create correct number of extension nodes", () => {
    const result = parseYAMLToGraph(testYaml);

    const extensionNodes = result.nodes.filter((n) => n.type === "extension");
    expect(extensionNodes).toHaveLength(2); // health_check, k8s_leader_elector
  });

  it("should create correct number of pipelines", () => {
    const result = parseYAMLToGraph(testYaml);

    expect(result.pipelines).toHaveLength(4); // metrics/node, metrics, logs, traces
  });

  it("should create pipeline objects with correct signal types", () => {
    const result = parseYAMLToGraph(testYaml);

    const pipelineSignalTypes = result.pipelines.map((p) => p.signalType);
    expect(pipelineSignalTypes).toContain("metrics");
    expect(pipelineSignalTypes).toContain("logs");
    expect(pipelineSignalTypes).toContain("traces");
  });

  // Resolve the per-group node created for a component. Node ids are opaque
  // ("node_N"); identity within a pipeline group = parentId + sharedConfigId.
  const findInGroup = (result: Graph, groupId: string, sharedConfigId: string) =>
    result.nodes.find((n) => n.parentId === groupId && n.data.sharedConfigId === sharedConfigId);

  it("should create edges connecting receivers to processors within a group", () => {
    const result = parseYAMLToGraph(testYaml);
    const metricsNodeGroup = groupOf(result, "metrics/node");

    // metrics/node pipeline: kubeletstats → filter (first processor)
    const kubeletstats = findInGroup(result, metricsNodeGroup, "receiver-kubeletstats");
    const filter = findInGroup(result, metricsNodeGroup, "processor-filter");
    expect(kubeletstats).toBeDefined();
    expect(filter).toBeDefined();

    const edge = result.edges.find((e) => e.source === kubeletstats!.id && e.target === filter!.id);
    expect(edge).toBeDefined();
  });

  it("should create edges connecting processors to exporters within a group", () => {
    const result = parseYAMLToGraph(testYaml);
    const metricsNodeGroup = groupOf(result, "metrics/node");

    // metrics/node pipeline: cumulativetodelta (last processor) → otlphttp
    const cumulativetodelta = findInGroup(result, metricsNodeGroup, "processor-cumulativetodelta");
    const otlphttp = findInGroup(result, metricsNodeGroup, "exporter-otlphttp");
    expect(cumulativetodelta).toBeDefined();
    expect(otlphttp).toBeDefined();

    const edge = result.edges.find((e) => e.source === cumulativetodelta!.id && e.target === otlphttp!.id);
    expect(edge).toBeDefined();
  });

  it("should create edges connecting processors in chain within a group", () => {
    const result = parseYAMLToGraph(testYaml);
    const metricsNodeGroup = groupOf(result, "metrics/node");

    // metrics/node pipeline: filter → k8sattributes → transform → cumulativetodelta
    const chain = [
      "processor-filter",
      "processor-k8sattributes",
      "processor-transform",
      "processor-cumulativetodelta",
    ].map((sharedId) => findInGroup(result, metricsNodeGroup, sharedId));
    chain.forEach((node) => expect(node).toBeDefined());

    for (let i = 0; i < chain.length - 1; i++) {
      const edge = result.edges.find((e) => e.source === chain[i]!.id && e.target === chain[i + 1]!.id);
      expect(edge).toBeDefined();
    }
  });

  it("should not create edges across pipeline groups", () => {
    const result = parseYAMLToGraph(testYaml);

    const nodesById = new Map(result.nodes.map((n) => [n.id, n]));
    for (const edge of result.edges) {
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(source!.parentId).toBe(target!.parentId);
    }
  });

  it("should assign positions to all nodes", () => {
    const result = parseYAMLToGraph(testYaml);

    result.nodes.forEach((node) => {
      expect(node.position).toBeDefined();
      expect(typeof node.position.x).toBe("number");
      expect(typeof node.position.y).toBe("number");
    });
  });

  it("should preserve node data with component types", () => {
    const result = parseYAMLToGraph(testYaml);

    // otlp is only in the traces pipeline
    const otlpReceiver = findInGroup(result, groupOf(result, "traces"), "receiver-otlp");
    expect(otlpReceiver).toBeDefined();
    expect(otlpReceiver?.data.componentType).toBe("receiver");
    expect(otlpReceiver?.data.componentSubType).toBe("otlp");
    expect(otlpReceiver?.data.config).toHaveProperty("protocols");
    // D9a: the node records its key and its pipeline, for matching and edits.
    expect(otlpReceiver?.data.key).toBe("receivers.otlp");
    expect(otlpReceiver?.data.pipeline).toBe("traces");
  });

  // D9a Parity Notes: saved positions are kept by matching (decision 5, the
  // store's layout-match), so `parse` itself takes none and lays out afresh.
  it("should compute deterministic positions: the same text lays out the same", () => {
    const initialResult = parseYAMLToGraph(testYaml);
    const result = parseYAMLToGraph(testYaml);

    expect(result.nodes.map((n) => ({ id: n.id, position: n.position }))).toEqual(
      initialResult.nodes.map((n) => ({ id: n.id, position: n.position })),
    );
  });
});

describe("parseYAMLToGraph with renamed (snake_case) component types", () => {
  // The Collector renamed several types (k8sattributes → k8s_attributes in
  // v0.146.0, filelog → file_log in v0.149.0, resourcedetection →
  // resource_detection and loadbalancing → load_balancing in v0.153.0, and
  // the otlp exporter → otlp_grpc in core v1.50.0), keeping old names as
  // aliases. Configs written with the new canonical names must still resolve
  // to palette entries so nodes stay styled and editable.
  const renamedYaml = corpusText("renamed-types.yaml");

  it("parses without errors", () => {
    const result = parse(renamedYaml);
    expect(result.ok).toBe(true);
  });

  it("maps snake_case names back to palette subTypes", () => {
    const result = parseYAMLToGraph(renamedYaml);

    const subTypesByType = (type: string) =>
      result.nodes.filter((n) => n.type === type).map((n) => n.data.componentSubType);

    expect(subTypesByType("receiver")).toContain("filelog");
    expect(subTypesByType("processor")).toEqual(expect.arrayContaining(["k8sattributes", "resourcedetection"]));
    expect(subTypesByType("exporter")).toEqual(expect.arrayContaining(["otlp", "loadbalancing"]));
  });

  it("resolves palette labels instead of raw uppercase fallbacks", () => {
    const result = parseYAMLToGraph(renamedYaml);

    const labels = result.nodes.map((n) => n.data.label);
    expect(labels).not.toContain("K8S_ATTRIBUTES");
    expect(labels).not.toContain("FILE_LOG");
    expect(labels).not.toContain("RESOURCE_DETECTION");
    expect(labels).not.toContain("LOAD_BALANCING");
    expect(labels).not.toContain("OTLP_GRPC");
    expect(labels).toContain("Kubernetes Attributes");
    expect(labels).toContain("File Log");
  });

  it("still resolves the old palette spellings unchanged", () => {
    const result = parseYAMLToGraph(testYaml);
    const subTypes = result.nodes.map((n) => n.data.componentSubType);
    expect(subTypes).toContain("k8sattributes");
  });

  it("gives otlp_grpc the OTLP exporter's label and keeps its key (decision 3)", () => {
    const result = parseYAMLToGraph(renamedYaml);
    const exporter = result.nodes.find((n) => n.data.key === "exporters.otlp_grpc");

    expect(exporter?.data.label).toBe("OTLP");
    expect(exporter?.data.componentSubType).toBe("otlp");
    expect(exporter?.data.sharedConfigId).toBe("exporter-otlp_grpc");
  });

  it("gives otlp_http (the collector's name for otlphttp since 2026-01-08) the OTLP/HTTP exporter's label and keeps its key (D9b Preflight ruling 6)", () => {
    const result = parseYAMLToGraph(corpusText("renamed-types-canonical.yaml"));
    const exporter = result.nodes.find((n) => n.data.key === "exporters.otlp_http");

    expect(exporter?.data.label).toBe("OTLP/HTTP");
    expect(exporter?.data.componentSubType).toBe("otlphttp");
    expect(exporter?.data.sharedConfigId).toBe("exporter-otlp_http");
    expect(result.nodes.map((n) => n.data.label)).not.toContain("OTLP_HTTP");
  });

  it.each([
    ["k8s_objects", "k8sobjects", "K8s Objects"],
    ["kubelet_stats", "kubeletstats", "Kubelet Stats"],
    ["host_metrics", "hostmetrics", "Host Metrics"],
  ])(
    "gives %s (the collector's name at v0.162.0) the palette's %s entry and keeps its key (D9c decision 2; Preflight ruling 28)",
    (spelled, palette, label) => {
      const result = parseYAMLToGraph(corpusText("renamed-types-canonical.yaml"));
      const receiver = result.nodes.find((n) => n.data.key === `receivers.${spelled}`);

      expect(receiver?.data.label).toBe(label);
      expect(receiver?.data.componentSubType).toBe(palette);
      expect(receiver?.data.sharedConfigId).toBe(`receiver-${spelled}`);
      expect(result.nodes.map((n) => n.data.label)).not.toContain(spelled.toUpperCase());
    },
  );
  // D9d decision 2: each `type` with the palette's spelling as `deprecated_type` at v0.162.0:
  // processor/cumulativetodeltaprocessor/metadata.yaml:2-3, receiver/awss3receiver/metadata.yaml:2-3,
  // connector/spanmetricsconnector/metadata.yaml:1-2. The S3 exporter is still `awss3` (exporter/awss3exporter/metadata.yaml:1).
  describe("D9d's renamed types", () => {
    const TEXT = [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc: {}",
      "  aws_s3/archive:",
      "    s3downloader:",
      "      s3_bucket: archive",
      "processors:",
      "  cumulative_to_delta: {}",
      "exporters:",
      "  awss3:",
      "    s3uploader:",
      "      region: us-east-1",
      "      s3_bucket: archive",
      "  debug: {}",
      "connectors:",
      "  span_metrics: {}",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp, aws_s3/archive]",
      "      exporters: [awss3, span_metrics]",
      "    metrics:",
      "      receivers: [span_metrics]",
      "      processors: [cumulative_to_delta]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    it.each([
      ["processors.cumulative_to_delta", "processor", "cumulativetodelta"],
      ["receivers.aws_s3/archive", "receiver", "awss3"],
      ["connectors.span_metrics", "connector", "spanmetrics"],
      ["exporters.awss3", "exporter", "awss3"],
    ] as const)("%s maps to the palette's %s %s entry and keeps its key", (key, kind, palette) => {
      expect(paletteSubType(key.split(".")[1]!.split("/")[0]!, kind)).toBe(palette);
      const result = parseYAMLToGraph(TEXT);
      const node = result.nodes.find((n) => n.data.key === key);
      expect(node?.type).toBe(kind);
      expect(node?.data.componentSubType).toBe(palette);
      // An instance's label adds its name in brackets ("AWS S3 (archive)").
      expect(node?.data.label.startsWith(findPaletteEntry(kind, palette)!.label)).toBe(true);
    });

    it("the aws_s3 rename is the receiver's only: an exporter spelled aws_s3 (refused by the collector) gets no palette entry (final ruling F8)", () => {
      expect(labelFor("aws_s3", "receiver")).toEqual({ label: findPaletteEntry("receiver", "awss3")!.label, subType: "awss3" });
      expect(labelFor("aws_s3/archive", "exporter")).toEqual({ label: "AWS_S3 (archive)", subType: "aws_s3", instanceName: "archive" });
      const result = parseYAMLToGraph(TEXT.replace("  awss3:\n    s3uploader:", "  aws_s3:\n    s3uploader:").replace("exporters: [awss3, span_metrics]", "exporters: [aws_s3, span_metrics]"));
      const node = result.nodes.find((n) => n.data.key === "exporters.aws_s3");
      expect(node?.data.componentSubType).toBe("aws_s3");
      expect(node?.data.label).toBe("AWS_S3");
    });
  });
});

describe("parse refuses a text the canvas can't show, and says why (Preflight ruling 9)", () => {
  it("more than one document", () => {
    expect(reasonFor("receivers: {}\n---\nexporters: {}\n")).toBe(
      "Line 2, column 1: The text holds more than one YAML document; a configuration is one.",
    );
  });

  it("a syntax error, with its message, code, line and column", () => {
    expect(reasonFor("receivers:\n  otlp: [1\n")).toMatch(/^Line 3, column 1: .+ \([A-Z_]+\)$/);
    expect(reasonFor("receivers:\n\totlp: {}\n")).toBe(
      "Line 2, column 1: Tabs are not allowed as indentation (TAB_AS_INDENT)",
    );
  });

  it("a duplicate key, as the collector refuses", () => {
    expect(reasonFor("receivers:\n  otlp: {}\n  otlp: {}\n")).toBe(
      "Line 3, column 3: Map keys must be unique (DUPLICATE_KEY)",
    );
  });

  it("a top level that isn't a mapping", () => {
    const reason = "The top level must be a mapping of sections, such as receivers: and service:.";
    expect(reasonFor("just text\n")).toBe(`Line 1, column 1: ${reason}`);
    expect(reasonFor("- receivers\n")).toBe(`Line 1, column 1: ${reason}`);
  });

  it("an alias whose anchor isn't set before it", () => {
    expect(reasonFor("receivers:\n  otlp: *missing\n")).toBe(
      "Line 2, column 9: The alias *missing names no anchor set before it.",
    );
  });

  it("a merge from something that isn't a mapping", () => {
    const reason = "A merge key (<<) must name a mapping, or a list of them.";
    expect(reasonFor("receivers:\n  otlp:\n    <<: 5\n")).toBe(`Line 3, column 9: ${reason}`);
    expect(reasonFor("x: &x 1\nreceivers:\n  otlp:\n    <<: [*x]\n")).toBe(`Line 4, column 9: ${reason}`);
  });

  it("an alias bomb (Excessive alias count)", () => {
    const levels = ["a: &a [x,x,x,x,x,x,x,x,x,x]"];
    for (const [previous, next] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ] as const) {
      levels.push(`${next}: &${next} [${Array(10).fill(`*${previous}`).join(",")}]`);
    }
    expect(reasonFor(`${levels.join("\n")}\n`)).toBe(
      "The text resolves too many aliases (Excessive alias count), as an alias bomb does.",
    );
  });

  it("an alias inside its own anchor", () => {
    expect(reasonFor("x-loop: &loop\n  again: *loop\n")).toBe(
      "An alias is used inside its own anchor, so the value never ends.",
    );
  });

  it.each(["receivers", "processors", "exporters", "connectors", "extensions", "service"])(
    "a %s section that isn't a mapping",
    (section) => {
      expect(reasonFor(`${section}: [otlp]\n`)).toBe(`Line 1, column ${section.length + 3}: ${section} must be a mapping.`);
    },
  );

  it("a service.pipelines that isn't a mapping", () => {
    expect(reasonFor("service:\n  pipelines: [traces]\n")).toBe(
      "Line 2, column 14: service.pipelines must be a mapping of pipelines.",
    );
  });

  it("a pipeline that isn't a mapping, or whose lists aren't lists of names", () => {
    expect(reasonFor("service:\n  pipelines:\n    traces: [otlp]\n")).toBe(
      "Line 3, column 13: A pipeline must be a mapping of receivers, processors and exporters.",
    );
    expect(reasonFor("service:\n  pipelines:\n    traces:\n      receivers: otlp\n")).toBe(
      "Line 4, column 18: A pipeline's receivers must be a list of component names.",
    );
    expect(reasonFor("service:\n  pipelines:\n    traces:\n      exporters: [{a: 1}]\n")).toMatch(
      /A pipeline's exporters must be a list of component names\.$/,
    );
  });

  it("a service.extensions that isn't a list of names", () => {
    expect(reasonFor("service:\n  extensions: health_check\n")).toBe(
      "Line 2, column 15: service.extensions must be a list of extension names.",
    );
  });

  it("a section written through an alias: refused at the alias, or without a position inside it", () => {
    expect(reasonFor("x: &list [a]\nreceivers: *list\n")).toBe("Line 2, column 12: receivers must be a mapping.");
    expect(reasonFor("x: &svc {pipelines: [a]}\nservice: *svc\n")).toBe(
      "service.pipelines must be a mapping of pipelines.",
    );
  });
});

describe("parse reads YAML 1.2's core schema (Preflight ruling 2)", () => {
  const exporter = () =>
    parseYAMLToGraph(corpusText("numbers.yaml")).nodes.find((n) => n.data.key === "exporters.file")!.data
      .config as Record<string, unknown>;

  it("reads 0o17 and 0x1F as integers, as the collector does", () => {
    expect(exporter().octal).toBe(15);
    expect(exporter().hex).toBe(31);
  });

  it("keeps a date and yes as strings, and reads 0750 as decimal", () => {
    expect(exporter().date).toBe("2024-01-01");
    expect(exporter().yes_is_text).toBe("yes");
    expect(exporter().leading_zero).toBe(750);
    expect(exporter().exponent).toBe(1000);
  });
});

describe("parse (D9a)", () => {
  it("reads empty text as the three default pipelines, empty", () => {
    for (const text of ["", "# only a comment\n"]) {
      const graph = parseYAMLToGraph(text);
      expect(graph.pipelines.map((p) => [p.id, p.name])).toEqual([
        ["pipeline_0", "traces"],
        ["pipeline_1", "metrics"],
        ["pipeline_2", "logs"],
      ]);
      expect(graph.nodes.map((n) => n.id)).toEqual(["group_0", "group_1", "group_2"]);
      expect(graph.edges).toEqual([]);
    }
  });

  it("returns the document, keeping its source tokens for the text edits", () => {
    const result = parse(corpusText("starter.yaml"));
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.toJS()).toHaveProperty("service.pipelines.traces");
    expect(result.document.contents?.srcToken).toBeDefined();
  });

  it("puts a merge key's values in the component's config", () => {
    const graph = parseYAMLToGraph(corpusText("anchors-merges.yaml"));
    const config = (key: string) => graph.nodes.find((n) => n.data.key === key)?.data.config;

    expect(config("exporters.otlp_grpc/primary")).toEqual({
      timeout: "5s",
      compression: "gzip",
      endpoint: "primary:4317",
      tls: { insecure: true },
    });
    expect(config("exporters.otlp_grpc/backup")).toEqual({
      timeout: "10s",
      compression: "gzip",
      endpoint: "backup:4317",
    });
    expect(config("receivers.otlp/second")).toEqual(config("receivers.otlp"));
    expect(config("processors.batch/large")).toEqual({ timeout: "10s", send_batch_size: 8192 });
  });

  it("keeps a connector's place in a pipeline without processors (decision 3)", () => {
    const graph = parseYAMLToGraph(corpusText("connector-memberships.yaml"));
    const node = (key: string) => graph.nodes.find((n) => n.data.key === key)!;
    const bridge = groupOf(graph, "traces/bridge");
    const has = (source: string, target: string) =>
      graph.edges.some((e) => e.source === source && e.target === target);

    expect(has(node("connectors.forward").id, bridge)).toBe(true);
    expect(has(bridge, node("connectors.spanmetrics").id)).toBe(true);
    expect(has(bridge, node("connectors.forward/fanout").id)).toBe(true);
    expect(has(node("connectors.forward/fanout").id, groupOf(graph, "traces/building"))).toBe(true);
    // Where the pipeline has something to join, the edge joins it.
    expect(has(graph.nodes.find((n) => n.data.key === "receivers.otlp" && n.data.pipeline === "traces/in")!.id, node("connectors.forward").id)).toBe(true);
  });

  it("reads service.extensions: unlisted is disabled, listed but undeclared stays (decision 3)", () => {
    const disabled = parseYAMLToGraph(corpusText("extensions-disabled.yaml"));
    const enabled = (graph: Graph) =>
      graph.nodes.filter((n) => n.type === "extension").map((n) => [n.data.key, n.data.enabled, n.data.declared]);
    expect(enabled(disabled)).toEqual([
      ["extensions.health_check", true, undefined],
      ["extensions.pprof", false, undefined],
      ["extensions.zpages", true, undefined],
    ]);

    const undeclared = parseYAMLToGraph(corpusText("extensions-undeclared.yaml"));
    expect(enabled(undeclared)).toEqual([
      ["extensions.health_check", true, undefined],
      ["extensions.basicauth/server", true, false],
      ["extensions.oauth2client", true, false],
    ]);
  });

  it("shows a component a pipeline names but nobody declares, marked and without config (decision 3)", () => {
    const graph = parseYAMLToGraph(corpusText("undeclared-references.yaml"));
    const undeclared = componentNodes(graph)
      .filter((n) => n.data.declared === false)
      .map((n) => [n.data.key, n.data.label, n.data.config]);

    expect(undeclared).toEqual([
      ["receivers.zipkin", "Zipkin", null],
      ["processors.batch", "Batch", null],
      ["processors.memory_limiter", "Memory Limiter", null],
      ["exporters.debug", "Debug", null],
      ["exporters.spanmetrics", "SPANMETRICS", null],
    ]);
    expect(componentNodes(graph).find((n) => n.data.key === "receivers.otlp")?.data.declared).toBeUndefined();
  });

  it("keeps a component with no value as null, not {}", () => {
    const graph = parseYAMLToGraph(corpusText("null-values.yaml"));
    expect(graph.nodes.find((n) => n.data.key === "exporters.debug")?.data.config).toBeNull();
    expect(graph.pipelines.map((p) => p.name)).toEqual(["traces", "logs", "metrics"]);
  });

  it("labels an unknown component by its type, uppercased, and keeps its config", () => {
    const graph = parseYAMLToGraph(corpusText("unknown-keys.yaml"));
    const mysterious = graph.nodes.find((n) => n.data.key === "receivers.mysterious")!;
    expect(mysterious.data.label).toBe("MYSTERIOUS");
    expect(mysterious.data.config).toEqual({ level: 11 });
    expect(graph.nodes.find((n) => n.data.key === "processors.custom_enricher/eu")?.data.label).toBe(
      "CUSTOM_ENRICHER (eu)",
    );
  });

  it("splits an instance name at the first slash, as the collector does", () => {
    const graph = parseYAMLToGraph(corpusText("instance-names.yaml"));
    const otlp = graph.nodes.find((n) => n.data.key === "receivers.otlp/team/eu")!;
    expect(otlp.data.componentSubType).toBe("otlp");
    expect(otlp.data.instanceName).toBe("team/eu");
    expect(otlp.data.label).toBe("OTLP (team/eu)");
  });

  it("marks the signal-fixed connectors' signals only", () => {
    const graph = parseYAMLToGraph(corpusText("complex-config.yaml"));
    expect(graph.nodes.find((n) => n.data.key === "connectors.spanmetrics")?.data.connectorSignals).toEqual({
      inputSignal: "traces",
      outputSignal: "metrics",
    });
    const forward = parseYAMLToGraph(corpusText("forward-connector.yaml"));
    expect(forward.nodes.find((n) => n.data.key === "connectors.forward")?.data.connectorSignals).toBeUndefined();
  });

  it("shows declared components no pipeline uses, ungrouped", () => {
    const graph = parseYAMLToGraph(corpusText("orphans.yaml"));
    const ungrouped = componentNodes(graph)
      .filter((n) => n.parentId === undefined)
      .map((n) => n.data.key);
    expect(ungrouped).toEqual(["receivers.jaeger", "processors.batch", "processors.memory_limiter", "exporters.otlphttp"]);
  });

  it("gives a pipeline named for no signal the traces signal", () => {
    const graph = parseYAMLToGraph("service:\n  pipelines:\n    custom/x: {}\n    LOGS/upper: {}\n");
    expect(graph.pipelines.map((p) => [p.name, p.signalType, p.color])).toEqual([
      ["custom/x", "traces", "#f97316"],
      ["LOGS/upper", "logs", "#64748b"],
    ]);
  });

  it("reads CRLF text as it reads LF text", () => {
    const lf = parseYAMLToGraph(corpusText("starter.yaml"));
    const crlf = parseYAMLToGraph(corpusText("crlf.yaml"));
    expect(crlf).toEqual(lf);
  });
});
