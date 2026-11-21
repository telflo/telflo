import { describe, expect, it } from "vitest";

import {
  LAYOUT_PRESETS,
  layoutAfterSwitch,
  layoutSetMessage,
  OPERATOR_CATEGORIES,
  operatorMeta,
  OPERATORS,
  operatorSeed,
  presetTypeOf,
  type OperatorType,
} from "./operator-catalog.js";

/*
 * The operator catalog: its 26 types, and the seed Add Operator appends
 * for each, checked against the collector's own rules at contrib v0.162.0
 * (`pkg/stanza/`, cited per rule): each seed decodes (its keys are the
 * operator's, its fields are fields) and builds (its operator's
 * `Build`/`Validate` accepts it). The collector's Go isn't run here; each
 * rule it applies to a seed is restated with its source, so a seed that
 * breaks one fails its row.
 */

// ── The collector's field syntax (entry/field.go:111-226) ──

/** entry/field.go:152-226 `fromJSONDot`: the keys of a dotted or bracketed path, or null where it refuses one. */
function fromJSONDot(s: string): string[] | null {
  const fields: string[] = [];
  type State = "begin" | "inBracket" | "inQuote" | "outQuote" | "outBracket" | "inToken";
  let state: State = "begin";
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    switch (state) {
      case "begin":
        if (c === "[") {
          state = "inBracket";
          continue;
        }
        start = i;
        state = "inToken";
        break;
      case "inBracket":
        if (c !== "'" && c !== '"') return null;
        state = "inQuote";
        quote = c;
        start = i + 1;
        break;
      case "inQuote":
        if (c === quote) {
          fields.push(s.slice(start, i));
          state = "outQuote";
        }
        break;
      case "outQuote":
        if (c !== "]") return null;
        state = "outBracket";
        break;
      case "outBracket":
        if (c === ".") {
          state = "inToken";
          start = i + 1;
        } else if (c === "[") state = "inBracket";
        else return null;
        break;
      case "inToken":
        if (c === ".") {
          fields.push(s.slice(start, i));
          start = i + 1;
        } else if (c === "[") {
          fields.push(s.slice(start, i));
          state = "inBracket";
        }
        break;
    }
  }
  if (state === "inBracket" || state === "outQuote" || state === "inQuote") return null;
  if (state === "inToken") fields.push(s.slice(start));
  return fields.length === 0 ? null : fields;
}

/**
 * entry/field.go:111-133 `newField`: a field is `body`, `attributes` or
 * `resource`, then its keys; a bare `attributes` or `resource` only where the
 * field is rootable.
 */
function isField(value: unknown, rootable = false): boolean {
  if (typeof value !== "string") return false;
  const keys = fromJSONDot(value);
  if (keys === null) return false;
  if (keys[0] === "body") return true;
  if (keys[0] === "attributes" || keys[0] === "resource") return rootable || keys.length > 1;
  return false;
}

/** A field with a key under its root (flatten's `Field.Parent()`, transformer/flatten/transformer.go:35-58). */
function isSubField(value: unknown): boolean {
  return isField(value) && (fromJSONDot(value as string)?.length ?? 0) > 1;
}

// ── The keys each operator decodes (mapstructure tags) ──

/** helper/operator.go:24-25 (`id`, `type`). */
const BASIC = ["id", "type"];
/** helper/writer.go:26-27 (`output`), helper/transformer.go:30-34 (`on_error`, `if`). */
const TRANSFORMER = [...BASIC, "output", "on_error", "if"];
/** helper/parser.go:31-41. */
const PARSER = [...TRANSFORMER, "parse_from", "parse_to", "body", "timestamp", "severity", "trace", "scope_name"];

type Seed = Record<string, unknown>;

interface Row {
  /** The collector's `operatorType` constant: where it is. */
  typeSource: string;
  /** The keys the operator decodes, and where its config says so. */
  keys: readonly string[];
  keysSource: string;
  /** Each rule its Build applies to the seed: [what, source, holds]. */
  rules: readonly [string, string, (seed: Seed) => boolean][];
}

/** helper/parser.go:34-35, 44-52: `parse_from` a field (default body), `parse_to` rootable (default attributes). */
const PARSER_RULES: Row["rules"] = [
  ["parse_from is a field", "helper/parser.go:34; entry/field.go:111-133", (s) => s.parse_from === undefined || isField(s.parse_from)],
  ["parse_to is a rootable field", "helper/parser.go:35; entry/field.go:52-64", (s) => s.parse_to === undefined || isField(s.parse_to, true)],
  ["no parse_to: body beside body", "helper/parser.go:50-52", (s) => !(s.body !== undefined && s.parse_to === "body")],
];

/** helper/transformer.go:43-51: `on_error` one of four, unset `send` (`:25`). */
const ON_ERROR: Row["rules"][number] = [
  "on_error is unset or one of send, send_quiet, drop, drop_quiet",
  "helper/transformer.go:25, 43-51",
  (s) => s.on_error === undefined || ["send", "send_quiet", "drop", "drop_quiet"].includes(s.on_error as string),
];

const EPOCH_LAYOUTS = ["s", "ms", "us", "ns", "s.ms", "s.us", "s.ns"];

const ROWS: Record<OperatorType, Row> = {
  json_parser: {
    typeSource: "parser/jsonparser/config.go:13",
    keys: [...PARSER, "parse_ints"],
    keysSource: "parser/jsonparser/config.go:32-36",
    rules: PARSER_RULES,
  },
  regex_parser: {
    typeSource: "parser/regex/config.go:19",
    keys: [...PARSER, "regex", "cache"],
    keysSource: "parser/regex/config.go:38-46",
    rules: [
      ...PARSER_RULES,
      ["regex is set", "parser/regex/config.go:55-57", (s) => typeof s.regex === "string" && s.regex !== ""],
      [
        "regex compiles with a named group",
        "parser/regex/config.go:59-75",
        (s) => new RegExp((s.regex as string).replace(/\(\?P</g, "(?<")).source !== "" && /\(\?P<\w+>/.test(s.regex as string),
      ],
    ],
  },
  csv_parser: {
    typeSource: "parser/csv/config.go:17",
    keys: [...PARSER, "header", "header_delimiter", "header_attribute", "delimiter", "lazy_quotes", "ignore_quotes"],
    keysSource: "parser/csv/config.go:36-45",
    rules: [
      ...PARSER_RULES,
      ["not both lazy and ignore quotes", "parser/csv/config.go:62-64", (s) => !(s.lazy_quotes === true && s.ignore_quotes === true)],
      ["the delimiter is one character (default ,)", "parser/csv/config.go:54-56, 66-68", (s) => [...((s.delimiter as string | undefined) ?? ",")].length === 1],
      [
        "exactly one of header and header_attribute",
        "parser/csv/config.go:74-80",
        (s) => (typeof s.header === "string" && s.header !== "") !== (typeof s.header_attribute === "string" && s.header_attribute !== ""),
      ],
      [
        "the header holds the delimiter",
        "parser/csv/config.go:58-60, 82-84",
        (s) => s.header === undefined || (s.header as string).includes((s.header_delimiter as string | undefined) ?? (s.delimiter as string | undefined) ?? ","),
      ],
    ],
  },
  key_value_parser: {
    typeSource: "parser/keyvalue/config.go:15",
    keys: [...PARSER, "delimiter", "pair_delimiter"],
    keysSource: "parser/keyvalue/config.go:35-40",
    rules: [
      ...PARSER_RULES,
      ["delimiter is set", "parser/keyvalue/config.go:49-51", (s) => typeof s.delimiter === "string" && s.delimiter !== ""],
      [
        "delimiter and pair delimiter differ (pair default a space)",
        "parser/keyvalue/config.go:53-60",
        (s) => s.delimiter !== (((s.pair_delimiter as string | undefined) ?? "") || " "),
      ],
    ],
  },
  syslog_parser: {
    typeSource: "parser/syslog/config.go:20",
    keys: [...PARSER, "protocol", "location", "enable_octet_counting", "allow_skip_pri_header", "non_transparent_framing_trailer", "max_octets"],
    keysSource: "parser/syslog/config.go:47-60",
    rules: [
      ...PARSER_RULES,
      ["protocol is rfc5424, rfc3164 or none", "parser/syslog/config.go:81-85", (s) => ["rfc5424", "rfc3164", "none"].includes(String(s.protocol).toLowerCase())],
      ["no framing trailer", "parser/syslog/config.go:86-96", (s) => s.non_transparent_framing_trailer === undefined],
    ],
  },
  json_array_parser: {
    typeSource: "parser/jsonarray/config.go:18",
    keys: [...PARSER, "header"],
    keysSource: "parser/jsonarray/config.go:39-42",
    rules: [
      ...PARSER_RULES,
      // The gate `logs.jsonParserArray` is Beta, on by default (internal/metadata/generated_feature_gates.go:17-23; config.go:46-48).
      [
        "without a header, parse_to is body or a field under a root (an array can't be the attributes' root)",
        "docs/operators/json_array_parser.md:50-52",
        (s) => s.header !== undefined || s.parse_to === "body" || (fromJSONDot(s.parse_to as string)?.length ?? 0) > 1,
      ],
    ],
  },
  container: {
    typeSource: "parser/container/config.go:22",
    keys: [...PARSER, "format", "add_metadata_from_filepath", "max_log_size"],
    keysSource: "parser/container/config.go:48-54",
    rules: [
      ...PARSER_RULES,
      ["format is unset or docker, crio, containerd", "parser/container/config.go:63-73", (s) => s.format === undefined || ["docker", "crio", "containerd"].includes(s.format as string)],
      ["add_metadata_from_filepath is a boolean", "parser/container/config.go:52", (s) => typeof s.add_metadata_from_filepath === "boolean"],
    ],
  },
  severity_parser: {
    typeSource: "parser/severity/config.go:13",
    keys: [...TRANSFORMER, "parse_from", "preset", "mapping", "overwrite_text"],
    keysSource: "parser/severity/config.go:33-36; helper/severity_builder.go:114-119",
    rules: [["parse_from is a field, and set", "helper/severity_builder.go:149-151; entry/field.go:111-133", (s) => isField(s.parse_from)]],
  },
  time_parser: {
    typeSource: "parser/timeparser/config.go:14",
    keys: [...TRANSFORMER, "parse_from", "layout", "layout_type", "location", "time_zone_locations"],
    keysSource: "parser/timeparser/config.go:34-37; helper/time.go:44-49",
    rules: [
      ["parse_from is a field, and set", "helper/time.go:75-77", (s) => isField(s.parse_from)],
      ["layout is set", "helper/time.go:79-81", (s) => typeof s.layout === "string" && s.layout !== ""],
      ["layout_type is strptime, gotime or epoch (unset strptime)", "helper/time.go:62-64, 85-112", (s) => ["strptime", "gotime", "epoch", undefined].includes(s.layout_type as string)],
      ["an epoch layout is one of the seven", "helper/time.go:98-106", (s) => s.layout_type !== "epoch" || EPOCH_LAYOUTS.includes(s.layout as string)],
    ],
  },
  trace_parser: {
    typeSource: "parser/trace/config.go:13",
    keys: [...TRANSFORMER, "trace_id", "span_id", "trace_flags"],
    keysSource: "parser/trace/config.go:33-36; helper/trace.go:33-57",
    rules: [
      [
        "each parse_from is a field",
        "helper/trace.go:41-57",
        (s) =>
          ["trace_id", "span_id", "trace_flags"].every((key) => {
            const block = s[key] as Seed | undefined;
            return block === undefined || isField(block.parse_from);
          }),
      ],
    ],
  },
  uri_parser: {
    typeSource: "parser/uri/config.go:13",
    keys: PARSER,
    keysSource: "parser/uri/config.go:32-34",
    rules: PARSER_RULES,
  },
  scope_name_parser: {
    typeSource: "parser/scope/config.go:13",
    keys: [...TRANSFORMER, "parse_from"],
    keysSource: "parser/scope/config.go:33-36; helper/scope_name.go:14-16",
    rules: [["parse_from is a field", "helper/scope_name.go:15; entry/field.go:111-133", (s) => isField(s.parse_from)]],
  },
  add: {
    typeSource: "transformer/add/config.go:17",
    keys: [...TRANSFORMER, "field", "value"],
    keysSource: "transformer/add/config.go:36-40",
    rules: [["field is a field", "transformer/add/config.go:38", (s) => isField(s.field)]],
  },
  copy: {
    typeSource: "transformer/copy/config.go:16",
    keys: [...TRANSFORMER, "from", "to"],
    keysSource: "transformer/copy/config.go:40-44",
    rules: [["from and to are fields, and set", "transformer/copy/config.go:55-65", (s) => isField(s.from) && isField(s.to)]],
  },
  move: {
    typeSource: "transformer/move/config.go:16",
    keys: [...TRANSFORMER, "from", "to"],
    keysSource: "transformer/move/config.go:40-44",
    rules: [["from and to are fields, and set", "transformer/move/config.go:55-65", (s) => isField(s.from) && isField(s.to)]],
  },
  remove: {
    typeSource: "transformer/remove/config.go:15",
    keys: [...TRANSFORMER, "field"],
    keysSource: "transformer/remove/config.go:36-40",
    rules: [["field is a rootable field, and set", "transformer/remove/config.go:39, 49-51", (s) => isField(s.field, true)]],
  },
  retain: {
    typeSource: "transformer/retain/config.go:17",
    keys: [...TRANSFORMER, "fields"],
    keysSource: "transformer/retain/config.go:36-39",
    rules: [
      [
        "fields is a list of fields, not empty",
        "transformer/retain/config.go:38, 47-49",
        (s) => Array.isArray(s.fields) && s.fields.length > 0 && s.fields.every((field) => isField(field)),
      ],
    ],
  },
  flatten: {
    typeSource: "transformer/flatten/config.go:16",
    keys: [...TRANSFORMER, "field"],
    keysSource: "transformer/flatten/config.go:35-38",
    rules: [["field is a field under a root", "transformer/flatten/config.go:47-68; transformer.go:35-58", (s) => isSubField(s.field)]],
  },
  unquote: {
    typeSource: "transformer/unquote/config.go:14",
    keys: [...TRANSFORMER, "field"],
    keysSource: "transformer/unquote/config.go:33-36",
    rules: [["field is a field", "transformer/unquote/config.go:35", (s) => isField(s.field)]],
  },
  regex_replace: {
    typeSource: "transformer/regexreplace/config.go:18",
    keys: [...TRANSFORMER, "regex_name", "regex", "replace_with", "field"],
    keysSource: "transformer/regexreplace/config.go:40-46",
    rules: [
      ["field is a field", "transformer/regexreplace/config.go:45", (s) => isField(s.field)],
      [
        "exactly one of regex and regex_name",
        "transformer/regexreplace/config.go:66-68",
        (s) => (typeof s.regex === "string" && s.regex !== "") !== (typeof s.regex_name === "string" && s.regex_name !== ""),
      ],
      ["regex_name is a known one", "transformer/regexreplace/config.go:48-57", (s) => s.regex_name === undefined || s.regex_name === "ansi_control_sequences"],
    ],
  },
  sanitize_utf8: {
    typeSource: "transformer/sanitizeutf8/transformer.go:20",
    keys: [...TRANSFORMER, "field"],
    keysSource: "transformer/sanitizeutf8/transformer.go:42-45",
    rules: [["field is a field", "transformer/sanitizeutf8/transformer.go:44", (s) => isField(s.field)]],
  },
  assign_keys: {
    typeSource: "transformer/assignkeys/config.go:17",
    keys: [...TRANSFORMER, "field", "keys"],
    keysSource: "transformer/assignkeys/config.go:38-42",
    rules: [
      // The gate `logs.assignKeys` is Beta, on by default (internal/metadata/generated_feature_gates.go:9-15).
      ["keys is not empty", "transformer/assignkeys/config.go:51-53", (s) => Array.isArray(s.keys) && s.keys.length > 0],
      ["field is a field", "transformer/assignkeys/config.go:55-79", (s) => isField(s.field)],
    ],
  },
  filter: {
    typeSource: "transformer/filter/config.go:18",
    keys: [...TRANSFORMER, "expr", "drop_ratio"],
    keysSource: "transformer/filter/config.go:43-47",
    rules: [
      ["expr is set", "transformer/filter/config.go:56-59", (s) => typeof s.expr === "string" && s.expr !== ""],
      ["drop_ratio is within 0..1 (default 1)", "transformer/filter/config.go:35-40, 61-63", (s) => ((s.drop_ratio as number | undefined) ?? 1) >= 0 && ((s.drop_ratio as number | undefined) ?? 1) <= 1],
    ],
  },
  router: {
    typeSource: "transformer/router/config.go:15",
    keys: [...BASIC, "routes", "default"],
    keysSource: "transformer/router/config.go:34-38",
    rules: [
      [
        "each route has an expr and only a route's keys; an output isn't required",
        "transformer/router/config.go:41-45, 63-80",
        (s) =>
          Array.isArray(s.routes) &&
          (s.routes as Seed[]).every(
            (route) => typeof route.expr === "string" && route.expr !== "" && Object.keys(route).every((key) => ["expr", "output", "attributes"].includes(key)),
          ),
      ],
      ["no route names an output no operator has", "pipeline/directed.go:151-152", (s) => (s.routes as Seed[]).every((route) => route.output === undefined)],
    ],
  },
  recombine: {
    typeSource: "transformer/recombine/config.go:23",
    keys: [
      ...TRANSFORMER,
      "is_first_entry",
      "is_last_entry",
      "max_batch_size",
      "max_unmatched_batch_size",
      "combine_field",
      "combine_with",
      "source_identifier",
      "overwrite_with",
      "force_flush_period",
      "max_sources",
      "max_log_size",
    ],
    keysSource: "transformer/recombine/config.go:51-64",
    rules: [
      [
        "exactly one of is_first_entry and is_last_entry",
        "transformer/recombine/config.go:73-79",
        (s) => (typeof s.is_first_entry === "string" && s.is_first_entry !== "") !== (typeof s.is_last_entry === "string" && s.is_last_entry !== ""),
      ],
      ["combine_field is a field, and set", "transformer/recombine/config.go:97-99", (s) => isField(s.combine_field)],
      ["overwrite_with is unset, newest or oldest", "transformer/recombine/config.go:101-109", (s) => [undefined, "newest", "oldest"].includes(s.overwrite_with as string)],
      // Unset, combine_with is the collector's newline (config.go:24, 43); the seed leaves it so.
      ["combine_with is left to its default", "transformer/recombine/config.go:24, 43", (s) => s.combine_with === undefined],
    ],
  },
  noop: {
    typeSource: "transformer/noop/config.go:13",
    keys: TRANSFORMER,
    keysSource: "transformer/noop/config.go:32-34",
    rules: [],
  },
};

describe("the 26 operator types", () => {
  it("are in four categories: 7 format parsers, 5 field parsers, 10 transforms, 4 flow", () => {
    expect(OPERATORS).toHaveLength(26);
    expect(new Set(OPERATORS.map((op) => op.type)).size).toBe(26);
    const count = (category: string) => OPERATORS.filter((op) => op.category === category).length;
    expect([count("parser"), count("field_parser"), count("transform"), count("flow")]).toEqual([7, 5, 10, 4]);
    expect(OPERATOR_CATEGORIES.map((c) => c.label)).toEqual(["Format Parsers", "Field Parsers", "Transform", "Flow Control"]);
  });

  it("each has a label, a description and an icon of its own kind", () => {
    for (const op of OPERATORS) {
      expect(op.label).not.toBe("");
      expect(op.description).not.toBe("");
      expect(op.icon).toBeTruthy();
    }
    // The selector shows these six with their own icons, as the card does.
    const icons = (types: string[]) => types.map((type) => operatorMeta(type)!.icon.displayName);
    expect(icons(["json_array_parser", "container", "noop", "regex_replace", "sanitize_utf8", "assign_keys"])).toEqual([
      "List",
      "Container",
      "Circle",
      "Replace",
      "ShieldCheck",
      "Key",
    ]);
  });

  it("a type outside the 26 has no entry", () => {
    expect(operatorMeta("drop_output")).toBeUndefined();
    expect(operatorMeta("JSON_PARSER")).toBeUndefined();
    expect(operatorMeta(7)).toBeUndefined();
  });
});

describe("every seed builds: its keys are its operator's, and each Build rule holds", () => {
  it.each(OPERATORS.map((op) => [op.type, ROWS[op.type]] as const))("%s", (type, row) => {
    const seed = operatorSeed(type);
    // The type is the collector's operatorType constant (row.typeSource).
    expect(seed.type, row.typeSource).toBe(type);
    for (const key of Object.keys(seed)) expect(row.keys, `${key} (${row.keysSource})`).toContain(key);
    for (const [what, source, holds] of [ON_ERROR, ...row.rules]) expect(holds(seed), `${what} (${source})`).toBe(true);
  });

  it("the table covers the 26 types and nothing else", () => {
    expect(Object.keys(ROWS).sort()).toEqual(OPERATORS.map((op) => op.type).sort());
  });

  it("the rules catch seeds the collector refuses", () => {
    const fails = (type: OperatorType, seed: Seed) => {
      const rules = [ON_ERROR, ...ROWS[type].rules];
      return rules.filter(([, , holds]) => !holds(seed)).map(([what]) => what);
    };
    // types/otel.ts:858, 860, 861-866, 879-885, 869-874.
    expect(fails("flatten", { type: "flatten", field: "attributes" })).toEqual(["field is a field under a root"]);
    expect(fails("router", { type: "router", routes: [{ output: "", expr: "true" }] })).toEqual(["no route names an output no operator has"]);
    expect(fails("recombine", { type: "recombine", is_first_entry: "x", combine_with: "\\n" })).toEqual([
      "combine_field is a field, and set",
      "combine_with is left to its default",
    ]);
    expect(fails("regex_replace", { type: "regex_replace", field: "body", regex: "", replace_with: "" })).toEqual(["exactly one of regex and regex_name"]);
    expect(fails("json_array_parser", { type: "json_array_parser", parse_from: "body", parse_to: "attributes" })).toEqual([
      "without a header, parse_to is body or a field under a root (an array can't be the attributes' root)",
    ]);
    expect(fails("add", { type: "add", field: "attributes", on_error: "silent" })).toEqual([
      "on_error is unset or one of send, send_quiet, drop, drop_quiet",
      "field is a field",
    ]);
  });

  it("the field syntax: prefixes, bracketed keys, rootable roots (entry/field.go:111-226)", () => {
    expect(isField("body")).toBe(true);
    expect(isField('attributes["log.file.path"]')).toBe(true);
    expect(isField("resource.host.name")).toBe(true);
    expect(isField("attributes")).toBe(false);
    expect(isField("attributes", true)).toBe(true);
    expect(isField("message")).toBe(false);
    expect(isField('attributes["x')).toBe(false);
    expect(fromJSONDot('attributes.["x"]')).toEqual(["attributes", "", "x"]);
  });
});

describe("the time layouts", () => {
  it("epoch offers the collector's s and s.us, labeled as the two epoch presets (helper/time.go:98-106)", () => {
    expect(LAYOUT_PRESETS.epoch.map((p) => [p.value, p.label])).toEqual([
      ["s", "Unix epoch (seconds)"],
      ["s.us", "Unix epoch with fractional"],
    ]);
    for (const preset of LAYOUT_PRESETS.epoch) expect(EPOCH_LAYOUTS).toContain(preset.value);
  });

  it("strptime's first preset is labeled with what it writes; Go time offers Go layouts", () => {
    expect(LAYOUT_PRESETS.strptime[0]).toMatchObject({ value: "%Y-%m-%d %H:%M:%S", label: "%Y-%m-%d %H:%M:%S" });
    expect(LAYOUT_PRESETS.gotime.map((p) => p.value)).toEqual([
      "2006-01-02 15:04:05",
      "2006-01-02T15:04:05Z0700",
      "2006-01-02T15:04:05Z",
      "2006-01-02T15:04:05.999999Z0700",
      "02/Jan/2006:15:04:05 -0700",
      "Jan 02 15:04:05",
    ]);
    // The same times, labeled alike.
    expect(LAYOUT_PRESETS.gotime.slice(1).map((p) => p.label)).toEqual(LAYOUT_PRESETS.strptime.slice(1).map((p) => p.label));
    for (const preset of LAYOUT_PRESETS.gotime) expect(preset.value).not.toContain("%");
  });

  it("a switch sets the new type's first preset over another type's preset; a custom layout, the type's own, or none is kept", () => {
    expect(layoutAfterSwitch("%Y-%m-%d %H:%M:%S", "epoch")).toBe("s");
    expect(layoutAfterSwitch("s.us", "gotime")).toBe("2006-01-02 15:04:05");
    expect(layoutAfterSwitch("2006-01-02T15:04:05Z", "strptime")).toBe("%Y-%m-%d %H:%M:%S");
    expect(layoutAfterSwitch("%d.%m.%Y", "epoch")).toBeUndefined();
    expect(layoutAfterSwitch("%b %d %H:%M:%S", "strptime")).toBeUndefined();
    expect(layoutAfterSwitch(undefined, "epoch")).toBeUndefined();
    // The seven epoch layouts are epoch's, not only the two presets (helper/time.go:100).
    expect(presetTypeOf("ms")).toBe("epoch");
    expect(layoutAfterSwitch("s.ns", "strptime")).toBe("%Y-%m-%d %H:%M:%S");
    expect(layoutSetMessage("epoch")).toBe("Layout set to the first epoch preset.");
  });
});
