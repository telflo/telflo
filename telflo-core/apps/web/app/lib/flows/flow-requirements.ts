import { parseDocument } from "yaml";
import { PARSE_OPTIONS, isPlainObject } from "~/lib/graph/parse.js";
import { orgVariableReferences } from "~/lib/org-variables.js";

/*
 * A flow's requirements (D12 Preflight rulings 12 and 18): what someone needs
 * to know before using a flow, for its page's "Before you use this" box. Not
 * a security check (that is the product admin's `flow_lint`): which backends
 * it sends to, and what has to be set before it runs.
 *
 * The text is read as the editor reads it
 * (D9a's options: YAML 1.2, merge keys, duplicate keys refused, at most 100
 * aliases). A text that can't be read lists nothing.
 */

export interface FlowRequirements {
  /** Exporter component types, e.g. otlp_grpc, datadog, clickhouse, each once, sorted. */
  exporters: string[];
  /** Environment variables the text references without a default, sorted. */
  envVars: string[];
  /**
   * Organization variables the text references (`${org:NAME}`, its live
   * references only: the opamp-server's scan, D20 decision 36), sorted. Set
   * in the organization's variables, not the collector's environment; an
   * unset one is delivered as written. The legacy `$orgvar:NAME` is plain
   * text since D20 (Q95), so it lists nothing.
   */
  orgVars: string[];
}

const NOTHING: FlowRequirements = { exporters: [], envVars: [], orgVars: [] };

/** How many aliases one text may resolve (the editor's limit, `yaml`'s default). */
const MAXIMUM_ALIAS_COUNT = 100;

/** `${env:VAR}` and `${env:VAR:-default}`; one with a default needs nothing from the importer. */
const ENV_REF_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

/** The text's value, or undefined when it can't be read. */
function readValue(yamlContent: string): unknown {
  const document = parseDocument(yamlContent, PARSE_OPTIONS);
  if (document.errors.length > 0) return undefined;
  try {
    return document.toJS({ maxAliasCount: MAXIMUM_ALIAS_COUNT });
  } catch {
    return undefined;
  }
}

export function describeFlowRequirements(yamlContent: string): FlowRequirements {
  const value = readValue(yamlContent);
  if (value === undefined) return NOTHING;

  const exporterSection = isPlainObject(value) && isPlainObject(value.exporters) ? value.exporters : {};
  // `otlp_http/langfuse` and `otlp_http` are one component: the suffix is the
  // instance's name, and would read as a second backend.
  const exporters = [...new Set(Object.keys(exporterSection).map((name) => name.split("/")[0] ?? name))].sort();

  const envVars = new Set<string>();
  for (const match of yamlContent.matchAll(ENV_REF_RE)) {
    if (match[1] !== undefined && match[2] === undefined) envVars.add(match[1]);
  }

  return {
    exporters,
    envVars: [...envVars].sort(),
    orgVars: orgVariableReferences(yamlContent).sort(),
  };
}
