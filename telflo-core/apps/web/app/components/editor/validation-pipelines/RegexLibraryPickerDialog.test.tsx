/**
 * The regex library picker (D15b Task 4: decisions 1, 2, 10 and 12;
 * Preflight rulings 5, 15 and 17): opened from a card's "Add from regex
 * library"; the dialog and its words; each row's description and regex;
 * the Category filter and the selection kept across it; the picks saved one
 * per request in the library's order, through the store, landing in the
 * card; a refusal the rest would share (429, 503, the 200-rule cap) stopping
 * the run, a pick's own (400) skipping it, each said inline, a pipeline gone
 * (404) stopping it too, toasted as it takes the card and the dialog away
 * (Ruling 32); the dialog's session (an answer, saved or refused, after
 * Escape acts on nothing; nor one, saved or refused, after a version switch
 * unmounted it, Ruling 23 and Ruling 34's m1); the picker gone with its card
 * as an answer comes in (no further pick, nothing said, only an "already
 * gone" stop toasted: Ruling 34's n1); the picker in StrictMode (Ruling
 * 34's n2); the library read on
 * every open, the latest read winning, a failed read with Retry; the
 * keyboard and the focus; the Play all hold; and replay's rule (no entry's
 * text in any attribute).
 *
 * Rendered in the whole tab, as the Validation subtab's tests are: Monaco is
 * stubbed; the API is its client's functions, spied on, over a little
 * in-memory API; toasts are spied on.
 */

import type { EditorProps } from "@monaco-editor/react";
import {
  RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
  VALIDATION_RULE_LIMIT_MESSAGE,
  type CreateValidationRuleRequest,
  type TestRegex,
  type TestRegexesResponse,
  type ValidationPipeline,
  type ValidationRule,
} from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: function DiffEditorStub() {
    return <div />;
  },
  default: function MonacoStub(props: EditorProps) {
    useEffect(() => {
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
      // Once, as Monaco mounts once.
    }, []);
    return <textarea aria-label="Sample editor" value={props.value ?? ""} readOnly />;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => Promise.resolve(), setMonacoSchema: () => undefined }));

import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { GROUP_ID, MEMBER_ID, MINE, signedInMember, versionFixture } from "~/test/configurations.js";
import { testRunFixture } from "~/test/test-runs.js";
import { testDefinitionFixture, testSuiteFixture } from "~/test/test-suites.js";
import { validationPipelineFixture, validationRuleFixture } from "~/test/validation-pipelines.js";
import { TestingTab } from "../test-runs/TestingTab.js";

const YAML = `receivers:
  otlp:
    protocols:
      http: {}
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
`;

const VERSION = versionFixture({ yamlContent: YAML });
const TARGET = { organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id };
const LOGS = validationPipelineFixture();

/** A library entry; `zq` marks its text for the attribute scans (ADR 0024). */
function entryFixture(index: number, overrides: Partial<TestRegex>): TestRegex {
  return {
    id: `0199f500-0000-7000-8000-${String(index).padStart(12, "0")}`,
    name: `zq-entry ${index}`,
    category: "zq-PII",
    description: `zq-description ${index}`,
    regex: `zq${index}\\d+`,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}

/** The library in the API's order (category, then name). */
const AWS = entryFixture(1, { name: "zq-AWS Access Key", category: "zq-Cloud", description: null, regex: "zq\\bAKIA[0-9A-Z]{16}\\b" });
const IPV4 = entryFixture(2, {
  name: "zq-IPv4 Address",
  category: "zq-Network",
  description: "zq-dotted quads",
  // Long, with spaces: shown in full, wrapped.
  regex: `zq ${"(?:[0-9]{1,3}\\.){3}[0-9]{1,3} ".repeat(8)}end`,
});
const EMAIL = entryFixture(3, { name: "zq-Email Address", description: "zq-matches emails", regex: "zq[a-z]+@[a-z]+\\.com" });
const PHONE = entryFixture(4, { name: "zq-Phone Number", description: "zq-matches phones", regex: "zq\\d{3}-\\d{4}" });
const SSN = entryFixture(5, { name: "zq-US SSN", description: "zq-matches SSNs", regex: "zq\\d{3}-\\d{2}-\\d{4}" });
const LIBRARY = [AWS, IPV4, EMAIL, PHONE, SSN];

const RATE_LIMITED = new ApiError("validation_rule_rate_limited", "Too many rule checks in the last minute. Try again shortly.", {
  status: 429,
});
const UNAVAILABLE = new ApiError("rules_unavailable", RULES_UNAVAILABLE_AT_SAVE_MESSAGE, { status: 503 });
const AT_LIMIT = new ApiError("validation_rule_limit_reached", VALIDATION_RULE_LIMIT_MESSAGE, { status: 409 });
const INVALID_WORDS = "Invalid regex: missing closing ): `(zq`";
const INVALID = new ApiError("validation_rule_invalid", INVALID_WORDS, {
  status: 400,
  details: { problems: [{ field: "pattern", message: INVALID_WORDS }] },
});

const initialEditor = useEditorStore.getState();
/** The store's own createRule, put back before each test (dropCardAtAnswer wraps it). */
const storeCreateRule = useValidationPipelinesStore.getState().createRule;
const initialTesting = useTestingStore.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A little API: the version's validation pipelines, each one's rules, and how a rule's create is answered. */
const api = {
  pipelines: [] as ValidationPipeline[],
  rules: {} as Record<string, ValidationRule[]>,
  nextId: 0,
  /** From this create on (1-based), every create is refused with `error`. */
  refuseFrom: null as { call: number; error: unknown } | null,
  /** A create of this pattern is refused with this error. */
  refusePattern: new Map<string, unknown>(),
  /** Each create waits for this before it answers. */
  gate: null as Promise<void> | null,
  calls: 0,
};

let createRule: MockInstance<typeof apiClient.createValidationRule>;
let listRegexes: MockInstance<typeof apiClient.getTestRegexes>;
let toastSuccess: MockInstance<typeof toast.success>;
let toastError: MockInstance<typeof toast.error>;

function serveApi() {
  vi.spyOn(apiClient, "getValidationPipelines").mockImplementation(async () => ({
    validationPipelines: api.pipelines.map((each) => ({ ...each })),
  }));
  vi.spyOn(apiClient, "getValidationRules").mockImplementation(async (_o, _c, _v, pipelineId) => ({
    rules: (api.rules[pipelineId] ?? []).map((each) => ({ ...each })),
  }));
  createRule = vi.spyOn(apiClient, "createValidationRule").mockImplementation(async (_o, _c, _v, pipelineId, request) => {
    api.calls += 1;
    const call = api.calls;
    if (api.gate !== null) await api.gate;
    if (api.refuseFrom !== null && call >= api.refuseFrom.call) throw api.refuseFrom.error;
    const refusal = api.refusePattern.get(request.pattern ?? "");
    if (refusal !== undefined) throw refusal;
    const listed = api.rules[pipelineId] ?? [];
    api.nextId += 1;
    const rule = validationRuleFixture({
      id: `0199f4aa-0000-7000-8000-${String(api.nextId).padStart(12, "0")}`,
      validationPipelineId: pipelineId,
      position: Math.max(0, ...listed.map((each) => each.position)) + 1,
      kind: request.kind,
      target: request.target,
      pattern: request.pattern ?? null,
      ottl: null,
      name: request.name ?? "",
      description: request.description ?? "",
    });
    api.rules[pipelineId] = [...listed, rule];
    return { rule };
  });
  listRegexes = vi.spyOn(apiClient, "getTestRegexes").mockImplementation(async () => ({ testRegexes: LIBRARY.map((each) => ({ ...each })) }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  useTestingStore.getState().reset();
  useTestSuitesStore.getState().reset();
  useValidationPipelinesStore.setState({ createRule: storeCreateRule });
  useValidationPipelinesStore.getState().reset();
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  api.pipelines = [LOGS];
  api.rules = {};
  api.nextId = 0;
  api.refuseFrom = null;
  api.refusePattern = new Map();
  api.gate = null;
  api.calls = 0;
  toastSuccess = vi.spyOn(toast, "success").mockImplementation(() => "");
  toastError = vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: [] }));
  vi.spyOn(apiClient, "getTestSuites").mockImplementation(async () => ({ suites: [] }));
  serveApi();
});

type User = ReturnType<typeof userEvent.setup>;

/** The tab on its Validation subtab; `strict`, inside React's StrictMode (each effect run, cleaned up and run again). */
async function renderValidation({ strict = false }: { strict?: boolean } = {}) {
  const view = render(
    strict ? (
      <StrictMode>
        <TestingTab />
      </StrictMode>
    ) : (
      <TestingTab />
    ),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Validation" }));
  return { ...view, user };
}

/** The logs card, expanded, its rules read. */
async function expandLogs(user: User) {
  const card = (await screen.findByText("logs", { selector: "li span.font-mono" })).closest("li")!;
  await user.click(within(card).getByRole("button", { expanded: false }));
  await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
  return card;
}

/** Opens the picker from the logs card and waits for the library's rows. */
async function openPicker(user: User, card?: HTMLElement) {
  const each = card ?? (await expandLogs(user));
  await user.click(within(each).getByRole("button", { name: "Add from regex library" }));
  const dialog = await screen.findByRole("dialog", { name: "Add validation rules from regex library" });
  return { card: each, dialog };
}

/** The rows' checkboxes, by name, once the library is shown. */
async function checkboxes(dialog: HTMLElement) {
  await waitFor(() => expect(within(dialog).queryByRole("status", { name: "Loading test regexes" })).toBeNull());
  return within(dialog).queryAllByRole("checkbox");
}

async function tick(user: User, dialog: HTMLElement, ...entries: TestRegex[]) {
  for (const entry of entries) await user.click(within(dialog).getByRole("checkbox", { name: entry.name }));
}

async function choose(user: User, dialog: HTMLElement, label: string, option: string) {
  await user.click(within(dialog).getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const alertsIn = (dialog: HTMLElement) => within(dialog).queryAllByRole("alert").map((each) => each.textContent);
const tickedNames = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("checkbox", { checked: true })
    .map((each) => document.getElementById(each.getAttribute("aria-labelledby")!)?.textContent);
const storedNames = () => (useValidationPipelinesStore.getState().rulesByPipeline[LOGS.id] ?? []).map((rule) => rule.name);
/** The card's rows as it shows them (hidden from the accessibility tree while the modal dialog shows). */
const cardRows = (card: HTMLElement) =>
  within(card)
    .queryAllByRole("listitem", { hidden: true })
    .map((row) => row.querySelector("span")?.textContent);

/** The request each create sent, in order. */
const sentRequests = (): CreateValidationRuleRequest[] => createRule.mock.calls.map((call) => call[4]);

/** The stop and skip lines anywhere on the page. */
const runLines = () =>
  screen
    .queryAllByRole("alert")
    .map((each) => each.textContent ?? "")
    .filter((text) => /rules were added|weren't added|wasn't added/.test(text));

/**
 * Has the store's createRule drop the logs card the moment its `call`th
 * answer is in (a teammate's delete read back in that same moment): the card
 * and the picker unmount after the store has answered and before the
 * picker's own code reads the answer, the picker's session not yet moved
 * (its bump is a microtask after the unmount). What the picker then does
 * rests on its `mounted` checks alone (Ruling 34's n1).
 */
function dropCardAtAnswer(call: number) {
  let calls = 0;
  const drop = () =>
    useValidationPipelinesStore.setState((state) => ({ pipelines: state.pipelines.filter((each) => each.id !== LOGS.id) }));
  useValidationPipelinesStore.setState({
    createRule: async (...args) => {
      calls += 1;
      const at = calls;
      try {
        const rule = await storeCreateRule(...args);
        if (at === call) drop();
        return rule;
      } catch (error) {
        // Dropped and rethrown with no await between, as the store's own dropGone.
        if (at === call) drop();
        throw error;
      }
    },
  });
}

describe("the picker's dialog (its words; decision 2)", () => {
  it("opens from 'Add from regex library' beside 'Add Validation Rule'; shows each row's name, description, regex and category in the API's order; Match 'Does not Contain', 'All categories', '0 selected'", async () => {
    const { user } = await renderValidation();
    const card = await expandLogs(user);
    const add = within(card).getByRole("button", { name: "Add Validation Rule" });
    const fromLibrary = within(card).getByRole("button", { name: "Add from regex library" });
    expect(add.parentElement).toBe(fromLibrary.parentElement);
    expect(listRegexes).not.toHaveBeenCalled();

    const { dialog } = await openPicker(user, card);

    expect(dialog).toHaveClass("ph-no-capture");
    expect(listRegexes).toHaveBeenCalledOnce();
    expect(listRegexes).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    const boxes = await checkboxes(dialog);
    expect(boxes.map((box) => document.getElementById(box.getAttribute("aria-labelledby")!)?.textContent)).toEqual(LIBRARY.map((entry) => entry.name));
    for (const entry of LIBRARY) {
      const row = within(dialog).getByRole("checkbox", { name: entry.name }).closest("li")!;
      expect(row).toHaveTextContent(entry.category);
      // The regex in full, wrapped, never cut.
      const regex = within(row).getByText(entry.regex, { normalizer: (text) => text });
      expect(regex).toHaveClass("font-mono", "whitespace-pre-wrap", "break-all");
      expect(regex).not.toHaveClass("truncate");
      if (entry.description !== null) expect(within(row).getByText(entry.description)).toBeInTheDocument();
    }
    expect(within(dialog).getByText("Name", { selector: "span" })).toBeInTheDocument();
    expect(within(dialog).getByText("Category", { selector: "span" })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Match" })).toHaveTextContent("Does not Contain");
    expect(within(dialog).getByRole("combobox", { name: "Category" })).toHaveTextContent("All categories");
    expect(dialog).toHaveTextContent("0 selected");
    expect(within(dialog).getByRole("button", { name: "OK" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("offers Contains and Does not Contain, and each category once, sorted, after 'All categories'; filtering keeps what was ticked; '{n} selected' counts every tick", async () => {
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);

    await user.click(within(dialog).getByRole("combobox", { name: "Match" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Contains", "Does not Contain"]);
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("combobox", { name: "Category" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "All categories",
      "zq-Cloud",
      "zq-Network",
      "zq-PII",
    ]);
    await user.keyboard("{Escape}");

    await tick(user, dialog, AWS, EMAIL);
    expect(dialog).toHaveTextContent("2 selected");

    await choose(user, dialog, "Category", "zq-PII");
    expect(within(dialog).getAllByRole("checkbox").map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(within(dialog).queryByRole("checkbox", { name: AWS.name })).toBeNull();
    await tick(user, dialog, SSN);
    expect(dialog).toHaveTextContent("3 selected");

    await choose(user, dialog, "Category", "zq-Network");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(dialog).toHaveTextContent("3 selected");

    await choose(user, dialog, "Category", "All categories");
    expect(tickedNames(dialog)).toEqual([AWS.name, EMAIL.name, SSN.name]);
    await tick(user, dialog, EMAIL);
    expect(dialog).toHaveTextContent("2 selected");
  });

  it("says 'No regexes available.' for an empty library", async () => {
    listRegexes.mockResolvedValue({ testRegexes: [] });
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);

    expect(await within(dialog).findByText("No regexes available.")).toBeInTheDocument();
    expect(within(dialog).queryAllByRole("checkbox")).toEqual([]);
  });
});

describe("saving the picks (decision 1; Preflight rulings 5 and 15)", () => {
  it("saves 3 picks in the library's order (one hidden by the filter), one request each, through the store: the rules land in the card in order; 'Added 3 validation rules', closed, the focus on 'Add from regex library'", async () => {
    const { user } = await renderValidation();
    const { card, dialog } = await openPicker(user);
    await checkboxes(dialog);
    await choose(user, dialog, "Match", "Contains");
    // Ticked out of order, and one of them hidden by the filter as OK is pressed.
    await tick(user, dialog, SSN, AWS, EMAIL);
    await choose(user, dialog, "Category", "zq-PII");

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sentRequests()).toEqual([
      // No description: the entry's name.
      { kind: "contains_regex", target: "output", pattern: AWS.regex, name: AWS.name, description: AWS.name },
      { kind: "contains_regex", target: "output", pattern: EMAIL.regex, name: EMAIL.name, description: EMAIL.description },
      { kind: "contains_regex", target: "output", pattern: SSN.regex, name: SSN.name, description: SSN.description },
    ]);
    for (const call of createRule.mock.calls) expect(call.slice(0, 4)).toEqual([TARGET.organizationId, TARGET.configurationId, TARGET.versionId, LOGS.id]);
    expect(toastSuccess).toHaveBeenCalledWith("Added 3 validation rules");
    expect(toastError).not.toHaveBeenCalled();
    expect(storedNames()).toEqual([AWS.name, EMAIL.name, SSN.name]);
    expect(cardRows(card)).toEqual([`Contains: ${AWS.name}`, `Contains: ${EMAIL.name}`, `Contains: ${SSN.name}`]);
    await waitFor(() => expect(within(card).getByRole("button", { name: "Add from regex library" })).toHaveFocus());
  });

  it("saves one pick as 'Does not Contain' by default: 'Added 1 validation rule'", async () => {
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, PHONE);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sentRequests()).toEqual([
      { kind: "not_contains_regex", target: "output", pattern: PHONE.regex, name: PHONE.name, description: PHONE.description },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("Added 1 validation rule");
  });

  it("holds OK while saving ('Adding…', aria-disabled, never disabled, the focus kept on it): a second press sends nothing more", async () => {
    const gate = deferred<void>();
    api.gate = gate.promise;
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS);
    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    const adding = within(dialog).getByRole("button", { name: "Adding…" });
    expect(adding).toHaveAttribute("aria-disabled", "true");
    expect(adding).toBeEnabled();
    expect(adding).toHaveFocus();
    await user.click(adding);
    expect(createRule).toHaveBeenCalledOnce();

    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createRule).toHaveBeenCalledOnce();
  });

  it.each([
    ["a 429 (the checks' limit)", RATE_LIMITED],
    ["a 503 (the evaluator down)", UNAVAILABLE],
    ["the 200-rule cap (409)", AT_LIMIT],
  ])("stops at %s after 2 of 5: 2 added, the other 3 still ticked and never sent, the reason inline; the dialog open, the focus on OK", async (_label, error) => {
    api.refuseFrom = { call: 3, error };
    const { user } = await renderValidation();
    const { card, dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, ...LIBRARY);
    expect(dialog).toHaveTextContent("5 selected");

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(alertsIn(dialog)).toEqual([`Added 2 of 5 rules. The other 3 weren't added: ${(error as ApiError).message}`]));
    expect(createRule).toHaveBeenCalledTimes(3);
    expect(tickedNames(dialog)).toEqual([EMAIL.name, PHONE.name, SSN.name]);
    expect(dialog).toHaveTextContent("3 selected");
    expect(screen.getByRole("dialog", { name: "Add validation rules from regex library" })).toBe(dialog);
    const ok = within(dialog).getByRole("button", { name: "OK" });
    expect(ok).toHaveFocus();
    expect(ok).not.toHaveAttribute("aria-disabled");
    expect(storedNames()).toEqual([AWS.name, IPV4.name]);
    expect(cardRows(card)).toEqual([`Does not contain: ${AWS.name}`, `Does not contain: ${IPV4.name}`]);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();

    // OK again tries the three left, from the first.
    api.refuseFrom = null;
    await user.click(ok);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sentRequests().map((request) => request.name)).toEqual([AWS.name, IPV4.name, EMAIL.name, EMAIL.name, PHONE.name, SSN.name]);
    expect(toastSuccess).toHaveBeenCalledWith("Added 3 validation rules");
    expect(storedNames()).toEqual([AWS.name, IPV4.name, EMAIL.name, PHONE.name, SSN.name]);
  });

  it("says 'The other one wasn't added' for one left, and 'No rules were added' when the first pick stops the run", async () => {
    api.refuseFrom = { call: 2, error: RATE_LIMITED };
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual([`Added 1 of 2 rules. The other one wasn't added: ${RATE_LIMITED.message}`]));

    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual([`No rules were added: ${RATE_LIMITED.message}`]));
    expect(tickedNames(dialog)).toEqual([IPV4.name]);
    expect(createRule).toHaveBeenCalledTimes(3);
  });

  it("stops on the server not reached, in the client's words; a session that ended (401) stops silently, every pick still ticked", async () => {
    api.refuseFrom = { call: 1, error: new ApiError("network_error", "Could not reach the server. Check your connection.") };
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["No rules were added: Could not reach the server. Check your connection."]));
    expect(createRule).toHaveBeenCalledOnce();

    api.refuseFrom = { call: 1, error: new ApiError("unauthenticated", "Your session has ended. Sign in again.", { status: 401 }) };
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "OK" })).not.toHaveAttribute("aria-disabled"));
    expect(alertsIn(dialog)).toEqual([]);
    expect(createRule).toHaveBeenCalledTimes(2);
    expect(tickedNames(dialog)).toEqual([AWS.name, IPV4.name]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["after 1 of 3", 2, "Added 1 of 3 rules. The other 2 weren't added: That validation pipeline doesn't exist."],
    ["at the first pick", 1, "No rules were added: That validation pipeline doesn't exist."],
  ])(
    "stops when the pipeline is gone %s (404 validation_pipeline_not_found, a teammate's delete): no further pick sent, the card dropped and the dialog with it, its stop toasted in the inline line's words (blocked), the focus on 'Add validation pipeline' (the panel's fallback; Ruling 32)",
    async (_label, call, line) => {
      api.refuseFrom = {
        call,
        error: new ApiError("validation_pipeline_not_found", "That validation pipeline doesn't exist.", { status: 404 }),
      };
      const { user } = await renderValidation();
      const { dialog } = await openPicker(user);
      await checkboxes(dialog);
      await tick(user, dialog, AWS, IPV4, EMAIL);

      await user.click(within(dialog).getByRole("button", { name: "OK" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
      expect(useValidationPipelinesStore.getState().pipelines).toEqual([]);
      // A task's worth of answers: any further pick would have been sent by now.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(sentRequests().map((request) => request.name)).toEqual([AWS.name, IPV4.name].slice(0, call));
      expect(toastError).toHaveBeenCalledOnce();
      expect(toastError).toHaveBeenCalledWith(line, { className: "ph-no-capture" });
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(screen.queryAllByRole("alert").map((each) => each.textContent)).not.toContain(line);
      expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus();
    },
  );

  it("says a stop with no reason of its own (the API's answer unreadable) without the generic words twice: 'No rules were added.', 'Added 2 of 5 rules. The other 3 weren't added.'", async () => {
    api.refuseFrom = { call: 1, error: new ApiError("unexpected_response", "The server's answer couldn't be read.", { status: 500 }) };
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, ...LIBRARY);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["No rules were added."]));

    api.refuseFrom = { call: 4, error: new Error("") };
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["Added 2 of 5 rules. The other 3 weren't added."]));
    expect(tickedNames(dialog)).toEqual([EMAIL.name, PHONE.name, SSN.name]);
  });

  it("names and skips a pick refused on its own (400 validation_rule_invalid, invalid_request), saving the rest; the dialog stays open with the skipped ones ticked, the focus on OK", async () => {
    api.refusePattern.set(IPV4.regex, INVALID);
    api.refusePattern.set(PHONE.regex, new ApiError("invalid_request", "The pattern is longer than 8,192 bytes.", { status: 400 }));
    const { user } = await renderValidation();
    const { card, dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, ...LIBRARY);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() =>
      expect(alertsIn(dialog)).toEqual([
        `"${IPV4.name}" wasn't added: ${INVALID_WORDS}`,
        `"${PHONE.name}" wasn't added: The pattern is longer than 8,192 bytes.`,
      ]),
    );
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "OK" })).toHaveFocus());
    expect(createRule).toHaveBeenCalledTimes(5);
    expect(tickedNames(dialog)).toEqual([IPV4.name, PHONE.name]);
    expect(storedNames()).toEqual([AWS.name, EMAIL.name, SSN.name]);
    expect(cardRows(card)).toEqual([`Does not contain: ${AWS.name}`, `Does not contain: ${EMAIL.name}`, `Does not contain: ${SSN.name}`]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("skips a pick only on a 400: invalid_request or validation_rule_invalid under any other status (a 429's) stops the run (side A's Nit 3)", async () => {
    api.refuseFrom = { call: 2, error: new ApiError("invalid_request", "Slow down.", { status: 429 }) };
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4, EMAIL);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    // A stop (invalid_request's own words are never shown: the generic ending).
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["Added 1 of 3 rules. The other 2 weren't added."]));
    expect(createRule).toHaveBeenCalledTimes(2);
    expect(tickedNames(dialog)).toEqual([IPV4.name, EMAIL.name]);

    api.refuseFrom = { call: 3, error: new ApiError("validation_rule_invalid", "Not checked.", { status: 503 }) };
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["No rules were added: Not checked."]));
    expect(createRule).toHaveBeenCalledTimes(3);
    expect(tickedNames(dialog)).toEqual([IPV4.name, EMAIL.name]);
  });

  it("says a skip and then a stop, each once: the stop counts the picks it held back", async () => {
    api.refusePattern.set(AWS.regex, INVALID);
    api.refuseFrom = { call: 3, error: UNAVAILABLE };
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4, EMAIL, PHONE);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() =>
      expect(alertsIn(dialog)).toEqual([
        `"${AWS.name}" wasn't added: ${INVALID_WORDS}`,
        `Added 1 of 4 rules. The other 2 weren't added: ${UNAVAILABLE.message}`,
      ]),
    );
    expect(tickedNames(dialog)).toEqual([AWS.name, EMAIL.name, PHONE.name]);
  });
});

describe("the dialog's session (D15a Ruling 56)", () => {
  it("an answer after Escape acts on nothing: no further pick, no toast, nothing unticked in the dialog opened since; the store keeps the rule", async () => {
    const gate = deferred<void>();
    api.gate = gate.promise;
    const { user } = await renderValidation();
    const { card, dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4);
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(createRule).toHaveBeenCalledOnce());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(within(card).getByRole("button", { name: "Add from regex library" })).toHaveFocus());

    // Opened again, fresh, the in-flight pick ticked anew.
    const reopened = (await openPicker(user, card)).dialog;
    await checkboxes(reopened);
    expect(reopened).toHaveTextContent("0 selected");
    await tick(user, reopened, AWS);

    await act(async () => gate.resolve());

    await waitFor(() => expect(storedNames()).toEqual([AWS.name]));
    expect(createRule).toHaveBeenCalledOnce();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add validation rules from regex library" })).toBe(reopened);
    expect(tickedNames(reopened)).toEqual([AWS.name]);
    expect(within(reopened).getByRole("button", { name: "OK" })).not.toHaveAttribute("aria-disabled");
    expect(alertsIn(reopened)).toEqual([]);
  });
  it("a refusal answered after Escape acts on nothing in the dialog opened since: no alert, the focus where it was, OK untouched (the catch's own session check)", async () => {
    const gate = deferred<void>();
    api.gate = gate.promise;
    api.refuseFrom = { call: 1, error: RATE_LIMITED };
    const { user } = await renderValidation();
    const { card, dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4);
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(createRule).toHaveBeenCalledOnce());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const reopened = (await openPicker(user, card)).dialog;
    await checkboxes(reopened);
    await tick(user, reopened, EMAIL);
    const email = within(reopened).getByRole("checkbox", { name: EMAIL.name });
    expect(email).toHaveFocus();

    await act(async () => gate.resolve());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(alertsIn(reopened)).toEqual([]);
    expect(email).toHaveFocus();
    const ok = within(reopened).getByRole("button", { name: "OK" });
    expect(ok).not.toHaveAttribute("aria-disabled");
    expect(ok).toBeEnabled();
    expect(tickedNames(reopened)).toEqual([EMAIL.name]);
    expect(createRule).toHaveBeenCalledOnce();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ["a save", null],
    ["a 429", RATE_LIMITED],
    ["a 404 (validation_pipeline_not_found)", new ApiError("validation_pipeline_not_found", "That validation pipeline doesn't exist.", { status: 404 })],
  ])(
    "a version switch mid-run (the picker unmounted with its card), its pick then answered with %s, sends nothing more and says nothing: no toast or alert over the new version (Ruling 23; Ruling 34's m1)",
    async (_label, error) => {
      const gate = deferred<void>();
      api.gate = gate.promise;
      if (error !== null) api.refuseFrom = { call: 1, error };
      const { user } = await renderValidation();
      const { dialog } = await openPicker(user);
      await checkboxes(dialog);
      await tick(user, dialog, AWS, IPV4, EMAIL);
      await user.click(within(dialog).getByRole("button", { name: "OK" }));
      await waitFor(() => expect(createRule).toHaveBeenCalledOnce());

      const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
      act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await screen.findByText("logs", { selector: "li span.font-mono" });

      await act(async () => gate.resolve());
      // A task's worth of answers: the rest of the run, had it gone on, would have been sent and toasted by now.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

      expect(createRule).toHaveBeenCalledOnce();
      expect(createRule.mock.calls[0]?.slice(0, 4)).toEqual([TARGET.organizationId, TARGET.configurationId, TARGET.versionId, LOGS.id]);
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
      expect(runLines()).toEqual([]);
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );
});

describe("the picker gone with its card as an answer comes in (Ruling 34's n1)", () => {
  /** Ticks three entries and presses OK; returns once a task's worth of answers is in. */
  async function runThree() {
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4, EMAIL);
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  it.each([
    ["the first pick's", 1, [AWS.name]],
    ["the last pick's", 3, [AWS.name, IPV4.name, EMAIL.name]],
  ])("%s save answered as the card goes sends no further pick and says nothing, no 'Added 3 validation rules' (the check after a save)", async (_label, call, sent) => {
    dropCardAtAnswer(call);
    await runThree();

    expect(sentRequests().map((request) => request.name)).toEqual(sent);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(runLines()).toEqual([]);
  });

  it("a pick's own refusal (400) answered as the card goes sends no further pick and says nothing (the check before each pick)", async () => {
    api.refusePattern.set(AWS.regex, INVALID);
    dropCardAtAnswer(1);
    await runThree();

    expect(sentRequests().map((request) => request.name)).toEqual([AWS.name]);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(runLines()).toEqual([]);
  });

  it("a refusal that isn't 'already gone' (a 429) answered as the card goes says nothing: only an already-gone answer took the card away, and only it is toasted", async () => {
    api.refuseFrom = { call: 2, error: RATE_LIMITED };
    dropCardAtAnswer(2);
    await runThree();

    expect(sentRequests().map((request) => request.name)).toEqual([AWS.name, IPV4.name]);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(runLines()).toEqual([]);
  });
});

describe("the picker in StrictMode (each effect run, cleaned up and run again; Ruling 34's n2)", () => {
  it("still says a stop inline: 'Added 1 of 2 rules. The other one wasn't added: …', no toast, the dialog open", async () => {
    api.refuseFrom = { call: 2, error: RATE_LIMITED };
    const { user } = await renderValidation({ strict: true });
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(alertsIn(dialog)).toEqual([`Added 1 of 2 rules. The other one wasn't added: ${RATE_LIMITED.message}`]));
    expect(createRule).toHaveBeenCalledTimes(2);
    expect(tickedNames(dialog)).toEqual([IPV4.name]);
    expect(screen.getByRole("dialog", { name: "Add validation rules from regex library" })).toBe(dialog);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("toasts a stop whose answer took the card away (404 validation_pipeline_not_found) once, in the inline line's words, blocked", async () => {
    api.refuseFrom = { call: 2, error: new ApiError("validation_pipeline_not_found", "That validation pipeline doesn't exist.", { status: 404 }) };
    const { user } = await renderValidation({ strict: true });
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4, EMAIL);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(sentRequests().map((request) => request.name)).toEqual([AWS.name, IPV4.name]);
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith("Added 1 of 3 rules. The other 2 weren't added: That validation pipeline doesn't exist.", {
      className: "ph-no-capture",
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("says nothing for a version switch mid-run: no further pick, no toast", async () => {
    const gate = deferred<void>();
    api.gate = gate.promise;
    api.refuseFrom = { call: 1, error: RATE_LIMITED };
    const { user } = await renderValidation({ strict: true });
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, AWS, IPV4);
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(createRule).toHaveBeenCalledOnce());

    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByText("logs", { selector: "li span.font-mono" });

    await act(async () => gate.resolve());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(createRule).toHaveBeenCalledOnce();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(runLines()).toEqual([]);
  });
});

describe("reading the library (Preflight ruling 15)", () => {
  it("reads it again each time the dialog opens; only the latest read is shown", async () => {
    const first = deferred<TestRegexesResponse>();
    listRegexes.mockReturnValueOnce(first.promise);
    const { user } = await renderValidation();
    const { card, dialog } = await openPicker(user);
    expect(within(dialog).getByRole("status", { name: "Loading test regexes" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const renamed = { ...EMAIL, name: "zq-Email, renamed" };
    listRegexes.mockResolvedValueOnce({ testRegexes: [renamed] });
    const reopened = (await openPicker(user, card)).dialog;
    expect(await within(reopened).findByRole("checkbox", { name: renamed.name })).toBeInTheDocument();
    expect(within(reopened).getAllByRole("checkbox")).toHaveLength(1);
    expect(listRegexes).toHaveBeenCalledTimes(2);

    // The first read, answered late: dropped.
    await act(async () => first.resolve({ testRegexes: LIBRARY }));
    expect(within(reopened).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(reopened).getByRole("checkbox", { name: renamed.name })).toBeInTheDocument();
  });

  it("shows a failed read inline, 'Failed to load test regexes', with Retry, which reads it again", async () => {
    listRegexes.mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Failed to load test regexes");
    expect(toastError).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));

    expect(await within(dialog).findByRole("checkbox", { name: AWS.name })).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(listRegexes).toHaveBeenCalledTimes(2);
  });
});

describe("the keyboard and the focus (decision 10)", () => {
  it("reaches each checkbox by Tab, named by its entry, described by its description, its state announced and toggled by Space; its focus visible", async () => {
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);

    const reached: string[] = [];
    for (let step = 0; step < 12 && reached.length < LIBRARY.length; step += 1) {
      await user.tab();
      const focused = document.activeElement as HTMLElement;
      if (focused.getAttribute("role") === "checkbox") reached.push(document.getElementById(focused.getAttribute("aria-labelledby")!)!.textContent!);
    }
    expect(reached).toEqual(LIBRARY.map((entry) => entry.name));

    const email = within(dialog).getByRole("checkbox", { name: EMAIL.name });
    expect(email).toHaveAccessibleDescription(EMAIL.description!);
    expect(within(dialog).getByRole("checkbox", { name: AWS.name })).not.toHaveAttribute("aria-describedby");
    expect(email).toHaveClass("focus-visible:ring-2");
    email.focus();
    expect(email).toHaveAttribute("aria-checked", "false");
    await user.keyboard(" ");
    expect(email).toHaveAttribute("aria-checked", "true");
    expect(dialog).toHaveTextContent("1 selected");
    await user.keyboard(" ");
    expect(email).toHaveAttribute("aria-checked", "false");
    // A click on the name ticks it too.
    await user.click(within(dialog).getByText(EMAIL.name));
    expect(email).toHaveAttribute("aria-checked", "true");
  });

  it("gives the focus back to 'Add from regex library' on Cancel", async () => {
    const { user } = await renderValidation();
    const { card, dialog } = await openPicker(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Add from regex library" })).toHaveFocus());
  });
});

describe("a Play all under way while the picker shows (D14b Ruling 50's rule)", () => {
  it("keeps the picker and its ticks: no switch to Tests under it, the run still queued", async () => {
    const suite = testSuiteFixture();
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [suite] });
    let release: (value: { definitions: ReturnType<typeof testDefinitionFixture>[] }) => void = () => undefined;
    vi.spyOn(apiClient, "getTestDefinitions").mockReturnValue(new Promise((resolve) => (release = resolve)));
    const run = testRunFixture({ queuedByUserId: MEMBER_ID });
    const queue = vi.spyOn(apiClient, "queueTestRun").mockResolvedValue({ run });
    vi.spyOn(apiClient, "getTestRun").mockResolvedValue({ run });
    const { user } = await renderValidation();

    await user.click(screen.getByRole("tab", { name: "Suites" }));
    await screen.findByText(suite.name);
    await user.click(screen.getByRole("button", { name: "Play all tests in parallel" }));
    await user.click(screen.getByRole("tab", { name: "Validation" }));
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    await tick(user, dialog, SSN);

    await act(async () => release({ definitions: [testDefinitionFixture()] }));

    await waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    expect(screen.getByRole("tab", { name: "Validation", hidden: true })).toHaveAttribute("aria-selected", "true");
    expect(tickedNames(screen.getByRole("dialog", { name: "Add validation rules from regex library" }))).toEqual([SSN.name]);
  });
});

describe("replay (Preflight ruling 17; ADR 0024)", () => {
  it("puts the dialog and its lists in ph-no-capture, no entry's text in any of their attributes, and none outside the block, through a run that stops and skips", async () => {
    api.refusePattern.set(EMAIL.regex, INVALID);
    api.refuseFrom = { call: 4, error: RATE_LIMITED };
    const markers: string[] = [];
    /**
     * Every attribute carrying a marker outside `ph-no-capture`, and any at
     * all in the picker and its lists (the card's rows behind it keep D15a's
     * titles, inside the panel's block); an input's value is masked by replay
     * (maskAllInputs).
     */
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        const inPicker = element.closest('[role="dialog"], [role="listbox"]') !== null;
        if (!inPicker && element.closest(".ph-no-capture") !== null) continue;
        for (const attribute of element.attributes) {
          if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && attribute.name === "value") continue;
          if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
    };
    const { user } = await renderValidation();
    const { dialog } = await openPicker(user);
    await checkboxes(dialog);
    expect(dialog).toHaveClass("ph-no-capture");
    scan();

    await user.click(within(dialog).getByRole("combobox", { name: "Category" }));
    const listbox = await screen.findByRole("listbox");
    expect(listbox.closest(".ph-no-capture")).not.toBeNull();
    expect(within(listbox).getByRole("option", { name: "zq-PII" })).toBeInTheDocument();
    scan();
    await user.click(within(listbox).getByRole("option", { name: "zq-PII" }));
    scan();
    await choose(user, dialog, "Category", "All categories");

    await tick(user, dialog, ...LIBRARY);
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(alertsIn(dialog)).toHaveLength(2));
    scan();

    expect(markers).toEqual([]);
    // The scan saw them, as text.
    expect(within(dialog).getByText(SSN.regex)).toBeInTheDocument();
    expect(alertsIn(dialog)[0]).toContain(EMAIL.name);
  });
});
