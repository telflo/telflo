import { describe, expect, it } from "vitest";
import { requiredEnvVarNames } from "./env-var-names.js";

// D17c-1 decisions 24 and 38, Preflight ruling 14: the references found,
// the five exclusions, and the collector's `$$` escape.

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
});
