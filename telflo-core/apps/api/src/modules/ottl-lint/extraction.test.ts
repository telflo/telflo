import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { extractOttl, type Extraction } from "./extraction.js";

/*
 * The extraction of OTTL from a collector configuration (D25 decision 33),
 * on the configuration parsed as the service parses it (mappings as Maps,
 * in the text's order): each component's cases, a skipped context's entry
 * quoting no value, and a policy list an alias nests in itself ending the
 * walk.
 */

const parsed = (text: string): unknown => parseDocument(text, { merge: true, uniqueKeys: true }).toJS({ mapAsMap: true, maxAliasCount: 100 });

const CONFIG = parsed(`
processors:
  transform/logs:
    error_mode: ignore
    log_statements:
      - context: log
        conditions:
          - severity_number >= 17
        statements:
          - set(attributes["env"], "prod")
      - set(resource.attributes["flat"], "yes")
    metric_statements:
      - statements:
          - convert_sum_to_gauge()
  filter:
    traces:
      span:
        - attributes["http.route"] == "/health"
      spanevent:
        - name == "exception"
    metrics:
      metric:
        - name == "up"
      datapoint:
        - value_int == 0
    logs:
      log_record:
        - IsMatch(body, "debug")
  tail_sampling:
    policies:
      - name: errors
        type: ottl_condition
        ottl_condition:
          span:
            - status.code == STATUS_CODE_ERROR
      - name: both
        type: and
        and:
          and_sub_policy:
            - name: inner
              type: ottl_condition
              ottl_condition:
                spanevent:
                  - name == "retry"
  batch: {}
connectors:
  routing:
    default_pipelines: [traces/other]
    table:
      - context: span
        condition: attributes["team"] == "a"
        pipelines: [traces/a]
      - condition: attributes["region"] == "eu"
        pipelines: [traces/eu]
      - context: request
        condition: request["X-Tenant"] == "acme"
        pipelines: [traces/acme]
      - statement: route() where attributes["legacy"] == true
        pipelines: [traces/legacy]
`);

const byLocation = (extraction: Extraction) => new Map(extraction.items.map((item) => [item.location, item]));

describe("extractOttl, case for case", () => {
  it("test_transform_structured_and_flat", () => {
    const items = byLocation(extractOttl(CONFIG));
    expect(items.get("processors.transform/logs.log_statements[0].conditions[0]")).toMatchObject({
      context: "log",
      kind: "condition",
      inferredContext: false,
    });
    expect(items.get("processors.transform/logs.log_statements[0].statements[0]")?.input).toBe('set(attributes["env"], "prod")');
    expect(items.get("processors.transform/logs.log_statements[1]")).toMatchObject({ context: "log", kind: "statement", inferredContext: true });
    expect(items.get("processors.transform/logs.metric_statements[0].statements[0]")).toMatchObject({ context: "datapoint", inferredContext: true });
  });

  it("test_filter_contexts", () => {
    const items = byLocation(extractOttl(CONFIG));
    expect(items.get("processors.filter.traces.span[0]")?.context).toBe("span");
    expect(items.get("processors.filter.traces.spanevent[0]")?.context).toBe("spanevent");
    expect(items.get("processors.filter.metrics.metric[0]")?.context).toBe("metric");
    expect(items.get("processors.filter.metrics.datapoint[0]")?.context).toBe("datapoint");
    expect(items.get("processors.filter.logs.log_record[0]")?.context).toBe("log");
    expect([...items].filter(([location]) => location.includes(".filter.")).every(([, item]) => item.kind === "condition")).toBe(true);
  });

  it("test_tail_sampling_including_nested_policies", () => {
    const items = byLocation(extractOttl(CONFIG));
    expect(items.get("processors.tail_sampling.policies[0].ottl_condition.span[0]")?.context).toBe("span");
    expect(items.get("processors.tail_sampling.policies[1].and.and_sub_policy[0].ottl_condition.spanevent[0]")).toMatchObject({
      context: "spanevent",
      input: 'name == "retry"',
    });
  });

  it("test_routing_conditions_default_context_and_skips", () => {
    const extraction = extractOttl(CONFIG);
    const items = byLocation(extraction);
    expect(items.get("connectors.routing.table[0].condition")?.context).toBe("span");
    expect(items.get("connectors.routing.table[1].condition")?.context).toBe("resource");
    expect(items.has("connectors.routing.table[2].condition")).toBe(false);
    expect(extraction.skipped.some((entry) => entry.includes("table[2].condition") && entry.includes("request"))).toBe(true);
    expect(extraction.skipped.some((entry) => entry.includes("table[3].statement"))).toBe(true);
  });

  it("test_order_follows_the_yaml_and_ignores_other_components", () => {
    const locations = extractOttl(CONFIG).items.map((item) => item.location);
    expect(locations[0]!.startsWith("processors.transform/logs")).toBe(true);
    expect(locations[locations.length - 1]).toBe("connectors.routing.table[1].condition");
    expect(locations.some((location) => location.includes("batch"))).toBe(false);
    expect(locations).toHaveLength(13);
  });

  it("test_non_mapping_and_empty_configs", () => {
    expect(extractOttl(new Map()).items).toEqual([]);
    expect(extractOttl(parsed("processors:\n  transform: oops\n")).items).toEqual([]);
    expect(extractOttl(parsed("- a list\n"))).toEqual({ items: [], skipped: [] });
  });
});

describe("the port's own cases", () => {
  it("skips a transform group's or a route's unknown context by its location, quoting no value", () => {
    const extraction = extractOttl(
      parsed(`
processors:
  transform:
    trace_statements:
      - context: marker_context_9e1
        statements: [set(name, "x")]
connectors:
  routing/two:
    table:
      - context: marker_route_3b2
        condition: name == "x"
`),
    );
    expect(extraction.items).toEqual([]);
    expect(extraction.skipped).toEqual([
      "processors.transform.trace_statements[0]: unknown context",
      "connectors.routing/two.table[0]: unknown context",
    ]);
  });

  it("walks a policy list an alias nests in itself once, in the YAML's order", () => {
    const extraction = extractOttl(
      parsed(`
processors:
  tail_sampling:
    policies: &policies
      - type: ottl_condition
        ottl_condition:
          span: [name == "a"]
      - type: composite
        composite:
          composite_sub_policy: *policies
      - type: ottl_condition
        ottl_condition:
          spanevent: [name == "b"]
`),
    );
    expect(extraction.items.map(({ location, input }) => `${location} ${input}`)).toEqual([
      'processors.tail_sampling.policies[0].ottl_condition.span[0] name == "a"',
      'processors.tail_sampling.policies[2].ottl_condition.spanevent[0] name == "b"',
    ]);
  });

  it("takes a flat transform statement list against the signal's lowest context, and leaves non-strings out", () => {
    const extraction = extractOttl(parsed('processors:\n  transform:\n    trace_statements:\n      - set(name, "x")\n      - 7\n      - [nested]\n'));
    expect(extraction.items).toEqual([
      { context: "span", kind: "statement", input: 'set(name, "x")', location: "processors.transform.trace_statements[0]", inferredContext: true },
    ]);
  });
});
