import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "../../form-context.js";
import { operatorSeed, type OperatorType } from "../operator-catalog.js";
import { OperatorPipeline } from "../OperatorPipeline.js";
import { OPERATOR_FORMS } from "./index.js";
import { ROUTE_WITHOUT_OUTPUT_HINT } from "./RouterOperatorForm.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The transformer and flow operator forms (D9c Task 7): the 14
 * forms in the operator cards, over the form contract. Each field is driven
 * as a person would (typing, clicking, picking) on the logs corpus'
 * `filelog/transforms` (comments, flow items, quoted scalars; the corpus
 * around them has an anchor and merges and `0750`), LF and CRLF, and writes
 * only its key: the text changes in that key's lines only, as one undo
 * entry, and parses to the value (decision 2). The fixes each have a test
 * that fails if the bug returns: add's value written as
 * typed (decision 2; Preflight ruling 2); retain's held rows and hint
 * (decision 9; Preflight ruling 13); flatten's copy and no Depth (decision
 * 4); unquote's and move's hints (decision 4); regex_replace's pattern
 * switch (decision 3; Preflight ruling 25); router's routes with no output
 * and the hint (decision 3; Preflight ruling 18); recombine's Combine With,
 * exclusive patterns and defaults (decisions 3, 4, 7 and 8; Preflight
 * ruling 1).
 *
 * Collector claims cite contrib v0.162.0 (`pkg/stanza/`).
 */

const CORPUS = corpusText("forms-logs-operators.yaml");
const TRANSFORMS = "receivers.filelog/transforms";

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderTransforms(text = CORPUS, key = TRANSFORMS) {
  openText(text);
  const user = userEvent.setup();
  render(
    <ComponentForm nodeId={componentNamed(key).id}>
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
const operatorsOf = (written: string, name = "filelog/transforms"): Value[] =>
  (parseYaml(written, { merge: true }) as { receivers: Record<string, { operators: Value[] }> }).receivers[name]!.operators;
/** A `<p>` whose whole text is `whole`. */
const hintIn = (container: HTMLElement, whole: string) =>
  within(container).queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
/** The card whose field `id` is in it. */
const cardOf = (id: string) => byId(id).closest(".rounded-lg.bg-card") as HTMLElement;
/** `typed` as user-event types it: `[` and `{` are its key descriptors, doubled to type them. */
const literal = (typed: string) => typed.replace(/[[{]/g, "$&$&");

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, literal(typed));
  await user.tab();
}

async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.type(input, literal(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** The corpus' transformers and flow operators, by card index. */
const ADD = 0;
const COPY = 1;
const MOVE = 2;
const REMOVE = 3;
const RETAIN = 4;
const FLATTEN = 5;
const UNQUOTE = 6;
const REGEX_REPLACE = 7;
const SANITIZE = 8;
const ASSIGN = 9;
const FILTER = 10;
const ROUTER = 11;
const RECOMBINE = 12;
const NOOP = 13;

const TRANSFORM_TYPES: readonly OperatorType[] = [
  "add",
  "copy",
  "move",
  "remove",
  "retain",
  "flatten",
  "unquote",
  "regex_replace",
  "sanitize_utf8",
  "assign_keys",
  "filter",
  "router",
  "recombine",
  "noop",
];

/** A card's field: `op-<card>-<field>`. */
const field = (card: number, name: string) => byId(`op-${card}-${name}`);
/** A card's button, by its name. */
const buttonIn = (card: number, anyFieldId: string, name: string, index = 0) =>
  within(cardOf(`op-${card}-${anyFieldId}`)).getAllByRole("button", { name })[index]!;

/** The corpus with the transforms receiver's operators replaced by `lines` (each an item). */
const withTransforms = (lines: readonly string[]) =>
  CORPUS.replace(
    /( {2}filelog\/transforms:\n.*\n {4}operators:\n)[\s\S]*?(?= {2}# every parser)/,
    `$1${lines.map((line) => `      - ${line}\n`).join("")}`,
  );

/** The 14 as Add Operator seeds them, as flow items: every field unset but the seed's. */
const SEEDS = withTransforms(TRANSFORM_TYPES.map((type) => JSON.stringify(operatorSeed(type))));

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
}

const ADD_VALUE = '        value: "production"\n';
const COPY_LINE = "      - {type: copy, from: body.msg, to: attributes.copied}\n";
const MOVE_TO = "        to: 'resource[\"host.name\"]' # a key with dots\n";
const RETAIN_FIELDS = "          - body.message # the message\n          - attributes.team\n";
const REGEX_LINES = "        regex: '\\x1b\\[\\d+m' # colour codes\n        replace_with: \"\"\n";
const ROUTES = "          - expr: 'attributes.level == \"error\"' # errors first\n            output: kept\n          - {expr: \"true\"}\n";
const RECOMBINE_TAIL = "        overwrite_with: newest # the latest fields\n";

/** add's Value typed: written verbatim when it reads as a number, a boolean or a one-line flow collection, else a string. */
const valueCase = (typed: string, written: string, value: unknown): FieldCase => ({
  name: `add Value ${typed}: written ${written}`,
  edit: (user) => retypeInto(user, field(ADD, "add-value"), typed),
  from: ADD_VALUE,
  to: `        value: ${written}\n`,
  card: ADD,
  check: (op) => expect(op.value).toEqual(value),
});

const CASES: FieldCase[] = [
  // add
  {
    name: "add Field: an attributes suffix",
    edit: (user) => retypeInto(user, field(ADD, "add-field-suffix"), "stage"),
    from: "        field: attributes.env\n",
    to: "        field: attributes.stage\n",
    card: ADD,
    check: (op) => expect(op.field).toBe("attributes.stage"),
  },
  valueCase("1.0", "1.0", 1),
  valueCase("true", "true", true),
  valueCase('{"k":"v"}', '{"k":"v"}', { k: "v" }),
  valueCase('[1, "a"]', '[1, "a"]', [1, "a"]),
  valueCase("EXPR(body.user)", '"EXPR(body.user)"', "EXPR(body.user)"),
  valueCase("staging", '"staging"', "staging"),
  valueCase("", '""', ""),
  // copy
  {
    name: "copy From, in a flow item",
    edit: (user) => retypeInto(user, field(COPY, "copy-from-suffix"), "text"),
    from: COPY_LINE,
    to: "      - {type: copy, from: body.text, to: attributes.copied}\n",
    card: COPY,
    check: (op) => expect(op.from).toBe("body.text"),
  },
  {
    name: "copy To, in a flow item",
    edit: (user) => pickIn(user, field(COPY, "copy-to"), "resource"),
    from: COPY_LINE,
    to: "      - {type: copy, from: body.msg, to: resource.copied}\n",
    card: COPY,
    check: (op) => expect(op.to).toBe("resource.copied"),
  },
  // move
  {
    name: "move From",
    edit: (user) => retypeInto(user, field(MOVE, "move-from-suffix"), "hostname"),
    from: "        from: attributes.host\n",
    to: "        from: attributes.hostname\n",
    card: MOVE,
    check: (op) => expect(op.from).toBe("attributes.hostname"),
  },
  {
    name: "move To: a bracketed key, its quoting and comment kept",
    edit: (user) => retypeInto(user, field(MOVE, "move-to-suffix"), '["service.name"]'),
    from: MOVE_TO,
    to: "        to: 'resource[\"service.name\"]' # a key with dots\n",
    card: MOVE,
    check: (op) => expect(op.to).toBe('resource["service.name"]'),
  },
  // remove
  {
    name: "remove Field: resource picked",
    edit: (user) => pickIn(user, field(REMOVE, "remove-field"), "resource"),
    from: "        field: attributes.password\n",
    to: "        field: resource.password\n",
    card: REMOVE,
    check: (op) => expect(op.field).toBe("resource.password"),
  },
  {
    name: "remove Field: an empty suffix writes the bare root (rootable, remove/config.go:39)",
    edit: (user) => retypeInto(user, field(REMOVE, "remove-field-suffix"), ""),
    from: "        field: attributes.password\n",
    to: "        field: attributes\n",
    card: REMOVE,
    check: (op) => expect(op.field).toBe("attributes"),
  },
  // retain
  {
    name: "retain Fields: a row, its comment kept",
    edit: (user) => retypeInto(user, field(RETAIN, "retain-field-0"), "body.msg"),
    from: RETAIN_FIELDS,
    to: "          - body.msg # the message\n          - attributes.team\n",
    card: RETAIN,
    check: (op) => expect(op.fields).toEqual(["body.msg", "attributes.team"]),
  },
  {
    name: "retain Fields: Remove removes the item's lines",
    edit: async (user) => user.click(buttonIn(RETAIN, "retain-field-1", "Remove", 1)),
    from: RETAIN_FIELDS,
    to: "          - body.message # the message\n",
    card: RETAIN,
    check: (op) => expect(op.fields).toEqual(["body.message"]),
  },
  {
    name: "retain Fields: Add Field, then typing, appends the item",
    edit: async (user) => {
      await user.click(buttonIn(RETAIN, "retain-field-0", "Add Field"));
      await typeInto(user, field(RETAIN, "retain-field-2"), 'resource["host.name"]');
    },
    from: RETAIN_FIELDS,
    to: `${RETAIN_FIELDS}          - resource["host.name"]\n`,
    card: RETAIN,
    check: (op) => expect(op.fields).toEqual(["body.message", "attributes.team", 'resource["host.name"]']),
  },
  {
    name: "retain Fields: a row emptied and left removes its item",
    edit: (user) => retypeInto(user, field(RETAIN, "retain-field-1"), ""),
    from: RETAIN_FIELDS,
    to: "          - body.message # the message\n",
    card: RETAIN,
    check: (op) => expect(op.fields).toEqual(["body.message"]),
  },
  // flatten
  {
    name: "flatten Field, depth left alone",
    edit: (user) => retypeInto(user, field(FLATTEN, "flatten-field-suffix"), "inner"),
    from: "        field: body.nested\n        depth: 2 # not a key: left alone\n",
    to: "        field: body.inner\n        depth: 2 # not a key: left alone\n",
    card: FLATTEN,
    check: (op) => expect([op.field, op.depth]).toEqual(["body.inner", 2]),
  },
  // unquote
  {
    name: "unquote Field, in a flow item",
    edit: (user) => retypeInto(user, field(UNQUOTE, "unquote-field-suffix"), "q"),
    from: "      - {type: unquote, field: body.quoted}\n",
    to: "      - {type: unquote, field: body.q}\n",
    card: UNQUOTE,
    check: (op) => expect(op.field).toBe("body.q"),
  },
  // regex_replace
  {
    name: "regex_replace Field: a bare body given a suffix",
    edit: (user) => typeInto(user, field(REGEX_REPLACE, "regex-replace-field-suffix"), "message"),
    from: "        field: body\n        regex:",
    to: "        field: body.message\n        regex:",
    card: REGEX_REPLACE,
    check: (op) => expect(op.field).toBe("body.message"),
  },
  {
    name: "regex_replace Regex Pattern, its quoting and comment kept",
    edit: (user) => retypeInto(user, field(REGEX_REPLACE, "regex-replace-regex"), "\\d+"),
    from: REGEX_LINES,
    to: "        regex: '\\d+' # colour codes\n        replace_with: \"\"\n",
    card: REGEX_REPLACE,
    check: (op) => expect(op.regex).toBe("\\d+"),
  },
  {
    name: "regex_replace Replace With",
    edit: (user) => typeInto(user, field(REGEX_REPLACE, "regex-replace-with"), "${1}"),
    from: REGEX_LINES,
    to: "        regex: '\\x1b\\[\\d+m' # colour codes\n        replace_with: \"${1}\"\n",
    card: REGEX_REPLACE,
    check: (op) => expect(op.replace_with).toBe("${1}"),
  },
  {
    name: "regex_replace Pattern Type: Well-Known writes regex_name and removes regex, in one change",
    edit: (user) => pickIn(user, field(REGEX_REPLACE, "regex-replace-pattern-type"), "Well-Known Pattern"),
    from: REGEX_LINES,
    to: '        replace_with: ""\n        regex_name: ansi_control_sequences\n',
    card: REGEX_REPLACE,
    check: (op) => expect([op.regex_name, "regex" in op]).toEqual(["ansi_control_sequences", false]),
  },
  // sanitize_utf8
  {
    name: "sanitize_utf8 Field",
    edit: (user) => retypeInto(user, field(SANITIZE, "sanitize-utf8-field-suffix"), "text"),
    from: "        field: attributes.raw\n",
    to: "        field: attributes.text\n",
    card: SANITIZE,
    check: (op) => expect(op.field).toBe("attributes.text"),
  },
  // assign_keys
  {
    name: "assign_keys Field",
    edit: (user) => retypeInto(user, field(ASSIGN, "assign-keys-field-suffix"), "items"),
    from: "        field: body.list\n",
    to: "        field: body.items\n",
    card: ASSIGN,
    check: (op) => expect(op.field).toBe("body.items"),
  },
  {
    name: "assign_keys Keys: a key, in a flow list",
    edit: (user) => retypeInto(user, field(ASSIGN, "assign-keys-key-0"), "key_id"),
    from: "        keys: [id, level]\n",
    to: "        keys: [key_id, level]\n",
    card: ASSIGN,
    check: (op) => expect(op.keys).toEqual(["key_id", "level"]),
  },
  {
    name: "assign_keys Keys: Add Key appends key<n+1>",
    edit: async (user) => user.click(buttonIn(ASSIGN, "assign-keys-field", "Add Key")),
    from: "        keys: [id, level]\n",
    to: "        keys: [id, level, key3]\n",
    card: ASSIGN,
    check: (op) => expect(op.keys).toEqual(["id", "level", "key3"]),
  },
  {
    name: "assign_keys Keys: Remove removes the item",
    edit: async (user) => user.click(buttonIn(ASSIGN, "assign-keys-field", "Remove", 0)),
    from: "        keys: [id, level]\n",
    to: "        keys: [level]\n",
    card: ASSIGN,
    check: (op) => expect(op.keys).toEqual(["level"]),
  },
  // filter
  {
    name: "filter Expression, its quoting kept",
    edit: (user) => retypeInto(user, field(FILTER, "filter-expr"), 'body matches "^TRACE"'),
    from: "        expr: 'body matches \"^DEBUG\"'\n",
    to: "        expr: 'body matches \"^TRACE\"'\n",
    card: FILTER,
    check: (op) => expect(op.expr).toBe('body matches "^TRACE"'),
  },
  {
    name: "filter Drop Ratio: 1.0 written as typed, its comment kept",
    edit: (user) => retypeInto(user, field(FILTER, "filter-ratio"), "1.0"),
    from: "        drop_ratio: 0.5 # half\n",
    to: "        drop_ratio: 1.0 # half\n",
    card: FILTER,
    check: (op) => expect(op.drop_ratio).toBe(1),
  },
  {
    name: "filter Drop Ratio: 1.5, outside 0-1, written as typed (decision 3; filter/config.go:61-63)",
    edit: (user) => retypeInto(user, field(FILTER, "filter-ratio"), "1.5"),
    from: "        drop_ratio: 0.5 # half\n",
    to: "        drop_ratio: 1.5 # half\n",
    card: FILTER,
    check: (op) => expect(op.drop_ratio).toBe(1.5),
  },
  // router
  {
    name: "router a route's Expression, its quoting and comment kept",
    edit: (user) => retypeInto(user, field(ROUTER, "route-expr-0"), 'attributes.level == "warn"'),
    from: ROUTES,
    to: ROUTES.replace('"error"', '"warn"'),
    card: ROUTER,
    check: (op) => expect((op.routes as Value[])[0]!.expr).toBe('attributes.level == "warn"'),
  },
  {
    name: "router a route's Output",
    edit: (user) => retypeInto(user, field(ROUTER, "route-output-0"), "errs"),
    from: ROUTES,
    to: ROUTES.replace("output: kept", "output: errs"),
    card: ROUTER,
    check: (op) => expect((op.routes as Value[])[0]!.output).toBe("errs"),
  },
  {
    name: "router a route's Output, typed where it had none, in a flow item",
    edit: (user) => typeInto(user, field(ROUTER, "route-output-1"), "kept"),
    from: ROUTES,
    to: ROUTES.replace('{expr: "true"}', '{expr: "true", output: kept}'),
    card: ROUTER,
    check: (op) => expect((op.routes as Value[])[1]).toEqual({ expr: "true", output: "kept" }),
  },
  {
    name: "router Add Route appends {expr: true}, with no output (decision 3)",
    edit: async (user) => user.click(buttonIn(ROUTER, "router-default", "Add Route")),
    from: ROUTES,
    to: `${ROUTES}          - expr: "true"\n`,
    card: ROUTER,
    check: (op) => expect((op.routes as Value[])[2]).toEqual({ expr: "true" }),
  },
  {
    name: "router Remove removes the route's lines",
    edit: async (user) => user.click(buttonIn(ROUTER, "router-default", "Remove", 0)),
    from: ROUTES,
    to: '          - {expr: "true"}\n',
    card: ROUTER,
    check: (op) => expect(op.routes).toEqual([{ expr: "true" }]),
  },
  {
    name: "router Default Output",
    edit: (user) => retypeInto(user, field(ROUTER, "router-default"), "other"),
    from: "        default: kept\n",
    to: "        default: other\n",
    card: ROUTER,
    check: (op) => expect(op.default).toBe("other"),
  },
  // recombine
  {
    name: "recombine Last Entry Pattern, its quoting kept",
    edit: (user) => retypeInto(user, field(RECOMBINE, "recombine-last"), 'body matches "]$"'),
    from: "        is_last_entry: 'body matches \"}$\"'\n",
    to: "        is_last_entry: 'body matches \"]$\"'\n",
    card: RECOMBINE,
    check: (op) => expect(op.is_last_entry).toBe('body matches "]$"'),
  },
  {
    name: "recombine Combine Field",
    edit: (user) => retypeInto(user, field(RECOMBINE, "recombine-field-suffix"), "log"),
    from: "        combine_field: body.message\n",
    to: "        combine_field: body.log\n",
    card: RECOMBINE,
    check: (op) => expect(op.combine_field).toBe("body.log"),
  },
  {
    name: "recombine Combine With: \\n typed is written as a newline, double-quoted (decision 8)",
    edit: (user) => retypeInto(user, field(RECOMBINE, "recombine-with"), "\\n"),
    from: '        combine_with: "\\t"\n',
    to: '        combine_with: "\\n"\n',
    card: RECOMBINE,
    check: (op) => expect(op.combine_with).toBe("\n"),
  },
  {
    name: "recombine Source Identifier",
    edit: (user) => retypeInto(user, field(RECOMBINE, "recombine-source-suffix"), "file"),
    from: "        source_identifier: attributes.stream\n",
    to: "        source_identifier: attributes.file\n",
    card: RECOMBINE,
    check: (op) => expect(op.source_identifier).toBe("attributes.file"),
  },
  {
    name: "recombine Max Batch Size: 0 is written (unlimited, recombine.md)",
    edit: (user) => retypeInto(user, field(RECOMBINE, "recombine-batch"), "0"),
    from: "        max_batch_size: 100\n",
    to: "        max_batch_size: 0\n",
    card: RECOMBINE,
    check: (op) => expect(op.max_batch_size).toBe(0),
  },
  {
    name: "recombine Max Log Size: a size with a unit written as typed",
    edit: (user) => retypeInto(user, field(RECOMBINE, "recombine-size"), "2MiB"),
    from: "        max_log_size: 1MiB\n",
    to: "        max_log_size: 2MiB\n",
    card: RECOMBINE,
    check: (op) => expect(op.max_log_size).toBe("2MiB"),
  },
  {
    name: "recombine Force Flush Period",
    edit: (user) => retypeInto(user, field(RECOMBINE, "recombine-flush"), "20s"),
    from: "        force_flush_period: 10s\n",
    to: "        force_flush_period: 20s\n",
    card: RECOMBINE,
    check: (op) => expect(op.force_flush_period).toBe("20s"),
  },
  {
    name: "recombine Overwrite With, its comment kept",
    edit: (user) => pickIn(user, field(RECOMBINE, "recombine-overwrite"), "Oldest entry"),
    from: RECOMBINE_TAIL,
    to: "        overwrite_with: oldest # the latest fields\n",
    card: RECOMBINE,
    check: (op) => expect(op.overwrite_with).toBe("oldest"),
  },
];

describe("every field of each transformer and flow operator writes only its key (decision 2)", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(CORPUS) : CORPUS;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderTransforms(before);

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

  it("the cards are the 14 transformers and flow operators, each with its form (Task 7)", () => {
    renderTransforms();
    expect(operatorsOf(CORPUS).map((op) => op.type)).toEqual(TRANSFORM_TYPES);
    for (const type of TRANSFORM_TYPES) expect(OPERATOR_FORMS[type]).toBeDefined();
    expect(field(NOOP, "id")).not.toBeNull();
  });
});

// ── The fixes ──

describe("add: the value is written as typed, and shown as typed (decision 2; Preflight ruling 2)", () => {
  it.each([
    ["1.0", 1],
    ["true", true],
    ['{"k":"v"}', { k: "v" }],
    ['[1, "a"]', [1, "a"]],
  ])("%s is written verbatim, plain, and shown as typed after the write", async (typed, value) => {
    const user = renderTransforms();
    await retypeInto(user, field(ADD, "add-value"), typed);
    expect(text()).toBe(CORPUS.replace(ADD_VALUE, `        value: ${typed}\n`));
    expect(operatorsOf(text())[ADD]!.value).toEqual(value);
    expect(field(ADD, "add-value").value).toBe(typed);
    expect(field(ADD, "add-value")).not.toBeDisabled();
  });

  it("a one-line flow mapping in the text shows as written, and stays editable", () => {
    const base = CORPUS.replace(ADD_VALUE, '        value: {a: [1, 2], "b": true}\n');
    renderTransforms(base);
    expect(field(ADD, "add-value").value).toBe('{a: [1, 2], "b": true}');
    expect(field(ADD, "add-value")).not.toBeDisabled();
  });

  it("the first filelog's 0750 shows as its characters, and blurring it writes nothing", async () => {
    const user = renderTransforms(CORPUS, "receivers.filelog");
    const input = within(cardOf("op-2-add-value")).getByDisplayValue("0750");
    await user.click(input);
    await user.tab();
    expect(text()).toBe(CORPUS);
  });

  it("a block mapping is read-only with the hint", () => {
    renderTransforms(CORPUS.replace(ADD_VALUE, "        value:\n          k: v\n"));
    expect(field(ADD, "add-value")).toBeDisabled();
    expect(hintIn(cardOf("op-0-add-value"), UNSHOWABLE_VALUE_MESSAGE)).not.toBeNull();
  });

  it("retyping a quoted \"42\" as 42 writes the number (writeSame, as Ruling 47)", async () => {
    const user = renderTransforms(CORPUS.replace(ADD_VALUE, '        value: "42"\n'));
    expect(field(ADD, "add-value").value).toBe("42");
    await retypeInto(user, field(ADD, "add-value"), "42");
    expect(text()).toBe(CORPUS.replace(ADD_VALUE, "        value: 42\n"));
    expect(operatorsOf(text())[ADD]!.value).toBe(42);
  });

  it("focusing and leaving the value writes nothing", async () => {
    const user = renderTransforms(CORPUS.replace(ADD_VALUE, '        value: "42"\n'));
    await user.click(field(ADD, "add-value"));
    await user.tab();
    expect(entries()).toBe(0);
  });

  it("the JSON example is real JSON, and typing it writes a mapping (decision 4)", async () => {
    const user = renderTransforms();
    const card = cardOf("op-0-add-value");
    expect(within(card).getByText('{"key": "value"}')).toBeInTheDocument();
    expect(within(card).queryByText("{'key': 'value'}")).toBeNull();
    await retypeInto(user, field(ADD, "add-value"), '{"key": "value"}');
    expect(operatorsOf(text())[ADD]!.value).toEqual({ key: "value" });
  });
});

describe("move and unquote: their hints say what the collector does (decision 4)", () => {
  it("move's example promotes to resource[\"host.name\"], a key with dots (entry/field.go:152-226)", () => {
    renderTransforms();
    const card = cardOf("op-2-move-from");
    expect(within(card).getByText('resource["host.name"]')).toBeInTheDocument();
    expect(within(card).queryByText("resource.host.name")).toBeNull();
  });

  it("unquote lists no single-quoted 'value' (strconv.Unquote, unquote/transformer.go:39)", () => {
    renderTransforms();
    const card = cardOf("op-6-unquote-field");
    expect(within(card).queryByText(/Single quotes/)).toBeNull();
    expect(within(card).queryByText("'value'")).toBeNull();
    expect(within(card).getByText(/Double quotes/)).toBeInTheDocument();
    expect(within(card).getByText(/Backticks/)).toBeInTheDocument();
  });
});

describe("retain: held rows, and a hint of fields the collector takes (decision 9; Preflight ruling 13)", () => {
  it("Add Field writes nothing until something is typed, and a held row left empty goes", async () => {
    const user = renderTransforms();
    await user.click(buttonIn(RETAIN, "retain-field-0", "Add Field"));
    expect(field(RETAIN, "retain-field-2")).not.toBeNull();
    await user.click(field(RETAIN, "retain-field-2"));
    await user.tab();
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
    expect(field(RETAIN, "retain-field-2")).toBeNull();
  });

  it("on an unset list, the empty text shows until Add Field; typing writes the list with its item", async () => {
    const base = withTransforms(["{type: retain}"]);
    const user = renderTransforms(base);
    const card = cardOf("op-0-id");
    expect(within(card).getByText('No fields specified. Click "Add Field" to add fields to retain.')).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Add Field" }));
    expect(within(card).queryByText(/No fields specified/)).toBeNull();
    await typeInto(user, field(0, "retain-field-0"), "body.msg");
    expect(operatorsOf(text())[0]).toEqual({ type: "retain", fields: ["body.msg"] });
    expect(entries()).toBe(1);
  });

  it("the hint lists body, attributes.user_id and resource[\"host.name\"]: no timestamp, no bare attributes or resource (field.go:117-131)", () => {
    renderTransforms();
    const card = cardOf("op-4-retain-field-0");
    const codes = [...card.querySelectorAll("li code")].map((code) => code.textContent);
    expect(codes).toEqual(["body", "attributes.user_id", 'resource["host.name"]']);
    expect(within(card).queryByText(/Log timestamp/)).toBeNull();
    expect(within(card).queryByText(/All attributes/)).toBeNull();
  });

  it("a fields list that isn't scalars is read-only with the hint", () => {
    renderTransforms(withTransforms(["{type: retain, fields: [{a: 1}]}"]));
    expect(hintIn(cardOf("op-0-id"), UNSHOWABLE_VALUE_MESSAGE)).not.toBeNull();
    expect(within(cardOf("op-0-id")).getByRole("button", { name: "Add Field" })).toBeDisabled();
  });
});

describe("flatten: what it does, and no Depth (decisions 3 and 4)", () => {
  it("says it moves a map's fields up one level, with the collector's example (flatten.md; flatten/transformer.go:35-58)", () => {
    renderTransforms();
    const card = cardOf("op-5-flatten-field");
    expect(hintIn(card, "Moves a map's fields up one level, into its parent.")).not.toBeNull();
    expect(hintIn(card, "Required. The map to flatten, under body, attributes or resource.")).not.toBeNull();
    expect(within(card).queryByText(/dot-notation/)).toBeNull();
    expect(within(card).queryByText(/leave empty for body/)).toBeNull();
    expect(within(card).getByText("Before flatten, with Field body.key1:")).toBeInTheDocument();
    expect(card.querySelectorAll("pre")[1]!.textContent).toContain('"nested1": "nestedval1"');
  });

  it("has no Depth field (flatten/config.go:35-38)", () => {
    renderTransforms();
    const card = cardOf("op-5-flatten-field");
    expect(within(card).queryByText("Depth")).toBeNull();
    expect(field(FLATTEN, "flatten-depth")).toBeNull();
  });

  it("an empty suffix removes the key: a bare attributes is refused (entry/field.go:119-126)", async () => {
    const base = CORPUS.replace("        field: body.nested\n", "        field: attributes.nested\n");
    const user = renderTransforms(base);
    await retypeInto(user, field(FLATTEN, "flatten-field-suffix"), "");
    expect(text()).toBe(base.replace("        field: attributes.nested\n", ""));
  });
});

describe("regex_replace: the pattern switch (decision 3; Preflight ruling 25)", () => {
  const SEEDED = withTransforms([JSON.stringify(operatorSeed("regex_replace")), "{type: noop}"]);
  const SEED_LINE = '      - {"type":"regex_replace","field":"body","regex_name":"ansi_control_sequences","replace_with":""}\n';

  it("the seed shows Well-Known Pattern (regex_name, regexreplace/config.go:48-57)", () => {
    renderTransforms(SEEDED);
    expect(field(0, "regex-replace-pattern-type")).toHaveTextContent("Well-Known Pattern");
    expect(field(0, "regex-replace-well-known")).toHaveTextContent("ANSI Control Sequences (ESC [)");
    expect(field(0, "regex-replace-regex")).toBeNull();
  });

  it("Custom writes nothing and keeps regex_name; the first regex typed removes it, in one change; undo restores", async () => {
    const user = renderTransforms(SEEDED);
    await pickIn(user, field(0, "regex-replace-pattern-type"), "Custom Regex");
    expect(text()).toBe(SEEDED);
    expect(entries()).toBe(0);
    expect(field(0, "regex-replace-regex").value).toBe("");
    expect(field(0, "regex-replace-pattern-type")).toHaveTextContent("Custom Regex");

    await typeInto(user, field(0, "regex-replace-regex"), "\\d+");
    expect(text()).toBe(SEEDED.replace(SEED_LINE, '      - {"type":"regex_replace","field":"body","replace_with":"", regex: \\d+}\n'));
    expect(operatorsOf(text())[0]).toEqual({ type: "regex_replace", field: "body", replace_with: "", regex: "\\d+" });
    expect(entries()).toBe(1);
    expect(field(0, "regex-replace-pattern-type")).toHaveTextContent("Custom Regex");

    act(() => void builderStore().undo());
    expect(text()).toBe(SEEDED);
    expect(field(0, "regex-replace-pattern-type")).toHaveTextContent("Well-Known Pattern");
  });

  it("Custom then Well-Known with nothing typed writes nothing", async () => {
    const user = renderTransforms(SEEDED);
    await pickIn(user, field(0, "regex-replace-pattern-type"), "Custom Regex");
    await pickIn(user, field(0, "regex-replace-pattern-type"), "Well-Known Pattern");
    expect(text()).toBe(SEEDED);
    expect(entries()).toBe(0);
    expect(field(0, "regex-replace-well-known")).not.toBeNull();
  });

  it("the Custom choice follows its card when the card moves (Preflight ruling 25)", async () => {
    layOutRows();
    const user = renderTransforms(SEEDED);
    await pickIn(user, field(0, "regex-replace-pattern-type"), "Custom Regex");
    await dragByKeyboard(screen.getAllByRole("button", { name: "Drag to reorder" })[0]!, 1);
    expect(operatorsOf(text()).map((op) => op.type)).toEqual(["noop", "regex_replace"]);
    expect(field(1, "regex-replace-pattern-type")).toHaveTextContent("Custom Regex");
    expect(field(1, "regex-replace-regex")).not.toBeNull();
  });

  it("the Custom choice goes when the keys change from elsewhere", async () => {
    const user = renderTransforms(SEEDED);
    await pickIn(user, field(0, "regex-replace-pattern-type"), "Custom Regex");
    act(() => void builderStore().setComponentValues(componentNamed(TRANSFORMS).id, [{ path: ["operators", 0, "regex_name"], value: "ansi_control_sequences_x" }]));
    expect(field(0, "regex-replace-pattern-type")).toHaveTextContent("Well-Known Pattern");
    expect(field(0, "regex-replace-well-known")).toHaveTextContent("ansi_control_sequences_x");
  });

  it("the Field is required and shows no default; the placeholder is regex-library's ISO date", () => {
    renderTransforms();
    const card = cardOf("op-7-regex-replace-field");
    expect(hintIn(card, "String field to apply replacement on.")).not.toBeNull();
    expect(field(REGEX_REPLACE, "regex-replace-regex").placeholder).toBe("\\d{4}-\\d{2}-\\d{2}");
  });
});

describe("router: routes with no output, and the hint (decision 3; Preflight ruling 18)", () => {
  it("Add Route appends a route with no output, and its Output shows the hint (router/transformer.go:98-118)", async () => {
    const base = withTransforms(["type: router"]);
    const user = renderTransforms(base);
    await user.click(within(cardOf("op-0-router-default")).getByRole("button", { name: "Add Route" }));
    expect(text()).toBe(base.replace("      - type: router\n  # every parser", '      - type: router\n        routes:\n          - expr: "true"\n  # every parser'));
    expect(operatorsOf(text())[0]).toEqual({ type: "router", routes: [{ expr: "true" }] });
    expect(field(0, "route-output-0").value).toBe("");
    expect(hintIn(cardOf("op-0-router-default"), ROUTE_WITHOUT_OUTPUT_HINT)).not.toBeNull();
  });

  it("the router's seed has no output, and shows the hint", () => {
    renderTransforms(withTransforms([JSON.stringify(operatorSeed("router"))]));
    expect(operatorsOf(text())[0]).toEqual({ type: "router", routes: [{ expr: "true" }] });
    expect(hintIn(cardOf("op-0-router-default"), ROUTE_WITHOUT_OUTPUT_HINT)).not.toBeNull();
  });

  it("the hint shows under the route without an output only, and goes once one is typed", async () => {
    const user = renderTransforms();
    const route = (index: number) => byId(`op-${ROUTER}-route-output-${index}`).closest(".p-3") as HTMLElement;
    expect(hintIn(route(0), ROUTE_WITHOUT_OUTPUT_HINT)).toBeNull();
    expect(hintIn(route(1), ROUTE_WITHOUT_OUTPUT_HINT)).not.toBeNull();
    await typeInto(user, field(ROUTER, "route-output-1"), "kept");
    expect(hintIn(route(1), ROUTE_WITHOUT_OUTPUT_HINT)).toBeNull();
  });

  // Its own time limit (D9c Rulings 54 and 80).
  it("clearing an Output removes the key (a route without one is valid); the hint comes back", async () => {
    const user = renderTransforms();
    await retypeInto(user, field(ROUTER, "route-output-0"), "");
    expect(text()).toBe(CORPUS.replace("            output: kept\n          - {expr", "          - {expr"));
    const route = byId(`op-${ROUTER}-route-output-0`).closest(".p-3") as HTMLElement;
    expect(hintIn(route, ROUTE_WITHOUT_OUTPUT_HINT)).not.toBeNull();
  }, 20_000);

  it("the router card shows no On Error or Condition (router/config.go:34-38)", () => {
    renderTransforms();
    expect(field(ROUTER, "on-error")).toBeNull();
    expect(field(ROUTER, "if")).toBeNull();
    expect(field(ROUTER, "id")).not.toBeNull();
  });
});

describe("recombine: Combine With, the exclusive patterns and the defaults (decisions 3, 4, 7 and 8)", () => {
  it("'\\n' (two characters) shows \\\\n, and blurring it writes nothing", async () => {
    const user = renderTransforms(CORPUS, "receivers.filelog");
    const input = within(cardOf("op-4-recombine-with")).getByDisplayValue("\\\\n");
    expect(input.id).toBe("op-4-recombine-with");
    await user.click(input);
    await user.tab();
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);
  });

  it("a tab in the text shows \\t", () => {
    renderTransforms();
    expect(field(RECOMBINE, "recombine-with").value).toBe("\\t");
  });

  it("\\n typed over '\\n' is written as a newline (recombine/config.go:24, 43)", async () => {
    const user = renderTransforms(CORPUS, "receivers.filelog");
    await retypeInto(user, byId("op-4-recombine-with"), "\\n");
    expect(text()).toBe(CORPUS.replace("        combine_with: '\\n'\n", '        combine_with: "\\n"\n'));
    expect(operatorsOf(text(), "filelog")[4]!.combine_with).toBe("\n");
  });

  it("unset: the collector's defaults as placeholders and hints (config.go:38-48, 63)", () => {
    renderTransforms(withTransforms([JSON.stringify(operatorSeed("recombine"))]));
    const card = cardOf("op-0-recombine-with");
    expect(field(0, "recombine-with").placeholder).toBe("\\n");
    expect(hintIn(card, "Separator between entries. · Default \\n")).not.toBeNull();
    expect(field(0, "recombine-batch").placeholder).toBe("1000");
    expect(hintIn(card, "Max entries to combine. · Default 1000")).not.toBeNull();
    expect(field(0, "recombine-size").placeholder).toBe("0 (unlimited)");
    expect(hintIn(card, "Max combined size (bytes). · Default 0 (unlimited)")).not.toBeNull();
    expect(field(0, "recombine-flush").placeholder).toBe("5s");
    expect(hintIn(card, "Emit partial entry after this duration. · Default 5s")).not.toBeNull();
    expect(field(0, "recombine-overwrite")).toHaveTextContent("Oldest entry");
    expect(hintIn(card, "Which entry's fields to keep. · Default oldest")).not.toBeNull();
    expect(hintIn(card, 'Field to identify log source (for interleaved logs). · Default attributes["log.file.path"]')).not.toBeNull();
    // Combine Field is required and the seed writes body: it shows no default.
    expect(hintIn(card, "Field to combine.")).not.toBeNull();
  });

  it("typing a First Entry Pattern removes is_last_entry, in one change, with no alert (config.go:73-79)", async () => {
    const user = renderTransforms();
    await typeInto(user, field(RECOMBINE, "recombine-first"), "body matches \"^\\\\d\"");
    expect(text()).toBe(
      CORPUS.replace("        is_last_entry: 'body matches \"}$\"'\n", "").replace(RECOMBINE_TAIL, `${RECOMBINE_TAIL}        is_first_entry: body matches "^\\\\d"\n`),
    );
    expect(entries()).toBe(1);
    expect(operatorsOf(text())[RECOMBINE]!.is_last_entry).toBeUndefined();
    expect(within(cardOf("op-12-recombine-first")).queryByText(/Removed/)).toBeNull();
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("typing a Last Entry Pattern removes is_first_entry (the seed's), in one change", async () => {
    const base = withTransforms([JSON.stringify(operatorSeed("recombine"))]);
    const user = renderTransforms(base);
    await typeInto(user, field(0, "recombine-last"), "body matches \"}$\"");
    expect(operatorsOf(text())[0]).toEqual({ type: "recombine", combine_field: "body", is_last_entry: 'body matches "}$"' });
    expect(entries()).toBe(1);
  });
});

describe("the other defaults and required fields (D9b decision 3)", () => {
  it("sanitize_utf8's unset Field shows the collector's body (sanitizeutf8/transformer.go:37)", () => {
    renderTransforms(withTransforms(["{type: sanitize_utf8}"]));
    expect(hintIn(cardOf("op-0-sanitize-utf8-field"), "String field to sanitize. · Default body")).not.toBeNull();
    expect(field(0, "sanitize-utf8-field-custom").placeholder).toBe("body");
  });

  it("assign_keys' Field shows no default; Remove is disabled at one key (assignkeys/config.go:51-53)", () => {
    renderTransforms(withTransforms(["{type: assign_keys, keys: [only]}"]));
    const card = cardOf("op-0-assign-keys-field");
    expect(hintIn(card, "Field containing the list to transform.")).not.toBeNull();
    expect(within(card).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(field(0, "assign-keys-key-0").placeholder).toBe("key1");
  });

  it("filter's unset Drop Ratio keeps its placeholder and shows Default 1.0 (filter/config.go:38)", () => {
    renderTransforms(withTransforms(["{type: filter, expr: 'true'}"]));
    expect(field(0, "filter-ratio").placeholder).toBe("1.0 (drop all)");
    expect(hintIn(cardOf("op-0-filter-ratio"), "Fraction of matching entries to drop (0.0-1.0). · Default 1.0")).not.toBeNull();
  });
});

// ── A card moved by keyboard (Preflight ruling 25), as `operators.test.tsx` drags one ──

const ROW_HEIGHT = 40;
let dragFrom = 0;

function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (parent?.classList.contains("space-y-3") && [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))) {
      return e;
    }
  }
  return null;
}

const rowIndex = (element: Element) => {
  const row = rowOf(element);
  return row ? [...row.parentElement!.children].indexOf(row) : 0;
};

/** dnd-kit measures rows; jsdom's are all zero, so rows are laid out 40 px apart. */
function layOutRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = this.closest(".ring-blue-400") ? dragFrom : rowIndex(this);
    const top = index * ROW_HEIGHT;
    return { x: 0, y: top, top, left: 0, right: 200, bottom: top + ROW_HEIGHT, width: 200, height: ROW_HEIGHT, toJSON: () => ({}) } as DOMRect;
  });
}

async function press(element: Element, key: string, code = key) {
  await act(async () => {
    fireEvent.keyDown(element, { key, code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function dragByKeyboard(handle: HTMLElement, steps: number) {
  dragFrom = rowIndex(handle);
  act(() => handle.focus());
  await press(handle, " ", "Space");
  for (let i = 0; i < Math.abs(steps); i++) await press(handle, steps > 0 ? "ArrowDown" : "ArrowUp");
  await press(handle, " ", "Space");
}

// ── Opening writes nothing (D9b decision 2) ──

describe("opening and expanding each transformer and flow operator card writes nothing", () => {
  const TEXTS = [
    ["the corpus", CORPUS],
    ["the corpus in CRLF", CRLF(CORPUS)],
    ["the seeds, every other field unset", SEEDS],
  ] as const;

  // One test per form and text, each with its own time limit (D9c Ruling 54).
  it.each(TRANSFORM_TYPES.flatMap((type, card) => TEXTS.map(([name, base]) => [type, name, card, base] as const)))(
    "%s on %s: collapsed, expanded, every field focused and left",
    async (_type, _name, card, base) => {
      const user = renderTransforms(base);
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
  it("puts no config value in any attribute across the transformer and flow cards, every menu opened", async () => {
    const MARK = "zq-mark";
    const base = withTransforms([
      `{type: add, id: ${MARK}-id, field: attributes.${MARK}-field, value: ${MARK}-value}`,
      `{type: copy, from: body.${MARK}-from, to: ${MARK}-to}`,
      `{type: move, from: resource.${MARK}-mfrom, to: 'attributes["${MARK}.mto"]'}`,
      `{type: remove, field: attributes.${MARK}-remove}`,
      `{type: retain, fields: [body.${MARK}-retain, ${MARK}-custom]}`,
      `{type: flatten, field: body.${MARK}-flat, depth: ${MARK}-depth}`,
      `{type: unquote, field: body.${MARK}-unquote}`,
      `{type: regex_replace, field: body.${MARK}-rr, regex_name: ${MARK}-name, replace_with: ${MARK}-with}`,
      `{type: sanitize_utf8, field: attributes.${MARK}-utf}`,
      `{type: assign_keys, field: body.${MARK}-list, keys: [${MARK}-key]}`,
      `{type: filter, expr: ${MARK}-expr, drop_ratio: ${MARK}-ratio}`,
      `{type: router, routes: [{expr: ${MARK}-route, output: ${MARK}-out}, {expr: ${MARK}-route2}], default: ${MARK}-default}`,
      `{type: recombine, combine_field: body.${MARK}-comb, combine_with: ${MARK}-sep, is_first_entry: ${MARK}-first, source_identifier: attributes.${MARK}-src, max_batch_size: ${MARK}-batch, max_log_size: ${MARK}-size, force_flush_period: ${MARK}-flush, overwrite_with: ${MARK}-ow}`,
      `{type: noop, id: ${MARK}-noop}`,
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

    const user = renderTransforms(base);
    for (const marker of [
      "-id", "-field", "-value", "-from", "-to", "-mfrom", ".mto", "-remove", "-retain", "-custom", "-flat", "-unquote", "-rr",
      "-name", "-with", "-utf", "-list", "-key", "-expr", "-ratio", "-route", "-out", "-route2", "-default", "-comb", "-sep",
      "-first", "-src", "-batch", "-size", "-flush", "-ow", "-noop",
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

// ── The Task 7 review's fixes (D9c Rulings 67 and 70) ──

describe("filter's example reads the service.name key (Ruling 67; decision 4)", () => {
  it("resource[\"service.name\"], not the nested path resource.service.name", () => {
    renderTransforms();
    const card = cardOf("op-10-filter-expr");
    expect(within(card).getByText('resource["service.name"] == "noisy-service"')).toBeInTheDocument();
    expect(within(card).queryByText(/resource\.service\.name/)).toBeNull();
  });
});

describe("the review's hints (Ruling 70)", () => {
  const EMPTY_JOIN = "Empty: entries are joined directly.";
  const WITH_EMPTY = CORPUS.replace('        combine_with: "\\t"\n', '        combine_with: ""\n');

  it("recombine: an empty combine_with says entries are joined directly, not the default newline (recombine.md:16, 45)", () => {
    renderTransforms(WITH_EMPTY);
    const card = cardOf("op-12-recombine-with");
    expect(field(RECOMBINE, "recombine-with").value).toBe("");
    expect(field(RECOMBINE, "recombine-with").placeholder).toBe("");
    expect(hintIn(card, EMPTY_JOIN)).not.toBeNull();
    expect(hintIn(card, "Separator between entries. · Default \\n")).toBeNull();
    expect(hintIn(card, "Separator between entries.")).not.toBeNull();
  });

  it("recombine: unset and set combine_with show no such hint; clearing an empty one still removes the key", async () => {
    renderTransforms(withTransforms([JSON.stringify(operatorSeed("recombine"))]));
    expect(hintIn(cardOf("op-0-recombine-with"), EMPTY_JOIN)).toBeNull();
    expect(hintIn(cardOf("op-0-recombine-with"), "Separator between entries. · Default \\n")).not.toBeNull();
  });

  it("recombine: typing into an empty combine_with, then clearing, removes the key", async () => {
    const user = renderTransforms(WITH_EMPTY);
    await typeInto(user, field(RECOMBINE, "recombine-with"), "|");
    expect(text()).toBe(CORPUS.replace('        combine_with: "\\t"\n', '        combine_with: "|"\n'));
    await retypeInto(user, field(RECOMBINE, "recombine-with"), "");
    expect(text()).toBe(CORPUS.replace('        combine_with: "\\t"\n', ""));
  });

  it.each([
    ['"42"', "42"],
    ['"true"', "true"],
    ["'1.0'", "1.0"],
  ])("add: a quoted string %s that reads as a number or boolean says Written as a string.", (written, shown) => {
    renderTransforms(CORPUS.replace(ADD_VALUE, `        value: ${written}\n`));
    expect(field(ADD, "add-value").value).toBe(shown);
    expect(hintIn(cardOf("op-0-add-value"), "Written as a string.")).not.toBeNull();
  });

  it.each([
    ["a string", '"production"'],
    ["a number", "42"],
    ["a boolean", "true"],
    ["a flow mapping", '{"k": "v"}'],
  ])("add: %s shows no such hint", (_name, written) => {
    renderTransforms(CORPUS.replace(ADD_VALUE, `        value: ${written}\n`));
    expect(hintIn(cardOf("op-0-add-value"), "Written as a string.")).toBeNull();
  });

  it("add: retyping the quoted string's characters writes the number, and the hint goes", async () => {
    const user = renderTransforms(CORPUS.replace(ADD_VALUE, '        value: "42"\n'));
    await retypeInto(user, field(ADD, "add-value"), "42");
    expect(operatorsOf(text())[ADD]!.value).toBe(42);
    expect(hintIn(cardOf("op-0-add-value"), "Written as a string.")).toBeNull();
  });

  const NO_DEFAULT = "Entries no route matches are dropped until a default output is set.";

  it("router: an unset Default Output says what no route matches goes to (router/transformer.go:98-118, 160-161)", async () => {
    const base = CORPUS.replace("        default: kept\n", "");
    const user = renderTransforms(base);
    const card = cardOf("op-11-router-default");
    expect(hintIn(card, NO_DEFAULT)).not.toBeNull();
    await typeInto(user, field(ROUTER, "router-default"), "kept");
    expect(hintIn(card, NO_DEFAULT)).toBeNull();
  });

  it("router: a set Default Output shows no such hint", () => {
    renderTransforms();
    expect(hintIn(cardOf("op-11-router-default"), NO_DEFAULT)).toBeNull();
  });

  it("sanitize_utf8: the example shows the escape \\uFFFD as text", () => {
    renderTransforms();
    const card = cardOf("op-8-sanitize-utf8-field");
    expect(within(card).getByText("\\uFFFD")).toBeInTheDocument();
    expect(within(card).getByText("\\uFFFD").tagName).toBe("CODE");
  });
});
