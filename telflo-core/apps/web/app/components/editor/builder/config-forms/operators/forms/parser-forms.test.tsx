import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "../../form-context.js";
import { layoutAfterSwitch, operatorSeed, type OperatorType } from "../operator-catalog.js";
import { OperatorPipeline } from "../OperatorPipeline.js";
import { OPERATOR_FORMS } from "./index.js";
import { REMOVED_PARSER_TRAILER, REMOVED_TRAILER_FOR_OCTETS } from "./SyslogParserForm.js";
import { SPAN_ID_OFF_HINT, TRACE_ID_OFF_HINT } from "./TraceParserForm.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The parser operator forms (D9c Task 6): the 12 parser forms in
 * the operator cards, over the form contract. Each field is driven as a
 * person would (typing, clicking, picking) on the logs corpus' parsers
 * (`filelog/parsers`: comments, flow items, quoted scalars; the corpus
 * around them has an anchor and merges and `0750`), LF and CRLF, and
 * writes only its key: the text changes in that key's lines only, as one
 * undo entry, and parses to the value (decision 2). The fixes each have a
 * test that fails if the bug returns: csv's exclusions and
 * Header Attribute as a name (decisions 4 and 7); container's default and
 * copy (decision 4); severity_parser writing nothing on render (decision
 * 8; Preflight ruling 26); time_parser's presets per layout type and the
 * layout switch (decisions 3 and 7; Preflight ruling 14); trace_parser's
 * hints (decision 4); syslog_parser's Protocol with `none`, unset shown
 * unset, and no timestamp section (decisions 4 and 6); uri_parser without
 * `fragment` (decision 4); json_array_parser's required Parse To.
 *
 * Collector claims cite contrib v0.162.0 (`pkg/stanza/`).
 */

const CORPUS = corpusText("forms-logs-operators.yaml");
const PARSERS = "receivers.filelog/parsers";

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The info toasts shown so far: decision 7's adjustments toast their messages (Ruling 87). */
const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderParsers(text = CORPUS) {
  openText(text);
  const user = userEvent.setup();
  render(
    <ComponentForm nodeId={componentNamed(PARSERS).id}>
      <OperatorPipeline path={["operators"]} source="file" />
    </ComponentForm>,
  );
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
type Value = Record<string, unknown>;
const operatorsOf = (written: string): Value[] =>
  (parseYaml(written, { merge: true }) as { receivers: Record<string, { operators: Value[] }> }).receivers["filelog/parsers"]!.operators;
/** A `<p>` whose whole text is `whole`. */
const hintIn = (container: HTMLElement, whole: string) =>
  within(container).queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
/** The card whose field `id` is in it. */
const cardOf = (id: string) => byId(id).closest(".rounded-lg.bg-card") as HTMLElement;

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.type(input, typed);
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** The corpus' parsers, by card index. */
const JSON_P = 0;
const REGEX = 1;
const CSV = 2;
const KV = 3;
const SYSLOG = 4;
const JSON_ARRAY = 5;
const CONTAINER = 6;
const SEVERITY = 7;
const TIME = 8;
const TRACE = 9;
const URI = 10;
const SCOPE = 11;

const PARSER_TYPES: readonly OperatorType[] = [
  "json_parser",
  "regex_parser",
  "csv_parser",
  "key_value_parser",
  "syslog_parser",
  "json_array_parser",
  "container",
  "severity_parser",
  "time_parser",
  "trace_parser",
  "uri_parser",
  "scope_name_parser",
];

/** A card's field: `op-<card>-<field>`. */
const field = (card: number, name: string) => byId(`op-${card}-${name}`);

/** The corpus with each parser's operators replaced by `lines` (each an item). */
const withParsers = (lines: readonly string[]) =>
  CORPUS.replace(/( {2}filelog\/parsers:\n.*\n {4}operators:\n)[\s\S]*?(?=exporters:)/, `$1${lines.map((line) => `      - ${line}\n`).join("")}`);

/** The 12 parsers as Add Operator seeds them, as flow items: every field unset but the seed's. */
const SEEDS = withParsers(PARSER_TYPES.map((type) => JSON.stringify(operatorSeed(type))));

// ── Every field writes only its key (decision 2) ──

interface FieldCase {
  name: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** The card's index, and a check of its operator after, as parsed. */
  card: number;
  check: (operator: Value) => void;
  /** A variant of the corpus text (LF), when the case needs one. */
  base?: string;
}

const REGEX_CACHE = "        parse_from: body.message\n        cache:\n          size: 100 # entries\n";
const CSV_LINES = '        header: id,name,msg\n        delimiter: ","\n        lazy_quotes: true # loose quoting\n';
const KV_LINE = '      - {type: key_value_parser, delimiter: ":", pair_delimiter: ";", parse_to: attributes.kv}\n';
const SYSLOG_LINES = [
  "      - type: syslog_parser",
  "        protocol: rfc3164",
  "        location: America/New_York",
  "        timestamp: # kept: the form shows no timestamp section",
  "          parse_from: attributes.ts",
  "          layout_type: gotime",
  "          layout: Jan 02 15:04:05",
  "",
].join("\n");
const JSON_ARRAY_LINES = "        parse_to: body\n        header: a,b,c\n";
const CONTAINER_LINES = "        format: docker\n        add_metadata_from_filepath: false\n        max_log_size: 2MiB\n";
const TRACE_LINES = "        trace_id:\n          parse_from: attributes.trace\n        span_id: {parse_from: attributes.span}\n";
const URI_LINE = "        parse_from: attributes.url\n";
const SCOPE_LINE = "        parse_from: attributes.logger # the logger's name\n";

const CASES: FieldCase[] = [
  // json_parser
  {
    name: "json_parser Parse From: a body suffix",
    edit: (user) => retypeInto(user, field(JSON_P, "json-parse-from-suffix"), "message"),
    from: "        id: json\n        parse_from: body\n",
    to: "        id: json\n        parse_from: body.message\n",
    card: JSON_P,
    check: (op) => expect(op.parse_from).toBe("body.message"),
  },
  {
    name: "json_parser Parse To: resource, a bare root (rootable, helper/parser.go:35)",
    edit: (user) => pickIn(user, field(JSON_P, "json-parse-to"), "resource"),
    from: "        parse_to: attributes\n        parse_ints: false\n",
    to: "        parse_to: resource\n        parse_ints: false\n",
    card: JSON_P,
    check: (op) => expect(op.parse_to).toBe("resource"),
  },
  {
    name: "json_parser Parse integers",
    edit: (user) => user.click(field(JSON_P, "json-parse-ints")),
    from: "        parse_ints: false\n",
    to: "        parse_ints: true\n",
    card: JSON_P,
    check: (op) => expect(op.parse_ints).toBe(true),
  },
  {
    name: "json_parser Parse Timestamp: the section at the card's scope",
    edit: (user) => user.click(field(JSON_P, "timestamp-enable")),
    from: "        parse_ints: false\n",
    to: '        parse_ints: false\n        timestamp:\n          parse_from: attributes.timestamp\n          layout: "%Y-%m-%d %H:%M:%S"\n          layout_type: strptime\n',
    card: JSON_P,
    check: (op) => expect(op.timestamp).toEqual({ parse_from: "attributes.timestamp", layout: "%Y-%m-%d %H:%M:%S", layout_type: "strptime" }),
  },
  {
    name: "json_parser Parse Severity: the section at the card's scope",
    edit: (user) => user.click(field(JSON_P, "severity-enable")),
    from: "        parse_ints: false\n",
    to: "        parse_ints: false\n        severity:\n          parse_from: attributes.level\n          preset: default\n",
    card: JSON_P,
    check: (op) => expect(op.severity).toEqual({ parse_from: "attributes.level", preset: "default" }),
  },
  // regex_parser
  {
    name: "regex_parser Regex Pattern, its quoting kept",
    edit: (user) => retypeInto(user, field(REGEX, "regex-pattern"), "^(?P<msg>.*)$"),
    from: "        regex: '^(?P<time>\\S+) (?P<level>\\w+) (?P<msg>.*)$'\n",
    to: "        regex: '^(?P<msg>.*)$'\n",
    card: REGEX,
    check: (op) => expect(op.regex).toBe("^(?P<msg>.*)$"),
  },
  {
    name: "regex_parser Parse From: a body suffix",
    edit: (user) => retypeInto(user, field(REGEX, "regex-parse-from-suffix"), "log"),
    from: "        parse_from: body.message\n",
    to: "        parse_from: body.log\n",
    card: REGEX,
    check: (op) => expect(op.parse_from).toBe("body.log"),
  },
  {
    name: "regex_parser Parse To, unset: picked, appended",
    edit: (user) => pickIn(user, field(REGEX, "regex-parse-to"), "resource"),
    from: REGEX_CACHE,
    to: `${REGEX_CACHE}        parse_to: resource\n`,
    card: REGEX,
    check: (op) => expect(op.parse_to).toBe("resource"),
  },
  {
    name: "regex_parser Cache Size: 0 is written plain",
    edit: (user) => retypeInto(user, field(REGEX, "regex-cache"), "0"),
    from: "          size: 100 # entries\n",
    to: "          size: 0 # entries\n",
    card: REGEX,
    check: (op) => expect(op.cache).toEqual({ size: 0 }),
  },
  {
    name: "regex_parser Cache Size: cleared, size goes and cache is {} (no cache)",
    edit: (user) => retypeInto(user, field(REGEX, "regex-cache"), ""),
    from: "        cache:\n          size: 100 # entries\n",
    to: "        cache: {}\n",
    card: REGEX,
    check: (op) => expect(op.cache).toEqual({}),
  },
  // csv_parser
  {
    name: "csv_parser Header",
    edit: (user) => retypeInto(user, field(CSV, "csv-header"), "a,b,c"),
    from: "        header: id,name,msg\n",
    to: "        header: a,b,c\n",
    card: CSV,
    check: (op) => expect(op.header).toBe("a,b,c"),
  },
  {
    name: "csv_parser Header Attribute: a name, and the header goes with it (decision 7)",
    edit: (user) => typeInto(user, field(CSV, "csv-header-attr"), "fields"),
    from: CSV_LINES,
    to: '        delimiter: ","\n        lazy_quotes: true # loose quoting\n        header_attribute: fields\n',
    card: CSV,
    check: (op) => {
      expect(op.header_attribute).toBe("fields");
      expect(op.header).toBeUndefined();
    },
  },
  {
    name: "csv_parser Delimiter, its quoting kept",
    edit: (user) => retypeInto(user, field(CSV, "csv-delimiter"), ";"),
    from: '        delimiter: ","\n',
    to: '        delimiter: ";"\n',
    card: CSV,
    check: (op) => expect(op.delimiter).toBe(";"),
  },
  {
    name: "csv_parser Lazy quotes, unticked: false, its comment kept",
    edit: (user) => user.click(field(CSV, "csv-lazy-quotes")),
    from: "        lazy_quotes: true # loose quoting\n",
    to: "        lazy_quotes: false # loose quoting\n",
    card: CSV,
    check: (op) => expect(op.lazy_quotes).toBe(false),
  },
  {
    name: "csv_parser Ignore quotes, ticked: lazy quotes unticked with it (decision 7)",
    edit: (user) => user.click(field(CSV, "csv-ignore-quotes")),
    from: "        lazy_quotes: true # loose quoting\n",
    to: "        lazy_quotes: false # loose quoting\n        ignore_quotes: true\n",
    card: CSV,
    check: (op) => expect(op).toMatchObject({ lazy_quotes: false, ignore_quotes: true }),
  },
  {
    name: "csv_parser Parse From, unset: typed in the custom input",
    edit: (user) => typeInto(user, field(CSV, "csv-parse-from-custom"), "body.csv"),
    from: CSV_LINES,
    to: `${CSV_LINES}        parse_from: body.csv\n`,
    card: CSV,
    check: (op) => expect(op.parse_from).toBe("body.csv"),
  },
  {
    name: "csv_parser Parse To, unset: attributes, a bare root",
    edit: (user) => pickIn(user, field(CSV, "csv-parse-to"), "attributes"),
    from: CSV_LINES,
    to: `${CSV_LINES}        parse_to: attributes\n`,
    card: CSV,
    check: (op) => expect(op.parse_to).toBe("attributes"),
  },
  // key_value_parser, a flow item
  {
    name: "key_value_parser Key-Value Delimiter, in a flow item",
    edit: (user) => retypeInto(user, field(KV, "kv-delimiter"), "="),
    from: KV_LINE,
    to: KV_LINE.replace('delimiter: ":"', 'delimiter: "="'),
    card: KV,
    check: (op) => expect(op.delimiter).toBe("="),
  },
  {
    name: "key_value_parser Pair Delimiter",
    edit: (user) => retypeInto(user, field(KV, "kv-pair-delimiter"), ","),
    from: KV_LINE,
    to: KV_LINE.replace('pair_delimiter: ";"', 'pair_delimiter: ","'),
    card: KV,
    check: (op) => expect(op.pair_delimiter).toBe(","),
  },
  {
    name: "key_value_parser Parse From, unset: typed in the custom input",
    edit: (user) => typeInto(user, field(KV, "kv-parse-from-custom"), "body.kv"),
    from: KV_LINE,
    to: KV_LINE.replace("}", ", parse_from: body.kv}"),
    card: KV,
    check: (op) => expect(op.parse_from).toBe("body.kv"),
  },
  {
    name: "key_value_parser Parse To: an attributes suffix",
    edit: (user) => retypeInto(user, field(KV, "kv-parse-to-suffix"), "pairs"),
    from: KV_LINE,
    to: KV_LINE.replace("attributes.kv", "attributes.pairs"),
    card: KV,
    check: (op) => expect(op.parse_to).toBe("attributes.pairs"),
  },
  // syslog_parser
  {
    name: "syslog_parser Protocol: RFC 5424; the timestamp block stays",
    edit: (user) => pickIn(user, field(SYSLOG, "syslog-protocol"), "RFC 5424 (Modern)"),
    from: "        protocol: rfc3164\n",
    to: "        protocol: rfc5424\n",
    card: SYSLOG,
    check: (op) => expect(op).toMatchObject({ protocol: "rfc5424", timestamp: { layout_type: "gotime" } }),
  },
  {
    name: "syslog_parser Protocol: none (decision 6)",
    edit: (user) => pickIn(user, field(SYSLOG, "syslog-protocol"), "None (message kept as-is)"),
    from: "        protocol: rfc3164\n",
    to: "        protocol: none\n",
    card: SYSLOG,
    check: (op) => expect(op.protocol).toBe("none"),
  },
  {
    name: "syslog_parser Location (RFC 3164)",
    edit: (user) => retypeInto(user, field(SYSLOG, "syslog-location"), "Europe/Paris"),
    from: "        location: America/New_York\n",
    to: "        location: Europe/Paris\n",
    card: SYSLOG,
    check: (op) => expect(op.location).toBe("Europe/Paris"),
  },
  {
    name: "syslog_parser Enable octet counting (RFC 5424)",
    base: CORPUS.replace("        protocol: rfc3164\n", "        protocol: rfc5424\n"),
    edit: (user) => user.click(field(SYSLOG, "syslog-octet")),
    from: SYSLOG_LINES.replace("rfc3164", "rfc5424"),
    to: `${SYSLOG_LINES.replace("rfc3164", "rfc5424")}        enable_octet_counting: true\n`,
    card: SYSLOG,
    check: (op) => expect(op.enable_octet_counting).toBe(true),
  },
  {
    name: "syslog_parser Parse From, unset: typed in the custom input",
    edit: (user) => typeInto(user, field(SYSLOG, "syslog-parse-from-custom"), "attributes.raw"),
    from: SYSLOG_LINES,
    to: `${SYSLOG_LINES}        parse_from: attributes.raw\n`,
    card: SYSLOG,
    check: (op) => expect(op.parse_from).toBe("attributes.raw"),
  },
  {
    name: "syslog_parser Parse Severity",
    edit: (user) => user.click(field(SYSLOG, "severity-enable")),
    from: SYSLOG_LINES,
    to: `${SYSLOG_LINES}        severity:\n          parse_from: attributes.level\n          preset: default\n`,
    card: SYSLOG,
    check: (op) => expect(op.severity).toEqual({ parse_from: "attributes.level", preset: "default" }),
  },
  // json_array_parser
  {
    name: "json_array_parser Parse From, unset: typed in the custom input",
    edit: (user) => typeInto(user, field(JSON_ARRAY, "json-array-parse-from-custom"), "body.list"),
    from: JSON_ARRAY_LINES,
    to: `${JSON_ARRAY_LINES}        parse_from: body.list\n`,
    card: JSON_ARRAY,
    check: (op) => expect(op.parse_from).toBe("body.list"),
  },
  {
    name: "json_array_parser Parse To: attributes (with a header)",
    edit: (user) => pickIn(user, field(JSON_ARRAY, "json-array-parse-to"), "attributes"),
    from: "        parse_to: body\n        header: a,b,c\n",
    to: "        parse_to: attributes\n        header: a,b,c\n",
    card: JSON_ARRAY,
    check: (op) => expect(op.parse_to).toBe("attributes"),
  },
  {
    name: "json_array_parser Header",
    edit: (user) => retypeInto(user, field(JSON_ARRAY, "json-array-header"), "x,y"),
    from: "        header: a,b,c\n",
    to: "        header: x,y\n",
    card: JSON_ARRAY,
    check: (op) => expect(op.header).toBe("x,y"),
  },
  // container
  {
    name: "container Format: CRI-O",
    edit: (user) => pickIn(user, field(CONTAINER, "container-format"), "CRI-O"),
    from: "        format: docker\n",
    to: "        format: crio\n",
    card: CONTAINER,
    check: (op) => expect(op.format).toBe("crio"),
  },
  {
    name: "container Format: Auto-detect removes the key",
    edit: (user) => pickIn(user, field(CONTAINER, "container-format"), "Auto-detect"),
    from: CONTAINER_LINES,
    to: "        add_metadata_from_filepath: false\n        max_log_size: 2MiB\n",
    card: CONTAINER,
    check: (op) => expect(op.format).toBeUndefined(),
  },
  {
    name: "container Add Kubernetes metadata",
    edit: (user) => user.click(field(CONTAINER, "container-add-metadata")),
    from: "        add_metadata_from_filepath: false\n",
    to: "        add_metadata_from_filepath: true\n",
    card: CONTAINER,
    check: (op) => expect(op.add_metadata_from_filepath).toBe(true),
  },
  {
    name: "container Max Log Size: 0, plain",
    edit: (user) => retypeInto(user, field(CONTAINER, "container-max-log-size"), "0"),
    from: "        max_log_size: 2MiB\n",
    to: "        max_log_size: 0\n",
    card: CONTAINER,
    check: (op) => expect(op.max_log_size).toBe(0),
  },
  {
    name: "container Max Log Size: a size with its unit, as typed",
    edit: (user) => retypeInto(user, field(CONTAINER, "container-max-log-size"), "512KiB"),
    from: "        max_log_size: 2MiB\n",
    to: "        max_log_size: 512KiB\n",
    card: CONTAINER,
    check: (op) => expect(op.max_log_size).toBe("512KiB"),
  },
  {
    name: "container Parse From, unset: typed in the custom input",
    edit: (user) => typeInto(user, field(CONTAINER, "container-parse-from-custom"), "body.log"),
    from: CONTAINER_LINES,
    to: `${CONTAINER_LINES}        parse_from: body.log\n`,
    card: CONTAINER,
    check: (op) => expect(op.parse_from).toBe("body.log"),
  },
  {
    name: "container Parse To, unset: resource",
    edit: (user) => pickIn(user, field(CONTAINER, "container-parse-to"), "resource"),
    from: CONTAINER_LINES,
    to: `${CONTAINER_LINES}        parse_to: resource\n`,
    card: CONTAINER,
    check: (op) => expect(op.parse_to).toBe("resource"),
  },
  {
    name: "container Parse Severity",
    edit: (user) => user.click(field(CONTAINER, "severity-enable")),
    from: CONTAINER_LINES,
    to: `${CONTAINER_LINES}        severity:\n          parse_from: attributes.level\n          preset: default\n`,
    card: CONTAINER,
    check: (op) => expect(op.severity).toEqual({ parse_from: "attributes.level", preset: "default" }),
  },
  // severity_parser
  {
    name: "severity_parser Parse From: an attributes suffix",
    edit: (user) => retypeInto(user, field(SEVERITY, "sevp-parse-from-suffix"), "severity"),
    from: "        parse_from: attributes.sev\n",
    to: "        parse_from: attributes.severity\n",
    card: SEVERITY,
    check: (op) => expect(op.parse_from).toBe("attributes.severity"),
  },
  {
    name: "severity_parser Preset: default",
    edit: (user) => pickIn(user, field(SEVERITY, "sevp-preset"), "Default (info, warn, error, debug, etc.)"),
    from: "        preset: none\n",
    to: "        preset: default\n",
    card: SEVERITY,
    check: (op) => expect(op.preset).toBe("default"),
  },
  {
    name: "severity_parser a mapping row, under the key's spelling in the text (Preflight ruling 26)",
    edit: (user) => retypeInto(user, field(SEVERITY, "sevp-mapping-error"), "error"),
    from: "          Error: [err, E] # keyed as written\n",
    to: "          Error: error # keyed as written\n",
    card: SEVERITY,
    check: (op) => expect(op.mapping).toEqual({ Error: "error", info: "ok" }),
  },
  {
    name: "severity_parser a mapping row not in the text: appended",
    edit: (user) => typeInto(user, field(SEVERITY, "sevp-mapping-warn"), "W, warning"),
    from: "          info: ok\n",
    to: "          info: ok\n          warn:\n            - W\n            - warning\n",
    card: SEVERITY,
    check: (op) => expect(op.mapping).toEqual({ Error: ["err", "E"], info: "ok", warn: ["W", "warning"] }),
  },
  {
    name: "severity_parser Custom severity mapping, unticked: mapping goes",
    edit: (user) => user.click(field(SEVERITY, "sevp-custom")),
    from: "        mapping:\n          Error: [err, E] # keyed as written\n          info: ok\n",
    to: "",
    card: SEVERITY,
    check: (op) => expect(op.mapping).toBeUndefined(),
  },
  {
    name: "severity_parser Overwrite severity text",
    edit: (user) => user.click(field(SEVERITY, "sevp-overwrite")),
    from: "        overwrite_text: true\n",
    to: "        overwrite_text: false\n",
    card: SEVERITY,
    check: (op) => expect(op.overwrite_text).toBe(false),
  },
  // time_parser
  {
    name: "time_parser Parse From: an attributes suffix",
    edit: (user) => retypeInto(user, field(TIME, "time-parse-from-suffix"), "time"),
    from: "        parse_from: attributes.ts\n        layout_type: gotime\n",
    to: "        parse_from: attributes.time\n        layout_type: gotime\n",
    card: TIME,
    check: (op) => expect(op.parse_from).toBe("attributes.time"),
  },
  {
    name: "time_parser Layout Type: strptime sets the first strptime preset, one change (decision 7)",
    edit: (user) => pickIn(user, field(TIME, "time-layout-type"), "strptime (Python-style)"),
    from: '        layout_type: gotime\n        layout: "2006-01-02 15:04:05"\n',
    to: '        layout_type: strptime\n        layout: "%Y-%m-%d %H:%M:%S"\n',
    card: TIME,
    check: (op) => expect(op).toMatchObject({ layout_type: "strptime", layout: "%Y-%m-%d %H:%M:%S" }),
  },
  {
    name: "time_parser Layout: a Go preset",
    edit: (user) => pickIn(user, field(TIME, "time-layout-preset"), "ISO 8601 UTC"),
    from: '        layout: "2006-01-02 15:04:05"\n',
    to: '        layout: "2006-01-02T15:04:05Z"\n',
    card: TIME,
    check: (op) => expect(op.layout).toBe("2006-01-02T15:04:05Z"),
  },
  {
    name: "time_parser Layout: Custom..., typed",
    edit: async (user) => {
      await pickIn(user, field(TIME, "time-layout-preset"), "Custom...");
      await retypeInto(user, field(TIME, "time-layout-custom"), "15:04:05");
    },
    from: '        layout: "2006-01-02 15:04:05"\n',
    to: '        layout: "15:04:05"\n',
    card: TIME,
    check: (op) => expect(op.layout).toBe("15:04:05"),
  },
  {
    name: "time_parser Timezone",
    edit: (user) => retypeInto(user, field(TIME, "time-location"), "Local"),
    from: "        location: UTC\n",
    to: "        location: Local\n",
    card: TIME,
    check: (op) => expect(op.location).toBe("Local"),
  },
  // trace_parser
  {
    name: "trace_parser Parse Trace ID, unticked: trace_id goes",
    edit: (user) => user.click(field(TRACE, "trace-id-enable")),
    from: TRACE_LINES,
    to: "        span_id: {parse_from: attributes.span}\n",
    card: TRACE,
    check: (op) => expect(op.trace_id).toBeUndefined(),
  },
  {
    name: "trace_parser the trace ID's Parse From",
    edit: (user) => retypeInto(user, field(TRACE, "trace-id-from-suffix"), "tid"),
    from: "          parse_from: attributes.trace\n",
    to: "          parse_from: attributes.tid\n",
    card: TRACE,
    check: (op) => expect(op.trace_id).toEqual({ parse_from: "attributes.tid" }),
  },
  {
    name: "trace_parser the span ID's Parse From, in a flow mapping",
    edit: (user) => retypeInto(user, field(TRACE, "span-id-from-suffix"), "sid"),
    from: "        span_id: {parse_from: attributes.span}\n",
    to: "        span_id: {parse_from: attributes.sid}\n",
    card: TRACE,
    check: (op) => expect(op.span_id).toEqual({ parse_from: "attributes.sid" }),
  },
  {
    name: "trace_parser Parse Span ID, unticked: span_id goes",
    edit: (user) => user.click(field(TRACE, "span-id-enable")),
    from: TRACE_LINES,
    to: "        trace_id:\n          parse_from: attributes.trace\n",
    card: TRACE,
    check: (op) => expect(op.span_id).toBeUndefined(),
  },
  {
    name: "trace_parser Parse Trace ID, ticked: its block",
    base: CORPUS.replace("        trace_id:\n          parse_from: attributes.trace\n", ""),
    edit: (user) => user.click(field(TRACE, "trace-id-enable")),
    from: "        span_id: {parse_from: attributes.span}\n",
    to: "        span_id: {parse_from: attributes.span}\n        trace_id:\n          parse_from: attributes.trace_id\n",
    card: TRACE,
    check: (op) => expect(op.trace_id).toEqual({ parse_from: "attributes.trace_id" }),
  },
  // uri_parser
  {
    name: "uri_parser Parse From: an attributes suffix",
    edit: (user) => retypeInto(user, field(URI, "uri-parse-from-suffix"), "uri"),
    from: URI_LINE,
    to: "        parse_from: attributes.uri\n",
    card: URI,
    check: (op) => expect(op.parse_from).toBe("attributes.uri"),
  },
  {
    name: "uri_parser Parse To, unset: resource",
    edit: (user) => pickIn(user, field(URI, "uri-parse-to"), "resource"),
    from: URI_LINE,
    to: `${URI_LINE}        parse_to: resource\n`,
    card: URI,
    check: (op) => expect(op.parse_to).toBe("resource"),
  },
  // scope_name_parser
  {
    name: "scope_name_parser Parse From, its comment kept",
    edit: (user) => retypeInto(user, field(SCOPE, "scope-parse-from-suffix"), "name"),
    from: SCOPE_LINE,
    to: "        parse_from: attributes.name # the logger's name\n",
    card: SCOPE,
    check: (op) => expect(op.parse_from).toBe("attributes.name"),
  },
];

/** The timestamp and severity sections' boxes on the other parsers that have them: each writes at its own card's scope. */
const TIMESTAMP_BLOCK = '        timestamp:\n          parse_from: attributes.timestamp\n          layout: "%Y-%m-%d %H:%M:%S"\n          layout_type: strptime\n';
const SEVERITY_BLOCK = "        severity:\n          parse_from: attributes.level\n          preset: default\n";
for (const [name, card, last] of [
  ["regex_parser", REGEX, REGEX_CACHE],
  ["csv_parser", CSV, CSV_LINES],
  ["json_array_parser", JSON_ARRAY, JSON_ARRAY_LINES],
] as const) {
  CASES.push(
    {
      name: `${name} Parse Timestamp`,
      edit: (user) => user.click(field(card, "timestamp-enable")),
      from: last,
      to: `${last}${TIMESTAMP_BLOCK}`,
      card,
      check: (op) => expect(op.timestamp).toEqual({ parse_from: "attributes.timestamp", layout: "%Y-%m-%d %H:%M:%S", layout_type: "strptime" }),
    },
    {
      name: `${name} Parse Severity`,
      edit: (user) => user.click(field(card, "severity-enable")),
      from: last,
      to: `${last}${SEVERITY_BLOCK}`,
      card,
      check: (op) => expect(op.severity).toEqual({ parse_from: "attributes.level", preset: "default" }),
    },
  );
}
CASES.push(
  {
    name: "key_value_parser Parse Timestamp, in a flow item",
    edit: (user) => user.click(field(KV, "timestamp-enable")),
    from: KV_LINE,
    to: KV_LINE.replace("}", ', timestamp: {parse_from: attributes.timestamp, layout: "%Y-%m-%d %H:%M:%S", layout_type: strptime}}'),
    card: KV,
    check: (op) => expect(op.timestamp).toEqual({ parse_from: "attributes.timestamp", layout: "%Y-%m-%d %H:%M:%S", layout_type: "strptime" }),
  },
  {
    name: "key_value_parser Parse Severity, in a flow item",
    edit: (user) => user.click(field(KV, "severity-enable")),
    from: KV_LINE,
    to: KV_LINE.replace("}", ", severity: {parse_from: attributes.level, preset: default}}"),
    card: KV,
    check: (op) => expect(op.severity).toEqual({ parse_from: "attributes.level", preset: "default" }),
  },
);

describe("every field of each parser writes only its key (decision 2)", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const lf = c.base ?? CORPUS;
      const before = crlf ? CRLF(lf) : lf;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderParsers(before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, () => to));
      expect(entries()).toBe(1);
      expect(selectUndoDescription(builderStore())).toMatch(/^Update /);
      c.check(operatorsOf(text())[c.card]!);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
    20_000,
  );

  it("the cards are the 12 parsers, each with its form (Task 6)", () => {
    renderParsers();
    expect(operatorsOf(CORPUS).map((op) => op.type)).toEqual(PARSER_TYPES);
    for (const type of PARSER_TYPES) expect(OPERATOR_FORMS[type]).toBeDefined();
  });
});

// ── The fixes ──

describe("csv_parser: Header Attribute is a name; the header pair and the quote pair exclude each other (decisions 4 and 7)", () => {
  const WITH_ATTRIBUTE = CORPUS.replace("        header: id,name,msg\n", "        header_attribute: fields # the header row\n");

  it("Header Attribute is a text field with the collector's example, not a field path (csv/parser.go:95)", () => {
    renderParsers();
    expect(field(CSV, "csv-header-attr").tagName).toBe("INPUT");
    expect(field(CSV, "csv-header-attr")).toHaveAttribute("placeholder", "e.g., header_field");
    expect(field(CSV, "csv-header-attr-suffix")).toBeNull();
  });

  it("typing a header removes header_attribute, in one change, with no toast (csv/config.go:78-80)", async () => {
    const user = renderParsers(WITH_ATTRIBUTE);
    expect(field(CSV, "csv-header-attr")).toHaveValue("fields");
    await typeInto(user, field(CSV, "csv-header"), "a,b");
    expect(text()).toBe(WITH_ATTRIBUTE.replace("        header_attribute: fields # the header row\n", "").replace(
      "        lazy_quotes: true # loose quoting\n",
      "        lazy_quotes: true # loose quoting\n        header: a,b\n",
    ));
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
    expect(field(CSV, "csv-header-attr")).toHaveValue("");
    act(() => void builderStore().undo());
    expect(text()).toBe(WITH_ATTRIBUTE);
  });

  it("clearing a header removes only its key", async () => {
    const user = renderParsers(WITH_ATTRIBUTE);
    await retypeInto(user, field(CSV, "csv-header-attr"), "");
    expect(text()).toBe(WITH_ATTRIBUTE.replace("        header_attribute: fields # the header row\n", ""));
  });

  it("ticking Lazy quotes unticks Ignore quotes, in one change (csv/config.go:62-64)", async () => {
    const base = CORPUS.replace("        lazy_quotes: true # loose quoting\n", "        ignore_quotes: true\n");
    const user = renderParsers(base);
    await user.click(field(CSV, "csv-lazy-quotes"));
    expect(text()).toBe(base.replace("        ignore_quotes: true\n", "        ignore_quotes: false\n        lazy_quotes: true\n"));
    expect(entries()).toBe(1);
    expect(field(CSV, "csv-ignore-quotes")).not.toBeChecked();
    expect(field(CSV, "csv-lazy-quotes")).toBeChecked();
  });

  it("unset Delimiter shows the collector's , as placeholder and hint, not as a value", () => {
    renderParsers(SEEDS);
    expect(field(CSV, "csv-delimiter")).toHaveValue("");
    expect(field(CSV, "csv-delimiter")).toHaveAttribute("placeholder", ",");
    expect(hintIn(cardOf(`op-${CSV}-csv-delimiter`), "Column separator. · Default ,")).not.toBeNull();
  });
});

describe("json_array_parser (decision 3)", () => {
  it("Parse To is marked required and shows no default; the seed's body shows as written", () => {
    renderParsers(SEEDS);
    const card = cardOf(`op-${JSON_ARRAY}-json-array-parse-to`);
    expect(within(card).getByText("Parse To").querySelector(".text-fail")).toHaveTextContent("*");
    expect(hintIn(card, "Destination for parsed array.")).not.toBeNull();
    expect(field(JSON_ARRAY, "json-array-parse-to")).toHaveTextContent("body");
  });
});

describe("container: Max Log Size's default is the collector's 1MiB (decision 4)", () => {
  it("shows Default 1MiB, the corrected description, and 1MiB as the placeholder (container/config.go:25, 43)", () => {
    renderParsers(SEEDS);
    const card = cardOf(`op-${CONTAINER}-container-max-log-size`);
    expect(hintIn(card, "Maximum bytes for recombined partial logs. · Default 1MiB")).not.toBeNull();
    expect(within(card).queryByText(/0 = unlimited/)).toBeNull();
    expect(field(CONTAINER, "container-max-log-size")).toHaveAttribute("placeholder", "1MiB");
    expect(field(CONTAINER, "container-max-log-size")).toHaveValue("");
  });

  it("unset Format shows Auto-detect; picking it writes nothing; unset metadata shows ticked (config.go:42)", async () => {
    const user = renderParsers(SEEDS);
    expect(field(CONTAINER, "container-format")).toHaveTextContent("Auto-detect");
    expect(field(CONTAINER, "container-add-metadata")).toBeChecked();
    await pickIn(user, field(CONTAINER, "container-format"), "Auto-detect");
    expect(text()).toBe(SEEDS);
    expect(entries()).toBe(0);
  });
});

describe("severity_parser writes nothing on render (decision 8; Preflight ruling 26)", () => {
  const UPPER = CORPUS.replace("          info: ok\n", "          INFO: ok\n          WARN: w\n");

  it("a mapping keyed in upper case is read, and opening, expanding and leaving its rows writes nothing", async () => {
    const user = renderParsers(UPPER);
    expect(field(SEVERITY, "sevp-custom")).toBeChecked();
    expect(field(SEVERITY, "sevp-mapping-error")).toHaveValue("err, E");
    expect(field(SEVERITY, "sevp-mapping-info")).toHaveValue("ok");
    expect(field(SEVERITY, "sevp-mapping-warn")).toHaveValue("w");
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      await user.click(field(SEVERITY, `sevp-mapping-${level}`));
      await user.tab();
    }
    expect(text()).toBe(UPPER);
    expect(entries()).toBe(0);
  });

  it("a row writes under the text's spelling (WARN stays WARN)", async () => {
    const user = renderParsers(UPPER);
    await retypeInto(user, field(SEVERITY, "sevp-mapping-warn"), "warning");
    expect(text()).toBe(UPPER.replace("          WARN: w\n", "          WARN: warning\n"));
  });

  it("a mapping the rows can't show is read-only with the hint", () => {
    renderParsers(CORPUS.replace("          info: ok\n", "          info: ok\n          error: 5\n"));
    expect(field(SEVERITY, "sevp-mapping-info")).toBeDisabled();
    expect(field(SEVERITY, "sevp-custom")).toBeDisabled();
    expect(within(cardOf(`op-${SEVERITY}-sevp-custom`)).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });

  it("unset Preset shows the collector's default, and Default default (Ruling 51)", () => {
    renderParsers(CORPUS.replace("        preset: none\n", ""));
    expect(field(SEVERITY, "sevp-preset")).toHaveTextContent("Default (info, warn, error, debug, etc.)");
    expect(hintIn(cardOf(`op-${SEVERITY}-sevp-preset`), "Predefined severity mappings. · Default default")).not.toBeNull();
  });
});

describe("time_parser: presets per layout type, and the switch (decisions 3 and 7; Preflight ruling 14)", () => {
  const TIME_BASE = (type: string, layout: string) =>
    CORPUS.replace('        layout_type: gotime\n        layout: "2006-01-02 15:04:05"\n', `        layout_type: ${type}\n        layout: ${layout}\n`);

  async function optionsOf(user: UserEvent) {
    await user.click(field(TIME, "time-layout-preset"));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    await user.keyboard("{Escape}");
    return options;
  }

  it("strptime offers six presets, the first labelled with what it writes", async () => {
    const user = renderParsers(TIME_BASE("strptime", "'%Y-%m-%d %H:%M:%S'"));
    expect(field(TIME, "time-layout-preset")).toHaveTextContent("%Y-%m-%d %H:%M:%S");
    expect(await optionsOf(user)).toEqual([
      "%Y-%m-%d %H:%M:%S",
      "ISO 8601 with TZ",
      "ISO 8601 UTC",
      "ISO 8601 with microseconds",
      "Common Log Format",
      "Syslog (RFC 3164)",
      "Custom...",
    ]);
    await pickIn(user, field(TIME, "time-layout-preset"), "ISO 8601 with microseconds");
    expect(operatorsOf(text())[TIME]!.layout).toBe("%Y-%m-%dT%H:%M:%S.%f%z");
  });

  // Its own time limit (D9c Rulings 54 and 80).
  it("Go time offers the same six in Go's layouts (ctimefmt.go:30-72)", async () => {
    const user = renderParsers();
    expect(field(TIME, "time-layout-preset")).toHaveTextContent("2006-01-02 15:04:05");
    expect(await optionsOf(user)).toEqual([
      "2006-01-02 15:04:05",
      "ISO 8601 with TZ",
      "ISO 8601 UTC",
      "ISO 8601 with microseconds",
      "Common Log Format",
      "Syslog (RFC 3164)",
      "Custom...",
    ]);
    const written: unknown[] = [];
    for (const label of ["ISO 8601 with TZ", "ISO 8601 with microseconds", "Common Log Format", "Syslog (RFC 3164)"]) {
      await pickIn(user, field(TIME, "time-layout-preset"), label);
      written.push(operatorsOf(text())[TIME]!.layout);
    }
    expect(written).toEqual(["2006-01-02T15:04:05Z0700", "2006-01-02T15:04:05.999999Z0700", "02/Jan/2006:15:04:05 -0700", "Jan 02 15:04:05"]);
  }, 20_000);

  it("epoch offers the collector's s and s.us (helper/time.go:98-106): Unix epoch (seconds) writes s", async () => {
    const user = renderParsers(TIME_BASE("epoch", "s.us"));
    expect(field(TIME, "time-layout-preset")).toHaveTextContent("Unix epoch with fractional");
    expect(await optionsOf(user)).toEqual(["Unix epoch (seconds)", "Unix epoch with fractional", "Custom..."]);
    await pickIn(user, field(TIME, "time-layout-preset"), "Unix epoch (seconds)");
    expect(text()).toBe(TIME_BASE("epoch", "s"));
    expect(operatorsOf(text())[TIME]).toMatchObject({ layout_type: "epoch", layout: "s" });
    expect(entries()).toBe(1);
  });

  it("switching to epoch sets s, toasted once, with no inline alert; undo restores both", async () => {
    const user = renderParsers();
    await pickIn(user, field(TIME, "time-layout-type"), "Epoch (Unix timestamp)");
    expect(text()).toBe(CORPUS.replace('        layout_type: gotime\n        layout: "2006-01-02 15:04:05"\n', '        layout_type: epoch\n        layout: "s"\n'));
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual(["Layout set to the first epoch preset."]);
    expect(screen.queryByText("Layout set to the first epoch preset.")).toBeNull();
    expect(field(TIME, "time-layout-preset")).toHaveTextContent("Unix epoch (seconds)");
    await retypeInto(user, field(TIME, "time-parse-from-suffix"), "time");
    expect(infoToasts()).toEqual(["Layout set to the first epoch preset."]);
    act(() => void builderStore().undo());
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("a custom layout is kept across a switch, with no toast (Preflight ruling 14)", async () => {
    const base = TIME_BASE("gotime", "'02 Jan 06 15:04'");
    const user = renderParsers(base);
    expect(field(TIME, "time-layout-preset")).toHaveTextContent("Custom...");
    expect(field(TIME, "time-layout-custom")).toHaveValue("02 Jan 06 15:04");
    await pickIn(user, field(TIME, "time-layout-type"), "strptime (Python-style)");
    expect(text()).toBe(TIME_BASE("strptime", "'02 Jan 06 15:04'"));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  it("unset Layout Type shows strptime and Default strptime (helper/time.go:37-41), and the cheat-sheet", () => {
    renderParsers(SEEDS.replace(',"layout_type":"strptime"', ""));
    expect(field(TIME, "time-layout-type")).toHaveTextContent("strptime (Python-style)");
    const card = cardOf(`op-${TIME}-time-layout-type`);
    expect(hintIn(card, "Time format specification type. · Default strptime")).not.toBeNull();
    expect(
      hintIn(card, "strptime format: %Y=year, %m=month, %d=day, %H=hour, %M=minute, %S=second, %f=microseconds, %z=timezone"),
    ).not.toBeNull();
  });
});

describe("trace_parser: the boxes say what the collector reads when off (decision 4)", () => {
  it("each box has its hint, on or off (helper/trace.go:59-83)", () => {
    renderParsers(CORPUS.replace("        span_id: {parse_from: attributes.span}\n", ""));
    const card = cardOf(`op-${TRACE}-trace-id-enable`);
    expect(field(TRACE, "trace-id-enable")).toBeChecked();
    expect(field(TRACE, "span-id-enable")).not.toBeChecked();
    expect(hintIn(card, TRACE_ID_OFF_HINT)).not.toBeNull();
    expect(hintIn(card, SPAN_ID_OFF_HINT)).not.toBeNull();
    expect(TRACE_ID_OFF_HINT).toBe("Off: the collector still reads body.trace_id.");
    expect(SPAN_ID_OFF_HINT).toBe("Off: the collector still reads body.span_id.");
    expect(field(TRACE, "span-id-from")).toBeNull();
  });

  it("a block without parse_from shows the collector's default (trace.go:64-73)", () => {
    renderParsers(CORPUS.replace("        span_id: {parse_from: attributes.span}\n", "        span_id: {}\n"));
    expect(field(TRACE, "span-id-enable")).toBeChecked();
    expect(field(TRACE, "span-id-from-custom")).toHaveAttribute("placeholder", "body.span_id");
    expect(hintIn(cardOf(`op-${TRACE}-span-id-enable`), "Field containing the span ID (16 hex chars). · Default body.span_id")).not.toBeNull();
  });
});

describe("syslog_parser: Protocol with none, unset shown unset, no timestamp section (decisions 4 and 6)", () => {
  it("offers RFC 5424, RFC 3164 and none", async () => {
    const user = renderParsers();
    await user.click(field(SYSLOG, "syslog-protocol"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["RFC 5424 (Modern)", "RFC 3164 (BSD/Legacy)", "None (message kept as-is)"]);
  });

  it("unset shows no selection and no Default (the collector requires it, syslog/config.go:82-83)", () => {
    renderParsers(CORPUS.replace("        protocol: rfc3164\n", ""));
    expect(field(SYSLOG, "syslog-protocol").textContent).toBe("");
    const card = cardOf(`op-${SYSLOG}-syslog-protocol`);
    expect(hintIn(card, "Syslog format specification.")).not.toBeNull();
    expect(within(card).queryByText(/^RFC 5424/)).toBeNull();
    expect(field(SYSLOG, "syslog-location")).toBeNull();
  });

  // Its own time limit (D9c Rulings 54 and 80).
  it("Location for RFC 3164 only, with Default UTC (config.go:98-100)", async () => {
    const user = renderParsers();
    expect(field(SYSLOG, "syslog-location")).toHaveValue("America/New_York");
    expect(hintIn(cardOf(`op-${SYSLOG}-syslog-location`), "Timezone for RFC 3164 (no TZ in format). · Default UTC")).not.toBeNull();
    await pickIn(user, field(SYSLOG, "syslog-protocol"), "RFC 5424 (Modern)");
    expect(field(SYSLOG, "syslog-location")).toBeNull();
    await pickIn(user, field(SYSLOG, "syslog-protocol"), "None (message kept as-is)");
    expect(field(SYSLOG, "syslog-location")).toBeNull();
  }, 20_000);

  it("the protocol is read as the collector reads it, lower-cased (config.go:64)", () => {
    renderParsers(CORPUS.replace("        protocol: rfc3164\n", "        protocol: RFC3164\n"));
    expect(field(SYSLOG, "syslog-protocol")).toHaveTextContent("RFC3164");
    expect(field(SYSLOG, "syslog-location")).toHaveValue("America/New_York");
  });

  it("has no Parse Timestamp; a timestamp block in the text stays through an edit (config.go:66-74)", async () => {
    const user = renderParsers();
    expect(field(SYSLOG, "timestamp-enable")).toBeNull();
    expect(field(SYSLOG, "severity-enable")).not.toBeNull();
    await retypeInto(user, field(SYSLOG, "syslog-location"), "UTC");
    expect(operatorsOf(text())[SYSLOG]!.timestamp).toEqual({ parse_from: "attributes.ts", layout_type: "gotime", layout: "Jan 02 15:04:05" });
  });
});

describe("uri_parser: no fragment (decision 4)", () => {
  it("the description and the output fields list scheme, host, port, path, query and user only (parseutils/uri.go:100-128)", () => {
    renderParsers();
    const card = cardOf(`op-${URI}-uri-parse-from`);
    expect(within(card).queryByText(/fragment/)).toBeNull();
    expect(hintIn(card, "Parses URIs into components: scheme, host, port, path, query.Example: https://example.com:8080/path?query=1")).not.toBeNull();
    expect([...card.querySelectorAll("li code")].map((c) => c.textContent)).toEqual(["scheme", "host", "port", "path", "query", "user"]);
  });
});

describe("regex_parser's copy and Cache Size", () => {
  it("the placeholder and the tip are regex-library's patterns", () => {
    renderParsers(SEEDS);
    expect(field(REGEX, "regex-pattern")).toHaveValue("^(?P<message>.*)$");
    expect(field(REGEX, "regex-pattern")).toHaveAttribute("placeholder", "^(?P<timestamp>\\S+) (?P<level>\\w+) (?P<message>.*)$");
    const card = cardOf(`op-${REGEX}-regex-pattern`);
    expect(
      hintIn(card, "Tip: Use named groups like (?P<field_name>...) to extract fields. Example: ^(?P<time>\\d{4}-\\d{2}-\\d{2}) (?P<msg>.*)$"),
    ).not.toBeNull();
    expect(field(REGEX, "regex-cache")).toHaveAttribute("placeholder", "0");
    expect(hintIn(card, "Regex cache size (0 = disabled). · Default 0")).not.toBeNull();
  });

  it("0 is typed and written where the cache is unset (0 never shows as empty)", async () => {
    const user = renderParsers(SEEDS);
    await typeInto(user, field(REGEX, "regex-cache"), "0");
    expect(operatorsOf(text())[REGEX]!.cache).toEqual({ size: 0 });
    expect(field(REGEX, "regex-cache")).toHaveValue("0");
  });
});

// ── Opening writes nothing (D9b decision 2) ──

describe("opening and expanding each parser card writes nothing", () => {
  const TEXTS = [
    ["the corpus", CORPUS],
    ["the corpus in CRLF", CRLF(CORPUS)],
    ["the seeds, every other field unset", SEEDS],
  ] as const;

  // One test per form and text, each with its own time limit (D9c Ruling 54).
  it.each(PARSER_TYPES.flatMap((type, card) => TEXTS.map(([name, base]) => [type, name, card, base] as const)))(
    "%s on %s: collapsed, expanded, every field focused and left",
    async (_type, _name, card, base) => {
      const user = renderParsers(base);
      for (const button of screen.getAllByRole("button", { name: "Collapse operator" })) await user.click(button);
      expect(screen.queryAllByRole("textbox")).toHaveLength(0);
      await user.click(screen.getAllByRole("button", { name: "Expand operator" })[card]!);
      expect(field(card, "id")).not.toBeNull();
      for (const input of screen.queryAllByRole("textbox")) {
        await user.click(input);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );
});

// ── Privacy (decision 10) ──

describe("privacy (decision 10)", () => {
  it("puts no config value in any attribute across the parser cards, every menu opened", async () => {
    const MARK = "zq-mark";
    const base = withParsers([
      `{type: json_parser, id: ${MARK}-id, parse_from: body.${MARK}-from, parse_to: attributes.${MARK}-to, parse_ints: ${MARK}-ints}`,
      `{type: regex_parser, regex: ${MARK}-regex, cache: {size: ${MARK}-cache}, timestamp: {parse_from: attributes.${MARK}-ts, layout: ${MARK}-layout}}`,
      `{type: csv_parser, header: ${MARK}-header, header_attribute: ${MARK}-hattr, delimiter: ${MARK}-delim, lazy_quotes: ${MARK}-lazy}`,
      `{type: key_value_parser, delimiter: ${MARK}-kv, pair_delimiter: ${MARK}-pair, severity: {parse_from: ${MARK}-sev, preset: ${MARK}-preset}}`,
      `{type: syslog_parser, protocol: ${MARK}-protocol, location: ${MARK}-location, parse_from: ${MARK}-custom}`,
      `{type: json_array_parser, parse_to: ${MARK}-array-to, header: ${MARK}-array-header}`,
      `{type: container, format: ${MARK}-format, max_log_size: ${MARK}-size, add_metadata_from_filepath: ${MARK}-meta}`,
      `{type: severity_parser, parse_from: attributes.${MARK}-sevp, preset: ${MARK}-sevp-preset, mapping: {warn: ${MARK}-warn}, overwrite_text: ${MARK}-ow}`,
      `{type: time_parser, parse_from: attributes.${MARK}-time, layout_type: ${MARK}-type, layout: ${MARK}-time-layout, location: ${MARK}-tz}`,
      `{type: trace_parser, trace_id: {parse_from: attributes.${MARK}-trace}, span_id: {parse_from: ${MARK}-span}}`,
      `{type: uri_parser, parse_from: attributes.${MARK}-uri, parse_to: resource.${MARK}-uri-to}`,
      `type: scope_name_parser\n        parse_from: 'attributes["${MARK}.scope"]'`,
    ]);

    const leaks: string[] = [];
    const scan = (where: string) => {
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
        }
      }
    };
    const shown = () =>
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    const user = renderParsers(base);
    for (const marker of [
      "-id", "-from", "-to", "-regex", "-layout", "-header", "-hattr", "-delim", "-kv", "-pair", "-sev", "-preset", "-protocol",
      "-custom", "-array-to", "-array-header", "-format", "-size", "-sevp", "-sevp-preset", "-warn", "-time", "-type",
      "-time-layout", "-tz", "-trace", "-span", "-uri", "-uri-to", ".scope",
    ]) {
      expect(shown()).toContain(`${MARK}${marker}`);
    }
    scan("cards");

    const menus = [...document.querySelectorAll('button[role="combobox"]')].map((trigger) => trigger.id).filter((id) => id !== "");
    expect(menus.length).toBeGreaterThan(20);
    for (const menu of menus) {
      if (byId(menu).hasAttribute("disabled")) continue;
      await user.click(byId(menu));
      scan(`${menu} menu`);
      await user.keyboard("{Escape}");
    }

    expect(text()).toBe(base);
    expect(entries()).toBe(0);
    expect(leaks).toEqual([]);
  }, 20_000);
});

// ── The Task 5 review's fixes (D9c Rulings 58 and 59) ──

describe("syslog_parser: a protocol other than RFC 5424 takes no framing trailer (Ruling 58)", () => {
  // parser/syslog/config.go:88-91: the trailer is refused with none and with anything but rfc5424.
  const WITH_TRAILER = CORPUS.replace(
    "        protocol: rfc3164\n        location: America/New_York\n",
    "        protocol: rfc5424\n        non_transparent_framing_trailer: LF # framing\n        location: America/New_York\n",
  );

  it.each([
    ["RFC 3164 (BSD/Legacy)", "rfc3164"],
    ["None (message kept as-is)", "none"],
  ])("switching to %s removes the trailer in the same change, toasted once, with no inline alert", async (label, protocol) => {
    const user = renderParsers(WITH_TRAILER);
    await pickIn(user, field(SYSLOG, "syslog-protocol"), label);
    expect(text()).toBe(
      WITH_TRAILER.replace("        protocol: rfc5424\n        non_transparent_framing_trailer: LF # framing\n", `        protocol: ${protocol}\n`),
    );
    expect(entries()).toBe(1);
    expect(screen.queryByText(REMOVED_PARSER_TRAILER)).toBeNull();
    expect(infoToasts()).toEqual([REMOVED_PARSER_TRAILER]);
    act(() => void builderStore().undo());
    expect(text()).toBe(WITH_TRAILER);
    // The undo toasts its own message, not the adjustment's again.
    expect(infoToasts().filter((message) => message === REMOVED_PARSER_TRAILER)).toHaveLength(1);
  });

  it("without a trailer, a switch writes the protocol alone, with no toast", async () => {
    const user = renderParsers();
    await pickIn(user, field(SYSLOG, "syslog-protocol"), "None (message kept as-is)");
    expect(text()).toBe(CORPUS.replace("        protocol: rfc3164\n        location:", "        protocol: none\n        location:"));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });
});

describe("container: format auto is shown as written (Ruling 59)", () => {
  // parser/container/config.go:63-71: only docker, crio and containerd; auto is refused.
  const AUTO = CORPUS.replace(CONTAINER_LINES, CONTAINER_LINES.replace("format: docker", "format: auto"));

  it("an extra option, as written, not Auto-detect; picking Auto-detect removes it", async () => {
    const user = renderParsers(AUTO);
    expect(field(CONTAINER, "container-format")).toHaveTextContent("auto");
    expect(field(CONTAINER, "container-format")).not.toHaveTextContent("Auto-detect");
    await user.click(field(CONTAINER, "container-format"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Auto-detect", "Docker (JSON)", "CRI-O", "Containerd", "auto"]);
    await user.click(screen.getByRole("option", { name: "Auto-detect" }));
    expect(text()).toBe(CORPUS.replace(CONTAINER_LINES, CONTAINER_LINES.replace("        format: docker\n", "")));
  });
});

// ── The Task 6 review's fixes (D9c Rulings 61-63) ──

describe("syslog_parser: octet counting (Rulings 61 and 62)", () => {
  const WITH_TRAILER = CORPUS.replace(
    "        protocol: rfc3164\n        location: America/New_York\n",
    "        protocol: rfc5424\n        non_transparent_framing_trailer: LF # framing\n        location: America/New_York\n",
  );

  it("ticking it removes a framing trailer in the same change, toasted once, with no inline alert (config.go:86-87)", async () => {
    const user = renderParsers(WITH_TRAILER);
    await user.click(field(SYSLOG, "syslog-octet"));
    expect(text()).toBe(
      WITH_TRAILER.replace("        non_transparent_framing_trailer: LF # framing\n", "").replace(
        "          layout: Jan 02 15:04:05\n",
        "          layout: Jan 02 15:04:05\n        enable_octet_counting: true\n",
      ),
    );
    expect(entries()).toBe(1);
    expect(screen.queryByText(REMOVED_TRAILER_FOR_OCTETS)).toBeNull();
    expect(infoToasts()).toEqual([REMOVED_TRAILER_FOR_OCTETS]);
    expect(REMOVED_TRAILER_FOR_OCTETS).toBe("Removed the framing trailer: it can't be used with octet counting.");
    await retypeInto(user, field(SYSLOG, "syslog-parse-from-custom"), "body.raw");
    expect(infoToasts()).toEqual([REMOVED_TRAILER_FOR_OCTETS]);
    act(() => void builderStore().undo());
    act(() => void builderStore().undo());
    expect(text()).toBe(WITH_TRAILER);
  });

  it("without a trailer, ticking writes the box alone, with no toast; unticking writes false", async () => {
    const base = CORPUS.replace("        protocol: rfc3164\n", "        protocol: rfc5424\n");
    const user = renderParsers(base);
    await user.click(field(SYSLOG, "syslog-octet"));
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
    await user.click(field(SYSLOG, "syslog-octet"));
    expect(operatorsOf(text())[SYSLOG]!.enable_octet_counting).toBe(false);
  });

  it.each([
    ["RFC 3164", "rfc3164"],
    ["none", "none"],
    ["RFC 5424", "rfc5424"],
  ])("shows under %s, which the collector frames by octet count too (parser.go:169-173, 199-209), and writes there", async (_name, protocol) => {
    const base = CORPUS.replace("        protocol: rfc3164\n", `        protocol: ${protocol}\n`);
    const user = renderParsers(base);
    expect(field(SYSLOG, "syslog-octet")).not.toBeChecked();
    await user.click(field(SYSLOG, "syslog-octet"));
    expect(text()).toBe(base.replace("          layout: Jan 02 15:04:05\n", "          layout: Jan 02 15:04:05\n        enable_octet_counting: true\n"));
  });

  it("shows while the protocol is unset", () => {
    renderParsers(CORPUS.replace("        protocol: rfc3164\n", ""));
    expect(field(SYSLOG, "syslog-octet")).not.toBeNull();
  });
});

describe("csv, time_parser and the epoch layouts (Ruling 63)", () => {
  const TIME_WITH = (type: string, layout: string) =>
    CORPUS.replace('        layout_type: gotime\n        layout: "2006-01-02 15:04:05"\n', `        layout_type: ${type}\n        layout: ${layout}\n`);

  it("csv's Header hint says the delimiter separates the names (csv/config.go:58-60, 82-84)", () => {
    renderParsers();
    const card = cardOf(`op-${CSV}-csv-header`);
    expect(hintIn(card, "Column names, separated by the delimiter.")).not.toBeNull();
    expect(hintIn(card, "Comma-separated column names.")).toBeNull();
  });

  it("clearing time_parser's custom layout removes the key (D9b's rule; never \"\")", async () => {
    const base = TIME_WITH("gotime", "'02 Jan 06 15:04'");
    const user = renderParsers(base);
    await retypeInto(user, field(TIME, "time-layout-custom"), "");
    expect(text()).toBe(base.replace("        layout: '02 Jan 06 15:04'\n", ""));
    expect(operatorsOf(text())[TIME]!.layout).toBeUndefined();
    // The input stays for the typing that follows.
    expect(field(TIME, "time-layout-custom")).toHaveValue("");
    await typeInto(user, field(TIME, "time-layout-custom"), "15:04");
    expect(operatorsOf(text())[TIME]!.layout).toBe("15:04");
  });

  it("Timezone is hidden under epoch; a location in the text stays through an edit (time.go:114-117)", async () => {
    const base = TIME_WITH("epoch", "s.us");
    const user = renderParsers(base);
    expect(field(TIME, "time-location")).toBeNull();
    expect(screen.queryByText("Default timezone (if not in timestamp).")).toBeNull();
    await pickIn(user, field(TIME, "time-layout-preset"), "Unix epoch (seconds)");
    expect(operatorsOf(text())[TIME]).toMatchObject({ layout: "s", location: "UTC" });
    await pickIn(user, field(TIME, "time-layout-type"), "Go time format");
    expect(field(TIME, "time-location")).toHaveValue("UTC");
  });

  // Its own time limit (D9c Rulings 54 and 80).
  it.each(["s", "ms", "us", "ns", "s.ms", "s.us", "s.ns"])(
    "epoch's %s counts as epoch's: a switch away sets the new type's first preset (time.go:100)",
    async (layout) => {
      const user = renderParsers(TIME_WITH("epoch", layout));
      await pickIn(user, field(TIME, "time-layout-type"), "strptime (Python-style)");
      expect(operatorsOf(text())[TIME]).toMatchObject({ layout_type: "strptime", layout: "%Y-%m-%d %H:%M:%S" });
      expect(infoToasts()).toEqual(["Layout set to the first strptime preset."]);
      expect(screen.queryByText("Layout set to the first strptime preset.")).toBeNull();
      expect(entries()).toBe(1);
    },
    20_000,
  );

  it("layoutAfterSwitch: the seven epoch layouts are epoch's; a switch to epoch keeps them", () => {
    for (const layout of ["s", "ms", "us", "ns", "s.ms", "s.us", "s.ns"]) {
      expect(layoutAfterSwitch(layout, "gotime")).toBe("2006-01-02 15:04:05");
      expect(layoutAfterSwitch(layout, "epoch")).toBeUndefined();
    }
    expect(layoutAfterSwitch("S", "gotime")).toBeUndefined();
  });
});
