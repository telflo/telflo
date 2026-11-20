import {
  AlertTriangle,
  ArrowRight,
  Braces,
  Circle,
  Clock,
  Combine,
  Container,
  Copy,
  Equal,
  FileText,
  Filter,
  FilterX,
  GitBranch,
  GitFork,
  Key,
  Link,
  List,
  Minimize2,
  Plus,
  Quote,
  Replace,
  ShieldCheck,
  Table,
  Tag,
  Trash2,
  type LucideIcon,
} from "lucide-react";

/*
 * The stanza operators a filelog, journald or syslog receiver's `operators`
 * list takes: their labels, descriptions, categories and icons, and the
 * seed Add Operator appends, as one table. The card and the selector both
 * read this one.
 *
 * There are 26: the collector's 12 parsers and 14 transformers at contrib
 * v0.162.0, each `type` the collector's `operatorType`
 * (the seeds' test cites each).
 *
 * - Icons are lucide components, so the selector shows every one,
 *   including `List`, `Container`, `Circle`, `Replace`, `ShieldCheck`
 *   and `Key`, never a `FileText` fallback. The regex parser's icon is
 *   `FileText`.
 * - The seeds are ones the collector builds and reads as meant: router's
 *   route has no `output` (not `output: ""`, an output no operator has,
 *   `pipeline/directed.go:151-152`; a route without one builds,
 *   `router/config.go:48-86`, and drops what it matches until one is typed);
 *   regex_replace seeds `regex_name: ansi_control_sequences` (`regex: ""` is
 *   refused, `regexreplace/config.go:66-68`); flatten seeds
 *   `field: body.nested` (a bare `attributes` is refused,
 *   `entry/field.go:119-121`); recombine seeds `combine_field: body`
 *   (required, `recombine/config.go:97-99`; written, not only shown) and no
 *   `combine_with` (the collector's default is a newline,
 *   `config.go:24, 43`; not the two characters `\n`); json_array_parser
 *   seeds `parse_to: body` (an array can't be the attributes' root without a
 *   header, `json_array_parser.md`).
 * - The time layouts' presets (`LAYOUT_PRESETS`) are per layout type: the
 *   strptime ones, the first's label saying what it writes (not the Go
 *   notation); Go layouts under Go time (never strptime strings there);
 *   epoch's `s` and `s.us` (`%s` and `%s.%f` are refused,
 *   `helper/time.go:98-106`).
 */

export type OperatorCategory = "parser" | "field_parser" | "transform" | "flow";

/** One of the 26 operator types a receiver's list takes. */
export type OperatorType =
  | "json_parser"
  | "regex_parser"
  | "csv_parser"
  | "key_value_parser"
  | "syslog_parser"
  | "json_array_parser"
  | "container"
  | "severity_parser"
  | "time_parser"
  | "trace_parser"
  | "uri_parser"
  | "scope_name_parser"
  | "add"
  | "copy"
  | "move"
  | "remove"
  | "retain"
  | "flatten"
  | "unquote"
  | "regex_replace"
  | "sanitize_utf8"
  | "assign_keys"
  | "filter"
  | "router"
  | "recombine"
  | "noop";

export interface OperatorMeta {
  type: OperatorType;
  label: string;
  description: string;
  category: OperatorCategory;
  icon: LucideIcon;
}

/** The operators, in the selector's order. */
export const OPERATORS: readonly OperatorMeta[] = [
  // Parsers
  { type: "json_parser", label: "JSON Parser", description: "Parse JSON structured data", category: "parser", icon: Braces },
  { type: "regex_parser", label: "Regex Parser", description: "Extract fields using regex patterns", category: "parser", icon: FileText },
  { type: "csv_parser", label: "CSV Parser", description: "Parse comma-separated values", category: "parser", icon: Table },
  { type: "key_value_parser", label: "Key-Value Parser", description: "Parse key=value pairs", category: "parser", icon: Equal },
  { type: "syslog_parser", label: "Syslog Parser", description: "Parse syslog formatted messages", category: "parser", icon: FileText },
  { type: "json_array_parser", label: "JSON Array Parser", description: "Parse JSON arrays into lists", category: "parser", icon: List },
  { type: "container", label: "Container Parser", description: "Parse Docker/CRI-O/Containerd logs", category: "parser", icon: Container },
  // Field parsers
  { type: "severity_parser", label: "Severity Parser", description: "Set severity from an extracted field", category: "field_parser", icon: AlertTriangle },
  { type: "time_parser", label: "Time Parser", description: "Set the timestamp from an extracted field", category: "field_parser", icon: Clock },
  {
    type: "trace_parser",
    label: "Trace Parser",
    description: "Set trace context from extracted trace/span ID fields",
    category: "field_parser",
    icon: GitBranch,
  },
  { type: "uri_parser", label: "URI Parser", description: "Split a URL field into components", category: "field_parser", icon: Link },
  {
    type: "scope_name_parser",
    label: "Scope Name Parser",
    description: "Set instrumentation scope name from a field",
    category: "field_parser",
    icon: Tag,
  },
  // Transform
  { type: "add", label: "Add Field", description: "Add a new field with a value", category: "transform", icon: Plus },
  { type: "copy", label: "Copy Field", description: "Copy a field to another location", category: "transform", icon: Copy },
  { type: "move", label: "Move Field", description: "Move a field to another location", category: "transform", icon: ArrowRight },
  { type: "remove", label: "Remove Field", description: "Remove a field", category: "transform", icon: Trash2 },
  { type: "retain", label: "Retain Fields", description: "Keep only specified fields", category: "transform", icon: Filter },
  { type: "flatten", label: "Flatten", description: "Flatten nested structures", category: "transform", icon: Minimize2 },
  { type: "unquote", label: "Unquote", description: "Remove quotes from string values", category: "transform", icon: Quote },
  { type: "regex_replace", label: "Regex Replace", description: "Replace text using regex patterns", category: "transform", icon: Replace },
  { type: "sanitize_utf8", label: "Sanitize UTF-8", description: "Clean invalid UTF-8 characters", category: "transform", icon: ShieldCheck },
  { type: "assign_keys", label: "Assign Keys", description: "Transform lists into maps with keys", category: "transform", icon: Key },
  // Flow Control
  { type: "filter", label: "Filter", description: "Filter entries based on conditions", category: "flow", icon: FilterX },
  { type: "router", label: "Router", description: "Route entries to different operators", category: "flow", icon: GitFork },
  { type: "recombine", label: "Recombine", description: "Combine multiline log entries", category: "flow", icon: Combine },
  { type: "noop", label: "No-Op", description: "Pass through without changes", category: "flow", icon: Circle },
];

const BY_TYPE: ReadonlyMap<string, OperatorMeta> = new Map(OPERATORS.map((meta) => [meta.type, meta]));

/** The catalog's entry for a type as written, or undefined for anything that isn't one of the 26 (a typo, `drop_output`). */
export function operatorMeta(type: unknown): OperatorMeta | undefined {
  return typeof type === "string" ? BY_TYPE.get(type) : undefined;
}

/** The Add Operator dialog's groups, with their labels and copy. */
export const OPERATOR_CATEGORIES: readonly { category: OperatorCategory; label: string; description: string }[] = [
  {
    category: "parser",
    label: "Format Parsers",
    description: "Interpret the raw log line, usually first. Match it to your log file's format.",
  },
  {
    category: "field_parser",
    label: "Field Parsers",
    description:
      "Promote an extracted field into the record's timestamp, severity, trace context, or scope. Needs an upstream parser to create the field.",
  },
  { category: "transform", label: "Transform", description: "Modify field values." },
  { category: "flow", label: "Flow Control", description: "Control log routing and combination." },
];

/** What Add Operator appends for `type`. */
export function operatorSeed(type: OperatorType): Record<string, unknown> {
  switch (type) {
    case "json_parser":
      return { type, parse_from: "body", parse_to: "attributes" };
    case "regex_parser":
      return { type, regex: "^(?P<message>.*)$", parse_from: "body", parse_to: "attributes" };
    case "csv_parser":
      return { type, header: "field1,field2,field3", parse_from: "body", parse_to: "attributes" };
    case "key_value_parser":
      return { type, delimiter: "=", pair_delimiter: " ", parse_from: "body", parse_to: "attributes" };
    case "syslog_parser":
      return { type, protocol: "rfc5424" };
    case "severity_parser":
      return { type, parse_from: "attributes.level", preset: "default" };
    case "time_parser":
      return { type, parse_from: "attributes.timestamp", layout: "%Y-%m-%d %H:%M:%S", layout_type: "strptime" };
    case "trace_parser":
      return { type, trace_id: { parse_from: "attributes.trace_id" }, span_id: { parse_from: "attributes.span_id" } };
    case "uri_parser":
      return { type, parse_from: "body", parse_to: "attributes" };
    case "scope_name_parser":
      return { type, parse_from: "attributes.logger" };
    case "add":
      return { type, field: "attributes.new_field", value: "" };
    case "copy":
      return { type, from: "body", to: "attributes.body_copy" };
    case "move":
      return { type, from: "attributes.old_field", to: "attributes.new_field" };
    case "remove":
      return { type, field: "attributes.field_to_remove" };
    case "retain":
      return { type, fields: ["body", "attributes.important"] };
    case "filter":
      return { type, expr: "body matches 'error'" };
    case "flatten":
      // A sub-field; a bare `attributes` is refused.
      return { type, field: "body.nested" };
    case "router":
      // No `output: ""`.
      return { type, routes: [{ expr: "true" }] };
    case "recombine":
      // `combine_field` written; `combine_with` left to its default, a newline.
      return { type, is_first_entry: "body matches '^\\\\d{4}-\\\\d{2}-\\\\d{2}'", combine_field: "body" };
    case "unquote":
      return { type, field: "body" };
    case "json_array_parser":
      // `parse_to: body`; `attributes` without a header fails on every entry.
      return { type, parse_from: "body", parse_to: "body" };
    case "container":
      return { type, add_metadata_from_filepath: true };
    case "noop":
      return { type };
    case "regex_replace":
      // The well-known pattern; `regex: ""` is refused.
      return { type, field: "body", regex_name: "ansi_control_sequences", replace_with: "" };
    case "sanitize_utf8":
      return { type, field: "body" };
    case "assign_keys":
      return { type, field: "body", keys: ["key1", "key2"] };
  }
}

// ── Time layouts ──

export type LayoutType = "strptime" | "gotime" | "epoch";

export interface LayoutPreset {
  value: string;
  label: string;
  /**
   * In the timestamp section's list: the time parser's list has one
   * more.
   */
  inSection: boolean;
}

/**
 * The layouts each layout type offers, the type's first preset first. The
 * Go ones are the strptime ones' times in Go's notation
 * (`internal/coreinternal/timeutils/internal/ctimefmt/ctimefmt.go:30-72`),
 * with the same labels; epoch's are the collector's own
 * (`helper/time.go:98-106`), labelled as two epoch presets.
 */
export const LAYOUT_PRESETS: Readonly<Record<LayoutType, readonly LayoutPreset[]>> = {
  strptime: [
    { value: "%Y-%m-%d %H:%M:%S", label: "%Y-%m-%d %H:%M:%S", inSection: true },
    { value: "%Y-%m-%dT%H:%M:%S%z", label: "ISO 8601 with TZ", inSection: true },
    { value: "%Y-%m-%dT%H:%M:%SZ", label: "ISO 8601 UTC", inSection: true },
    { value: "%Y-%m-%dT%H:%M:%S.%f%z", label: "ISO 8601 with microseconds", inSection: false },
    { value: "%d/%b/%Y:%H:%M:%S %z", label: "Common Log Format", inSection: true },
    { value: "%b %d %H:%M:%S", label: "Syslog (RFC 3164)", inSection: true },
  ],
  gotime: [
    { value: "2006-01-02 15:04:05", label: "2006-01-02 15:04:05", inSection: true },
    { value: "2006-01-02T15:04:05Z0700", label: "ISO 8601 with TZ", inSection: true },
    { value: "2006-01-02T15:04:05Z", label: "ISO 8601 UTC", inSection: true },
    { value: "2006-01-02T15:04:05.999999Z0700", label: "ISO 8601 with microseconds", inSection: false },
    { value: "02/Jan/2006:15:04:05 -0700", label: "Common Log Format", inSection: true },
    { value: "Jan 02 15:04:05", label: "Syslog (RFC 3164)", inSection: true },
  ],
  epoch: [
    { value: "s", label: "Unix epoch (seconds)", inSection: true },
    { value: "s.us", label: "Unix epoch with fractional", inSection: true },
  ],
};

export const LAYOUT_TYPES: readonly LayoutType[] = ["strptime", "gotime", "epoch"];

/**
 * The collector's seven epoch layouts (`helper/time.go:99-100`), of which
 * the presets offer two: each counts as epoch's in a Layout Type switch,
 * so switching away from `ms` sets the new type's first preset.
 */
export const EPOCH_LAYOUTS: readonly string[] = ["s", "ms", "us", "ns", "s.ms", "s.us", "s.ns"];

/** The layout type whose preset `layout` is, if it is one (any of the seven epoch layouts is epoch's). */
export function presetTypeOf(layout: string): LayoutType | undefined {
  if (EPOCH_LAYOUTS.includes(layout)) return "epoch";
  return LAYOUT_TYPES.find((type) => LAYOUT_PRESETS[type].some((preset) => preset.value === layout));
}

/** The alert when a Layout Type switch set the layout. */
export function layoutSetMessage(type: LayoutType): string {
  return `Layout set to the first ${type} preset.`;
}

/**
 * What a switch of Layout Type to `to` does to `layout`: a preset of another
 * type becomes `to`'s first preset; a custom layout, one of `to`'s own, or
 * none is kept (a custom layout is typed text). Returns the new layout, or
 * undefined to keep it.
 */
export function layoutAfterSwitch(layout: string | undefined, to: LayoutType): string | undefined {
  if (layout === undefined) return undefined;
  const from = presetTypeOf(layout);
  return from !== undefined && from !== to ? LAYOUT_PRESETS[to][0]!.value : undefined;
}
