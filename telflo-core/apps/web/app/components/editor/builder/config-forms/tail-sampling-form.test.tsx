import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSET_OPTION, UNSHOWABLE_VALUE_MESSAGE, useComponentForm, WRITTEN_OPTION } from "./form-context.js";
import { formFor } from "./registry.js";
import {
  AND_EMPTY_HINT,
  BOUNDS_HINT,
  DROP_EMPTY_HINT,
  ERROR_MODE_UNSET_HINT,
  NO_MAXIMUM_HINT,
  NO_MINIMUM_HINT,
  POLICIES_INFO,
  POLICY_TYPE_KEYS,
  TailSamplingForm,
} from "./TailSamplingForm.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The tail sampling processor: its form over the form contract. Each field
 * is driven as a person would, on the traces corpus text (comments, an
 * anchor and its aliases, flow and block lists) and on a text of the policy
 * types the corpus lacks (a bare `0750` the collector reads as a number, an
 * anchor, flow mappings, an extension's policy), LF and CRLF, and writes
 * only its key.
 *
 * Collector claims cite contrib v0.162.0's `processor/tailsamplingprocessor`
 * (`config.go`, `processor.go`, `internal/sampling/*.go`) and `pkg/ottl`.
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The traces corpus (LF): its tail_sampling has comments, an alias of an anchored block, flow and block lists. */
const CORPUS = LF(corpusText("forms-traces.yaml"));
/** The complex config: its tail_sampling's values are quoted. */
const COMPLEX = LF(corpusText("complex-config.yaml"));

const TS = "processors.tail_sampling";

/** The policy types the corpus lacks, each as a person writes it. */
const TYPES_TEXT = [
  "# The tail sampling policies the traces corpus lacks: comments,",
  "# an anchor and its alias, flow mappings and a bare 0750.",
  "x-states: &states [premium, enterprise]",
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc:",
  "processors:",
  "  tail_sampling:",
  "    num_traces: 0750 # a number to the collector",
  "    decision_cache:",
  "      sampled_cache_size: 1000",
  "      non_sampled_cache_size: 5000",
  "    policies:",
  "      - name: http-errors # in range",
  "        type: numeric_attribute",
  "        numeric_attribute:",
  "          key: http.status_code",
  "          min_value: 400",
  "          max_value: 599",
  "      - name: flagged",
  "        type: boolean_attribute",
  "        boolean_attribute: {key: error, value: true}",
  "      - name: tenants",
  "        type: trace_state",
  "        trace_state:",
  "          key: tenant",
  "          values: *states",
  "      - name: big",
  "        type: span_count",
  "        span_count:",
  "          min_spans: 2",
  "          max_spans: 0750 # a number to the collector",
  "      - name: budget",
  "        type: composite",
  "        composite:",
  "          max_total_spans_per_second: 1000",
  "          policy_order: [budget-a] # never read",
  "          composite_sub_policy:",
  "            - name: budget-a",
  "              type: always_sample",
  "          rate_allocation:",
  "            - policy: budget-a",
  "              percent: 100",
  "      - name: limited",
  "        type: rate_limiting",
  "        rate_limiting:",
  "          spans_per_second: 100",
  "          burst_capacity: 400 # twice the default",
  "      - name: not-slow",
  "        type: not",
  "        not:",
  "          not_sub_policy: {name: slow, type: latency, latency: {threshold_ms: 500}}",
  "      - name: bytes",
  "        type: bytes_limiting",
  "        bytes_limiting: {bytes_per_second: 1024000, burst_capacity: 2048000}",
  "      - name: custom # an extension's policy",
  "        type: my_sampler",
  "        my_sampler:",
  "          ratio: 5",
  "      - name: everything",
  "        type: always_sample",
  "exporters:",
  "  debug:",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      processors: [tail_sampling]",
  "      exporters: [debug]",
  "",
].join("\n");

/** A text holding only a tail_sampling of `lines` (at four spaces), in a traces pipeline. */
function ownText(lines: string): string {
  const body = lines.trimEnd() === "" ? ["  tail_sampling: {}"] : ["  tail_sampling:", lines.trimEnd()];
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    "processors:",
    ...body,
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      processors: [tail_sampling]",
    "      exporters: [debug]",
    "",
  ].join("\n");
}

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

const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);
const errorToasts = () => vi.mocked(toast.error).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderForm(text = CORPUS, options?: Parameters<typeof userEvent.setup>[0]) {
  openText(text);
  const user = userEvent.setup(options);
  render(
    <ComponentForm nodeId={componentNamed(TS).id}>
      <TailSamplingForm />
    </ComponentForm>,
  );
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const tailSampling = (written = text()): Value =>
  (parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>).processors!.tail_sampling!;
const policies = (written = text()) => tailSampling(written).policies as Value[];
/** A hint line, by its whole text ("… · Default 30s" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const queryHint = (whole: string) => screen.queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** `typed` with user-event's special characters (`{`, `[`) escaped. */
const escapeKeys = (typed: string) => typed.replace(/[{[]/g, (c) => c + c);

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, escapeKeys(typed));
  await user.tab();
}

/** Types into an empty field and leaves it. */
async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.click(input);
  await user.keyboard(escapeKeys(typed));
  await user.tab();
}

/** The cards' expand buttons, in order. */
const toggles = () => screen.getAllByRole("button", { name: /^(Expand|Collapse) policy$/ });

/** Expands card `index` (the first starts expanded). */
async function expand(user: UserEvent, index: number) {
  const button = toggles()[index]!;
  if (button.getAttribute("aria-expanded") === "false") await user.click(button);
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${title}\\s*\\d*$`) }).at(-1)!);
}

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  /** The text the case runs on (LF). */
  base: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the tail_sampling value after, as parsed. */
  check: (value: Value) => void;
}

const policy = (value: Value, index: number) => (value.policies as Value[])[index]!;
const block = (value: Value, index: number, type: string) => policy(value, index)[type] as Value;

const CASES: FieldCase[] = [
  // the top level, on the traces corpus
  {
    name: "Decision Wait",
    base: CORPUS,
    edit: (user) => retypeInto(user, byId("decision-wait"), "20s"),
    from: "    decision_wait: 10s\n",
    to: "    decision_wait: 20s\n",
    check: (v) => expect(v.decision_wait).toBe("20s"),
  },
  {
    name: "Traces in Memory",
    base: CORPUS,
    edit: (user) => retypeInto(user, byId("num-traces"), "60000"),
    from: "    num_traces: 50000\n",
    to: "    num_traces: 60000\n",
    check: (v) => expect(v.num_traces).toBe(60000),
  },
  {
    name: "Traces in Memory over a bare 0750, its comment kept",
    base: TYPES_TEXT,
    edit: (user) => retypeInto(user, byId("num-traces"), "1000"),
    from: "    num_traces: 0750 # a number to the collector\n",
    to: "    num_traces: 1000 # a number to the collector\n",
    check: (v) => expect(v.num_traces).toBe(1000),
  },
  {
    name: "Expected New Traces Per Second",
    base: CORPUS,
    edit: (user) => retypeInto(user, byId("expected-traces"), "20"),
    from: "    expected_new_traces_per_sec: 10\n",
    to: "    expected_new_traces_per_sec: 20\n",
    check: (v) => expect(v.expected_new_traces_per_sec).toBe(20),
  },
  {
    name: "Sampled Decision Cache Size",
    base: CORPUS,
    edit: async (user) => {
      await openSection(user, "Advanced: Cache & Tuning");
      await retypeInto(user, byId("sampled-cache-size"), "200000");
    },
    from: "      sampled_cache_size: 100000\n",
    to: "      sampled_cache_size: 200000\n",
    check: (v) => expect(v.decision_cache).toEqual({ sampled_cache_size: 200000 }),
  },
  {
    name: "Non-Sampled Decision Cache Size (unset)",
    base: CORPUS,
    edit: async (user) => {
      await openSection(user, "Advanced: Cache & Tuning");
      await typeInto(user, byId("non-sampled-cache-size"), "5000");
    },
    from: "      sampled_cache_size: 100000\n",
    to: "      sampled_cache_size: 100000\n      non_sampled_cache_size: 5000\n",
    check: (v) =>
      expect(v.decision_cache).toEqual({
        sampled_cache_size: 100000,
        non_sampled_cache_size: 5000,
      }),
  },
  {
    name: "Stop on First Match (unset)",
    base: CORPUS,
    edit: async (user) => {
      await openSection(user, "Advanced: Cache & Tuning");
      await user.click(byId("sample-on-first-match"));
    },
    from: "        type: trace_flags\n",
    to: "        type: trace_flags\n    sample_on_first_match: true\n",
    check: (v) => expect(v.sample_on_first_match).toBe(true),
  },
  // the corpus's policies
  {
    name: "Policy Name, its comment kept",
    base: CORPUS,
    edit: (user) => retypeInto(user, byId("policy-0-name"), "fails"),
    from: "      - name: errors # keep every failure\n",
    to: "      - name: fails # keep every failure\n",
    check: (v) => expect(policy(v, 0).name).toBe("fails"),
  },
  {
    name: "status_code OK ticked, appended to its flow list",
    base: CORPUS,
    edit: (user) => user.click(byId("policy-0-status-0")),
    from: "          status_codes: [ERROR]\n",
    to: "          status_codes: [ERROR, OK]\n",
    check: (v) =>
      expect(block(v, 0, "status_code")).toEqual({
        status_codes: ["ERROR", "OK"],
      }),
  },
  {
    name: "latency Upper Threshold (unset) under an alias: the policy gets its own copy, the anchor stays",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 1);
      await typeInto(user, byId("policy-1-upper-threshold"), "2000");
    },
    from: "      - name: slow\n        type: latency\n        latency: *slow\n",
    to: "      - name: slow\n        type: latency\n        latency:\n          threshold_ms: 1000\n          upper_threshold_ms: 2000\n",
    check: (v) =>
      expect(block(v, 1, "latency")).toEqual({
        threshold_ms: 1000,
        upper_threshold_ms: 2000,
      }),
  },
  {
    name: "probabilistic Sampling Percentage",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 2);
      await retypeInto(user, byId("policy-2-sampling-percentage"), "25");
    },
    from: "          sampling_percentage: 10\n",
    to: "          sampling_percentage: 25\n",
    check: (v) => expect(block(v, 2, "probabilistic")).toEqual({ sampling_percentage: 25 }),
  },
  {
    name: "string_attribute Attribute Key",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 3);
      await retypeInto(user, byId("policy-3-key"), "http.target");
    },
    from: "          key: http.route\n",
    to: "          key: http.target\n",
    check: (v) => expect(block(v, 3, "string_attribute").key).toBe("http.target"),
  },
  {
    name: "string_attribute Values: a line typed after Enter is appended; enabled_regex_matching kept",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 3);
      await user.click(byId("policy-3-values"));
      await user.keyboard("{End}{Control>}{End}{/Control}{Enter}/cart");
      await user.tab();
    },
    from: "            - /pay\n",
    to: "            - /pay\n            - /cart\n",
    check: (v) =>
      expect(block(v, 3, "string_attribute")).toEqual({
        key: "http.route",
        values: ["/checkout", "/pay", "/cart"],
        enabled_regex_matching: false,
      }),
  },
  {
    name: "rate_limiting Spans Per Second",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 4);
      await retypeInto(user, byId("policy-4-spans-per-second"), "600");
    },
    from: "          spans_per_second: 500\n",
    to: "          spans_per_second: 600\n",
    check: (v) => expect(block(v, 4, "rate_limiting")).toEqual({ spans_per_second: 600 }),
  },
  {
    name: "ottl_condition Error Mode",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 5);
      await user.selectOptions(byId("policy-5-error-mode"), "propagate");
    },
    from: "          error_mode: ignore\n",
    to: "          error_mode: propagate\n",
    check: (v) => expect(block(v, 5, "ottl_condition").error_mode).toBe("propagate"),
  },
  {
    name: "ottl_condition Span Conditions, written as typed",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 5);
      await retypeInto(user, byId("policy-5-span"), 'span.attributes["http.status_code"] >= 501');
    },
    from: '            - span.attributes["http.status_code"] >= 500\n',
    to: '            - span.attributes["http.status_code"] >= 501\n',
    check: (v) => expect(block(v, 5, "ottl_condition").span).toEqual(['span.attributes["http.status_code"] >= 501']),
  },
  {
    name: "ottl_condition Span Event Conditions (unset)",
    base: CORPUS,
    edit: async (user) => {
      await expand(user, 5);
      await typeInto(user, byId("policy-5-spanevent"), 'name == "exception"');
    },
    from: '            - span.attributes["http.status_code"] >= 500\n',
    to: '            - span.attributes["http.status_code"] >= 500\n          spanevent:\n            - name == "exception"\n',
    check: (v) => expect(block(v, 5, "ottl_condition").spanevent).toEqual(['name == "exception"']),
  },
  // the other types
  {
    name: "numeric_attribute Attribute Key, the card's comment kept",
    base: TYPES_TEXT,
    edit: (user) => retypeInto(user, byId("policy-0-key"), "http.code"),
    from: "          key: http.status_code\n",
    to: "          key: http.code\n",
    check: (v) => expect(block(v, 0, "numeric_attribute").key).toBe("http.code"),
  },
  {
    name: "numeric_attribute Minimum Value",
    base: TYPES_TEXT,
    edit: (user) => retypeInto(user, byId("policy-0-min-value"), "500"),
    from: "          min_value: 400\n",
    to: "          min_value: 500\n",
    check: (v) => expect(block(v, 0, "numeric_attribute").min_value).toBe(500),
  },
  {
    name: "numeric_attribute Maximum Value",
    base: TYPES_TEXT,
    edit: (user) => retypeInto(user, byId("policy-0-max-value"), "999"),
    from: "          max_value: 599\n",
    to: "          max_value: 999\n",
    check: (v) => expect(block(v, 0, "numeric_attribute").max_value).toBe(999),
  },
  {
    name: "numeric_attribute Invert Match (unset)",
    base: TYPES_TEXT,
    edit: (user) => user.click(byId("policy-0-invert-match")),
    from: "          max_value: 599\n",
    to: "          max_value: 599\n          invert_match: true\n",
    check: (v) => expect(block(v, 0, "numeric_attribute").invert_match).toBe(true),
  },
  {
    name: "boolean_attribute Attribute Key in a flow mapping",
    base: TYPES_TEXT,
    edit: async (user) => {
      await expand(user, 1);
      await retypeInto(user, byId("policy-1-key"), "failed");
    },
    from: "        boolean_attribute: {key: error, value: true}\n",
    to: "        boolean_attribute: {key: failed, value: true}\n",
    check: (v) =>
      expect(block(v, 1, "boolean_attribute")).toEqual({
        key: "failed",
        value: true,
      }),
  },
  {
    name: "boolean_attribute Expected Value, written as a boolean",
    base: TYPES_TEXT,
    edit: async (user) => {
      await expand(user, 1);
      await user.selectOptions(byId("policy-1-value"), "false");
    },
    from: "        boolean_attribute: {key: error, value: true}\n",
    to: "        boolean_attribute: {key: error, value: false}\n",
    check: (v) =>
      expect(block(v, 1, "boolean_attribute")).toEqual({
        key: "error",
        value: false,
      }),
  },
  {
    name: "trace_state Trace State Key",
    base: TYPES_TEXT,
    edit: async (user) => {
      await expand(user, 2);
      await retypeInto(user, byId("policy-2-key"), "plan");
    },
    from: "          key: tenant\n",
    to: "          key: plan\n",
    check: (v) =>
      expect(block(v, 2, "trace_state")).toEqual({
        key: "plan",
        values: ["premium", "enterprise"],
      }),
  },
  {
    name: "span_count Minimum Spans",
    base: TYPES_TEXT,
    edit: async (user) => {
      await expand(user, 3);
      await retypeInto(user, byId("policy-3-min-spans"), "3");
    },
    from: "          min_spans: 2\n",
    to: "          min_spans: 3\n",
    check: (v) => expect(block(v, 3, "span_count").min_spans).toBe(3),
  },
  {
    name: "span_count Maximum Spans over a bare 0750, its comment kept",
    base: TYPES_TEXT,
    edit: async (user) => {
      await expand(user, 3);
      await retypeInto(user, byId("policy-3-max-spans"), "100");
    },
    from: "          max_spans: 0750 # a number to the collector\n",
    to: "          max_spans: 100 # a number to the collector\n",
    check: (v) =>
      expect(block(v, 3, "span_count")).toEqual({
        min_spans: 2,
        max_spans: 100,
      }),
  },
  {
    name: "composite Max Total Spans Per Second; policy_order kept",
    base: TYPES_TEXT,
    edit: async (user) => {
      await expand(user, 4);
      await retypeInto(user, byId("policy-4-max-total-spans"), "2000");
    },
    from: "          max_total_spans_per_second: 1000\n",
    to: "          max_total_spans_per_second: 2000\n",
    check: (v) => {
      expect(block(v, 4, "composite").max_total_spans_per_second).toBe(2000);
      expect(block(v, 4, "composite").policy_order).toEqual(["budget-a"]);
    },
  },
  {
    name: "rate_limiting Spans Per Second keeps burst_capacity (the block isn't rebuilt)",
    base: TYPES_TEXT,
    edit: async (user) => {
      await expand(user, 5);
      await retypeInto(user, byId("policy-5-spans-per-second"), "200");
    },
    from: "          spans_per_second: 100\n",
    to: "          spans_per_second: 200\n",
    check: (v) =>
      expect(block(v, 5, "rate_limiting")).toEqual({
        spans_per_second: 200,
        burst_capacity: 400,
      }),
  },
];

describe("every field writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(c.base) : c.base;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(tailSampling());
      expect(infoToasts()).toEqual([]);
      expect(errorToasts()).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );

  it("the complex config: the quoted Decision Wait and a quoted policy name are retyped in place", async () => {
    const user = renderForm(COMPLEX);
    await retypeInto(user, byId("decision-wait"), "45s");
    await retypeInto(user, byId("policy-0-name"), "errors");
    const value = tailSampling();
    expect(value.decision_wait).toBe("45s");
    expect(policy(value, 0)).toEqual({
      name: "errors",
      type: "status_code",
      status_code: { status_codes: ["ERROR"] },
    });
    const changed = LF(text())
      .split("\n")
      .filter((line, index) => line !== COMPLEX.split("\n")[index]);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toMatch(/^ {4}decision_wait: '?45s'?$/);
    expect(changed[1]).toMatch(/^ {6}- name: '?errors'?$/);
  });
});

// ── Opening writes nothing ──

describe("opening writes nothing", () => {
  // One test per text, each with its own time limit.
  it.each([
    ["the traces corpus", CORPUS, 9],
    ["the traces corpus, CRLF", CRLF(CORPUS), 9],
    ["the complex config", COMPLEX, 3],
    ["the other types", TYPES_TEXT, 10],
    ["the other types, CRLF", CRLF(TYPES_TEXT), 10],
  ] as const)(
    "opening %s, every card and section, focusing every field, writes nothing and leaves the editor clean",
    async (_name, base, cards) => {
      const user = renderForm(base);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", {
          expanded: false,
        }))
          await user.click(button);
      }
      expect(toggles()).toHaveLength(cards);
      expect(toggles().every((button) => button.getAttribute("aria-expanded") === "true")).toBe(true);
      const { textboxes, all } = formControls();
      expect(textboxes.length).toBeGreaterThanOrEqual(cards + 5);
      expect(all).toBeGreaterThanOrEqual(cards * 2 + 6);
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );
});

// ── The type switch ──

/** A policy `p` of `type` with `lines` (at eight spaces), in a text of its own. */
function onePolicy(type: string, lines = ""): string {
  return ownText(["    policies:", "      - name: p # the policy", `        type: ${type}`, ...(lines ? [lines] : [])].join("\n"));
}

const SHARED_TYPES = [
  "always_sample",
  "latency",
  "numeric_attribute",
  "probabilistic",
  "status_code",
  "string_attribute",
  "rate_limiting",
  "bytes_limiting",
  "span_count",
  "trace_state",
  "boolean_attribute",
  "ottl_condition",
  "trace_flags",
];

interface SeedCase {
  type: string;
  /** The policy after the switch (from a latency policy; to latency, from probabilistic). */
  item: Value;
  /** Why the collector builds it at v0.162.0. */
  rule: string;
  builds: (item: Value) => boolean;
}

const SEEDS: SeedCase[] = [
  {
    type: "always_sample",
    item: { name: "p", type: "always_sample" },
    rule: "processor.go:382-383: NewAlwaysSample takes no config",
    builds: (item) => Object.keys(item).length === 2,
  },
  {
    type: "probabilistic",
    item: {
      name: "p",
      type: "probabilistic",
      probabilistic: { sampling_percentage: 10 },
    },
    rule: "processor.go:397-399: NewProbabilisticSampler returns no error",
    builds: (item) => typeof (item.probabilistic as Value).sampling_percentage === "number",
  },
  {
    type: "status_code",
    item: {
      name: "p",
      type: "status_code",
      status_code: { status_codes: ["ERROR"] },
    },
    rule: "internal/sampling/status_code.go:30-46: at least one code, each exactly OK, ERROR or UNSET",
    builds: (item) => {
      const codes = (item.status_code as Value).status_codes as string[];
      return codes.length > 0 && codes.every((code) => ["OK", "ERROR", "UNSET"].includes(code));
    },
  },
  {
    type: "latency",
    item: { name: "p", type: "latency", latency: { threshold_ms: 1000 } },
    rule: "processor.go:384-386: NewLatency returns no error",
    builds: (item) => typeof (item.latency as Value).threshold_ms === "number",
  },
  {
    type: "string_attribute",
    item: {
      name: "p",
      type: "string_attribute",
      string_attribute: { key: "service.name", values: [] },
    },
    rule: "internal/sampling/string_tag_filter.go:40-48: only a regex list can be refused, and regex matching is off",
    builds: (item) => (item.string_attribute as Value).enabled_regex_matching === undefined,
  },
  {
    type: "numeric_attribute",
    item: {
      name: "p",
      type: "numeric_attribute",
      numeric_attribute: { key: "", min_value: 0, max_value: 100 },
    },
    rule: "processor.go:387-395 and numeric_tag_filter.go:31-34: a nonzero bound, else no evaluator",
    builds: (item) => {
      const bounds = item.numeric_attribute as Value;
      return bounds.min_value !== 0 || bounds.max_value !== 0;
    },
  },
  {
    type: "boolean_attribute",
    item: {
      name: "p",
      type: "boolean_attribute",
      boolean_attribute: { key: "", value: true },
    },
    rule: "processor.go:424-426: NewBooleanAttributeFilter returns no error; value decodes as a bool",
    builds: (item) => typeof (item.boolean_attribute as Value).value === "boolean",
  },
  {
    type: "trace_state",
    item: {
      name: "p",
      type: "trace_state",
      trace_state: { key: "", values: [] },
    },
    rule: "processor.go:421-423: NewTraceStateFilter returns no error",
    builds: (item) => Array.isArray((item.trace_state as Value).values),
  },
  {
    type: "span_count",
    item: { name: "p", type: "span_count", span_count: { min_spans: 1 } },
    rule: "processor.go:418-420: NewSpanCount returns no error",
    builds: (item) => typeof (item.span_count as Value).min_spans === "number",
  },
  {
    type: "ottl_condition",
    item: {
      name: "p",
      type: "ottl_condition",
      ottl_condition: {
        error_mode: "ignore",
        span: ['span.attributes["http.status_code"] >= 400'],
      },
    },
    rule: "internal/sampling/ottl.go:39-41: at least one span or span event condition; pkg/ottl/config.go:23-31: ignore is a mode",
    builds: (item) => {
      const ottl = item.ottl_condition as Value;
      const count = ((ottl.span as string[] | undefined)?.length ?? 0) + ((ottl.spanevent as string[] | undefined)?.length ?? 0);
      return count > 0 && ["ignore", "silent", "propagate"].includes(ottl.error_mode as string);
    },
  },
  {
    type: "rate_limiting",
    item: {
      name: "p",
      type: "rate_limiting",
      rate_limiting: { spans_per_second: 1000 },
    },
    rule: "processor.go:406-411: NewRateLimiting returns no error",
    builds: (item) => typeof (item.rate_limiting as Value).spans_per_second === "number",
  },
  {
    type: "and",
    item: { name: "p", type: "and", and: { and_sub_policy: [] } },
    rule: "and_helper.go:13-23: each sub-policy is built; none is accepted (and.go: it samples every trace)",
    builds: (item) => Array.isArray((item.and as Value).and_sub_policy),
  },
  {
    type: "composite",
    item: {
      name: "p",
      type: "composite",
      composite: {
        max_total_spans_per_second: 1000,
        composite_sub_policy: [],
        rate_allocation: [],
      },
    },
    rule: "composite_helper.go:14-31: each sub-policy is built; config.go:157: policy_order is never read, so it isn't seeded",
    builds: (item) => !("policy_order" in (item.composite as Value)),
  },
  {
    type: "not",
    item: {
      name: "p",
      type: "not",
      not: {
        not_sub_policy: {
          name: "p-not",
          type: "latency",
          latency: { threshold_ms: 1000 },
        },
      },
    },
    rule: "not_helper.go:13-24: one shared sub-policy (an empty one is refused, processor.go:443)",
    builds: (item) => SHARED_TYPES.includes(((item.not as Value).not_sub_policy as Value).type as string),
  },
  {
    type: "drop",
    item: {
      name: "p",
      type: "drop",
      drop: {
        drop_sub_policy: [
          {
            name: "p-drop",
            type: "string_attribute",
            string_attribute: {
              key: "url.path",
              values: ["/health", "/metrics"],
            },
          },
        ],
      },
    },
    rule: "drop_helper.go:13-33: each sub-policy a shared type or not",
    builds: (item) =>
      ((item.drop as Value).drop_sub_policy as Value[]).every((sub) => [...SHARED_TYPES, "not"].includes(sub.type as string)),
  },
  {
    type: "bytes_limiting",
    item: {
      name: "p",
      type: "bytes_limiting",
      bytes_limiting: { bytes_per_second: 1048576 },
    },
    rule: "processor.go:412-417 and bytes_limiting.go:28-30: NewBytesLimiting returns no error (README.md:315: bytes_per_second required)",
    builds: (item) => ((item.bytes_limiting as Value).bytes_per_second as number) > 0,
  },
  {
    type: "trace_flags",
    item: { name: "p", type: "trace_flags" },
    rule: "processor.go:430-431: NewTraceFlags takes no config",
    builds: (item) => Object.keys(item).length === 2,
  },
];

describe("the type switch (one change, every known block removed, the seed written)", () => {
  it("offers the collector's 17 types (config.go:20-58), the 13 common ones first", () => {
    renderForm(onePolicy("latency", "        latency: {threshold_ms: 5}"));
    const options = within(byId("policy-0-type")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Always Sample",
      "Probabilistic",
      "Status Code",
      "Latency",
      "String Attribute",
      "Numeric Attribute",
      "Boolean Attribute",
      "Trace State",
      "Span Count",
      "OTTL Condition",
      "Rate Limiting",
      "AND",
      "Composite",
      "NOT",
      "Drop",
      "Bytes Limiting",
      "Trace Flags",
    ]);
    expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual([...POLICY_TYPE_KEYS]);
    expect(SEEDS.map((seed) => seed.type).sort()).toEqual([...POLICY_TYPE_KEYS].sort());
  });

  it.each(SEEDS)("switching to $type writes its seed, which the collector builds ($rule)", async ({ type, item, builds }) => {
    const from = type === "latency" ? "        probabilistic: {sampling_percentage: 5}" : "        latency: {threshold_ms: 5}";
    const before = onePolicy(type === "latency" ? "probabilistic" : "latency", from);
    const user = renderForm(before);
    await user.selectOptions(byId("policy-0-type"), type);
    expect(policies()).toEqual([item]);
    expect(builds(policies()[0]!)).toBe(true);
    // The item's first line and its comment stay.
    expect(text()).toContain("      - name: p # the policy\n");
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
    act(() => void builderStore().undo());
    expect(text()).toBe(before);
  });

  it("keeps the item's comments and keys that aren't type blocks (an extension's config), and removes every known block, stray ones too", async () => {
    const before = onePolicy(
      "my_sampler",
      [
        "        # the extension's settings",
        "        my_sampler:",
        "          ratio: 5",
        "        latency: {threshold_ms: 5} # stray",
        "        probabilistic:",
        "          sampling_percentage: 10",
        "        trace_flags: {}",
      ].join("\n"),
    );
    const user = renderForm(before);
    expect(screen.getByText("Configure my_sampler in the YAML editor")).toBeDefined();
    // The extension's type shows as written; its option's value is the token, never the type.
    const select = byId("policy-0-type") as HTMLSelectElement;
    expect(select.value).toBe(WRITTEN_OPTION);
    expect(within(select).getByRole("option", { name: "my_sampler" })).toHaveProperty("value", WRITTEN_OPTION);

    await user.selectOptions(select, "status_code");
    expect(text()).toBe(
      onePolicy(
        "status_code",
        [
          "        # the extension's settings",
          "        my_sampler:",
          "          ratio: 5",
          "        status_code:",
          "          status_codes:",
          "            - ERROR",
        ].join("\n"),
      ),
    );
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
  });

  it("the not and drop seeds name their sub-policy after the policy as written", async () => {
    const user = renderForm(ownText(["    policies:", "      - name: 'checkout api'", "        type: always_sample"].join("\n")));
    await user.selectOptions(byId("policy-0-type"), "not");
    expect((policies()[0]!.not as Value).not_sub_policy).toEqual({
      name: "checkout api-not",
      type: "latency",
      latency: { threshold_ms: 1000 },
    });
    await user.selectOptions(byId("policy-0-type"), "drop");
    expect(((policies()[0]!.drop as Value).drop_sub_policy as Value[])[0]!.name).toBe("checkout api-drop");
    expect(policies()[0]!.not).toBeUndefined();
  });

  it("the card keeps its key through a switch: it stays expanded, and so do the others' states", async () => {
    const user = renderForm(CORPUS);
    await expand(user, 2);
    await user.selectOptions(byId("policy-2-type"), "span_count");
    expect(toggles()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(toggles()[1]!.getAttribute("aria-expanded")).toBe("false");
    expect(toggles()[2]!.getAttribute("aria-expanded")).toBe("true");
    expect(byId("policy-2-min-spans")).toHaveProperty("value", "1");
  });
});

// ── What the text holds that the seeds don't ──

describe("a policy as the text has it (spec: never a throw on a block the form didn't seed)", () => {
  it("a missing block shows its fields unset, and the summary the collector's zero", async () => {
    const before = ownText(
      [
        "    policies:",
        "      - name: a",
        "        type: latency",
        "      - name: b",
        "        type: status_code",
        "      - name: c",
        "        type: ottl_condition",
        "      - name: d",
        "        type: boolean_attribute",
        "      - name: e",
        "        type: numeric_attribute",
      ].join("\n"),
    );
    const user = renderForm(before);
    for (let index = 1; index < 5; index++) await expand(user, index);
    expect(screen.getByText("Latency > 0ms")).toBeDefined();
    expect(byId("policy-0-threshold")).toHaveProperty("value", "");
    expect(screen.getByText("Status:")).toBeDefined();
    expect(["OK", "ERROR", "UNSET"].map((_c, index) => byId(`policy-1-status-${index}`).getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(screen.getByText("OTTL: 0 conditions")).toBeDefined();
    expect(byId("policy-2-error-mode")).toHaveProperty("value", UNSET_OPTION);
    expect(byId("policy-2-span")).toHaveProperty("value", "");
    expect(screen.getByText("= false")).toBeDefined();
    expect(byId("policy-3-value")).toHaveProperty("value", "false");
    expect(screen.getByText(": 0-0")).toBeDefined();
    expect(hint(BOUNDS_HINT)).toBeDefined();
    expect(text()).toBe(before);
    expect(entries()).toBe(0);

    // The first field typed writes the block.
    await typeInto(user, byId("policy-0-threshold"), "250");
    expect(policies()[0]).toEqual({
      name: "a",
      type: "latency",
      latency: { threshold_ms: 250 },
    });
  });

  it("a block, an item or a list it can't show is read-only with the unshowable-value hint; the card still moves and is removed", async () => {
    const user = renderForm(
      ownText(["    policies:", "      - name: a", "        type: latency", "        latency: [1000]", "      - just a string"].join("\n")),
    );
    expect(hint(UNSHOWABLE_VALUE_MESSAGE)).toBeDefined();
    expect(document.getElementById("policy-0-threshold")).toBeNull();
    await expand(user, 1);
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Remove policy" })[1]!);
    expect(policies()).toEqual([{ name: "a", type: "latency", latency: [1000] }]);

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(ownText("    policies: none"));
    expect(hint(UNSHOWABLE_VALUE_MESSAGE)).toBeDefined();
    expect(screen.getByRole("button", { name: "Add Policy" })).toHaveProperty("disabled", true);
  });

  it("a policy with no type shows a blank type and no fields; choosing one writes it with its seed", async () => {
    const user = renderForm(ownText(["    policies:", "      - name: a"].join("\n")));
    const select = byId("policy-0-type") as HTMLSelectElement;
    expect(select.value).toBe(WRITTEN_OPTION);
    expect(select.selectedOptions[0]!.textContent).toBe("");
    expect(screen.queryByText(/YAML editor|No additional configuration/)).toBeNull();
    await user.selectOptions(select, "latency");
    expect(policies()).toEqual([{ name: "a", type: "latency", latency: { threshold_ms: 1000 } }]);
    // A typed type offers no blank option to remove it.
    expect(within(select).queryByRole("option", { name: "" })).toBeNull();
  });

  it("shows each type's summary from the text, OTTL counting span and span event conditions", () => {
    renderForm(
      ownText(
        [
          "    policies:",
          "      - {name: a, type: always_sample}",
          "      - {name: b, type: probabilistic, probabilistic: {sampling_percentage: 12.5}}",
          "      - {name: c, type: status_code, status_code: {status_codes: [ERROR, UNSET]}}",
          "      - {name: d, type: latency, latency: {threshold_ms: 900}}",
          "      - {name: e, type: string_attribute, string_attribute: {key: svc, values: [x]}}",
          "      - {name: f, type: numeric_attribute, numeric_attribute: {key: code, min_value: 400, max_value: 499}}",
          "      - {name: g, type: boolean_attribute, boolean_attribute: {key: err, value: true}}",
          "      - {name: h, type: trace_state, trace_state: {key: tenant, values: [x, y]}}",
          "      - {name: i, type: span_count, span_count: {min_spans: 2, max_spans: 9}}",
          "      - {name: j, type: span_count, span_count: {min_spans: 2}}",
          "      - {name: k, type: ottl_condition, ottl_condition: {span: [a, b], spanevent: [c]}}",
          "      - {name: l, type: rate_limiting, rate_limiting: {spans_per_second: 70}}",
          "      - {name: m, type: and, and: {and_sub_policy: [{name: x, type: always_sample}]}}",
          "      - {name: n, type: composite, composite: {max_total_spans_per_second: 80}}",
          "      - {name: o, type: not}",
          "      - {name: p, type: my_sampler}",
        ].join("\n"),
      ),
    );
    for (const summary of [
      "Always Sample",
      "12.5% sampling",
      "Status: ERROR, UNSET",
      "Latency > 900ms",
      "svc in [...]",
      "code: 400-499",
      "err = true",
      "TraceState tenant in [2 values]",
      "2-9 spans",
      ">= 2 spans",
      "OTTL: 3 conditions",
      "70 spans/sec",
      "AND (1 sub-policies)",
      "Composite: 80 spans/sec",
      "not",
      "my_sampler",
    ]) {
      expect(screen.getByText(summary, { selector: "div" })).toBeDefined();
    }
  });
});

// ── Add, remove, move ──

describe("the policy cards", () => {
  it("Add Policy appends the probabilistic policy under the first unused policy-N, expanded, one entry", async () => {
    const before = ownText(["    policies:", "      - name: policy-2 # typed", "        type: always_sample"].join("\n"));
    const user = renderForm(before);
    await user.click(screen.getByRole("button", { name: "Add Policy" }));
    // Not policy-2 (its length + 1): the collector refuses a repeated name (processor.go:248-250).
    expect(policies()).toEqual([
      { name: "policy-2", type: "always_sample" },
      {
        name: "policy-3",
        type: "probabilistic",
        probabilistic: { sampling_percentage: 10 },
      },
    ]);
    expect(entries()).toBe(1);
    expect(toggles()[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(byId("policy-1-name")).toHaveProperty("value", "policy-3");
  });

  it("after a remove, Add never repeats a name", async () => {
    const user = renderForm(
      ownText(
        ["    policies:", "      - {name: policy-1, type: always_sample}", "      - {name: policy-2, type: always_sample}"].join("\n"),
      ),
    );
    await user.click(screen.getAllByRole("button", { name: "Remove policy" })[0]!);
    await user.click(screen.getByRole("button", { name: "Add Policy" }));
    await user.click(screen.getByRole("button", { name: "Add Policy" }));
    expect(policies().map((p) => p.name)).toEqual(["policy-2", "policy-3", "policy-4"]);
    expect(new Set(policies().map((p) => p.name)).size).toBe(3);
  });

  it("Add Policy with no policies writes the list; removing the last leaves [] and shows the empty line", async () => {
    const before = ownText("    decision_wait: 10s");
    const user = renderForm(before);
    expect(screen.getByText("No policies configured")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Add Policy" }));
    expect(policies()).toEqual([
      {
        name: "policy-1",
        type: "probabilistic",
        probabilistic: { sampling_percentage: 10 },
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Remove policy" }));
    expect(tailSampling().policies).toEqual([]);
    expect(screen.getByText("No policies configured")).toBeDefined();
  });

  it("removing a policy removes its own lines, its comment with it; the next card keeps its state", async () => {
    const user = renderForm(CORPUS);
    await expand(user, 1);
    await user.click(toggles()[0]!);
    await user.click(screen.getAllByRole("button", { name: "Remove policy" })[0]!);
    expect(text()).toBe(
      CORPUS.replace(
        "      - name: errors # keep every failure\n        type: status_code\n        status_code:\n          status_codes: [ERROR]\n",
        "",
      ),
    );
    expect(entries()).toBe(1);
    // slow's card, expanded before, is now first and still expanded.
    expect(toggles()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(byId("policy-0-name")).toHaveProperty("value", "slow");
  });

  it("the first card starts expanded and the others collapsed; the toggle's label and aria-expanded follow it", async () => {
    const user = renderForm(CORPUS);
    expect(toggles().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Collapse policy",
      ...Array.from({ length: 8 }, () => "Expand policy"),
    ]);
    await user.click(toggles()[0]!);
    expect(toggles()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("policy-0-name")).toBeNull();
    expect(text()).toBe(CORPUS);
  });
});

// ── Dragging ──

const ROW_HEIGHT = 40;

/** The sortable card an element is in: a child of the `space-y-2` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (
      parent?.classList.contains("space-y-2") &&
      [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))
    ) {
      return e;
    }
  }
  return null;
}

/** dnd-kit measures rows; jsdom's are all zero, so cards are laid out 40 px apart. */
function layOutRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = rowOf(this);
    const index = row ? [...row.parentElement!.children].indexOf(row) : 0;
    const top = index * ROW_HEIGHT;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + ROW_HEIGHT,
      width: 200,
      height: ROW_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

async function press(element: Element, key: string, code = key) {
  await act(async () => {
    fireEvent.keyDown(element, { key, code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("dragging a policy (form.move)", () => {
  it("moves the policy's own lines, its comment with it, one entry; its expanded state goes with it", async () => {
    layOutRows();
    renderForm(CORPUS);
    const [first] = screen.getAllByRole("button", { name: "Drag to reorder" });
    act(() => first!.focus());
    await press(first!, " ", "Space");
    await press(first!, "ArrowDown");
    await press(first!, " ", "Space");
    const errors =
      "      - name: errors # keep every failure\n        type: status_code\n        status_code:\n          status_codes: [ERROR]\n";
    const slow = "      - name: slow\n        type: latency\n        latency: *slow\n";
    expect(text()).toBe(CORPUS.replace(errors + slow, slow + errors));
    expect(entries()).toBe(1);
    expect(
      policies()
        .map((p) => p.name)
        .slice(0, 2),
    ).toEqual(["slow", "errors"]);
    // The expanded card moved with its policy.
    expect(toggles()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(toggles()[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(byId("policy-1-name")).toHaveProperty("value", "errors");
  });
});

// ── The fields ──

describe("the top level and Advanced", () => {
  it("shows the collector's defaults as placeholders and hints (factory.go:29-37; config.go:310-323)", async () => {
    const user = renderForm(ownText("    policies: []"));
    expect(byId("decision-wait")).toHaveProperty("placeholder", "30s");
    expect(hint("Buffer spans this long before deciding; longer uses more memory. · Default 30s")).toBeDefined();
    expect(byId("num-traces")).toHaveProperty("placeholder", "50000");
    expect(hint("Max concurrent traces held; raise with traffic volume. · Default 50000")).toBeDefined();
    expect(byId("expected-traces")).toHaveProperty("placeholder", "0");
    expect(hint("Hint for memory allocation. · Default 0 (auto)")).toBeDefined();
    await openSection(user, "Advanced: Cache & Tuning");
    expect(byId("sampled-cache-size")).toHaveProperty("placeholder", "0");
    expect(hint("'Keep' decisions cached after traces leave memory; ~24 bytes each. · Default 0 (disabled)")).toBeDefined();
    expect(hint("'Drop' decisions cached; size well above traces in memory. · Default 0 (disabled)")).toBeDefined();
    expect(byId("sample-on-first-match").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Trace affinity required")).toBeDefined();
    expect(screen.getByText(POLICIES_INFO)).toBeDefined();
  });

  it('Decision Wait cleared removes the key (never "", an empty duration the collector refuses)', async () => {
    const user = renderForm(CORPUS);
    await retypeInto(user, byId("decision-wait"), "");
    expect(tailSampling().decision_wait).toBeUndefined();
  });

  it("the last cache size cleared removes decision_cache; Stop on First Match unticked writes false", async () => {
    const user = renderForm(CORPUS);
    await openSection(user, "Advanced: Cache & Tuning");
    await retypeInto(user, byId("sampled-cache-size"), "");
    expect(text()).toBe(CORPUS.replace("    decision_cache:\n      sampled_cache_size: 100000\n", ""));
    await user.click(byId("sample-on-first-match"));
    await user.click(byId("sample-on-first-match"));
    expect(tailSampling().sample_on_first_match).toBe(false);
  });
});

describe("the policy fields", () => {
  it("unticking the last status code leaves [] (status_code.go:30-31 refuses it)", async () => {
    const user = renderForm(CORPUS);
    await user.click(byId("policy-0-status-1"));
    expect(text()).toBe(CORPUS.replace("          status_codes: [ERROR]\n", "          status_codes: []\n"));
  });

  it("a status code outside the three shows ticked, as written, and can be unticked", async () => {
    const user = renderForm(onePolicy("status_code", "        status_code: {status_codes: [ERROR, error]}"));
    expect(screen.getByText("error", { selector: "label" })).toBeDefined();
    await user.click(byId("policy-0-status-3"));
    expect(policies()[0]!.status_code).toEqual({ status_codes: ["ERROR"] });
  });

  it("the newline fields keep a typed line break past the pause and write each line as an item", async () => {
    const user = renderForm(onePolicy("trace_state", "        trace_state:\n          key: tenant"));
    const values = byId("policy-0-values");
    expect(values.getAttribute("placeholder")).toBe("e.g. premium\nenterprise\nvip");
    await user.click(values);
    await user.keyboard("gold{Enter}");
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(values).toHaveProperty("value", "gold\n");
    await user.keyboard("silver");
    await user.tab();
    expect((policies()[0]!.trace_state as Value).values).toEqual(["gold", "silver"]);
  });

  it("trace_state Values under an alias: an edit gives the policy its own list; the anchor stays", async () => {
    const user = renderForm(TYPES_TEXT);
    await expand(user, 2);
    const values = byId("policy-2-values");
    expect(values).toHaveProperty("value", "premium\nenterprise");
    await user.click(values);
    await user.keyboard("{Control>}{End}{/Control}{Enter}vip");
    await user.tab();
    expect((policies()[2]!.trace_state as Value).values).toEqual(["premium", "enterprise", "vip"]);
    expect(text()).toContain("x-states: &states [premium, enterprise]\n");
  });

  it("numeric bounds say 0 is no bound (processor.go:387-395); with neither, ask for one (numeric_tag_filter.go:31-34)", async () => {
    const user = renderForm(onePolicy("numeric_attribute", "        numeric_attribute:\n          key: code\n          min_value: 400"));
    expect(hint(NO_MINIMUM_HINT)).toBeDefined();
    expect(hint(NO_MAXIMUM_HINT)).toBeDefined();
    expect(queryHint(BOUNDS_HINT)).toBeNull();
    await retypeInto(user, byId("policy-0-min-value"), "0");
    expect((policies()[0]!.numeric_attribute as Value).min_value).toBe(0);
    expect(hint(BOUNDS_HINT)).toBeDefined();
    await retypeInto(user, byId("policy-0-min-value"), "");
    expect(hint(BOUNDS_HINT)).toBeDefined();
    await typeInto(user, byId("policy-0-max-value"), "599");
    expect(queryHint(BOUNDS_HINT)).toBeNull();
  });

  it("Expected Value unset shows false, Default false; true is written as a boolean", async () => {
    const user = renderForm(onePolicy("boolean_attribute", "        boolean_attribute:\n          key: error"));
    expect(byId("policy-0-value")).toHaveProperty("value", "false");
    expect(hint("Default false")).toBeDefined();
    await user.selectOptions(byId("policy-0-value"), "true");
    expect(text()).toContain("          key: error\n          value: true\n");
    expect((policies()[0]!.boolean_attribute as Value).value).toBe(true);
  });

  it("OTTL Error Mode: unset blank with its hint (pkg/ottl/parser.go:543-560); ignore, silent, propagate (pkg/ottl/config.go:16-31); blank removes it", async () => {
    const user = renderForm(onePolicy("ottl_condition", "        ottl_condition:\n          span: [a]"));
    const select = byId("policy-0-error-mode") as HTMLSelectElement;
    expect(select.value).toBe(UNSET_OPTION);
    expect(hint(ERROR_MODE_UNSET_HINT)).toBeDefined();
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "",
      "Ignore errors",
      "Ignore errors silently",
      "Propagate errors",
    ]);
    await user.selectOptions(select, "silent");
    expect((policies()[0]!.ottl_condition as Value).error_mode).toBe("silent");
    expect(queryHint(ERROR_MODE_UNSET_HINT)).toBeNull();
    await user.selectOptions(select, UNSET_OPTION);
    expect(policies()[0]!.ottl_condition).toEqual({ span: ["a"] });
    expect(byId("policy-0-span").getAttribute("placeholder")).toBe(
      'attributes["http.status_code"] >= 400\nresource.attributes["service.name"] == "api"',
    );
  });

  it("string_attribute's placeholder has real line breaks (not &#10;)", () => {
    renderForm(onePolicy("string_attribute"));
    expect(byId("policy-0-values").getAttribute("placeholder")).toBe("e.g. frontend\nbackend\napi");
  });

  it("and and drop say what no sub-policies do (and.go, drop.go); composite has no Policy Order (config.go:157)", async () => {
    const user = renderForm(
      ownText(
        [
          "    policies:",
          "      - {name: a, type: and, and: {and_sub_policy: []}}",
          "      - {name: d, type: drop}",
          "      - {name: c, type: composite, composite: {max_total_spans_per_second: 10, policy_order: [x]}}",
          "      - {name: n, type: not}",
          "      - {name: b, type: bytes_limiting}",
          "      - {name: f, type: trace_flags}",
          "      - {name: s, type: always_sample}",
        ].join("\n"),
      ),
    );
    for (let index = 1; index < 7; index++) await expand(user, index);
    expect(hint(AND_EMPTY_HINT)).toBeDefined();
    expect(hint(DROP_EMPTY_HINT)).toBeDefined();
    expect(screen.getAllByText("YAML-only sub-policies")).toHaveLength(2);
    expect(screen.queryByText("Policy Order")).toBeNull();
    expect(byId("policy-2-max-total-spans")).toHaveProperty("value", "10");
    expect(screen.getByText("Configure drop in the YAML editor")).toBeDefined();
    expect(screen.getByText("Configure not in the YAML editor")).toBeDefined();
    expect(screen.getByText("Configure bytes_limiting in the YAML editor")).toBeDefined();
    expect(screen.getAllByText("No additional configuration")).toHaveLength(2);
    expect(entries()).toBe(0);
  });

  it("and and drop with sub-policies show no empty line", async () => {
    const user = renderForm(CORPUS);
    await expand(user, 6);
    await expand(user, 7);
    expect(queryHint(AND_EMPTY_HINT)).toBeNull();
    expect(queryHint(DROP_EMPTY_HINT)).toBeNull();
    expect(screen.getByText("Configure drop in the YAML editor")).toBeDefined();
  });
});

// ── Privacy ──

describe("privacy", () => {
  it("puts no config value in any attribute or option value: every card and section open", async () => {
    const MARK = "zq-mark";
    const marked = ownText(
      [
        `    decision_wait: ${MARK}-wait`,
        `    num_traces: ${MARK}-traces`,
        "    decision_cache:",
        `      sampled_cache_size: ${MARK}-cache`,
        `    sample_on_first_match: ${MARK}-first`,
        "    policies:",
        `      - name: ${MARK}-p0`,
        `        type: ${MARK}-type`,
        `      - name: ${MARK}-p1`,
        "        type: status_code",
        `        status_code: {status_codes: [${MARK}-code]}`,
        `      - name: ${MARK}-p2`,
        "        type: string_attribute",
        `        string_attribute: {key: ${MARK}-key, values: [${MARK}-value]}`,
        `      - name: ${MARK}-p3`,
        "        type: boolean_attribute",
        `        boolean_attribute: {key: ${MARK}-bkey, value: ${MARK}-bool}`,
        `      - name: ${MARK}-p4`,
        "        type: ottl_condition",
        `        ottl_condition: {error_mode: ${MARK}-mode, span: [${MARK}-cond], spanevent: [${MARK}-event]}`,
        `      - name: ${MARK}-p5`,
        "        type: numeric_attribute",
        `        numeric_attribute: {key: ${MARK}-nkey, min_value: ${MARK}-min, invert_match: ${MARK}-inv}`,
        `      - name: ${MARK}-p6`,
        "        type: not",
      ].join("\n"),
    );
    const leaks: string[] = [];
    const user = renderForm(marked);
    for (let round = 0; round < 3; round++) {
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    }
    expect(toggles()).toHaveLength(7);
    const shown =
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();
    for (const what of [
      "wait",
      "traces",
      "cache",
      "p0",
      "type",
      "code",
      "key",
      "value",
      "bkey",
      "bool",
      "mode",
      "cond",
      "event",
      "nkey",
      "min",
    ]) {
      expect(shown).toContain(`${MARK}-${what}`);
    }
    for (const element of document.querySelectorAll("*")) {
      // A controlled field's value property is its content, not an attribute: the replay masks inputs.
      for (const attribute of element.attributes) {
        if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
      if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(MARK)) leaks.push("option value");
    }
    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
    expect(entries()).toBe(0);
  });
});

// ── Registry and copy ──

describe("dispatch and copy", () => {
  it("gives the tail_sampling processor this form, and no other type of that name", () => {
    expect(formFor("processor", "tail_sampling")).toBe(TailSamplingForm);
    expect(formFor("exporter", "tail_sampling")).toBeUndefined();
  });

  it("the hints' and alerts' words, exactly", () => {
    expect(POLICIES_INFO).toBe("A trace is sampled if any policy matches, unless a drop policy matches first. Policies evaluate in order.");
    expect(AND_EMPTY_HINT).toBe("With no sub-policies, this policy samples every trace.");
    expect(DROP_EMPTY_HINT).toBe("With no sub-policies, this policy drops every trace.");
    expect(NO_MINIMUM_HINT).toBe("0 or empty: no minimum.");
    expect(NO_MAXIMUM_HINT).toBe("0 or empty: no maximum.");
    expect(BOUNDS_HINT).toBe("Set a minimum or a maximum.");
    expect(ERROR_MODE_UNSET_HINT).toBe("Unset: errors are skipped without a log.");
  });
});
