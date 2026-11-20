/**
 * A run's rules' results: the Validation grid inside the results, a row per
 * rule the run copied, its Passed or Failed icon and its name, the count line,
 * and "Show test details": the rule, its advisory, and why it failed in each
 * of the four kinds of details or by its own error ("Not checked: …"
 * included); no grid for a run without rules; replay's rules (every rule's
 * text, snippet and sample inside `ph-no-capture`, none in an aria attribute,
 * of a rule only its error in an attribute, the row's tooltip, inside the
 * block).
 *
 * Rendered as the Testing tab renders it, the selected run's detail in the
 * store (the runs, their polling and the viewers are TestRunsPanel.test's).
 * Private texts carry `zq`, the marker the attribute scans look for.
 */

import type { TestRunDetail, ValidationRuleResult, ValidationRuleSnapshot } from "@telflo/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";
import { testRunFixture, testRunSummaryOf } from "~/test/test-runs.js";
import { TestRunResults } from "./TestRunResults.js";

const ruleId = (n: number) => `0199f400-0000-7000-8000-00000000000${n}`;

function rule(n: number, overrides: Partial<ValidationRuleSnapshot>): ValidationRuleSnapshot {
  return {
    id: ruleId(n),
    position: n,
    kind: "not_contains_text",
    target: "output",
    pattern: null,
    ottl: null,
    name: "",
    description: "",
    ...overrides,
  };
}

function result(n: number, overrides: Partial<ValidationRuleResult>): ValidationRuleResult {
  return { id: ruleId(n), passed: false, error: null, advisory: null, detail: null, ...overrides };
}

/** Each kind of result, in the rules' order: one passed, seven failed. */
const RULES: ValidationRuleSnapshot[] = [
  rule(1, { pattern: "zq-secret-token", name: "zq-no-secrets", description: "zq-rule-description" }),
  rule(2, { kind: "contains_regex", target: "stderr", pattern: "zq-started\\s+ok" }),
  rule(3, {
    kind: "ottl",
    ottl: { context: "log", condition: 'attributes["env"] == "zq-prod"', quantifier: "all" },
    name: "zq-env-prod",
    description: "zq line one\nzq line two",
  }),
  rule(4, {
    kind: "ottl",
    ottl: {
      context: "log",
      quantifier: "distinct",
      expression: 'attributes["zq-route"]',
      count: { operator: "lte", value: 2 },
    },
  }),
  rule(5, {
    kind: "ottl",
    ottl: { context: "log", condition: 'attributes["zq-debug"] == true', quantifier: "none" },
  }),
  rule(6, { kind: "contains_text", pattern: "zq-late", name: "zq-late-rule" }),
  rule(7, {
    kind: "ottl",
    ottl: { context: "log", condition: 'Int(attributes["zq-n"]) > 1', quantifier: "any" },
  }),
  rule(8, { target: "stderr", pattern: "zq-panic" }),
];

const NOT_CHECKED = "Not checked: the rules took longer than 20 s to check.";
const ZERO_RECORDS_ADVISORY = "No log records in the output: none holds only because there was nothing to check.";

const RESULTS: ValidationRuleResult[] = [
  result(1, {
    detail: {
      kind: "unexpected_match",
      source: "output",
      totalMatchCount: 7,
      moreMatches: false,
      matches: [
        {
          text: "zq-secret-token",
          textTruncated: false,
          before: '{"stringValue":"zq-before ',
          after: ' zq-after"}',
          record: { index: 2, path: "resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue" },
        },
        { text: "zq-secret-token-and-more", textTruncated: true, before: "", after: "", record: { index: null, path: "" } },
      ],
    },
  }),
  result(2, { detail: { kind: "no_match", source: "stderr", searchedCharacters: 1234 } }),
  result(3, {
    detail: {
      kind: "record_mismatch",
      context: "log",
      totalCount: 10,
      matchedCount: 7,
      missCount: 3,
      misses: [
        { index: 4, reason: "condition evaluated to false", snippet: '{"zq-snippet":4}' },
        { index: 8, reason: "condition evaluated to false", snippet: '{"zq-snippet":8}' },
      ],
    },
  }),
  result(4, {
    detail: { kind: "distinct_mismatch", totalCount: 9, matchedCount: 9, distinctCount: 4, samples: ["zq-route-a", "zq-route-b"] },
  }),
  result(5, { passed: true, advisory: ZERO_RECORDS_ADVISORY }),
  result(6, { error: NOT_CHECKED }),
  result(7, { error: "condition evaluation failed on 1 of 3 records: zq-type-error" }),
  result(8, {
    detail: {
      kind: "unexpected_match",
      source: "stderr",
      totalMatchCount: 100_000,
      moreMatches: true,
      matches: [{ text: "zq-panic", textTruncated: false, before: "zq-level=error ", after: " zq-goroutine", record: { line: 4 } }],
    },
  }),
];

const RUN = testRunFixture({
  status: "validation_failed",
  startedAt: "2026-10-09T12:00:01.000Z",
  finishedAt: "2026-10-09T12:00:09.000Z",
  ahead: null,
  outputSizeBytes: 18,
  outputTruncated: false,
  validationRules: RULES,
  validationResults: RESULTS,
});

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState(initialTesting, true);
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: versionFixture() });
});

afterEach(() => {
  cleanup();
  useTestingStore.setState(initialTesting, true);
});

/** Renders the results of `run`, read in full. */
function show(run: TestRunDetail = RUN) {
  useTestingStore.setState({ runDetails: { [run.id]: run }, selectedRunId: run.id });
  render(<TestRunResults run={testRunSummaryOf(run)} />);
  return userEvent.setup();
}

const results = () => screen.getByRole("region", { name: "Test results" });

/** The grid's rows, in order. */
const rows = () => within(within(results()).getByRole("list", { name: "Validation" })).getAllByRole("listitem");

/** An element whose own text is exactly `text` (a sentence split over spans). */
const sentence = (text: string) => (_: string, element: Element | null) =>
  element !== null && element.textContent === text && [...element.children].every((child) => child.textContent !== text);

/** Opens row `n`'s details (from 1) and returns the dialog. */
async function openDetails(user: ReturnType<typeof userEvent.setup>, n: number) {
  await user.click(within(results()).getByRole("button", { name: new RegExp(`^Show test details for rule ${n}: `) }));
  return screen.findByRole("dialog", { name: "Validation test details" });
}

/** The dialog's labelled rows (a label over its value), as [label, value], in order. */
function detailRows(dialog: HTMLElement): [string, string][] {
  return [...dialog.querySelectorAll(".tf-label")]
    .filter((label) => label.parentElement?.classList.contains("gap-1") && label.nextElementSibling !== null)
    .map((label) => [label.textContent ?? "", label.nextElementSibling!.textContent ?? ""]);
}

describe("the Validation grid", () => {
  it("shows a row per rule in the rules' order: its Passed or Failed icon and its name, the count line, 'Show test details' named by the rule", () => {
    show();

    const pane = results();
    expect(within(pane).getByText("Validation")).toBeInTheDocument();
    expect(within(pane).getByText("1 of 8 rules passed")).toBeInTheDocument();
    expect(rows().map((row) => within(row).getByRole("img").getAttribute("aria-label"))).toEqual([
      "Failed",
      "Failed",
      "Failed",
      "Failed",
      "Passed",
      "Failed",
      "Failed",
      "Failed",
    ]);
    expect(rows().map((row) => row.querySelector(".truncate")?.textContent)).toEqual([
      "Does not contain: zq-no-secrets",
      "Contains: zq-started\\s+ok",
      "OTTL: zq-env-prod",
      'OTTL: at most 2 distinct attributes["zq-route"]',
      'OTTL: none log: attributes["zq-debug"] == true',
      "Contains: zq-late-rule",
      'OTTL: any log: Int(attributes["zq-n"]) > 1',
      "Does not contain: zq-panic",
    ]);
    // Each named by hidden text inside the block, its own, with a fixed title.
    const buttons = within(pane).getAllByRole("button", { name: /^Show test details/ });
    expect(buttons).toHaveLength(8);
    expect(new Set(buttons.map((button) => button.getAttribute("aria-labelledby"))).size).toBe(8);
    for (const button of buttons) {
      expect(button).not.toHaveAttribute("aria-label");
      expect(button).toHaveAttribute("title", "Show test details");
      const name = document.getElementById(button.getAttribute("aria-labelledby")!)!;
      expect(name).toHaveClass("sr-only");
      expect(name.closest(".ph-no-capture")).not.toBeNull();
    }
    expect(within(pane).getByRole("button", { name: "Show test details for rule 1: zq-no-secrets" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Show test details for rule 2: zq-started\\s+ok" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: 'Show test details for rule 4: at most 2 distinct attributes["zq-route"]' })).toBeInTheDocument();
  });

  it("counts a single rule as 'rule': '1 of 1 rule passed'", () => {
    show(testRunFixture({ ...RUN, status: "succeeded", validationRules: [RULES[0]!], validationResults: [result(1, { passed: true })] }));

    expect(within(results()).getByText("1 of 1 rule passed")).toBeInTheDocument();
    expect(within(results()).getByRole("img", { name: "Passed" })).toBeInTheDocument();
  });

  it("shows no grid for a run without rules", () => {
    show(testRunFixture({ ...RUN, status: "succeeded", validationRules: [], validationResults: [] }));

    expect(within(results()).getByText("Success")).toBeInTheDocument();
    expect(within(results()).getByText("Pipeline:")).toBeInTheDocument();
    expect(within(results()).queryByText("Validation")).toBeNull();
    expect(within(results()).queryByText(/rules? passed/)).toBeNull();
    expect(within(results()).queryByRole("button", { name: /Show test details/ })).toBeNull();
  });

  it("lists only the rules that have a result: one with none is simply not listed", () => {
    show(testRunFixture({ ...RUN, validationRules: RULES.slice(0, 3), validationResults: [RESULTS[0]!, RESULTS[2]!] }));

    expect(rows().map((row) => row.querySelector(".truncate")?.textContent)).toEqual(["Does not contain: zq-no-secrets", "OTTL: zq-env-prod"]);
    expect(within(results()).getByText("0 of 2 rules passed")).toBeInTheDocument();
    expect(within(results()).getByRole("button", { name: "Show test details for rule 2: zq-env-prod" })).toBeInTheDocument();
  });

  it("shows a rule the time limit cut off as Failed, its words in the row's tooltip, as the run's status counts it", () => {
    show();

    const row = rows()[5]!;
    expect(within(row).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(within(row).queryByRole("img", { name: /Skipped|Pending/ })).toBeNull();
    expect(row).toHaveAttribute("title", NOT_CHECKED);
    expect(rows()[0]).not.toHaveAttribute("title");
  });
});

describe("Show test details", () => {
  it("unexpected_match in the output: the rule, then each match highlighted with its context and its record and path; 'Showing the first 2'", async () => {
    const user = show();
    const dialog = await openDetails(user, 1);

    expect(dialog).toHaveClass("ph-no-capture");
    expect(detailRows(dialog)).toEqual([
      ["Name", "Does not contain: zq-no-secrets"],
      ["Condition", "Output does not contain text"],
      ["Input", "zq-secret-token"],
      ["Description", "zq-rule-description"],
    ]);
    expect(within(dialog).getByText("Failure details")).toBeInTheDocument();
    expect(within(dialog).getByText(sentence("Found 7 unexpected matches in output. Showing the first 2."))).toBeInTheDocument();
    const [first, second] = within(dialog).getAllByRole("listitem");
    expect(within(first!).getByText("record 2")).toBeInTheDocument();
    expect(within(first!).getByText("resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue")).toBeInTheDocument();
    expect(first!.querySelector("pre")).toHaveTextContent('{"stringValue":"zq-before zq-secret-token zq-after"}', { normalizeWhitespace: false });
    expect(first!.querySelector("mark")).toHaveTextContent(/^zq-secret-token$/);
    expect(within(second!).getByText("outside every record")).toBeInTheDocument();
    expect(second!.querySelector("mark")).toHaveTextContent(/^zq-secret-token-and-more…$/);
    expect(within(dialog).queryByText("Advisory")).toBeNull();
  });

  it("unexpected_match in the log: the line, and 'more than 100,000' when the count stopped", async () => {
    const user = show();
    const dialog = await openDetails(user, 8);

    expect(detailRows(dialog)).toEqual([
      ["Name", "Does not contain: zq-panic"],
      ["Condition", "Stderr does not contain text"],
      ["Input", "zq-panic"],
      ["Description", "(no description)"],
    ]);
    expect(within(dialog).getByText(sentence("Found more than 100,000 unexpected matches in stderr. Showing the first 1."))).toBeInTheDocument();
    expect(within(dialog).getByText("line 4")).toBeInTheDocument();
    expect(dialog.querySelector("mark")).toHaveTextContent(/^zq-panic$/);
    expect(dialog.querySelector("mark")?.parentElement).toHaveTextContent("zq-level=error zq-panic zq-goroutine");
  });

  it("no_match: 'No match found in stderr (1,234 chars searched).' under the regex", async () => {
    const user = show();
    const dialog = await openDetails(user, 2);

    expect(detailRows(dialog)).toEqual([
      ["Name", "Contains: zq-started\\s+ok"],
      ["Condition", "Stderr contains regex"],
      ["Regex", "zq-started\\s+ok"],
      ["Description", "(no description)"],
    ]);
    expect(within(dialog).getByText(sentence("No match found in stderr (1,234 chars searched)."))).toBeInTheDocument();
  });

  it("record_mismatch: 'M of T elements matched; O did not.', each miss's record, reason and snippet; a multi-line description as a block", async () => {
    const user = show();
    const dialog = await openDetails(user, 3);

    // Two rows labelled Condition for an OTTL rule: the kind, then the condition.
    expect(detailRows(dialog)).toEqual([
      ["Name", "OTTL: zq-env-prod"],
      ["Condition", "OTTL condition assertion"],
      ["Condition", 'all log: attributes["env"] == "zq-prod"'],
      ["Description", "zq line one\nzq line two"],
    ]);
    expect(within(dialog).getByText("zq line one\nzq line two", { normalizer: (text) => text }).tagName).toBe("PRE");
    expect(within(dialog).getByText(sentence("7 of 10 elements matched; 3 did not. Showing the first 2."))).toBeInTheDocument();
    const misses = within(dialog).getAllByRole("listitem");
    expect(misses.map((miss) => [...miss.children].map((child) => child.textContent))).toEqual([
      ["log #4", "condition evaluated to false", '{"zq-snippet":4}'],
      ["log #8", "condition evaluated to false", '{"zq-snippet":8}'],
    ]);
  });

  it("distinct_mismatch: 'D distinct values across E records — outside the rule's threshold.' and the samples", async () => {
    const user = show();
    const dialog = await openDetails(user, 4);

    expect(within(dialog).getByText(sentence("4 distinct values across 9 records — outside the rule's threshold. Showing the first 2."))).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["zq-route-a", "zq-route-b"]);
  });

  it("a rule's own error, 'Not checked' included, under Failure details (not only in the tooltip)", async () => {
    const user = show();
    let dialog = await openDetails(user, 6);
    expect(within(dialog).getByText("Failure details")).toBeInTheDocument();
    expect(within(dialog).getByText(NOT_CHECKED)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openDetails(user, 7);
    expect(within(dialog).getByText("condition evaluation failed on 1 of 3 records: zq-type-error")).toBeInTheDocument();
    expect(within(dialog).queryByRole("list")).toBeNull();
  });

  it("a passing rule's advisory, and no Failure details", async () => {
    const user = show();
    const dialog = await openDetails(user, 5);

    expect(within(dialog).getByText("Advisory")).toBeInTheDocument();
    expect(within(dialog).getByText(ZERO_RECORDS_ADVISORY)).toBeInTheDocument();
    expect(within(dialog).queryByText("Failure details")).toBeNull();
  });

  it("a failed rule with no error, no detail and no advisory says so, never an empty Failure details", async () => {
    const user = show(testRunFixture({ ...RUN, validationRules: [RULES[7]!], validationResults: [result(8, {})] }));
    const dialog = await openDetails(user, 1);

    expect(within(dialog).getByText("Failure details")).toBeInTheDocument();
    expect(within(dialog).getByText("This rule failed; the evaluator gave no further detail.")).toBeInTheDocument();
    expect(within(dialog).queryByText("Advisory")).toBeNull();
  });

  it("a failed rule's advisory: the failure's reason when it has no error or detail (an empty-text regex); beside its detail otherwise", async () => {
    const emptyMatches = "The pattern matched only empty text (3 times), so there is no match to show.";
    const truncated = "The output was truncated: only its first 10 MiB were checked.";
    const user = show(
      testRunFixture({
        ...RUN,
        validationRules: [rule(1, { kind: "not_contains_regex", pattern: "zq-x*" }), RULES[2]!],
        validationResults: [result(1, { advisory: emptyMatches }), { ...RESULTS[2]!, advisory: truncated }],
      }),
    );

    let dialog = await openDetails(user, 1);
    expect(within(dialog).getByText("Failure details")).toBeInTheDocument();
    expect(within(dialog).getByText(emptyMatches).closest(".bg-muted\\/40")).not.toBeNull();
    expect(within(dialog).queryByText("This rule failed; the evaluator gave no further detail.")).toBeNull();
    expect(within(dialog).getAllByText(emptyMatches)).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openDetails(user, 2);
    expect(within(dialog).getByText("Advisory")).toBeInTheDocument();
    expect(within(dialog).getByText(truncated)).toBeInTheDocument();
    expect(within(dialog).getByText(sentence("7 of 10 elements matched; 3 did not. Showing the first 2."))).toBeInTheDocument();
  });

  it("a failing none and a failing any rule's record_mismatch: their counts and misses", async () => {
    const user = show(
      testRunFixture({
        ...RUN,
        validationRules: [RULES[4]!, RULES[6]!],
        validationResults: [
          result(5, {
            detail: {
              kind: "record_mismatch",
              context: "log",
              totalCount: 4,
              matchedCount: 1,
              missCount: 1,
              misses: [{ index: 2, reason: "the condition held (none allows none)", snippet: '{"zq-debug":true}' }],
            },
          }),
          result(7, {
            detail: {
              kind: "record_mismatch",
              context: "log",
              totalCount: 3,
              matchedCount: 0,
              missCount: 3,
              misses: [
                { index: 0, reason: "condition evaluated to false", snippet: '{"zq-n":0}' },
                { index: 1, reason: "condition evaluated to false", snippet: "" },
              ],
            },
          }),
        ],
      }),
    );

    let dialog = await openDetails(user, 1);
    expect(within(dialog).getByText(sentence("1 of 4 elements matched; 3 did not."))).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem").map((miss) => [...miss.children].map((child) => child.textContent))).toEqual([
      ["log #2", "the condition held (none allows none)", '{"zq-debug":true}'],
    ]);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openDetails(user, 2);
    expect(within(dialog).getByText(sentence("0 of 3 elements matched; 3 did not. Showing the first 2."))).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem").map((miss) => [...miss.children].map((child) => child.textContent))).toEqual([
      ["log #0", "condition evaluated to false", '{"zq-n":0}'],
      ["log #1", "condition evaluated to false"],
    ]);
  });

  it("gives the focus back to the row's button as it closes", async () => {
    const user = show();
    const opener = within(results()).getByRole("button", { name: /^Show test details for rule 3: / });
    const dialog = await openDetails(user, 3);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe("replay", () => {
  it("keeps every rule's text, snippet and sample inside ph-no-capture: no aria attribute carries one, and of a rule only its error is an attribute, the row's tooltip, inside the block", async () => {
    const markers: string[] = [];
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (!attribute.value.includes("zq") && !attribute.value.includes("Not checked")) continue;
          const allowed = attribute.name === "title" && element.closest(".ph-no-capture") !== null && element.tagName === "LI";
          if (!allowed) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
    };
    const insideBlocks = () => {
      for (const element of screen.queryAllByText(/zq|Not checked/)) expect(element.closest(".ph-no-capture"), element.textContent ?? "").not.toBeNull();
    };
    const user = show();
    scan();
    insideBlocks();
    expect(screen.getAllByText(/zq/).length).toBeGreaterThan(8);

    for (let n = 1; n <= RULES.length; n += 1) {
      const dialog = await openDetails(user, n);
      expect(dialog).toHaveClass("ph-no-capture");
      scan();
      insideBlocks();
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    expect(markers).toEqual([]);
  });
});
