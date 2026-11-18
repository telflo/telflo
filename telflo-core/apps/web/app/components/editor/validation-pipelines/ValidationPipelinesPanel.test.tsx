/**
 * The Testing tab's Validation subtab (D15a Task 8: decisions 5, 6, 12, 13
 * and 18; Preflight rulings 26 and 27): validation pipelines created
 * (taken pipelines disabled) and deleted (confirmed); each rule editor
 * mode's fields and the rule it saves; Record count's and Between's
 * refusals; the OTTL contexts per signal; builder rules reopening in their
 * builder and other OTTL in OTTL mode; a rule's delete, confirmed; the API's
 * refusals shown (a broken condition, the evaluator down, the rate limit);
 * the stale warning against the editor's text; the empty states, a failed
 * read and its Retry; a published version's rules editable; where the focus
 * goes; and replay's rule (no rule text in an attribute outside
 * `ph-no-capture`). Ruling 45's follow-up: a rule's context never changes
 * silently (a builder only on the context it saves), the form's problems
 * announced politely, Go's blank, every field held during a save, the
 * count's bound, a builder rule's and a mode change's PATCH, and the API's
 * refusal under the builders. Ruling 46: each of a refusal's problems under
 * the field it names, else the mode's main field. Ruling 50: two problems on
 * one field. Ruling 56: a save's answer acts only on its dialog's session
 * (P1, P1b, New validation pipeline's), Go's whitespace trimmed (P3), the
 * 8,192-byte bound (P4), an unreadable request's words inline, a teammate's
 * delete (404) closing the editor, the focus to the card's header, and only
 * logs, traces and metrics pipelines offered. Ruling 57: a rule's Edit and
 * Delete held while a change or delete of it is under way (probe A), the
 * focus to "+ Pipeline" when the card is gone (probe B), Name's and
 * Description's problems cleared as they are edited (probe C), the
 * attribute builder's Go trim, Save kept held through an abandoned answer,
 * and the too-long problem under the field that makes it so (probe D).
 * Ruling 59: a change answered after the version was left and come back to
 * mid-save opens in Edit (the review's probe), the focus to "+ Pipeline"
 * when the card goes under a rule's delete confirmation or with a delete
 * answered "validation pipeline not found", and a refused change (400, 503,
 * the server not reached) giving its rule's Edit and Delete back.
 * Ruling 61: the focus to the card now at its place, else "+ Pipeline",
 * when a card goes under its pipeline's delete confirmation (probe E), and
 * a change answered after the version was left and come back to read again,
 * a teammate's later change kept (probe F).
 * Ruling 26: a card editor's save answered after a version switch (the
 * editor gone with its card) toasts nothing; an edit given a prefill too
 * opens the rule as stored.
 *
 * Rendered in the whole tab, as the Suites subtab's tests are: Monaco is
 * stubbed; the API is its client's functions, spied on, over a little
 * in-memory API; toasts are spied on.
 */

import type { EditorProps } from "@monaco-editor/react";
import {
  RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
  signalOfPipeline,
  validationPipelineExistsMessage,
  VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH,
  VALIDATION_RULE_NAME_MAXIMUM_LENGTH,
  type CreateValidationRuleRequest,
  type UpdateValidationRuleRequest,
  type ValidationPipeline,
  type ValidationPipelinesResponse,
  type ValidationRule,
  type ValidationRuleResponse,
} from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
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
import { GROUP_ID, MEMBER_ID, MINE, PUBLISHED_FIELDS, signedInMember, versionFixture } from "~/test/configurations.js";
import { testRunFixture } from "~/test/test-runs.js";
import { testDefinitionFixture, testSuiteFixture } from "~/test/test-suites.js";
import { validationPipelineFixture, validationRuleFixture } from "~/test/validation-pipelines.js";
import { TestingTab } from "../test-runs/TestingTab.js";
import { RuleEditorDialog } from "./RuleEditorDialog.js";

/** Four pipelines, one of each signal and a second logs one whose name carries the private-text marker. */
const YAML = `receivers:
  otlp:
    protocols:
      http: {}
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
    logs/zqotlp:
      receivers: [otlp]
      exporters: [debug]
`;

const VERSION = versionFixture({ yamlContent: YAML });
const TARGET = [GROUP_ID, MINE.id, VERSION.id] as const;
const LOGS = validationPipelineFixture();
const TRACES = validationPipelineFixture({ id: "0199f300-0000-7000-8000-0000000000b1", pipeline: "traces", signal: "traces" });
const METRICS = validationPipelineFixture({ id: "0199f300-0000-7000-8000-0000000000b2", pipeline: "metrics", signal: "metrics" });
const RULE = validationRuleFixture();

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

let toastError: MockInstance<typeof toast.error>;

/** A little API: the version's validation pipelines and each one's rules, written by the client's calls. */
const api = {
  pipelines: [] as ValidationPipeline[],
  rules: {} as Record<string, ValidationRule[]>,
  nextId: 0,
};

function newId(prefix: string): string {
  api.nextId += 1;
  return `${prefix}-0000-7000-8000-${String(api.nextId).padStart(12, "0")}`;
}

/** The rule the API keeps for a create's or a change's request. */
function stored(base: ValidationRule, request: CreateValidationRuleRequest | UpdateValidationRuleRequest): ValidationRule {
  const content =
    request.kind === undefined
      ? {}
      : { kind: request.kind, target: request.target ?? base.target, pattern: request.pattern ?? null, ottl: request.ottl ?? null };
  return {
    ...base,
    ...content,
    name: (request.name ?? base.name).trim(),
    description: (request.description ?? base.description).trim(),
  };
}

function serveApi() {
  return {
    listPipelines: vi
      .spyOn(apiClient, "getValidationPipelines")
      // Fresh objects each read, as the API's JSON is: a re-read hands the cards new props.
      .mockImplementation(async () => ({ validationPipelines: api.pipelines.map((each) => ({ ...each })) })),
    createPipeline: vi.spyOn(apiClient, "createValidationPipeline").mockImplementation(async (_o, _c, _v, request) => {
      if (api.pipelines.some((each) => each.pipeline === request.pipeline)) {
        throw new ApiError("validation_pipeline_exists", validationPipelineExistsMessage(request.pipeline), { status: 409 });
      }
      const validationPipeline = validationPipelineFixture({
        id: newId("0199f3aa"),
        pipeline: request.pipeline,
        signal: signalOfPipeline(request.pipeline) ?? "logs",
      });
      api.pipelines.push(validationPipeline);
      return { validationPipeline };
    }),
    deletePipeline: vi.spyOn(apiClient, "deleteValidationPipeline").mockImplementation(async (_o, _c, _v, id) => {
      api.pipelines = api.pipelines.filter((each) => each.id !== id);
      return undefined;
    }),
    listRules: vi
      .spyOn(apiClient, "getValidationRules")
      .mockImplementation(async (_o, _c, _v, pipelineId) => ({ rules: (api.rules[pipelineId] ?? []).map((each) => ({ ...each })) })),
    createRule: vi.spyOn(apiClient, "createValidationRule").mockImplementation(async (_o, _c, _v, pipelineId, request) => {
      const listed = api.rules[pipelineId] ?? [];
      const rule = stored(
        validationRuleFixture({
          id: newId("0199f4aa"),
          validationPipelineId: pipelineId,
          position: Math.max(0, ...listed.map((each) => each.position)) + 1,
          name: "",
          description: "",
        }),
        request,
      );
      api.rules[pipelineId] = [...listed, rule];
      return { rule };
    }),
    updateRule: vi.spyOn(apiClient, "updateValidationRule").mockImplementation(async (_o, _c, _v, pipelineId, ruleId, request) => {
      const listed = api.rules[pipelineId] ?? [];
      const rule = stored(listed.find((each) => each.id === ruleId)!, request);
      api.rules[pipelineId] = listed.map((each) => (each.id === ruleId ? rule : each));
      return { rule };
    }),
    deleteRule: vi.spyOn(apiClient, "deleteValidationRule").mockImplementation(async (_o, _c, _v, pipelineId, ruleId) => {
      api.rules[pipelineId] = (api.rules[pipelineId] ?? []).filter((each) => each.id !== ruleId);
      return undefined;
    }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  useTestingStore.getState().reset();
  useTestSuitesStore.getState().reset();
  useValidationPipelinesStore.getState().reset();
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  api.pipelines = [];
  api.rules = {};
  api.nextId = 0;
  toastError = vi.spyOn(toast, "error");
  vi.spyOn(toast, "info").mockImplementation(() => "");
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: [] }));
  vi.spyOn(apiClient, "getTestSuites").mockImplementation(async () => ({ suites: [] }));
});

async function renderValidation() {
  const view = render(<TestingTab />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Validation" }));
  return { ...view, user };
}

type User = ReturnType<typeof userEvent.setup>;

/** A validation pipeline's card, by its pipeline's name (text). */
async function card(pipeline: string) {
  return (await screen.findByText(pipeline, { selector: "li span.font-mono" })).closest("li")!;
}

/** Expands a card and waits for its rules (read as it mounted). */
async function expand(user: User, pipeline: string) {
  const each = await card(pipeline);
  await user.click(within(each).getByRole("button", { expanded: false }));
  await waitFor(() => expect(within(each).queryByRole("status")).toBeNull());
  return each;
}

/** Chooses `option` in the combobox labelled `label`, inside `scope`. */
async function choose(user: User, scope: HTMLElement, label: string, option: string) {
  await user.click(within(scope).getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Opens the rule editor from a card's "Add Validation Rule". */
async function openAddRule(user: User, pipeline: string) {
  const each = await expand(user, pipeline);
  await user.click(within(each).getByRole("button", { name: "Add Validation Rule" }));
  return screen.findByRole("dialog", { name: "Add validation rule" });
}

/** Types `text` into `field` as it is: user-event's `{` and `[` (its key descriptors) doubled. */
async function typeIn(user: User, field: HTMLElement, text: string) {
  await user.type(field, text.replace(/[{[]/g, "$&$&"));
}

/** Types `text` into `field`, replacing what is there. */
async function retype(user: User, field: HTMLElement, text: string) {
  await user.clear(field);
  if (text !== "") await typeIn(user, field, text);
}

describe("the Validation subtab", () => {
  it("sits between Tests and Suites, and reads the version's pipelines each time it shows: 'No validation pipelines yet. Click + Pipeline to create one.'", async () => {
    const { listPipelines } = serveApi();
    const { user } = await renderValidation();

    expect(within(screen.getByRole("tablist")).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Tests", "Validation", "Suites"]);
    expect(await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.")).toBeInTheDocument();
    expect(listPipelines).toHaveBeenCalledTimes(1);
    expect(listPipelines).toHaveBeenCalledWith(...TARGET, { signal: expect.any(AbortSignal) });

    api.pipelines = [LOGS];
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await user.click(screen.getByRole("tab", { name: "Validation" }));

    expect(await card("logs")).toBeInTheDocument();
    expect(listPipelines).toHaveBeenCalledTimes(2);
  });

  it("shows a spinner while the pipelines are read", async () => {
    serveApi();
    let release: (value: ValidationPipelinesResponse) => void = () => undefined;
    vi.spyOn(apiClient, "getValidationPipelines").mockReturnValue(new Promise((resolve) => (release = resolve)));
    await renderValidation();

    expect(screen.getByRole("status", { name: "Loading validation pipelines" })).toBeInTheDocument();
    await act(async () => release({ validationPipelines: [] }));
    expect(await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.")).toBeInTheDocument();
  });

  it("reads the new version's pipelines when the version changes", async () => {
    const { listPipelines } = serveApi();
    api.pipelines = [LOGS];
    await renderValidation();
    await card("logs");

    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
    api.pipelines = [];
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));

    expect(await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.")).toBeInTheDocument();
    expect(listPipelines).toHaveBeenLastCalledWith(GROUP_ID, MINE.id, other.id, { signal: expect.any(AbortSignal) });
  });

  it("says 'Load a configuration version to manage validation rules.' with no version", async () => {
    serveApi();
    await renderValidation();
    await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.");

    act(() => useEditorStore.getState().reset());

    expect(await screen.findByText("Load a configuration version to manage validation rules.")).toBeInTheDocument();
  });

  it("explains itself in its words", async () => {
    serveApi();
    const { user } = await renderValidation();

    await user.click(screen.getByRole("button", { name: "What are validation pipelines?" }));

    const help = await screen.findByRole("dialog");
    expect(within(help).getByText("Validation")).toBeInTheDocument();
    expect(help).toHaveTextContent(
      "Validation pipelines group validation rules by the YAML pipeline they check. When you run a test against a pipeline, only the rules in that pipeline's group are evaluated.",
    );
  });

  it("shows a failed read inline with Retry, 'Failed to load validation pipelines', and reads again; a refusal in its own words", async () => {
    const { listPipelines } = serveApi();
    listPipelines.mockRejectedValueOnce(new ApiError("internal_error", "Internal error", { status: 500 }));
    api.pipelines = [LOGS];
    const { user } = await renderValidation();

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load validation pipelines");
    expect(screen.queryByText("No validation pipelines yet. Click + Pipeline to create one.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await card("logs")).toBeInTheDocument();
    expect(screen.queryByText("Failed to load validation pipelines")).toBeNull();

    listPipelines.mockRejectedValueOnce(new ApiError("configuration_version_not_found", "Version not found", { status: 404 }));
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await user.click(screen.getByRole("tab", { name: "Validation" }));
    expect(await screen.findByText("Version not found")).toBeInTheDocument();
  });
});

describe("validation pipelines", () => {
  it("creates one: 'New validation pipeline', the editor's pipelines with taken ones disabled, its hint, OK held until one is chosen; it joins the list", async () => {
    const { createPipeline } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    await card("logs");

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    const dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    expect(dialog).toHaveTextContent("Rules in this group only run against tests that target this pipeline.");
    expect(within(dialog).getByRole("button", { name: "OK" })).toBeDisabled();

    await user.click(within(dialog).getByRole("combobox", { name: "Pipeline" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "traces",
      "metrics",
      "logs — already has a validation pipeline",
      "logs/zqotlp",
    ]);
    expect(screen.getByRole("option", { name: "logs — already has a validation pipeline" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "metrics" })).not.toHaveAttribute("aria-disabled");
    // The values are the pipelines' opaque ids, never their names.
    expect(screen.getByRole("listbox").closest(".ph-no-capture")).not.toBeNull();
    await user.click(screen.getByRole("option", { name: "metrics" }));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New validation pipeline" })).toBeNull());
    expect(createPipeline).toHaveBeenCalledWith(...TARGET, { pipeline: "metrics" });
    expect(await card("metrics")).toBeInTheDocument();
    expect([...document.querySelectorAll("li span.font-mono")].map((name) => name.textContent)).toEqual(["logs", "metrics"]);
    // The focus back to "+ Pipeline".
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });

  it("reads 'Creating…' while the API answers, and toasts the API's 409 words, keeping the dialog open", async () => {
    const { createPipeline } = serveApi();
    const { user } = await renderValidation();
    await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.");
    let refuse: (error: unknown) => void = () => undefined;
    createPipeline.mockReturnValueOnce(new Promise((_resolve, reject) => (refuse = reject)));

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    const dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    await choose(user, dialog, "Pipeline", "logs");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    await act(async () =>
      refuse(new ApiError("validation_pipeline_exists", validationPipelineExistsMessage("logs"), { status: 409 })),
    );

    expect(toastError).toHaveBeenCalledWith('Pipeline "logs" already has a validation pipeline for this version.');
    expect(screen.getByRole("dialog", { name: "New validation pipeline" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "OK" })).toBeEnabled();
  });

  it("deletes one only once confirmed: 'Delete validation pipeline?', its words, 'Deleting...' while the API answers; Cancel deletes nothing", async () => {
    const { deletePipeline } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const logs = await card("logs");

    await user.click(within(logs).getByRole("button", { name: "Delete validation pipeline" }));
    let confirmation = await screen.findByRole("alertdialog", { name: "Delete validation pipeline?" });
    expect(confirmation).toHaveTextContent("Really delete the validation pipeline logs and all its validation rules?");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletePipeline).not.toHaveBeenCalled();
    // Back to the card's Delete.
    await waitFor(() => expect(within(logs).getByRole("button", { name: "Delete validation pipeline" })).toHaveFocus());

    let release: () => void = () => undefined;
    deletePipeline.mockImplementationOnce(async (_o, _c, _v, id) => {
      await new Promise<void>((resolve) => (release = resolve));
      api.pipelines = api.pipelines.filter((each) => each.id !== id);
      return undefined;
    });
    await user.click(within(logs).getByRole("button", { name: "Delete validation pipeline" }));
    confirmation = await screen.findByRole("alertdialog", { name: "Delete validation pipeline?" });
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    expect(within(confirmation).getByRole("button", { name: "Deleting..." })).toBeDisabled();
    await act(async () => release());

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletePipeline).toHaveBeenCalledWith(...TARGET, LOGS.id);
    expect(await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.")).toBeInTheDocument();
    // None left: the focus to "+ Pipeline".
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });

  it("moves the focus after a pipeline's delete to the next card's header, else the previous one's", async () => {
    serveApi();
    const traces = validationPipelineFixture({ id: "0199f300-0000-7000-8000-000000000002", pipeline: "traces", signal: "traces" });
    api.pipelines = [LOGS, traces];
    const { user } = await renderValidation();

    await user.click(within(await card("logs")).getByRole("button", { name: "Delete validation pipeline" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(within(cardSync("traces")).getByRole("button", { expanded: false })).toHaveFocus());

    api.pipelines = [traces, LOGS];
    act(() => useValidationPipelinesStore.setState({ pipelines: [traces, LOGS] }));
    await user.click(within(await card("logs")).getByRole("button", { name: "Delete validation pipeline" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(within(cardSync("traces")).getByRole("button", { expanded: false })).toHaveFocus());
  });

  it("has no button nested inside the card's expand button, and describes Delete by the pipeline's name", async () => {
    serveApi();
    api.pipelines = [LOGS];
    await renderValidation();
    const logs = await card("logs");

    for (const button of logs.querySelectorAll("button")) expect(button.querySelector("button")).toBeNull();
    expect(within(logs).getByRole("button", { name: "Delete validation pipeline" })).toHaveAccessibleDescription("logs");
  });
});

/** A card, synchronously, once it shows. */
function cardSync(pipeline: string) {
  return screen.getByText(pipeline, { selector: "li span.font-mono" }).closest("li")!;
}

describe("the stale warning (decision 18's correction: the editor's current text)", () => {
  const WARNING = "pipeline not found in current YAML";
  const TITLE = "This pipeline is not defined in the current YAML — rules here won't run until it is.";

  it("marks a card whose pipeline isn't in the editor's text, and follows the text as it changes; the card stays editable", async () => {
    serveApi();
    const gone = validationPipelineFixture({ id: "0199f300-0000-7000-8000-000000000002", pipeline: "metrics/zqgone", signal: "metrics" });
    api.pipelines = [LOGS, gone];
    const { user } = await renderValidation();

    const stale = await card("metrics/zqgone");
    expect(within(stale).getByText(WARNING).parentElement).toHaveAttribute("title", TITLE);
    expect(within(await card("logs")).queryByText(WARNING)).toBeNull();

    // The text changes (typed, then applied): logs leaves it, metrics/zqgone arrives.
    act(() => {
      useEditorStore.getState().setText(YAML.replace("    logs:\n", "    metrics/zqgone:\n"));
      useEditorStore.getState().apply();
    });

    expect(within(cardSync("logs")).getByText(WARNING)).toBeInTheDocument();
    expect(within(cardSync("metrics/zqgone")).queryByText(WARNING)).toBeNull();
    // Still editable: its rules open, and a rule can be added.
    const logs = await expand(user, "logs");
    expect(within(logs).getByRole("button", { name: "Add Validation Rule" })).toBeEnabled();
  });
});

describe("a validation pipeline's rules", () => {
  it("are read as the card mounts, before it is expanded; 'No validation rules yet.'", async () => {
    const { listRules } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    await card("logs");

    await waitFor(() => expect(listRules).toHaveBeenCalledWith(...TARGET, LOGS.id, { signal: expect.any(AbortSignal) }));
    const logs = await expand(user, "logs");
    expect(within(logs).getByText("No validation rules yet.")).toBeInTheDocument();
    expect(listRules).toHaveBeenCalledTimes(1);
  });

  it("show a failed read inline with Retry, 'Failed to load validation rules', and read again", async () => {
    const { listRules } = serveApi();
    listRules.mockRejectedValueOnce(new ApiError("internal_error", "Internal error", { status: 500 }));
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");

    expect(within(logs).getByRole("alert")).toHaveTextContent("Failed to load validation rules");
    await user.click(within(logs).getByRole("button", { name: "Retry" }));

    expect(await within(logs).findByText("Does not contain: zq-no-secrets")).toBeInTheDocument();
    expect(within(logs).queryByText("Failed to load validation rules")).toBeNull();
  });

  it("show each rule by its name, else its summary, and name each row's Edit and Delete by hidden text: 'Edit rule 2: <summary>'", async () => {
    serveApi();
    const ottl = validationRuleFixture({
      id: "0199f400-0000-7000-8000-000000000002",
      position: 5,
      kind: "ottl",
      pattern: null,
      ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "zqprod"' },
      name: "",
    });
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE, ottl] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");

    expect(within(logs).getByText("Does not contain: zq-no-secrets")).toBeInTheDocument();
    expect(within(logs).getByText('OTTL: all log: attributes["env"] == "zqprod"')).toBeInTheDocument();
    for (const name of [
      "Edit rule 1: zq-no-secrets",
      "Delete rule 1: zq-no-secrets",
      'Edit rule 2: all log: attributes["env"] == "zqprod"',
      'Delete rule 2: all log: attributes["env"] == "zqprod"',
    ]) {
      const button = within(logs).getByRole("button", { name });
      // By reference to hidden text, never an aria-label.
      expect(button).toHaveAttribute("aria-labelledby");
      expect(button).not.toHaveAttribute("aria-label");
    }
  });

  it("are deleted only once confirmed (new): 'Delete validation rule?' with its name; Cancel deletes nothing, the focus back to its Delete; then to the next row's Edit, else the previous one's, else Add Validation Rule", async () => {
    const { deleteRule } = serveApi();
    const second = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 2, name: "zq-second" });
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE, second] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");

    await user.click(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" }));
    let confirmation = await screen.findByRole("alertdialog", { name: "Delete validation rule?" });
    expect(confirmation).toHaveTextContent("Delete the validation rule Does not contain: zq-no-secrets?");
    expect(confirmation).toHaveClass("ph-no-capture");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteRule).not.toHaveBeenCalled();
    await waitFor(() => expect(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" })).toHaveFocus());

    await user.click(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" }));
    confirmation = await screen.findByRole("alertdialog", { name: "Delete validation rule?" });
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteRule).toHaveBeenCalledWith(...TARGET, LOGS.id, RULE.id);
    expect(within(logs).queryByText("Does not contain: zq-no-secrets")).toBeNull();
    // The next row, now the first: its Edit, renamed by its new place.
    await waitFor(() => expect(within(logs).getByRole("button", { name: "Edit rule 1: zq-second" })).toHaveFocus());

    await user.click(within(logs).getByRole("button", { name: "Delete rule 1: zq-second" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(logs).getByText("No validation rules yet.")).toBeInTheDocument();
    await waitFor(() => expect(within(logs).getByRole("button", { name: "Add Validation Rule" })).toHaveFocus());
  });

  it("keep a rule's confirmation open on a refused delete, with the API's words, else fixed words", async () => {
    const { deleteRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    deleteRule.mockRejectedValueOnce(new ApiError("unexpected_response", "The server returned an unexpected response.", { status: 502 }));

    await user.click(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete rule"));
    expect(screen.getByRole("alertdialog", { name: "Delete validation rule?" })).toBeInTheDocument();
  });

  it("are editable on a published version (decision 13): a pipeline created, a rule added, changed and deleted", async () => {
    const { createRule, updateRule, deleteRule } = serveApi();
    const published = versionFixture({ yamlContent: YAML, ...PUBLISHED_FIELDS });
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: published });
    const { user } = await renderValidation();

    await user.click(await screen.findByRole("button", { name: "Add validation pipeline" }));
    const dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    await choose(user, dialog, "Pipeline", "logs");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    const editor = await openAddRule(user, "logs");
    await typeIn(user, within(editor).getByLabelText("Text"), "zq-token");
    await user.click(within(editor).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const logs = cardSync("logs");

    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-token" }));
    const editing = await screen.findByRole("dialog", { name: "Edit validation rule" });
    await typeIn(user, within(editing).getByLabelText("Name"), "zq-named");
    await user.click(within(editing).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(logs).getByRole("button", { name: "Delete rule 1: zq-named" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(logs).getByText("No validation rules yet.")).toBeInTheDocument());

    expect(createRule).toHaveBeenCalledTimes(1);
    expect(updateRule).toHaveBeenCalledTimes(1);
    expect(deleteRule).toHaveBeenCalledTimes(1);
  });
});

describe("the rule editor's modes (all four, and the rules they save)", () => {
  /** Adds a rule on `pipeline` through `fill`, and answers the request the API was sent. */
  async function addRule(user: User, pipeline: string, fill: (dialog: HTMLElement) => Promise<void>) {
    const { createRule } = serveApi();
    const validationPipeline = validationPipelineFixture({
      id: "0199f300-0000-7000-8000-0000000000aa",
      pipeline,
      signal: signalOfPipeline(pipeline) ?? "logs",
    });
    api.pipelines = [validationPipeline];
    await renderValidation();
    const dialog = await openAddRule(user, pipeline);
    await fill(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    return createRule.mock.calls[0]?.[4];
  }

  it("opens on Match output text: Does Not Contain, Text, Read from Output; its description; the hints follow the stream; Add rule held until a value", async () => {
    serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");

    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("Match output text");
    expect(dialog).toHaveTextContent(
      "Sweep the pipeline output — or the collector log — for text or a regex, and pass when it's present (or absent).",
    );
    expect(within(dialog).getByRole("combobox", { name: "Read from" })).toHaveTextContent("Output (pipeline records)");
    expect(dialog).toHaveTextContent("Reads the OTLP records that flowed through your pipeline. Default for new rules.");
    expect(within(dialog).getByRole("combobox", { name: "Match" })).toHaveTextContent("Does Not Contain");
    expect(within(dialog).getByRole("combobox", { name: "Type" })).toHaveTextContent("Text");
    expect(within(dialog).getByRole("button", { name: "Add rule" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("maxLength", String(VALIDATION_RULE_NAME_MAXIMUM_LENGTH));
    expect(within(dialog).getByLabelText("Description")).toHaveAttribute("maxLength", String(VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH));

    await choose(user, dialog, "Read from", "Stderr (collector log)");
    expect(dialog).toHaveTextContent("Reads the collector's diagnostic log");
    await choose(user, dialog, "Type", "Regex");
    expect(within(dialog).getByLabelText("Regex pattern")).toHaveAttribute("placeholder", "^error:.*");
  });

  it("Match output text saves a text or regex rule: its kind from Match and Type, its stream, its pattern, name and description", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "logs", async (dialog) => {
      await choose(user, dialog, "Read from", "Stderr (collector log)");
      await choose(user, dialog, "Match", "Contains");
      await choose(user, dialog, "Type", "Regex");
      await typeIn(user, within(dialog).getByLabelText("Regex pattern"), "\\b\\d{3}-\\d{2}-\\d{4}\\b");
      await typeIn(user, within(dialog).getByLabelText("Name"), "  zq SSN guard ");
      await typeIn(user, within(dialog).getByLabelText("Description"), "zq-why");
    });

    expect(request).toEqual({
      kind: "contains_regex",
      target: "stderr",
      pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
      name: "zq SSN guard",
      description: "zq-why",
    });
  });

  it("Record count saves the canonical count control on the signal's record context: Between From To", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "traces", async (dialog) => {
      await choose(user, dialog, "Rule type", "Record count");
      expect(dialog).toHaveTextContent("Counts leaf records (datapoints, spans, or log records depending on the run's signal type).");
      await choose(user, dialog, "Operator", "Between");
      await retype(user, within(dialog).getByLabelText("From"), "2");
      await retype(user, within(dialog).getByLabelText("To"), "5");
    });

    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "span", condition: "true", quantifier: "count", count: { operator: "between", value: 2, value2: 5 } },
      name: "",
      description: "",
    });
  });

  it("Record count refuses a negative count, a fraction, an empty one, and an unordered Between (new), Add rule held", async () => {
    serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Rule type", "Record count");
    const add = within(dialog).getByRole("button", { name: "Add rule" });

    const value = within(dialog).getByLabelText("Value");
    await retype(user, value, "-1");
    expect(within(dialog).getByText("Value can't be negative")).toBeInTheDocument();
    expect(value).toHaveAttribute("aria-invalid", "true");
    expect(value).toHaveAccessibleDescription("Value can't be negative");
    expect(add).toBeDisabled();
    await retype(user, value, "1.5");
    expect(within(dialog).getByText("Value must be an integer")).toBeInTheDocument();
    await retype(user, value, "");
    expect(within(dialog).getByText("Value must be an integer")).toBeInTheDocument();
    await retype(user, value, "7");
    expect(add).toBeEnabled();

    await choose(user, dialog, "Operator", "Between");
    await retype(user, within(dialog).getByLabelText("To"), "3");
    expect(within(dialog).getByText("To can't be less than From")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("To")).toHaveAccessibleDescription("To can't be less than From");
    expect(add).toBeDisabled();
    await retype(user, within(dialog).getByLabelText("To"), "-3");
    expect(within(dialog).getByText("Value 2 can't be negative")).toBeInTheDocument();
    await retype(user, within(dialog).getByLabelText("To"), "7");
    expect(add).toBeEnabled();
  });

  it("refuses a count past 2,147,483,647 (the API's bound) and saves 2,147,483,647 itself", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "logs", async (dialog) => {
      const add = within(dialog).getByRole("button", { name: "Add rule" });
      // OTTL mode's count, and Record count's.
      await choose(user, dialog, "Rule type", "OTTL condition");
      await typeIn(user, within(dialog).getByLabelText("OTTL condition"), "true");
      await choose(user, dialog, "Require", "Matching count…");
      await retype(user, within(dialog).getByLabelText("Count"), "2147483648");
      expect(within(dialog).getByText("Count can't be more than 2,147,483,647")).toBeInTheDocument();
      await choose(user, dialog, "Rule type", "Record count");
      const value = within(dialog).getByLabelText("Value");
      await retype(user, value, "2147483648");
      expect(within(dialog).getByText("Value can't be more than 2,147,483,647")).toBeInTheDocument();
      expect(value).toHaveAccessibleDescription("Value can't be more than 2,147,483,647");
      expect(add).toBeDisabled();
      await retype(user, value, "2147483647");
      expect(add).toBeEnabled();
      await choose(user, dialog, "Operator", "Between");
      await retype(user, within(dialog).getByLabelText("To"), "2147483648");
      expect(within(dialog).getByText("Value 2 can't be more than 2,147,483,647")).toBeInTheDocument();
      expect(add).toBeDisabled();
      await retype(user, within(dialog).getByLabelText("To"), "2147483647");
      expect(add).toBeEnabled();
    });

    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: {
        context: "log",
        condition: "true",
        quantifier: "count",
        count: { operator: "between", value: 2_147_483_647, value2: 2_147_483_647 },
      },
      name: "",
      description: "",
    });
  });

  it("announces the form's problems in a polite live region kept in place across the modes, each tied to its field (Ruling 45)", async () => {
    serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    // There before any problem, empty: a region added with its words isn't announced.
    const region = dialog.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("");

    await choose(user, dialog, "Rule type", "Record count");
    const value = within(dialog).getByLabelText("Value");
    await retype(user, value, "-1");
    expect(dialog.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region).toHaveTextContent("Value can't be negative");
    expect(within(region as HTMLElement).getByText("Value can't be negative")).toBe(
      document.getElementById(value.getAttribute("aria-describedby")!),
    );
    await choose(user, dialog, "Operator", "Between");
    await retype(user, value, "4");
    await retype(user, within(dialog).getByLabelText("To"), "3");
    expect(region).toHaveTextContent("To can't be less than From");
    expect(within(dialog).getByLabelText("To")).toHaveAccessibleDescription("To can't be less than From");

    await choose(user, dialog, "Rule type", "Record attribute");
    expect(dialog.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region).toHaveTextContent("Attribute key is required");
    expect(within(dialog).getByLabelText("Attribute key")).toHaveAccessibleDescription("Attribute key is required");
    await choose(user, dialog, "Rule type", "OTTL condition");
    expect(region).toHaveTextContent("OTTL condition is required");
    expect(within(dialog).getByLabelText("OTTL condition")).toHaveAccessibleDescription("OTTL condition is required");
    // A problem isn't an alert: that's the API's refusal's.
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("holds Add rule on a text of Go's whitespace only (U+0085, U+00A0), as on an empty one, and leaves such a row filter out", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "metrics", async (dialog) => {
      const add = within(dialog).getByRole("button", { name: "Add rule" });
      await typeIn(user, within(dialog).getByLabelText("Text"), "\u0085");
      expect(add).toBeDisabled();
      await retype(user, within(dialog).getByLabelText("Text"), "\u00a0 \u0085");
      expect(add).toBeDisabled();
      await choose(user, dialog, "Rule type", "OTTL condition");
      await typeIn(user, within(dialog).getByLabelText("OTTL condition"), "\u0085");
      expect(within(dialog).getByText("OTTL condition is required")).toBeInTheDocument();
      expect(add).toBeDisabled();
      await choose(user, dialog, "Require", "Distinct values…");
      await typeIn(user, within(dialog).getByLabelText("Value expression"), "\u0085");
      expect(within(dialog).getByText("OTTL value expression is required")).toBeInTheDocument();
      await retype(user, within(dialog).getByLabelText("Value expression"), 'attributes["zq"]');
      // The row filter holds U+0085 only: blank, so left out.
      expect(within(dialog).getByLabelText("Row filter (optional)")).toHaveValue("\u0085");
      expect(add).toBeEnabled();
    });

    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "datapoint", quantifier: "distinct", expression: 'attributes["zq"]', count: { operator: "eq", value: 1 } },
      name: "",
      description: "",
    });
  });

  it("Record attribute saves Ana's rule: All records match, Record, env Equals prod → attributes[\"env\"] == \"prod\" on the log context", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "logs", async (dialog) => {
      await choose(user, dialog, "Rule type", "Record attribute");
      expect(within(dialog).getByText("Attribute key is required")).toBeInTheDocument();
      await choose(user, dialog, "Scope", "Record");
      await typeIn(user, within(dialog).getByLabelText("Attribute key"), "env");
      await choose(user, dialog, "Operator", "Equals");
      expect(within(dialog).getByText("Value is required for this operator")).toBeInTheDocument();
      await typeIn(user, within(dialog).getByLabelText("Value"), "prod");
    });

    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' },
      name: "",
      description: "",
    });
  });

  it("Record attribute's distinct values save a bare-attribute expression with its count; a $-JSONPath key is refused", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "metrics", async (dialog) => {
      await choose(user, dialog, "Rule type", "Record attribute");
      await choose(user, dialog, "Require", "Distinct values…");
      await typeIn(user, within(dialog).getByLabelText("Attribute key"), "$.route");
      expect(
        within(dialog).getByText("JSONPath keys are no longer supported — write the assertion in OTTL mode instead"),
      ).toBeInTheDocument();
      await retype(user, within(dialog).getByLabelText("Attribute key"), "http.route");
      await choose(user, dialog, "Distinct count", "At most");
      await retype(user, within(dialog).getByLabelText("Value"), "50");
    });

    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "resource", quantifier: "distinct", expression: 'attributes["http.route"]', count: { operator: "lte", value: 50 } },
      name: "",
      description: "",
    });
  });

  it("OTTL condition saves its context, quantifier and condition; its count; a distinct rule's expression, its blank filter left out", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "logs", async (dialog) => {
      await choose(user, dialog, "Rule type", "OTTL condition");
      expect(within(dialog).getByText("OTTL condition is required")).toBeInTheDocument();
      await choose(user, dialog, "Context", "resource");
      await choose(user, dialog, "Require", "Matching count…");
      await choose(user, dialog, "Operator", "Not exactly");
      await retype(user, within(dialog).getByLabelText("Count"), "0");
      await typeIn(user, within(dialog).getByLabelText("OTTL condition"), 'attributes["zq"] != nil');
    });
    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "resource", quantifier: "count", condition: 'attributes["zq"] != nil', count: { operator: "ne", value: 0 } },
      name: "",
      description: "",
    });
  });

  it("OTTL condition's Distinct values… saves the value expression and no condition when the filter is blank", async () => {
    const user = userEvent.setup();
    const request = await addRule(user, "metrics", async (dialog) => {
      await choose(user, dialog, "Rule type", "OTTL condition");
      await choose(user, dialog, "Require", "Distinct values…");
      expect(within(dialog).getByText("OTTL value expression is required")).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Row filter (optional)")).toBeInTheDocument();
      await typeIn(user, within(dialog).getByLabelText("Value expression"), 'attributes["route"]');
      await choose(user, dialog, "Operator", "Between");
      await retype(user, within(dialog).getByLabelText("From"), "1");
      await retype(user, within(dialog).getByLabelText("To"), "0");
      expect(within(dialog).getByText("To can't be less than From")).toBeInTheDocument();
      await retype(user, within(dialog).getByLabelText("To"), "9");
    });
    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "datapoint", quantifier: "distinct", expression: 'attributes["route"]', count: { operator: "between", value: 1, value2: 9 } },
      name: "",
      description: "",
    });
  });

  it.each([
    ["logs", "log", ["log", "resource", "scope"]],
    ["traces", "span", ["span", "spanevent", "resource", "scope"]],
    ["metrics", "datapoint", ["metric", "datapoint", "resource", "scope"]],
  ])("offers the %s pipeline's OTTL contexts only, its record context (%s) first chosen", async (pipeline, chosen, contexts) => {
    serveApi();
    api.pipelines = [validationPipelineFixture({ pipeline, signal: signalOfPipeline(pipeline) ?? "logs" })];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, pipeline);
    await choose(user, dialog, "Rule type", "OTTL condition");

    expect(within(dialog).getByRole("combobox", { name: "Context" })).toHaveTextContent(chosen);
    await user.click(within(dialog).getByRole("combobox", { name: "Context" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(contexts);
  });
});

describe("a rule reopened", () => {
  /** Opens the editor on `rule`, the only rule of `validationPipeline` (the logs pipeline's by default). */
  async function edit(rule: ValidationRule, validationPipeline: ValidationPipeline = LOGS) {
    serveApi();
    api.pipelines = [validationPipeline];
    api.rules = { [validationPipeline.id]: [{ ...rule, validationPipelineId: validationPipeline.id }] };
    const { user } = await renderValidation();
    const each = await expand(user, validationPipeline.pipeline);
    await user.click(within(each).getAllByRole("button", { name: /^Edit rule 1: / })[0]!);
    return { user, dialog: await screen.findByRole("dialog", { name: "Edit validation rule" }) };
  }

  /** Saves the editor and answers the change the API was sent. */
  async function save(user: User, dialog: HTMLElement) {
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    return vi.mocked(apiClient.updateValidationRule).mock.calls[0]?.[5];
  }

  const ottlRule = (ottl: ValidationRule["ottl"]) =>
    validationRuleFixture({ kind: "ottl", target: "output", pattern: null, ottl, name: "zq-ottl", description: "" });

  it("opens a text rule in Match output text with its fields; Save sends the rule whole (Ruling 38)", async () => {
    const { user, dialog } = await edit(validationRuleFixture({ target: "stderr", kind: "contains_regex", pattern: "^zq" }));

    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("Match output text");
    expect(within(dialog).getByRole("combobox", { name: "Read from" })).toHaveTextContent("Stderr (collector log)");
    expect(within(dialog).getByRole("combobox", { name: "Match" })).toHaveTextContent("Contains");
    expect(within(dialog).getByRole("combobox", { name: "Type" })).toHaveTextContent("Regex");
    expect(within(dialog).getByLabelText("Regex pattern")).toHaveValue("^zq");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("zq-no-secrets");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("zq-rule-description");

    await retype(user, within(dialog).getByLabelText("Description"), "");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(vi.mocked(apiClient.updateValidationRule)).toHaveBeenCalledWith(...TARGET, LOGS.id, RULE.id, {
      kind: "contains_regex",
      target: "stderr",
      pattern: "^zq",
      name: "zq-no-secrets",
      description: "",
    });
  });

  it("opens a Record count rule in its builder, its operator and bounds filled", async () => {
    const { dialog } = await edit(ottlRule({ context: "log", condition: "true", quantifier: "count", count: { operator: "between", value: 3, value2: 8 } }));

    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("Record count");
    expect(within(dialog).getByRole("combobox", { name: "Operator" })).toHaveTextContent("Between");
    expect(within(dialog).getByLabelText("From")).toHaveValue(3);
    expect(within(dialog).getByLabelText("To")).toHaveValue(8);
  });

  it("opens a Record attribute rule in its builder, its key, operator and value filled", async () => {
    const { dialog } = await edit(ottlRule({ context: "resource", quantifier: "none", condition: 'attributes["zq.key"] == "zq value"' }));

    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("Record attribute");
    expect(within(dialog).getByRole("combobox", { name: "Require" })).toHaveTextContent("No record matches");
    expect(within(dialog).getByRole("combobox", { name: "Scope" })).toHaveTextContent("Resource");
    expect(within(dialog).getByLabelText("Attribute key")).toHaveValue("zq.key");
    expect(within(dialog).getByRole("combobox", { name: "Operator" })).toHaveTextContent("Equals");
    expect(within(dialog).getByLabelText("Value")).toHaveValue("zq value");
  });

  it("opens any other OTTL in OTTL condition mode, as written", async () => {
    const { dialog } = await edit(
      ottlRule({ context: "log", quantifier: "any", condition: 'attributes["a"] != nil and IsMatch(body, "zq.*")' }),
    );

    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("OTTL condition");
    expect(within(dialog).getByRole("combobox", { name: "Context" })).toHaveTextContent("log");
    expect(within(dialog).getByRole("combobox", { name: "Require" })).toHaveTextContent("At least one matches");
    expect(within(dialog).getByLabelText("OTTL condition")).toHaveValue('attributes["a"] != nil and IsMatch(body, "zq.*")');
  });

  it.each([
    ["a traces spanevent none-rule", TRACES, { context: "spanevent", quantifier: "none", condition: 'attributes["zq"] != nil' }],
    ["a metrics metric-context rule", METRICS, { context: "metric", quantifier: "all", condition: 'attributes["zq"] == "zqv"' }],
    [
      "a logs resource count rule",
      LOGS,
      { context: "resource", condition: "true", quantifier: "count", count: { operator: "gte", value: 1 } },
    ],
  ] as const)(
    "opens %s, a builder's shape on a context its builder doesn't save, in OTTL condition mode; a rename PATCHes the same context (Ruling 45)",
    async (_what, validationPipeline, ottl) => {
      const { user, dialog } = await edit(ottlRule(ottl), validationPipeline);

      expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("OTTL condition");
      expect(within(dialog).getByRole("combobox", { name: "Context" })).toHaveTextContent(ottl.context);
      await typeIn(user, within(dialog).getByLabelText("Name"), "-renamed");

      expect(await save(user, dialog)).toEqual({ kind: "ottl", target: "output", ottl, name: "zq-ottl-renamed", description: "" });
    },
  );

  it("saves a reopened Record count rule as its builder's canonical OTTL, on the signal's record context", async () => {
    const { user, dialog } = await edit(
      ottlRule({ context: "datapoint", condition: "true", quantifier: "count", count: { operator: "gte", value: 2 } }),
      METRICS,
    );
    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("Record count");
    await retype(user, within(dialog).getByLabelText("Value"), "4");

    expect(await save(user, dialog)).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "datapoint", condition: "true", quantifier: "count", count: { operator: "gte", value: 4 } },
      name: "zq-ottl",
      description: "",
    });
  });

  it("saves a reopened Record attribute rule as its builder's canonical OTTL, on its record context", async () => {
    const { user, dialog } = await edit(ottlRule({ context: "span", quantifier: "none", condition: 'attributes["zq.key"] != nil' }), TRACES);
    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("Record attribute");
    expect(within(dialog).getByRole("combobox", { name: "Scope" })).toHaveTextContent("Record");
    await choose(user, dialog, "Operator", "Equals");
    await typeIn(user, within(dialog).getByLabelText("Value"), "zq v");

    expect(await save(user, dialog)).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "span", quantifier: "none", condition: 'attributes["zq.key"] == "zq v"' },
      name: "zq-ottl",
      description: "",
    });
  });

  it("sends the content whole when a rule's mode changes while editing: an OTTL rule saved as Match output text", async () => {
    const { user, dialog } = await edit(ottlRule({ context: "log", quantifier: "any", condition: 'attributes["a"] != nil and IsMatch(body, "zq.*")' }));
    await choose(user, dialog, "Rule type", "Match output text");
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-now-text");

    expect(await save(user, dialog)).toEqual({
      kind: "not_contains_text",
      target: "output",
      pattern: "zq-now-text",
      name: "zq-ottl",
      description: "",
    });
  });

  it("keeps what was typed when the rules are read again mid-edit, as fresh objects", async () => {
    const { user, dialog } = await edit(RULE);
    await retype(user, within(dialog).getByLabelText("Text"), "zq-typed");

    const before = useValidationPipelinesStore.getState().rulesByPipeline[LOGS.id]?.[0];
    await act(async () => {
      await useValidationPipelinesStore.getState().loadRules({ organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id }, LOGS.id);
    });
    // The rule answered afresh: a new object in the card's list.
    expect(useValidationPipelinesStore.getState().rulesByPipeline[LOGS.id]?.[0]).not.toBe(before);
    expect(vi.mocked(apiClient.getValidationRules)).toHaveBeenCalledTimes(2);

    expect(within(dialog).getByLabelText("Text")).toHaveValue("zq-typed");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("zq-no-secrets");
  });

  it("keeps what was typed when the pipelines are read again mid-edit (a late signal resets nothing)", async () => {
    const { user, dialog } = await edit(RULE);
    await retype(user, within(dialog).getByLabelText("Text"), "zq-typed");

    const before = useValidationPipelinesStore.getState().pipelines[0];
    await act(async () => {
      await useValidationPipelinesStore.getState().loadPipelines({ organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id });
    });
    // The pipeline answered afresh: a new object for the card.
    expect(useValidationPipelinesStore.getState().pipelines[0]).not.toBe(before);

    expect(within(dialog).getByLabelText("Text")).toHaveValue("zq-typed");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("zq-no-secrets");
  });
});

describe("the API's refusals at Save (decision 6)", () => {
  /** The logs pipeline's editor, adding an OTTL rule with Ben's broken condition. */
  async function brokenCondition() {
    const spies = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Rule type", "OTTL condition");
    await typeIn(user, within(dialog).getByLabelText("OTTL condition"), 'attributes["env"] == "prod');
    return { ...spies, user, dialog };
  }

  it("shows a broken condition's refusal as the API words it, under the condition, announced and tied to it; the dialog keeps the text", async () => {
    const { createRule, user, dialog } = await brokenCondition();
    const words = 'OTTL syntax error: 1:22: unexpected token "<EOF>" (expected "\\"")';
    createRule.mockRejectedValueOnce(new ApiError("validation_rule_invalid", words, { status: 400 }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(words);
    const condition = within(dialog).getByLabelText("OTTL condition");
    expect(condition).toHaveValue('attributes["env"] == "prod');
    expect(condition).toHaveAttribute("aria-invalid", "true");
    expect(condition).toHaveAccessibleDescription(words);
    expect(toastError).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Add rule" })).toBeEnabled();

    // Editing what it checks clears it.
    await typeIn(user, condition, '"');
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("shows a regex's refusal under its pattern: 'Invalid regex: …' (RE2's, not JavaScript's: a lookahead the browser accepts)", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Type", "Regex");
    // JavaScript would accept it; nothing here checks it.
    await typeIn(user, within(dialog).getByLabelText("Regex pattern"), "zq(?=x)");
    expect(within(dialog).getByRole("button", { name: "Add rule" })).toBeEnabled();
    const words = "Invalid regex: error parsing regexp: invalid or unsupported Perl syntax: `(?=`";
    createRule.mockRejectedValueOnce(new ApiError("validation_rule_invalid", words, { status: 400 }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(words);
    expect(within(dialog).getByLabelText("Regex pattern")).toHaveAccessibleDescription(words);
    expect(within(dialog).getByLabelText("Regex pattern")).toHaveValue("zq(?=x)");
  });

  it.each([
    ["Record count", "Value", async (_user: User, _dialog: HTMLElement) => undefined],
    [
      "Record attribute",
      "Attribute key",
      async (user: User, dialog: HTMLElement) => typeIn(user, within(dialog).getByLabelText("Attribute key"), "zq.key"),
    ],
  ])("shows a refusal under %s's fields, tied to its %s, announced; the dialog keeps the text", async (mode, label, fill) => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Rule type", mode);
    await fill(user, dialog);
    const words = "OTTL syntax error: zq";
    createRule.mockRejectedValueOnce(new ApiError("validation_rule_invalid", words, { status: 400 }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(words);
    const field = within(dialog).getByLabelText(label);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(words);
    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent(mode);
    expect(toastError).not.toHaveBeenCalled();
  });

  /** A 400 validation_rule_invalid as the API answers it: the first problem's words, each problem with its field in details (Ruling 46). */
  function invalid(...problems: { field: string; message: string }[]) {
    return new ApiError("validation_rule_invalid", problems[0]!.message, { status: 400, details: { problems } });
  }

  /** The logs pipeline's editor, adding a distinct OTTL rule with a Row filter and a value expression. */
  async function distinctRule() {
    const spies = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Rule type", "OTTL condition");
    await choose(user, dialog, "Require", "Distinct values…");
    await typeIn(user, within(dialog).getByLabelText("Row filter (optional)"), 'attributes["env"] == "prod"');
    await typeIn(user, within(dialog).getByLabelText("Value expression"), 'attributes["http.route"');
    return { ...spies, user, dialog };
  }

  /** The alert in the field's own block: shown under it. */
  function alertUnder(field: HTMLElement): HTMLElement {
    return within(field.parentElement!).getByRole("alert");
  }

  it("shows a distinct rule's broken expression under the value expression, not the Row filter: only the expression invalid (Ruling 46)", async () => {
    const { createRule, user, dialog } = await distinctRule();
    const words = 'OTTL syntax error: 1:12: unexpected token "<EOF>" (expected "]")';
    createRule.mockRejectedValueOnce(invalid({ field: "ottl.expression", message: words }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(words);
    const expression = within(dialog).getByLabelText("Value expression");
    const filter = within(dialog).getByLabelText("Row filter (optional)");
    expect(alertUnder(expression)).toHaveTextContent(words);
    expect(expression).toHaveAttribute("aria-invalid", "true");
    expect(expression).toHaveAccessibleDescription(words);
    expect(expression).toHaveValue('attributes["http.route"');
    expect(filter).not.toHaveAttribute("aria-invalid");
    expect(filter).not.toHaveAttribute("aria-describedby");
    expect(within(filter.parentElement!).queryByRole("alert")).toBeNull();
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows a condition's problem under the condition (a distinct rule's Row filter), the expression untouched", async () => {
    const { createRule, user, dialog } = await distinctRule();
    const words = "The condition nests brackets more than 12 deep.";
    createRule.mockRejectedValueOnce(invalid({ field: "ottl.condition", message: words }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    const filter = within(dialog).getByLabelText("Row filter (optional)");
    await waitFor(() => expect(alertUnder(filter)).toHaveTextContent(words));
    expect(filter).toHaveAttribute("aria-invalid", "true");
    expect(filter).toHaveAccessibleDescription(words);
    expect(within(dialog).getByLabelText("Value expression")).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
  });

  it("shows each of several problems under its own field, each field tied to its own words only", async () => {
    const { createRule, user, dialog } = await distinctRule();
    await choose(user, dialog, "Operator", "Between");
    const conditionWords = 'OTTL syntax error: 1:1: unexpected token "=="';
    const expressionWords = 'OTTL syntax error: 1:12: unexpected token "<EOF>" (expected "]")';
    const value2Words = "Between's second value can't be less than its first.";
    const contextWords = "The logs signal has no OTTL context zq.";
    createRule.mockRejectedValueOnce(
      invalid(
        { field: "ottl.context", message: contextWords },
        { field: "ottl.condition", message: conditionWords },
        { field: "ottl.count.value2", message: value2Words },
        { field: "ottl.expression", message: expressionWords },
      ),
    );

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(within(dialog).getAllByRole("alert")).toHaveLength(4));
    const expectations: [HTMLElement, string][] = [
      [within(dialog).getByRole("combobox", { name: "Context" }), contextWords],
      [within(dialog).getByLabelText("Row filter (optional)"), conditionWords],
      [within(dialog).getByLabelText("To"), value2Words],
      [within(dialog).getByLabelText("Value expression"), expressionWords],
    ];
    for (const [field, words] of expectations) {
      expect(alertUnder(field)).toHaveTextContent(words);
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription(words);
    }
    expect(within(dialog).getByRole("combobox", { name: "Require" })).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByLabelText("From")).not.toHaveAttribute("aria-invalid");
  });

  it.each([
    ["a field the editor doesn't know", { problems: [{ field: "zq.unknown", message: "OTTL syntax error: zq" }] }],
    ["a problem naming no field", { problems: [{ message: "OTTL syntax error: zq" }] }],
    ["details that aren't problems", { zq: true }],
  ])("falls back to the mode's main field for %s", async (_what, details) => {
    const { createRule, user, dialog } = await brokenCondition();
    createRule.mockRejectedValueOnce(new ApiError("validation_rule_invalid", "OTTL syntax error: zq", { status: 400, details }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    const condition = within(dialog).getByLabelText("OTTL condition");
    await waitFor(() => expect(alertUnder(condition)).toHaveTextContent("OTTL syntax error: zq"));
    expect(condition).toHaveAttribute("aria-invalid", "true");
    expect(condition).toHaveAccessibleDescription("OTTL syntax error: zq");
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
  });

  it("ties a builder's problems to the builder's fields: Record attribute's condition to its value, Record count's second value to To", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Rule type", "Record attribute");
    await typeIn(user, within(dialog).getByLabelText("Attribute key"), "zq.key");
    await choose(user, dialog, "Operator", "Matches regex");
    await typeIn(user, within(dialog).getByLabelText("Value"), "zq(");
    const regexWords = "OTTL syntax error: error parsing regexp: missing closing ): `zq(`";
    createRule.mockRejectedValueOnce(invalid({ field: "ottl.condition", message: regexWords }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    const value = within(dialog).getByLabelText("Value");
    await waitFor(() => expect(alertUnder(value)).toHaveTextContent(regexWords));
    expect(value).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText("Attribute key")).not.toHaveAttribute("aria-invalid");

    await choose(user, dialog, "Rule type", "Record count");
    await choose(user, dialog, "Operator", "Between");
    const betweenWords = "Between's second value can't be less than its first.";
    createRule.mockRejectedValueOnce(invalid({ field: "ottl.count.value2", message: betweenWords }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    const to = within(dialog).getByLabelText("To");
    await waitFor(() => expect(alertUnder(to)).toHaveTextContent(betweenWords));
    expect(to).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText("From")).not.toHaveAttribute("aria-invalid");
  });

  it.each([
    ["the evaluator down (503)", new ApiError("rules_unavailable", RULES_UNAVAILABLE_AT_SAVE_MESSAGE, { status: 503 }), RULES_UNAVAILABLE_AT_SAVE_MESSAGE],
    [
      "the rate limit (429)",
      new ApiError("validation_rule_rate_limited", "Too many rule checks. Try again in a minute.", { status: 429 }),
      "Too many rule checks. Try again in a minute.",
    ],
  ])("toasts %s in the API's words, keeping the dialog and its text", async (_what, error, words) => {
    const { createRule, user, dialog } = await brokenCondition();
    createRule.mockRejectedValueOnce(error);

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(words));
    expect(screen.getByRole("dialog", { name: "Add validation rule" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("OTTL condition")).toHaveValue('attributes["env"] == "prod');
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("shows two problems naming one field both under it, the field described by both (Ruling 50)", async () => {
    const { createRule, user, dialog } = await brokenCondition();
    const first = 'OTTL syntax error: 1:22: unexpected token "<EOF>" (expected "\\"")';
    const second = "OTTL syntax error: zq the second problem";
    createRule.mockRejectedValueOnce(invalid({ field: "ottl.condition", message: first }, { field: "ottl.condition", message: second }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    const condition = within(dialog).getByLabelText("OTTL condition");
    await waitFor(() => expect(within(condition.parentElement!).getAllByRole("alert")).toHaveLength(2));
    const alerts = within(condition.parentElement!).getAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent)).toEqual([first, second]);
    expect(condition.getAttribute("aria-describedby")?.split(" ")).toEqual(alerts.map((alert) => alert.id));
    expect(condition).toHaveAccessibleDescription(`${first} ${second}`);
    expect(condition).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getAllByRole("alert")).toHaveLength(2);
  });

  describe("an unreadable request (400 invalid_request): the API's words inline, never the generic toast (Ruling 56)", () => {
    /** The envelope's issue, as fastify-type-provider-zod words a request schema's (errors.ts forwards `error.validation`). */
    const zodIssue = (path: string[], message: string) => ({
      keyword: "custom",
      instancePath: `/${path.join("/")}`,
      schemaPath: `#/${path.join("/")}/custom`,
      params: { issue: { code: "custom", path, message } },
      message,
    });

    it("puts each issue under the field its path names: the condition's bound, the context's signal, the name", async () => {
      const { createRule, user, dialog } = await brokenCondition();
      const tooLong = "The condition is longer than 8,192 bytes.";
      const context = "The pipeline's signal doesn't have this OTTL context.";
      const name = "The name can't contain U+0000 or a lone surrogate.";
      createRule.mockRejectedValueOnce(
        new ApiError("invalid_request", "The request was not valid.", {
          status: 400,
          // The schema's issues, and the service's own (ottlContextNotOfSignal: a bare path).
          details: [zodIssue(["ottl", "condition"], tooLong), { path: ["ottl", "context"], message: context }, zodIssue(["name"], name)],
        }),
      );

      await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

      const condition = within(dialog).getByLabelText("OTTL condition");
      await waitFor(() => expect(alertUnder(condition)).toHaveTextContent(tooLong));
      expect(condition).toHaveAccessibleDescription(tooLong);
      expect(condition).toHaveAttribute("aria-invalid", "true");
      const contextField = within(dialog).getByRole("combobox", { name: "Context" });
      expect(alertUnder(contextField)).toHaveTextContent(context);
      expect(contextField).toHaveAccessibleDescription(context);
      const nameField = within(dialog).getByLabelText("Name");
      expect(alertUnder(nameField)).toHaveTextContent(name);
      expect(nameField).toHaveAccessibleDescription(name);
      expect(within(dialog).getAllByRole("alert")).toHaveLength(3);
      expect(toastError).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Add validation rule" })).toBeInTheDocument();
    });

    it("puts a pattern's issue under the pattern, and one with no details under the mode's main field in the API's words", async () => {
      const { createRule } = serveApi();
      api.pipelines = [LOGS];
      const { user } = await renderValidation();
      const dialog = await openAddRule(user, "logs");
      const pattern = within(dialog).getByLabelText("Text");
      await typeIn(user, pattern, "zq-pattern");
      const tooLong = "The pattern is longer than 8,192 bytes.";
      createRule.mockRejectedValueOnce(new ApiError("invalid_request", "The request was not valid.", { status: 400, details: [zodIssue(["pattern"], tooLong)] }));

      await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

      await waitFor(() => expect(alertUnder(pattern)).toHaveTextContent(tooLong));
      expect(pattern).toHaveAccessibleDescription(tooLong);

      await choose(user, dialog, "Rule type", "OTTL condition");
      await typeIn(user, within(dialog).getByLabelText("OTTL condition"), "true");
      createRule.mockRejectedValueOnce(new ApiError("invalid_request", "The request was not valid.", { status: 400 }));
      await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

      const condition = within(dialog).getByLabelText("OTTL condition");
      await waitFor(() => expect(alertUnder(condition)).toHaveTextContent("The request was not valid."));
      expect(toastError).not.toHaveBeenCalled();
    });
  });

  it("reads 'Saving...' while the API answers, every field held (Ruling 45), and gives them back on a refusal", async () => {
    const { createRule, user, dialog } = await brokenCondition();
    await choose(user, dialog, "Require", "Matching count…");
    let refuse: (error: unknown) => void = () => undefined;
    createRule.mockReturnValueOnce(new Promise((_resolve, reject) => (refuse = reject)));
    const fields = () => [
      ...within(dialog).getAllByRole("combobox"),
      ...within(dialog).getAllByRole("textbox"),
      ...within(dialog).getAllByRole("spinbutton"),
    ];
    // Rule type, Context, Require, Operator; Name, OTTL condition, Description; Count.
    expect(fields()).toHaveLength(8);

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();
    for (const each of fields()) expect(each).toBeDisabled();
    await act(async () => refuse(new ApiError("rules_unavailable", RULES_UNAVAILABLE_AT_SAVE_MESSAGE, { status: 503 })));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add rule" })).toBeEnabled());
    for (const each of fields()) expect(each).toBeEnabled();

    let answer: (value: ValidationRuleResponse) => void = () => undefined;
    createRule.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();
    await act(async () => answer({ rule: RULE }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the focus as the dialogs close", () => {
  it("goes back to the opener: Add Validation Rule, a row's Edit, + Pipeline", async () => {
    serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");

    await user.click(within(logs).getByRole("button", { name: "Add Validation Rule" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(logs).getByRole("button", { name: "Add Validation Rule" })).toHaveFocus());

    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    await screen.findByRole("dialog", { name: "Edit validation rule" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });
});

describe("a Play all under way while a Validation dialog shows (D14b Ruling 50's rule, extended)", () => {
  it("keeps the rule editor and what was typed in it: no switch to Tests under it, the run still queued", async () => {
    serveApi();
    api.pipelines = [LOGS];
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
    const dialog = await openAddRule(user, "logs");
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-kept");

    await act(async () => release({ definitions: [testDefinitionFixture()] }));

    await waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    // The dialog is modal: the tabs behind it are hidden from the accessibility tree.
    expect(screen.getByRole("tab", { name: "Validation", hidden: true })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("dialog", { name: "Add validation rule" })).getByLabelText("Text")).toHaveValue("zq-kept");
  });
});

describe("replay (Preflight ruling 27; ADR 0024)", () => {
  it("puts the panel and every dialog's content in ph-no-capture, and no pipeline name or rule text in an attribute outside it", async () => {
    serveApi();
    const zqPipeline = validationPipelineFixture({ id: "0199f300-0000-7000-8000-000000000002", pipeline: "logs/zqotlp" });
    const ottl = validationRuleFixture({
      id: "0199f400-0000-7000-8000-000000000002",
      position: 2,
      kind: "ottl",
      pattern: null,
      ottl: { context: "log", quantifier: "all", condition: 'attributes["zq"] == "zqvalue"' },
      name: "",
      description: "zq-ottl-description",
    });
    api.pipelines = [LOGS, zqPipeline];
    api.rules = { [LOGS.id]: [RULE, ottl] };
    const markers: string[] = [];
    /** Every attribute outside `ph-no-capture` carrying a marker; an input's value is masked by replay (maskAllInputs). */
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        if (element.closest(".ph-no-capture") !== null) continue;
        for (const attribute of element.attributes) {
          if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && attribute.name === "value") continue;
          if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
    };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    await expand(user, "logs/zqotlp");
    expect(logs.closest(".ph-no-capture")).not.toBeNull();
    scan();

    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    expect(dialog).toHaveClass("ph-no-capture");
    scan();
    await user.click(within(dialog).getByRole("combobox", { name: "Rule type" }));
    expect((await screen.findByRole("listbox")).closest(".ph-no-capture")).not.toBeNull();
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(logs).getByRole("button", { name: /^Edit rule 2: / }));
    dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    scan();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(logs).getByRole("button", { name: /^Delete rule 2: / }));
    expect(await screen.findByRole("alertdialog")).toHaveClass("ph-no-capture");
    scan();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(within(cardSync("logs/zqotlp")).getByRole("button", { name: "Delete validation pipeline" }));
    expect(await screen.findByRole("alertdialog")).toHaveClass("ph-no-capture");
    scan();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    expect(dialog).toHaveClass("ph-no-capture");
    await user.click(within(dialog).getByRole("combobox", { name: "Pipeline" }));
    await screen.findByRole("option", { name: /^logs\/zqotlp/ });
    scan();
    await user.keyboard("{Escape}");

    expect(markers).toEqual([]);
    // The scan saw them, as text.
    expect(screen.getAllByText("Does not contain: zq-no-secrets").length).toBeGreaterThan(0);
  });
});

describe("a save's answer and the dialog's session (Ruling 56)", () => {
  it("P1: a rule's add answered after Escape doesn't close the editor opened since, nor toasts; the rule joins the list all the same", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    let answer: (value: ValidationRuleResponse) => void = () => undefined;
    createRule.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    let dialog = await openAddRule(user, "logs");
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-first");
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const logs = cardSync("logs");
    await user.click(within(logs).getByRole("button", { name: "Add Validation Rule" }));
    dialog = await screen.findByRole("dialog", { name: "Add validation rule" });
    expect(within(dialog).getByLabelText("Text")).toHaveValue("");
    expect(within(dialog).getByLabelText("Text")).toBeEnabled();
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-second");

    await act(async () => answer({ rule: validationRuleFixture({ pattern: "zq-first", name: "", description: "" }) }));

    expect(screen.getByRole("dialog", { name: "Add validation rule" })).toBe(dialog);
    expect(within(dialog).getByLabelText("Text")).toHaveValue("zq-second");
    expect(within(dialog).getByRole("button", { name: "Add rule" })).toBeEnabled();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    // The store keeps what the API answered: the abandoned add shows in the card.
    expect(within(logs).getByText("Does not contain: zq-first")).toBeInTheDocument();

    // The new session's own save closes it.
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createRule).toHaveBeenLastCalledWith(...TARGET, LOGS.id, expect.objectContaining({ pattern: "zq-second" }));
  });

  it("P1b: a change refused after Escape puts nothing under the next rule's fields, nor toasts", async () => {
    const { updateRule } = serveApi();
    const other = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000003", position: 2, pattern: "zq-other", name: "zq-other-rule" });
    const second = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 3, pattern: "zq-second", name: "zq-second-rule" });
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE, other, second] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    const refusals: ((error: unknown) => void)[] = [];
    updateRule.mockImplementation(() => new Promise((_resolve, reject) => refusals.push(reject)));

    // Two abandoned saves, of two rules (a rule being saved is held, Ruling 57): one the evaluator refuses, one the evaluator can't check.
    for (const opener of ["Edit rule 1: zq-no-secrets", "Edit rule 2: zq-other-rule"]) {
      await user.click(within(logs).getByRole("button", { name: opener }));
      const first = await screen.findByRole("dialog", { name: "Edit validation rule" });
      await choose(user, first, "Type", "Regex");
      await retype(user, within(first).getByLabelText("Regex pattern"), "zq(");
      await user.click(within(first).getByRole("button", { name: "Save" }));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    await user.click(within(logs).getByRole("button", { name: "Edit rule 3: zq-second-rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    const words = "Invalid regex: missing closing ): `zq(`";
    await act(async () =>
      refusals[0]!(new ApiError("validation_rule_invalid", words, { status: 400, details: { problems: [{ field: "pattern", message: words }] } })),
    );
    await act(async () => refusals[1]!(new ApiError("rules_unavailable", RULES_UNAVAILABLE_AT_SAVE_MESSAGE, { status: 503 })));

    expect(screen.getByRole("dialog", { name: "Edit validation rule" })).toBe(dialog);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    const text = within(dialog).getByLabelText("Text");
    expect(text).toHaveValue("zq-second");
    expect(text).not.toHaveAttribute("aria-invalid");
    expect(text).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("New validation pipeline: a create answered after Escape doesn't close the dialog opened since, nor toasts; the card shows all the same", async () => {
    const { createPipeline } = serveApi();
    const { user } = await renderValidation();
    await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.");
    let answer: (value: { validationPipeline: ValidationPipeline }) => void = () => undefined;
    createPipeline.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    let dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    await choose(user, dialog, "Pipeline", "metrics");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    await choose(user, dialog, "Pipeline", "traces");
    await act(async () => answer({ validationPipeline: METRICS }));

    expect(screen.getByRole("dialog", { name: "New validation pipeline" })).toBe(dialog);
    expect(within(dialog).getByRole("combobox", { name: "Pipeline" })).toHaveTextContent("traces");
    expect(within(dialog).getByRole("button", { name: "OK" })).toBeEnabled();
    expect(toastError).not.toHaveBeenCalled();
    expect(cardSync("metrics")).toBeInTheDocument();

    // A refusal answered after Escape toasts nothing either.
    let refuse: (error: unknown) => void = () => undefined;
    createPipeline.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    await act(async () => refuse(new ApiError("validation_pipeline_exists", validationPipelineExistsMessage("traces"), { status: 409 })));
    expect(screen.getByRole("dialog", { name: "New validation pipeline" })).toBe(dialog);
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("the editor's text as the API reads it (Ruling 56)", () => {
  it("P3: trims only Go's whitespace around a pattern, a condition and an expression: a U+FEFF (not Go's whitespace) is kept and saves", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    let dialog = await openAddRule(user, "logs");
    const text = within(dialog).getByLabelText("Text");
    fireEvent.change(text, { target: { value: "\ufeff" } });
    expect(within(dialog).getByRole("button", { name: "Add rule" })).toBeEnabled();
    fireEvent.change(text, { target: { value: " \u0085\ufeff\u00a0" } });
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // JavaScript's trim would have sent "\u0085" (it keeps U+0085, strips U+FEFF), and the API refused the old "" outright.
    expect(createRule.mock.calls[0]?.[4]).toEqual({ kind: "not_contains_text", target: "output", pattern: "\ufeff", name: "", description: "" });

    await user.click(within(cardSync("logs")).getByRole("button", { name: "Add Validation Rule" }));
    dialog = await screen.findByRole("dialog", { name: "Add validation rule" });
    await choose(user, dialog, "Rule type", "OTTL condition");
    await choose(user, dialog, "Require", "Distinct values…");
    fireEvent.change(within(dialog).getByLabelText("Row filter (optional)"), { target: { value: "\u0085\ufeff\u0085" } });
    fireEvent.change(within(dialog).getByLabelText("Value expression"), { target: { value: '\u3000attributes["zq"]\u0085' } });
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createRule.mock.calls[1]?.[4]?.ottl).toEqual({
      context: "log",
      quantifier: "distinct",
      condition: "\ufeff",
      expression: 'attributes["zq"]',
      count: { operator: "eq", value: 1 },
    });
  });

  it("P4: holds a pattern past 8,192 bytes of UTF-8 as a form problem tied to it, announced, in the API's words; 8,192 bytes save", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    const region = dialog.querySelector('[aria-live="polite"]')!;
    const text = within(dialog).getByLabelText("Text");
    const add = within(dialog).getByRole("button", { name: "Add rule" });
    // An empty pattern only holds Add rule.
    expect(region).toHaveTextContent("");

    fireEvent.change(text, { target: { value: "a".repeat(10_000) } });
    expect(region).toHaveTextContent("The pattern is longer than 8,192 bytes.");
    expect(text).toHaveAccessibleDescription("The pattern is longer than 8,192 bytes.");
    expect(text).toHaveAttribute("aria-invalid", "true");
    expect(add).toBeDisabled();
    // Bytes, not characters: 4,097 two-byte characters are 8,194 bytes.
    fireEvent.change(text, { target: { value: "é".repeat(4_097) } });
    expect(add).toBeDisabled();
    // Counted as it is sent: trimmed.
    fireEvent.change(text, { target: { value: ` ${"é".repeat(4_096)} ` } });
    expect(region).toHaveTextContent("");
    expect(text).not.toHaveAttribute("aria-invalid");
    expect(add).toBeEnabled();
    await user.click(add);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createRule.mock.calls[0]?.[4]?.pattern).toBe("é".repeat(4_096));
  });

  it("holds a condition, a value expression, a Row filter and a builder's condition past 8,192 bytes, each under its field", async () => {
    serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    const add = within(dialog).getByRole("button", { name: "Add rule" });
    const long = "a".repeat(8_193);

    await choose(user, dialog, "Rule type", "OTTL condition");
    const condition = within(dialog).getByLabelText("OTTL condition");
    fireEvent.change(condition, { target: { value: long } });
    expect(condition).toHaveAccessibleDescription("The condition is longer than 8,192 bytes.");
    expect(add).toBeDisabled();
    fireEvent.change(condition, { target: { value: "true" } });
    expect(add).toBeEnabled();

    await choose(user, dialog, "Require", "Distinct values…");
    const expression = within(dialog).getByLabelText("Value expression");
    fireEvent.change(expression, { target: { value: long } });
    expect(expression).toHaveAccessibleDescription("The expression is longer than 8,192 bytes.");
    expect(add).toBeDisabled();
    fireEvent.change(expression, { target: { value: 'attributes["zq"]' } });
    const filter = within(dialog).getByLabelText("Row filter (optional)");
    fireEvent.change(filter, { target: { value: long } });
    expect(filter).toHaveAccessibleDescription("The condition is longer than 8,192 bytes.");
    expect(add).toBeDisabled();

    await choose(user, dialog, "Rule type", "Record attribute");
    fireEvent.change(within(dialog).getByLabelText("Attribute key"), { target: { value: "zq.key" } });
    await choose(user, dialog, "Operator", "Equals");
    const value = within(dialog).getByLabelText("Value");
    fireEvent.change(value, { target: { value: long } });
    expect(value).toHaveAccessibleDescription("The condition is longer than 8,192 bytes.");
    expect(add).toBeDisabled();
  });
});

describe("a rule or pipeline a teammate deleted (404, Ruling 56)", () => {
  it("closes the rule editor on a change answered 'rule not found', toasting the API's words; the rule leaves the list, the focus to Add Validation Rule", async () => {
    const { updateRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    updateRule.mockRejectedValueOnce(new ApiError("validation_rule_not_found", "Validation rule not found", { status: 404 }));

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Validation rule not found");
    expect(within(logs).getByText("No validation rules yet.")).toBeInTheDocument();
    await waitFor(() => expect(within(logs).getByRole("button", { name: "Add Validation Rule" })).toHaveFocus());
  });

  it("closes the rule editor on an add answered 'validation pipeline not found': the card leaves the list", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS, TRACES];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-late");
    createRule.mockRejectedValueOnce(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 }));

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Validation pipeline not found");
    expect(screen.queryByText("logs", { selector: "li span.font-mono" })).toBeNull();
    expect(cardSync("traces")).toBeInTheDocument();
  });

  it("closes New validation pipeline on a create answered 404 (the version gone), toasting its words; the list read again shows the refusal", async () => {
    const { createPipeline, listPipelines } = serveApi();
    const { user } = await renderValidation();
    await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.");
    const gone = new ApiError("configuration_version_not_found", "Configuration version not found", { status: 404 });
    createPipeline.mockRejectedValueOnce(gone);
    listPipelines.mockRejectedValueOnce(gone);

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    const dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    await choose(user, dialog, "Pipeline", "logs");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Configuration version not found");
    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration version not found");
    expect(listPipelines).toHaveBeenCalledTimes(2);
  });
});

describe("the focus with neither the editor's opener nor Add Validation Rule there (Ruling 56)", () => {
  it("goes to the card's header while the rules are read again after a failed first read", async () => {
    const { listRules } = serveApi();
    listRules.mockRejectedValueOnce(new ApiError("internal_error", "Internal error", { status: 500 }));
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    expect(within(logs).getByRole("alert")).toHaveTextContent("Failed to load validation rules");
    let release: () => void = () => undefined;
    listRules.mockImplementationOnce(async (_o, _c, _v, pipelineId) => {
      await new Promise<void>((resolve) => (release = resolve));
      return { rules: (api.rules[pipelineId] ?? []).map((each) => ({ ...each })) };
    });

    await user.click(within(logs).getByRole("button", { name: "Add Validation Rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add validation rule" });
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-added");
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The rules are read again (the add's, so the list is whole): a spinner where Add Validation Rule was.
    expect(within(logs).getByRole("status", { name: "Loading validation rules" })).toBeInTheDocument();
    expect(within(logs).queryByRole("button", { name: "Add Validation Rule" })).toBeNull();
    await waitFor(() => expect(within(logs).getByRole("button", { expanded: true })).toHaveFocus());

    await act(async () => release());
    expect(await within(logs).findByText("Does not contain: zq-added")).toBeInTheDocument();
  });
});

describe("New validation pipeline's choices (Ruling 56)", () => {
  it("offers only logs, traces and metrics pipelines: not a profiles one, which the API would refuse", async () => {
    serveApi();
    useEditorStore.getState().load({
      organizationId: GROUP_ID,
      configuration: MINE,
      version: versionFixture({ yamlContent: `${YAML}    profiles:\n      receivers: [otlp]\n      exporters: [debug]\n` }),
    });
    expect(useEditorStore.getState().graph.pipelines.map((pipeline) => pipeline.name)).toContain("profiles");
    const { user } = await renderValidation();
    await screen.findByText("No validation pipelines yet. Click + Pipeline to create one.");

    await user.click(screen.getByRole("button", { name: "Add validation pipeline" }));
    const dialog = await screen.findByRole("dialog", { name: "New validation pipeline" });
    await user.click(within(dialog).getByRole("combobox", { name: "Pipeline" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["traces", "metrics", "logs", "logs/zqotlp"]);
  });
});

describe("Ruling 57: a rule held while it saves, the focus with its card gone, and the review's fixes", () => {
  it("holds a rule's Edit and Delete while its change is under way, its editor closed (probe A): reopened once it answers, on what the API kept", async () => {
    const { updateRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    let answer: (value: ValidationRuleResponse) => void = () => undefined;
    updateRule.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const edit = within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" });
    await user.click(edit);
    let dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    await retype(user, within(dialog).getByLabelText("Text"), "zq-changed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Held, its name unchanged, the focus back on it; a click opens nothing.
    const held = within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" });
    const remove = within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" });
    for (const button of [held, remove]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("title", "A change to this rule is in progress");
    }
    await waitFor(() => expect(held).toHaveFocus());
    await user.click(held);
    await user.click(remove);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await act(async () => answer({ rule: { ...RULE, pattern: "zq-changed" } }));

    const editable = within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" });
    expect(editable).not.toHaveAttribute("aria-disabled");
    expect(editable).toHaveAttribute("title", "Edit rule");
    expect(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" })).not.toHaveAttribute("aria-disabled");
    await user.click(editable);
    dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    expect(within(dialog).getByLabelText("Text")).toHaveValue("zq-changed");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("holds a rule's Edit and Delete while its delete is under way, and gives them back when the delete is refused", async () => {
    const { deleteRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    let refuse: (error: unknown) => void = () => undefined;
    deleteRule.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));

    await user.click(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Delete validation rule?" });
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
    // Behind the confirmation (kept open until the API answers): hidden from the accessibility tree meanwhile.
    expect(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets", hidden: true })).toHaveAttribute("aria-disabled", "true");
    expect(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets", hidden: true })).toHaveAttribute("aria-disabled", "true");

    await act(async () => refuse(new ApiError("internal_error", "Internal error", { status: 500 })));
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" })).not.toHaveAttribute("aria-disabled");
    expect(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" })).not.toHaveAttribute("aria-disabled");
  });

  it("gives the focus to + Pipeline when a change answered 'validation pipeline not found' takes the card away (probe B)", async () => {
    const { updateRule } = serveApi();
    api.pipelines = [LOGS, TRACES];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    updateRule.mockRejectedValueOnce(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 }));

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Validation pipeline not found");
    expect(screen.queryByText("logs", { selector: "li span.font-mono" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });

  it("clears the API's problems under Name or Description as that field is edited, the others kept (probe C)", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    const pattern = within(dialog).getByLabelText("Text");
    await typeIn(user, pattern, "zq-pattern");
    const nameWords = "The name can't contain U+0000 or a lone surrogate.";
    const descriptionWords = "The description can't contain U+0000 or a lone surrogate.";
    const patternWords = "The pattern is longer than 8,192 bytes.";
    createRule.mockRejectedValueOnce(
      new ApiError("invalid_request", "The request was not valid.", {
        status: 400,
        details: [
          { path: ["name"], message: nameWords },
          { path: ["description"], message: descriptionWords },
          { path: ["pattern"], message: patternWords },
        ],
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    const name = within(dialog).getByLabelText("Name");
    const description = within(dialog).getByLabelText("Description");
    await waitFor(() => expect(within(dialog).getAllByRole("alert")).toHaveLength(3));
    expect(name).toHaveAccessibleDescription(nameWords);
    expect(description).toHaveAccessibleDescription(descriptionWords);

    await typeIn(user, name, "x");
    expect(within(name.parentElement!).queryByRole("alert")).toBeNull();
    expect(name).not.toHaveAttribute("aria-invalid");
    expect(name).toHaveAccessibleDescription("");
    expect(within(description.parentElement!).getByRole("alert")).toHaveTextContent(descriptionWords);
    expect(within(pattern.parentElement!).getByRole("alert")).toHaveTextContent(patternWords);

    await typeIn(user, description, "y");
    expect(within(description.parentElement!).queryByRole("alert")).toBeNull();
    expect(description).not.toHaveAttribute("aria-invalid");
    expect(within(pattern.parentElement!).getByRole("alert")).toHaveTextContent(patternWords);
    expect(pattern).toHaveAttribute("aria-invalid", "true");
  });

  it("trims Record attribute's key and value of Go's whitespace only: a U+FEFF kept, a U+0085 trimmed", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Rule type", "Record attribute");
    await choose(user, dialog, "Scope", "Record");
    // JavaScript's trim would strip the key's U+FEFF and keep the value's U+0085.
    fireEvent.change(within(dialog).getByLabelText("Attribute key"), { target: { value: " ﻿zq.key\u0085" } });
    await choose(user, dialog, "Operator", "Equals");
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "\u0085zq-value﻿\u0085" } });
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(createRule.mock.calls[0]?.[4]?.ottl).toEqual({
      context: "log",
      quantifier: "all",
      condition: 'attributes["﻿zq.key"] == "zq-value﻿"',
    });
  });

  it("keeps Save held when an abandoned save answers during the new session's own save (no double submit)", async () => {
    const { createRule } = serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const answers: ((value: ValidationRuleResponse) => void)[] = [];
    createRule.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    let dialog = await openAddRule(user, "logs");
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-first");
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(cardSync("logs")).getByRole("button", { name: "Add Validation Rule" }));
    dialog = await screen.findByRole("dialog", { name: "Add validation rule" });
    await typeIn(user, within(dialog).getByLabelText("Text"), "zq-second");
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();

    await act(async () => answers[0]!({ rule: validationRuleFixture({ pattern: "zq-first", name: "", description: "" }) }));

    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(within(dialog).getByLabelText("Text")).toBeDisabled();
    expect(createRule).toHaveBeenCalledTimes(2);

    await act(async () =>
      answers[1]!({
        rule: validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 2, pattern: "zq-second", name: "", description: "" }),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(cardSync("logs")).getByText("Does not contain: zq-second")).toBeInTheDocument();
  });

  it("puts Record attribute's too-long condition under the key when the key makes it so, else under the value (probe D)", async () => {
    serveApi();
    api.pipelines = [LOGS];
    const { user } = await renderValidation();
    const dialog = await openAddRule(user, "logs");
    await choose(user, dialog, "Rule type", "Record attribute");
    const key = within(dialog).getByLabelText("Attribute key");
    fireEvent.change(key, { target: { value: "k".repeat(9_000) } });
    // Exists: the key alone.
    expect(key).toHaveAccessibleDescription("The condition is longer than 8,192 bytes.");
    await choose(user, dialog, "Operator", "Equals");
    const value = within(dialog).getByLabelText("Value");
    fireEvent.change(value, { target: { value: "v" } });

    expect(key).toHaveAccessibleDescription("The condition is longer than 8,192 bytes.");
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(value).not.toHaveAttribute("aria-invalid");
    expect(value).toHaveAccessibleDescription("");
    expect(within(dialog).getByRole("button", { name: "Add rule" })).toBeDisabled();

    // The value makes it long: under the value.
    fireEvent.change(key, { target: { value: "zq.key" } });
    fireEvent.change(value, { target: { value: "v".repeat(9_000) } });
    expect(value).toHaveAccessibleDescription("The condition is longer than 8,192 bytes.");
    expect(key).not.toHaveAttribute("aria-invalid");
  });
});

describe("Ruling 59: a late answer placed, the focus with the card gone under a rule's confirmation, a refused change released", () => {
  it("opens a rule's Edit on the change that landed while the version was left and come back to mid-save, not on the rules read meanwhile (the review's probe)", async () => {
    const { updateRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    let logs = await expand(user, "logs");
    let answer: (value: ValidationRuleResponse) => void = () => undefined;
    updateRule.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    await retype(user, within(dialog).getByLabelText("Text"), "zq-changed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Away to another version and back, mid-save: the card reads its rules again before the change commits.
    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
    await card("logs");
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION }));
    logs = await expand(user, "logs");
    // The rules read meanwhile: the old text.
    expect(useValidationPipelinesStore.getState().rulesByPipeline[LOGS.id]?.[0]?.pattern).toBe("zq-secret-token");
    expect(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" })).toHaveAttribute("aria-disabled", "true");

    const changed = { ...RULE, pattern: "zq-changed" };
    api.rules = { [LOGS.id]: [changed] };
    await act(async () => answer({ rule: changed }));

    const edit = within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" });
    expect(edit).not.toHaveAttribute("aria-disabled");
    await user.click(edit);
    dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    expect(within(dialog).getByLabelText("Text")).toHaveValue("zq-changed");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("gives the focus to + Pipeline when the card goes under a rule's delete confirmation (an abandoned save answered 'validation pipeline not found')", async () => {
    const { updateRule } = serveApi();
    const second = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 2, pattern: "zq-second", name: "zq-second-rule" });
    api.pipelines = [LOGS, TRACES];
    api.rules = { [LOGS.id]: [RULE, second] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    let refuse: (error: unknown) => void = () => undefined;
    updateRule.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    await retype(user, within(dialog).getByLabelText("Text"), "zq-changed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(logs).getByRole("button", { name: "Delete rule 2: zq-second-rule" }));
    await screen.findByRole("alertdialog", { name: "Delete validation rule?" });

    await act(async () => refuse(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 })));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText("logs", { selector: "li span.font-mono" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });

  it("drops the card on a rule's delete answered 'validation pipeline not found', toasting its words; the focus to + Pipeline", async () => {
    const { deleteRule } = serveApi();
    api.pipelines = [LOGS, TRACES];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    deleteRule.mockRejectedValueOnce(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 }));
    await user.click(within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Delete validation rule?" });

    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("Validation pipeline not found");
    expect(screen.queryByText("logs", { selector: "li span.font-mono" })).toBeNull();
    expect(cardSync("traces")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });

  it.each([
    [
      "a rule the API refuses (400)",
      new ApiError("validation_rule_invalid", "Invalid regex: zq", { status: 400, details: { problems: [{ field: "pattern", message: "Invalid regex: zq" }] } }),
    ],
    ["the evaluator down (503)", new ApiError("rules_unavailable", RULES_UNAVAILABLE_AT_SAVE_MESSAGE, { status: 503 })],
    ["the server not reached", new ApiError("network_error", "Could not reach the server. Check your connection.")],
  ])("gives a rule's Edit and Delete back when its change is refused: %s", async (_what, refusal) => {
    const { updateRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    let refuse: (error: unknown) => void = () => undefined;
    updateRule.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    await retype(user, within(dialog).getByLabelText("Text"), "zq-changed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    // Held behind the editor (hidden from the accessibility tree meanwhile) while the API answers.
    expect(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets", hidden: true })).toHaveAttribute("aria-disabled", "true");

    await act(async () => refuse(refusal));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled());
    expect(useValidationPipelinesStore.getState().ruleWritesInFlight).toEqual({});
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const edit = within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" });
    for (const button of [edit, within(logs).getByRole("button", { name: "Delete rule 1: zq-no-secrets" })]) {
      expect(button).not.toHaveAttribute("aria-disabled");
    }
    expect(edit).toHaveAttribute("title", "Edit rule");
    await user.click(edit);
    dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    expect(within(dialog).getByLabelText("Text")).toHaveValue("zq-secret-token");
  });
});

describe("Ruling 61: a late answer read again, and the focus with a card gone under its pipeline's confirmation", () => {
  /** Saves a change to RULE in its editor, Escapes it, and leaves the save hanging until `settle` is called. */
  async function abandonSave(user: User, updateRule: MockInstance<typeof apiClient.updateValidationRule>, logs: HTMLElement) {
    const settle = {
      answer: (_value: ValidationRuleResponse) => undefined as void,
      refuse: (_error: unknown) => undefined as void,
    };
    updateRule.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settle.answer = resolve;
          settle.refuse = reject;
        }),
    );
    await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    await retype(user, within(dialog).getByLabelText("Text"), "zq-changed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    return settle;
  }

  it("gives the focus to + Pipeline when the card goes under its pipeline's delete confirmation, no other card there (probe E)", async () => {
    const { updateRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    const save = await abandonSave(user, updateRule, logs);
    await user.click(within(logs).getByRole("button", { name: "Delete validation pipeline" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Delete validation pipeline?" });

    await act(async () => save.refuse(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 })));
    expect(screen.queryByText("logs", { selector: "li span.font-mono" })).toBeNull();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });

  it("gives the focus to the card now at its place when the card goes under its pipeline's delete confirmation, closed with Escape", async () => {
    const { updateRule } = serveApi();
    api.pipelines = [LOGS, TRACES];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    const save = await abandonSave(user, updateRule, logs);
    await user.click(within(logs).getByRole("button", { name: "Delete validation pipeline" }));
    await screen.findByRole("alertdialog", { name: "Delete validation pipeline?" });

    await act(async () => save.refuse(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 })));
    expect(screen.queryByText("logs", { selector: "li span.font-mono" })).toBeNull();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(within(cardSync("traces")).getByRole("button", { expanded: false })).toHaveFocus());
  });

  it("gives the focus to + Pipeline when Delete is clicked in a confirmation whose card has vanished, no other card there (Ruling 63)", async () => {
    const { updateRule, deletePipeline } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    const save = await abandonSave(user, updateRule, logs);
    await user.click(within(logs).getByRole("button", { name: "Delete validation pipeline" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Delete validation pipeline?" });
    api.pipelines = [];
    deletePipeline.mockRejectedValueOnce(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 }));
    await act(async () => save.refuse(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 })));
    expect(screen.queryByText("logs", { selector: "li span.font-mono" })).toBeNull();
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Add validation pipeline" })).toHaveFocus());
  });

  it("gives the focus to the card now at its place when Delete is clicked in a confirmation whose card has vanished (Ruling 63)", async () => {
    const { updateRule, deletePipeline } = serveApi();
    api.pipelines = [LOGS, TRACES];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    const save = await abandonSave(user, updateRule, logs);
    await user.click(within(logs).getByRole("button", { name: "Delete validation pipeline" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Delete validation pipeline?" });
    api.pipelines = [TRACES];
    deletePipeline.mockRejectedValueOnce(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 }));
    await act(async () => save.refuse(new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 })));
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(within(cardSync("traces")).getByRole("button", { expanded: false })).toHaveFocus());
  });

  it("opens Edit on a teammate's change committed after mine, when mine answers after the version was left and come back to (probe F)", async () => {
    const { updateRule, listRules } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const { user } = await renderValidation();
    let logs = await expand(user, "logs");
    const save = await abandonSave(user, updateRule, logs);

    // Away and back mid-save: the API commits mine, then a teammate's; the card reads the teammate's.
    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
    await card("logs");
    const teammates = { ...RULE, pattern: "zq-teammate" };
    api.rules = { [LOGS.id]: [teammates] };
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION }));
    logs = await expand(user, "logs");
    expect(useValidationPipelinesStore.getState().rulesByPipeline[LOGS.id]?.[0]?.pattern).toBe("zq-teammate");
    const readsBefore = listRules.mock.calls.length;

    // Mine answers last: read again, not placed.
    await act(async () => save.answer({ rule: { ...RULE, pattern: "zq-changed" } }));

    const edit = within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" });
    await waitFor(() => expect(edit).not.toHaveAttribute("aria-disabled"));
    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    expect(within(dialog).getByLabelText("Text")).toHaveValue("zq-teammate");
    expect(listRules.mock.calls.length).toBe(readsBefore + 1);
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("Ruling 26: a save answered after the editor has gone, and an edit given a prefill", () => {
  it.each([
    ["an add, refused", "add", "refuse"],
    ["a change, refused", "change", "refuse"],
    ["a change, answered", "change", "answer"],
  ] as const)("toasts nothing when a card editor's save (%s) is answered after a version switch", async (_what, write, outcome) => {
    const { createRule, updateRule } = serveApi();
    api.pipelines = [LOGS];
    api.rules = { [LOGS.id]: [RULE] };
    const toastSuccess = vi.spyOn(toast, "success").mockImplementation(() => "");
    const settle = {
      answer: (_value: ValidationRuleResponse) => undefined as void,
      refuse: (_error: unknown) => undefined as void,
    };
    const hang = () =>
      new Promise<ValidationRuleResponse>((resolve, reject) => {
        settle.answer = resolve;
        settle.refuse = reject;
      });
    createRule.mockImplementationOnce(hang);
    updateRule.mockImplementationOnce(hang);
    const { user } = await renderValidation();
    const logs = await expand(user, "logs");
    if (write === "add") {
      await user.click(within(logs).getByRole("button", { name: "Add Validation Rule" }));
      const dialog = await screen.findByRole("dialog", { name: "Add validation rule" });
      await typeIn(user, within(dialog).getByLabelText("Text"), "zq-late");
      await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    } else {
      await user.click(within(logs).getByRole("button", { name: "Edit rule 1: zq-no-secrets" }));
      const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
      await retype(user, within(dialog).getByLabelText("Text"), "zq-changed");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
    }
    expect(createRule.mock.calls.length + updateRule.mock.calls.length).toBe(1);

    // Away to another version mid-save: the card, and its editor with it, unmount.
    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await card("logs");
    await act(async () =>
      outcome === "refuse"
        ? settle.refuse(new ApiError("network_error", "Could not reach the server. Check your connection."))
        : settle.answer({ rule: { ...RULE, pattern: "zq-changed" } }),
    );

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["a text rule", RULE, "Match output text", "Text", "zq-secret-token"],
    [
      "an OTTL rule",
      validationRuleFixture({
        kind: "ottl",
        pattern: null,
        ottl: { context: "log", quantifier: "any", condition: 'attributes["a"] != nil and IsMatch(body, "zq.*")' },
      }),
      "OTTL condition",
      "OTTL condition",
      'attributes["a"] != nil and IsMatch(body, "zq.*")',
    ],
    [
      "a builder-shaped OTTL rule, recognised",
      validationRuleFixture({
        kind: "ottl",
        pattern: null,
        ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' },
      }),
      "Record attribute",
      "Attribute key",
      "env",
    ],
  ] as const)("opens %s as stored when given a prefill too: an edit ignores `initial`", async (_what, rule, mode, field, text) => {
    render(
      <RuleEditorDialog
        open
        onOpenChange={() => undefined}
        target={{ organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id }}
        validationPipeline={LOGS}
        rule={rule}
        initial={{ context: "resource", quantifier: "none", condition: 'attributes["zq-prefill"] != nil' }}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Edit validation rule" });
    expect(within(dialog).getByRole("combobox", { name: "Rule type" })).toHaveTextContent(mode);
    expect(within(dialog).getByLabelText(field)).toHaveValue(text);
    expect(within(dialog).getByLabelText("Name")).toHaveValue("zq-no-secrets");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("zq-rule-description");
    if (mode === "OTTL condition") {
      expect(within(dialog).getByRole("combobox", { name: "Context" })).toHaveTextContent("log");
      expect(within(dialog).getByRole("combobox", { name: "Require" })).toHaveTextContent("At least one matches");
    }
    if (mode === "Record attribute") {
      // Recognised from the stored rule, never the prefill's resource / none.
      expect(within(dialog).getByRole("combobox", { name: "Require" })).toHaveTextContent("All records match");
      expect(within(dialog).getByRole("combobox", { name: "Scope" })).toHaveTextContent("Record");
      expect(within(dialog).getByRole("combobox", { name: "Operator" })).toHaveTextContent("Equals");
      expect(within(dialog).getByLabelText("Value")).toHaveValue("prod");
    }
    expect(within(dialog).queryByDisplayValue('attributes["zq-prefill"] != nil')).toBeNull();
    expect(within(dialog).queryByDisplayValue("zq-prefill")).toBeNull();
  });
});
