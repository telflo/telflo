import { describe, expect, it } from "vitest";
import { requiredEnvVarNames } from "./env-var-names.js";

// The references found, the five exclusions, and the collector's `$$`
// escape.

describe("requiredEnvVarNames", () => {
  it("finds bare ${env:…} references, each once, in first-appearance order", () => {
    const yaml = [
      "exporters:",
      "  otlphttp:",
      "    endpoint: ${env:BACKEND_ENDPOINT}",
      "    headers:",
      "      Authorization: Bearer ${env:BACKEND_API_KEY}",
      "  otlphttp/2:",
      "    endpoint: ${env:BACKEND_ENDPOINT}",
    ].join("\n");
    expect(requiredEnvVarNames(yaml)).toEqual(["BACKEND_ENDPOINT", "BACKEND_API_KEY"]);
  });

  it("skips a reference with a :-default", () => {
    expect(requiredEnvVarNames("endpoint: ${env:BACKEND_ENDPOINT:-http://localhost:4318}")).toEqual([]);
  });

  it("still needs a variable that also appears with a default", () => {
    expect(requiredEnvVarNames("a: ${env:MIXED_VAR:-fallback}\nb: ${env:MIXED_VAR}")).toEqual(["MIXED_VAR"]);
  });

  it("leaves out the five an install sets itself", () => {
    const yaml = [
      "a: ${env:OPAMP_TOKEN}",
      "b: ${env:COLLECTOR_GROUP_ID}",
      "c: ${env:OPAMP_ENDPOINT}",
      "d: ${env:OPAMP_SERVER_NAME}",
      "e: ${env:OPAMP_ALLOW_INSECURE_CONNECTIONS}",
      "f: ${env:MY_KEY}",
    ].join("\n");
    expect(requiredEnvVarNames(yaml)).toEqual(["MY_KEY"]);
  });

  it("ignores malformed names and other providers", () => {
    expect(requiredEnvVarNames("a: ${env:1BAD}\nb: ${env:BAD-NAME}\nc: ${file:/etc/secret}\nd: ${env:}\ne: ${MY_KEY}")).toEqual([]);
  });

  it("skips a reference the collector reads as text ($${env:…}), and counts one after an escaped $ ($$${env:…})", () => {
    expect(requiredEnvVarNames("a: $${env:ESCAPED}\nb: $$$${env:ALSO_ESCAPED}\nc: $$${env:LIVE}\nd: x${env:LIVE_TOO}")).toEqual([
      "LIVE",
      "LIVE_TOO",
    ]);
  });

  it("leaves out a name over 256 characters (the facts' reply bounds each name), keeping one of 256", () => {
    const longest = `A${"b".repeat(255)}`;
    expect(requiredEnvVarNames(`a: \${env:${longest}c}\nb: \${env:${longest}}\nc: \${env:OK}`)).toEqual([longest, "OK"]);
  });

  it("keeps a lower-case or mixed-case name as written", () => {
    expect(requiredEnvVarNames("a: ${env:my_key}\nb: ${env:My_Key}")).toEqual(["my_key", "My_Key"]);
  });

  it("reads a text the collector's $$ escapes and defaults mix as the single pattern did (random texts)", () => {
    // The single pattern this replaced: the same answers, on texts built from the pieces that matter.
    const single = /(\$+)\{env:([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;
    const reference = (yaml: string): string[] => {
      const names: string[] = [];
      for (const [, dollars, name, fallback] of yaml.matchAll(single) as Iterable<[string, string, string, string | undefined]>) {
        if (dollars.length % 2 === 1 && fallback === undefined && !names.includes(name) && name !== "OPAMP_TOKEN") names.push(name);
      }
      return names;
    };
    const pieces = ["$", "$$", "{", "}", "env:", "A", "B", "OPAMP_TOKEN", ":-", ":", "-", "x", " ", "\n"];
    let seed = 1;
    const next = (bound: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % bound;
    };
    for (let i = 0; i < 5000; i += 1) {
      let yaml = "";
      for (let j = next(30); j > 0; j -= 1) yaml += pieces[next(pieces.length)];
      expect(requiredEnvVarNames(yaml), yaml).toEqual(reference(yaml));
    }
  });

  it("reads 256 KiB of a dollar run, or of defaults never closed, in linear time", () => {
    const limit = 262_144;
    for (const yaml of [`receivers: {}\n# ${"$".repeat(limit)}`, `# ${"${env:A:-".repeat(limit / 9)}`, `# ${"${env:".repeat(limit / 6)}`]) {
      const started = performance.now();
      expect(requiredEnvVarNames(yaml)).toEqual([]);
      // The single pattern took seconds to minutes on each (the square of the length).
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

