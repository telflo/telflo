import { describe, expect, it } from "vitest";
import { hasPipelineKey, pipelineKeysOf } from "./yaml-pipelines.js";

/*
 * The pipeline keys of a collector configuration's `service.pipelines` (D25
 * Preflight ruling 8): what route 14's PUT and route 26's test runs check a
 * pipeline's name against.
 */

const CONFIG = [
  "receivers:",
  "  otlp:",
  "exporters:",
  "  debug:",
  "service:",
  "  pipelines:",
  "    traces/otlp:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "    logs:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "    metrics/a/b:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

describe("pipelineKeysOf", () => {
  it("answers the keys of service.pipelines, in the text's order, a key holding / whole", () => {
    expect(pipelineKeysOf(CONFIG)).toEqual(["traces/otlp", "logs", "metrics/a/b"]);
  });

  it("answers an empty list for an empty service.pipelines mapping", () => {
    expect(pipelineKeysOf("service:\n  pipelines: {}\n")).toEqual([]);
  });

  it("reads keys through an anchor and a merge key, as the collector's YAML does", () => {
    const text = [
      "base: &base",
      "  traces/shared:",
      "    receivers: [otlp]",
      "service:",
      "  pipelines:",
      "    <<: *base",
      "    logs:",
      "      receivers: [otlp]",
      "",
    ].join("\n");
    expect(pipelineKeysOf(text)).toEqual(["traces/shared", "logs"]);
  });

  it("answers undefined for a text that doesn't parse, a duplicate key included", () => {
    expect(pipelineKeysOf("service: [unclosed")).toBeUndefined();
    expect(pipelineKeysOf("service:\n  pipelines:\n    logs: {}\n    logs: {}\n")).toBeUndefined();
  });

  it("answers undefined for a text with no service.pipelines mapping", () => {
    expect(pipelineKeysOf("")).toBeUndefined();
    expect(pipelineKeysOf("just a string")).toBeUndefined();
    expect(pipelineKeysOf("- a list\n")).toBeUndefined();
    expect(pipelineKeysOf("receivers: {}\n")).toBeUndefined();
    expect(pipelineKeysOf("service: plain\n")).toBeUndefined();
    expect(pipelineKeysOf("service:\n  telemetry: {}\n")).toBeUndefined();
    expect(pipelineKeysOf("service:\n  pipelines: [logs, traces]\n")).toBeUndefined();
    expect(pipelineKeysOf("service:\n  pipelines:\n")).toBeUndefined();
  });

  it("leaves out a key that isn't a string", () => {
    expect(pipelineKeysOf("service:\n  pipelines:\n    1: {}\n    true: {}\n    ~: {}\n    logs: {}\n    '2': {}\n")).toEqual([
      "logs",
      "2",
    ]);
  });

  it("refuses an alias bomb past 100 aliases, as the lints do", () => {
    const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level <= 8; level += 1) {
      const previous = `*a${level - 1}`;
      lines.push(`a${level}: &a${level} [${Array.from({ length: 10 }, () => previous).join(", ")}]`);
    }
    lines.push("service:", "  pipelines:", "    logs: *a8", "");
    expect(pipelineKeysOf(lines.join("\n"))).toBeUndefined();
  });
});

describe("hasPipelineKey", () => {
  it("is true only for a key of service.pipelines, compared whole and exactly", () => {
    expect(hasPipelineKey(CONFIG, "traces/otlp")).toBe(true);
    expect(hasPipelineKey(CONFIG, "logs")).toBe(true);
    expect(hasPipelineKey(CONFIG, "metrics/a/b")).toBe(true);
    expect(hasPipelineKey(CONFIG, "traces")).toBe(false);
    expect(hasPipelineKey(CONFIG, "Logs")).toBe(false);
    expect(hasPipelineKey(CONFIG, "logs ")).toBe(false);
    expect(hasPipelineKey(CONFIG, "traces%2Fotlp")).toBe(false);
    expect(hasPipelineKey(CONFIG, "otlp")).toBe(false);
  });

  it("is false for every name of a text that declares no pipeline", () => {
    expect(hasPipelineKey("service: [unclosed", "logs")).toBe(false);
    expect(hasPipelineKey("receivers: {}\n", "logs")).toBe(false);
  });
});
