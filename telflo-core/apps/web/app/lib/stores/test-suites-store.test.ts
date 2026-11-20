import type { TestDefinitionsResponse, TestSuitesResponse } from "@telflo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { GROUP_ID, MINE, VERSION_ID } from "~/test/configurations.js";
import { testDefinitionFixture, testSuiteFixture } from "~/test/test-suites.js";
import {
  DEFINITIONS_LOAD_FAILED_MESSAGE,
  StaleSuitesTargetError,
  SUITES_LOAD_FAILED_MESSAGE,
  useTestSuitesStore,
} from "./test-suites-store.js";

/*
 * The Suites subtab's store: reads, a definitions read under way kept for a
 * later Play all, answers for another version or after signing out dropped,
 * and the edits.
 */

const TARGET = { organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION_ID };
const OTHER = { ...TARGET, versionId: "0199c000-0000-7000-8000-000000000002" };
const SUITE = testSuiteFixture();
const DEFINITION = testDefinitionFixture();

/** A promise and the means to settle it, for an answer the test releases. */
function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const store = () => useTestSuitesStore.getState();

beforeEach(() => {
  vi.restoreAllMocks();
  store().reset();
});

describe("the suites", () => {
  it("are read for a version; another version's read starts from none", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
    vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValue({ definitions: [DEFINITION] });
    await store().loadSuites(TARGET);
    await store().loadDefinitions(TARGET, SUITE.id);
    expect(store()).toMatchObject({ target: TARGET, suites: [SUITE], suitesLoaded: true, definitionsBySuite: { [SUITE.id]: [DEFINITION] } });

    const answer = deferred<TestSuitesResponse>();
    vi.spyOn(apiClient, "getTestSuites").mockReturnValue(answer.promise);
    const reading = store().loadSuites(OTHER);

    expect(store()).toMatchObject({ target: OTHER, suites: [], suitesLoaded: false, suitesLoading: true, definitionsBySuite: {} });
    answer.resolve({ suites: [] });
    await reading;
    expect(store()).toMatchObject({ suites: [], suitesLoaded: true, suitesLoading: false });
  });

  it("drop an answer for a version left since, and an earlier read's answer", async () => {
    const first = deferred<TestSuitesResponse>();
    const second = deferred<TestSuitesResponse>();
    vi.spyOn(apiClient, "getTestSuites").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const stale = store().loadSuites(TARGET);
    const fresh = store().loadSuites(OTHER);

    first.resolve({ suites: [SUITE] });
    await stale;
    expect(store().suites).toEqual([]);
    second.resolve({ suites: [] });
    await fresh;
    expect(store()).toMatchObject({ target: OTHER, suites: [], suitesLoaded: true });
  });

  it("keep a failed read's words: a refusal's own, else 'Failed to load test suites'; a session that ended, none", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockRejectedValueOnce(new ApiError("configuration_not_found", "Configuration not found", { status: 404 }));
    await store().loadSuites(TARGET);
    expect(store().suitesError).toBe("Configuration not found");

    vi.spyOn(apiClient, "getTestSuites").mockRejectedValueOnce(new ApiError("rate_limited", "Too many requests", { status: 429 }));
    await store().loadSuites(TARGET);
    expect(store().suitesError).toBe(SUITES_LOAD_FAILED_MESSAGE);

    vi.spyOn(apiClient, "getTestSuites").mockRejectedValueOnce(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    vi.spyOn(apiClient, "isSessionEnded").mockReturnValue(true);
    await store().loadSuites(TARGET);
    expect(store()).toMatchObject({ suitesError: null, suitesLoading: false });
  });

  it("take created, updated and deleted suites in place; a deleted suite's definitions go", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
    vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValue({ definitions: [DEFINITION] });
    await store().loadSuites(TARGET);
    await store().loadDefinitions(TARGET, SUITE.id);
    const created = testSuiteFixture({ id: "0199f000-0000-7000-8000-000000000002", name: "zq-second" });
    vi.spyOn(apiClient, "createTestSuite").mockResolvedValue({ suite: created });
    vi.spyOn(apiClient, "updateTestSuite").mockResolvedValue({ suite: { ...SUITE, name: "zq-renamed" } });
    const remove = vi.spyOn(apiClient, "deleteTestSuite").mockResolvedValue(undefined);

    await store().createSuite(TARGET, { name: "zq-second", description: "" });
    await store().updateSuite(TARGET, SUITE.id, { name: "zq-renamed", description: SUITE.description });
    expect(store().suites.map((suite) => suite.name)).toEqual(["zq-renamed", "zq-second"]);
    await store().deleteSuite(TARGET, SUITE.id);

    expect(remove).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, SUITE.id);
    expect(store().suites).toEqual([created]);
    expect(store().definitionsBySuite).toEqual({});
  });
});

/** Holds TARGET, as the Suites subtab does by reading its suites, before any definitions are read. */
async function holdTarget() {
  vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
  await store().loadSuites(TARGET);
}

describe("a suite's definitions", () => {
  it("are refused for a version the store doesn't hold, reading nothing and switching nothing (the version shown keeps its suites)", async () => {
    await holdTarget();
    const read = vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValue({ definitions: [DEFINITION] });

    await expect(store().loadDefinitions(OTHER, SUITE.id)).rejects.toBeInstanceOf(StaleSuitesTargetError);

    expect(read).not.toHaveBeenCalled();
    expect(store().target).toEqual(TARGET);
    expect(store().suites).toEqual([SUITE]);
    expect(store().definitionsLoadingBySuite).toEqual({});
    expect(store().definitionsErrorBySuite).toEqual({});
    // Nor before any version is held (signed out).
    store().reset();
    await expect(store().loadDefinitions(TARGET, SUITE.id)).rejects.toBeInstanceOf(StaleSuitesTargetError);
    expect(store().target).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("answer the read under way rather than start another, so a Play all can await it; the next read is fresh", async () => {
    await holdTarget();
    const answer = deferred<TestDefinitionsResponse>();
    const read = vi.spyOn(apiClient, "getTestDefinitions").mockReturnValueOnce(answer.promise);

    const first = store().loadDefinitions(TARGET, SUITE.id);
    const second = store().loadDefinitions(TARGET, SUITE.id);

    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(store().definitionsLoadingBySuite).toEqual({ [SUITE.id]: true });
    answer.resolve({ definitions: [DEFINITION] });
    await expect(second).resolves.toEqual([DEFINITION]);
    expect(store().definitionsLoadingBySuite).toEqual({});

    read.mockResolvedValueOnce({ definitions: [] });
    await expect(store().loadDefinitions(TARGET, SUITE.id)).resolves.toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reject a failed read, keeping its words ('Failed to load test configurations', or a refusal's own) until the next", async () => {
    await holdTarget();
    vi.spyOn(apiClient, "getTestDefinitions").mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    await expect(store().loadDefinitions(TARGET, SUITE.id)).rejects.toBeInstanceOf(ApiError);
    expect(store().definitionsErrorBySuite).toEqual({ [SUITE.id]: DEFINITIONS_LOAD_FAILED_MESSAGE });

    vi.spyOn(apiClient, "getTestDefinitions").mockRejectedValueOnce(new ApiError("test_suite_not_found", "Test suite not found", { status: 404 }));
    await expect(store().loadDefinitions(TARGET, SUITE.id)).rejects.toBeInstanceOf(ApiError);
    expect(store().definitionsErrorBySuite).toEqual({ [SUITE.id]: "Test suite not found" });

    vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValueOnce({ definitions: [] });
    await store().loadDefinitions(TARGET, SUITE.id);
    expect(store().definitionsErrorBySuite).toEqual({});
  });

  it("take a created definition at the end of a read list, and read a list never read; a deleted one goes", async () => {
    const read = vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValue({ definitions: [DEFINITION] });
    const created = testDefinitionFixture({ id: "0199f100-0000-7000-8000-000000000002", name: "zq-second" });
    vi.spyOn(apiClient, "createTestDefinition").mockResolvedValue({ definition: created });
    vi.spyOn(apiClient, "deleteTestDefinition").mockResolvedValue(undefined);
    const request = { inputFileId: "0199d000-0000-7000-8000-000000000001", name: "zq-second", pipeline: "logs", signal: "logs" as const, durationSeconds: 5 };
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
    await store().loadSuites(TARGET);

    await store().createDefinition(TARGET, SUITE.id, request);
    await vi.waitFor(() => expect(store().definitionsBySuite[SUITE.id]).toEqual([DEFINITION]));
    expect(read).toHaveBeenCalledTimes(1);

    await store().createDefinition(TARGET, SUITE.id, request);
    expect(store().definitionsBySuite[SUITE.id]).toEqual([DEFINITION, created]);
    await store().deleteDefinition(TARGET, SUITE.id, DEFINITION.id);
    expect(store().definitionsBySuite[SUITE.id]).toEqual([created]);
  });
});

describe("signing out (reset)", () => {
  it("forgets everything, and an answer to a request made before adds nothing", async () => {
    const suites = deferred<TestSuitesResponse>();
    const definitions = deferred<TestDefinitionsResponse>();
    vi.spyOn(apiClient, "getTestSuites").mockReturnValue(suites.promise);
    vi.spyOn(apiClient, "getTestDefinitions").mockReturnValue(definitions.promise);
    const reading = store().loadSuites(TARGET);
    const readingDefinitions = store().loadDefinitions(TARGET, SUITE.id);

    store().reset();
    suites.resolve({ suites: [SUITE] });
    definitions.resolve({ definitions: [DEFINITION] });
    await reading;
    await readingDefinitions;

    expect(store()).toMatchObject({
      target: null,
      suites: [],
      suitesLoaded: false,
      suitesLoading: false,
      definitionsBySuite: {},
      definitionsLoadingBySuite: {},
    });
  });

  it("drops an edit's answer that arrives after it", async () => {
    const answer = deferred<{ suite: typeof SUITE }>();
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [] });
    vi.spyOn(apiClient, "createTestSuite").mockReturnValue(answer.promise);
    await store().loadSuites(TARGET);
    const creating = store().createSuite(TARGET, { name: "zq-late", description: "" });

    store().reset();
    answer.resolve({ suite: SUITE });
    await creating;

    expect(store().suites).toEqual([]);
  });
});

describe("reads and writes made meanwhile", () => {
  const CREATED = testSuiteFixture({ id: "0199f000-0000-7000-8000-000000000002", name: "zq-created" });
  const NEW_DEFINITION = testDefinitionFixture({ id: "0199f100-0000-7000-8000-000000000002", name: "zq-new" });

  it("drop an earlier read's answer for the same version: the later read's stands", async () => {
    const first = deferred<TestSuitesResponse>();
    const second = deferred<TestSuitesResponse>();
    vi.spyOn(apiClient, "getTestSuites").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const earlier = store().loadSuites(TARGET);
    const later = store().loadSuites(TARGET);

    second.resolve({ suites: [SUITE, CREATED] });
    await later;
    first.resolve({ suites: [SUITE] });
    await earlier;

    expect(store().suites).toEqual([SUITE, CREATED]);
  });

  it("drop a definitions answer from before a sign-out, the same version opened again", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
    await store().loadSuites(TARGET);
    const before = deferred<TestDefinitionsResponse>();
    vi.spyOn(apiClient, "getTestDefinitions").mockReturnValueOnce(before.promise);
    const reading = store().loadDefinitions(TARGET, SUITE.id);

    store().reset();
    await store().loadSuites(TARGET);
    before.resolve({ definitions: [DEFINITION] });
    await reading;

    expect(store().definitionsBySuite).toEqual({});
    expect(store().definitionsLoadingBySuite).toEqual({});
  });

  it("never let a suites read under way overwrite a suite created or deleted meanwhile: its answer is dropped and the list read again", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValueOnce({ suites: [SUITE] });
    await store().loadSuites(TARGET);
    const stale = deferred<TestSuitesResponse>();
    const read = vi.spyOn(apiClient, "getTestSuites").mockReturnValueOnce(stale.promise).mockResolvedValue({ suites: [SUITE, CREATED] });
    vi.spyOn(apiClient, "createTestSuite").mockResolvedValue({ suite: CREATED });
    const reading = store().loadSuites(TARGET);

    await store().createSuite(TARGET, { name: "zq-created", description: "" });
    expect(store().suites).toEqual([SUITE, CREATED]);
    // Its answer was taken before the create.
    stale.resolve({ suites: [SUITE] });
    await reading;

    expect(read).toHaveBeenCalledTimes(2);
    expect(store().suites).toEqual([SUITE, CREATED]);

    // A delete: the stale answer still listing it doesn't bring it back.
    const staleAgain = deferred<TestSuitesResponse>();
    read.mockReturnValueOnce(staleAgain.promise).mockResolvedValue({ suites: [CREATED] });
    vi.spyOn(apiClient, "deleteTestSuite").mockResolvedValue(undefined);
    const readingAgain = store().loadSuites(TARGET);
    await store().deleteSuite(TARGET, SUITE.id);
    staleAgain.resolve({ suites: [SUITE, CREATED] });
    await readingAgain;

    expect(store().suites).toEqual([CREATED]);
  });

  it("never let a definitions read under way overwrite a definition created or deleted meanwhile; a Play all awaiting it gets the fresh list", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
    await store().loadSuites(TARGET);
    const read = vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValueOnce({ definitions: [DEFINITION] });
    await store().loadDefinitions(TARGET, SUITE.id);
    const stale = deferred<TestDefinitionsResponse>();
    read.mockReturnValueOnce(stale.promise).mockResolvedValue({ definitions: [DEFINITION, NEW_DEFINITION] });
    vi.spyOn(apiClient, "createTestDefinition").mockResolvedValue({ definition: NEW_DEFINITION });
    const request = { inputFileId: "0199d000-0000-7000-8000-000000000001", name: "zq-new", pipeline: "logs", signal: "logs" as const, durationSeconds: 5 };
    const reading = store().loadDefinitions(TARGET, SUITE.id);

    await store().createDefinition(TARGET, SUITE.id, request);
    stale.resolve({ definitions: [DEFINITION] });

    await expect(reading).resolves.toEqual([DEFINITION, NEW_DEFINITION]);
    expect(store().definitionsBySuite[SUITE.id]).toEqual([DEFINITION, NEW_DEFINITION]);

    const staleAgain = deferred<TestDefinitionsResponse>();
    read.mockReturnValueOnce(staleAgain.promise).mockResolvedValue({ definitions: [NEW_DEFINITION] });
    vi.spyOn(apiClient, "deleteTestDefinition").mockResolvedValue(undefined);
    const readingAgain = store().loadDefinitions(TARGET, SUITE.id);
    await store().deleteDefinition(TARGET, SUITE.id, DEFINITION.id);
    staleAgain.resolve({ definitions: [DEFINITION, NEW_DEFINITION] });
    await readingAgain;

    expect(store().definitionsBySuite[SUITE.id]).toEqual([NEW_DEFINITION]);
  });

  it("read the suites again after a create while they aren't shown (the first read failed), so the new one shows", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    await store().loadSuites(TARGET);
    expect(store().suitesLoaded).toBe(false);
    const read = vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [CREATED] });
    vi.spyOn(apiClient, "createTestSuite").mockResolvedValue({ suite: CREATED });

    await store().createSuite(TARGET, { name: "zq-created", description: "" });

    await vi.waitFor(() => expect(store()).toMatchObject({ suites: [CREATED], suitesLoaded: true, suitesError: null }));
    expect(read).toHaveBeenCalledOnce();
  });

  it("drop a suite or definition the API says is gone (404) on delete, and still reject with its words", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE, CREATED] });
    vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValue({ definitions: [DEFINITION] });
    await store().loadSuites(TARGET);
    await store().loadDefinitions(TARGET, CREATED.id);
    vi.spyOn(apiClient, "deleteTestDefinition").mockRejectedValue(new ApiError("test_definition_not_found", "Test configuration not found", { status: 404 }));
    vi.spyOn(apiClient, "deleteTestSuite").mockRejectedValueOnce(new ApiError("test_suite_not_found", "Test suite not found", { status: 404 }));

    await expect(store().deleteDefinition(TARGET, CREATED.id, DEFINITION.id)).rejects.toThrow("Test configuration not found");
    expect(store().definitionsBySuite[CREATED.id]).toEqual([]);
    await expect(store().deleteSuite(TARGET, SUITE.id)).rejects.toThrow("Test suite not found");
    expect(store().suites).toEqual([CREATED]);

    // Any other refusal leaves it.
    vi.spyOn(apiClient, "deleteTestSuite").mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    await expect(store().deleteSuite(TARGET, CREATED.id)).rejects.toThrow();
    expect(store().suites).toEqual([CREATED]);
  });
});
