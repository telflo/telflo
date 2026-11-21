import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIGURATION_YAML_MAXIMUM_LENGTH } from "@telflo/contracts";
import {
  clearStagedEdit,
  hasStagedEdit,
  readStagedEdit,
  STAGED_EDIT_KEY,
  STAGED_EDIT_MAX_AGE_MS,
  stagePlaygroundEdit,
  type StagedContent,
} from "./staged-edit.js";

/*
 * The staged edit: one key, written by Save, read by the handoff, removed
 * by its Save or Discard, and ignored and removed when older than 7 days,
 * unreadable, or refused by the create's schema. A visitor's text is
 * checked with boolean canaries only: never compared, printed or
 * snapshotted.
 */

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const CANARY = `canary-${Math.random().toString(36).slice(2)}`;

function content(overrides: Partial<StagedContent> = {}): StagedContent {
  return {
    name: `Gateway ${CANARY}`,
    yamlContent: `receivers:\n  otlp: {}\n# ${CANARY}\n`,
    nodes: [],
    edges: [],
    pipelines: [],
    collectorDistribution: "otelcol-contrib",
    collectorVersion: "0.162.0",
    ...overrides,
  };
}

function stored(): string | null {
  return window.localStorage.getItem(STAGED_EDIT_KEY);
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("staging", () => {
  it("writes one key in the stored format, read back as the create's content", () => {
    expect(stagePlaygroundEdit(content(), NOW)).toBe("staged");
    expect(window.localStorage.length).toBe(1);
    const parsed = JSON.parse(stored()!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "collectorDistribution",
      "collectorVersion",
      "edges",
      "name",
      "nodes",
      "pipelines",
      "savedAt",
      "version",
      "yamlContent",
    ]);
    expect(parsed["version"]).toBe(1);
    expect(parsed["savedAt"]).toBe(new Date(NOW).toISOString());

    const read = readStagedEdit(NOW)!;
    expect(read).not.toBeNull();
    expect(read.content.name.includes(CANARY)).toBe(true);
    expect(read.content.yamlContent.includes(CANARY)).toBe(true);
    expect(read.content.description).toBe("");
    expect(read.content.collectorDistribution).toBe("otelcol-contrib");
    expect(read.content.collectorVersion).toBe("0.162.0");
    expect("sourceFlowSlug" in read.content).toBe(false);
  });

  it("replaces the edit staged before", () => {
    stagePlaygroundEdit(content(), NOW);
    stagePlaygroundEdit(content({ name: "Second" }), NOW + 1000);
    expect(window.localStorage.length).toBe(1);
    expect(readStagedEdit(NOW + 1000)!.content.name === "Second").toBe(true);
  });

  it("refuses, writing nothing, what the create's schema would refuse (the YAML's cap)", () => {
    const tooLong = "#".repeat(CONFIGURATION_YAML_MAXIMUM_LENGTH + 1);
    expect(stagePlaygroundEdit(content({ yamlContent: tooLong }), NOW)).toBe("refused");
    expect(stored()).toBeNull();
    expect(stagePlaygroundEdit(content({ name: "   " }), NOW)).toBe("refused");
    expect(stored()).toBeNull();
  });

  it("says so when the browser can't keep it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(stagePlaygroundEdit(content(), NOW)).toBe("unavailable");
  });
});

describe("reading", () => {
  it("is null with nothing staged", () => {
    expect(readStagedEdit(NOW)).toBeNull();
    expect(hasStagedEdit(NOW)).toBe(false);
  });

  it("keeps an edit 7 days old, and ignores and removes one older", () => {
    stagePlaygroundEdit(content(), NOW);
    expect(hasStagedEdit(NOW + STAGED_EDIT_MAX_AGE_MS)).toBe(true);
    expect(stored()).not.toBeNull();
    expect(readStagedEdit(NOW + STAGED_EDIT_MAX_AGE_MS + 1)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("ignores and removes one dated in the future", () => {
    stagePlaygroundEdit(content(), NOW + 60_000);
    expect(readStagedEdit(NOW)).toBeNull();
    expect(stored()).toBeNull();
  });

  it.each([
    ["not JSON", "{not json"],
    ["not an object", JSON.stringify(["a"])],
    ["another format", JSON.stringify({ ...content(), version: 2, savedAt: new Date(NOW).toISOString() })],
    ["a field missing", JSON.stringify({ version: 1, savedAt: new Date(NOW).toISOString(), name: "x" })],
    ["an extra field", JSON.stringify({ ...content(), version: 1, savedAt: new Date(NOW).toISOString(), sourceFlowSlug: "a-flow" })],
    ["undated", JSON.stringify({ ...content(), version: 1, savedAt: "yesterday" })],
    ["a graph that isn't one", JSON.stringify({ ...content(), nodes: "x", version: 1, savedAt: new Date(NOW).toISOString() })],
  ])("ignores and removes one that is %s", (_label, value) => {
    window.localStorage.setItem(STAGED_EDIT_KEY, value);
    expect(readStagedEdit(NOW)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("ignores and removes one the create's schema refuses (written by something else)", () => {
    const tooLong = "#".repeat(CONFIGURATION_YAML_MAXIMUM_LENGTH + 1);
    window.localStorage.setItem(
      STAGED_EDIT_KEY,
      JSON.stringify({ version: 1, savedAt: new Date(NOW).toISOString(), ...content({ yamlContent: tooLong }) }),
    );
    expect(readStagedEdit(NOW)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("is null when storage can't be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readStagedEdit(NOW)).toBeNull();
  });
});

describe("clearing", () => {
  it("removes it (the handoff's Save and Discard)", () => {
    stagePlaygroundEdit(content(), NOW);
    clearStagedEdit();
    expect(stored()).toBeNull();
    expect(readStagedEdit(NOW)).toBeNull();
  });
});
