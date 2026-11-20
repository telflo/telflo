/**
 * The Testing tab's Suites subtab: suites created, renamed, described
 * and deleted (confirmed); definitions added from My Files, Upload and Paste,
 * and deleted (confirmed); the empty states, failed reads and their Retry;
 * the caps' words; a published version's suites editable; the definition
 * dialog's defaults, and that it writes nothing back to the run dialog's
 * choice; the help; and replay's rule (no name in an attribute).
 *
 * Rendered in the whole tab, as TestingTab.test.tsx does: Monaco is stubbed
 * with a textarea standing for the paste panel's editor; the API is its
 * client's functions, spied on, over a little in-memory API; toasts are
 * spied on.
 */

import type { EditorProps } from "@monaco-editor/react";
import {
  TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_DEFINITION_LIMIT_MESSAGE,
  TEST_DEFINITION_NAME_MAXIMUM_LENGTH,
  TEST_RUN_QUEUE_FULL_MESSAGE,
  TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_SUITE_LIMIT_MESSAGE,
  TEST_SUITE_NAME_MAXIMUM_LENGTH,
  type CreateTestDefinitionRequest,
  type TestDefinition,
  type TestFile,
  type TestRunDetail,
  type TestSuite,
  type TestTemplate,
} from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const fake = vi.hoisted(() => ({
  initMonaco: (() => Promise.resolve()) as () => Promise<void>,
}));

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: function DiffEditorStub() {
    return <div />;
  },
  default: function MonacoStub(props: EditorProps) {
    useEffect(() => {
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
      // Once, as Monaco mounts once.
    }, []);
    return (
      <textarea
        aria-label="Sample editor"
        value={props.value ?? ""}
        onChange={(event) => props.onChange?.(event.target.value, undefined as never)}
      />
    );
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => fake.initMonaco(), setMonacoSchema: () => undefined }));

import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { RUNS_REQUEST_TIMEOUT_MS, selectIsPlayHeld, useTestingStore, type PlayAllRun } from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, MEMBER_ID, MINE, PUBLISHED_FIELDS, signedInMember, versionFixture } from "~/test/configurations.js";
import { testFileFixture, testRunFixture, testRunSummaryOf } from "~/test/test-runs.js";
import { testDefinitionFixture, testSuiteFixture } from "~/test/test-suites.js";
import { TestingTab } from "../test-runs/TestingTab.js";

/** Three pipelines: traces, logs and logs/zqotlp (a name carrying the private-text marker). */
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
    logs:
      receivers: [otlp]
      exporters: [debug]
    logs/zqotlp:
      receivers: [otlp]
      exporters: [debug]
`;

const VERSION = versionFixture({ yamlContent: YAML });
const OLD_FILE = testFileFixture({ displayName: "zq-old-upload", fileName: "zq-old-upload.json", description: "zq-file-description" });
const SUITE = testSuiteFixture();
const DEFINITION = testDefinitionFixture();

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();
const initialSuites = useTestSuitesStore.getState();

let toastError: MockInstance<typeof toast.error>;

/** A little API: the version's suites and each suite's definitions, written by the client's calls. */
const api = {
  suites: [] as TestSuite[],
  definitions: {} as Record<string, TestDefinition[]>,
  files: [] as TestFile[],
  nextId: 0,
};

function newId(prefix: string): string {
  api.nextId += 1;
  return `${prefix}-0000-7000-8000-${String(api.nextId).padStart(12, "0")}`;
}

function serveApi() {
  return {
    listSuites: vi.spyOn(apiClient, "getTestSuites").mockImplementation(async () => ({ suites: [...api.suites] })),
    createSuite: vi.spyOn(apiClient, "createTestSuite").mockImplementation(async (_o, _c, _v, request) => {
      const suite = testSuiteFixture({ id: newId("0199f0aa"), name: request.name, description: request.description ?? "" });
      api.suites.push(suite);
      return { suite };
    }),
    updateSuite: vi.spyOn(apiClient, "updateTestSuite").mockImplementation(async (_o, _c, _v, suiteId, request) => {
      const index = api.suites.findIndex((suite) => suite.id === suiteId);
      const before = api.suites[index]!;
      const suite = { ...before, name: request.name ?? before.name, description: request.description ?? before.description };
      api.suites[index] = suite;
      return { suite };
    }),
    deleteSuite: vi.spyOn(apiClient, "deleteTestSuite").mockImplementation(async (_o, _c, _v, suiteId) => {
      api.suites = api.suites.filter((suite) => suite.id !== suiteId);
      return undefined;
    }),
    listDefinitions: vi
      .spyOn(apiClient, "getTestDefinitions")
      .mockImplementation(async (_o, _c, _v, suiteId) => ({ definitions: [...(api.definitions[suiteId] ?? [])] })),
    createDefinition: vi
      .spyOn(apiClient, "createTestDefinition")
      .mockImplementation(async (_o, _c, _v, suiteId, request: CreateTestDefinitionRequest) => {
        const file = api.files.find((each) => each.id === request.inputFileId);
        const definition = testDefinitionFixture({
          id: newId("0199f1aa"),
          suiteId,
          name: request.name,
          description: request.description ?? "",
          pipeline: request.pipeline,
          signal: request.signal,
          durationSeconds: request.durationSeconds,
          inputName: file?.fileName ?? "unknown.json",
        });
        api.definitions[suiteId] = [...(api.definitions[suiteId] ?? []), definition];
        return { definition };
      }),
    deleteDefinition: vi.spyOn(apiClient, "deleteTestDefinition").mockImplementation(async (_o, _c, _v, suiteId, definitionId) => {
      api.definitions[suiteId] = (api.definitions[suiteId] ?? []).filter((each) => each.id !== definitionId);
      return undefined;
    }),
    listFiles: vi.spyOn(apiClient, "getTestFiles").mockImplementation(async () => ({ files: [...api.files] })),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  // Nothing left of another test's Play all or start.
  useTestingStore.getState().reset();
  useTestSuitesStore.setState(initialSuites, true);
  useTestSuitesStore.getState().reset();
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  fake.initMonaco = () => Promise.resolve();
  api.suites = [];
  api.definitions = {};
  api.files = [OLD_FILE];
  api.nextId = 0;
  toastError = vi.spyOn(toast, "error");
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: useTestingStore.getState().runs }));
});

const TARGET = [GROUP_ID, MINE.id, VERSION.id] as const;

async function renderSuites() {
  const view = render(<TestingTab />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Suites" }));
  return { ...view, user };
}

/** The suite's card, by its name (text). */
async function card(name: string) {
  return (await screen.findByText(name)).closest("li")!;
}

/** Expands the suite's card and waits for its definitions' read. */
async function expand(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: new RegExp(name) }));
  await waitFor(() => expect(within(cardSync(name)).queryByRole("status")).toBeNull());
}

function cardSync(name: string) {
  return screen.getByText(name).closest("li")!;
}

/** The definition dialog's slot holding `text` (a slide's own fields; the main view's Name is another). */
function slotWith(text: string): HTMLElement {
  return screen.getByText(text).closest<HTMLElement>("[data-run-dialog-slot]")!;
}

describe("the Suites subtab", () => {
  it("reads the version's suites each time it shows: 'No suites yet. Click + to create one.'", async () => {
    const { listSuites } = serveApi();
    const { user } = await renderSuites();

    expect(await screen.findByText("No suites yet. Click + to create one.")).toBeInTheDocument();
    expect(listSuites).toHaveBeenCalledTimes(1);
    // With the hang guard's signal.
    expect(listSuites).toHaveBeenCalledWith(...TARGET, { signal: expect.any(AbortSignal) });

    api.suites = [SUITE];
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await user.click(screen.getByRole("tab", { name: "Suites" }));

    expect(await screen.findByText("zq-smoke-tests")).toBeInTheDocument();
    expect(screen.getByText("zq-suite-description")).toBeInTheDocument();
    expect(listSuites).toHaveBeenCalledTimes(2);
  });

  it("reads the new version's suites when the version changes", async () => {
    const { listSuites } = serveApi();
    api.suites = [SUITE];
    await renderSuites();
    await screen.findByText("zq-smoke-tests");

    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
    api.suites = [];
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));

    expect(await screen.findByText("No suites yet. Click + to create one.")).toBeInTheDocument();
    expect(listSuites).toHaveBeenLastCalledWith(GROUP_ID, MINE.id, other.id, { signal: expect.any(AbortSignal) });
    expect(screen.queryByText("zq-smoke-tests")).toBeNull();
  });

  it("says 'Load a configuration version to manage suites.' with no version", async () => {
    serveApi();
    const { user } = await renderSuites();
    await screen.findByText("No suites yet. Click + to create one.");

    act(() => useEditorStore.getState().reset());
    await user.click(screen.getByRole("tab", { name: "Suites" }));

    expect(await screen.findByText("Load a configuration version to manage suites.")).toBeInTheDocument();
  });

  it("explains itself in its words", async () => {
    serveApi();
    const { user } = await renderSuites();

    await user.click(screen.getByRole("button", { name: "What is this panel?" }));

    const help = await screen.findByRole("dialog");
    expect(within(help).getByText("Suites")).toBeInTheDocument();
    expect(help).toHaveTextContent(
      "Suites are named groups of reusable test configurations scoped to the current configuration version." +
        "Use + to create a suite, then expand it and click + Add test configuration to define individual tests inside." +
        "All runs appear in the Tests tab.",
    );
  });

  it("shows a failed read inline with Retry, 'Failed to load test suites', and reads again", async () => {
    const { listSuites } = serveApi();
    listSuites.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 502 }));
    api.suites = [SUITE];
    const { user } = await renderSuites();

    expect(await screen.findByText("Failed to load test suites")).toBeInTheDocument();
    expect(screen.queryByText("No suites yet. Click + to create one.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("zq-smoke-tests")).toBeInTheDocument();
    expect(screen.queryByText("Failed to load test suites")).toBeNull();
    expect(listSuites).toHaveBeenCalledTimes(2);
  });

  it("shows a refusal's own words (a 4xx), with Retry", async () => {
    const { listSuites } = serveApi();
    listSuites.mockRejectedValueOnce(new ApiError("configuration_version_not_found", "Version not found", { status: 404 }));
    await renderSuites();

    expect(await screen.findByText("Version not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});

describe("suites", () => {
  it("creates a suite: 'New suite', the name required once trimmed, the description; it joins the list", async () => {
    const { createSuite } = serveApi();
    const { user } = await renderSuites();
    await screen.findByText("No suites yet. Click + to create one.");

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    const dialog = await screen.findByRole("dialog", { name: "New suite" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveAttribute("placeholder", "Smoke tests");
    expect(within(dialog).getByLabelText("Description")).toHaveAttribute("placeholder", "What this suite covers");
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await user.type(name, "   ");
    expect(create).toBeDisabled();
    await user.clear(name);
    await user.type(name, "  zq-new-suite ");
    await user.type(within(dialog).getByLabelText("Description"), " zq-covers-logs ");
    await user.click(create);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createSuite).toHaveBeenCalledWith(...TARGET, { name: "zq-new-suite", description: "zq-covers-logs" });
    expect(await screen.findByText("zq-new-suite")).toBeInTheDocument();
    expect(screen.getByText("zq-covers-logs")).toBeInTheDocument();
  });

  it("toasts the API's words for the 101st suite, keeping the dialog open", async () => {
    const { createSuite } = serveApi();
    createSuite.mockRejectedValueOnce(new ApiError("test_suite_limit_reached", TEST_SUITE_LIMIT_MESSAGE, { status: 409 }));
    const { user } = await renderSuites();
    await screen.findByText("No suites yet. Click + to create one.");

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    const dialog = await screen.findByRole("dialog", { name: "New suite" });
    await user.type(within(dialog).getByLabelText("Name"), "One too many");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("A version can have at most 100 test suites."));
    expect(screen.getByRole("dialog", { name: "New suite" })).toBeInTheDocument();
  });

  it("renames and describes a suite: 'Edit suite' opens with its name and description", async () => {
    const { updateSuite } = serveApi();
    api.suites = [SUITE];
    const { user } = await renderSuites();

    await user.click(within(await card("zq-smoke-tests")).getByRole("button", { name: "Edit suite" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit suite" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("zq-smoke-tests");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("zq-suite-description");
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "zq-renamed");
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.type(within(dialog).getByLabelText("Description"), "zq-described");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateSuite).toHaveBeenCalledWith(...TARGET, SUITE.id, { name: "zq-renamed", description: "zq-described" });
    expect(await screen.findByText("zq-renamed")).toBeInTheDocument();
    expect(screen.getByText("zq-described")).toBeInTheDocument();
    expect(screen.queryByText("zq-smoke-tests")).toBeNull();
  });

  it("deletes a suite only once confirmed: 'Delete test suite?', its name in the words, 'Deleting...' while the API answers", async () => {
    const { deleteSuite } = serveApi();
    api.suites = [SUITE];
    const { user } = await renderSuites();

    await user.click(within(await card("zq-smoke-tests")).getByRole("button", { name: "Delete suite" }));
    let confirm = await screen.findByRole("alertdialog", { name: "Delete test suite?" });
    expect(confirm).toHaveTextContent("Really delete the test suite zq-smoke-tests and all related test definitions?");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteSuite).not.toHaveBeenCalled();
    expect(screen.getByText("zq-smoke-tests")).toBeInTheDocument();

    let answer: () => void = () => undefined;
    deleteSuite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => {
            api.suites = [];
            resolve(undefined);
          };
        }),
    );
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete suite" }));
    confirm = await screen.findByRole("alertdialog", { name: "Delete test suite?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(await within(confirm).findByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Still open while the API answers (not merely the reference held above).
    expect(screen.getByRole("alertdialog", { name: "Delete test suite?" })).toBeInTheDocument();

    act(() => answer());

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteSuite).toHaveBeenCalledWith(...TARGET, SUITE.id);
    expect(await screen.findByText("No suites yet. Click + to create one.")).toBeInTheDocument();
  });

  it("is editable on a published version: create, rename and delete", async () => {
    serveApi();
    act(() =>
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: versionFixture({ yamlContent: YAML, ...PUBLISHED_FIELDS }) }),
    );
    const { user } = await renderSuites();
    await screen.findByText("No suites yet. Click + to create one.");

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    await user.type(within(await screen.findByRole("dialog", { name: "New suite" })).getByLabelText("Name"), "zq-published-suite");
    await user.click(screen.getByRole("button", { name: "Create" }));
    const created = await card("zq-published-suite");
    await user.click(within(created).getByRole("button", { name: "Edit suite" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit suite" });
    await user.type(within(dialog).getByLabelText("Description"), "zq-still-editable");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("zq-still-editable")).toBeInTheDocument();
    await user.click(within(cardSync("zq-published-suite")).getByRole("button", { name: "Delete suite" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No suites yet. Click + to create one.")).toBeInTheDocument();
  });

  it("shows Play all in parallel, Play all serially and Run test with fixed words, pressable while nothing holds Play", async () => {
    serveApi();
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");

    const suiteCard = cardSync("zq-smoke-tests");
    const parallel = within(suiteCard).getByRole("button", { name: "Play all tests in parallel" });
    const serial = within(suiteCard).getByRole("button", { name: "Play all tests serially" });
    const run = within(suiteCard).getByRole("button", { name: "Run test" });
    expect(parallel).toHaveAttribute("title", "Play all in parallel");
    expect(serial).toHaveAttribute("title", "Play all serially");
    expect(run).toHaveAttribute("title", "Run test");
    for (const button of [parallel, serial, run]) expect(button).toBeEnabled();
  });
});

describe("a suite's definitions", () => {
  it("are read each time the card expands: 'No test configurations yet.'", async () => {
    const { listDefinitions } = serveApi();
    api.suites = [SUITE];
    const { user } = await renderSuites();

    await expand(user, "zq-smoke-tests");
    expect(within(cardSync("zq-smoke-tests")).getByText("No test configurations yet.")).toBeInTheDocument();
    expect(listDefinitions).toHaveBeenCalledWith(...TARGET, SUITE.id, { signal: expect.any(AbortSignal) });

    api.definitions = { [SUITE.id]: [DEFINITION] };
    await user.click(screen.getByRole("button", { name: /zq-smoke-tests/ }));
    await expand(user, "zq-smoke-tests");

    expect(await within(cardSync("zq-smoke-tests")).findByText("zq-logs-only")).toBeInTheDocument();
    expect(within(cardSync("zq-smoke-tests")).getByText("zq-definition-description")).toBeInTheDocument();
    expect(listDefinitions).toHaveBeenCalledTimes(2);
  });

  it("show a failed read inline with Retry, 'Failed to load test configurations', and read again", async () => {
    const { listDefinitions } = serveApi();
    listDefinitions.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const { user } = await renderSuites();

    await user.click(await screen.findByRole("button", { name: /zq-smoke-tests/ }));
    const suiteCard = cardSync("zq-smoke-tests");
    expect(await within(suiteCard).findByText("Failed to load test configurations")).toBeInTheDocument();
    expect(within(suiteCard).queryByText("No test configurations yet.")).toBeNull();

    await user.click(within(suiteCard).getByRole("button", { name: "Retry" }));

    expect(await within(suiteCard).findByText("zq-logs-only")).toBeInTheDocument();
    expect(within(suiteCard).queryByText("Failed to load test configurations")).toBeNull();
    expect(listDefinitions).toHaveBeenCalledTimes(2);
  });

  it("are deleted only once confirmed: 'Delete test configuration?' with its name", async () => {
    const { deleteDefinition } = serveApi();
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete test configuration" }));
    let confirm = await screen.findByRole("alertdialog", { name: "Delete test configuration?" });
    expect(confirm).toHaveTextContent("Delete the test configuration zq-logs-only?");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteDefinition).not.toHaveBeenCalled();

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete test configuration" }));
    confirm = await screen.findByRole("alertdialog", { name: "Delete test configuration?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteDefinition).toHaveBeenCalledWith(...TARGET, SUITE.id, DEFINITION.id);
    expect(within(cardSync("zq-smoke-tests")).getByText("No test configurations yet.")).toBeInTheDocument();
  });

  it("keep the confirmation open with the API's words when the delete is refused, else fixed words", async () => {
    const { deleteDefinition } = serveApi();
    deleteDefinition
      .mockRejectedValueOnce(new ApiError("configuration_version_not_found", "Version not found", { status: 404 }))
      .mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete test configuration" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Version not found"));
    expect(screen.getByRole("alertdialog", { name: "Delete test configuration?" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete test configuration"));
    expect(screen.getByRole("alertdialog", { name: "Delete test configuration?" })).toBeInTheDocument();
    expect(within(cardSync("zq-smoke-tests")).getByText("zq-logs-only")).toBeInTheDocument();
  });

  it("close the confirmation and leave the list when the API says it's gone already (404, another tab deleted it), with its words", async () => {
    const { deleteDefinition } = serveApi();
    deleteDefinition.mockRejectedValueOnce(new ApiError("test_definition_not_found", "Test configuration not found", { status: 404 }));
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete test configuration" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Test configuration not found"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(cardSync("zq-smoke-tests")).getByText("No test configurations yet.")).toBeInTheDocument();
  });
});

describe("the definition dialog, 'New test configuration'", () => {
  /** Expands the suite and opens its definition dialog. */
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await expand(user, "zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" }));
    return screen.findByRole("dialog", { name: "New test configuration" });
  }

  /** The main view's own controls (a slide's Name and Description are others). */
  const main = () => slotWith("Choose Test File");
  const ok = () => within(main()).getByRole("button", { name: "OK" });

  beforeEach(() => {
    api.suites = [SUITE];
  });

  it("opens with the remembered duration, no file chosen and the remembered pipeline; OK held until a name (trimmed) and a file", async () => {
    serveApi();
    useTestingStore.setState({
      lastRunDurationSeconds: 12,
      selectedFile: { id: OLD_FILE.id, displayName: OLD_FILE.displayName },
      selectedPipelineName: "logs/zqotlp",
    });
    const { user } = await renderSuites();
    const dialog = await openAdd(user);

    expect(within(main()).getByLabelText("Name")).toHaveAttribute("placeholder", "Logs only");
    expect(within(main()).getByLabelText("Description")).toHaveAttribute("placeholder", "Optional — what this test verifies");
    expect(within(dialog).getByRole("combobox", { name: "Test Pipeline" })).toHaveTextContent("logs/zqotlp");
    expect(within(dialog).getByLabelText("Run duration (seconds)")).toHaveValue(12);
    expect(within(dialog).getByText("Selected File:")).toHaveTextContent("Selected File: None");
    expect(ok()).toBeDisabled();
    // The sources, in order: My Files, Templates, Paste Text.
    expect(
      within(main())
        .getAllByRole("button")
        .map((button) => button.textContent)
        .filter((text) => ["My Files", "Templates", "Paste Text"].includes(text ?? "")),
    ).toEqual(["My Files", "Templates", "Paste Text"]);

    await user.type(within(main()).getByLabelText("Name"), "   ");
    expect(ok()).toBeDisabled();
  });

  it("opens with the first pipeline when none is remembered", async () => {
    serveApi();
    const { user } = await renderSuites();
    const dialog = await openAdd(user);

    expect(within(dialog).getByRole("combobox", { name: "Test Pipeline" })).toHaveTextContent("traces");
  });

  it("adds a definition from My Files: its name, description, pipeline and signal, duration and file; it writes nothing back to the run dialog's choice", async () => {
    const { createDefinition } = serveApi();
    useTestingStore.setState({ lastRunDurationSeconds: 12, selectedFile: null, selectedPipelineName: "traces" });
    const { user } = await renderSuites();
    await openAdd(user);

    await user.type(within(main()).getByLabelText("Name"), " zq-logs-only ");
    await user.type(within(main()).getByLabelText("Description"), "zq-checks-logs");
    await user.click(within(main()).getByRole("combobox", { name: "Test Pipeline" }));
    await user.click(await screen.findByRole("option", { name: "logs/zqotlp" }));
    await user.clear(within(main()).getByLabelText("Run duration (seconds)"));
    await user.type(within(main()).getByLabelText("Run duration (seconds)"), "9");
    await user.click(within(main()).getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "zq-old-upload", pressed: false }));
    await user.click(within(slotWith("zq-old-upload")).getByRole("button", { name: "OK" }));
    await screen.findByText("zq-old-upload", { selector: "span.font-mono" });
    await user.click(ok());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createDefinition).toHaveBeenCalledWith(...TARGET, SUITE.id, {
      inputFileId: OLD_FILE.id,
      name: "zq-logs-only",
      description: "zq-checks-logs",
      pipeline: "logs/zqotlp",
      signal: "logs",
      durationSeconds: 9,
    });
    expect(await within(cardSync("zq-smoke-tests")).findByText("zq-logs-only")).toBeInTheDocument();
    expect(useTestingStore.getState()).toMatchObject({ selectedFile: null, selectedPipelineName: "traces", lastRunDurationSeconds: 12 });

    // The run dialog opens as it would have: no file, the remembered pipeline and duration.
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await user.click(screen.getByRole("button", { name: "Configure and run" }));
    const run = await screen.findByRole("dialog", { name: "Select Test File" });
    expect(within(run).getByText("Selected File:")).toHaveTextContent("Selected File: None");
    expect(within(run).getByRole("combobox", { name: "Test Pipeline" })).toHaveTextContent("traces");
    expect(within(run).getByLabelText("Run duration (seconds)")).toHaveValue(12);
  });

  it("adds a definition from a file uploaded in it (My Files, then Upload)", async () => {
    const { createDefinition } = serveApi();
    const saved = testFileFixture({ id: "0199d000-0000-7000-8000-000000000009", displayName: "zq-picked", fileName: "zq-picked.ndjson" });
    const upload = vi.spyOn(apiClient, "uploadTestFile").mockImplementation(async () => {
      api.files = [saved, ...api.files];
      return { file: saved };
    });
    const { user } = await renderSuites();
    await openAdd(user);
    await user.type(within(main()).getByLabelText("Name"), "zq-uploaded-test");

    await user.click(within(main()).getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "Upload" }));
    const uploadSlot = slotWith("Upload Test File");
    const file = new File(['{"a":1}\n'], "zq-picked.ndjson", { type: "application/x-ndjson" });
    await user.upload(uploadSlot.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    await user.clear(within(uploadSlot).getByLabelText("Name"));
    await user.type(within(uploadSlot).getByLabelText("Name"), "zq-picked");
    await user.click(within(uploadSlot).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(GROUP_ID, { displayName: "zq-picked", description: "", file }));
    await user.click(await screen.findByRole("button", { name: "zq-picked", pressed: false }));
    await user.click(within(slotWith("zq-old-upload")).getByRole("button", { name: "OK" }));
    await screen.findByText("zq-picked", { selector: "span.font-mono" });
    await user.click(ok());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createDefinition).toHaveBeenCalledWith(...TARGET, SUITE.id, expect.objectContaining({ inputFileId: saved.id, name: "zq-uploaded-test" }));
    expect(useTestingStore.getState().selectedFile).toBeNull();
  });

  it("adds a definition from pasted text (saved to My Files first)", async () => {
    const { createDefinition } = serveApi();
    const saved = testFileFixture({ id: "0199d000-0000-7000-8000-000000000010", displayName: "zq-pasted", fileName: "zq-pasted.json" });
    const save = vi.spyOn(apiClient, "saveTestSample").mockImplementation(async () => {
      api.files = [saved, ...api.files];
      return { file: saved };
    });
    const { user } = await renderSuites();
    await openAdd(user);
    await user.type(within(main()).getByLabelText("Name"), "zq-pasted-test");

    await user.click(within(main()).getByRole("button", { name: "Paste Text" }));
    const pasteSlot = slotWith("Paste Test Sample");
    await user.type(within(pasteSlot).getByLabelText("Name"), "zq-pasted");
    fireEvent.change(await within(pasteSlot).findByRole("textbox", { name: "Sample editor" }), {
      target: { value: '{"resourceSpans":[]}' },
    });
    await user.click(within(pasteSlot).getByRole("button", { name: "Use Sample" }));
    await screen.findByText("zq-pasted", { selector: "span.font-mono" });
    await user.click(ok());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ displayName: "zq-pasted", text: '{"resourceSpans":[]}' }));
    expect(createDefinition).toHaveBeenCalledWith(...TARGET, SUITE.id, expect.objectContaining({ inputFileId: saved.id, name: "zq-pasted-test" }));
    expect(useTestingStore.getState().selectedFile).toBeNull();
  });

  it("toasts the API's words for a suite's 101st, keeping the dialog open", async () => {
    const { createDefinition } = serveApi();
    createDefinition.mockRejectedValueOnce(new ApiError("test_definition_limit_reached", TEST_DEFINITION_LIMIT_MESSAGE, { status: 409 }));
    const { user } = await renderSuites();
    await openAdd(user);
    await user.type(within(main()).getByLabelText("Name"), "One too many");
    await user.click(within(main()).getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "zq-old-upload", pressed: false }));
    await user.click(within(slotWith("zq-old-upload")).getByRole("button", { name: "OK" }));
    await screen.findByText("zq-old-upload", { selector: "span.font-mono" });
    await user.click(ok());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("A test suite can have at most 100 test configurations."));
    expect(screen.getByRole("dialog", { name: "New test configuration" })).toBeInTheDocument();
    expect(ok()).toHaveTextContent("OK");
  });

  it("reads 'Saving…' while the API answers", async () => {
    const { createDefinition } = serveApi();
    let answer: () => void = () => undefined;
    createDefinition.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ definition: DEFINITION });
        }),
    );
    const { user } = await renderSuites();
    await openAdd(user);
    await user.type(within(main()).getByLabelText("Name"), "zq-slow");
    await user.click(within(main()).getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "zq-old-upload", pressed: false }));
    await user.click(within(slotWith("zq-old-upload")).getByRole("button", { name: "OK" }));
    await screen.findByText("zq-old-upload", { selector: "span.font-mono" });
    await user.click(ok());

    expect(await within(main()).findByRole("button", { name: "Saving…" })).toBeDisabled();
    act(() => answer());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("replay", () => {
  it("puts no suite, definition or file name, nor a description, in any attribute, with every card, dialog and confirmation shown", async () => {
    serveApi();
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const markers: string[] = [];
    /** Every attribute in the document carrying a marker; an input's value is masked by replay (maskAllInputs). */
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && attribute.name === "value") continue;
          if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
    };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    await screen.findByText("zq-logs-only");
    scan();

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Edit suite" }));
    await screen.findByRole("dialog", { name: "Edit suite" });
    scan();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete suite" }));
    await screen.findByRole("alertdialog");
    scan();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete test configuration" }));
    await screen.findByRole("alertdialog");
    scan();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" }));
    await screen.findByRole("dialog", { name: "New test configuration" });
    await user.type(within(slotWith("Choose Test File")).getByLabelText("Name"), "zq-typed-name");
    await user.click(within(slotWith("Choose Test File")).getByRole("combobox", { name: "Test Pipeline" }));
    await user.click(await screen.findByRole("option", { name: "logs/zqotlp" }));
    await user.click(within(slotWith("Choose Test File")).getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "zq-old-upload", pressed: false }));
    await user.click(within(slotWith("zq-old-upload")).getByRole("button", { name: "OK" }));
    await screen.findByText("zq-old-upload", { selector: "span.font-mono" });
    scan();

    expect(markers).toEqual([]);
    // The scan saw them, as text.
    expect(screen.getByText("zq-old-upload", { selector: "span.font-mono" })).toBeInTheDocument();
  });
});

/*
 * Play one, Play all and the hold, from the cards. The API queues each
 * definition's run with its breadcrumb and lists it from then on; a run ends
 * when a test says so.
 */

/** The runs the API has queued, newest first, as they now stand. */
let queuedRuns: TestRunDetail[] = [];

/** The API's queue, list and run reads, over `queuedRuns`; a definition's input head as raw OTLP JSON unless a test serves another. */
function serveRuns() {
  queuedRuns = [];
  let next = 0;
  const queue = vi.spyOn(apiClient, "queueTestRun").mockImplementation(async (_o, _c, _v, request) => {
    next += 1;
    const definitionId = "definitionId" in request ? request.definitionId : null;
    const definition = Object.values(api.definitions)
      .flat()
      .find((each) => each.id === definitionId);
    const suite = api.suites.find((each) => each.id === definition?.suiteId);
    const run = testRunFixture({
      id: `0199e000-0000-7000-8000-${String(next).padStart(12, "0")}`,
      queuedAt: `2026-10-10T12:00:${String(next).padStart(2, "0")}.000Z`,
      queuedByUserId: MEMBER_ID,
      ...(definition === undefined || suite === undefined
        ? {}
        : { suiteId: suite.id, suiteName: suite.name, definitionId: definition.id, definitionName: definition.name }),
    });
    queuedRuns = [run, ...queuedRuns];
    return { run };
  });
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: queuedRuns.map(testRunSummaryOf) }));
  vi.spyOn(apiClient, "getTestRun").mockImplementation(async (_o, _c, _v, runId) => {
    const run = queuedRuns.find((each) => each.id === runId);
    if (run === undefined) throw new ApiError("test_run_not_found", "Test run not found", { status: 404 });
    return { run };
  });
  const head = vi
    .spyOn(apiClient, "getTestDefinitionInputHead")
    .mockResolvedValue(new TextEncoder().encode('{"resourceLogs":[{"scopeLogs":[]}]}'));
  return { queue, head };
}

/** Ends every run the API has queued so far. */
function endAll() {
  queuedRuns = queuedRuns.map((run) => ({ ...run, status: "succeeded" as const, ahead: null, startedAt: run.queuedAt, finishedAt: run.queuedAt }));
}

const SECOND_DEFINITION = testDefinitionFixture({ id: "0199f100-0000-7000-8000-000000000002", name: "zq-traces-too", pipeline: "traces", signal: "traces" });
const THIRD_DEFINITION = testDefinitionFixture({ id: "0199f100-0000-7000-8000-000000000003", name: "zq-third" });

/** The Tests subtab's selected row (pressed). */
const selectedRow = () => screen.getByRole("button", { pressed: true });

/** Whether every Play on the version is held for the person signed in. */
const isHeld = () => selectIsPlayHeld(useTestingStore.getState(), MEMBER_ID, VERSION.id);

/** A definition's input head the fixture-shape check questions on an OTLP pipeline: raw lines. */
const RAW_HEAD = new TextEncoder().encode("zq raw line one\nzq raw line two\n");

/** Another version of the configuration, for a switch mid-start. */
const OTHER_VERSION = versionFixture({ id: "0199c000-0000-7000-8000-000000000077", yamlContent: YAML });

describe("Play one, a definition's Run test", () => {
  beforeEach(() => {
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
  });

  it("queues the definition from itself with the text and pin as they are, then shows Tests, its run selected and focused, with its breadcrumb", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true"));
    expect(queue.mock.calls).toEqual([[GROUP_ID, MINE.id, VERSION.id, { definitionId: DEFINITION.id, yaml: YAML, collectorVersion: "0.162.0" }]]);
    // The question's head is the definition's own input's.
    expect(head).toHaveBeenCalledWith(...TARGET, SUITE.id, DEFINITION.id, { signal: expect.any(AbortSignal) });
    await waitFor(() => expect(document.activeElement).toBe(selectedRow()));
    expect(selectedRow()).toHaveTextContent("zq-smoke-tests › zq-logs-only");
  });

  it("asks the fixture-shape question from the definition's own input: Cancel stays on Suites, queuing nothing and holding nothing; Run Anyway queues it, then shows Tests", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    // Raw lines on an OTLP pipeline.
    head.mockResolvedValue(new TextEncoder().encode("zq raw line one\nzq raw line two\n"));
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
    const question = await screen.findByRole("dialog", { name: "Fixture may not match the receiver" });
    // The question holds every Play until it is answered.
    expect(selectIsPlayHeld(useTestingStore.getState(), MEMBER_ID, VERSION.id)).toBe(true);
    await user.click(within(question).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("tab", { name: "Suites" })).toHaveAttribute("aria-selected", "true");
    expect(queue).not.toHaveBeenCalled();
    expect(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" })).toBeEnabled();

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Fixture may not match the receiver" })).getByRole("button", { name: "Run Anyway" }));

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(queue.mock.calls[0]![3]).toEqual({ definitionId: DEFINITION.id, yaml: YAML, collectorVersion: "0.162.0" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(document.activeElement).toBe(selectedRow()));
  });

  it("starts once on a double click during its head read: the hold is set at the click", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    let answer!: (bytes: Uint8Array) => void;
    head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const run = within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" });

    await user.dblClick(run);

    expect(head).toHaveBeenCalledOnce();
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute("title", "Another run is in progress");
    answer(new TextEncoder().encode('{"resourceLogs":[]}'));
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true"));
    expect(queue).toHaveBeenCalledOnce();
  });

  it("starts once for two Run test clicks before any re-render (both still pressable): beginStart's check refuses the second", async () => {
    api.definitions = { [SUITE.id]: [DEFINITION, SECOND_DEFINITION] };
    serveApi();
    const { queue, head } = serveRuns();
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const [first, second] = within(cardSync("zq-smoke-tests")).getAllByRole("button", { name: "Run test" });

    act(() => {
      fireEvent.click(first!);
      fireEvent.click(second!);
    });

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    await waitFor(() => expect(isHeld()).toBe(true));
    expect(head).toHaveBeenCalledOnce();
    expect(queue.mock.calls[0]![3]).toEqual({ definitionId: DEFINITION.id, yaml: YAML, collectorVersion: "0.162.0" });
  });

  it("drops the question when its head answers after the version changed: no question, nothing queued, the hold released", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    let answer!: (bytes: Uint8Array) => void;
    head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
    expect(isHeld()).toBe(true);

    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION }));
    await act(async () => answer(RAW_HEAD));

    // Settled either way: the hold released, or a question shown.
    await waitFor(() => expect(useTestingStore.getState().starting === null || screen.queryByRole("dialog") !== null).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useTestingStore.getState().starting).toBeNull();
    expect(queue).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Suites" })).toHaveAttribute("aria-selected", "true");
  });

  it("closes the question already showing when the version changes: nothing queued, the hold released, no Run Anyway left to queue on the version left", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    head.mockResolvedValue(RAW_HEAD);
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
    const question = await screen.findByRole("dialog", { name: "Fixture may not match the receiver" });
    const runAnyway = within(question).getByRole("button", { name: "Run Anyway" });
    expect(isHeld()).toBe(true);

    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(runAnyway).not.toBeInTheDocument();
    expect(useTestingStore.getState().starting).toBeNull();
    expect(isHeld()).toBe(false);
    expect(selectIsPlayHeld(useTestingStore.getState(), MEMBER_ID, OTHER_VERSION.id)).toBe(false);
    expect(queue).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Suites" })).toHaveAttribute("aria-selected", "true");
  });

  it("releases the hold when the panel collapses with the question showing, queuing nothing (the tab unmounted)", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    head.mockResolvedValue(RAW_HEAD);
    const { user, unmount } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
    await screen.findByRole("dialog", { name: "Fixture may not match the receiver" });
    expect(isHeld()).toBe(true);

    unmount();

    expect(isHeld()).toBe(false);
    expect(queue).not.toHaveBeenCalled();
  });

  it("releases the hold when the panel collapses during the head read and the head then asks: no question, nothing queued", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    let answer!: (bytes: Uint8Array) => void;
    head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { user, unmount } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));

    unmount();
    // The read is still under way: the start still holds.
    expect(isHeld()).toBe(true);
    answer(RAW_HEAD);

    await waitFor(() => expect(isHeld()).toBe(false));
    expect(queue).not.toHaveBeenCalled();
  });

  it("shows a refusal by its message, else 'Failed to start test run', staying on Suites", async () => {
    serveApi();
    const { queue } = serveRuns();
    queue
      .mockRejectedValueOnce(new ApiError("testing_unavailable", "Testing is unavailable right now. Try again later.", { status: 503 }))
      .mockRejectedValueOnce(new ApiError("invalid_request", "The request was not valid.", { status: 400 }));
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const run = () => within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" });

    await user.click(run());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Testing is unavailable right now. Try again later."));
    await waitFor(() => expect(run()).toBeEnabled());
    await user.click(run());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to start test run"));
    expect(screen.getByRole("tab", { name: "Suites" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Play all from a card", () => {
  beforeEach(() => {
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION, SECOND_DEFINITION, THIRD_DEFINITION] };
  });

  it("in parallel: shows Tests once the definitions are read, queues every definition from itself in the card's order, no question; each row's breadcrumb; the first one's run selected and focused", async () => {
    serveApi();
    const { queue, head } = serveRuns();
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(3));
    expect(queue.mock.calls.map((call) => call[3])).toEqual(
      [DEFINITION, SECOND_DEFINITION, THIRD_DEFINITION].map((definition) => ({ definitionId: definition.id, yaml: YAML, collectorVersion: "0.162.0" })),
    );
    // No fixture-shape question for a Play all.
    expect(head).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(selectedRow()));
    expect(selectedRow()).toHaveTextContent("zq-smoke-tests › zq-logs-only");
    for (const name of ["zq-logs-only", "zq-traces-too", "zq-third"]) {
      expect(screen.getByText(`zq-smoke-tests › ${name}`)).toBeInTheDocument();
    }
  });

  it("shows Tests only once the definitions are known not to be empty: Suites while they are read; an empty suite's toast and a failed read leave the person on Suites", async () => {
    const { listDefinitions } = serveApi();
    const { queue } = serveRuns();
    const toastInfo = vi.spyOn(toast, "info");
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");
    const suitesShown = () => expect(screen.getByRole("tab", { name: "Suites" })).toHaveAttribute("aria-selected", "true");

    // Empty.
    api.definitions = { [SUITE.id]: [] };
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("This suite has no test configurations yet"));
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    suitesShown();

    // The read fails.
    listDefinitions.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests serially" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to load test configurations"));
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    suitesShown();
    expect(queue).not.toHaveBeenCalled();

    // While the read is under way, Suites still shows; once it answers with a definition, Tests.
    let answer!: (value: { definitions: TestDefinition[] }) => void;
    listDefinitions.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));
    await waitFor(() => expect(answer).toBeDefined());
    suitesShown();
    expect(useTestingStore.getState().playAll).not.toBeNull();
    answer({ definitions: [DEFINITION] });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
  });

  it("queues each definition once on a double click", async () => {
    serveApi();
    const { queue } = serveRuns();
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.dblClick(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));

    await waitFor(() => expect(queue).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it("starts one Play all for two clicks before any re-render (both buttons still pressable): the store's guard, not the subtab switch, refuses the second; the definitions read once", async () => {
    const { listDefinitions } = serveApi();
    const { queue } = serveRuns();
    await renderSuites();
    await screen.findByText("zq-smoke-tests");
    const parallel = within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" });
    const serial = within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests serially" });

    act(() => {
      fireEvent.click(parallel);
      fireEvent.click(serial);
    });

    // The first, in parallel: every definition queued without waiting for a run to end. Had the
    // second started (stopping the first), its serial loop would queue one and wait.
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    expect(listDefinitions).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it("drops the focus request of a Play all whose first run answers while Suites shows: keyboard to Tests later, the focus stays on the tab", async () => {
    serveApi();
    const { queue } = serveRuns();
    const answers: Array<() => void> = [];
    const queueRun = queue.getMockImplementation()!;
    queue.mockImplementation((...args) => new Promise((resolve) => answers.push(() => resolve(queueRun(...args)))));
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));
    await waitFor(() => expect(answers).toHaveLength(3));

    // Back to Suites before the queue answers.
    await user.click(screen.getByRole("tab", { name: "Suites" }));
    await act(async () => {
      for (const respond of answers) respond();
    });
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    expect(useTestingStore.getState().selectedRunId).not.toBeNull();

    // Later, by the keyboard: the Tests tab takes the focus and keeps it (Home: Validation now sits between them).
    act(() => screen.getByRole("tab", { name: "Suites" }).focus());
    await user.keyboard("{Home}");
    const tests = screen.getByRole("tab", { name: "Tests" });
    await waitFor(() => expect(tests).toHaveAttribute("aria-selected", "true"));
    expect(selectedRow()).toBeInTheDocument();
    expect(document.activeElement).toBe(tests);
  });

  it("serially: one at a time, the next once the run before has ended, each step's run selected; not stopped by the panel collapsing (the tab unmounted)", async () => {
    serveApi();
    const { queue } = serveRuns();
    const { user, unmount } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests serially" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    await waitFor(() => expect(selectedRow()).toHaveTextContent("zq-smoke-tests › zq-logs-only"));

    // The right panel collapses: the tab unmounts, the Play all goes on.
    unmount();
    endAll();
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
    expect(queue.mock.calls[1]![3]).toMatchObject({ definitionId: SECOND_DEFINITION.id });
    endAll();
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(3));
    endAll();
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
  });

  it("toasts the refusals once, 'k of n test configurations weren't queued' with the API's words", async () => {
    serveApi();
    const { queue } = serveRuns();
    const full = new ApiError("test_run_queue_full", TEST_RUN_QUEUE_FULL_MESSAGE, { status: 429 });
    queue.mockRejectedValueOnce(full).mockRejectedValueOnce(full);
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));

    await waitFor(() => expect(queue).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(toastError).toHaveBeenLastCalledWith(`2 of 3 test configurations weren't queued: ${TEST_RUN_QUEUE_FULL_MESSAGE}`, {
        id: expect.any(String),
      }),
    );
  });
});

describe("one hold over every Play", () => {
  beforeEach(() => {
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
  });

  it("holds Configure and run, ↺, Run test and both Play alls, titled 'Another run is in progress', while a Play all is under way, a run starts, or the person's own run waits; never the suites' and definitions' edits", async () => {
    serveApi();
    serveRuns();
    const teammates = testRunFixture({ queuedByUserId: "00000000-0000-4000-8000-000000000012", status: "succeeded", ahead: null });
    queuedRuns = [teammates];
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const target = { organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id };

    const plays = () => [
      within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }),
      within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }),
      within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests serially" }),
    ];
    const edits = () => [
      screen.getByRole("button", { name: "Add suite" }),
      within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Edit suite" }),
      within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete suite" }),
      within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete test configuration" }),
      within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" }),
    ];
    const expectHeld = (isHeld: boolean) => {
      for (const button of plays()) {
        expect(button).toHaveProperty("disabled", isHeld);
        if (isHeld) expect(button).toHaveAttribute("title", "Another run is in progress");
      }
      for (const button of edits()) expect(button).toBeEnabled();
    };
    expectHeld(false);

    // A Play all under way.
    let playing!: PlayAllRun;
    act(() => {
      playing = useTestingStore.getState().beginPlayAll(target, SUITE.id, "serial", MEMBER_ID)!;
    });
    expectHeld(true);
    act(() => useTestingStore.getState().endPlayAll(playing));
    expectHeld(false);

    // A single run starting.
    let release!: () => void;
    act(() => {
      release = useTestingStore.getState().beginStart(target, MEMBER_ID) as () => void;
    });
    expectHeld(true);
    act(() => release());
    expectHeld(false);

    // The person's own run waiting, and on the Tests subtab too: Configure and run and every ↺.
    act(() => {
      useTestingStore.getState().beginStart(target, MEMBER_ID);
    });
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    const configure = screen.getByRole("button", { name: "Configure and run" });
    expect(configure).toBeDisabled();
    expect(configure).toHaveAttribute("title", "Another run is in progress");
    const rerun = await screen.findByRole("button", { name: "Re-run test" });
    expect(rerun).toBeDisabled();
    expect(rerun).toHaveAttribute("title", "Another run is in progress");
    act(() => useTestingStore.getState().reset());
    act(() =>
      useTestingStore.setState({
        runsVersionId: VERSION.id,
        runs: [testRunSummaryOf(testRunFixture({ status: "queued", queuedByUserId: MEMBER_ID }))],
      }),
    );
    expect(screen.getByRole("button", { name: "Configure and run" })).toBeDisabled();
  });
});

describe("a definition from a template", () => {
  it("copies the template picked in the definition dialog's Templates step: the request names it by id", async () => {
    api.suites = [SUITE];
    const { createDefinition } = serveApi();
    const template: TestTemplate = {
      id: "0199f200-0000-7000-8000-000000000001",
      name: "zq-template-pick",
      description: "",
      receiverType: "otlp",
      signal: "logs",
      fileName: "zq-template-pick.json",
      contentType: "application/json",
      sizeBytes: 20,
      createdAt: "2026-10-10T12:00:00.000Z",
      updatedAt: "2026-10-10T12:00:00.000Z",
    };
    vi.spyOn(apiClient, "getTestTemplates").mockResolvedValue({ templates: [template] });
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" }));
    const dialog = await screen.findByRole("dialog", { name: "New test configuration" });
    const main = slotWith("Choose Test File");
    await user.type(within(main).getByLabelText("Name"), "zq-from-template");

    await user.click(within(main).getByRole("button", { name: "Templates" }));
    await user.click(await screen.findByRole("button", { name: "zq-template-pick", pressed: false }));
    await user.click(within(slotWith("zq-template-pick")).getByRole("button", { name: "OK" }));
    expect(await within(dialog).findByText("zq-template-pick", { selector: "span.font-mono" })).toBeInTheDocument();
    await user.click(within(main).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(createDefinition).toHaveBeenCalledOnce());
    expect(createDefinition).toHaveBeenCalledWith(...TARGET, SUITE.id, {
      templateId: template.id,
      name: "zq-from-template",
      description: "",
      pipeline: "traces",
      signal: "traces",
      durationSeconds: 5,
    });
    // The run dialog's own choice is untouched.
    expect(useTestingStore.getState().selectedTemplate).toBeNull();
  });
});

describe("the Suites subtab's focus, reads and refusals", () => {
  const SECOND_SUITE = testSuiteFixture({ id: "0199f000-0000-7000-8000-000000000002", name: "zq-second-suite", description: "" });
  const THIRD_SUITE = testSuiteFixture({ id: "0199f000-0000-7000-8000-000000000003", name: "zq-third-suite", description: "" });
  /** A card's header (its expand button). */
  const header = (name: string) => screen.getByRole("button", { name: new RegExp(name), expanded: false });

  it("gives the focus back to the opener as the suite dialogs close: Add suite, Edit suite", async () => {
    serveApi();
    api.suites = [SUITE];
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    await user.click(within(await screen.findByRole("dialog", { name: "New suite" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add suite" })));

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    await user.type(within(await screen.findByRole("dialog", { name: "New suite" })).getByLabelText("Name"), "zq-new-suite");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add suite" })));

    const edit = within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Edit suite" });
    await user.click(edit);
    await user.click(within(await screen.findByRole("dialog", { name: "Edit suite" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Edit suite" })));
  });

  it("gives the focus back to 'Add test configuration' as the definition dialog closes", async () => {
    serveApi();
    api.suites = [SUITE];
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const add = within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" });

    await user.click(add);
    await user.click(within(slotWith("Choose Test File")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" })));
  });

  it("moves the focus after a suite's delete to the next card's header, else the previous one's, else Add suite", async () => {
    serveApi();
    api.suites = [SUITE, SECOND_SUITE, THIRD_SUITE];
    const { user } = await renderSuites();
    await screen.findByText("zq-third-suite");
    const remove = async (name: string) => {
      await user.click(within(cardSync(name)).getByRole("button", { name: "Delete suite" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    };

    await remove("zq-second-suite");
    await waitFor(() => expect(document.activeElement).toBe(header("zq-third-suite")));
    await remove("zq-third-suite");
    await waitFor(() => expect(document.activeElement).toBe(header("zq-smoke-tests")));
    await remove("zq-smoke-tests");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add suite" })));
  });

  it("moves the focus after a definition's delete to the next row's first button, else the previous row's, else 'Add test configuration'", async () => {
    serveApi();
    const second = testDefinitionFixture({ id: "0199f100-0000-7000-8000-000000000002", name: "zq-second-definition" });
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION, second] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const remove = async (name: string) => {
      const row = within(cardSync("zq-smoke-tests")).getByText(name).closest("li")!;
      await user.click(within(row).getByRole("button", { name: "Delete test configuration" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    };

    await remove("zq-logs-only");
    const nextRow = within(cardSync("zq-smoke-tests")).getByText("zq-second-definition").closest("li")!;
    await waitFor(() => expect(document.activeElement).toBe(within(nextRow).getByRole("button", { name: "Run test" })));
    await remove("zq-second-definition");
    await waitFor(() => expect(document.activeElement).toBe(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" })));
  });

  it("moves the focus after a definition's delete to the next row's first button that can be pressed: Delete, while Run test is held", async () => {
    serveApi();
    const second = testDefinitionFixture({ id: "0199f100-0000-7000-8000-000000000002", name: "zq-second-definition" });
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION, second] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    // Every Play held: a run starting.
    act(() => {
      useTestingStore.getState().beginStart({ organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id }, MEMBER_ID);
    });
    const row = within(cardSync("zq-smoke-tests")).getByText("zq-logs-only").closest("li")!;

    await user.click(within(row).getByRole("button", { name: "Delete test configuration" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    const nextRow = within(cardSync("zq-smoke-tests")).getByText("zq-second-definition").closest("li")!;
    expect(within(nextRow).getByRole("button", { name: "Run test" })).toBeDisabled();
    await waitFor(() => expect(document.activeElement).toBe(within(nextRow).getByRole("button", { name: "Delete test configuration" })));
  });

  it("gives the focus back to the Delete that opened a confirmation closed without deleting: Cancel and Escape, a suite's and a definition's", async () => {
    const { deleteSuite, deleteDefinition } = serveApi();
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const suiteDelete = within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete suite" });
    const definitionDelete = within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete test configuration" });
    /** Opens the confirmation from `opener` (the click moves the focus into it), then closes it with `close`. */
    const openAndClose = async (opener: HTMLElement, close: (dialog: HTMLElement) => Promise<void>) => {
      await user.click(opener);
      const dialog = await screen.findByRole("alertdialog");
      await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
      await close(dialog);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    };
    const cancel = (dialog: HTMLElement) => user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const escape = () => user.keyboard("{Escape}");

    await openAndClose(suiteDelete, cancel);
    await waitFor(() => expect(document.activeElement).toBe(suiteDelete));
    await openAndClose(suiteDelete, escape);
    await waitFor(() => expect(document.activeElement).toBe(suiteDelete));
    await openAndClose(definitionDelete, cancel);
    await waitFor(() => expect(document.activeElement).toBe(definitionDelete));
    await openAndClose(definitionDelete, escape);
    await waitFor(() => expect(document.activeElement).toBe(definitionDelete));

    expect(deleteSuite).not.toHaveBeenCalled();
    expect(deleteDefinition).not.toHaveBeenCalled();
    expect(within(cardSync("zq-smoke-tests")).getByText("zq-logs-only")).toBeInTheDocument();
  });

  it("shows a suite created after a failed first read: the list is read again", async () => {
    const { listSuites } = serveApi();
    listSuites.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 502 }));
    const { user } = await renderSuites();
    await screen.findByText("Failed to load test suites");

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    await user.type(within(await screen.findByRole("dialog", { name: "New suite" })).getByLabelText("Name"), "zq-after-failure");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("zq-after-failure")).toBeInTheDocument();
    expect(screen.queryByText("Failed to load test suites")).toBeNull();
    expect(listSuites).toHaveBeenCalledTimes(2);
  });

  it("never shows another version's suites while the store still holds them (before this version's read has begun)", async () => {
    serveApi();
    const otherTarget = { organizationId: GROUP_ID, configurationId: MINE.id, versionId: "0199c000-0000-7000-8000-000000000002" };
    api.suites = [testSuiteFixture({ id: "0199f000-0000-7000-8000-000000000009", name: "zq-other-version-suite" })];
    await act(() => useTestSuitesStore.getState().loadSuites(otherTarget));
    // This version's read never starts: what shows is only what the guard lets through.
    const read = vi.spyOn(useTestSuitesStore.getState(), "loadSuites").mockResolvedValue(undefined);

    render(<TestingTab />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Suites" }));

    await waitFor(() => expect(read).toHaveBeenCalledWith({ organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id }));
    expect(useTestSuitesStore.getState().target).toEqual(otherTarget);
    expect(screen.queryByText("zq-other-version-suite")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("toasts the API's words when a rename is refused, keeping the dialog open", async () => {
    const { updateSuite } = serveApi();
    updateSuite.mockRejectedValueOnce(new ApiError("test_suite_not_found", "Test suite not found", { status: 404 }));
    api.suites = [SUITE];
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Edit suite" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit suite" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Test suite not found"));
    expect(screen.getByRole("dialog", { name: "Edit suite" })).toBeInTheDocument();
  });

  it("keeps a suite's confirmation open on a refused delete (the API's words, else fixed words); closes it, the suite gone, on a 404 test_suite_not_found", async () => {
    const { deleteSuite } = serveApi();
    deleteSuite
      .mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }))
      .mockRejectedValueOnce(new ApiError("test_suite_not_found", "Test suite not found", { status: 404 }));
    api.suites = [SUITE];
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Delete suite" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete suite"));
    expect(screen.getByRole("alertdialog", { name: "Delete test suite?" })).toBeInTheDocument();
    expect(useTestSuitesStore.getState().suites).toEqual([SUITE]);

    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Test suite not found"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("No suites yet. Click + to create one.")).toBeInTheDocument();
  });

  it("keeps names and descriptions to what the API stores (maxLength)", async () => {
    serveApi();
    api.suites = [SUITE];
    const { user } = await renderSuites();
    await screen.findByText("zq-smoke-tests");

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    const suiteDialog = await screen.findByRole("dialog", { name: "New suite" });
    expect(within(suiteDialog).getByLabelText("Name")).toHaveAttribute("maxLength", String(TEST_SUITE_NAME_MAXIMUM_LENGTH));
    expect(within(suiteDialog).getByLabelText("Description")).toHaveAttribute("maxLength", String(TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH));
    await user.click(within(suiteDialog).getByRole("button", { name: "Cancel" }));

    await expand(user, "zq-smoke-tests");
    await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" }));
    const main = slotWith("Choose Test File");
    expect(within(main).getByLabelText("Name")).toHaveAttribute("maxLength", String(TEST_DEFINITION_NAME_MAXIMUM_LENGTH));
    expect(within(main).getByLabelText("Description")).toHaveAttribute("maxLength", String(TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH));
  });

  it("describes each row's buttons by its name's text (aria-describedby), the name never in an attribute", async () => {
    serveApi();
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
    const { user } = await renderSuites();
    await expand(user, "zq-smoke-tests");
    const suiteCard = cardSync("zq-smoke-tests");

    for (const name of ["Delete suite", "Edit suite", "Play all tests in parallel", "Play all tests serially"]) {
      expect(within(suiteCard).getByRole("button", { name })).toHaveAccessibleDescription("zq-smoke-tests");
    }
    for (const name of ["Run test", "Delete test configuration"]) {
      expect(within(suiteCard).getByRole("button", { name })).toHaveAccessibleDescription("zq-logs-only");
    }
  });
});

describe("the question, the hold and the focus around a Play", () => {
  /** A matching head: an OTLP envelope on the OTLP logs pipeline, so no question. */
  const MATCHING_HEAD = new TextEncoder().encode('{"resourceLogs":[]}');
  /** A subtab's trigger; found while a modal dialog hides the rest from the accessibility tree too. */
  const tab = (name: "Tests" | "Suites") => screen.getByRole("tab", { name, hidden: true });
  const suitesShown = () => expect(tab("Suites")).toHaveAttribute("aria-selected", "true");

  /** A read that answers only by its abort, as the client does (REQUEST_ABORTED); never without a signal. */
  function stalled(...args: unknown[]): Promise<never> {
    const options = args.at(-1);
    const signal = typeof options === "object" && options !== null ? (options as { signal?: AbortSignal }).signal : undefined;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
    });
  }

  /**
   * A browser drops the focus of a button that becomes disabled (held), to
   * the body; jsdom keeps it there, and won't blur a disabled button, so a
   * test drops it as a browser would: enabled for the blur alone.
   */
  function dropHeldFocus(button: HTMLButtonElement) {
    expect(button).toBeDisabled();
    act(() => {
      button.disabled = false;
      button.blur();
      button.disabled = true;
    });
    expect(document.activeElement).toBe(document.body);
  }

  beforeEach(() => {
    api.suites = [SUITE];
    api.definitions = { [SUITE.id]: [DEFINITION] };
  });

  describe("the question's hold", () => {
    it("is released when the panel collapses in the same React batch as the question's head answering", async () => {
      serveApi();
      const { queue, head } = serveRuns();
      let answer!: (bytes: Uint8Array) => void;
      head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      let hide!: () => void;
      function Host() {
        const [shown, setShown] = useState(true);
        hide = () => setShown(false);
        return shown ? <TestingTab /> : <p>collapsed</p>;
      }
      render(<Host />);
      const user = userEvent.setup();
      await user.click(tab("Suites"));
      await expand(user, "zq-smoke-tests");
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
      expect(isHeld()).toBe(true);

      // The head answers, its question is set, and the panel collapses: one act, one batch, no render between.
      await act(async () => {
        answer(RAW_HEAD);
        for (let step = 0; step < 50; step += 1) await Promise.resolve();
        hide();
      });

      expect(screen.getByText("collapsed")).toBeInTheDocument();
      expect(useTestingStore.getState().starting).toBeNull();
      expect(isHeld()).toBe(false);
      expect(queue).not.toHaveBeenCalled();
    });
  });

  describe("the focus as the question closes", () => {
    it("goes to the active subtab's trigger when the question closes as the version changes", async () => {
      serveApi();
      const { head } = serveRuns();
      head.mockResolvedValue(RAW_HEAD);
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
      await screen.findByRole("dialog", { name: "Fixture may not match the receiver" });

      act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(tab("Suites")));
    });

    it("goes back to the Run test pressed when the question is cancelled (nothing queued)", async () => {
      serveApi();
      const { head } = serveRuns();
      head.mockResolvedValue(RAW_HEAD);
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      const run = () => within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" });
      await user.click(run());

      await user.click(within(await screen.findByRole("dialog", { name: "Fixture may not match the receiver" })).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(run()));
      expect(run()).toBeEnabled();
    });
  });

  describe("no switch to Tests while a Suites dialog shows", () => {
    it("keeps the suite dialog and its typed text while a Play all's runs queue: the first selected, Suites still shown, the focus left in the dialog", async () => {
      api.definitions = { [SUITE.id]: [DEFINITION, SECOND_DEFINITION] };
      const { listDefinitions } = serveApi();
      const { queue } = serveRuns();
      let answer!: (value: { definitions: TestDefinition[] }) => void;
      listDefinitions.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));
      await waitFor(() => expect(answer).toBeDefined());
      await user.click(screen.getByRole("button", { name: "Add suite" }));
      const dialog = await screen.findByRole("dialog", { name: "New suite" });
      await user.type(within(dialog).getByLabelText("Name"), "zq-typed-meanwhile");

      await act(async () => answer({ definitions: [DEFINITION, SECOND_DEFINITION] }));

      await waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
      expect(useTestingStore.getState().selectedRunId).toBe("0199e000-0000-7000-8000-000000000001");
      expect(screen.getByRole("dialog", { name: "New suite" })).toBe(dialog);
      expect(within(dialog).getByLabelText("Name")).toHaveValue("zq-typed-meanwhile");
      expect(within(dialog).getByLabelText("Name")).toHaveFocus();
      suitesShown();

      // Closed: back to Add suite. Tests, shown later, has the run selected, and no request left to pull the focus to it.
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add suite" })));
      await user.click(tab("Tests"));
      expect(selectedRow()).toHaveTextContent("zq-smoke-tests › zq-logs-only");
      expect(document.activeElement).toBe(tab("Tests"));
    });

    it("keeps the definition dialog and its typed name while a Play one's run queues, selected", async () => {
      serveApi();
      const { queue, head } = serveRuns();
      let answer!: (bytes: Uint8Array) => void;
      head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
      await waitFor(() => expect(answer).toBeDefined());
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Add test configuration" }));
      const name = within(slotWith("Choose Test File")).getByLabelText("Name");
      await user.type(name, "zq-typed-name");

      await act(async () => answer(MATCHING_HEAD));

      await waitFor(() => expect(queue).toHaveBeenCalledOnce());
      await waitFor(() => expect(useTestingStore.getState().starting).toBeNull());
      expect(useTestingStore.getState().selectedRunId).toBe("0199e000-0000-7000-8000-000000000001");
      expect(screen.getByRole("dialog", { name: "New test configuration" })).toBeInTheDocument();
      expect(within(slotWith("Choose Test File")).getByLabelText("Name")).toHaveValue("zq-typed-name");
      suitesShown();
    });

    it.each([
      ["Delete suite", "Delete test suite?"],
      ["Delete test configuration", "Delete test configuration?"],
    ])("keeps the confirmation opened by %s while a Play one's run queues", async (opener, title) => {
      serveApi();
      const { queue, head } = serveRuns();
      let answer!: (bytes: Uint8Array) => void;
      head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
      await waitFor(() => expect(answer).toBeDefined());
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: opener }));
      const confirmation = await screen.findByRole("alertdialog", { name: title });

      await act(async () => answer(MATCHING_HEAD));

      await waitFor(() => expect(queue).toHaveBeenCalledOnce());
      await waitFor(() => expect(useTestingStore.getState().starting).toBeNull());
      expect(screen.getByRole("alertdialog", { name: title })).toBe(confirmation);
      suitesShown();
    });

    it("switches as before once the dialog has closed", async () => {
      serveApi();
      const { queue, head } = serveRuns();
      let answer!: (bytes: Uint8Array) => void;
      head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      await user.click(screen.getByRole("button", { name: "Add suite" }));
      await user.click(within(await screen.findByRole("dialog", { name: "New suite" })).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
      await act(async () => answer(MATCHING_HEAD));

      await waitFor(() => expect(queue).toHaveBeenCalledOnce());
      await waitFor(() => expect(tab("Tests")).toHaveAttribute("aria-selected", "true"));
      await waitFor(() => expect(document.activeElement).toBe(selectedRow()));
    });
  });

  describe("reads that never answer (fake timers, the hang guard)", () => {
    it("ends the suites' spinner after 10 s: 'Failed to load test suites' with Retry", async () => {
      vi.useFakeTimers();
      try {
        const { listSuites } = serveApi();
        listSuites.mockImplementation(stalled);
        render(<TestingTab />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        fireEvent.mouseDown(tab("Suites"));
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(screen.getByRole("status", { name: "Loading test suites" })).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1));
        expect(screen.getByRole("status", { name: "Loading test suites" })).toBeInTheDocument();
        await act(() => vi.advanceTimersByTimeAsync(1));

        expect(screen.queryByRole("status", { name: "Loading test suites" })).toBeNull();
        expect(screen.getByText("Failed to load test suites")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ends a card's spinner after 10 s: 'Failed to load test configurations' with Retry", async () => {
      const { listDefinitions } = serveApi();
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");
      vi.useFakeTimers();
      try {
        listDefinitions.mockImplementation(stalled);
        fireEvent.click(screen.getByRole("button", { name: /zq-smoke-tests/, expanded: false }));
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(within(cardSync("zq-smoke-tests")).getByRole("status", { name: "Loading test configurations" })).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS));

        expect(within(cardSync("zq-smoke-tests")).queryByRole("status")).toBeNull();
        expect(within(cardSync("zq-smoke-tests")).getByText("Failed to load test configurations")).toBeInTheDocument();
        expect(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Retry" })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
      expect(user).toBeDefined();
    });

    it("lets go of a Play all whose definitions read never answers after 10 s: not held, 'Failed to load test configurations', Retry on the card, nothing queued", async () => {
      const { listDefinitions } = serveApi();
      const { queue } = serveRuns();
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      vi.useFakeTimers();
      try {
        listDefinitions.mockImplementation(stalled);
        fireEvent.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));
        await act(() => vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1));
        expect(isHeld()).toBe(true);

        await act(() => vi.advanceTimersByTimeAsync(1));

        expect(isHeld()).toBe(false);
        expect(toastError).toHaveBeenCalledWith("Failed to load test configurations");
        expect(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Retry" })).toBeEnabled();
        expect(queue).not.toHaveBeenCalled();
        suitesShown();
      } finally {
        vi.useRealTimers();
      }
    });

    it("toasts a Play all's refused definitions read in the API's words, its hold released", async () => {
      const { listDefinitions } = serveApi();
      serveRuns();
      listDefinitions.mockRejectedValueOnce(new ApiError("test_suite_not_found", "Test suite not found", { status: 404 }));
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");

      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests serially" }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Test suite not found"));
      await waitFor(() => expect(isHeld()).toBe(false));
    });
  });

  describe("the focus after a Play that queued nothing", () => {
    it("goes to the Tests trigger when every definition of a Play all is refused: its button went with the switch", async () => {
      api.definitions = { [SUITE.id]: [DEFINITION, SECOND_DEFINITION, THIRD_DEFINITION] };
      serveApi();
      const { queue } = serveRuns();
      queue.mockRejectedValue(new ApiError("test_run_queue_full", TEST_RUN_QUEUE_FULL_MESSAGE, { status: 429 }));
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");

      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests in parallel" }));

      await waitFor(() => expect(queue).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(tab("Tests")));
    });

    it.each([
      ["an empty suite", "Play all tests serially", "info"],
      ["a failed definitions read", "Play all tests in parallel", "error"],
    ] as const)("goes back to the Play all pressed after %s", async (_case, button, outcome) => {
      const { listDefinitions } = serveApi();
      serveRuns();
      const toastInfo = vi.spyOn(toast, "info");
      let answer!: (value: { definitions: TestDefinition[] }) => void;
      let fail!: (error: unknown) => void;
      listDefinitions.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            answer = resolve;
            fail = reject;
          }),
      );
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");
      const play = () => within(cardSync("zq-smoke-tests")).getByRole<HTMLButtonElement>("button", { name: button });
      await user.click(play());
      await waitFor(() => expect(answer).toBeDefined());
      dropHeldFocus(play());

      if (outcome === "info") answer({ definitions: [] });
      else fail(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));

      await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
      if (outcome === "info") expect(toastInfo).toHaveBeenCalledWith("This suite has no test configurations yet");
      else expect(toastError).toHaveBeenCalledWith("Failed to load test configurations");
      await waitFor(() => expect(document.activeElement).toBe(play()));
      suitesShown();
    });

    it("goes back to the Run test pressed after its queue request is refused", async () => {
      serveApi();
      const { queue } = serveRuns();
      let refuse!: (error: unknown) => void;
      queue.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      const run = () => within(cardSync("zq-smoke-tests")).getByRole<HTMLButtonElement>("button", { name: "Run test" });
      await user.click(run());
      await waitFor(() => expect(queue).toHaveBeenCalledOnce());
      dropHeldFocus(run());

      refuse(new ApiError("testing_unavailable", "Testing is unavailable right now. Try again later.", { status: 503 }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Testing is unavailable right now. Try again later."));
      await waitFor(() => expect(document.activeElement).toBe(run()));
    });

    it("goes back to the Run test pressed when the question's Run Anyway is refused", async () => {
      serveApi();
      const { queue, head } = serveRuns();
      head.mockResolvedValue(RAW_HEAD);
      queue.mockRejectedValueOnce(new ApiError("test_run_queue_full", TEST_RUN_QUEUE_FULL_MESSAGE, { status: 429 }));
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      const run = () => within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" });
      await user.click(run());

      await user.click(within(await screen.findByRole("dialog", { name: "Fixture may not match the receiver" })).getByRole("button", { name: "Run Anyway" }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(TEST_RUN_QUEUE_FULL_MESSAGE));
      await waitFor(() => expect(document.activeElement).toBe(run()));
      expect(run()).toBeEnabled();
      suitesShown();
    });

    it("leaves the focus where the person has put it since: never pulled back from it", async () => {
      const { listDefinitions } = serveApi();
      serveRuns();
      let answer!: (value: { definitions: TestDefinition[] }) => void;
      listDefinitions.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Play all tests serially" }));
      await waitFor(() => expect(answer).toBeDefined());
      const add = screen.getByRole("button", { name: "Add suite" });
      act(() => add.focus());

      await act(async () => answer({ definitions: [] }));

      await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
      // A render later, the focus is still where the person put it.
      await act(async () => undefined);
      expect(document.activeElement).toBe(add);
    });

    it("goes to the active subtab's trigger when the Play all pressed is still held as it ends (the person's own run, queued elsewhere): a held button counts as gone", async () => {
      const { listDefinitions } = serveApi();
      serveRuns();
      let answer!: (value: { definitions: TestDefinition[] }) => void;
      listDefinitions.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");
      const play = () => within(cardSync("zq-smoke-tests")).getByRole<HTMLButtonElement>("button", { name: "Play all tests serially" });
      await user.click(play());
      await waitFor(() => expect(answer).toBeDefined());
      dropHeldFocus(play());
      // The person's own run, queued from another tab, as the poll reads it: it holds Play past the Play all.
      const own = testRunFixture({ status: "queued", queuedByUserId: MEMBER_ID });
      queuedRuns = [own];
      act(() => useTestingStore.setState({ runsVersionId: VERSION.id, runs: [testRunSummaryOf(own)] }));

      await act(async () => answer({ definitions: [] }));

      await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
      expect(play()).toBeDisabled();
      await waitFor(() => expect(document.activeElement).toBe(tab("Suites")));
      suitesShown();
    });

    it("stays where it fell when the Play all was stopped by a version switch during its definitions read, which answers after: no late jump", async () => {
      const { listDefinitions } = serveApi();
      const { queue } = serveRuns();
      let answer!: (value: { definitions: TestDefinition[] }) => void;
      listDefinitions.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await screen.findByText("zq-smoke-tests");
      const play = () => within(cardSync("zq-smoke-tests")).getByRole<HTMLButtonElement>("button", { name: "Play all tests in parallel" });
      await user.click(play());
      await waitFor(() => expect(answer).toBeDefined());
      dropHeldFocus(play());

      act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION }));
      expect(useTestingStore.getState().playAll).toBeNull();
      await act(async () => answer({ definitions: [DEFINITION] }));
      // Renders later, the read's answer long handled: the focus hasn't moved.
      await act(async () => undefined);
      await act(async () => undefined);

      expect(document.activeElement).toBe(document.body);
      expect(queue).not.toHaveBeenCalled();
      suitesShown();
    });
  });

  describe("a Play one whose version is left mid-read", () => {
    it("queues nothing though its input suits the pipeline: no question asked, the hold released", async () => {
      serveApi();
      const { queue, head } = serveRuns();
      let answer!: (bytes: Uint8Array) => void;
      head.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const { user } = await renderSuites();
      await expand(user, "zq-smoke-tests");
      await user.click(within(cardSync("zq-smoke-tests")).getByRole("button", { name: "Run test" }));
      expect(isHeld()).toBe(true);

      act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION }));
      await act(async () => answer(MATCHING_HEAD));

      await waitFor(() => expect(useTestingStore.getState().starting).toBeNull());
      expect(queue).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      suitesShown();
    });
  });
});
