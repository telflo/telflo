import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH,
  CONFIGURATION_ERROR_CODES,
  CONFIGURATION_NAME_MAXIMUM_LENGTH,
  CONFIGURATION_SEARCH_MAXIMUM_LENGTH,
  CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH,
  CONFIGURATION_YAML_MAXIMUM_LENGTH,
  ConfigurationDescriptionSchema,
  ConfigurationNameSchema,
  ConfigurationResponseSchema,
  ConfigurationSchema,
  ConfigurationVersionLabelSchema,
  ConfigurationVersionResponseSchema,
  ConfigurationVersionSchema,
  ConfigurationVersionSummaryResponseSchema,
  ConfigurationVersionSummarySchema,
  ConfigurationValidationResponseSchema,
  CONFIGURATION_VERSIONS_FILTERS,
  ConfigurationVersionListItemSchema,
  ConfigurationVersionsQuerySchema,
  ConfigurationVersionsResponseSchema,
  ConfigurationWithVersionResponseSchema,
  CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES,
  CONFIGURATIONS_LIST_FILTERS,
  CONFIGURATIONS_PAGE_DEFAULT_LIMIT,
  CONFIGURATIONS_PAGE_MAXIMUM_LIMIT,
  ConfigurationsPageSchema,
  CreateConfigurationRequestSchema,
  CreateConfigurationVersionRequestSchema,
  GRAPH_COLUMN_MAXIMUM_BYTES,
  GRAPH_COMPONENT_SUBTYPE_MAXIMUM_LENGTH,
  GRAPH_CONFIG_MAXIMUM_DEPTH,
  GRAPH_EDGE_ID_PATTERN,
  GRAPH_GROUP_ID_PATTERN,
  GRAPH_INSTANCE_NAME_MAXIMUM_LENGTH,
  GRAPH_LABEL_MAXIMUM_LENGTH,
  GRAPH_MAXIMUM_EDGES,
  GRAPH_MAXIMUM_NODES,
  GRAPH_MAXIMUM_PIPELINES,
  GRAPH_NODE_ID_PATTERN,
  GRAPH_PIPELINE_ID_PATTERN,
  GRAPH_PIPELINE_NAME_MAXIMUM_LENGTH,
  GRAPH_SHARED_CONFIG_ID_MAXIMUM_LENGTH,
  graphColumnByteLength,
  GraphEdgeSchema,
  GraphEdgesSchema,
  GraphNodeSchema,
  GraphNodesSchema,
  GraphPipelineSchema,
  GraphPipelinesSchema,
  hasUnstorableCharacter,
  hasYamlControlCharacter,
  isStorableJsonValue,
  ListConfigurationsQuerySchema,
  PublishConfigurationVersionRequestSchema,
  RenameConfigurationVersionRequestSchema,
  SaveConfigurationVersionRequestSchema,
  SelectConfigurationVersionRequestSchema,
  UpdateConfigurationRequestSchema,
  utf8ByteLength,
  ValidateConfigurationVersionRequestSchema,
  type ConfigurationErrorCode,
} from "./configurations.js";

/** Collector versions a request may not name: not `major.minor.patch` in ASCII digits. */
const COLLECTOR_VERSIONS_REFUSED: Array<[string, unknown]> = [
  ["a v prefix", "v0.162.0"],
  ["two parts", "0.162"],
  ["a pre-release suffix", "0.162.0-rc.1"],
  ["Arabic-Indic digits", "٠.١٦٢.٠"],
  ["''", ""],
  ["65 characters", `0.0.${"1".repeat(61)}`],
  ["U+0000", "0.162.0\u0000"],
  ["null", null],
  ["a number", 0.162],
];

describe("the limits", () => {
  it("are the name's, the description's, the search's and the page's", () => {
    expect(CONFIGURATION_NAME_MAXIMUM_LENGTH).toBe(200);
    expect(CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH).toBe(500);
    expect(CONFIGURATION_SEARCH_MAXIMUM_LENGTH).toBe(200);
    expect(CONFIGURATIONS_PAGE_DEFAULT_LIMIT).toBe(50);
    expect(CONFIGURATIONS_PAGE_MAXIMUM_LIMIT).toBe(100);
  });

  it("are 256 Ki characters for the YAML", () => {
    expect(CONFIGURATION_YAML_MAXIMUM_LENGTH).toBe(262_144);
  });
});

/** Characters Postgres can't store exactly: refused in a name, a description and a label. */
const UNSTORABLE = [
  ["U+0000", "a\u0000b"],
  ["a lone high surrogate", "a\ud800b"],
  ["a lone low surrogate", "a\udc00b"],
] as const;

describe("ConfigurationNameSchema", () => {
  it("trims the name, and counts its length after trimming", () => {
    expect(ConfigurationNameSchema.parse("  Gateway  ")).toBe("Gateway");
    expect(ConfigurationNameSchema.safeParse(`  ${"a".repeat(200)}  `).success).toBe(true);
  });

  it("accepts 1 and 200 characters, and refuses 201", () => {
    expect(ConfigurationNameSchema.safeParse("a").success).toBe(true);
    expect(ConfigurationNameSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(ConfigurationNameSchema.safeParse("a".repeat(201)).success).toBe(false);
  });

  it.each([
    ["an empty name", ""],
    ["a whitespace-only name", "  \t "],
  ])("refuses %s with the empty-name message", (_label, name) => {
    const result = ConfigurationNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Configuration name cannot be empty");
  });

  it("refuses null and a number", () => {
    expect(ConfigurationNameSchema.safeParse(null).success).toBe(false);
    expect(ConfigurationNameSchema.safeParse(42).success).toBe(false);
  });

  it.each(UNSTORABLE)("refuses %s, which Postgres can't store exactly", (_label, name) => {
    expect(ConfigurationNameSchema.safeParse(name).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ name }).success).toBe(false);
    expect(UpdateConfigurationRequestSchema.safeParse({ name }).success).toBe(false);
  });

  it("keeps a well-formed pair, which is one character", () => {
    expect(ConfigurationNameSchema.parse("Gateway 🚀")).toBe("Gateway 🚀");
  });
});

describe("ConfigurationDescriptionSchema", () => {
  it("trims, accepts '' and 500 characters, and refuses 501", () => {
    expect(ConfigurationDescriptionSchema.parse("  Collects traces  ")).toBe("Collects traces");
    expect(ConfigurationDescriptionSchema.parse("   ")).toBe("");
    expect(ConfigurationDescriptionSchema.safeParse("a".repeat(500)).success).toBe(true);
    expect(ConfigurationDescriptionSchema.safeParse(`  ${"a".repeat(500)}  `).success).toBe(true);
    expect(ConfigurationDescriptionSchema.safeParse("a".repeat(501)).success).toBe(false);
  });

  it.each(UNSTORABLE)("refuses %s, as the name does", (_label, description) => {
    expect(ConfigurationDescriptionSchema.safeParse(description).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ name: "A", description }).success).toBe(false);
    expect(UpdateConfigurationRequestSchema.safeParse({ description }).success).toBe(false);
  });
});

describe("CreateConfigurationRequestSchema", () => {
  it("accepts a name and a description, trimmed", () => {
    expect(CreateConfigurationRequestSchema.parse({ name: " Gateway ", description: " Prod " })).toEqual({
      name: "Gateway",
      description: "Prod",
    });
  });

  it("makes a description left out ''", () => {
    expect(CreateConfigurationRequestSchema.parse({ name: "Gateway" })).toEqual({ name: "Gateway", description: "" });
  });

  it("refuses a missing, empty or 201-character name", () => {
    expect(CreateConfigurationRequestSchema.safeParse({}).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ name: " " }).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ name: "a".repeat(201) }).success).toBe(false);
  });

  it("refuses a null or 501-character description", () => {
    expect(CreateConfigurationRequestSchema.safeParse({ name: "Gateway", description: null }).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ name: "Gateway", description: "a".repeat(501) }).success).toBe(
      false,
    );
  });

  it("accepts a collector distribution, left out meaning the catalogue's default", () => {
    expect(CreateConfigurationRequestSchema.parse({ name: "Gateway", collectorDistribution: "otelcol-contrib" })).toEqual({
      name: "Gateway",
      description: "",
      collectorDistribution: "otelcol-contrib",
    });
    expect(CreateConfigurationRequestSchema.parse({ name: "Gateway" })).not.toHaveProperty("collectorDistribution");
    // In the catalogue's format but not in it: the service's to refuse (collector_distribution_unknown).
    expect(CreateConfigurationRequestSchema.safeParse({ name: "Gateway", collectorDistribution: "clickstack" }).success).toBe(
      true,
    );
  });

  it.each([
    ["an upper-case id", "OtelCol-Contrib"],
    ["a space", "otelcol contrib"],
    ["a trailing hyphen", "otelcol-"],
    ["''", ""],
    ["65 characters", "a".repeat(65)],
    ["U+0000", "otelcol\u0000"],
    ["null", null],
    ["a number", 1],
  ])("refuses a collector distribution that is %s: not the catalogue's format", (_label, collectorDistribution) => {
    expect(CreateConfigurationRequestSchema.safeParse({ name: "Gateway", collectorDistribution }).success).toBe(false);
  });

  it("refuses an unknown field, yaml among them", () => {
    expect(CreateConfigurationRequestSchema.safeParse({ name: "Gateway", yaml: "receivers: {}" }).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ name: "Gateway", distribution: "otelcol" }).success).toBe(
      false,
    );
  });
});

describe("CreateConfigurationRequestSchema from a flow", () => {
  /** A flow's YAML as the seed holds it: a trailing newline and an env reference, kept as they are. */
  const yamlContent = "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: ${env:OTLP_ENDPOINT}\n";
  /** A graph as `toStored` writes it: a pipeline's group, a component in it, and the pipeline. */
  const graph = {
    nodes: [
      {
        id: "group_0",
        type: "pipelineGroup",
        position: { x: 50, y: 30 },
        style: { width: 980, height: 240 },
        data: { label: "traces", pipelineId: "pipeline_0", signalType: "traces", color: "#f97316" },
      },
      {
        id: "node_0",
        type: "receiver",
        parentId: "group_0",
        position: { x: 50, y: 70 },
        data: {
          label: "OTLP",
          componentType: "receiver",
          componentSubType: "otlp",
          config: { protocols: { grpc: { endpoint: "${env:OTLP_ENDPOINT}" } } },
        },
      },
    ],
    edges: [],
    pipelines: [{ id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316" }],
  };
  const fromFlow = {
    name: "PII Redaction Gateway",
    description: "",
    collectorDistribution: "otelcol-contrib",
    yamlContent,
    ...graph,
    collectorVersion: "0.162.0",
    sourceFlowSlug: "pii-redaction-gateway",
  };

  it("accepts a flow's content, collector version and slug, and keeps each exactly as sent", () => {
    expect(CreateConfigurationRequestSchema.parse(fromFlow)).toEqual(fromFlow);
    expect(CreateConfigurationRequestSchema.parse(fromFlow).yamlContent).toBe(yamlContent);
  });

  it("leaves each out of a create without them, which parses exactly as before", () => {
    const parsed = CreateConfigurationRequestSchema.parse({ name: "Gateway" });
    expect(parsed).toEqual({ name: "Gateway", description: "" });
    for (const field of ["yamlContent", "nodes", "edges", "pipelines", "collectorVersion", "sourceFlowSlug"]) {
      expect(parsed).not.toHaveProperty(field);
    }
  });

  /** Every proper, non-empty subset of the content's four fields. */
  const CONTENT = { yamlContent, ...graph };
  const FIELDS = ["yamlContent", "nodes", "edges", "pipelines"] as const;
  const subsets = Array.from({ length: 2 ** FIELDS.length - 2 }, (_, index) =>
    FIELDS.filter((_field, bit) => ((index + 1) & (1 << bit)) !== 0),
  );

  it.each(subsets.map((subset) => [subset.join(", "), subset] as const))(
    "refuses %s without the rest: the content comes whole or not at all",
    (_label, subset) => {
      const request = { name: "Gateway", ...Object.fromEntries(subset.map((field) => [field, CONTENT[field]])) };
      const result = CreateConfigurationRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
      // The refusal names the rule, never a value of the text.
      expect(JSON.stringify(result.error?.issues)).not.toContain("OTLP_ENDPOINT");
    },
  );

  it("has exactly fourteen such subsets, and the whole four accepted", () => {
    expect(new Set(subsets.map((subset) => subset.join())).size).toBe(14);
    expect(CreateConfigurationRequestSchema.safeParse({ name: "Gateway", ...CONTENT }).success).toBe(true);
  });

  it("accepts the collector version and the slug each without the content, or the other", () => {
    expect(CreateConfigurationRequestSchema.parse({ name: "Gateway", collectorVersion: "0.161.0" })).toEqual({
      name: "Gateway",
      description: "",
      collectorVersion: "0.161.0",
    });
    expect(CreateConfigurationRequestSchema.parse({ name: "Gateway", sourceFlowSlug: "a" })).toEqual({
      name: "Gateway",
      description: "",
      sourceFlowSlug: "a",
    });
  });

  it("has the save's limits on the content", () => {
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, yamlContent: "a".repeat(262_144) }).success).toBe(
      true,
    );
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, yamlContent: "a".repeat(262_145) }).success).toBe(
      false,
    );
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, yamlContent: "a\u0000" }).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, yamlContent: "a: \ud800" }).success).toBe(false);
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, yamlContent: "" }).success).toBe(true);
    // A component id carrying a name, and React Flow's runtime field.
    expect(
      CreateConfigurationRequestSchema.safeParse({ ...fromFlow, nodes: [{ ...graph.nodes[1], id: "receiver-otlp" }] })
        .success,
    ).toBe(false);
    expect(
      CreateConfigurationRequestSchema.safeParse({ ...fromFlow, nodes: [{ ...graph.nodes[1], measured: { width: 1 } }] })
        .success,
    ).toBe(false);
    const receiver = graph.nodes[1]!;
    // Small nodes, so the count is the bound reached, not the column's bytes.
    const nodes = Array.from({ length: GRAPH_MAXIMUM_NODES + 1 }, (_, index) => ({
      ...receiver,
      id: `node_${index}`,
      data: { ...receiver.data, config: null },
    }));
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, nodes }).success).toBe(false);
    expect(
      CreateConfigurationRequestSchema.safeParse({ ...fromFlow, nodes: nodes.slice(0, GRAPH_MAXIMUM_NODES) }).success,
    ).toBe(true);
    const padding = (bytes: number) => {
      const config = (length: number) => [{ ...receiver, data: { ...receiver.data, config: "a".repeat(length) } }];
      return config(bytes - graphColumnByteLength(config(0)));
    };
    expect(GraphNodesSchema.safeParse(padding(GRAPH_COLUMN_MAXIMUM_BYTES)).success).toBe(true);
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, nodes: padding(GRAPH_COLUMN_MAXIMUM_BYTES) }).success).toBe(
      true,
    );
    expect(
      CreateConfigurationRequestSchema.safeParse({ ...fromFlow, nodes: padding(GRAPH_COLUMN_MAXIMUM_BYTES + 1) }).success,
    ).toBe(false);
    for (const column of ["nodes", "edges", "pipelines"] as const) {
      expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, [column]: null }).success).toBe(false);
      expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, [column]: {} }).success).toBe(false);
    }
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, yamlContent: null }).success).toBe(false);
  });

  it.each(COLLECTOR_VERSIONS_REFUSED)("refuses a collector version that is %s: not the catalogue's format", (_label, collectorVersion) => {
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, collectorVersion }).success).toBe(false);
  });

  it.each([
    ["''", ""],
    ["upper case", "PII-Redaction"],
    ["a space", "pii redaction"],
    ["a leading hyphen", "-pii"],
    ["a trailing hyphen", "pii-"],
    ["two hyphens in a row", "pii--redaction"],
    ["an underscore", "pii_redaction"],
    ["surrounding whitespace, which isn't trimmed", " pii-redaction "],
    ["81 characters", "a".repeat(81)],
    ["null", null],
    ["a number", 42],
  ])("refuses a source flow slug that is %s: the slug's format only", (_label, sourceFlowSlug) => {
    expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, sourceFlowSlug }).success).toBe(false);
  });

  it("accepts any slug in the format, up to 80 characters, whether or not such a flow exists", () => {
    for (const sourceFlowSlug of ["a", "0", "a".repeat(80), "no-such-flow-2", "telflo"]) {
      expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, sourceFlowSlug }).success).toBe(true);
    }
  });

  it("still refuses an unknown field with the flow's inputs, a flow's own field names among them", () => {
    for (const extra of [{ yaml: yamlContent }, { flowSlug: "pii-redaction-gateway" }, { source_flow_slug: "a" }]) {
      expect(CreateConfigurationRequestSchema.safeParse({ ...fromFlow, ...extra }).success).toBe(false);
    }
  });
});

describe("UpdateConfigurationRequestSchema", () => {
  it("accepts the name, the description, both or neither, trimmed", () => {
    expect(UpdateConfigurationRequestSchema.parse({ name: " Renamed " })).toEqual({ name: "Renamed" });
    expect(UpdateConfigurationRequestSchema.parse({ description: " New " })).toEqual({ description: "New" });
    expect(UpdateConfigurationRequestSchema.parse({ name: "A", description: "B" })).toEqual({
      name: "A",
      description: "B",
    });
    expect(UpdateConfigurationRequestSchema.parse({})).toEqual({});
  });

  it("accepts '' as the description, which clears it", () => {
    expect(UpdateConfigurationRequestSchema.parse({ description: "" })).toEqual({ description: "" });
  });

  it("refuses null for either field", () => {
    expect(UpdateConfigurationRequestSchema.safeParse({ description: null }).success).toBe(false);
    expect(UpdateConfigurationRequestSchema.safeParse({ name: null }).success).toBe(false);
  });

  it("refuses an empty or 201-character name, and a 501-character description", () => {
    const empty = UpdateConfigurationRequestSchema.safeParse({ name: "" });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe("Configuration name cannot be empty");
    expect(UpdateConfigurationRequestSchema.safeParse({ name: "a".repeat(201) }).success).toBe(false);
    expect(UpdateConfigurationRequestSchema.safeParse({ description: "a".repeat(501) }).success).toBe(false);
  });

  it("refuses an unknown field in an update, yaml among them", () => {
    expect(UpdateConfigurationRequestSchema.safeParse({ yaml: "receivers: {}" }).success).toBe(false);
    expect(UpdateConfigurationRequestSchema.safeParse({ name: "A", createdBy: null }).success).toBe(false);
  });
});

describe("ConfigurationSchema", () => {
  const configuration = {
    id: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f",
    name: "Gateway",
    description: "",
    createdAt: "2026-09-27T12:00:00.000Z",
    updatedAt: "2026-09-27T12:30:00.000Z",
    createdBy: { userId: "5e2c7a1b-8d3f-4c6e-a9b0-1f2e3d4c5b6a", email: "creator@example.com" },
    published: false,
    collectorDistribution: "otelcol-contrib",
  };

  it("accepts a configuration with its creator, and one whose creator is gone", () => {
    expect(ConfigurationSchema.safeParse(configuration).success).toBe(true);
    expect(ConfigurationSchema.safeParse({ ...configuration, createdBy: null }).success).toBe(true);
  });

  it("says whether it is published: a boolean, always there", () => {
    expect(ConfigurationSchema.safeParse({ ...configuration, published: true }).success).toBe(true);
    const { published: _omitted, ...withoutPublished } = configuration;
    expect(ConfigurationSchema.safeParse(withoutPublished).success).toBe(false);
    expect(ConfigurationSchema.safeParse({ ...configuration, published: null }).success).toBe(false);
    expect(ConfigurationSchema.safeParse({ ...configuration, published: "true" }).success).toBe(false);
  });

  it("carries its collector distribution: a string, always there", () => {
    expect(ConfigurationSchema.parse(configuration).collectorDistribution).toBe("otelcol-contrib");
    const { collectorDistribution: _omitted, ...withoutDistribution } = configuration;
    expect(ConfigurationSchema.safeParse(withoutDistribution).success).toBe(false);
    expect(ConfigurationSchema.safeParse({ ...configuration, collectorDistribution: null }).success).toBe(false);
  });

  it("refuses a non-ISO timestamp, a non-UUID id, a missing creator and extra keys", () => {
    const { createdBy: _omitted, ...withoutCreator } = configuration;
    expect(ConfigurationSchema.safeParse({ ...configuration, updatedAt: "yesterday" }).success).toBe(false);
    expect(ConfigurationSchema.safeParse({ ...configuration, id: "42" }).success).toBe(false);
    expect(ConfigurationSchema.safeParse(withoutCreator).success).toBe(false);
    expect(ConfigurationSchema.safeParse({ ...configuration, deletedAt: null }).success).toBe(false);
    expect(
      ConfigurationSchema.safeParse({ ...configuration, createdBy: { ...configuration.createdBy, role: "admin" } })
        .success,
    ).toBe(false);
  });

  it("is answered as { configuration } and listed as { items, nextCursor }", () => {
    expect(ConfigurationResponseSchema.safeParse({ configuration }).success).toBe(true);
    expect(ConfigurationsPageSchema.safeParse({ items: [configuration], nextCursor: "abc" }).success).toBe(true);
    expect(ConfigurationsPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(ConfigurationsPageSchema.safeParse({ items: [] }).success).toBe(false);
    expect(ConfigurationsPageSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(false);
  });
});

describe("ConfigurationVersionSchema", () => {
  const configuration = {
    id: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f",
    name: "Gateway",
    description: "",
    createdAt: "2026-09-27T12:00:00.000Z",
    updatedAt: "2026-09-27T12:30:00.000Z",
    createdBy: null,
    published: true,
    collectorDistribution: "otelcol-contrib",
  };
  const version = {
    id: "0192f1a4-7b3c-7d2e-8f10-6f5e4d3c2b1a",
    configurationId: configuration.id,
    versionNumber: 1,
    label: "Add tail sampling",
    createdBy: { userId: "5e2c7a1b-8d3f-4c6e-a9b0-1f2e3d4c5b6a", email: "creator@example.com" },
    yamlContent: "receivers:\n  otlp: {}\n",
    nodes: [],
    edges: [],
    pipelines: [],
    createdAt: "2026-09-27T12:00:00.000Z",
    updatedAt: "2026-09-28T09:15:00.000Z",
    publishedAt: "2026-09-28T10:00:00.000Z",
    publishedBy: { userId: "6f3d8b2c-9e40-4d7f-b0c1-2a3b4c5d6e7f", email: "publisher@example.com" },
    collectorVersion: "0.162.0",
    collectorVersionDeprecated: false,
    collectorVersionDeprecatedNote: null,
  };
  const { configurationId: _c, yamlContent: _y, nodes: _n, edges: _e, pipelines: _p, ...summary } = version;

  it("accepts a version, its YAML empty or not", () => {
    expect(ConfigurationVersionSchema.safeParse(version).success).toBe(true);
    expect(ConfigurationVersionSchema.safeParse({ ...version, yamlContent: "" }).success).toBe(true);
  });

  it("answers the graph's columns as arrays of anything, so another writer's rows still open", () => {
    const foreign = {
      ...version,
      nodes: [{ id: "group-pipeline-traces", measured: { width: 1 } }, 42, null],
      edges: ["anything"],
      pipelines: [{ name: "traces/production" }],
    };
    expect(ConfigurationVersionSchema.parse(foreign)).toEqual(foreign);
  });

  it("requires the graph's three columns, each an array", () => {
    for (const column of ["nodes", "edges", "pipelines"] as const) {
      const { [column]: _dropped, ...without } = version;
      expect(ConfigurationVersionSchema.safeParse(without).success).toBe(false);
      expect(ConfigurationVersionSchema.safeParse({ ...version, [column]: {} }).success).toBe(false);
      expect(ConfigurationVersionSchema.safeParse({ ...version, [column]: null }).success).toBe(false);
    }
  });

  it("refuses version 0, a fractional version, a non-UUID id, a non-ISO timestamp and extra keys", () => {
    expect(ConfigurationVersionSchema.safeParse({ ...version, versionNumber: 0 }).success).toBe(false);
    expect(ConfigurationVersionSchema.safeParse({ ...version, versionNumber: 1.5 }).success).toBe(false);
    expect(ConfigurationVersionSchema.safeParse({ ...version, configurationId: "42" }).success).toBe(false);
    expect(ConfigurationVersionSchema.safeParse({ ...version, updatedAt: "yesterday" }).success).toBe(false);
    expect(ConfigurationVersionSchema.safeParse({ ...version, createdByUserId: null }).success).toBe(false);
  });

  it("accepts an unnamed version, and one whose creator is gone", () => {
    expect(ConfigurationVersionSchema.safeParse({ ...version, label: null }).success).toBe(true);
    expect(ConfigurationVersionSchema.safeParse({ ...version, createdBy: null }).success).toBe(true);
  });

  it("accepts a draft: no publish time and no publisher, and a published version whose publisher is gone", () => {
    const draft = { ...version, publishedAt: null, publishedBy: null };
    expect(ConfigurationVersionSchema.safeParse(draft).success).toBe(true);
    expect(
      ConfigurationVersionSummarySchema.safeParse({ ...summary, publishedAt: null, publishedBy: null }).success,
    ).toBe(true);
    expect(ConfigurationVersionSchema.safeParse({ ...version, publishedBy: null }).success).toBe(true);
  });

  it("refuses a non-ISO publish time, and a publisher of another shape than the creator's", () => {
    expect(ConfigurationVersionSchema.safeParse({ ...version, publishedAt: "yesterday" }).success).toBe(false);
    expect(
      ConfigurationVersionSchema.safeParse({ ...version, publishedBy: { userId: "42", email: "a@b" } }).success,
    ).toBe(false);
    expect(
      ConfigurationVersionSchema.safeParse({ ...version, publishedBy: { ...version.publishedBy, role: "admin" } })
        .success,
    ).toBe(false);
    expect(ConfigurationVersionSchema.safeParse({ ...version, publishedByUserId: null }).success).toBe(false);
  });

  it("carries its collector version and whether the catalogue deprecated it since, with the catalogue's note", () => {
    expect(ConfigurationVersionSummarySchema.parse(summary)).toMatchObject({
      collectorVersion: "0.162.0",
      collectorVersionDeprecated: false,
      collectorVersionDeprecatedNote: null,
    });
    const deprecated = {
      ...summary,
      collectorVersion: "0.155.0",
      collectorVersionDeprecated: true,
      collectorVersionDeprecatedNote: "Retired: upgrade to 0.162.0.",
    };
    expect(ConfigurationVersionSummarySchema.parse(deprecated)).toEqual(deprecated);
    expect(ConfigurationVersionSchema.safeParse({ ...version, ...deprecated }).success).toBe(true);
    expect(ConfigurationVersionSummarySchema.safeParse({ ...summary, collectorVersionDeprecated: "false" }).success).toBe(
      false,
    );
    expect(ConfigurationVersionSummarySchema.safeParse({ ...summary, collectorVersionDeprecatedNote: 1 }).success).toBe(
      false,
    );
    // The configuration carries the distribution; a summary doesn't.
    expect(ConfigurationVersionSummarySchema.safeParse({ ...summary, collectorDistribution: "otelcol-contrib" }).success).toBe(
      false,
    );
  });

  it.each([
    "label",
    "createdBy",
    "publishedAt",
    "publishedBy",
    "collectorVersion",
    "collectorVersionDeprecated",
    "collectorVersionDeprecatedNote",
  ] as const)("refuses a version without %s, and its summary too", (field) => {
    const { [field]: _dropped, ...without } = version;
    const { [field]: _alsoDropped, ...summaryWithout } = summary;
    expect(ConfigurationVersionSchema.safeParse(without).success).toBe(false);
    expect(ConfigurationVersionSummarySchema.safeParse(summaryWithout).success).toBe(false);
    expect(ConfigurationVersionResponseSchema.safeParse({ version: without }).success).toBe(false);
    expect(ConfigurationVersionSummaryResponseSchema.safeParse({ version: summaryWithout }).success).toBe(false);
    expect(
      ConfigurationWithVersionResponseSchema.safeParse({ configuration, version: without, versions: [summary] }).success,
    ).toBe(false);
    expect(
      ConfigurationWithVersionResponseSchema.safeParse({ configuration, version, versions: [summaryWithout] }).success,
    ).toBe(false);
  });

  it("is answered as { configuration, version, versions } by a read and as { version } by a save or a create", () => {
    expect(ConfigurationWithVersionResponseSchema.safeParse({ configuration, version, versions: [summary] }).success).toBe(
      true,
    );
    expect(ConfigurationWithVersionResponseSchema.safeParse({ configuration, version }).success).toBe(false);
    expect(ConfigurationWithVersionResponseSchema.safeParse({ configuration, versions: [summary] }).success).toBe(false);
    expect(
      ConfigurationWithVersionResponseSchema.safeParse({ configuration, version, versions: [summary], extra: 1 }).success,
    ).toBe(false);
    expect(ConfigurationVersionResponseSchema.safeParse({ version }).success).toBe(true);
    expect(ConfigurationVersionResponseSchema.safeParse({ version, configuration }).success).toBe(false);
  });

  it("lists summaries without content: a summary carrying the YAML is refused", () => {
    expect(ConfigurationVersionSummarySchema.safeParse(summary).success).toBe(true);
    expect(ConfigurationVersionSummarySchema.safeParse({ ...summary, yamlContent: "" }).success).toBe(false);
    expect(
      ConfigurationWithVersionResponseSchema.safeParse({ configuration, version, versions: [version] }).success,
    ).toBe(false);
  });

  it("answers a rename as { version } holding a summary", () => {
    expect(ConfigurationVersionSummaryResponseSchema.safeParse({ version: summary }).success).toBe(true);
    expect(ConfigurationVersionSummaryResponseSchema.safeParse({ version }).success).toBe(false);
    expect(ConfigurationVersionSummaryResponseSchema.safeParse({ version: { ...summary, versionNumber: 0 } }).success).toBe(
      false,
    );
  });

  it("answers the versions route as { versions } of id, number, label and published date only", () => {
    const item = { id: summary.id, versionNumber: 1, label: summary.label, publishedAt: summary.publishedAt };
    expect(ConfigurationVersionListItemSchema.parse(item)).toEqual(item);
    expect(ConfigurationVersionListItemSchema.safeParse({ ...item, label: null, publishedAt: null }).success).toBe(true);
    expect(ConfigurationVersionsResponseSchema.parse({ versions: [item] })).toEqual({ versions: [item] });
    expect(ConfigurationVersionsResponseSchema.safeParse({ versions: [] }).success).toBe(true);
    // Neither a version nor its summary: no content, no layout, no member's email, no times, no collector version.
    expect(ConfigurationVersionsResponseSchema.safeParse({ versions: [version] }).success).toBe(false);
    expect(ConfigurationVersionsResponseSchema.safeParse({ versions: [summary] }).success).toBe(false);
    for (const key of [
      "yamlContent",
      "nodes",
      "edges",
      "pipelines",
      "configurationId",
      "createdBy",
      "publishedBy",
      "createdAt",
      "updatedAt",
      "collectorVersion",
      "collectorVersionDeprecated",
      "collectorVersionDeprecatedNote",
    ] as const) {
      expect(ConfigurationVersionListItemSchema.safeParse({ ...item, [key]: version[key] }).success).toBe(false);
    }
    for (const key of ["id", "versionNumber", "label", "publishedAt"] as const) {
      const { [key]: _dropped, ...without } = item;
      expect(ConfigurationVersionListItemSchema.safeParse(without).success).toBe(false);
    }
    expect(ConfigurationVersionListItemSchema.safeParse({ ...item, versionNumber: 0 }).success).toBe(false);
    expect(ConfigurationVersionListItemSchema.safeParse({ ...item, publishedAt: "yesterday" }).success).toBe(false);
    expect(ConfigurationVersionsResponseSchema.safeParse({}).success).toBe(false);
    expect(ConfigurationVersionsResponseSchema.safeParse({ versions: [item], nextCursor: null }).success).toBe(false);
    expect(ConfigurationVersionsResponseSchema.safeParse({ versions: [item], configuration }).success).toBe(false);
  });
});

describe("ConfigurationVersionsQuerySchema", () => {
  it("defaults to every version (filter all)", () => {
    expect(ConfigurationVersionsQuerySchema.parse({})).toEqual({ filter: "all" });
  });

  it("offers exactly all and published", () => {
    expect(CONFIGURATION_VERSIONS_FILTERS).toEqual(["all", "published"]);
  });

  it.each(CONFIGURATION_VERSIONS_FILTERS)("accepts filter=%s", (filter) => {
    expect(ConfigurationVersionsQuerySchema.parse({ filter })).toEqual({ filter });
  });

  it.each(["", "mine", "Published", "drafts", "true"])("refuses filter=%j", (filter) => {
    expect(ConfigurationVersionsQuerySchema.safeParse({ filter }).success).toBe(false);
  });

  it("refuses an unknown parameter, a page's, and a repeated filter", () => {
    expect(ConfigurationVersionsQuerySchema.safeParse({ unknown: "1" }).success).toBe(false);
    expect(ConfigurationVersionsQuerySchema.safeParse({ limit: "10" }).success).toBe(false);
    expect(ConfigurationVersionsQuerySchema.safeParse({ cursor: "abc" }).success).toBe(false);
    expect(ConfigurationVersionsQuerySchema.safeParse({ filter: ["all", "published"] }).success).toBe(false);
  });
});

describe("ConfigurationVersionLabelSchema", () => {
  it("is 80 characters at most", () => {
    expect(CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH).toBe(80);
  });

  it("trims the label, and counts its length after trimming", () => {
    expect(ConfigurationVersionLabelSchema.parse("  Add tail sampling  ")).toBe("Add tail sampling");
    expect(ConfigurationVersionLabelSchema.parse(` ${"a".repeat(80)}\t`)).toBe("a".repeat(80));
  });

  it("accepts 1 and 80 characters, and refuses 81", () => {
    expect(ConfigurationVersionLabelSchema.safeParse("a").success).toBe(true);
    expect(ConfigurationVersionLabelSchema.safeParse("a".repeat(80)).success).toBe(true);
    expect(ConfigurationVersionLabelSchema.safeParse("a".repeat(81)).success).toBe(false);
  });

  it.each(["", "   ", "\t\n"])("refuses %j", (label) => {
    expect(ConfigurationVersionLabelSchema.safeParse(label).success).toBe(false);
  });

  it.each(UNSTORABLE)("refuses %s, which Postgres can't store exactly, in a label", (_label, label) => {
    expect(ConfigurationVersionLabelSchema.safeParse(label).success).toBe(false);
  });

  it("keeps a well-formed pair", () => {
    expect(ConfigurationVersionLabelSchema.parse("Tail sampling 🚀")).toBe("Tail sampling 🚀");
  });
});

describe("CreateConfigurationVersionRequestSchema", () => {
  const SOURCE = "0192f1a4-7b3c-7d2e-8f10-6f5e4d3c2b1a";
  const content = { yamlContent: "receivers:\r\n  otlp: {} # 🚀\n", nodes: [], edges: [], pipelines: [] };
  const request = { sourceVersionId: SOURCE, ...content };

  it("accepts the save's content and the source, the label left out meaning none", () => {
    expect(CreateConfigurationVersionRequestSchema.parse(request)).toEqual(request);
    expect(CreateConfigurationVersionRequestSchema.parse(request).label).toBeUndefined();
  });

  it("trims the label, and accepts 80 characters", () => {
    expect(CreateConfigurationVersionRequestSchema.parse({ ...request, label: "  Add tail sampling " }).label).toBe(
      "Add tail sampling",
    );
    expect(CreateConfigurationVersionRequestSchema.parse({ ...request, label: "a".repeat(80) }).label).toBe(
      "a".repeat(80),
    );
  });

  it.each(["", "   ", "\t \n"])("takes %j as no label", (label) => {
    const parsed = CreateConfigurationVersionRequestSchema.parse({ ...request, label });
    expect(parsed.label).toBeUndefined();
  });

  it("refuses an 81-character label, after trimming, and a null one", () => {
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, label: "a".repeat(81) }).success).toBe(false);
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, label: ` ${"a".repeat(80)} ` }).success).toBe(
      true,
    );
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, label: null }).success).toBe(false);
  });

  it.each(UNSTORABLE)("refuses a label holding %s on a create", (_label, label) => {
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, label }).success).toBe(false);
  });

  it("refuses a create without sourceVersionId", () => {
    expect(CreateConfigurationVersionRequestSchema.safeParse(content).success).toBe(false);
  });

  it("accepts a collector version, left out meaning the source's", () => {
    expect(CreateConfigurationVersionRequestSchema.parse({ ...request, collectorVersion: "0.161.0" })).toEqual({
      ...request,
      collectorVersion: "0.161.0",
    });
    expect(CreateConfigurationVersionRequestSchema.parse(request)).not.toHaveProperty("collectorVersion");
  });

  it.each(COLLECTOR_VERSIONS_REFUSED)("refuses a collector version that is %s: not the catalogue's format", (_label, collectorVersion) => {
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, collectorVersion }).success).toBe(false);
  });

  it("refuses a distribution: the server stamps the configuration's", () => {
    expect(
      CreateConfigurationVersionRequestSchema.safeParse({ ...request, collectorDistribution: "otelcol-contrib" }).success,
    ).toBe(false);
  });

  it("takes any source id up to 64 characters, so the service answers a malformed one 404", () => {
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, sourceVersionId: "not-a-uuid" }).success).toBe(
      true,
    );
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, sourceVersionId: "a".repeat(64) }).success).toBe(
      true,
    );
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, sourceVersionId: "a".repeat(65) }).success).toBe(
      false,
    );
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, sourceVersionId: 42 }).success).toBe(false);
  });

  it("has the save's limits on the content", () => {
    expect(
      CreateConfigurationVersionRequestSchema.safeParse({ ...request, yamlContent: "a".repeat(262_144) }).success,
    ).toBe(true);
    expect(
      CreateConfigurationVersionRequestSchema.safeParse({ ...request, yamlContent: "a".repeat(262_145) }).success,
    ).toBe(false);
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, yamlContent: "a\u0000" }).success).toBe(false);
    expect(
      CreateConfigurationVersionRequestSchema.safeParse({ ...request, nodes: [{ id: "node-otlp", type: "receiver" }] })
        .success,
    ).toBe(false);
    for (const column of ["yamlContent", "nodes", "edges", "pipelines"] as const) {
      const { [column]: _dropped, ...without } = request;
      expect(CreateConfigurationVersionRequestSchema.safeParse(without).success).toBe(false);
    }
  });

  it("refuses unknown fields", () => {
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, versionNumber: 2 }).success).toBe(false);
    expect(CreateConfigurationVersionRequestSchema.safeParse({ ...request, configurationId: SOURCE }).success).toBe(
      false,
    );
  });
});

describe("RenameConfigurationVersionRequestSchema", () => {
  it("trims the label", () => {
    expect(RenameConfigurationVersionRequestSchema.parse({ label: "  Renamed  " })).toEqual({ label: "Renamed" });
  });

  it("accepts 80 characters and refuses 81", () => {
    expect(RenameConfigurationVersionRequestSchema.safeParse({ label: "a".repeat(80) }).success).toBe(true);
    expect(RenameConfigurationVersionRequestSchema.safeParse({ label: "a".repeat(81) }).success).toBe(false);
  });

  it.each(["", "   "])("refuses %j: a rename can't clear the label", (label) => {
    expect(RenameConfigurationVersionRequestSchema.safeParse({ label }).success).toBe(false);
  });

  it.each(UNSTORABLE)("refuses a label holding %s on a rename", (_label, label) => {
    expect(RenameConfigurationVersionRequestSchema.safeParse({ label }).success).toBe(false);
  });

  it("refuses a missing or null label, and unknown fields", () => {
    expect(RenameConfigurationVersionRequestSchema.safeParse({}).success).toBe(false);
    expect(RenameConfigurationVersionRequestSchema.safeParse({ label: null }).success).toBe(false);
    expect(RenameConfigurationVersionRequestSchema.safeParse({ label: "A", versionNumber: 2 }).success).toBe(false);
  });
});

describe("SelectConfigurationVersionRequestSchema", () => {
  it("takes a version id, any string up to 64 characters", () => {
    const versionId = "0192f1a4-7b3c-7d2e-8f10-6f5e4d3c2b1a";
    expect(SelectConfigurationVersionRequestSchema.parse({ versionId })).toEqual({ versionId });
    expect(SelectConfigurationVersionRequestSchema.safeParse({ versionId: "42" }).success).toBe(true);
    expect(SelectConfigurationVersionRequestSchema.safeParse({ versionId: "a".repeat(65) }).success).toBe(false);
  });

  it("refuses a missing or null id, and unknown fields", () => {
    expect(SelectConfigurationVersionRequestSchema.safeParse({}).success).toBe(false);
    expect(SelectConfigurationVersionRequestSchema.safeParse({ versionId: null }).success).toBe(false);
    expect(SelectConfigurationVersionRequestSchema.safeParse({ versionId: "a", userId: "b" }).success).toBe(false);
  });
});

describe("PublishConfigurationVersionRequestSchema", () => {
  it("takes the version's updatedAt as a summary reports it: ISO 8601 in UTC with milliseconds", () => {
    const expectedUpdatedAt = new Date("2026-10-04T12:34:56.789Z").toISOString();
    expect(PublishConfigurationVersionRequestSchema.parse({ expectedUpdatedAt })).toEqual({ expectedUpdatedAt });
    expect(PublishConfigurationVersionRequestSchema.parse({ expectedUpdatedAt: "2026-10-04T12:34:56.000Z" })).toEqual({
      expectedUpdatedAt: "2026-10-04T12:34:56.000Z",
    });
  });

  it("leaves it out for a caller with no tab: an empty body publishes what is saved", () => {
    expect(PublishConfigurationVersionRequestSchema.parse({})).toEqual({});
  });

  it.each([
    ["no milliseconds", "2026-10-04T12:34:56Z"],
    ["microseconds", "2026-10-04T12:34:56.789123Z"],
    ["an offset instead of Z", "2026-10-04T14:34:56.789+02:00"],
    ["a date only", "2026-10-04"],
    ["not a date", "yesterday"],
    ["an empty string", ""],
  ])("refuses %s", (_label, expectedUpdatedAt) => {
    expect(PublishConfigurationVersionRequestSchema.safeParse({ expectedUpdatedAt }).success).toBe(false);
  });

  it("refuses a number, null, an array, and unknown fields", () => {
    for (const expectedUpdatedAt of [Date.parse("2026-10-04T12:34:56.789Z"), null, ["2026-10-04T12:34:56.789Z"]]) {
      expect(PublishConfigurationVersionRequestSchema.safeParse({ expectedUpdatedAt }).success).toBe(false);
    }
    expect(
      PublishConfigurationVersionRequestSchema.safeParse({
        expectedUpdatedAt: "2026-10-04T12:34:56.789Z",
        yamlContent: "receivers: {}\n",
      }).success,
    ).toBe(false);
    expect(PublishConfigurationVersionRequestSchema.safeParse([]).success).toBe(false);
    expect(PublishConfigurationVersionRequestSchema.safeParse(null).success).toBe(false);
  });
});

describe("SaveConfigurationVersionRequestSchema", () => {
  const EMPTY_GRAPH = { nodes: [], edges: [], pipelines: [] };
  const yamlOf = (yamlContent: unknown) =>
    SaveConfigurationVersionRequestSchema.safeParse({ yamlContent, ...EMPTY_GRAPH });

  /** Node's own `String.prototype.isWellFormed()`: the rule the schema follows, undeclared in ES2023's library. */
  const isWellFormed = (text: string) => (text as unknown as { isWellFormed(): boolean }).isWellFormed();

  it("accepts 262,144 characters and refuses 262,145", () => {
    expect(yamlOf("a".repeat(262_144)).success).toBe(true);
    expect(yamlOf("a".repeat(262_145)).success).toBe(false);
  });

  it("accepts ''", () => {
    expect(SaveConfigurationVersionRequestSchema.parse({ yamlContent: "", ...EMPTY_GRAPH })).toEqual({
      yamlContent: "",
      ...EMPTY_GRAPH,
    });
  });

  it("keeps the text exactly: leading and trailing whitespace, CRLF, tabs and a non-BMP character", () => {
    const text = "  \r\nreceivers:\r\n\totlp: {} # 🚀  \n\n";
    expect(SaveConfigurationVersionRequestSchema.parse({ yamlContent: text, ...EMPTY_GRAPH })).toEqual({
      yamlContent: text,
      ...EMPTY_GRAPH,
    });
  });

  it("accepts a collector version, left out meaning the one stored", () => {
    expect(
      SaveConfigurationVersionRequestSchema.parse({ yamlContent: "", ...EMPTY_GRAPH, collectorVersion: "0.161.0" }),
    ).toEqual({ yamlContent: "", ...EMPTY_GRAPH, collectorVersion: "0.161.0" });
    expect(SaveConfigurationVersionRequestSchema.parse({ yamlContent: "", ...EMPTY_GRAPH })).not.toHaveProperty(
      "collectorVersion",
    );
    // In the catalogue's format but not in it: the service's to refuse (collector_version_unknown).
    expect(
      SaveConfigurationVersionRequestSchema.safeParse({ yamlContent: "", ...EMPTY_GRAPH, collectorVersion: "9.9.9" })
        .success,
    ).toBe(true);
  });

  it.each(COLLECTOR_VERSIONS_REFUSED)("refuses a collector version that is %s: not the catalogue's format", (_label, collectorVersion) => {
    expect(
      SaveConfigurationVersionRequestSchema.safeParse({ yamlContent: "", ...EMPTY_GRAPH, collectorVersion }).success,
    ).toBe(false);
  });

  it("refuses an unknown field, a missing yamlContent, null and a number", () => {
    expect(
      SaveConfigurationVersionRequestSchema.safeParse({ yamlContent: "", ...EMPTY_GRAPH, versionNumber: 2 }).success,
    ).toBe(false);
    expect(
      SaveConfigurationVersionRequestSchema.safeParse({ yamlContent: "", ...EMPTY_GRAPH, collectorDistribution: "otelcol-contrib" })
        .success,
    ).toBe(false);
    expect(SaveConfigurationVersionRequestSchema.safeParse(EMPTY_GRAPH).success).toBe(false);
    expect(yamlOf(null).success).toBe(false);
    expect(yamlOf(42).success).toBe(false);
  });

  it("refuses U+0000, which Postgres can't store", () => {
    const result = yamlOf("receivers:\u0000\n");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("The YAML can't contain the character U+0000.");
  });

  it.each([
    ["a lone high surrogate", "a\ud83db"],
    ["a lone low surrogate", "a\ude80b"],
    ["a pair in the wrong order", "\ude80\ud83d"],
    ["a high surrogate at the end", "receivers:\ud83d"],
  ])("refuses %s, which isn't well formed and would be stored as U+FFFD", (_label, text) => {
    expect(isWellFormed(text)).toBe(false);
    const result = yamlOf(text);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("The YAML can't contain a lone surrogate.");
  });

  it("accepts well-formed surrogate pairs, and U+FFFD itself", () => {
    const text = "# 🚀 𝕏 \ufffd";
    expect(isWellFormed(text)).toBe(true);
    expect(yamlOf(text).success).toBe(true);
  });

  it.each([
    ["U+0000", "receivers:\u0000\n", true],
    ["a lone high surrogate", "a\ud83db", true],
    ["a lone low surrogate", "a\ude80b", true],
    ["a pair in the wrong order", "\ude80\ud83d", true],
    ["well-formed pairs and U+FFFD", "# 🚀 𝕏 \ufffd", false],
    ["''", "", false],
  ])("hasUnstorableCharacter answers %s with %s, as the schema refuses or accepts it", (_label, text, unstorable) => {
    expect(hasUnstorableCharacter(text)).toBe(unstorable);
    expect(yamlOf(text).success).toBe(!unstorable);
  });

  it("counts the limit in UTF-16 units, so a non-BMP character counts twice", () => {
    expect(yamlOf("🚀".repeat(131_072)).success).toBe(true);
    expect(yamlOf(`${"🚀".repeat(131_072)}a`).success).toBe(false);
  });
});

describe("ListConfigurationsQuerySchema", () => {
  it("defaults to 50, no cursor, no search, and every configuration the caller can see (filter all)", () => {
    expect(ListConfigurationsQuerySchema.parse({})).toEqual({ limit: 50, filter: "all" });
  });

  it("coerces the query string's values", () => {
    expect(
      ListConfigurationsQuerySchema.parse({ limit: "10", cursor: "abc", q: "  gateway ", filter: "mine" }),
    ).toEqual({
      limit: 10,
      cursor: "abc",
      q: "gateway",
      filter: "mine",
    });
  });

  it.each(CONFIGURATIONS_LIST_FILTERS)("accepts the list's filter=%s", (filter) => {
    expect(ListConfigurationsQuerySchema.parse({ filter }).filter).toBe(filter);
  });

  it("offers exactly all, mine and published", () => {
    expect(CONFIGURATIONS_LIST_FILTERS).toEqual(["all", "mine", "published"]);
  });

  it.each(["", "Mine", "drafts", "true", "everyone"])("refuses filter=%j", (filter) => {
    expect(ListConfigurationsQuerySchema.safeParse({ filter }).success).toBe(false);
  });

  it("refuses a mine parameter, whatever its value", () => {
    expect(ListConfigurationsQuerySchema.safeParse({ mine: "true" }).success).toBe(false);
    expect(ListConfigurationsQuerySchema.safeParse({ mine: "false" }).success).toBe(false);
  });

  it("accepts limits 1 and 100", () => {
    expect(ListConfigurationsQuerySchema.parse({ limit: "1" }).limit).toBe(1);
    expect(ListConfigurationsQuerySchema.parse({ limit: "100" }).limit).toBe(100);
  });

  it.each(["0", "101", "-1", "2.5", "ten", ""])("refuses limit %j", (limit) => {
    expect(ListConfigurationsQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("trims the search, empty meaning none left to the service, and refuses 201 characters", () => {
    expect(ListConfigurationsQuerySchema.parse({ q: "   " }).q).toBe("");
    expect(ListConfigurationsQuerySchema.safeParse({ q: ` ${"a".repeat(200)} ` }).success).toBe(true);
    expect(ListConfigurationsQuerySchema.safeParse({ q: "a".repeat(201) }).success).toBe(false);
  });

  it("refuses a cursor over 256 characters", () => {
    expect(ListConfigurationsQuerySchema.safeParse({ cursor: "a".repeat(256) }).success).toBe(true);
    expect(ListConfigurationsQuerySchema.safeParse({ cursor: "a".repeat(257) }).success).toBe(false);
  });

  it("refuses an unknown parameter and a repeated one", () => {
    expect(ListConfigurationsQuerySchema.safeParse({ unknown: "1" }).success).toBe(false);
    expect(ListConfigurationsQuerySchema.safeParse({ q: ["a", "b"] }).success).toBe(false);
  });
});

describe("CONFIGURATION_ERROR_CODES", () => {
  it("is the configuration endpoints' thirteen codes, in order", () => {
    expect(CONFIGURATION_ERROR_CODES).toEqual([
      "configuration_not_found",
      "configuration_version_not_found",
      "configuration_version_published",
      "configuration_delete_forbidden",
      "publishing_unavailable",
      "configuration_version_changed",
      "configuration_version_empty",
      "collector_version_unknown",
      "collector_distribution_unknown",
      "validation_unavailable",
      "validation_rate_limited",
      "configuration_in_use",
      "configuration_invalid",
    ]);
  });

  it("derives a union type, so a misspelled code does not type-check", () => {
    expectTypeOf<"configuration_not_found">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"configuration_version_not_found">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"configuration_version_published">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"configuration_delete_forbidden">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"publishing_unavailable">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"collector_version_unknown">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"collector_distribution_unknown">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"validation_unavailable">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"validation_rate_limited">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"configuration_in_use">().toMatchTypeOf<ConfigurationErrorCode>();
    expectTypeOf<"config_not_found">().not.toMatchTypeOf<ConfigurationErrorCode>();
  });
});

describe("a version's validation", () => {
  describe("ValidateConfigurationVersionRequestSchema", () => {
    it("takes the text alone, or with a collector version", () => {
      expect(ValidateConfigurationVersionRequestSchema.parse({ yaml: "receivers: {}\n" })).toEqual({
        yaml: "receivers: {}\n",
      });
      expect(
        ValidateConfigurationVersionRequestSchema.parse({ yaml: "receivers: {}\n", collectorVersion: "0.162.0" }),
      ).toEqual({ yaml: "receivers: {}\n", collectorVersion: "0.162.0" });
    });

    it("keeps the text exactly as sent: not trimmed, its line endings as they are", () => {
      const yaml = "  receivers:\r\n    otlp: {}\r\n\n";
      expect(ValidateConfigurationVersionRequestSchema.parse({ yaml }).yaml).toBe(yaml);
    });

    it("takes 262,144 characters and refuses one more", () => {
      const at = "#".repeat(CONFIGURATION_YAML_MAXIMUM_LENGTH);
      expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml: at }).success).toBe(true);
      expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml: `${at}#` }).success).toBe(false);
    });

    it("refuses empty text, which is never checked", () => {
      expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml: "" }).success).toBe(false);
    });

    it("refuses text no version could hold: U+0000 and a lone surrogate", () => {
      expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml: "a\u0000b" }).success).toBe(false);
      expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml: "a\ud800b" }).success).toBe(false);
    });

    it("refuses every C0 control character but tab, line feed and carriage return", () => {
      const message = "The YAML can't contain a control character other than tab, line feed and carriage return.";
      for (let code = 0; code < 0x20; code += 1) {
        const yaml = `a: "${String.fromCharCode(code)}"\n`;
        const result = ValidateConfigurationVersionRequestSchema.safeParse({ yaml });
        const allowed = code === 0x09 || code === 0x0a || code === 0x0d;
        expect(result.success, `U+${code.toString(16).padStart(4, "0")}`).toBe(allowed);
        if (!allowed) expect(result.error?.issues[0]?.message).toBe(message);
        expect(hasYamlControlCharacter(yaml)).toBe(!allowed);
      }
      // DEL and the characters past the C0 block are not C0: left to the validator.
      for (const yaml of ['a: "\u007f"\n', 'a: "\u0085"\n', "a: ' '\n"]) {
        expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml }).success).toBe(true);
      }
    });

    it("leaves the save's own rules as they were: a version may still store a C0 control character", () => {
      const save = { yamlContent: "a: \u0007\n", nodes: [], edges: [], pipelines: [] };
      expect(SaveConfigurationVersionRequestSchema.safeParse(save).success).toBe(true);
    });

    it("refuses a missing text, a collector version that isn't major.minor.patch, and null", () => {
      expect(ValidateConfigurationVersionRequestSchema.safeParse({}).success).toBe(false);
      for (const collectorVersion of ["0.162", "v0.162.0", "latest", "", null, 162]) {
        expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml: "a: 1\n", collectorVersion }).success).toBe(false);
      }
    });

    it("refuses a distribution, or any other field: the distribution is always the configuration's", () => {
      expect(
        ValidateConfigurationVersionRequestSchema.safeParse({ yaml: "a: 1\n", distribution: "otelcol-contrib" }).success,
      ).toBe(false);
      expect(ValidateConfigurationVersionRequestSchema.safeParse({ yaml: "a: 1\n", version: "0.162.0" }).success).toBe(
        false,
      );
    });
  });

  describe("ConfigurationValidationResponseSchema", () => {
    const answer = {
      status: "invalid",
      collectorVersion: "0.162.0",
      errors: [{ message: 'unknown type: "nosuch" for id: "nosuch/2"', componentPath: "exporters::nosuch/2" }],
      requirements: [
        {
          category: "env_var",
          title: "Set environment variable EXPORT_URL",
          description: "This configuration references EXPORT_URL via ${env:EXPORT_URL}.",
          componentPath: null,
        },
      ],
    };

    it("reads each status", () => {
      expect(ConfigurationValidationResponseSchema.parse(answer)).toEqual(answer);
      for (const status of ["valid", "retired"]) {
        expect(
          ConfigurationValidationResponseSchema.safeParse({ ...answer, status, errors: [], requirements: [] }).success,
        ).toBe(true);
      }
      expect(ConfigurationValidationResponseSchema.safeParse({ ...answer, status: "unavailable" }).success).toBe(false);
    });

    it("takes a null component path, and each of the nine categories, and nothing else", () => {
      expect(CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES).toHaveLength(9);
      for (const category of CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES) {
        const requirement = { ...answer.requirements[0]!, category };
        expect(ConfigurationValidationResponseSchema.safeParse({ ...answer, requirements: [requirement] }).success).toBe(
          true,
        );
      }
      const unknown = { ...answer.requirements[0]!, category: "org_variable" };
      expect(ConfigurationValidationResponseSchema.safeParse({ ...answer, requirements: [unknown] }).success).toBe(false);
      const pathless = { message: "failed", componentPath: null };
      expect(ConfigurationValidationResponseSchema.safeParse({ ...answer, errors: [pathless] }).success).toBe(true);
    });

    it("is strict at every level", () => {
      expect(ConfigurationValidationResponseSchema.safeParse({ ...answer, distribution: "otelcol-contrib" }).success).toBe(
        false,
      );
      const error = { ...answer.errors[0]!, raw: "x" };
      expect(ConfigurationValidationResponseSchema.safeParse({ ...answer, errors: [error] }).success).toBe(false);
      const requirement = { ...answer.requirements[0]!, raw: "x" };
      expect(ConfigurationValidationResponseSchema.safeParse({ ...answer, requirements: [requirement] }).success).toBe(
        false,
      );
    });
  });
});

/** A fixture as a test changes it: any field, at the levels the graph's schemas have. */
interface Changeable {
  [field: string]: unknown;
  position: Record<string, unknown>;
  style?: Record<string, unknown>;
  data: Record<string, unknown> & { connectorSignals?: Record<string, unknown> };
}

/*
 * The builder's graph. The fixtures are hand-written in the shapes the
 * builder stores: a pipeline's group, components in it, a connector, an
 * extension on its own, and a group's optional extra fields.
 */
describe("the graph's schemas", () => {
  const GROUP = {
    id: "group_0",
    type: "pipelineGroup",
    position: { x: 50, y: 30 },
    style: { width: 980, height: 240 },
    data: {
      label: "traces/production",
      pipelineId: "pipeline_0",
      signalType: "traces",
      color: "#F97316",
      componentType: "pipelineGroup",
      componentSubType: "pipelineGroup",
      config: {},
    },
  };
  const RECEIVER = {
    id: "node_0",
    type: "receiver",
    parentId: "group_0",
    position: { x: 50, y: 70 },
    data: {
      label: "OTLP (edge)",
      componentType: "receiver",
      componentSubType: "otlp",
      instanceName: "edge",
      config: { protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: null } },
      sharedConfigId: "receiver-otlp/edge",
    },
  };
  const PROCESSOR = {
    id: "node_1",
    type: "processor",
    parentId: "group_0",
    position: { x: 300.5, y: -70.25 },
    data: {
      label: "Batch",
      componentType: "processor",
      componentSubType: "batch",
      config: { timeout: "1s", send_batch_size: 8192, flags: [true, false, 0.5, -1e21] },
      sharedConfigId: "processor-batch",
    },
  };
  const CONNECTOR = {
    id: "node_2",
    type: "connector",
    parentId: "group_0",
    position: { x: 550, y: 70 },
    data: {
      label: "Span Metrics",
      componentType: "connector",
      componentSubType: "spanmetrics",
      config: null,
      connectorSignals: { inputSignal: "traces", outputSignal: "metrics" },
    },
  };
  const EXTENSION = {
    id: "node_999999",
    type: "extension",
    position: { x: -1_000_000, y: 1_000_000 },
    data: { label: "Health Check", componentType: "extension", componentSubType: "health_check", config: {} },
  };
  const NODES = [GROUP, RECEIVER, PROCESSOR, CONNECTOR, EXTENSION];
  const EDGE = { id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep" };
  const EDGES = [EDGE, { id: "edge_1", source: "node_1", target: "node_2", type: "smoothstep" }];
  const PIPELINE = { id: "pipeline_0", name: "traces/production", signalType: "traces", color: "#f97316" };
  const PIPELINES = [PIPELINE, { id: "pipeline_1", name: "metrics", signalType: "metrics", color: "#3b82f6" }];

  const nodeOk = (node: unknown) => GraphNodeSchema.safeParse(node).success;
  const edgeOk = (edge: unknown) => GraphEdgeSchema.safeParse(edge).success;
  const pipelineOk = (pipeline: unknown) => GraphPipelineSchema.safeParse(pipeline).success;
  /** A copy of `value` with `change` applied to it. */
  const changed = <Value>(value: Value, change: (copy: Changeable) => void): unknown => {
    const copy = structuredClone(value) as unknown as Changeable;
    change(copy);
    return copy;
  };

  it("are the graph's bounds and id forms", () => {
    expect([GRAPH_MAXIMUM_NODES, GRAPH_MAXIMUM_EDGES, GRAPH_MAXIMUM_PIPELINES]).toEqual([5_000, 10_000, 1_000]);
    expect(GRAPH_COLUMN_MAXIMUM_BYTES).toBe(1_048_576);
    expect([GRAPH_NODE_ID_PATTERN, GRAPH_GROUP_ID_PATTERN, GRAPH_EDGE_ID_PATTERN, GRAPH_PIPELINE_ID_PATTERN]).toEqual([
      /^node_\d{1,6}$/,
      /^group_\d{1,6}$/,
      /^edge_\d{1,6}$/,
      /^pipeline_\d{1,6}$/,
    ]);
  });

  it("accept the shapes the builder stores, unchanged", () => {
    for (const node of NODES) expect(GraphNodeSchema.parse(node)).toEqual(node);
    for (const edge of EDGES) expect(GraphEdgeSchema.parse(edge)).toEqual(edge);
    for (const pipeline of PIPELINES) expect(GraphPipelineSchema.parse(pipeline)).toEqual(pipeline);
    const request = { yamlContent: "receivers: {}\n", nodes: NODES, edges: EDGES, pipelines: PIPELINES };
    expect(SaveConfigurationVersionRequestSchema.parse(request)).toEqual(request);
  });

  it("accept a group without the extra fields or a size, and a component without the optional ones", () => {
    expect(
      nodeOk(
        changed(GROUP, (group) => {
          delete group.style;
          delete group.data.componentType;
          delete group.data.componentSubType;
          delete group.data.config;
        }),
      ),
    ).toBe(true);
    expect(
      nodeOk({
        id: "node_7",
        type: "exporter",
        position: { x: 0, y: 0 },
        data: { label: "", componentType: "exporter", componentSubType: "", config: null },
      }),
    ).toBe(true);
  });

  describe("ids: a number, never a name", () => {
    it.each([
      ["a derived group id", "group-pipeline-traces"],
      ["a named group", "group-pipeline-traces/production"],
      ["a group id with a name after it", "group_1_traces"],
      ["seven digits", "group_1234567"],
      ["no digits", "group_"],
      ["a node id", "node_0"],
    ])("refuses a group whose id is %s", (_label, id) => {
      expect(nodeOk({ ...GROUP, id })).toBe(false);
    });

    it.each([
      ["a derived id", "receiver-otlp-1"],
      ["a name", "node_otlp"],
      ["a group id", "group_0"],
      ["surrounding space", " node_0"],
      ["a trailing newline", "node_0\n"],
    ])("refuses a component whose id is %s", (_label, id) => {
      expect(nodeOk({ ...RECEIVER, id })).toBe(false);
    });

    it("refuses a component in a group named by a name, and a group naming its pipeline by a name", () => {
      expect(nodeOk({ ...RECEIVER, parentId: "group-pipeline-traces" })).toBe(false);
      expect(nodeOk(changed(GROUP, (group) => (group.data.pipelineId = "traces-default")))).toBe(false);
    });

    it("refuses an edge whose id, source or target carries a name, or names a group", () => {
      expect(edgeOk({ ...EDGE, id: "edge-otlp-batch" })).toBe(false);
      expect(edgeOk({ ...EDGE, source: "receiver-otlp-1" })).toBe(false);
      expect(edgeOk({ ...EDGE, target: "group-pipeline-traces" })).toBe(false);
      expect(edgeOk({ ...EDGE, target: "group_0" })).toBe(false);
    });

    it("refuses a pipeline whose id carries its name", () => {
      expect(pipelineOk({ ...PIPELINE, id: "traces-default" })).toBe(false);
      expect(pipelineOk({ ...PIPELINE, id: "pipeline-traces/production" })).toBe(false);
    });
  });

  describe("strictness", () => {
    it.each(["measured", "selected", "dragging", "width", "height", "positionAbsolute", "resizing", "zIndex"])(
      "refuses a node carrying React Flow's %s",
      (field) => {
        expect(nodeOk({ ...RECEIVER, [field]: field === "measured" ? { width: 1, height: 1 } : true })).toBe(false);
        expect(nodeOk({ ...GROUP, [field]: true })).toBe(false);
      },
    );

    it("refuses an unknown field in a node's data, position, style or connector signals, in an edge and in a pipeline", () => {
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.extra = 1)))).toBe(false);
      expect(nodeOk(changed(GROUP, (node) => (node.data.instanceName = "x")))).toBe(false);
      expect(nodeOk(changed(RECEIVER, (node) => (node.position.z = 1)))).toBe(false);
      expect(nodeOk(changed(GROUP, (node) => (node.style!.zIndex = 1)))).toBe(false);
      expect(nodeOk(changed(CONNECTOR, (node) => (node.data.connectorSignals!.routes = [])))).toBe(false);
      expect(edgeOk({ ...EDGE, data: { pipelineIds: ["pipeline_0"] } })).toBe(false);
      expect(edgeOk({ ...EDGE, sourceHandle: "a" })).toBe(false);
      expect(pipelineOk({ ...PIPELINE, hidden: true })).toBe(false);
    });

    it("refuses a component with a group's fields or a style, and a group with a parent", () => {
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.pipelineId = "pipeline_0")))).toBe(false);
      expect(nodeOk({ ...RECEIVER, style: { width: 10, height: 10 } })).toBe(false);
      expect(nodeOk({ ...GROUP, parentId: "group_1" })).toBe(false);
    });

    it("refuses an unknown node type, a component whose componentType isn't its type, and an edge type other than smoothstep", () => {
      expect(nodeOk({ ...RECEIVER, type: "group" })).toBe(false);
      expect(nodeOk({ ...RECEIVER, type: "exporter" })).toBe(false);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.componentType = "pipelineGroup")))).toBe(false);
      expect(nodeOk(changed(GROUP, (node) => (node.data.componentType = "receiver")))).toBe(false);
      expect(edgeOk({ ...EDGE, type: "default" })).toBe(false);
    });

    it("refuses a missing field: a label, a component's config, a group's colour, an edge's target, a pipeline's name", () => {
      expect(nodeOk(changed(RECEIVER, (node) => delete node.data.label))).toBe(false);
      expect(nodeOk(changed(RECEIVER, (node) => delete node.data.config))).toBe(false);
      expect(nodeOk(changed(GROUP, (node) => delete node.data.color))).toBe(false);
      expect(edgeOk({ id: "edge_0", source: "node_0", type: "smoothstep" })).toBe(false);
      expect(pipelineOk({ id: "pipeline_0", signalType: "traces", color: "#f97316" })).toBe(false);
    });
  });

  describe("numbers", () => {
    it.each([
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["NaN", Number.NaN],
      ["beyond ±1,000,000", 1_000_000.5],
      ["a string", "10"],
    ])("refuse a position of %s", (_label, value) => {
      expect(nodeOk({ ...RECEIVER, position: { x: value, y: 0 } })).toBe(false);
      expect(nodeOk({ ...RECEIVER, position: { x: 0, y: value } })).toBe(false);
    });

    it("refuse a group's size that is negative, over 100,000 or not finite, and accept 0 and 100,000", () => {
      expect(nodeOk({ ...GROUP, style: { width: 0, height: 100_000 } })).toBe(true);
      for (const value of [-1, 100_001, Number.POSITIVE_INFINITY, Number.NaN]) {
        expect(nodeOk({ ...GROUP, style: { width: value, height: 10 } })).toBe(false);
        expect(nodeOk({ ...GROUP, style: { width: 10, height: value } })).toBe(false);
      }
    });

    it("refuse a non-finite number anywhere in a config: JSON has none, and 1e400 parses to Infinity", () => {
      expect(JSON.parse("1e400")).toBe(Number.POSITIVE_INFINITY);
      expect(
        nodeOk(
          changed(RECEIVER, (node) => (node.data.config = { protocols: { grpc: { port: JSON.parse("1e400") } } })),
        ),
      ).toBe(false);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = [[Number.NaN]])))).toBe(false);
    });
  });

  describe("colours and signals", () => {
    it.each(["#f9731", "#f973166", "f97316", "#g97316", "orange", "", "rgb(0,0,0)"])(
      "refuse the colour %j on a group and on a pipeline",
      (color) => {
        expect(nodeOk(changed(GROUP, (node) => (node.data.color = color)))).toBe(false);
        expect(pipelineOk({ ...PIPELINE, color })).toBe(false);
      },
    );

    it("refuse a signal other than traces, metrics or logs", () => {
      expect(nodeOk(changed(GROUP, (node) => (node.data.signalType = "profiles")))).toBe(false);
      expect(pipelineOk({ ...PIPELINE, signalType: "Traces" })).toBe(false);
      expect(nodeOk(changed(CONNECTOR, (node) => (node.data.connectorSignals!.outputSignal = "spans")))).toBe(false);
    });
  });

  describe("text lengths, which the writer guarantees", () => {
    it.each([
      ["label", GRAPH_LABEL_MAXIMUM_LENGTH, 320],
      ["componentSubType", GRAPH_COMPONENT_SUBTYPE_MAXIMUM_LENGTH, 100],
      ["instanceName", GRAPH_INSTANCE_NAME_MAXIMUM_LENGTH, 200],
      ["sharedConfigId", GRAPH_SHARED_CONFIG_ID_MAXIMUM_LENGTH, 320],
    ])("accept a component's %s at %s and refuse one more", (field, maximum, expected) => {
      expect(maximum).toBe(expected);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data[field] = "a".repeat(maximum))))).toBe(true);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data[field] = "a".repeat(maximum + 1))))).toBe(false);
    });

    it("fit the longest label and sharedConfigId derived from a type and an instance name within bounds", () => {
      const type = "t".repeat(GRAPH_COMPONENT_SUBTYPE_MAXIMUM_LENGTH);
      const instance = "i".repeat(GRAPH_INSTANCE_NAME_MAXIMUM_LENGTH);
      const node = changed(RECEIVER, (copy) => {
        copy.data.componentSubType = type;
        copy.data.instanceName = instance;
        copy.data.label = `${type.toUpperCase()} (${instance})`;
        copy.data.sharedConfigId = `connector-${type}/${instance}`;
      });
      expect(nodeOk(node)).toBe(true);
    });

    it("accept a pipeline's name as a lowercase word or the text's type[/name], at most 256", () => {
      for (const name of ["traces", "metrics/2", "logs/prod-eu.west_1", "traces/𝕏-🚀", "profiles/x"]) {
        expect(pipelineOk({ ...PIPELINE, name })).toBe(true);
      }
      expect(GRAPH_PIPELINE_NAME_MAXIMUM_LENGTH).toBe(256);
      expect(pipelineOk({ ...PIPELINE, name: `${"a".repeat(55)}/${"n".repeat(200)}` })).toBe(true);
      expect(pipelineOk({ ...PIPELINE, name: `${"a".repeat(56)}/${"n".repeat(200)}` })).toBe(false);
      expect(pipelineOk({ ...PIPELINE, name: `traces/${"n".repeat(201)}` })).toBe(false);
    });

    it.each(["", "Traces", "traces/", "traces/a b", "traces/a\nb", "/name", "traces name", "1traces"])(
      "refuse the pipeline name %j",
      (name) => {
        expect(pipelineOk({ ...PIPELINE, name })).toBe(false);
      },
    );
  });

  describe("characters Postgres can't store", () => {
    const deepConfig = (leaf: unknown, key = "key") => ({
      exporters: [{ headers: { [key]: { values: [1, { deeper: leaf }] } } }],
    });

    it.each([
      ["U+0000", "a\u0000b"],
      ["a lone high surrogate", "a\ud83db"],
      ["a lone low surrogate", "\ude80"],
    ])("are refused as %s in a nested config string, a nested config key, and every text field", (_label, bad) => {
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = deepConfig(bad))))).toBe(false);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = deepConfig("ok", bad))))).toBe(false);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = { [bad]: 1 })))).toBe(false);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = bad)))).toBe(false);
      for (const field of ["label", "componentSubType", "instanceName", "sharedConfigId"]) {
        expect(nodeOk(changed(RECEIVER, (node) => (node.data[field] = bad)))).toBe(false);
      }
      expect(nodeOk(changed(GROUP, (node) => (node.data.label = bad)))).toBe(false);
      expect(nodeOk(changed(GROUP, (node) => (node.data.config = deepConfig(bad))))).toBe(false);
      expect(pipelineOk({ ...PIPELINE, name: `traces/${bad}` })).toBe(false);
    });

    it("accept well-formed surrogate pairs and U+FFFD, in a config's strings and keys and in a label", () => {
      const text = "🚀 𝕏 �";
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = deepConfig(text, text))))).toBe(true);
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.label = text)))).toBe(true);
    });
  });

  describe("a config", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = "leaf";
      for (let level = 0; level < depth; level += 1) value = level % 2 === 0 ? [value] : { next: value };
      return value;
    };

    it(`is any JSON value, nested at most ${GRAPH_CONFIG_MAXIMUM_DEPTH} deep`, () => {
      expect(GRAPH_CONFIG_MAXIMUM_DEPTH).toBe(64);
      for (const config of [null, true, 0, "text", [], {}, nested(GRAPH_CONFIG_MAXIMUM_DEPTH)]) {
        expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = config)))).toBe(true);
      }
      expect(nodeOk(changed(RECEIVER, (node) => (node.data.config = nested(GRAPH_CONFIG_MAXIMUM_DEPTH + 1))))).toBe(
        false,
      );
    });

    it("refuses a nesting far past any stack without throwing", () => {
      const deep = JSON.parse(`${"[".repeat(200_000)}${"]".repeat(200_000)}`);
      expect(() => GraphNodeSchema.safeParse(changed(RECEIVER, (node) => (node.data.config = deep)))).not.toThrow();
      const request = {
        yamlContent: "",
        nodes: [{ ...RECEIVER, data: { ...RECEIVER.data, config: deep } }],
        edges: [],
        pipelines: [],
      };
      expect(SaveConfigurationVersionRequestSchema.safeParse(request).success).toBe(false);
    });

    it("isStorableJsonValue refuses what JSON can't carry: undefined, a function, a class instance", () => {
      expect(isStorableJsonValue({ a: [1, "b", null, { c: false }] })).toBe(true);
      expect(isStorableJsonValue(undefined)).toBe(false);
      expect(isStorableJsonValue({ a: () => 1 })).toBe(false);
      expect(isStorableJsonValue({ at: new Date() })).toBe(false);
      expect(isStorableJsonValue(Object.create(null) as unknown)).toBe(true);
    });
  });

  describe("the columns' bounds", () => {
    const component = (index: number) => ({ ...EXTENSION, id: `node_${index}` });
    const edge = (index: number) => ({ ...EDGE, id: `edge_${index}` });
    const pipeline = (index: number) => ({ ...PIPELINE, id: `pipeline_${index}` });

    it("accept 5,000 nodes, 10,000 edges and 1,000 pipelines, and refuse one more of each", () => {
      const nodes = Array.from({ length: GRAPH_MAXIMUM_NODES }, (_, index) => component(index));
      const edges = Array.from({ length: GRAPH_MAXIMUM_EDGES }, (_, index) => edge(index));
      const pipelines = Array.from({ length: GRAPH_MAXIMUM_PIPELINES }, (_, index) => pipeline(index));
      expect(GraphNodesSchema.safeParse(nodes).success).toBe(true);
      expect(GraphEdgesSchema.safeParse(edges).success).toBe(true);
      expect(GraphPipelinesSchema.safeParse(pipelines).success).toBe(true);
      expect(GraphNodesSchema.safeParse([...nodes, component(5_000)]).success).toBe(false);
      expect(GraphEdgesSchema.safeParse([...edges, edge(10_000)]).success).toBe(false);
      expect(GraphPipelinesSchema.safeParse([...pipelines, pipeline(1_000)]).success).toBe(false);
    });

    /** One node whose config is `padding` repeated to make the column exactly `bytes` long in UTF-8. */
    const columnOf = (bytes: number, unit: string) => {
      const empty = graphColumnByteLength([changed(RECEIVER, (node) => (node.data.config = ""))]);
      const unitBytes = utf8ByteLength(unit);
      const count = Math.floor((bytes - empty) / unitBytes);
      const rest = "a".repeat(bytes - empty - count * unitBytes);
      return [changed(RECEIVER, (node) => (node.data.config = `${unit.repeat(count)}${rest}`))];
    };

    it("accept a column of exactly 1 MiB of JSON in UTF-8 bytes, and refuse one byte more", () => {
      const atBound = columnOf(GRAPH_COLUMN_MAXIMUM_BYTES, "a");
      expect(graphColumnByteLength(atBound)).toBe(1_048_576);
      expect(GraphNodesSchema.safeParse(atBound).success).toBe(true);
      const over = columnOf(GRAPH_COLUMN_MAXIMUM_BYTES + 1, "a");
      expect(graphColumnByteLength(over)).toBe(1_048_577);
      const result = GraphNodesSchema.safeParse(over);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("The column's JSON is over 1048576 bytes.");
    });

    it("count UTF-8 bytes, not UTF-16 units: CJK text under 1 MiB in units but over it in bytes is refused", () => {
      const cjk = columnOf(GRAPH_COLUMN_MAXIMUM_BYTES + 3, "中");
      expect(JSON.stringify(cjk).length).toBeLessThan(GRAPH_COLUMN_MAXIMUM_BYTES / 2);
      expect(GraphNodesSchema.safeParse(cjk).success).toBe(false);
      expect(GraphNodesSchema.safeParse(columnOf(GRAPH_COLUMN_MAXIMUM_BYTES, "中")).success).toBe(true);
    });

    it("count what JSON escapes as it prints it: U+0001 is six bytes", () => {
      const escaped = columnOf(GRAPH_COLUMN_MAXIMUM_BYTES + 6, "\u0001");
      expect(GraphNodesSchema.safeParse(escaped).success).toBe(false);
    });

    it("bound each of the three columns, and the save's request refuses any of them over it", () => {
      const longPipelines = Array.from({ length: GRAPH_MAXIMUM_PIPELINES }, (_, index) => ({
        ...pipeline(index),
        name: `traces/${"\u0001".repeat(200)}`,
      }));
      expect(graphColumnByteLength(longPipelines)).toBeGreaterThan(GRAPH_COLUMN_MAXIMUM_BYTES);
      expect(GraphPipelinesSchema.safeParse(longPipelines).success).toBe(false);
      const request = { yamlContent: "", nodes: [], edges: [], pipelines: longPipelines };
      expect(SaveConfigurationVersionRequestSchema.safeParse(request).success).toBe(false);
    });

    it("utf8ByteLength counts 1, 2, 3 and 4 bytes, and a lone surrogate as U+FFFD's 3", () => {
      expect(utf8ByteLength("a")).toBe(1);
      expect(utf8ByteLength("é")).toBe(2);
      expect(utf8ByteLength("中")).toBe(3);
      expect(utf8ByteLength("🚀")).toBe(4);
      expect(utf8ByteLength("\ud83d")).toBe(3);
      expect(utf8ByteLength("\ud83da")).toBe(4);
      const sample = "a é 中 🚀 \u0001";
      expect(utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).length);
    });
  });

  describe("the save's request", () => {
    const request = { yamlContent: "", nodes: NODES, edges: EDGES, pipelines: PIPELINES };

    it.each(["nodes", "edges", "pipelines", "yamlContent"] as const)("requires %s", (field) => {
      const { [field]: _dropped, ...without } = request;
      expect(SaveConfigurationVersionRequestSchema.safeParse(without).success).toBe(false);
    });

    it("refuses a column that isn't an array", () => {
      for (const field of ["nodes", "edges", "pipelines"] as const) {
        expect(SaveConfigurationVersionRequestSchema.safeParse({ ...request, [field]: {} }).success).toBe(false);
        expect(SaveConfigurationVersionRequestSchema.safeParse({ ...request, [field]: null }).success).toBe(false);
      }
    });

    it("never echoes a label, a name, a config or a value it refuses: its issues name rules only", () => {
      const marker = "Private-marker-7c1f";
      const refused = [
        { ...request, nodes: [changed(RECEIVER, (node) => (node.data.label = `${marker}\u0000`))] },
        { ...request, nodes: [changed(RECEIVER, (node) => (node.data.label = marker.repeat(40)))] },
        { ...request, nodes: [changed(RECEIVER, (node) => (node.type = marker))] },
        { ...request, nodes: [changed(RECEIVER, (node) => (node.data.componentType = marker))] },
        { ...request, nodes: [changed(RECEIVER, (node) => (node.id = `node-${marker}`))] },
        { ...request, nodes: [changed(RECEIVER, (node) => (node.data.config = { [`${marker}\u0000`]: marker }))] },
        {
          ...request,
          nodes: [changed(RECEIVER, (node) => (node.data.config = { a: { [marker]: `\ud800${marker}` } }))],
        },
        { ...request, nodes: [changed(GROUP, (node) => (node.data.signalType = marker))] },
        { ...request, nodes: [changed(GROUP, (node) => (node.data.color = marker))] },
        { ...request, nodes: [changed(GROUP, (node) => (node.data.componentType = marker))] },
        { ...request, edges: [{ ...EDGE, type: marker }] },
        { ...request, pipelines: [{ ...PIPELINE, name: `traces/${marker} x` }] },
        { ...request, pipelines: [{ ...PIPELINE, signalType: marker }] },
        { ...request, nodes: columnOfMarker(marker) },
      ];
      for (const body of refused) {
        const result = SaveConfigurationVersionRequestSchema.safeParse(body);
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).not.toContain(marker);
      }

      function columnOfMarker(text: string) {
        return [changed(RECEIVER, (node) => (node.data.config = text.repeat(60_000)))];
      }
    });
  });
});
