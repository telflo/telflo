import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE,
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  COLLECTOR_GROUP_UNASSIGNED_MESSAGE,
  collectorVersionNotOfferedMessage,
  FLEET_ERROR_CODES,
  FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE,
  FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
  FLEETS_UNAVAILABLE_MESSAGE,
  INSTALL_UNAVAILABLE_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  VARIABLE_ERROR_CODES,
  type FleetDetail,
  type FleetsPage,
} from "@telflo/contracts";
import type * as ReactRouter from "react-router";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED, type FleetsQuery } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { FLEET_ID, fleetDetail, fleetsPage, manyFleets } from "~/test/fleets.js";
import {
  FLEET_LOAD_FAILED_MESSAGE,
  FLEET_READ_TIMEOUT_MS,
  FLEET_REFUSAL_CODES,
  FLEET_WRITE_TIMEOUT_MS,
  FLEETS_LOAD_FAILED_MESSAGE,
  FLEETS_POLL_INTERVAL_MS,
  bundleFieldOf,
  bundleFieldProblemsOf,
  fieldProblemsOf,
  fleetFieldProblemsOf,
  fleetRefusalMessage,
  isFleetRefusal,
  isStaleCursor,
  isUnknownOutcome,
  useFleet,
  useFleetsList,
} from "./fleets.js";

// The hooks outside a router: the layout's data as each test sets it (for
// the terms), and a revalidate that stays the same function, as the
// router's does.
const router = vi.hoisted(() => ({
  revalidate: vi.fn(() => Promise.resolve()),
  layoutData: undefined as unknown,
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useRouteLoaderData: () => router.layoutData,
  useRevalidator: () => ({ revalidate: router.revalidate, state: "idle" }),
}));

const FALLBACK = "Failed to create fleet";

const RATE_LIMITED_MESSAGE = "Too many attempts. Please wait and try again.";

function refusal(code: string, message: string, options: { status?: number; retryAfterSeconds?: number; details?: unknown } = {}) {
  return new ApiError(code, message, options);
}

const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
const NO_CONNECTION = () => new ApiError("network_error", "Could not reach the server. Check your connection.");
const ORGANIZATION_GONE = () => refusal("organization_not_found", "Organization not found", { status: 404 });
const TERMS = () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", { status: 403 });
const SESSION_ENDED = () => refusal("unauthenticated", "You need to sign in.", { status: 401 });
const FLEET_GONE = () => refusal("fleet_not_found", "Fleet not found.", { status: 404 });
const RATE_LIMITED = (retryAfterSeconds: number) =>
  refusal("rate_limited", RATE_LIMITED_MESSAGE, { status: 429, retryAfterSeconds });

describe("fleetRefusalMessage (D17a decisions 13 and 28, Preflight ruling 15; D17b-1 decision 16)", () => {
  it("allows the fleets' codes, the quick-deploy links', the organization's, the person's fleet limits, the pin's two configuration codes and D20's two variables codes, and nothing else", () => {
    expect([...FLEET_REFUSAL_CODES].sort()).toEqual(
      [
        ...FLEET_ERROR_CODES,
        "quick_deploy_link_not_found",
        "quick_deploy_link_revoked",
        "quick_deploy_link_limit_reached",
        "enrollment_token_default_missing",
        "collector_group_variables_changed",
        "public_install_links_disabled",
        "organization_not_found",
        "rate_limited",
        "configuration_version_not_found",
        "configuration_not_found",
        "variable_group_not_found",
        "variables_undefined",
      ].sort(),
    );
  });

  it("takes D20's two codes from the contracts' VARIABLE_ERROR_CODES, and no other variables code (Preflight ruling 39)", () => {
    const variables = FLEET_REFUSAL_CODES.filter((code) => (VARIABLE_ERROR_CODES as readonly string[]).includes(code));
    expect(variables.sort()).toEqual(["variable_group_not_found", "variables_undefined"]);
    // The variables routes' 503 is theirs: a fleet route answers fleets_unavailable.
    expect(FLEET_REFUSAL_CODES).not.toContain("variables_unavailable");
  });

  it.each([
    ["fleet_not_found", "Fleet not found."],
    ["fleet_label_taken", "Another of the organization's fleets has this label."],
    ["fleet_conflict", "A different fleet already has this id."],
    ["fleet_archived", "This fleet is archived."],
    ["enrollment_token_expired", "This enrollment token has expired."],
    ["fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE],
    ["organization_not_found", "Organization not found"],
    ["rate_limited", RATE_LIMITED_MESSAGE],
    ["collector_name_taken", "Another of the organization's collectors has this name."],
    ["configuration_version_not_found", "Configuration version not found"],
    ["configuration_not_found", "Configuration not found"],
    ["variable_group_not_found", "Variable group not found"],
    ["variables_undefined", "The published version references organization variables that aren't defined: define them first."],
  ])("shows the API's message for the refusal %s", (code, message) => {
    const error = refusal(code, message);
    expect(isFleetRefusal(error)).toBe(true);
    expect(fleetRefusalMessage(error, FALLBACK)).toBe(message);
  });

  it.each([
    ["invalid_request", "The request was not valid."],
    ["terms_acceptance_required", "Accept the current Terms of Service to continue."],
    ["internal_error", "Something went wrong. Please try again."],
    ["unexpected_response", "The server returned an unexpected response."],
    ["network_error", "Could not reach the server. Check your connection."],
    [REQUEST_ABORTED, "The request was cancelled."],
    ["configuration_version_published", "This version is already published."],
  ])("shows the fallback for %s", (code, message) => {
    const error = refusal(code, message);
    expect(isFleetRefusal(error)).toBe(false);
    expect(fleetRefusalMessage(error, FALLBACK)).toBe(FALLBACK);
  });

  // D17c-1 decision 47: the install's refusals and the new default token's, through the contracts' FLEET_ERROR_CODES.
  it.each([
    ["install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, 503],
    ["collector_group_unassigned", COLLECTOR_GROUP_UNASSIGNED_MESSAGE, 409],
    ["collector_version_not_offered", collectorVersionNotOfferedMessage("0.150.0"), 409],
    ["collector_group_assignment_deleted", COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE, 409],
    ["fleet_type_not_installable", FLEET_TYPE_NOT_INSTALLABLE_MESSAGE, 409],
    // D17d-2 decision 27: a Kubernetes group's settings the platform can't read, and the Helm direction's words.
    ["collector_group_settings_unreadable", COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE, 409],
    ["fleet_type_not_installable", FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE, 409],
    ["enrollment_token_default_exists", "The fleet already has a valid default token.", 409],
  ])("allows D17c-1's %s, showing its own words", (code, message, status) => {
    expect(FLEET_REFUSAL_CODES).toContain(code);
    expect(isFleetRefusal(refusal(code, message, { status }))).toBe(true);
    expect(fleetRefusalMessage(refusal(code, message, { status }), FALLBACK)).toBe(message);
  });

  // D17c-2 decision 33, Preflight ruling 15: the quick-deploy links' refusals, through the contracts' QUICK_DEPLOY_LINK_ERROR_CODES.
  it.each([
    ["quick_deploy_link_not_found", "Install link not found.", 404],
    ["quick_deploy_link_revoked", "This install link is revoked: make a new one.", 409],
    ["quick_deploy_link_limit_reached", "Revoke an install link first: a fleet holds at most 100 active links.", 409],
    ["enrollment_token_default_missing", "The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.", 409],
    [
      "collector_group_variables_changed",
      "This group's published version no longer reads the variables this link was made with: make a new link.",
      409,
    ],
    // D17d-2 decision 27: the organization's switch off.
    [
      "public_install_links_disabled",
      "Public install links are turned off for this organization: an admin can turn them on in Settings → Organization.",
      409,
    ],
  ] as const)("allows D17c-2's %s, showing its own words", (code, message, status) => {
    expect(QUICK_DEPLOY_LINK_ERROR_MESSAGES[code]).toBe(message);
    expect(FLEET_REFUSAL_CODES).toContain(code);
    expect(isFleetRefusal(refusal(code, message, { status }))).toBe(true);
    expect(fleetRefusalMessage(refusal(code, message, { status }), FALLBACK)).toBe(message);
  });

  it("shows the fallback for anything that isn't an ApiError", () => {
    expect(fleetRefusalMessage(new Error("fleet_not_found"), FALLBACK)).toBe(FALLBACK);
    expect(fleetRefusalMessage("fleet_label_taken", FALLBACK)).toBe(FALLBACK);
  });
});

describe("isUnknownOutcome (Preflight ruling 13)", () => {
  it.each([
    ["a 503 fleets_unavailable", UNAVAILABLE()],
    ["a 500", refusal("internal_error", "Something went wrong.", { status: 500 })],
    ["a 502 whose body isn't an envelope", new ApiError("unexpected_response", "The server returned an unexpected error.", { status: 502 })],
    ["a 201 that doesn't parse", new ApiError("unexpected_response", "The server returned an unexpected response.")],
    ["no connection", NO_CONNECTION()],
    ["the hang guard's abort", new ApiError(REQUEST_ABORTED, "The request was cancelled.")],
    ["something that isn't an ApiError", new Error("boom")],
  ])("is unknown for %s", (_name, error) => {
    expect(isUnknownOutcome(error)).toBe(true);
  });

  it.each([
    ["a 429", RATE_LIMITED(30)],
    ["a 409 fleet_label_taken", refusal("fleet_label_taken", "Taken.", { status: 409 })],
    ["a 409 fleet_conflict", refusal("fleet_conflict", "Conflict.", { status: 409 })],
    ["a 400 invalid_request", refusal("invalid_request", "The request was not valid.", { status: 400 })],
    ["a 403 terms_acceptance_required", TERMS()],
    ["a 404 organization_not_found", ORGANIZATION_GONE()],
    ["a 401", SESSION_ENDED()],
    // D17c-1 Preflight ruling 27: checked before the 5xx rule; the templates couldn't be read, nothing was rendered.
    ["a 503 install_unavailable", refusal("install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, { status: 503 })],
  ])("is known for %s: the API made nothing this time", (_name, error) => {
    expect(isUnknownOutcome(error)).toBe(false);
  });
});

describe("fieldProblemsOf (D17c-1 Preflight ruling 27)", () => {
  const invalid = (details: unknown) => refusal("invalid_request", "The request was not valid.", { status: 400, details });
  /** The install dialog's mapper: a variable's value by its index, the paths by name. */
  const installKey = (path: string): string | undefined => {
    const variable = /^env\.(\d+)\.(?:value|name)$/.exec(path);
    if (variable !== null) return `env.${variable[1]}`;
    return path === "rootPath" || path === "executablePath" ? path : undefined;
  };
  /** The group dialog's mapper: a mount's field by its index and field. */
  const mountKey = (path: string): string | undefined => {
    const mount = /^annotations\.telflo\.dockerMounts\.(\d+)\.(hostPath|containerPath|readOnly)$/.exec(path);
    return mount === null ? (path === "annotations" ? "annotations" : undefined) : `${mount[1]}.${mount[2]}`;
  };

  it("keys each detail by the caller's mapping of its path, as a Zod issue's path or the platform's detail gives it", () => {
    expect(
      fieldProblemsOf(
        invalid([
          { path: ["env", 1, "value"], message: "Use no control characters (a line break or a tab, say)." },
          {
            keyword: "custom",
            instancePath: "/rootPath",
            params: { issue: { code: "custom", path: ["rootPath"], message: "Use no . or .. segment." } },
            message: "Use no . or .. segment.",
          },
          { instancePath: "/env/0/name", message: "Not a variable this group's published version reads." },
        ]),
        installKey,
      ),
    ).toEqual({
      "env.1": "Use no control characters (a line break or a tab, say).",
      rootPath: "Use no . or .. segment.",
      "env.0": "Not a variable this group's published version reads.",
    });
    expect(
      fieldProblemsOf(
        invalid([
          { path: ["annotations", "telflo", "dockerMounts", 0, "containerPath"], message: "Each container path once." },
          { path: ["annotations", "telflo", "dockerMounts", 2, "hostPath"], message: "Use an absolute path, starting with /." },
          { path: ["annotations"], message: "annotations must be a JSON object of at most 16384 bytes, or null." },
        ]),
        mountKey,
      ),
    ).toEqual({
      "0.containerPath": "Each container path once.",
      "2.hostPath": "Use an absolute path, starting with /.",
      annotations: "annotations must be a JSON object of at most 16384 bytes, or null.",
    });
  });

  it("keeps the first detail on a key, skips paths the mapping leaves out and details without words", () => {
    expect(
      fieldProblemsOf(
        invalid([
          { path: ["env", 0, "value"], message: "Type a value or untick it." },
          { path: ["env", 0, "name"], message: "Each variable once." },
          { path: ["method"], message: "Invalid enum value." },
          { path: ["rootPath"] },
          { message: "The request was not valid." },
        ]),
        installKey,
      ),
    ).toEqual({ "env.0": "Type a value or untick it." });
  });

  it("keys a detail by a key that is an Object.prototype name (a variable's name is configuration text): never an inherited one", () => {
    const byName = (path: string) => /^env\.(.+)$/.exec(path)?.[1];
    const problems = fieldProblemsOf(
      invalid([
        { path: ["env", "constructor"], message: "first" },
        { path: ["env", "__proto__"], message: "second" },
        { path: ["env", "toString"], message: "third" },
        { path: ["env", "toString"], message: "a later one, dropped" },
      ]),
      byName,
    );
    expect(Object.entries(problems)).toEqual([
      ["constructor", "first"],
      ["__proto__", "second"],
      ["toString", "third"],
    ]);
    expect(problems.hasOwnProperty).toBeUndefined();
  });

  it("is empty for any other refusal or failure", () => {
    const details = [{ path: ["rootPath"], message: "x" }];
    expect(fieldProblemsOf(refusal("install_unavailable", INSTALL_UNAVAILABLE_MESSAGE, { status: 503, details }), installKey)).toEqual({});
    expect(fieldProblemsOf(invalid(undefined), installKey)).toEqual({});
    expect(fieldProblemsOf(new Error("invalid_request"), installKey)).toEqual({});
  });
});

describe("bundleFieldOf and bundleFieldProblemsOf (D17c-2 decision 33, Preflight ruling 18)", () => {
  const invalid = (details: unknown) => refusal("invalid_request", "The request was not valid.", { status: 400, details });
  /** A quick-deploy link's create, as the Linux form sends it. */
  const request = {
    method: "own-binary",
    arch: "amd64",
    rootPath: "/etc/otelcol",
    executablePath: "/usr/bin/otelcol-contrib",
    env: [{ name: "NGINX_ENV", value: "a" }, { name: "constructor", value: "b" }],
    systemd: true,
  } as const;

  it.each([
    ["rootPath", "rootPath"],
    ["executablePath", "executablePath"],
    ["env.0.value", "env:NGINX_ENV"],
    ["env.0.name", "env:NGINX_ENV"],
    ["env.1.value", "env:constructor"],
    ["env.2.value", undefined],
    ["env.0", undefined],
    ["env.x.value", undefined],
    ["env.0.value.extra", undefined],
    ["systemd", undefined],
    ["method", undefined],
    ["arch", undefined],
    ["", undefined],
  ])("maps %j to %j", (path, field) => {
    expect(bundleFieldOf(path, request)).toBe(field);
  });

  it("keys a create's 400 details by the form's fields, a variable by its name, never an inherited key", () => {
    const problems = bundleFieldProblemsOf(
      invalid([
        { path: ["rootPath"], message: "Use no . or .. segment." },
        { path: ["executablePath"], message: "Use an absolute path, starting with /." },
        { path: ["env", 1, "name"], message: "Not a variable this group's published version reads." },
        { path: ["env", 0, "value"], message: "Use no control characters (a line break or a tab, say)." },
        { path: ["systemd"], message: "Expected boolean, received string" },
      ]),
      request,
    );
    expect(Object.entries(problems)).toEqual([
      ["rootPath", "Use no . or .. segment."],
      ["executablePath", "Use an absolute path, starting with /."],
      ["env:constructor", "Not a variable this group's published version reads."],
      ["env:NGINX_ENV", "Use no control characters (a line break or a tab, say)."],
    ]);
    expect(Object.getPrototypeOf(problems)).toBeNull();
  });

  it("is empty for any other refusal", () => {
    const details = [{ path: ["rootPath"], message: "x" }];
    expect(bundleFieldProblemsOf(refusal("quick_deploy_link_limit_reached", "Limit.", { status: 409, details }), request)).toEqual({});
    expect(bundleFieldProblemsOf(new Error("invalid_request"), request)).toEqual({});
  });
});

describe("fleetFieldProblemsOf (Preflight ruling 15)", () => {
  /** A detail as the platform's fleet routes and the contract's 400s write one. */
  const detail = (field: string, message: string) => ({
    keyword: "custom",
    instancePath: `/${field}`,
    schemaPath: `#/${field}/custom`,
    params: { issue: { code: "custom", path: [field], message } },
    message,
  });
  const invalid = (details: unknown) => refusal("invalid_request", "The request was not valid.", { status: 400, details });

  it("maps label to the Name and rotateExpiresAt to the Token expiry, each with its detail's words", () => {
    expect(
      fleetFieldProblemsOf(
        invalid([
          detail("label", "Must not start or end with a space, or hold a control character."),
          detail("rotateExpiresAt", "Must be a time in the future."),
        ]),
      ),
    ).toEqual({
      label: "Must not start or end with a space, or hold a control character.",
      rotateExpiresAt: "Must be a time in the future.",
    });
    // A Zod issue's own path, as the contract's request schema reports it.
    expect(fleetFieldProblemsOf(invalid([{ path: ["label"], message: "Must be 1 to 80 characters." }]))).toEqual({
      label: "Must be 1 to 80 characters.",
    });
  });

  it("maps a collector's name to its Name field (D17b-1 Preflight ruling 12)", () => {
    expect(fleetFieldProblemsOf(invalid([detail("name", "Must be 1 to 200 characters.")]))).toEqual({
      name: "Must be 1 to 200 characters.",
    });
    expect(fleetFieldProblemsOf(invalid([{ path: ["name"], message: "Must not start or end with a space." }]))).toEqual({
      name: "Must not start or end with a space.",
    });
  });

  it("maps a rotation's expiresAt and graceEndsAt to the rotate dialog's fields (D17b-2 decision 16)", () => {
    expect(
      fleetFieldProblemsOf(invalid([detail("graceEndsAt", "Must not be after expiresAt."), detail("expiresAt", "Must be a time in the future.")])),
    ).toEqual({ graceEndsAt: "Must not be after expiresAt.", expiresAt: "Must be a time in the future." });
    expect(fleetFieldProblemsOf(invalid([{ path: ["graceEndsAt"], message: "Must be a time in the future." }]))).toEqual({
      graceEndsAt: "Must be a time in the future.",
    });
    // The first detail on a field is the one shown.
    expect(
      fleetFieldProblemsOf(invalid([detail("graceEndsAt", "Must be a time in the future."), detail("graceEndsAt", "Must not be after expiresAt.")])),
    ).toEqual({ graceEndsAt: "Must be a time in the future." });
  });

  it("is empty for any other field, details that name none, or any other refusal: the dialog's fallback", () => {
    expect(fleetFieldProblemsOf(invalid([detail("cursor", "Not a cursor of this list's: reload the list.")]))).toEqual({});
    expect(fleetFieldProblemsOf(invalid([{ message: "The request was not valid." }]))).toEqual({});
    expect(fleetFieldProblemsOf(invalid(undefined))).toEqual({});
    expect(
      fleetFieldProblemsOf(refusal("fleet_label_taken", "Another of the organization's fleets has this label.", { details: [detail("label", "x")] })),
    ).toEqual({});
    expect(fleetFieldProblemsOf(new Error("invalid_request"))).toEqual({});
  });
});

describe("isStaleCursor (D17b-1 decision 16, D17b-2 decision 16)", () => {
  /** The platform's stale cursor (`modules/fleets/errors.ts`'s `invalidCursor`). */
  const stale = (details: unknown) =>
    refusal("invalid_request", "The list's cursor isn't valid: reload the list.", { status: 400, details });
  const cursorDetail = {
    keyword: "custom",
    instancePath: "/cursor",
    schemaPath: "#/cursor/custom",
    params: { issue: { code: "custom", path: ["cursor"], message: "Not a cursor of this list's: reload the list." } },
    message: "Not a cursor of this list's: reload the list.",
  };

  it("is true for a 400 invalid_request with a detail naming cursor, by the platform's detail or a Zod issue's path", () => {
    expect(isStaleCursor(stale([cursorDetail]))).toBe(true);
    expect(isStaleCursor(stale([{ path: ["limit"], message: "x" }, { path: ["cursor"], message: "x" }]))).toBe(true);
  });

  it("is false for details naming another field or none, another code, or anything that isn't an ApiError", () => {
    expect(isStaleCursor(stale([{ path: ["limit"], message: "Must be at most 100." }]))).toBe(false);
    expect(isStaleCursor(stale(undefined))).toBe(false);
    expect(isStaleCursor(stale(["cursor", null]))).toBe(false);
    expect(isStaleCursor(refusal("fleet_not_found", "Fleet not found.", { status: 404, details: [cursorDetail] }))).toBe(false);
    expect(isStaleCursor(new Error("invalid_request"))).toBe(false);
  });
});

/** One call of the browser client, answered when the test says. */
interface PendingCall<Answer> {
  organizationId: string;
  signal: AbortSignal | undefined;
  resolve: (answer: Answer) => void;
  reject: (error: unknown) => void;
}

/**
 * A read the test answers when it chooses. It ignores its AbortSignal, as a
 * reply already on its way would, unless `honourAbort`: then an abort
 * rejects it with REQUEST_ABORTED, as the client does.
 */
function pendingCall<Answer>(organizationId: string, signal: AbortSignal | undefined, honourAbort: boolean) {
  let call!: PendingCall<Answer>;
  const promise = new Promise<Answer>((resolve, reject) => {
    call = { organizationId, signal, resolve, reject };
  });
  if (honourAbort) {
    signal?.addEventListener("abort", () => call.reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
  }
  return { call, promise };
}

/** Every getFleets call, in order, each answered by the test. */
function serveFleets({ honourAbort = false } = {}) {
  const calls: Array<PendingCall<FleetsPage> & { query: FleetsQuery }> = [];
  const spy = vi.spyOn(apiClient, "getFleets").mockImplementation((organizationId, query = {}, options = {}) => {
    const { call, promise } = pendingCall<FleetsPage>(organizationId, options.signal, honourAbort);
    calls.push({ ...call, query });
    return promise;
  });
  return { calls, spy, last: () => calls.at(-1)! };
}

/** Lets the promises settle and the timers run, as far as `milliseconds`. */
async function advance(milliseconds = 0): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

let visibility: DocumentVisibilityState = "visible";

function setUp(): void {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  router.revalidate.mockClear();
  router.layoutData = undefined;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  document.body.innerHTML = "";
  useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
}

function tearDown(): void {
  vi.useRealTimers();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
}

// The fleet screens' timings, pinned as DeleteFleetDialog's tests pin its
// 35 s: the other tests advance by these constants, so a changed value
// would pass them all (the final review's Minor).
describe("the fleet screens' timings", () => {
  it("polls every 15 s (D17a decision 8, Preflight ruling 10's useVisiblePolling(poll, 15_000))", () => {
    expect(FLEETS_POLL_INTERVAL_MS).toBe(15_000);
  });

  it("ends a read that never answers at 10 s (Preflight ruling 10's abortAfter(10_000))", () => {
    expect(FLEET_READ_TIMEOUT_MS).toBe(10_000);
  });

  it("ends a create, rename or archive that never answers at 30 s (Preflight rulings 13 and 14's abortAfter(30_000))", () => {
    expect(FLEET_WRITE_TIMEOUT_MS).toBe(30_000);
  });
});

describe("useFleetsList (D17a decision 20, Preflight rulings 10 and 11)", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  /** The list's hook, its first page answered with `fleets` and `nextCursor`. */
  async function loaded(fleets: FleetDetail[], nextCursor: string | null = null) {
    const served = serveFleets();
    const hook = renderHook(({ status }) => useFleetsList({ status }), {
      initialProps: { status: undefined as "active" | "archived" | undefined },
    });
    await advance();
    served.last().resolve(fleetsPage(fleets, nextCursor));
    await advance();
    return { ...hook, served };
  }

  it("loads the active organization's first page: 50, every fleet, no cursor", async () => {
    const served = serveFleets();
    const { result } = renderHook(() => useFleetsList({ status: undefined }));
    expect(result.current.fleets).toBeNull();
    await advance();

    expect(served.calls).toHaveLength(1);
    expect(served.calls[0]!.organizationId).toBe(PERSONAL_ID);
    expect(served.calls[0]!.query).toEqual({ status: undefined, limit: 50, cursor: undefined });
    expect(served.calls[0]!.signal).toBeInstanceOf(AbortSignal);

    served.last().resolve(fleetsPage(manyFleets(50), "cursor-50"));
    await advance();
    expect(served.calls).toHaveLength(1);
    expect(result.current.fleets).toEqual(manyFleets(50));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.shownStatus).toBeUndefined();
    expect(result.current.failed).toBe(false);
  });

  it("drops a late answer: an older read answering after a newer one changes nothing", async () => {
    const served = serveFleets();
    const { result } = renderHook(() => useFleetsList({ status: undefined }));
    await advance();
    const first = served.last();

    act(() => result.current.reload());
    await advance();
    const second = served.last();
    expect(served.calls).toHaveLength(2);

    second.resolve(fleetsPage(manyFleets(1, 2)));
    await advance();
    first.resolve(fleetsPage(manyFleets(1, 1)));
    await advance();

    expect(result.current.fleets).toEqual(manyFleets(1, 2));
  });

  it("drops the old organization's answers on a switch, and shows nothing of it", async () => {
    const { result, served } = await loaded(manyFleets(3));
    expect(result.current.fleets).toHaveLength(3);

    // A poll in the old organization is under way when the switch comes.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const oldPoll = served.last();
    expect(oldPoll.organizationId).toBe(PERSONAL_ID);

    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await advance();
    expect(result.current.fleets).toBeNull();
    const groupLoad = served.last();
    expect(groupLoad.organizationId).toBe(GROUP_ID);
    expect(groupLoad.query).toEqual({ status: undefined, limit: 50, cursor: undefined });
    // The switch aborted the old organization's poll.
    expect(oldPoll.signal?.aborted).toBe(true);

    oldPoll.resolve(fleetsPage(manyFleets(5, 100)));
    await advance();
    expect(result.current.fleets).toBeNull();

    groupLoad.resolve(fleetsPage(manyFleets(1, 200)));
    await advance();
    expect(result.current.fleets).toEqual(manyFleets(1, 200));
  });

  it("'Load more' asks for the next page with the list's status and cursor, and appends it, each fleet once", async () => {
    const served = serveFleets();
    const { result } = renderHook(() => useFleetsList({ status: "active" }));
    await advance();
    served.last().resolve(fleetsPage(manyFleets(50), "cursor-50"));
    await advance();

    act(() => result.current.loadMore());
    expect(result.current.isLoadingMore).toBe(true);
    // A second click while it is under way sends nothing more.
    act(() => result.current.loadMore());
    await advance();
    expect(served.calls).toHaveLength(2);
    expect(served.last().query).toEqual({ status: "active", cursor: "cursor-50" });

    // Fleet 50 came round again (the list moved): it is shown once.
    served.last().resolve(fleetsPage(manyFleets(11, 50), null));
    await advance();
    expect(result.current.isLoadingMore).toBe(false);
    expect(result.current.fleets).toEqual(manyFleets(60));
    expect(result.current.hasMore).toBe(false);

    // The last page: nothing more to ask for.
    act(() => result.current.loadMore());
    await advance();
    expect(served.calls).toHaveLength(2);
  });

  it("polls every 15 s, re-reading the pages shown in pages of up to 100, and continues 'Load more' after the rows shown", async () => {
    const { result, served } = await loaded(manyFleets(50), "cursor-50");
    act(() => result.current.loadMore());
    await advance();
    served.last().resolve(fleetsPage(manyFleets(70, 51), "cursor-120"));
    await advance();
    expect(result.current.fleets).toHaveLength(120);

    // Nothing before the interval.
    await advance(FLEETS_POLL_INTERVAL_MS - 1);
    expect(served.calls).toHaveLength(2);
    await advance(1);
    expect(served.calls).toHaveLength(3);
    expect(served.last().query).toEqual({ status: undefined, limit: 100, cursor: undefined });
    // A new fleet came first: the poll reads 120 from the top, so the last one shown before drops below.
    const polled = [...manyFleets(1, 1000), ...manyFleets(119)];
    served.last().resolve(fleetsPage(polled.slice(0, 100), "poll-100"));
    await advance();
    expect(served.calls).toHaveLength(4);
    expect(served.last().query).toEqual({ status: undefined, limit: 20, cursor: "poll-100" });
    served.last().resolve(fleetsPage(polled.slice(100), "poll-120"));
    await advance();

    expect(result.current.fleets).toEqual(polled);
    expect(result.current.hasMore).toBe(true);

    // "Load more" goes on from the poll's cursor, right after the rows shown.
    act(() => result.current.loadMore());
    await advance();
    expect(served.last().query).toEqual({ status: undefined, cursor: "poll-120" });
  });

  // The review of 32f39ff: the list's focus return tells rows from a read begun after a write by the read's number.
  it("numbers its rows by the read they came from (the first pages', a poll's, \"Load more\"'s, a reload's) and gives the latest read begun", async () => {
    const { result, served } = await loaded(manyFleets(50), "cursor-50");
    const first = result.current.rowsRead;
    expect(first).toBeGreaterThan(0);
    expect(result.current.latestRead()).toBe(first);

    // A poll begun: numbered above the rows shown, which keep their number until it answers.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const polled = result.current.latestRead();
    expect(polled).toBeGreaterThan(first);
    expect(result.current.rowsRead).toBe(first);
    served.last().resolve(fleetsPage(manyFleets(50, 2), "cursor-51"));
    await advance();
    expect(result.current.fleets).toEqual(manyFleets(50, 2));
    expect(result.current.rowsRead).toBe(polled);

    // "Load more"'s rows, the shown ones with its page, carry its number.
    act(() => result.current.loadMore());
    const more = result.current.latestRead();
    expect(more).toBeGreaterThan(polled);
    await advance();
    served.last().resolve(fleetsPage(manyFleets(5, 52), null));
    await advance();
    expect(result.current.fleets).toHaveLength(55);
    expect(result.current.rowsRead).toBe(more);

    // A reload begins in an effect: its number is the latest once it has.
    act(() => result.current.reload());
    await advance();
    const reloaded = result.current.latestRead();
    expect(reloaded).toBeGreaterThan(more);
    expect(result.current.rowsRead).toBe(more);
    served.last().resolve(fleetsPage(manyFleets(54)));
    await advance();
    expect(result.current.fleets).toEqual(manyFleets(54));
    expect(result.current.rowsRead).toBe(reloaded);
  });

  it("polls at least 50 when fewer are shown, and stops where the list ends", async () => {
    const { result, served } = await loaded(manyFleets(3));
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.last().query).toEqual({ status: undefined, limit: 50, cursor: undefined });
    served.last().resolve(fleetsPage(manyFleets(4)));
    await advance();
    expect(served.calls).toHaveLength(2);
    expect(result.current.fleets).toEqual(manyFleets(4));
    expect(result.current.hasMore).toBe(false);
  });

  it("never starts a poll while a person's read is under way: a reload, or 'Load more'", async () => {
    const { result, served } = await loaded(manyFleets(50), "cursor-50");

    act(() => result.current.reload());
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    served.last().resolve(fleetsPage(manyFleets(50), "cursor-50"));
    await advance();

    act(() => result.current.loadMore());
    await advance(3 * FLEETS_POLL_INTERVAL_MS - 1);
    expect(served.calls).toHaveLength(3);
    served.last().resolve(fleetsPage(manyFleets(5, 51), null));
    await advance();

    // Both done: the next tick polls.
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(4);
    expect(served.last().query).toEqual({ status: undefined, limit: 55, cursor: undefined });
  });

  it("lets a person's read supersede a poll under way: the poll is aborted and its answer dropped", async () => {
    const { result, served } = await loaded(manyFleets(2));
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = served.last();

    act(() => result.current.reload());
    await advance();
    expect(poll.signal?.aborted).toBe(true);
    const reload = served.last();
    expect(reload).not.toBe(poll);

    reload.resolve(fleetsPage(manyFleets(1, 7)));
    await advance();
    poll.resolve(fleetsPage(manyFleets(9, 20)));
    await advance();
    expect(result.current.fleets).toEqual(manyFleets(1, 7));
  });

  it("skips polls until a 429's Retry-After has passed", async () => {
    const { result, served } = await loaded(manyFleets(2));
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.fleets).toEqual(manyFleets(2));
    expect(served.calls).toHaveLength(2);

    // Held until 40 s after the 429: the ticks at 15 s and 30 s after it are skipped.
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("holds the polls until Retry-After after a person's reload refused with a 429", async () => {
    vi.spyOn(toast, "error");
    const { result, served } = await loaded(manyFleets(2));
    act(() => result.current.reload());
    await advance();
    served.last().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.fleets).toEqual(manyFleets(2));
    expect(served.calls).toHaveLength(2);

    // Held until 40 s after the 429: the ticks at 15 s and 30 s are skipped.
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("holds the polls until Retry-After after a first load refused with a 429, past 'Try again'", async () => {
    const served = serveFleets();
    const { result } = renderHook(() => useFleetsList({ status: undefined }));
    await advance();
    served.last().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.failed).toBe(true);

    act(() => result.current.reload());
    await advance();
    served.last().resolve(fleetsPage(manyFleets(2)));
    await advance();
    expect(served.calls).toHaveLength(2);

    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("holds the polls until Retry-After after 'Load more' refused with a 429", async () => {
    vi.spyOn(toast, "error");
    const { result, served } = await loaded(manyFleets(50), "cursor-50");
    act(() => result.current.loadMore());
    await advance();
    served.last().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.isLoadingMore).toBe(false);
    expect(served.calls).toHaveLength(2);

    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("holds nothing for a 429 without Retry-After: the next poll comes at its tick", async () => {
    const { served } = await loaded(manyFleets(2));
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(refusal("rate_limited", RATE_LIMITED_MESSAGE, { status: 429 }));
    await advance();
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("stands each read's hang guard down once it has answered: only the polling interval's timer is left", async () => {
    const { result, served } = await loaded(manyFleets(50), "cursor-50");
    // The first load's guard is gone: the interval alone.
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.loadMore());
    await advance();
    expect(vi.getTimerCount()).toBe(2);
    served.last().resolve(fleetsPage(manyFleets(5, 51), null));
    await advance();
    expect(vi.getTimerCount()).toBe(1);

    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(2);
    served.last().resolve(fleetsPage(manyFleets(55)));
    await advance();
    expect(vi.getTimerCount()).toBe(1);

    // A refused read stands its guard down too.
    act(() => result.current.reload());
    await advance();
    served.last().reject(SESSION_ENDED());
    await advance();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps the rows, silently, through a poll's 503, no connection, a 401 and its 10 s abort, and polls on", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded(manyFleets(2));

    for (const failure of [UNAVAILABLE(), NO_CONNECTION(), SESSION_ENDED()]) {
      await advance(FLEETS_POLL_INTERVAL_MS);
      served.last().reject(failure);
      await advance();
      expect(result.current.fleets).toEqual(manyFleets(2));
    }

    // A poll that never answers ends at the hang guard; the next one runs.
    const hanging = serveFleets({ honourAbort: true });
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(hanging.calls).toHaveLength(1);
    await advance(FLEET_READ_TIMEOUT_MS - 1);
    expect(hanging.last().signal?.aborted).toBe(false);
    await advance(1);
    expect(hanging.last().signal?.aborted).toBe(true);
    expect(result.current.fleets).toEqual(manyFleets(2));
    await advance(FLEETS_POLL_INTERVAL_MS - FLEET_READ_TIMEOUT_MS);
    expect(hanging.calls).toHaveLength(2);

    expect(error).not.toHaveBeenCalled();
    expect(router.revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["organization_not_found", ORGANIZATION_GONE],
    ["terms_acceptance_required", TERMS],
  ])("revalidates the layout on a poll's %s, with no toast, the rows kept", async (_code, failure) => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded(manyFleets(2));
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(failure());
    await advance();

    expect(router.revalidate).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(result.current.fleets).toEqual(manyFleets(2));
  });

  it("loads nothing, and polls nothing, while the layout says the terms need accepting", async () => {
    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, true) };
    const served = serveFleets();
    const { result, rerender } = renderHook(() => useFleetsList({ status: undefined }));
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(0);
    expect(result.current.fleets).toBeNull();

    // Accepted: the layout's revalidation says so, and the list loads.
    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, false) };
    rerender();
    await advance();
    expect(served.calls).toHaveLength(1);
  });

  it("shows a failed first load as failed (never an empty list), and 'Try again' loads it", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serveFleets();
    const { result } = renderHook(() => useFleetsList({ status: undefined }));
    await advance();
    served.last().reject(UNAVAILABLE());
    await advance();
    expect(result.current.failed).toBe(true);
    expect(result.current.fleets).toBeNull();
    expect(error).not.toHaveBeenCalled();
    // Nothing is shown, so nothing polls.
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(1);

    act(() => result.current.reload());
    expect(result.current.failed).toBe(false);
    await advance();
    served.last().resolve(fleetsPage([]));
    await advance();
    expect(result.current.fleets).toEqual([]);
  });

  it("ends a first load that never answers at the hang guard, as failed", async () => {
    const served = serveFleets({ honourAbort: true });
    const { result } = renderHook(() => useFleetsList({ status: undefined }));
    await advance(FLEET_READ_TIMEOUT_MS);
    expect(served.last().signal?.aborted).toBe(true);
    expect(result.current.failed).toBe(true);
  });

  it("keeps the rows and toasts 'Failed to load fleets' when a reload of the shown list fails", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded(manyFleets(2));
    act(() => result.current.reload());
    await advance();
    served.last().reject(UNAVAILABLE());
    await advance();

    expect(result.current.fleets).toEqual(manyFleets(2));
    expect(result.current.failed).toBe(false);
    expect(error).toHaveBeenCalledWith(FLEETS_LOAD_FAILED_MESSAGE);
  });

  it("says nothing when a person's read finds the session over", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded(manyFleets(50), "cursor-50");
    act(() => result.current.loadMore());
    await advance();
    served.last().reject(SESSION_ENDED());
    await advance();
    expect(error).not.toHaveBeenCalled();
    expect(result.current.isLoadingMore).toBe(false);
  });

  it("shows the old list as stale while a filter's first page is under way, and pages nothing meanwhile", async () => {
    const { result, rerender, served } = await loaded(manyFleets(50), "cursor-50");

    rerender({ status: "archived" });
    await advance();
    expect(served.last().query).toEqual({ status: "archived", limit: 50, cursor: undefined });
    expect(result.current.isStale).toBe(true);
    expect(result.current.fleets).toEqual(manyFleets(50));
    act(() => result.current.loadMore());
    await advance();
    expect(served.calls).toHaveLength(2);

    served.last().resolve(fleetsPage([fleetDetail({ status: "archived" })]));
    await advance();
    expect(result.current.isStale).toBe(false);
    expect(result.current.shownStatus).toBe("archived");
    expect(result.current.fleets).toEqual([fleetDetail({ status: "archived" })]);
  });

  it("aborts the read under way on unmount", async () => {
    const { served, unmount } = await loaded(manyFleets(2));
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = served.last();
    unmount();
    expect(poll.signal?.aborted).toBe(true);
  });

  it("pauses while a dialog is open (useVisiblePolling)", async () => {
    const { served } = await loaded(manyFleets(2));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(1);
  });
});

/** Every getFleet call, in order, each answered by the test. */
function serveFleet({ honourAbort = false } = {}) {
  const calls: Array<PendingCall<FleetDetail> & { fleetId: string }> = [];
  const spy = vi.spyOn(apiClient, "getFleet").mockImplementation((organizationId, fleetId, options = {}) => {
    const { call, promise } = pendingCall<FleetDetail>(organizationId, options.signal, honourAbort);
    calls.push({ ...call, fleetId });
    return promise;
  });
  return { calls, spy, last: () => calls.at(-1)! };
}

describe("useFleet (D17a decision 19, Preflight rulings 9, 10 and 17)", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  async function loaded(fleet: FleetDetail = fleetDetail()) {
    const served = serveFleet();
    const hook = renderHook(({ fleetId }) => useFleet(fleetId), { initialProps: { fleetId: FLEET_ID } });
    await advance();
    served.last().resolve(fleet);
    await advance();
    return { ...hook, served };
  }

  it("answers 'not found' for an id that isn't a UUID, with no request and no poll", async () => {
    const served = serveFleet();
    const { result } = renderHook(() => useFleet("..%2F..%2Fauth"));
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(result.current.state).toBe("not_found");
    expect(served.calls).toHaveLength(0);
  });

  it("reads the fleet by its id, lower-cased, in the active organization", async () => {
    const served = serveFleet();
    const { result } = renderHook(() => useFleet(FLEET_ID.toUpperCase()));
    expect(result.current.state).toBe("loading");
    await advance();
    expect(served.last().organizationId).toBe(PERSONAL_ID);
    expect(served.last().fleetId).toBe(FLEET_ID);
    served.last().resolve(fleetDetail());
    await advance();
    expect(result.current).toMatchObject({ state: "loaded", fleet: fleetDetail(), isReloading: false });
  });

  it("answers 'not found' for a 404 fleet_not_found", async () => {
    const served = serveFleet();
    const { result } = renderHook(() => useFleet(FLEET_ID));
    await advance();
    served.last().reject(FLEET_GONE());
    await advance();
    expect(result.current.state).toBe("not_found");
  });

  it("polls every 15 s, the header following a rename made elsewhere", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    served.last().resolve(fleetDetail({ label: "edge-prod-eu", status: "archived" }));
    await advance();
    expect(result.current.fleet).toMatchObject({ label: "edge-prod-eu", status: "archived" });
  });

  it("answers 'not found' once a poll finds the fleet deleted, and polls no more", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(FLEET_GONE());
    await advance();
    expect(result.current.state).toBe("not_found");
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
  });

  it("keeps the fleet, silently, through a poll's 503 or abort, and polls on", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(UNAVAILABLE());
    await advance();
    expect(result.current.state).toBe("loaded");

    const hanging = serveFleet({ honourAbort: true });
    await advance(FLEETS_POLL_INTERVAL_MS);
    await advance(FLEET_READ_TIMEOUT_MS);
    expect(hanging.last().signal?.aborted).toBe(true);
    expect(result.current).toMatchObject({ state: "loaded", fleet: fleetDetail() });
    await advance(FLEETS_POLL_INTERVAL_MS - FLEET_READ_TIMEOUT_MS);
    expect(hanging.calls).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("revalidates the layout on a poll's organization_not_found", async () => {
    const { served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(ORGANIZATION_GONE());
    await advance();
    expect(router.revalidate).toHaveBeenCalledTimes(1);
  });

  it("skips polls until a 429's Retry-After has passed", async () => {
    const { served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(RATE_LIMITED(20));
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("never starts a poll while a person's read is under way", async () => {
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    // The reload (its answer still to come, past its guard) is the only read: no poll began.
    expect(served.calls).toHaveLength(2);
    served.last().resolve(fleetDetail({ label: "renamed" }));
    await advance();
    expect(result.current.fleet?.label).toBe("renamed");

    // Done: the next tick polls.
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("holds the polls until Retry-After after a person's reload refused with a 429", async () => {
    vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance();
    served.last().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.state).toBe("loaded");
    expect(served.calls).toHaveLength(2);

    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("stands each read's hang guard down once it has answered: only the polling interval's timer is left", async () => {
    const { result, served } = await loaded();
    expect(vi.getTimerCount()).toBe(1);

    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(2);
    served.last().resolve(fleetDetail());
    await advance();
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.reload());
    await advance();
    expect(vi.getTimerCount()).toBe(2);
    served.last().reject(SESSION_ENDED());
    await advance();
    expect(vi.getTimerCount()).toBe(1);

    await advance(FLEETS_POLL_INTERVAL_MS);
    served.last().reject(SESSION_ENDED());
    await advance();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("lets a reload supersede a poll under way, dropping its late answer", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = served.last();
    act(() => result.current.reload());
    await advance();
    expect(poll.signal?.aborted).toBe(true);
    expect(result.current.isReloading).toBe(true);
    served.last().resolve(fleetDetail({ label: "renamed" }));
    await advance();
    poll.resolve(fleetDetail({ label: "stale" }));
    await advance();
    expect(result.current.fleet?.label).toBe("renamed");
    expect(result.current.isReloading).toBe(false);
  });

  it("drops the old organization's answer on a switch", async () => {
    const served = serveFleet();
    const { result } = renderHook(() => useFleet(FLEET_ID));
    await advance();
    const old = served.last();
    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await advance();
    expect(served.last().organizationId).toBe(GROUP_ID);
    old.resolve(fleetDetail());
    await advance();
    expect(result.current.state).toBe("loading");
    served.last().reject(FLEET_GONE());
    await advance();
    expect(result.current.state).toBe("not_found");
  });

  // Ruling 28: the Tokens tab's focus after a write follows only a fleet from a read begun after it.
  it("numbers its fleet by the read it came from (the first, a poll's, a reload's) and gives the latest read begun", async () => {
    const { result, served } = await loaded();
    const first = result.current.fleetRead;
    expect(first).toBeGreaterThan(0);
    expect(result.current.latestRead()).toBe(first);

    // A poll begun: numbered above the fleet shown, which keeps its number until it answers.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const polled = result.current.latestRead();
    expect(polled).toBeGreaterThan(first);
    expect(result.current.fleetRead).toBe(first);
    served.last().resolve(fleetDetail({ status: "archived" }));
    await advance();
    expect(result.current.fleet?.status).toBe("archived");
    expect(result.current.fleetRead).toBe(polled);

    // A reload begins in an effect: its number is the latest once it has.
    act(() => result.current.reload());
    await advance();
    const reloaded = result.current.latestRead();
    expect(reloaded).toBeGreaterThan(polled);
    expect(result.current.fleetRead).toBe(polled);
    served.last().resolve(fleetDetail());
    await advance();
    expect(result.current.fleetRead).toBe(reloaded);

    // A fleet found gone: none shown, numbered 0.
    act(() => result.current.reload());
    await advance();
    served.last().reject(FLEET_GONE());
    await advance();
    expect(result.current).toMatchObject({ state: "not_found", fleet: null, fleetRead: 0 });
  });

  it("shows a failed first read as failed, and 'Try again' reads it", async () => {
    const served = serveFleet();
    const { result } = renderHook(() => useFleet(FLEET_ID));
    await advance();
    served.last().reject(NO_CONNECTION());
    await advance();
    expect(result.current.state).toBe("failed");

    act(() => result.current.reload());
    await advance();
    expect(result.current.state).toBe("loading");
    served.last().resolve(fleetDetail());
    await advance();
    expect(result.current.state).toBe("loaded");
  });

  it("keeps the fleet and toasts 'Failed to load fleet' when a reload fails", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance();
    served.last().reject(UNAVAILABLE());
    await advance();
    expect(result.current.state).toBe("loaded");
    expect(error).toHaveBeenCalledWith(FLEET_LOAD_FAILED_MESSAGE);
  });

  it("loads nothing while the layout says the terms need accepting", async () => {
    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, true) };
    const served = serveFleet();
    renderHook(() => useFleet(FLEET_ID));
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(0);
  });
});
