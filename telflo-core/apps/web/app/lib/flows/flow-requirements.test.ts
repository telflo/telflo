import { describe, expect, it } from "vitest";
import { describeFlowRequirements } from "./flow-requirements.js";

/*
 * The requirements' cases (D12 Preflight ruling 12), on the editor's reading
 * of the text (`yaml`).
 */

const CONFIG = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  otlp_grpc:
    endpoint: \${env:OTLP_ENDPOINT}
    headers:
      Authorization: "Bearer \${env:OTLP_TOKEN}"
  otlp_http/langfuse:
    endpoint: \${env:OTLP_ENDPOINT}
  datadog:
    api:
      key: \${env:DD_API_KEY}
      site: \${env:DD_SITE:-datadoghq.com}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_grpc, datadog]
`;

describe("describeFlowRequirements", () => {
  it("lists the backends a flow sends to", () => {
    expect(describeFlowRequirements(CONFIG).exporters).toEqual(["datadog", "otlp_grpc", "otlp_http"]);
  });

  it("collapses config aliases onto their component", () => {
    // `otlp_http/langfuse` is one backend configured twice over, not two.
    const { exporters } = describeFlowRequirements(CONFIG);
    expect(exporters.filter((e) => e === "otlp_http")).toHaveLength(1);
  });

  it("lists variables the importer has to set", () => {
    expect(describeFlowRequirements(CONFIG).envVars).toEqual(["DD_API_KEY", "OTLP_ENDPOINT", "OTLP_TOKEN"]);
  });

  it("omits variables that already have a default", () => {
    // ${env:DD_SITE:-datadoghq.com} works untouched, so listing it as a
    // requirement would send people looking for something to do.
    expect(describeFlowRequirements(CONFIG).envVars).not.toContain("DD_SITE");
  });

  it("does not treat receiver bind addresses as backends", () => {
    expect(describeFlowRequirements(CONFIG).exporters).not.toContain("otlp");
  });

  it("returns nothing rather than throwing on unparseable YAML", () => {
    expect(describeFlowRequirements("exporters:\n  [broken")).toEqual({ exporters: [], envVars: [], orgVars: [] });
    // The editor's reading refuses a duplicate key, as the collector does.
    expect(describeFlowRequirements("exporters:\n  a: {}\n  a: {}\nx: ${env:X}\n")).toEqual({
      exporters: [],
      envVars: [],
      orgVars: [],
    });
  });

  it("handles a config with no exporters", () => {
    expect(describeFlowRequirements("receivers:\n  otlp:\n")).toEqual({ exporters: [], envVars: [], orgVars: [] });
    // Nor one whose exporters aren't a mapping, nor one that isn't a mapping at all.
    expect(describeFlowRequirements("exporters: [otlp]\n").exporters).toEqual([]);
    expect(describeFlowRequirements("- exporters\n").exporters).toEqual([]);
  });

  it("lists org variables separately from environment variables", () => {
    // Both answer "what must I set first?", but in different places: the
    // collector's environment vs the organization's variables.
    const config = `
exporters:
  clickhouse:
    endpoint: '\${org:CLICKHOUSE_ENDPOINT}'
    username: '\${org:CLICKHOUSE_USER}'
    password: \${env:CLICKHOUSE_PASSWORD}
    database: \${org:CLICKHOUSE_DATABASE}
`;
    const { envVars, orgVars } = describeFlowRequirements(config);
    expect(orgVars).toEqual(["CLICKHOUSE_DATABASE", "CLICKHOUSE_ENDPOINT", "CLICKHOUSE_USER"]);
    expect(envVars).toEqual(["CLICKHOUSE_PASSWORD"]);
  });

  it("does not mistake the other token tiers, or the legacy $orgvar: (plain text since D20, Q95), for org variables", () => {
    const config = "exporters:\n  otlp:\n    a: '$other:X'\n    b: '$secret:Y'\n    c: '$orgvar:LEGACY'\n    d: '$${org:ESCAPED}'\n";
    expect(describeFlowRequirements(config).orgVars).toEqual([]);
  });
});
