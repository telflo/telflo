import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { renderHook } from "@testing-library/react";
import type * as ReactRouter from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Logout with a read still in flight (D12 Ruling 33). The client is the real
 * one, its session-ended handler the real default (goToLogin's hard load of
 * `/login?redirectTo=…`), with axios answering through a fake API (as
 * api-client.test.ts does). Each test holds a read in flight, logs out, and
 * only then lets the read's 401 arrive: a stray answer from the session that
 * Logout ended, which must leave the browser on Logout's `/login`, its toast
 * shown, and not hard-load `/login?redirectTo=…` over it.
 */

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => navigate,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
// PostHog's reset, watched at the analytics module's boundary; the mock outlives resetModules.
const analytics = vi.hoisted(() => ({ signedOutLocally: vi.fn() }));
vi.mock("~/lib/analytics.js", () => analytics);

type Reply = { status: number; body?: unknown };
type Route = () => Reply | Promise<Reply>;

let routes: Record<string, Route> = {};

const ME = "GET /api/v1/auth/me";
const LOGOUT = "DELETE /api/v1/auth/sessions/current";
const REFRESH = "POST /api/v1/auth/refresh";
const SIGN_IN = "POST /api/v1/auth/sessions";
const FLOWS = "GET /api/v1/flows";

const UNAUTHENTICATED: Reply = { status: 401, body: { error: { code: "unauthenticated", message: "You need to sign in." } } };
const EXPIRED: Reply = { status: 401, body: { error: { code: "access_token_expired", message: "Your access token has expired." } } };
const SERVER_ERROR: Reply = { status: 500, body: { error: { code: "internal_error", message: "Something went wrong." } } };

/** A fresh client and hook, with axios answering through `routes`. */
async function load() {
  vi.resetModules();
  const { default: axios, AxiosError, AxiosHeaders } = await import("axios");
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const key = `${(config.method ?? "get").toUpperCase()} ${config.baseURL ?? ""}${config.url ?? ""}`;
    const route = routes[key];
    const reply = route ? await route() : { status: 404, body: { error: { code: "not_found", message: key } } };
    const response = {
      data: reply.body === undefined ? "" : JSON.stringify(reply.body),
      status: reply.status,
      statusText: "",
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
      request: {},
    };
    if (config.validateStatus ? config.validateStatus(reply.status) : true) return response;
    throw new AxiosError(`Request failed with status code ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response);
  };
  axios.defaults.adapter = adapter;
  const client = await import("./api-client.js");
  const { LOGOUT_RELEASE_HANG_GUARD_MS, useLogout } = await import("./use-logout.js");
  return { client, logout: renderHook(() => useLogout()).result.current, hangGuardMs: LOGOUT_RELEASE_HANG_GUARD_MS };
}

/** A reply the test sends when it chooses. */
function held(): { route: Route; answer: (reply: Reply) => void; reached: Promise<void> } {
  let answer!: (reply: Reply) => void;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const reply = new Promise<Reply>((resolve) => {
    answer = resolve;
  });
  return {
    route: () => {
      arrived();
      return reply;
    },
    answer,
    reached,
  };
}

let assign: ReturnType<typeof vi.fn>;

/** Called exactly once, with exactly these arguments. */
function expectOnce(mock: ReturnType<typeof vi.fn>, ...args: unknown[]): void {
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock).toHaveBeenCalledWith(...args);
}

beforeEach(() => {
  routes = {};
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  analytics.signedOutLocally.mockReset();
  assign = vi.fn();
  vi.stubGlobal("location", { pathname: "/app", search: "", assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The handler is armed again: a request that fails with 401 now (a session
 * that ends later, after signing in again) goes to `/login?redirectTo=…`.
 * Polled, since the release follows the stray read's settling.
 */
async function expectHandlerArmedAgain(client: Awaited<ReturnType<typeof load>>["client"]): Promise<void> {
  routes[ME] = () => UNAUTHENTICATED;
  await vi.waitFor(async () => {
    await client.getCurrentUser().catch(() => undefined);
    expect(assign).toHaveBeenCalledWith("/login?redirectTo=" + encodeURIComponent("/app"));
  });
}

describe("useLogout with a read in flight (D12 Ruling 33)", () => {
  it("a stray 401 unauthenticated answering after the DELETE leaves Logout's /login and toast: no hard load to /login?redirectTo", async () => {
    const read = held();
    routes[ME] = read.route;
    routes[LOGOUT] = () => ({ status: 204 });
    const { client, logout } = await load();

    const stray = client.getCurrentUser();
    await read.reached;
    expect(await logout()).toBe(true);
    read.answer(UNAUTHENTICATED);
    await expect(stray).rejects.toMatchObject({ code: "unauthenticated" });

    expectOnce(navigate, "/login");
    expectOnce(toast.success, "Logged out successfully");
    expect(assign).not.toHaveBeenCalled();
    await expectHandlerArmedAgain(client);
  });

  it("a stray access_token_expired whose refresh is refused after the DELETE leaves Logout's /login too", async () => {
    const read = held();
    routes[ME] = read.route;
    routes[REFRESH] = () => UNAUTHENTICATED;
    routes[LOGOUT] = () => ({ status: 204 });
    const { client, logout } = await load();

    const stray = client.getCurrentUser();
    await read.reached;
    expect(await logout()).toBe(true);
    read.answer(EXPIRED);
    await expect(stray).rejects.toMatchObject({ code: "unauthenticated" });

    expectOnce(navigate, "/login");
    expectOnce(toast.success, "Logged out successfully");
    expect(assign).not.toHaveBeenCalled();
    await expectHandlerArmedAgain(client);
  });

  it("with nothing in flight, logs out as before, and a later ended session goes to /login?redirectTo", async () => {
    routes[LOGOUT] = () => ({ status: 204 });
    const { client, logout } = await load();
    // A staged playground edit: signing out removes it (Q211, Ruling 317).
    window.localStorage.setItem("telflo-playground-staged-edit", JSON.stringify({ version: 1 }));

    expect(await logout()).toBe(true);
    expect(window.localStorage.getItem("telflo-playground-staged-edit") !== null).toBe(false);

    expectOnce(navigate, "/login");
    expectOnce(toast.success, "Logged out successfully");
    expect(analytics.signedOutLocally).toHaveBeenCalled();
    await expectHandlerArmedAgain(client);
  });

  it("forgets the Testing tab's files, heads, selection and runs (D14a Ruling 44; ADR 0024)", async () => {
    routes[LOGOUT] = () => ({ status: 204 });
    const { logout } = await load();
    // The module instance the hook resets (load() reset the registry, then imported it).
    const { useTestingStore } = await import("./stores/testing-store.js");
    const { testFileFixture, testRunFixture } = await import("~/test/test-runs.js");
    const file = testFileFixture();
    const run = testRunFixture();
    useTestingStore.setState({
      filesOrganizationId: "0190a8b0-0000-7000-8000-0000000000aa",
      files: [file],
      filesLoaded: true,
      selectedFile: { id: file.id, displayName: file.displayName },
      selectedPipelineName: "logs",
      heads: { [file.id]: new Uint8Array([0x7b, 0x7d]) },
      runsVersionId: run.versionId,
      runs: [run],
      runsLoaded: true,
      selectedRunId: run.id,
      runDetails: { [run.id]: run },
    });

    expect(await logout()).toBe(true);

    expect(useTestingStore.getState()).toMatchObject({
      filesOrganizationId: null,
      files: [],
      filesLoaded: false,
      selectedFile: null,
      selectedPipelineName: null,
      heads: {},
      runsVersionId: null,
      runs: [],
      runsLoaded: false,
      selectedRunId: null,
      runDetails: {},
    });
  });

  it("forgets the Suites subtab's suites and definitions, their names and descriptions (D14b; ADR 0024)", async () => {
    routes[LOGOUT] = () => ({ status: 204 });
    const { logout } = await load();
    // The module instance the hook resets (load() reset the registry, then imported it).
    const { useTestSuitesStore } = await import("./stores/test-suites-store.js");
    const { testSuiteFixture, testDefinitionFixture } = await import("~/test/test-suites.js");
    const suite = testSuiteFixture();
    const definition = testDefinitionFixture();
    useTestSuitesStore.setState({
      target: { organizationId: "0190a8b0-0000-7000-8000-0000000000aa", configurationId: suite.configurationId, versionId: suite.versionId },
      suites: [suite],
      suitesLoaded: true,
      suitesError: "Failed to load test suites",
      definitionsBySuite: { [suite.id]: [definition] },
      definitionsErrorBySuite: { [suite.id]: "Failed to load test configurations" },
    });

    expect(await logout()).toBe(true);

    expect(useTestSuitesStore.getState()).toMatchObject({
      target: null,
      suites: [],
      suitesLoaded: false,
      suitesError: null,
      definitionsBySuite: {},
      definitionsLoadingBySuite: {},
      definitionsErrorBySuite: {},
    });
  });

  it("forgets the Validation subtab's pipelines and rules, their names and text (D15a; ADR 0024)", async () => {
    routes[LOGOUT] = () => ({ status: 204 });
    const { logout } = await load();
    // The module instance the hook resets (load() reset the registry, then imported it).
    const { useValidationPipelinesStore } = await import("./stores/validation-pipelines-store.js");
    const { validationPipelineFixture, validationRuleFixture } = await import("~/test/validation-pipelines.js");
    const pipeline = validationPipelineFixture();
    const rule = validationRuleFixture();
    useValidationPipelinesStore.setState({
      target: { organizationId: "0190a8b0-0000-7000-8000-0000000000aa", configurationId: pipeline.configurationId, versionId: pipeline.versionId },
      pipelines: [pipeline],
      pipelinesLoaded: true,
      pipelinesError: "Failed to load validation pipelines",
      rulesByPipeline: { [pipeline.id]: [rule] },
      rulesErrorByPipeline: { [pipeline.id]: "Failed to load validation rules" },
    });

    expect(await logout()).toBe(true);

    expect(useValidationPipelinesStore.getState()).toMatchObject({
      target: null,
      pipelines: [],
      pipelinesLoaded: false,
      pipelinesError: null,
      rulesByPipeline: {},
      rulesLoadingByPipeline: {},
      rulesErrorByPipeline: {},
    });
  });

  it("forgets the organization's variables' names (D20; Q88), and a read of them in flight at the logout lands nowhere", async () => {
    const organizationId = "0190a8b0-0000-7000-8000-0000000000aa";
    const names = held();
    routes[`GET /api/v1/organizations/${organizationId}/variables`] = names.route;
    routes[LOGOUT] = () => ({ status: 204 });
    const { logout } = await load();
    // The module instance the hook resets (load() reset the registry, then imported it).
    const { ensureOrgVariableNames, orgVariableNamesNow, seedOrgVariableNames } = await import("./org-variables.js");
    const variable = {
      id: "0190a8b0-0000-7000-8000-0000000000bb",
      name: "OTLP_EP",
      value: "value-canary",
      description: "The gateway",
      changedBy: null,
      changedAt: "2026-10-20T10:00:00.000Z",
    };
    seedOrgVariableNames(organizationId, [variable]);
    expect(orgVariableNamesNow().names).toHaveLength(1);
    // A picker opening a minute on reads them again: that read is in flight when the person logs out.
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    ensureOrgVariableNames(organizationId, { opening: true });
    later.mockRestore();
    await names.reached;

    expect(await logout()).toBe(true);
    expect(orgVariableNamesNow()).toEqual({ organizationId: null, status: "idle", names: [] });

    names.answer({ status: 200, body: { variables: [variable] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(orgVariableNamesNow()).toEqual({ organizationId: null, status: "idle", names: [] });
  });

  it("forgets the variable groups' names (D20 default 25; Q88), and a read of them in flight at the logout lands nowhere", async () => {
    const organizationId = "0190a8b0-0000-7000-8000-0000000000aa";
    const known = "0190a8b0-0000-7000-8000-0000000000c1";
    const unknown = "0190a8b0-0000-7000-8000-0000000000c2";
    const groups = held();
    routes[`GET /api/v1/organizations/${organizationId}/variable-groups`] = groups.route;
    routes[LOGOUT] = () => ({ status: 204 });
    const { logout } = await load();
    // The module instance the hook resets (load() reset the registry, then imported it).
    const { ensureVariableGroupNames, seedVariableGroupNames, variableGroupNamesNow } = await import("./variable-group-display.js");
    seedVariableGroupNames(organizationId, [{ id: known, name: "canary-variable-group" }]);
    expect(variableGroupNamesNow().names.get(known)).toBe("canary-variable-group");
    // A row naming one the names don't hold, a minute on, reads them again: that read is in flight when the person logs out.
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    ensureVariableGroupNames(organizationId, [unknown]);
    later.mockRestore();
    await groups.reached;

    expect(await logout()).toBe(true);
    expect(variableGroupNamesNow()).toEqual({ organizationId: null, status: "idle", names: new Map() });

    const variableGroup = {
      id: unknown,
      name: "late-canary-variable-group",
      description: null,
      overrideCount: 0,
      usage: { collectorGroups: 0, pinnedCollectors: 0 },
      changedBy: null,
      changedAt: "2026-10-20T10:00:00.000Z",
    };
    groups.answer({ status: 200, body: { variableGroups: [variableGroup] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(variableGroupNamesNow()).toEqual({ organizationId: null, status: "idle", names: new Map() });
  });

  it("a failed DELETE keeps the session and says so, and the handler is armed again at once (D2a Parity Notes)", async () => {
    routes[LOGOUT] = () => SERVER_ERROR;
    const { client, logout } = await load();

    expect(await logout()).toBe(false);

    expect(navigate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // The session is still there, so a 401 now is a session that ended: the handler's, as before.
    routes[ME] = () => UNAUTHENTICATED;
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expectOnce(assign, "/login?redirectTo=" + encodeURIComponent("/app"));
  });
});

describe("Logout's hang guard (D12 Ruling 39)", () => {
  // Only the guard's timer is faked: nothing else here waits on one, and
  // expect.poll keeps the real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is 30 s", async () => {
    const { hangGuardMs } = await load();
    expect(hangGuardMs).toBe(30_000);
  });

  it("a read that never answers holds the handler only until the guard: signed in again, a session that then ends goes to /login?redirectTo", async () => {
    const hung = held();
    routes[FLOWS] = hung.route;
    routes[LOGOUT] = () => ({ status: 204 });
    routes[SIGN_IN] = () => ({ status: 200, body: { user: { id: "0190a8b0-0000-7000-8000-0000000000bb", email: "member@example.com" } } });
    const { client, logout, hangGuardMs } = await load();

    void client.getFlows().catch(() => undefined);
    await hung.reached;
    expect(await logout()).toBe(true);
    expectOnce(navigate, "/login");

    // Signing in again in the same tab (the form navigates client-side), and
    // that session ending later (revoked elsewhere): a 401 unauthenticated.
    await client.createSession({ email: "member@example.com", password: "correct horse battery staple" });
    routes[ME] = () => UNAUTHENTICATED;
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    // The hung read still has the handler suspended...
    expect(assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(hangGuardMs - 1);
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(assign).not.toHaveBeenCalled();

    // ...until the guard: the handler is armed, and the next 401 goes to sign in.
    await vi.advanceTimersByTimeAsync(1);
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expectOnce(assign, "/login?redirectTo=" + encodeURIComponent("/app"));
  });

  it("requests that settle first release the handler then, and the guard's timer goes with them", async () => {
    const read = held();
    routes[ME] = read.route;
    routes[LOGOUT] = () => ({ status: 204 });
    const { client, logout } = await load();

    const stray = client.getCurrentUser();
    await read.reached;
    expect(await logout()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    read.answer(UNAUTHENTICATED);
    await expect(stray).rejects.toMatchObject({ code: "unauthenticated" });
    expect(assign).not.toHaveBeenCalled();

    await expect.poll(() => vi.getTimerCount()).toBe(0);
    // Released with no time passed: a 401 now goes to sign in.
    routes[ME] = () => UNAUTHENTICATED;
    await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "unauthenticated" });
    expectOnce(assign, "/login?redirectTo=" + encodeURIComponent("/app"));
  });
});
