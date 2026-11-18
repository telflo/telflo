import { describe, expect, it } from "vitest";
import { CONFIGURATION_YAML_MAXIMUM_LENGTH } from "./configurations.js";
import {
  CreateFlowRequestSchema,
  FLOW_AUTHOR_NAME_MAXIMUM_LENGTH,
  FLOW_DESCRIPTION_MAXIMUM_LENGTH,
  FLOW_ERROR_CODES,
  FLOW_LINT_CODES,
  FLOW_LINT_SEVERITIES,
  FLOW_MAXIMUM_TAGS,
  FLOW_NAME_MAXIMUM_LENGTH,
  FLOW_SIGNALS,
  FLOW_SLUG_MAXIMUM_LENGTH,
  FLOW_SOURCE_URL_MAXIMUM_LENGTH,
  FLOW_SOURCES,
  FLOW_SUMMARY_MAXIMUM_LENGTH,
  FLOW_TAG_MAXIMUM_LENGTH,
  FLOW_YAML_MAXIMUM_LENGTH,
  FlowCardSchema,
  FlowLintFindingSchema,
  FlowLintRequestSchema,
  FlowLintResponseSchema,
  FlowResponseSchema,
  FlowSchema,
  FlowShowcaseResponseSchema,
  FlowSlugSchema,
  FlowsResponseSchema,
  PublishedFlowResponseSchema,
  PublishedFlowSchema,
  PublishedFlowsResponseSchema,
  UpdateFlowRequestSchema,
} from "./flows.js";
import * as contracts from "./index.js";

/** The admin dialog's fields for a valid flow, as it sends them. */
const input = {
  slug: "log-volume-cost-control",
  name: "Log Volume Cost Control",
  summary: "Drops DEBUG and TRACE records.",
  description: "Long text.\n\nA second paragraph.",
  signals: ["logs"],
  tags: ["cost", "logs"],
  yaml: "receivers:\n  otlp:\n",
  collectorDistribution: "otelcol-contrib",
  collectorVersion: "0.162.0",
  sourceUrl: null,
  authorName: null,
  sortOrder: 10,
};

const flow = {
  id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  ...input,
  source: "telflo",
  authorUrl: null,
  published: true,
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T12:30:00.000Z",
};

const card = {
  slug: flow.slug,
  name: flow.name,
  summary: flow.summary,
  signals: flow.signals,
  tags: flow.tags,
  authorName: flow.authorName,
  updatedAt: flow.updatedAt,
};

/** Whether the create accepts `input` with `field` set to `value`. */
const createAccepts = (field: string, value: unknown) =>
  CreateFlowRequestSchema.safeParse({ ...input, [field]: value }).success;

describe("the flows' constants (D12 decisions 2 and 11)", () => {
  it("has the signals and sources, and the admin dialog's limits", () => {
    expect(FLOW_SIGNALS).toEqual(["traces", "metrics", "logs"]);
    expect(FLOW_SOURCES).toEqual(["telflo", "community"]);
    expect({
      name: FLOW_NAME_MAXIMUM_LENGTH,
      slug: FLOW_SLUG_MAXIMUM_LENGTH,
      summary: FLOW_SUMMARY_MAXIMUM_LENGTH,
      author: FLOW_AUTHOR_NAME_MAXIMUM_LENGTH,
    }).toEqual({ name: 120, slug: 80, summary: 300, author: 80 });
    expect(FLOW_YAML_MAXIMUM_LENGTH).toBe(CONFIGURATION_YAML_MAXIMUM_LENGTH);
    expect(FLOW_DESCRIPTION_MAXIMUM_LENGTH).toBe(262_144);
  });

  it("names the flows' own error codes; the rest are shared", () => {
    expect(FLOW_ERROR_CODES).toEqual(["flow_not_found", "flow_slug_taken"]);
    expect(contracts.IDENTITY_ERROR_CODES).toContain("product_admin_required");
    expect(contracts.CONFIGURATION_ERROR_CODES).toEqual(
      expect.arrayContaining(["collector_distribution_unknown", "collector_version_unknown"]),
    );
  });

  it("are exported from the package's index", () => {
    expect(contracts.CreateFlowRequestSchema).toBe(CreateFlowRequestSchema);
    expect(contracts.UpdateFlowRequestSchema).toBe(UpdateFlowRequestSchema);
    expect(contracts.FlowSchema).toBe(FlowSchema);
    expect(contracts.FlowCardSchema).toBe(FlowCardSchema);
    expect(contracts.FlowShowcaseResponseSchema).toBe(FlowShowcaseResponseSchema);
    expect(contracts.FlowsResponseSchema).toBe(FlowsResponseSchema);
    expect(contracts.FlowResponseSchema).toBe(FlowResponseSchema);
    expect(contracts.PublishedFlowSchema).toBe(PublishedFlowSchema);
    expect(contracts.PublishedFlowsResponseSchema).toBe(PublishedFlowsResponseSchema);
    expect(contracts.PublishedFlowResponseSchema).toBe(PublishedFlowResponseSchema);
    expect(contracts.FlowSlugSchema).toBe(FlowSlugSchema);
    expect(contracts.FLOW_ERROR_CODES).toBe(FLOW_ERROR_CODES);
    expect(contracts.FlowLintRequestSchema).toBe(FlowLintRequestSchema);
    expect(contracts.FlowLintResponseSchema).toBe(FlowLintResponseSchema);
    expect(contracts.FlowLintFindingSchema).toBe(FlowLintFindingSchema);
    expect(contracts.FLOW_LINT_CODES).toBe(FLOW_LINT_CODES);
    expect(contracts.FLOW_LINT_SEVERITIES).toBe(FLOW_LINT_SEVERITIES);
  });
});

describe("CreateFlowRequestSchema (D12 decision 11)", () => {
  it("accepts the admin dialog's fields, published by default", () => {
    expect(CreateFlowRequestSchema.parse(input)).toEqual({ ...input, published: true });
    expect(CreateFlowRequestSchema.parse({ ...input, published: false }).published).toBe(false);
  });

  it("requires every field but published", () => {
    for (const field of Object.keys(input)) {
      const { [field as keyof typeof input]: _left, ...rest } = input;
      expect({ field, accepted: CreateFlowRequestSchema.safeParse(rest).success }).toEqual({ field, accepted: false });
    }
  });

  it("refuses a source, an author link, an id and any unknown field (strict): every create is telflo's", () => {
    for (const [field, value] of Object.entries({
      source: "community",
      authorUrl: "https://example.com",
      id: flow.id,
      yamlContent: "x",
      collector_version: "0.162.0",
    })) {
      expect({ field, accepted: createAccepts(field, value) }).toEqual({ field, accepted: false });
    }
  });

  it("takes a kebab-case slug of 1 to 80 characters, exactly as sent", () => {
    expect(createAccepts("slug", "a")).toBe(true);
    expect(createAccepts("slug", "a1-b2-c3")).toBe(true);
    expect(createAccepts("slug", "a".repeat(80))).toBe(true);
    for (const slug of ["", "a".repeat(81), "Upper", "a--b", "-a", "a-", "a_b", "a b", " a", "a/b", "é"]) {
      expect({ slug, accepted: createAccepts("slug", slug) }).toEqual({ slug, accepted: false });
    }
  });

  it("trims the name to 1 to 120 characters, the summary to 1 to 300, the description to at most 262,144", () => {
    expect(CreateFlowRequestSchema.parse({ ...input, name: "  Name  " }).name).toBe("Name");
    expect(createAccepts("name", "n".repeat(120))).toBe(true);
    expect(createAccepts("name", "n".repeat(121))).toBe(false);
    expect(createAccepts("name", "   ")).toBe(false);
    expect(CreateFlowRequestSchema.parse({ ...input, summary: " S " }).summary).toBe("S");
    expect(createAccepts("summary", "s".repeat(300))).toBe(true);
    expect(createAccepts("summary", "s".repeat(301))).toBe(false);
    expect(createAccepts("summary", "")).toBe(false);
    expect(CreateFlowRequestSchema.parse({ ...input, description: "  " }).description).toBe("");
    expect(createAccepts("description", "d".repeat(FLOW_DESCRIPTION_MAXIMUM_LENGTH))).toBe(true);
    expect(createAccepts("description", "d".repeat(FLOW_DESCRIPTION_MAXIMUM_LENGTH + 1))).toBe(false);
  });

  it("keeps the YAML exactly as sent, up to the configuration's 262,144 characters, and refuses a blank one", () => {
    const yaml = "\n  receivers: {}\r\n\t";
    expect(CreateFlowRequestSchema.parse({ ...input, yaml }).yaml).toBe(yaml);
    expect(createAccepts("yaml", "y".repeat(CONFIGURATION_YAML_MAXIMUM_LENGTH))).toBe(true);
    expect(createAccepts("yaml", "y".repeat(CONFIGURATION_YAML_MAXIMUM_LENGTH + 1))).toBe(false);
    expect(createAccepts("yaml", "")).toBe(false);
    expect(createAccepts("yaml", " \n\t ")).toBe(false);
  });

  it("refuses text Postgres can't store exactly in every text field: U+0000 and a lone surrogate", () => {
    for (const bad of ["a\u0000b", "a\ud800b", "\udc00"]) {
      for (const field of ["name", "summary", "description", "yaml", "authorName"]) {
        expect({ field, bad, accepted: createAccepts(field, `x${bad}`) }).toEqual({ field, bad, accepted: false });
      }
      expect(createAccepts("tags", [`x${bad}`])).toBe(false);
      expect(createAccepts("sourceUrl", `https://example.com/${bad}`)).toBe(false);
    }
    expect(createAccepts("name", "emoji 😀 pair")).toBe(true);
  });

  it("takes each signal of traces, metrics and logs at most once, or none", () => {
    expect(createAccepts("signals", ["traces", "metrics", "logs"])).toBe(true);
    expect(createAccepts("signals", [])).toBe(true);
    expect(createAccepts("signals", ["logs", "logs"])).toBe(false);
    expect(createAccepts("signals", ["profiles"])).toBe(false);
    expect(createAccepts("signals", ["Logs"])).toBe(false);
  });

  it("trims each tag, refuses an empty one, and bounds them at 32 of 64 characters", () => {
    expect(CreateFlowRequestSchema.parse({ ...input, tags: [" cost ", "logs"] }).tags).toEqual(["cost", "logs"]);
    expect(createAccepts("tags", [])).toBe(true);
    expect(createAccepts("tags", [" "])).toBe(false);
    expect(createAccepts("tags", ["t".repeat(FLOW_TAG_MAXIMUM_LENGTH)])).toBe(true);
    expect(createAccepts("tags", ["t".repeat(FLOW_TAG_MAXIMUM_LENGTH + 1)])).toBe(false);
    expect(createAccepts("tags", Array.from({ length: FLOW_MAXIMUM_TAGS }, (_, index) => `t${index}`))).toBe(true);
    expect(createAccepts("tags", Array.from({ length: FLOW_MAXIMUM_TAGS + 1 }, (_, index) => `t${index}`))).toBe(false);
  });

  it("takes a source link that starts with http:// or https:// (case as the table's check), or none", () => {
    const parsed = (sourceUrl: unknown) => CreateFlowRequestSchema.parse({ ...input, sourceUrl }).sourceUrl;
    expect(parsed("https://github.com/org/repo")).toBe("https://github.com/org/repo");
    expect(parsed("  http://example.com  ")).toBe("http://example.com");
    expect(parsed("")).toBeNull();
    expect(parsed("   ")).toBeNull();
    expect(parsed(null)).toBeNull();
    for (const sourceUrl of ["javascript:alert(1)", "data:text/html,x", "ftp://x", "//example.com", "HTTPS://x", "example.com"]) {
      const result = CreateFlowRequestSchema.safeParse({ ...input, sourceUrl });
      expect({ sourceUrl, accepted: result.success }).toEqual({ sourceUrl, accepted: false });
    }
    expect(CreateFlowRequestSchema.safeParse({ ...input, sourceUrl: "ftp://x" }).error?.issues[0]?.message).toBe(
      "Source URL must start with http:// or https://",
    );
    expect(createAccepts("sourceUrl", `https://${"a".repeat(FLOW_SOURCE_URL_MAXIMUM_LENGTH - 8)}`)).toBe(true);
    expect(createAccepts("sourceUrl", `https://${"a".repeat(FLOW_SOURCE_URL_MAXIMUM_LENGTH - 7)}`)).toBe(false);
  });

  it("trims the author to at most 80 characters, '' or null for none", () => {
    const parsed = (authorName: unknown) => CreateFlowRequestSchema.parse({ ...input, authorName }).authorName;
    expect(parsed(" ClickStack ")).toBe("ClickStack");
    expect(parsed("")).toBeNull();
    expect(parsed(null)).toBeNull();
    expect(createAccepts("authorName", "a".repeat(80))).toBe(true);
    expect(createAccepts("authorName", "a".repeat(81))).toBe(false);
  });

  it("takes a sort order of any int4, and nothing else", () => {
    for (const sortOrder of [0, -5, 145, 2_147_483_647, -2_147_483_648]) {
      expect(createAccepts("sortOrder", sortOrder)).toBe(true);
    }
    for (const sortOrder of [1.5, 2_147_483_648, -2_147_483_649, "10", null]) {
      expect({ sortOrder, accepted: createAccepts("sortOrder", sortOrder) }).toEqual({ sortOrder, accepted: false });
    }
  });

  it("checks the pin's formats only: the catalogue decides whether it is offered", () => {
    expect(createAccepts("collectorDistribution", "clickstack")).toBe(true);
    expect(createAccepts("collectorVersion", "0.147.0")).toBe(true);
    expect(createAccepts("collectorDistribution", "Contrib")).toBe(false);
    expect(createAccepts("collectorVersion", "v0.162.0")).toBe(false);
    expect(createAccepts("collectorVersion", "")).toBe(false);
  });
});

describe("UpdateFlowRequestSchema (D12 decision 11)", () => {
  it("takes any of the dialog's fields and published, none at all included", () => {
    expect(UpdateFlowRequestSchema.parse({})).toEqual({});
    expect(UpdateFlowRequestSchema.parse({ published: false })).toEqual({ published: false });
    expect(UpdateFlowRequestSchema.parse({ ...input, published: true })).toEqual({ ...input, published: true });
    expect(UpdateFlowRequestSchema.parse({ sourceUrl: "", authorName: "" })).toEqual({ sourceUrl: null, authorName: null });
  });

  it("checks each field as the create does", () => {
    for (const [field, value] of Object.entries({
      slug: "Not-Kebab",
      name: "",
      summary: "s".repeat(301),
      yaml: "  ",
      signals: ["logs", "logs"],
      tags: [""],
      sourceUrl: "javascript:x",
      authorName: "a".repeat(81),
      sortOrder: 0.5,
      collectorVersion: "latest",
      published: "yes",
    })) {
      expect({ field, accepted: UpdateFlowRequestSchema.safeParse({ [field]: value }).success }).toEqual({
        field,
        accepted: false,
      });
    }
  });

  it("refuses the source, the author link, the timestamps and any unknown field (strict)", () => {
    for (const field of ["source", "authorUrl", "id", "createdAt", "updatedAt", "unknown"]) {
      expect({ field, accepted: UpdateFlowRequestSchema.safeParse({ [field]: "x" }).success }).toEqual({
        field,
        accepted: false,
      });
    }
  });
});

describe("the flows' responses", () => {
  it("FlowSchema is a flow in camelCase, strict", () => {
    expect(FlowSchema.parse(flow)).toEqual(flow);
    expect(FlowSchema.safeParse({ ...flow, authorName: "ClickStack", sourceUrl: "https://x" }).success).toBe(true);
    expect(FlowSchema.safeParse({ ...flow, yaml_content: "x" }).success).toBe(false);
    expect(FlowSchema.safeParse({ ...flow, source: "other" }).success).toBe(false);
    const { yaml: _yaml, ...withoutYaml } = flow;
    expect(FlowSchema.safeParse(withoutYaml).success).toBe(false);
  });

  it("FlowCardSchema is the card's fields and updatedAt, and refuses the YAML or anything else", () => {
    expect(FlowCardSchema.parse(card)).toEqual(card);
    expect(FlowCardSchema.safeParse({ ...card, yaml: flow.yaml }).success).toBe(false);
    expect(FlowCardSchema.safeParse({ ...card, published: true }).success).toBe(false);
    expect(FlowCardSchema.safeParse({ ...card, id: flow.id }).success).toBe(false);
  });

  it("the showcase, the list and the one-flow answers wrap them", () => {
    expect(FlowShowcaseResponseSchema.parse({ flows: [card] })).toEqual({ flows: [card] });
    expect(FlowShowcaseResponseSchema.safeParse({ flows: [flow] }).success).toBe(false);
    expect(FlowsResponseSchema.parse({ flows: [flow] })).toEqual({ flows: [flow] });
    expect(FlowsResponseSchema.safeParse({ flows: [] }).success).toBe(true);
    expect(FlowResponseSchema.parse({ flow })).toEqual({ flow });
    expect(FlowResponseSchema.safeParse({ flow, extra: 1 }).success).toBe(false);
  });

  it("PublishedFlowSchema is a flow without its id, published, sortOrder and createdAt, YAML included, strict (D31-1 decision 34)", () => {
    const { id: _id, published: _published, sortOrder: _sortOrder, createdAt: _createdAt, ...published } = flow;
    expect(PublishedFlowSchema.parse(published)).toEqual(published);
    expect(Object.keys(PublishedFlowSchema.shape).sort()).toEqual(
      [
        "authorName",
        "authorUrl",
        "collectorDistribution",
        "collectorVersion",
        "description",
        "name",
        "signals",
        "slug",
        "source",
        "sourceUrl",
        "summary",
        "tags",
        "updatedAt",
        "yaml",
      ].sort(),
    );
    for (const field of ["id", "published", "sortOrder", "createdAt"] as const) {
      expect([field, PublishedFlowSchema.safeParse({ ...published, [field]: flow[field] }).success]).toEqual([field, false]);
    }
    const { yaml: _yaml, ...withoutYaml } = published;
    expect(PublishedFlowSchema.safeParse(withoutYaml).success).toBe(false);
  });

  it("the open list and the one-flow answers wrap it, and refuse a flow in full", () => {
    const { id: _id, published: _published, sortOrder: _sortOrder, createdAt: _createdAt, ...published } = flow;
    expect(PublishedFlowsResponseSchema.parse({ flows: [published] })).toEqual({ flows: [published] });
    expect(PublishedFlowsResponseSchema.safeParse({ flows: [] }).success).toBe(true);
    expect(PublishedFlowsResponseSchema.safeParse({ flows: [flow] }).success).toBe(false);
    expect(PublishedFlowResponseSchema.parse({ flow: published })).toEqual({ flow: published });
    expect(PublishedFlowResponseSchema.safeParse({ flow }).success).toBe(false);
    expect(PublishedFlowResponseSchema.safeParse({ flow: published, extra: 1 }).success).toBe(false);
  });
});

describe("the lint's request and answer (D12 decision 6, Preflight ruling 3)", () => {
  const finding = {
    severity: "block",
    code: "literal-endpoint",
    message: "'endpoint' is the hardcoded destination 'https://collector.example'.",
    path: "exporters.otlp.endpoint",
  };
  const answer = {
    blocked: true,
    findings: [finding],
    destinations: ["exporters.otlp.endpoint → https://collector.example"],
  };

  it("takes any YAML up to a flow's 262,144 characters, blank and unstorable text included, exactly as sent", () => {
    for (const yaml of ["receivers: {}\n", "", "   ", "a: \u0000", "a: \ud800", "x".repeat(FLOW_YAML_MAXIMUM_LENGTH)]) {
      expect(FlowLintRequestSchema.parse({ yaml })).toEqual({ yaml });
    }
    expect(FlowLintRequestSchema.safeParse({ yaml: "x".repeat(FLOW_YAML_MAXIMUM_LENGTH + 1) }).success).toBe(false);
  });

  it("requires the YAML as a string and refuses anything else (strict)", () => {
    expect(FlowLintRequestSchema.safeParse({}).success).toBe(false);
    expect(FlowLintRequestSchema.safeParse({ yaml: null }).success).toBe(false);
    expect(FlowLintRequestSchema.safeParse({ yaml: 1 }).success).toBe(false);
    expect(FlowLintRequestSchema.safeParse({ yaml: "a: 1", slug: "x" }).success).toBe(false);
  });

  it("has two severities and 14 codes: 11 rules, then 3 for input the lint can't read", () => {
    expect(FLOW_LINT_SEVERITIES).toEqual(["block", "warn"]);
    expect(FLOW_LINT_CODES).toHaveLength(14);
    expect(FLOW_LINT_CODES.slice(-3)).toEqual(["empty-config", "invalid-yaml", "invalid-config"]);
    expect(new Set(FLOW_LINT_CODES).size).toBe(14);
  });

  it("answers blocked, the findings and the destinations, strict", () => {
    expect(FlowLintResponseSchema.parse(answer)).toEqual(answer);
    expect(FlowLintResponseSchema.parse({ blocked: false, findings: [], destinations: [] })).toEqual({
      blocked: false,
      findings: [],
      destinations: [],
    });
    expect(FlowLintResponseSchema.safeParse({ ...answer, yaml: "a: 1" }).success).toBe(false);
    const { destinations: _destinations, ...withoutDestinations } = answer;
    expect(FlowLintResponseSchema.safeParse(withoutDestinations).success).toBe(false);
  });

  it("checks each finding's severity and code against the lists, strict", () => {
    expect(FlowLintFindingSchema.parse(finding)).toEqual(finding);
    expect(FlowLintFindingSchema.safeParse({ ...finding, severity: "error" }).success).toBe(false);
    expect(FlowLintFindingSchema.safeParse({ ...finding, code: "made-up" }).success).toBe(false);
    expect(FlowLintFindingSchema.safeParse({ ...finding, line: 3 }).success).toBe(false);
  });
});
