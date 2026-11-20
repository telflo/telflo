import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  type EnrollmentTokenEvent,
  type EnrollmentTokenEventsPage,
  type EnrollmentTokenListed,
  type EnrollmentTokensResponse,
  type QuickDeployLink,
  type QuickDeployLinksPage,
} from "@telflo/contracts";
import type * as ReactRouter from "react-router";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED, type PageQuery } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import {
  DEFAULT_TOKEN_ID,
  FLEET_ID,
  REPLACED_TOKEN_ID,
  ROTATE_TOKEN_ID,
  fleetTokens,
  listedToken,
  manyTokenEvents,
  quickDeployLink,
  quickDeployLinksPage,
  tokenEventsPage,
  tokensInEveryState,
} from "~/test/fleets.js";
import { FLEET_READ_TIMEOUT_MS, FLEETS_POLL_INTERVAL_MS } from "./fleets.js";
import {
  INSTALL_LINKS_FAILED_MESSAGE,
  INSTALL_LINKS_PAGE_SIZE,
  TOKEN_HISTORY_FAILED_MESSAGE,
  TOKEN_HISTORY_PAGE_SIZE,
  TOKENS_LOAD_FAILED_MESSAGE,
  currentRotateToken,
  installLinkExtendable,
  installLinkStatus,
  installLinkTokenValid,
  tokenStatus,
  tokenValidAt,
  useTokensTab,
} from "./tokens.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("a token's status", () => {
  const states = tokensInEveryState(NOW);
  const tokens = fleetTokens(NOW);

  it("is valid while not revoked and its expiry, if any, is after now: at the expiry it isn't", () => {
    expect(tokenValidAt(listedToken(), NOW)).toBe(true);
    expect(tokenValidAt(listedToken({ expiresAt: iso(NOW + 1) }), NOW)).toBe(true);
    expect(tokenValidAt(listedToken({ expiresAt: iso(NOW) }), NOW)).toBe(false);
    expect(tokenValidAt(listedToken({ revokedAt: iso(NOW - DAY) }), NOW)).toBe(false);
    expect(tokenValidAt(listedToken({ revokedAt: iso(NOW - DAY), expiresAt: iso(NOW + DAY) }), NOW)).toBe(false);
  });

  it("names the current rotate token by GetActiveRotate's order: not in a grace first, then the newest, then the greater id", () => {
    expect(currentRotateToken(tokens, NOW)?.id).toBe(ROTATE_TOKEN_ID);
    // Only tokens in a grace: the newest of them.
    expect(currentRotateToken([states.beingReplaced, states.expired, states.defaultToken], NOW)?.id).toBe(REPLACED_TOKEN_ID);
    // A newer token in a grace loses to an older one not in a grace.
    const older = listedToken({ id: REPLACED_TOKEN_ID, createdAt: iso(NOW - 10 * DAY) });
    const newerInGrace = listedToken({ id: ROTATE_TOKEN_ID, createdAt: iso(NOW - DAY), doRefresh: true, expiresAt: iso(NOW + DAY) });
    expect(currentRotateToken([newerInGrace, older], NOW)?.id).toBe(REPLACED_TOKEN_ID);
    // At one instant, the greater id.
    const same = iso(NOW - DAY);
    expect(currentRotateToken([listedToken({ id: REPLACED_TOKEN_ID, createdAt: same }), listedToken({ createdAt: same })], NOW)?.id).toBe(
      REPLACED_TOKEN_ID,
    );
    // None valid (suspended), and never the default token.
    expect(currentRotateToken([states.expired, states.revoked, states.defaultToken], NOW)).toBeUndefined();
  });

  it("gives each state its words and badge, in order", () => {
    expect(tokenStatus(states.defaultToken, tokens, NOW)).toEqual({ label: "Valid", variant: "secondary" });
    expect(tokenStatus(states.revokedDefaultToken, tokens, NOW)).toEqual({ label: "Revoked", variant: "secondary" });
    expect(tokenStatus(states.current, tokens, NOW)).toEqual({ label: "Current", variant: "success" });
    expect(tokenStatus(states.beingReplaced, tokens, NOW)).toEqual({
      label: "Being replaced",
      variant: "info",
      until: states.beingReplaced.expiresAt,
    });
    expect(tokenStatus(states.expired, tokens, NOW)).toEqual({ label: "Expired", variant: "outline" });
    expect(tokenStatus(states.revoked, tokens, NOW)).toEqual({ label: "Revoked", variant: "secondary" });
  });

  it("says Revoked before Expired, and Expired at the expiry instant, for either kind", () => {
    const both = listedToken({ revokedAt: iso(NOW - 2 * DAY), expiresAt: iso(NOW - DAY) });
    expect(tokenStatus(both, [both], NOW).label).toBe("Revoked");
    const atExpiry = listedToken({ expiresAt: iso(NOW) });
    expect(tokenStatus(atExpiry, [atExpiry], NOW).label).toBe("Expired");
    const expiredDefault = listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", expiresAt: iso(NOW - DAY) });
    expect(tokenStatus(expiredDefault, [expiredDefault], NOW).label).toBe("Expired");
  });

  it("makes the token being replaced current once the current one is revoked", () => {
    const revokedCurrent = { ...states.current, revokedAt: iso(NOW) };
    const after = [revokedCurrent, states.beingReplaced, states.defaultToken];
    expect(tokenStatus(revokedCurrent, after, NOW).label).toBe("Revoked");
    expect(tokenStatus(states.beingReplaced, after, NOW)).toEqual({ label: "Current", variant: "success" });
    // Past its grace, nothing is current: the fleet is suspended.
    const later = Date.parse(states.beingReplaced.expiresAt!);
    expect(tokenStatus(states.beingReplaced, after, later).label).toBe("Expired");
    expect(currentRotateToken(after, later)).toBeUndefined();
  });

  it("calls a valid rotate token that isn't current 'Being replaced', without an expiry too", () => {
    const old = listedToken({ id: REPLACED_TOKEN_ID, createdAt: iso(NOW - 30 * DAY) });
    expect(tokenStatus(old, [states.current, old], NOW)).toEqual({ label: "Being replaced", variant: "info", until: null });
  });
});

// An install link's status: its own state, then its token's.
describe("an install link's status", () => {
  const states = tokensInEveryState(NOW);
  const tokens = fleetTokens(NOW);
  const active = quickDeployLink({ createdAt: iso(NOW - DAY), expiresAt: iso(NOW + DAY), defaultTokenId: DEFAULT_TOKEN_ID });

  it("is Revoked once revoked, even before its expiry and with its token revoked", () => {
    const revoked = { ...active, revokedAt: iso(NOW - 1000) };
    expect(installLinkStatus(revoked, tokens, NOW)).toEqual({ label: "Revoked", variant: "secondary" });
    expect(installLinkStatus({ ...revoked, expiresAt: iso(NOW - DAY) }, [states.revokedDefaultToken], NOW).label).toBe("Revoked");
  });

  it("is Expired at or past its expiry, not revoked, its token revoked or not", () => {
    expect(installLinkStatus({ ...active, expiresAt: iso(NOW - DAY) }, tokens, NOW)).toEqual({ label: "Expired", variant: "outline" });
    expect(installLinkStatus({ ...active, expiresAt: iso(NOW) }, tokens, NOW).label).toBe("Expired");
    expect(installLinkStatus({ ...active, expiresAt: iso(NOW - DAY) }, [states.revokedDefaultToken], NOW).label).toBe("Expired");
  });

  it("is Token revoked when the default token it carries isn't valid among the same read's tokens, or isn't among them", () => {
    expect(installLinkStatus(active, [states.current, states.revokedDefaultToken], NOW)).toEqual({ label: "Token revoked", variant: "outline" });
    expect(installLinkStatus(active, [states.current], NOW).label).toBe("Token revoked");
    // A new default token doesn't help a link whose command carries the revoked one.
    const newDefault = listedToken({ id: REPLACED_TOKEN_ID, kind: "default", createdAt: iso(NOW) });
    expect(installLinkStatus(active, [newDefault, states.revokedDefaultToken], NOW).label).toBe("Token revoked");
  });

  it("is Group deleted when its group is gone (groupName null), after Revoked, Expired and Token revoked", () => {
    const gone = { ...active, groupName: null };
    expect(installLinkStatus(gone, tokens, NOW)).toEqual({ label: "Group deleted", variant: "outline" });
    expect(installLinkStatus(gone, null, NOW).label).toBe("Group deleted");
    expect(installLinkStatus({ ...gone, expiresAt: null }, tokens, NOW).label).toBe("Group deleted");
    expect(installLinkStatus({ ...gone, revokedAt: iso(NOW - 1000) }, tokens, NOW).label).toBe("Revoked");
    expect(installLinkStatus({ ...gone, expiresAt: iso(NOW - DAY) }, tokens, NOW).label).toBe("Expired");
    expect(installLinkStatus(gone, [states.current, states.revokedDefaultToken], NOW).label).toBe("Token revoked");
  });

  it("is Active otherwise: never expiring too, and by its own times while the tokens are unread", () => {
    expect(installLinkStatus(active, tokens, NOW)).toEqual({ label: "Active", variant: "success" });
    expect(installLinkStatus({ ...active, expiresAt: null }, tokens, NOW).label).toBe("Active");
    expect(installLinkStatus({ ...active, expiresAt: iso(NOW + 1) }, tokens, NOW).label).toBe("Active");
    expect(installLinkStatus(active, null, NOW).label).toBe("Active");
    expect(installLinkStatus({ ...active, expiresAt: iso(NOW - 1) }, null, NOW).label).toBe("Expired");
  });

  it("tells whether the link's token is valid whatever its status (no Extend without it); true while the tokens are unread", () => {
    expect(installLinkTokenValid(active, tokens, NOW)).toBe(true);
    expect(installLinkTokenValid(active, [states.current, states.revokedDefaultToken], NOW)).toBe(false);
    expect(installLinkTokenValid(active, [states.current], NOW)).toBe(false);
    // An expired or a revoked link's token is judged the same way.
    const expired = { ...active, expiresAt: iso(NOW - DAY) };
    expect(installLinkTokenValid(expired, [states.revokedDefaultToken], NOW)).toBe(false);
    const revoked = { ...active, revokedAt: iso(NOW - 1000) };
    expect(installLinkTokenValid(revoked, tokens, NOW)).toBe(true);
    expect(installLinkTokenValid(active, null, NOW)).toBe(true);
  });

  it("offers Extend only on a link not revoked, its group not deleted and its token valid, an expired one included", () => {
    const expired = { ...active, expiresAt: iso(NOW - DAY) };
    expect(installLinkExtendable(active, tokens, NOW)).toBe(true);
    expect(installLinkExtendable(expired, tokens, NOW)).toBe(true);
    expect(installLinkExtendable(active, null, NOW)).toBe(true);
    expect(installLinkExtendable({ ...active, revokedAt: iso(NOW - 1000) }, tokens, NOW)).toBe(false);
    expect(installLinkExtendable({ ...active, groupName: null }, tokens, NOW)).toBe(false);
    expect(installLinkExtendable({ ...expired, groupName: null }, null, NOW)).toBe(false);
    expect(installLinkExtendable(active, [states.current, states.revokedDefaultToken], NOW)).toBe(false);
  });
});

// The hook outside a router: the layout's data as each test sets it (for
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
  refusal("rate_limited", "Too many attempts. Please wait and try again.", { status: 429, retryAfterSeconds });
/** The platform's stale cursor (`modules/fleets/errors.ts`'s `invalidCursor`). */
const STALE_CURSOR = () =>
  refusal("invalid_request", "The list's cursor isn't valid: reload the list.", {
    status: 400,
    details: [
      {
        keyword: "custom",
        instancePath: "/cursor",
        schemaPath: "#/cursor/custom",
        params: { issue: { code: "custom", path: ["cursor"], message: "Not a cursor of this list's: reload the list." } },
        message: "Not a cursor of this list's: reload the list.",
      },
    ],
  });

const TOKENS: EnrollmentTokenListed[] = fleetTokens(NOW);
const NEWER_TOKENS: EnrollmentTokenListed[] = [listedToken({ id: REPLACED_TOKEN_ID, createdAt: iso(NOW) }), ...TOKENS];
const FIRST_PAGE = tokenEventsPage(manyTokenEvents(50), "cursor-1");
const SECOND_PAGE = tokenEventsPage(manyTokenEvents(10, 51), null);

/** `count` install links numbered from `from`, newest first: ids that differ by the number, each an hour before the one numbered before it. */
function manyLinks(count: number, from = 1): QuickDeployLink[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    return quickDeployLink({
      id: `0192f1a4-7b3c-7d2e-8f10-${n.toString(16).padStart(12, "0")}`,
      createdAt: iso(NOW - n * 3_600_000),
      expiresAt: iso(NOW + DAY - n * 3_600_000),
    });
  });
}

const LINKS_FIRST_PAGE = quickDeployLinksPage(manyLinks(50), "links-cursor-1");
const LINKS_SECOND_PAGE = quickDeployLinksPage(manyLinks(10, 51), null);

/** One call of the browser client, answered when the test says. */
interface PendingCall<Answer> {
  organizationId: string;
  fleetId: string;
  signal: AbortSignal | undefined;
  resolve: (answer: Answer) => void;
  reject: (error: unknown) => void;
}

function pendingCall<Answer>(organizationId: string, fleetId: string, signal: AbortSignal | undefined, honourAbort: boolean) {
  let call!: PendingCall<Answer>;
  const promise = new Promise<Answer>((resolve, reject) => {
    call = { organizationId, fleetId, signal, resolve, reject };
  });
  if (honourAbort) {
    signal?.addEventListener("abort", () => call.reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
  }
  return { call, promise };
}

/**
 * Every getEnrollmentTokens, getEnrollmentTokenEvents and getQuickDeployLinks
 * call, in order, each answered by the test; the links' answered at once
 * with LINKS_FIRST_PAGE unless `holdLinks` (the tests of the links' own
 * reads hold them).
 */
function serve({ honourAbort = false, holdLinks = false } = {}) {
  const tokens: Array<PendingCall<EnrollmentTokensResponse>> = [];
  const events: Array<PendingCall<EnrollmentTokenEventsPage> & { query: PageQuery }> = [];
  const links: Array<PendingCall<QuickDeployLinksPage> & { query: PageQuery }> = [];
  vi.spyOn(apiClient, "getQuickDeployLinks").mockImplementation((organizationId, fleetId, query = {}, options = {}) => {
    const { call, promise } = pendingCall<QuickDeployLinksPage>(organizationId, fleetId, options.signal, honourAbort);
    links.push({ ...call, query });
    if (!holdLinks) call.resolve(LINKS_FIRST_PAGE);
    return promise;
  });
  vi.spyOn(apiClient, "getEnrollmentTokens").mockImplementation((organizationId, fleetId, options = {}) => {
    const { call, promise } = pendingCall<EnrollmentTokensResponse>(organizationId, fleetId, options.signal, honourAbort);
    tokens.push(call);
    return promise;
  });
  vi.spyOn(apiClient, "getEnrollmentTokenEvents").mockImplementation((organizationId, fleetId, query = {}, options = {}) => {
    const { call, promise } = pendingCall<EnrollmentTokenEventsPage>(organizationId, fleetId, options.signal, honourAbort);
    events.push({ ...call, query });
    return promise;
  });
  return { tokens, events, links, token: () => tokens.at(-1)!, event: () => events.at(-1)!, link: () => links.at(-1)! };
}

type Served = ReturnType<typeof serve>;

/** Lets the promises settle and the timers run, as far as `milliseconds`. */
async function advance(milliseconds = 0): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

/** Answers the latest read from the top: its tokens, and its history's first page. */
async function answer(served: Served, tokens: EnrollmentTokenListed[] = TOKENS, page: EnrollmentTokenEventsPage = FIRST_PAGE) {
  served.token().resolve({ tokens });
  served.event().resolve(page);
  await advance();
}

/** Fails the latest read from the top with `error`, each of its requests (the links' too, when not yet answered). */
async function failAll(served: Served, error: () => unknown) {
  served.token().reject(error());
  served.event().reject(error());
  served.link().reject(error());
  await advance();
}

const FIRST: PageQuery = { limit: TOKEN_HISTORY_PAGE_SIZE };
const after = (cursor: string): PageQuery => ({ limit: TOKEN_HISTORY_PAGE_SIZE, cursor });

let visibility: DocumentVisibilityState = "visible";
const onFleetGone = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  router.revalidate.mockClear();
  router.layoutData = undefined;
  onFleetGone.mockClear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  document.body.innerHTML = "";
  useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

function render() {
  return renderHook(({ fleetId }: { fleetId: string }) => useTokensTab(fleetId, { onFleetGone }), {
    initialProps: { fleetId: FLEET_ID },
  });
}

/** The hook with its first read answered: the tokens, and 50 events with a next page. */
async function loaded() {
  const served = serve();
  const hook = render();
  await advance();
  await answer(served);
  return { ...hook, served };
}

/** The hook with the history's two pages shown ("Load more" used once). */
async function twoPages() {
  const hook = await loaded();
  act(() => hook.result.current.history.loadMore());
  await advance();
  hook.served.event().resolve(SECOND_PAGE);
  await advance();
  expect(hook.result.current.history.events).toHaveLength(60);
  return hook;
}

describe("useTokensTab", () => {
  it("reads the tokens and the history's first page together, under one hang guard, as a person's read", async () => {
    const served = serve();
    const { result } = render();
    expect(result.current).toMatchObject({ tokens: null, personsRead: true, failed: false, rowsRead: 0 });
    expect(result.current.history).toMatchObject({ events: null, hasMore: false, loadingMore: false, failed: false });
    await advance();

    expect(served.tokens).toHaveLength(1);
    expect(served.events).toHaveLength(1);
    expect(served.token()).toMatchObject({ organizationId: PERSONAL_ID, fleetId: FLEET_ID });
    expect(served.event()).toMatchObject({ organizationId: PERSONAL_ID, fleetId: FLEET_ID, query: FIRST });
    expect(served.token().signal).toBeInstanceOf(AbortSignal);
    expect(served.event().signal).toBe(served.token().signal);

    await answer(served);
    expect(result.current).toMatchObject({ tokens: TOKENS, personsRead: false, failed: false });
    expect(result.current.history).toMatchObject({ events: FIRST_PAGE.events, hasMore: true, loadingMore: false, failed: false });
    expect(result.current.rowsRead).toBeGreaterThan(0);
    expect(result.current.latestRead()).toBe(result.current.rowsRead);
  });

  it("polls every 15 s while only the first page is shown, reading tokens and that page again and replacing both", async () => {
    const { result, served } = await loaded();
    const first = result.current.rowsRead;

    await advance(FLEETS_POLL_INTERVAL_MS - 1);
    expect(served.tokens).toHaveLength(1);
    await advance(1);
    expect(served.tokens).toHaveLength(2);
    expect(served.events).toHaveLength(2);
    expect(served.event().query).toEqual(FIRST);
    expect(served.event().signal).toBe(served.token().signal);
    expect(result.current.personsRead).toBe(false);
    const polled = result.current.latestRead();
    expect(polled).toBeGreaterThan(first);
    expect(result.current.rowsRead).toBe(first);

    const newer = tokenEventsPage(manyTokenEvents(50, 0), "cursor-0");
    await answer(served, NEWER_TOKENS, newer);
    expect(result.current).toMatchObject({ tokens: NEWER_TOKENS, rowsRead: polled });
    expect(result.current.history.events).toEqual(newer.events);
  });

  it("drops a late answer: an older read answering after a newer one changes nothing", async () => {
    const served = serve();
    const { result } = render();
    await advance();
    const first = { token: served.token(), event: served.event() };

    act(() => result.current.reload());
    await advance();
    expect(served.tokens).toHaveLength(2);
    expect(first.token.signal?.aborted).toBe(true);
    await answer(served, NEWER_TOKENS);

    first.token.resolve({ tokens: [listedToken()] });
    first.event.resolve(tokenEventsPage([]));
    await advance();
    expect(result.current.tokens).toEqual(NEWER_TOKENS);
    expect(result.current.history.events).toEqual(FIRST_PAGE.events);
  });

  it("drops the old organization's answers on a switch, never renders its rows in the new one, and reads the new one's", async () => {
    const served = serve();
    const renders: Array<{ organizationId: string | undefined; tokens: unknown; events: unknown; links: unknown }> = [];
    renderHook(() => {
      const read = useTokensTab(FLEET_ID, { onFleetGone });
      renders.push({ organizationId: useCurrentUser()?.organization.id, tokens: read.tokens, events: read.history.events, links: read.links.links });
      return read;
    });
    await advance();
    await answer(served);

    // A poll in the old organization is under way when the switch comes.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const oldPoll = { token: served.token(), event: served.event() };
    expect(oldPoll.token.organizationId).toBe(PERSONAL_ID);

    renders.length = 0;
    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await advance();
    expect(oldPoll.token.signal?.aborted).toBe(true);
    expect(served.token().organizationId).toBe(GROUP_ID);
    expect(served.event()).toMatchObject({ organizationId: GROUP_ID, query: FIRST });
    const inNew = renders.filter((each) => each.organizationId === GROUP_ID);
    expect(inNew).not.toHaveLength(0);
    expect(inNew.filter((each) => each.tokens !== null || each.events !== null || each.links !== null)).toEqual([]);

    oldPoll.token.resolve({ tokens: TOKENS });
    oldPoll.event.resolve(FIRST_PAGE);
    await advance();
    expect(renders.at(-1)).toMatchObject({ tokens: null, events: null, links: null });

    await answer(served, [listedToken()], tokenEventsPage([]));
    expect(renders.at(-1)).toMatchObject({ tokens: [listedToken()], events: [], links: LINKS_FIRST_PAGE.links });
  });

  it("starts over for another fleet: the old fleet's late answer is dropped", async () => {
    const OTHER_FLEET_ID = "c0d1e2f3-a4b5-4c6d-8e7f-a0b1c2d3e4f5";
    const { result, served, rerender } = await twoPages();
    rerender({ fleetId: OTHER_FLEET_ID });
    expect(result.current.tokens).toBeNull();
    expect(result.current.history.events).toBeNull();
    await advance();
    expect(served.token().fleetId).toBe(OTHER_FLEET_ID);
    expect(served.event()).toMatchObject({ fleetId: OTHER_FLEET_ID, query: FIRST });
  });

  it("lets a person's refresh supersede a poll under way: the poll is aborted and its answer dropped", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = { token: served.token(), event: served.event() };

    act(() => result.current.reload());
    await advance();
    expect(poll.token.signal?.aborted).toBe(true);
    await answer(served, NEWER_TOKENS);
    poll.token.resolve({ tokens: [listedToken()] });
    poll.event.resolve(tokenEventsPage([]));
    await advance();
    expect(result.current.tokens).toEqual(NEWER_TOKENS);
    expect(result.current.history.events).toEqual(FIRST_PAGE.events);
  });

  it("never starts a poll while a person's read is under way", async () => {
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(2);
    await answer(served);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(3);
  });

  describe("a person's read failing over what is shown keeps it and toasts once", () => {
    it.each([
      ["the tokens", "tokens", TOKENS_LOAD_FAILED_MESSAGE],
      ["the history", "history", TOKEN_HISTORY_FAILED_MESSAGE],
      ["both: the tokens' words", "both", TOKENS_LOAD_FAILED_MESSAGE],
    ] as const)("%s", async (_name, failing, message) => {
      const error = vi.spyOn(toast, "error");
      const { result, served } = await loaded();
      act(() => result.current.reload());
      await advance();
      if (failing === "history") served.token().resolve({ tokens: NEWER_TOKENS });
      else served.token().reject(UNAVAILABLE());
      if (failing === "tokens") served.event().resolve(tokenEventsPage(manyTokenEvents(3), null));
      else served.event().reject(NO_CONNECTION());
      await advance();

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(message);
      expect(result.current).toMatchObject({ failed: false, personsRead: false });
      expect(result.current.history.failed).toBe(false);
      expect(result.current.tokens).toEqual(failing === "history" ? NEWER_TOKENS : TOKENS);
      expect(result.current.history.events).toEqual(failing === "tokens" ? manyTokenEvents(3) : FIRST_PAGE.events);
    });
  });

  it("fails the tokens and the history apart on a first read, with no toast, and 'Try again' reads both", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = render();
    await advance();
    served.token().reject(UNAVAILABLE());
    served.event().resolve(FIRST_PAGE);
    await advance();
    expect(result.current).toMatchObject({ tokens: null, failed: true, personsRead: false });
    expect(result.current.history).toMatchObject({ events: FIRST_PAGE.events, failed: false });

    act(() => result.current.reload());
    expect(result.current.failed).toBe(false);
    await advance();
    served.token().resolve({ tokens: TOKENS });
    served.event().reject(NO_CONNECTION());
    await advance();
    // The history shown stays (a toast, since it was shown); the tokens are in.
    expect(result.current).toMatchObject({ tokens: TOKENS, failed: false });
    expect(error).toHaveBeenCalledWith(TOKEN_HISTORY_FAILED_MESSAGE);
  });

  it("shows the history failed when its first read fails, the tokens shown, and a poll reads it again", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = render();
    await advance();
    served.token().resolve({ tokens: TOKENS });
    served.event().reject(UNAVAILABLE());
    await advance();
    expect(result.current).toMatchObject({ tokens: TOKENS, failed: false });
    expect(result.current.history).toMatchObject({ events: null, failed: true, hasMore: false });
    expect(error).not.toHaveBeenCalled();

    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.event().query).toEqual(FIRST);
    await answer(served);
    expect(result.current.history).toMatchObject({ events: FIRST_PAGE.events, failed: false });
  });

  it("shows every part failed when the first read fails them all, and polls nothing", async () => {
    const served = serve({ holdLinks: true });
    const { result } = render();
    await advance();
    await failAll(served, NO_CONNECTION);
    expect(result.current).toMatchObject({ tokens: null, failed: true });
    expect(result.current.history.failed).toBe(true);
    expect(result.current.links.failed).toBe(true);
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(1);
  });

  it("ends a first read that never answers at the hang guard, every part failed", async () => {
    const served = serve({ honourAbort: true, holdLinks: true });
    const { result } = render();
    await advance(FLEET_READ_TIMEOUT_MS - 1);
    expect(served.token().signal?.aborted).toBe(false);
    await advance(1);
    expect(served.token().signal?.aborted).toBe(true);
    expect(served.link().signal?.aborted).toBe(true);
    expect(result.current.failed).toBe(true);
    expect(result.current.history.failed).toBe(true);
    expect(result.current.links.failed).toBe(true);
  });

  it("stands each read's hang guard down once it has answered: only the polling interval's timer is left", async () => {
    const { result, served } = await loaded();
    expect(vi.getTimerCount()).toBe(1);
    act(() => result.current.history.loadMore());
    await advance();
    expect(vi.getTimerCount()).toBe(2);
    served.event().resolve(SECOND_PAGE);
    await advance();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("skips polls until a poll's 429 Retry-After has passed, the rows kept", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.token().resolve({ tokens: NEWER_TOKENS });
    served.event().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.tokens).toEqual(NEWER_TOKENS);
    expect(result.current.history.events).toEqual(FIRST_PAGE.events);
    expect(served.tokens).toHaveLength(2);

    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(3);
  });

  it("holds the polls on a 429 of a person's read, and of 'Load more'", async () => {
    vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance();
    await failAll(served, () => RATE_LIMITED(40));
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(3);
    await answer(served);

    act(() => result.current.history.loadMore());
    await advance();
    served.event().reject(RATE_LIMITED(40));
    await advance();
    const before = served.tokens.length;
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(before);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(before + 1);
  });

  it("keeps the rows, silently, through a poll's 503, no connection, a 401 and its 10 s abort, and polls on", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();

    for (const failure of [UNAVAILABLE, NO_CONNECTION, SESSION_ENDED]) {
      await advance(FLEETS_POLL_INTERVAL_MS);
      await failAll(served, failure);
      expect(result.current).toMatchObject({ tokens: TOKENS, failed: false });
      expect(result.current.history).toMatchObject({ events: FIRST_PAGE.events, failed: false });
    }

    const hanging = serve({ honourAbort: true });
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(hanging.tokens).toHaveLength(1);
    await advance(FLEET_READ_TIMEOUT_MS);
    expect(hanging.token().signal?.aborted).toBe(true);
    expect(hanging.event().signal?.aborted).toBe(true);
    expect(result.current.tokens).toEqual(TOKENS);
    await advance(FLEETS_POLL_INTERVAL_MS - FLEET_READ_TIMEOUT_MS);
    expect(hanging.tokens).toHaveLength(2);

    expect(error).not.toHaveBeenCalled();
    expect(router.revalidate).not.toHaveBeenCalled();
    expect(onFleetGone).not.toHaveBeenCalled();
  });

  it.each([
    ["the first read's tokens", "first-tokens"],
    ["the first read's history", "first-history"],
    ["a person's read", "person"],
    ["a poll", "poll"],
    ["'Load more'", "more"],
  ] as const)("calls onFleetGone on %s 404 fleet_not_found, with no toast and no failed state", async (_name, reader) => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = render();
    await advance();
    if (reader === "first-tokens" || reader === "first-history") {
      if (reader === "first-tokens") served.token().reject(FLEET_GONE());
      else served.token().resolve({ tokens: TOKENS });
      if (reader === "first-history") served.event().reject(FLEET_GONE());
      else served.event().resolve(FIRST_PAGE);
      await advance();
    } else {
      await answer(served);
      if (reader === "more") {
        act(() => result.current.history.loadMore());
        await advance();
        served.event().reject(FLEET_GONE());
        await advance();
      } else {
        if (reader === "person") act(() => result.current.reload());
        else await advance(FLEETS_POLL_INTERVAL_MS);
        await advance();
        await failAll(served, FLEET_GONE);
      }
    }
    expect(onFleetGone).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ failed: false, personsRead: false });
    expect(result.current.history).toMatchObject({ failed: false, loadingMore: false });
  });

  it.each([
    ["organization_not_found", ORGANIZATION_GONE],
    ["terms_acceptance_required", TERMS],
  ])("revalidates the layout on %s, a poll's, a person's or 'Load more''s, with no toast, the rows kept", async (_code, failure) => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    await failAll(served, failure);
    expect(router.revalidate).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await advance();
    await failAll(served, failure);
    expect(router.revalidate).toHaveBeenCalledTimes(2);
    act(() => result.current.history.loadMore());
    await advance();
    served.event().reject(failure());
    await advance();
    expect(router.revalidate).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    expect(result.current.tokens).toEqual(TOKENS);
    expect(result.current.history.events).toEqual(FIRST_PAGE.events);
  });

  it("says nothing when a person's read or 'Load more' finds the session over", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance();
    await failAll(served, SESSION_ENDED);
    act(() => result.current.history.loadMore());
    await advance();
    served.event().reject(SESSION_ENDED());
    await advance();
    expect(error).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ personsRead: false, failed: false });
  });

  it("loads nothing, and polls nothing, while the layout says the terms need accepting", async () => {
    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, true) };
    const served = serve();
    const { result, rerender } = render();
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    act(() => result.current.reload());
    act(() => result.current.history.loadMore());
    await advance();
    expect(served.tokens).toHaveLength(0);
    expect(served.events).toHaveLength(0);
    expect(result.current).toMatchObject({ tokens: null, personsRead: false });

    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, false) };
    rerender({ fleetId: FLEET_ID });
    await advance();
    expect(served.tokens).toHaveLength(1);
  });

  it("aborts the read under way on unmount", async () => {
    const { served, unmount } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = served.token();
    unmount();
    expect(poll.signal?.aborted).toBe(true);
  });

  it("pauses while a dialog is open (useVisiblePolling)", async () => {
    const { served } = await loaded();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(1);
  });
});

describe("useTokensTab's history", () => {
  it("'Load more' reads the next page after the shown one's cursor and appends it, each event once", async () => {
    const { result, served } = await loaded();
    act(() => result.current.history.loadMore());
    expect(result.current.history.loadingMore).toBe(true);
    expect(result.current.personsRead).toBe(false);
    await advance();
    expect(served.event().query).toEqual(after("cursor-1"));
    expect(served.tokens).toHaveLength(1);

    // A second press while it runs sends nothing.
    act(() => result.current.history.loadMore());
    await advance();
    expect(served.events).toHaveLength(2);

    // The history moved while paging: its first event of the page is already shown, and is shown once.
    const moved = tokenEventsPage([...manyTokenEvents(1, 50), ...manyTokenEvents(10, 51)], "cursor-2");
    served.event().resolve(moved);
    await advance();
    expect(result.current.history).toMatchObject({ events: manyTokenEvents(60), hasMore: true, loadingMore: false });
    expect(new Set(result.current.history.events!.map((event: EnrollmentTokenEvent) => event.id)).size).toBe(60);

    act(() => result.current.history.loadMore());
    await advance();
    expect(served.event().query).toEqual(after("cursor-2"));
    served.event().resolve(tokenEventsPage(manyTokenEvents(5, 61), null));
    await advance();
    expect(result.current.history).toMatchObject({ events: manyTokenEvents(65), hasMore: false });

    // The last page: nothing more to read.
    act(() => result.current.history.loadMore());
    await advance();
    expect(served.events).toHaveLength(3);
  });

  it("does nothing on 'Load more' while a person's read from the top is under way", async () => {
    const { result, served } = await loaded();
    act(() => result.current.reload());
    act(() => result.current.history.loadMore());
    await advance();
    expect(served.events.map((call) => call.query)).toEqual([FIRST, FIRST]);
  });

  it("polls the history's first page only while it alone is shown: after 'Load more', the polls read the tokens only", async () => {
    const { result, served } = await twoPages();
    const eventReads = served.events.length;

    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(2);
    expect(served.events).toHaveLength(eventReads);
    served.token().resolve({ tokens: NEWER_TOKENS });
    await advance();
    expect(result.current.tokens).toEqual(NEWER_TOKENS);
    expect(result.current.history.events).toHaveLength(60);

    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.events).toHaveLength(eventReads);
  });

  it("the refresh reads the tokens and the history from the top, and the polls read the first page again after it", async () => {
    const { result, served } = await twoPages();
    act(() => result.current.reload());
    expect(result.current.personsRead).toBe(true);
    await advance();
    expect(served.event().query).toEqual(FIRST);
    expect(served.event().signal).toBe(served.token().signal);
    await answer(served, NEWER_TOKENS);
    expect(result.current.tokens).toEqual(NEWER_TOKENS);
    expect(result.current.history).toMatchObject({ events: FIRST_PAGE.events, hasMore: true });

    const eventReads = served.events.length;
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.events).toHaveLength(eventReads + 1);
    expect(served.event().query).toEqual(FIRST);
  });

  it("never starts a poll while 'Load more' runs", async () => {
    const { result, served } = await loaded();
    act(() => result.current.history.loadMore());
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(1);
    served.event().resolve(SECOND_PAGE);
    await advance();
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(2);
  });

  it("'Load more' supersedes a poll under way: the poll's late first page never replaces the two pages", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = { token: served.token(), event: served.event() };
    expect(poll.event.query).toEqual(FIRST);

    act(() => result.current.history.loadMore());
    await advance();
    expect(poll.token.signal?.aborted).toBe(true);
    served.event().resolve(SECOND_PAGE);
    await advance();
    expect(result.current.history.events).toHaveLength(60);

    poll.token.resolve({ tokens: NEWER_TOKENS });
    poll.event.resolve(tokenEventsPage(manyTokenEvents(50, 0), "cursor-0"));
    await advance();
    expect(result.current.history.events).toEqual(manyTokenEvents(60));
    expect(result.current.tokens).toEqual(TOKENS);
  });

  it("a refresh supersedes 'Load more': its late page is never appended", async () => {
    const { result, served } = await loaded();
    act(() => result.current.history.loadMore());
    await advance();
    const more = served.event();

    act(() => result.current.reload());
    await advance();
    expect(more.signal?.aborted).toBe(true);
    expect(result.current.history.loadingMore).toBe(false);
    await answer(served, NEWER_TOKENS);
    more.resolve(SECOND_PAGE);
    await advance();
    expect(result.current.history).toMatchObject({ events: FIRST_PAGE.events, hasMore: true });
  });

  it("keeps the rows and toasts when 'Load more' fails, and can be pressed again", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.history.loadMore());
    await advance();
    served.event().reject(UNAVAILABLE());
    await advance();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(TOKEN_HISTORY_FAILED_MESSAGE);
    expect(result.current.history).toMatchObject({ events: FIRST_PAGE.events, hasMore: true, loadingMore: false, failed: false });
    expect(result.current.tokens).toEqual(TOKENS);

    act(() => result.current.history.loadMore());
    await advance();
    expect(served.event().query).toEqual(after("cursor-1"));
    served.event().resolve(SECOND_PAGE);
    await advance();
    expect(result.current.history.events).toHaveLength(60);
  });

  it("reads from the top, silently, when 'Load more''s cursor is stale (400 invalid_request naming cursor)", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.history.loadMore());
    await advance();
    served.event().reject(STALE_CURSOR());
    await advance();
    expect(result.current.personsRead).toBe(true);
    expect(served.token().signal).toBe(served.event().signal);
    expect(served.event().query).toEqual(FIRST);
    const fresh = tokenEventsPage(manyTokenEvents(50, 2), "fresh-1");
    await answer(served, NEWER_TOKENS, fresh);
    expect(result.current.history).toMatchObject({ events: fresh.events, hasMore: true });
    expect(result.current.tokens).toEqual(NEWER_TOKENS);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("useTokensTab's install links", () => {
  const LINKS_FIRST: PageQuery = { limit: INSTALL_LINKS_PAGE_SIZE };
  const linksAfter = (cursor: string): PageQuery => ({ limit: INSTALL_LINKS_PAGE_SIZE, cursor });

  /** Answers the latest read from the top, its links held until now: the tokens, the history's first page, the links'. */
  async function answerAll(served: Served, links: QuickDeployLinksPage = LINKS_FIRST_PAGE, tokens: EnrollmentTokenListed[] = TOKENS) {
    served.token().resolve({ tokens });
    served.event().resolve(FIRST_PAGE);
    served.link().resolve(links);
    await advance();
  }

  /** The hook with its first read answered, the links held for each read. */
  async function linksLoaded() {
    const served = serve({ holdLinks: true });
    const hook = render();
    await advance();
    await answerAll(served);
    return { ...hook, served };
  }

  /** The links' two pages shown ("Load more" used once). */
  async function twoLinkPages() {
    const hook = await linksLoaded();
    act(() => hook.result.current.links.loadMore());
    await advance();
    hook.served.link().resolve(LINKS_SECOND_PAGE);
    await advance();
    expect(hook.result.current.links.links).toHaveLength(60);
    return hook;
  }

  it("reads the links' first page with the tokens and the history, under the one hang guard, shown once all three have answered", async () => {
    const served = serve({ holdLinks: true });
    const { result } = render();
    expect(result.current.links).toMatchObject({ links: null, hasMore: false, loadingMore: false, failed: false });
    await advance();
    expect(served.links).toHaveLength(1);
    expect(served.link()).toMatchObject({ organizationId: PERSONAL_ID, fleetId: FLEET_ID, query: LINKS_FIRST });
    expect(served.link().signal).toBe(served.token().signal);

    served.token().resolve({ tokens: TOKENS });
    served.event().resolve(FIRST_PAGE);
    await advance();
    // One read: nothing shows before its last part answers.
    expect(result.current).toMatchObject({ tokens: null, personsRead: true });
    served.link().resolve(LINKS_FIRST_PAGE);
    await advance();
    expect(result.current).toMatchObject({ tokens: TOKENS, personsRead: false });
    expect(result.current.links).toMatchObject({ links: LINKS_FIRST_PAGE.links, hasMore: true, loadingMore: false, failed: false });
    expect(result.current.rowsRead).toBe(result.current.latestRead());
  });

  it("polls the links' first page with the rest every 15 s, and replaces it", async () => {
    const { result, served } = await linksLoaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.links).toHaveLength(2);
    expect(served.link().query).toEqual(LINKS_FIRST);
    expect(served.link().signal).toBe(served.token().signal);
    const newer = quickDeployLinksPage(manyLinks(3, 100), null);
    await answerAll(served, newer);
    expect(result.current.links).toMatchObject({ links: newer.links, hasMore: false });
    expect(result.current.rowsRead).toBe(result.current.latestRead());
  });

  it("'Load more' reads the links' next page after the shown cursor and appends it, each link once; a second press sends nothing", async () => {
    const { result, served } = await linksLoaded();
    act(() => result.current.links.loadMore());
    expect(result.current.links.loadingMore).toBe(true);
    expect(result.current.history.loadingMore).toBe(false);
    expect(result.current.personsRead).toBe(false);
    await advance();
    expect(served.link().query).toEqual(linksAfter("links-cursor-1"));
    expect(served.tokens).toHaveLength(1);
    expect(served.events).toHaveLength(1);
    act(() => result.current.links.loadMore());
    act(() => result.current.history.loadMore());
    await advance();
    expect(served.links).toHaveLength(2);
    expect(served.events).toHaveLength(1);

    // A link the list moved past while paging is shown once.
    served.link().resolve(quickDeployLinksPage([...manyLinks(1, 50), ...manyLinks(10, 51)], null));
    await advance();
    expect(result.current.links).toMatchObject({ links: manyLinks(60), hasMore: false, loadingMore: false });
    act(() => result.current.links.loadMore());
    await advance();
    expect(served.links).toHaveLength(2);
  });

  it("polls the links' first page only while it alone is shown: after 'Load more' the polls leave the links alone, until a refresh", async () => {
    const { result, served } = await twoLinkPages();
    const linkReads = served.links.length;
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(2);
    expect(served.events).toHaveLength(2);
    expect(served.links).toHaveLength(linkReads);
    served.token().resolve({ tokens: NEWER_TOKENS });
    served.event().resolve(FIRST_PAGE);
    await advance();
    expect(result.current.tokens).toEqual(NEWER_TOKENS);
    expect(result.current.links.links).toHaveLength(60);

    act(() => result.current.reload());
    await advance();
    expect(served.links).toHaveLength(linkReads + 1);
    expect(served.link().query).toEqual(LINKS_FIRST);
    await answerAll(served);
    expect(result.current.links).toMatchObject({ links: LINKS_FIRST_PAGE.links, hasMore: true });
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.links).toHaveLength(linkReads + 2);
  });

  it("drops late answers: a refresh supersedes the links' 'Load more', and 'Load more' a poll under way", async () => {
    const { result, served } = await linksLoaded();
    act(() => result.current.links.loadMore());
    await advance();
    const more = served.link();
    act(() => result.current.reload());
    await advance();
    expect(more.signal?.aborted).toBe(true);
    expect(result.current.links.loadingMore).toBe(false);
    await answerAll(served);
    more.resolve(LINKS_SECOND_PAGE);
    await advance();
    expect(result.current.links.links).toEqual(LINKS_FIRST_PAGE.links);

    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = { token: served.token(), event: served.event(), link: served.link() };
    act(() => result.current.links.loadMore());
    await advance();
    expect(poll.link.signal?.aborted).toBe(true);
    served.link().resolve(LINKS_SECOND_PAGE);
    await advance();
    poll.token.resolve({ tokens: NEWER_TOKENS });
    poll.event.resolve(FIRST_PAGE);
    poll.link.resolve(quickDeployLinksPage(manyLinks(2, 200), null));
    await advance();
    expect(result.current.links.links).toEqual(manyLinks(60));
    expect(result.current.tokens).toEqual(TOKENS);
  });

  it("fails the links apart on a first read, with no toast; 'Try again' reads them again", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serve({ holdLinks: true });
    const { result } = render();
    await advance();
    served.token().resolve({ tokens: TOKENS });
    served.event().resolve(FIRST_PAGE);
    served.link().reject(UNAVAILABLE());
    await advance();
    expect(result.current).toMatchObject({ tokens: TOKENS, failed: false });
    expect(result.current.history.failed).toBe(false);
    expect(result.current.links).toMatchObject({ links: null, failed: true });
    expect(error).not.toHaveBeenCalled();

    act(() => result.current.reload());
    expect(result.current.links.failed).toBe(false);
    await advance();
    await answerAll(served);
    expect(result.current.links).toMatchObject({ links: LINKS_FIRST_PAGE.links, failed: false });
  });

  it.each([
    ["the links alone: the links' words", ["links"], INSTALL_LINKS_FAILED_MESSAGE],
    ["the history and the links: the history's words", ["history", "links"], TOKEN_HISTORY_FAILED_MESSAGE],
    ["all three: the tokens' words", ["tokens", "history", "links"], TOKENS_LOAD_FAILED_MESSAGE],
  ] as const)("toasts once when a person's read fails %s, over rows shown, and keeps them", async (_name, failing, message) => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await linksLoaded();
    act(() => result.current.reload());
    await advance();
    const fails = (part: string) => (failing as readonly string[]).includes(part);
    if (fails("tokens")) served.token().reject(UNAVAILABLE());
    else served.token().resolve({ tokens: NEWER_TOKENS });
    if (fails("history")) served.event().reject(NO_CONNECTION());
    else served.event().resolve(FIRST_PAGE);
    served.link().reject(UNAVAILABLE());
    await advance();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(message);
    expect(result.current.links).toMatchObject({ links: LINKS_FIRST_PAGE.links, failed: false });
  });

  it("keeps the links silently through a poll's failure", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await linksLoaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.token().resolve({ tokens: TOKENS });
    served.event().resolve(FIRST_PAGE);
    served.link().reject(UNAVAILABLE());
    await advance();
    expect(result.current.links).toMatchObject({ links: LINKS_FIRST_PAGE.links, failed: false });
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the rows and toasts the links' words when their 'Load more' fails, and can be pressed again", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await linksLoaded();
    act(() => result.current.links.loadMore());
    await advance();
    served.link().reject(UNAVAILABLE());
    await advance();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(INSTALL_LINKS_FAILED_MESSAGE);
    expect(result.current.links).toMatchObject({ links: LINKS_FIRST_PAGE.links, hasMore: true, loadingMore: false, failed: false });
    act(() => result.current.links.loadMore());
    await advance();
    expect(served.link().query).toEqual(linksAfter("links-cursor-1"));
  });

  it("reads from the top, silently, when the links' cursor is stale", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await linksLoaded();
    act(() => result.current.links.loadMore());
    await advance();
    served.link().reject(STALE_CURSOR());
    await advance();
    expect(result.current.personsRead).toBe(true);
    expect(served.link().query).toEqual(LINKS_FIRST);
    expect(served.link().signal).toBe(served.token().signal);
    const fresh = quickDeployLinksPage(manyLinks(5, 300), null);
    await answerAll(served, fresh);
    expect(result.current.links).toMatchObject({ links: fresh.links, hasMore: false });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["the first read's links", "first"],
    ["the links' 'Load more'", "more"],
  ] as const)("calls onFleetGone on %s 404 fleet_not_found, with no toast and no failed state", async (_name, reader) => {
    const error = vi.spyOn(toast, "error");
    const served = serve({ holdLinks: true });
    const { result } = render();
    await advance();
    if (reader === "first") {
      served.token().resolve({ tokens: TOKENS });
      served.event().resolve(FIRST_PAGE);
      served.link().reject(FLEET_GONE());
      await advance();
    } else {
      await answerAll(served);
      act(() => result.current.links.loadMore());
      await advance();
      served.link().reject(FLEET_GONE());
      await advance();
    }
    expect(onFleetGone).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(result.current.links).toMatchObject({ failed: false, loadingMore: false });
  });

  it("holds the polls on a 429 of the links' 'Load more'", async () => {
    vi.spyOn(toast, "error");
    const { result, served } = await linksLoaded();
    act(() => result.current.links.loadMore());
    await advance();
    served.link().reject(RATE_LIMITED(40));
    await advance();
    const before = served.tokens.length;
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(before);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.tokens).toHaveLength(before + 1);
  });

  it("starts over for another fleet, the links dropped", async () => {
    const OTHER_FLEET_ID = "c0d1e2f3-a4b5-4c6d-8e7f-a0b1c2d3e4f5";
    const { result, served, rerender } = await twoLinkPages();
    rerender({ fleetId: OTHER_FLEET_ID });
    expect(result.current.links.links).toBeNull();
    await advance();
    expect(served.link()).toMatchObject({ fleetId: OTHER_FLEET_ID, query: LINKS_FIRST });
  });
});
