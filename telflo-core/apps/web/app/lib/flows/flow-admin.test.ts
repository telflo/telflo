import { describe, expect, it } from "vitest";
import { changedFields, deriveSignals, isPinOffered, isProductAdminRefusal, slugify, type FlowFields } from "./flow-admin.js";
import { ApiError } from "~/lib/api-client.js";
import { ACME, CATALOGUE, CONTRIB, RETIRED_VERSION } from "~/test/collector-distributions.js";
import { PII_REDACTION, TAIL_SAMPLING, TAIL_SAMPLING_YAML, makeFlow } from "~/test/flows.js";

/** The dialog's fields for `flow` as it is: what an edit that changes nothing saves. */
function fieldsOf(flow = TAIL_SAMPLING): FlowFields {
  return {
    slug: flow.slug,
    name: flow.name,
    summary: flow.summary,
    description: flow.description,
    signals: flow.signals,
    tags: flow.tags,
    yaml: flow.yaml,
    collectorDistribution: flow.collectorDistribution,
    collectorVersion: flow.collectorVersion,
    sourceUrl: flow.sourceUrl,
    authorName: flow.authorName,
    sortOrder: flow.sortOrder,
  };
}

describe("slugify", () => {
  it("lowercases the name and joins its words of letters and digits with hyphens", () => {
    expect(slugify("  PII Redaction: Gateway (v2)!  ")).toBe("pii-redaction-gateway-v2");
  });

  it("cuts the slug to 80 characters", () => {
    expect(slugify("a".repeat(100))).toHaveLength(80);
  });

  it("is empty for a name with no letter or digit", () => {
    expect(slugify("—!—")).toBe("");
  });
});

describe("deriveSignals", () => {
  it("names each signal the text's pipelines handle, traces, metrics, logs in that order, `traces/sampled` as traces", () => {
    expect(deriveSignals(TAIL_SAMPLING_YAML)).toEqual(["traces", "metrics"]);
    expect(deriveSignals(PII_REDACTION.yaml)).toEqual(["logs"]);
  });

  it("has none for a blank text, a text without pipelines, and one the editor can't read", () => {
    expect(deriveSignals("   \n")).toEqual([]);
    // parse's graph would show three empty default pipelines here; the text has none.
    expect(deriveSignals("receivers:\n  otlp:\n")).toEqual([]);
    expect(deriveSignals("service:\n  pipelines:\n    logs: [\n")).toEqual([]);
    expect(deriveSignals("a: 1\na: 2\n")).toEqual([]);
  });
});

describe("isPinOffered", () => {
  it("is true for a pin the catalog offers", () => {
    expect(isPinOffered(TAIL_SAMPLING, CATALOGUE)).toBe(true);
  });

  it("is false for a pin it has retired or never had", () => {
    expect(isPinOffered(makeFlow({ collectorVersion: RETIRED_VERSION }), CATALOGUE)).toBe(false);
    expect(isPinOffered(makeFlow({ collectorVersion: "9.9.9" }), [CONTRIB, ACME])).toBe(false);
  });

  it("can't say while the catalog is unread, or for a distribution it doesn't list", () => {
    expect(isPinOffered(makeFlow({ collectorVersion: RETIRED_VERSION }), null)).toBeNull();
    expect(isPinOffered(makeFlow({ collectorDistribution: "gone" }), CATALOGUE)).toBeNull();
  });
});

describe("changedFields: an edit's PATCH", () => {
  it("is empty when nothing changed, the signals in another order included", () => {
    expect(changedFields(TAIL_SAMPLING, { ...fieldsOf(), signals: ["metrics", "traces"] })).toEqual({});
  });

  it("sends only the name when only the name changed, so a retired pin isn't sent", () => {
    const retired = makeFlow({ collectorVersion: RETIRED_VERSION });
    expect(changedFields(retired, { ...fieldsOf(retired), name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it("sends the distribution and the version together when either changed", () => {
    expect(changedFields(TAIL_SAMPLING, { ...fieldsOf(), collectorVersion: "0.161.0" })).toEqual({
      collectorDistribution: "otelcol-contrib",
      collectorVersion: "0.161.0",
    });
  });

  it("sends each other field that changed, and nulls an emptied link or author", () => {
    const flow = makeFlow({ sourceUrl: "https://example.com/c.yaml", authorName: "ClickStack" });
    expect(
      changedFields(flow, {
        ...fieldsOf(flow),
        slug: "new-slug",
        summary: "S",
        description: "D",
        signals: ["logs"],
        tags: ["cost", "sampling"],
        yaml: "x: 1\n",
        sourceUrl: null,
        authorName: null,
        sortOrder: 5,
      }),
    ).toEqual({
      slug: "new-slug",
      summary: "S",
      description: "D",
      signals: ["logs"],
      tags: ["cost", "sampling"],
      yaml: "x: 1\n",
      sourceUrl: null,
      authorName: null,
      sortOrder: 5,
    });
  });
});

describe("isProductAdminRefusal", () => {
  it("is the API's 403 product_admin_required only", () => {
    expect(isProductAdminRefusal(new ApiError("product_admin_required", "No.", { status: 403 }))).toBe(true);
    expect(isProductAdminRefusal(new ApiError("forbidden", "No.", { status: 403 }))).toBe(false);
    expect(isProductAdminRefusal(new Error("product_admin_required"))).toBe(false);
  });
});
