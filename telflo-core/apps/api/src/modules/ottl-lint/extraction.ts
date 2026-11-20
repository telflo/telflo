import { OTTL_CONTEXTS, type OttlContext } from "@telflo/contracts";

/*
 * Every OTTL expression in a collector configuration, so the public API's
 * OTTL lint can lint "the OTTL in this configuration". It knows where the
 * OTTL-bearing components keep their expressions and the context each is
 * written against:
 *
 * - the `transform` processor: `trace_statements`, `metric_statements` and
 *   `log_statements`, each a flat list of statements (the context the
 *   processor infers: linted against the signal's lowest context) or groups
 *   `{ context, conditions, statements }`;
 * - the `filter` processor: `traces.span`, `traces.spanevent`,
 *   `metrics.metric`, `metrics.datapoint` and `logs.log_record` conditions;
 * - the `routing` connector (or the legacy processor): `table[].condition`,
 *   its `context` defaulting to `resource`;
 * - the `tail_sampling` processor: `ottl_condition` policies' `span` and
 *   `spanevent` lists, inside `and` and `composite` policies too.
 *
 * Pure: it takes the parsed configuration (mappings as Maps, in the text's
 * order, as the service parses it) and returns each expression with its
 * context and a dotted `location` into the YAML. What the linter can't
 * judge (the routing's `request` context, legacy `statement` routes, an
 * unknown context) is listed in `skipped` rather than dropped. A skipped
 * context's entry doesn't quote the context's value (fixed words after the
 * location), and the policies are walked without recursion, each list once,
 * so an alias that nests a policy list in itself can't loop.
 */

/** The contexts the evaluator lints against. */
export const OTTL_LINT_CONTEXTS: ReadonlySet<string> = new Set<string>(OTTL_CONTEXTS);

/**
 * Flat transform statements carry no context: the processor infers the
 * lowest one their paths need. Linting against the signal's lowest context
 * accepts the same paths (`resource.*` and `instrumentation_scope.*` are
 * reachable from it), so it is the least-false-positive choice.
 */
const TRANSFORM_DEFAULT_CONTEXT: Readonly<Record<string, OttlContext>> = {
  trace_statements: "span",
  metric_statements: "datapoint",
  log_statements: "log",
};

const FILTER_CONTEXTS: Readonly<Record<string, Readonly<Record<string, OttlContext>>>> = {
  traces: { span: "span", spanevent: "spanevent" },
  metrics: { metric: "metric", datapoint: "datapoint" },
  logs: { log_record: "log" },
};

/** One expression to lint: its context, kind, text, where it is, and whether its context was inferred. */
export interface ExtractedExpression {
  context: OttlContext;
  kind: "condition" | "statement";
  input: string;
  location: string;
  inferredContext: boolean;
}

export interface Extraction {
  items: ExtractedExpression[];
  skipped: string[];
}

type Mapping = Map<unknown, unknown>;

const isMapping = (value: unknown): value is Mapping => value instanceof Map;

/** A mapping's value, as Python's `dict.get`. */
const get = (mapping: Mapping, key: string): unknown => mapping.get(key);

/** `value or fallback`, Python's truthiness for what YAML gives: null, false, 0, "", an empty list or mapping. */
function orElse(value: unknown, fallback: unknown): unknown {
  const isFalsy =
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (value instanceof Map && value.size === 0);
  return isFalsy ? fallback : value;
}

/** A key as a path names it. */
const keyText = (key: unknown): string => String(key);

/** `transform/logs` → `transform`. */
const componentType = (key: unknown): string => keyText(key).split("/", 1)[0] as string;

/** A list's strings, in order; anything else none. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const isOttlContext = (value: unknown): value is OttlContext => typeof value === "string" && OTTL_LINT_CONTEXTS.has(value);

/** Every OTTL expression in `config` (a parsed collector configuration), in the YAML's order. */
export function extractOttl(config: unknown): Extraction {
  const items: ExtractedExpression[] = [];
  const skipped: string[] = [];
  if (!isMapping(config)) return { items, skipped };

  const processors = orElse(get(config, "processors"), new Map());
  if (isMapping(processors)) {
    for (const [name, component] of processors) {
      if (!isMapping(component)) continue;
      const location = `processors.${keyText(name)}`;
      switch (componentType(name)) {
        case "transform":
          extractTransform(component, location, items, skipped);
          break;
        case "filter":
          extractFilter(component, location, items);
          break;
        case "routing":
          extractRouting(component, location, items, skipped);
          break;
        case "tail_sampling":
          extractTailSampling(component, location, items);
          break;
      }
    }
  }

  const connectors = orElse(get(config, "connectors"), new Map());
  if (isMapping(connectors)) {
    for (const [name, component] of connectors) {
      if (isMapping(component) && componentType(name) === "routing") {
        extractRouting(component, `connectors.${keyText(name)}`, items, skipped);
      }
    }
  }
  return { items, skipped };
}

function extractTransform(component: Mapping, location: string, items: ExtractedExpression[], skipped: string[]): void {
  // The component's own keys, so findings come out in the YAML's order.
  for (const [key, groups] of component) {
    const defaultContext = typeof key === "string" ? TRANSFORM_DEFAULT_CONTEXT[key] : undefined;
    if (defaultContext === undefined || !Array.isArray(groups)) continue;
    groups.forEach((group: unknown, groupIndex) => {
      const groupLocation = `${location}.${key as string}[${groupIndex}]`;
      if (typeof group === "string") {
        items.push({ context: defaultContext, kind: "statement", input: group, location: groupLocation, inferredContext: true });
        return;
      }
      if (!isMapping(group)) return;
      const named = get(group, "context");
      let context: OttlContext = defaultContext;
      let inferredContext = false;
      if (typeof named !== "string" || named === "") {
        inferredContext = true;
      } else if (!isOttlContext(named)) {
        skipped.push(`${groupLocation}: unknown context`);
        return;
      } else {
        context = named;
      }
      stringsOf(get(group, "conditions")).forEach((condition, index) => {
        items.push({ context, kind: "condition", input: condition, location: `${groupLocation}.conditions[${index}]`, inferredContext });
      });
      stringsOf(get(group, "statements")).forEach((statement, index) => {
        items.push({ context, kind: "statement", input: statement, location: `${groupLocation}.statements[${index}]`, inferredContext });
      });
    });
  }
}

function extractFilter(component: Mapping, location: string, items: ExtractedExpression[]): void {
  for (const [signal, section] of component) {
    const contexts = typeof signal === "string" ? FILTER_CONTEXTS[signal] : undefined;
    if (contexts === undefined || !isMapping(section)) continue;
    for (const [key, conditions] of section) {
      const context = typeof key === "string" ? contexts[key] : undefined;
      if (context === undefined) continue;
      stringsOf(conditions).forEach((condition, index) => {
        items.push({
          context,
          kind: "condition",
          input: condition,
          location: `${location}.${signal as string}.${key as string}[${index}]`,
          inferredContext: false,
        });
      });
    }
  }
}

function extractRouting(component: Mapping, location: string, items: ExtractedExpression[], skipped: string[]): void {
  const table = get(component, "table");
  if (!Array.isArray(table)) return;
  table.forEach((entry: unknown, index) => {
    if (!isMapping(entry)) return;
    const entryLocation = `${location}.table[${index}]`;
    const context = orElse(get(entry, "context"), "resource");
    if (typeof get(entry, "statement") === "string") {
      skipped.push(`${entryLocation}.statement: legacy route() statements use a routing-only function the linter does not know`);
    }
    const condition = get(entry, "condition");
    if (typeof condition !== "string") return;
    if (context === "request") {
      skipped.push(`${entryLocation}.condition: 'request' context is routing-specific and cannot be parse-checked`);
      return;
    }
    if (!isOttlContext(context)) {
      skipped.push(`${entryLocation}: unknown context`);
      return;
    }
    items.push({ context, kind: "condition", input: condition, location: `${entryLocation}.condition`, inferredContext: false });
  });
}

function extractTailSampling(component: Mapping, location: string, items: ExtractedExpression[]): void {
  const policies = get(component, "policies");
  if (Array.isArray(policies)) walkPolicies(policies, `${location}.policies`, items);
}

/**
 * The policies, depth first in the YAML's order, without
 * recursion: each list is walked once, so a list an alias nests inside
 * itself ends the walk there rather than looping.
 */
function walkPolicies(root: unknown[], rootLocation: string, items: ExtractedExpression[]): void {
  const seen = new Set<unknown[]>([root]);
  const stack: Array<{ policies: unknown[]; location: string; next: number }> = [{ policies: root, location: rootLocation, next: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next >= top.policies.length) {
      stack.pop();
      continue;
    }
    const index = top.next;
    top.next += 1;
    const policy = top.policies[index];
    if (!isMapping(policy)) continue;
    const policyLocation = `${top.location}[${index}]`;
    const type = get(policy, "type");
    let nested: { policies: unknown; location: string } | undefined;
    if (type === "ottl_condition") {
      const conditions = get(policy, "ottl_condition");
      if (!isMapping(conditions)) continue;
      for (const key of ["span", "spanevent"] as const) {
        stringsOf(get(conditions, key)).forEach((condition, conditionIndex) => {
          items.push({
            context: key,
            kind: "condition",
            input: condition,
            location: `${policyLocation}.ottl_condition.${key}[${conditionIndex}]`,
            inferredContext: false,
          });
        });
      }
    } else if (type === "and") {
      const and = orElse(get(policy, "and"), new Map());
      if (isMapping(and)) nested = { policies: get(and, "and_sub_policy"), location: `${policyLocation}.and.and_sub_policy` };
    } else if (type === "composite") {
      const composite = orElse(get(policy, "composite"), new Map());
      if (isMapping(composite)) {
        nested = { policies: get(composite, "composite_sub_policy"), location: `${policyLocation}.composite.composite_sub_policy` };
      }
    }
    if (nested !== undefined && Array.isArray(nested.policies) && !seen.has(nested.policies)) {
      seen.add(nested.policies);
      stack.push({ policies: nested.policies, location: nested.location, next: 0 });
    }
  }
}
