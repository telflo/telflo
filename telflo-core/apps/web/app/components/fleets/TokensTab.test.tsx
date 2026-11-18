import { useEffect, useState, type ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  quickDeployLinkExpiryAfter,
  type EnrollmentTokenEvent,
  type EnrollmentTokenEventKind,
  type EnrollmentTokenListed,
  type FleetDetail,
  type QuickDeployLink,
  type QuickDeployHelmChoices,
  type QuickDeployLinuxChoices,
} from "@telflo/contracts";
import { maskSecret } from "~/components/secrets/SecretCopyBox.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { FLEETS_POLL_INTERVAL_MS } from "~/lib/fleets.js";
import { formatDateTime } from "~/lib/format.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { currentRotateToken, INSTALL_LINKS_FAILED_MESSAGE, tokenValidAt } from "~/lib/tokens.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import {
  CREATOR,
  EMPTY_SUMMARY,
  expectNoAttributeHolds,
  expectTextOnlyInsideNoCapture,
  FLEET_ID,
  fleetDetail,
  listedToken,
  manyTokenEvents,
  QUICK_DEPLOY_SECRET,
  QUICK_DEPLOY_URL,
  quickDeployLink,
  tokenEvent,
  tokensInEveryState,
} from "~/test/fleets.js";
import { EXTEND_DESCRIPTION, EXTEND_FAILED_MESSAGE, EXTENDED_MESSAGE, ExtendInstallLinkDialog } from "./ExtendInstallLinkDialog.js";
import { InstallLinkDialog } from "./InstallLinkDialog.js";
import {
  INSTALL_LINKS_EMPTY,
  INSTALL_LINKS_EMPTY_HINT,
  INSTALL_LINKS_HELP,
  KUBERNETES_INSTALL_LINKS_EMPTY_HINT,
  KUBERNETES_INSTALL_LINKS_HELP,
} from "./InstallLinksSection.js";
import {
  LINK_REVOKED_MESSAGE,
  REVOKE_HELM_LINK_WORDS,
  REVOKE_LINK_FAILED_MESSAGE,
  REVOKE_LINK_WORDS,
  RevokeInstallLinkDialog,
} from "./RevokeInstallLinkDialog.js";
import { DEFAULT_REVOKE_KUBERNETES } from "./RevokeTokenDialog.js";
import { TOKEN_BANNER_LABEL } from "./TokenBanner.js";
import { DEFAULT_TOKEN_EXISTS, NEW_DEFAULT_DESCRIPTION_KUBERNETES, NEW_DEFAULT_RESULT, NEW_DEFAULT_RESULT_KUBERNETES } from "./NewDefaultTokenDialog.js";
import { ARCHIVED_ROTATE, ARCHIVED_ROTATE_AND_DEFAULT, TOKENS_HELP, TokensTab } from "./TokensTab.js";

/*
 * A server fleet's Tokens tab (D17b-2 decisions 9–13, 22, 26–34; Preflight
 * rulings 4, 6, 8, 10 and 12–15) over the real hook (`useTokensTab`), the
 * browser client's calls answered by a small fake of the API's tokens and
 * token events. Reveal is in `RevealTokenDialog.test.tsx`, and the dialogs'
 * own cases are in their tests; this file covers the tab's states, polls,
 * history, the flows through the API, focus and privacy.
 */

const NOW = Date.now();
const DAY = 86_400_000;
const GONE = () => new ApiError("fleet_not_found", "Fleet not found.", { status: 404 });
const UNAVAILABLE = () => new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
const LINK_NOT_FOUND = () =>
  new ApiError("quick_deploy_link_not_found", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_not_found, { status: 404 });
const LINK_REVOKED = () => new ApiError("quick_deploy_link_revoked", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_revoked, { status: 409 });
const NEW_ROTATE_ID = "c0ffee00-0000-4000-8000-0000000000c1";
const DEFAULT_BEARER = "tfd_tab-canary-default-41f2";
const REVEALED_ROTATE_BEARER = "tfr_tab-canary-revealed-77a0";
const ROTATED_BEARER = "tfr_tab-canary-rotated-c3d9";
const NEW_DEFAULT_ID = "c0ffee00-0000-4000-8000-0000000000d2";
const NEW_DEFAULT_BEARER = "tfd_tab-canary-new-default-9a4f";
const NEW_DEFAULT_REVEALED_BEARER = "tfd_tab-canary-new-default-revealed-2c8b";

/** What the fake API holds: the fleet's tokens (newest first), its token events (newest first) and its install links (newest first). */
interface Api {
  tokens: EnrollmentTokenListed[];
  events: EnrollmentTokenEvent[];
  links: QuickDeployLink[];
  /** Fails the next links reads with these, one each. */
  linkFailures: unknown[];
  /** Fails the next link writes (an extend, a revoke) with these, one each, before writing. */
  linkWriteFailures: unknown[];
  /** Holds every link write until released. */
  linkWriteHold: Promise<void> | null;
  /** Fails the next tokens reads with these, one each. */
  tokenFailures: unknown[];
  /** Holds every tokens read until released. */
  hold: Promise<void> | null;
  /** Fails the next new default tokens with these, one each, after making the token (a 500 once the store committed). */
  issueFailuresAfterMaking: unknown[];
}

let api: Api;
let eventNumber = 0;

function eventOf(token: EnrollmentTokenListed, event: EnrollmentTokenEventKind, email = CREATOR.email): EnrollmentTokenEvent {
  eventNumber += 1;
  return tokenEvent({
    id: `00000000-0000-4000-b000-${eventNumber.toString(16).padStart(12, "0")}`,
    tokenId: token.id,
    event,
    actor: { ...CREATOR, email },
    occurredAt: new Date(NOW + eventNumber * 1000).toISOString(),
  });
}

const earlier = (a: string | null, b: string) => (a === null || Date.parse(b) < Date.parse(a) ? b : a);

/** The token reads and writes over the fake, as the API makes them (the events recorded as the opamp-server does). */
function serve() {
  const getEnrollmentTokens = vi.spyOn(apiClient, "getEnrollmentTokens").mockImplementation(async () => {
    if (api.hold !== null) await api.hold;
    const failure = api.tokenFailures.shift();
    if (failure !== undefined) throw failure;
    return { tokens: [...api.tokens] };
  });
  const getEnrollmentTokenEvents = vi.spyOn(apiClient, "getEnrollmentTokenEvents").mockImplementation(async (_organizationId, _fleetId, query = {}) => {
    const limit = query.limit ?? 50;
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const end = start + limit;
    return { events: api.events.slice(start, end), nextCursor: end < api.events.length ? String(end) : null };
  });
  const rotateEnrollmentToken = vi.spyOn(apiClient, "rotateEnrollmentToken").mockImplementation(async (_organizationId, _fleetId, request) => {
    const current = currentRotateToken(api.tokens, Date.now());
    if (current !== undefined) {
      api.tokens = api.tokens.map((token) =>
        token.id === current.id ? { ...token, doRefresh: true, expiresAt: earlier(token.expiresAt, request.graceEndsAt) } : token,
      );
    }
    const made = listedToken({ id: NEW_ROTATE_ID, expiresAt: request.expiresAt, createdAt: new Date().toISOString() });
    api.tokens = [made, ...api.tokens];
    api.events = [eventOf(made, "issued"), ...(current === undefined ? [] : [eventOf(current, "rotated")]), ...api.events];
    return { token: { id: made.id, bearer: ROTATED_BEARER, expiresAt: made.expiresAt, predecessorId: current?.id ?? null } };
  });
  const revealEnrollmentToken = vi.spyOn(apiClient, "revealEnrollmentToken").mockImplementation(async (_organizationId, _fleetId, tokenId) => {
    const token = api.tokens.find((each) => each.id === tokenId)!;
    api.events = [eventOf(token, "viewed"), ...api.events];
    const bearer = token.id === NEW_DEFAULT_ID ? NEW_DEFAULT_REVEALED_BEARER : token.kind === "default" ? DEFAULT_BEARER : REVEALED_ROTATE_BEARER;
    return { token: { id: token.id, kind: token.kind, bearer, expiresAt: token.expiresAt } };
  });
  // The opamp-server's IssueDefault: 409 while a default token is valid; else a new one, its `issued` event, its bearer.
  const issueDefaultEnrollmentToken = vi.spyOn(apiClient, "issueDefaultEnrollmentToken").mockImplementation(async () => {
    if (api.tokens.some((token) => token.kind === "default" && tokenValidAt(token, Date.now()))) {
      throw new ApiError("enrollment_token_default_exists", "The fleet already has a valid default token.", { status: 409 });
    }
    const made = listedToken({ id: NEW_DEFAULT_ID, kind: "default", expiresAt: null, createdAt: new Date().toISOString(), activeCollectors: 0 });
    api.tokens = [made, ...api.tokens];
    api.events = [eventOf(made, "issued"), ...api.events];
    const failure = api.issueFailuresAfterMaking.shift();
    if (failure !== undefined) throw failure;
    return { token: { id: made.id, kind: "default", bearer: NEW_DEFAULT_BEARER, expiresAt: null } };
  });
  const revokeEnrollmentToken = vi.spyOn(apiClient, "revokeEnrollmentToken").mockImplementation(async (_organizationId, _fleetId, tokenId) => {
    api.tokens = api.tokens.map((token) => (token.id === tokenId ? { ...token, revokedAt: new Date().toISOString() } : token));
    const revoked = api.tokens.find((each) => each.id === tokenId)!;
    api.events = [eventOf(revoked, "revoked"), ...api.events];
    const { activeCollectors: _active, ...token } = revoked;
    return { token };
  });
  const getQuickDeployLinks = vi.spyOn(apiClient, "getQuickDeployLinks").mockImplementation(async (_organizationId, _fleetId, query = {}) => {
    if (api.hold !== null) await api.hold;
    const failure = api.linkFailures.shift();
    if (failure !== undefined) throw failure;
    const limit = query.limit ?? 50;
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const end = start + limit;
    return { links: api.links.slice(start, end), nextCursor: end < api.links.length ? String(end) : null };
  });
  /** A link write's checks, as the API makes them: the link the fleet's, else 404. */
  const linkFor = async (linkId: string) => {
    if (api.linkWriteHold !== null) await api.linkWriteHold;
    const failure = api.linkWriteFailures.shift();
    if (failure !== undefined) throw failure;
    const link = api.links.find((each) => each.id === linkId);
    if (link === undefined) throw LINK_NOT_FOUND();
    return link;
  };
  const replaceLink = (next: QuickDeployLink) => {
    api.links = api.links.map((each) => (each.id === next.id ? next : each));
    return { link: next };
  };
  // The API's extend: refused once revoked; else the new expiry counted from now.
  const extendQuickDeployLink = vi.spyOn(apiClient, "extendQuickDeployLink").mockImplementation(async (_organizationId, _fleetId, linkId, by) => {
    const link = await linkFor(linkId);
    if (link.revokedAt !== null) throw LINK_REVOKED();
    const expiresAt = quickDeployLinkExpiryAfter(by, new Date());
    return replaceLink({ ...link, expiresAt: expiresAt === null ? null : expiresAt.toISOString(), status: "active" });
  });
  // The API's revoke: idempotent.
  const revokeQuickDeployLink = vi.spyOn(apiClient, "revokeQuickDeployLink").mockImplementation(async (_organizationId, _fleetId, linkId) => {
    const link = await linkFor(linkId);
    return replaceLink(link.revokedAt === null ? { ...link, revokedAt: new Date().toISOString(), status: "revoked" } : link);
  });
  return {
    getEnrollmentTokens,
    getEnrollmentTokenEvents,
    rotateEnrollmentToken,
    revealEnrollmentToken,
    revokeEnrollmentToken,
    issueDefaultEnrollmentToken,
    getQuickDeployLinks,
    extendQuickDeployLink,
    revokeQuickDeployLink,
  };
}

const onFleetGone = vi.fn();
const onFleetChanged = vi.fn();
/**
 * The route's fleet reads, numbered as `useFleet`'s (`useReadOrder`): the
 * latest begun. Each fleet the tab is given carries the read it came from.
 */
let fleetReads = 0;
/** Begins a fleet read, as the route's poll or reload would: its number. */
const beginFleetRead = () => ++fleetReads;
const latestFleetRead = () => fleetReads;
/** Gives the tab a fleet from the read `read` (by default one begun now: a poll answering at once). */
let setFleet: (fleet: FleetDetail, read?: number) => void = () => {};

function renderTab(initial: FleetDetail = fleetDetail()) {
  const first = beginFleetRead();
  function Tab() {
    const [shown, set] = useState({ fleet: initial, read: first });
    useEffect(() => {
      setFleet = (fleet, read = beginFleetRead()) => set({ fleet, read });
    }, []);
    return (
      <TokensTab
        fleet={shown.fleet}
        fleetRead={shown.read}
        latestFleetRead={latestFleetRead}
        onFleetGone={onFleetGone}
        onFleetChanged={onFleetChanged}
      />
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Tab }]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

async function poll(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
}

const button = (name: string) => screen.getByRole("button", { name });
const tokens = tokensInEveryState(NOW);
const ROTATE_NAME = `the rotate token created ${formatDateTime(tokens.current.createdAt)}`;
const REPLACED_NAME = `the rotate token created ${formatDateTime(tokens.beingReplaced.createdAt)}`;
/**
 * The rotate-before-expiry banner, by its name: a `region` landmark rendered
 * only when there is a banner, with no live semantics (Ruling 31).
 */
const banner = () => screen.getByRole("region", { name: TOKEN_BANNER_LABEL });
/** No banner shown: no region by its name (looked for behind an open dialog too, which hides the page from the tree). */
const expectNoBanner = () => expect(screen.queryByRole("region", { name: TOKEN_BANNER_LABEL, hidden: true })).toBeNull();
const bannerRotate = () => within(banner()).getByRole("button", { name: "Rotate token" });
/** The header's "Rotate token", not the banner's (when one is shown). */
const headerRotate = () =>
  screen
    .getAllByRole("button", { name: "Rotate token" })
    .find((each) => !screen.queryByRole("region", { name: TOKEN_BANNER_LABEL, hidden: true })?.contains(each))!;
/** A fleet whose current rotate token expires in 5 days: the banner shows. */
const expiringFleet = () =>
  fleetDetail({ summary: { ...EMPTY_SUMMARY, rotateToken: { expiresAt: new Date(NOW + 5 * DAY + 60_000).toISOString(), graceEndsAt: null, validCount: 1 } } });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  onFleetGone.mockReset();
  onFleetChanged.mockReset();
  fleetReads = 0;
  eventNumber = 0;
  api = {
    tokens: [tokens.current, tokens.beingReplaced, tokens.expired, tokens.revoked, tokens.defaultToken],
    events: [],
    tokenFailures: [],
    hold: null,
    issueFailuresAfterMaking: [],
    links: [],
    linkFailures: [],
    linkWriteFailures: [],
    linkWriteHold: null,
  };
  api.events = [eventOf(tokens.current, "issued"), eventOf(tokens.defaultToken, "issued")].reverse();
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

describe("TokensTab's states (decision 26)", () => {
  it('shows "Loading tokens…" until the first read answers', async () => {
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    serve();
    renderTab();
    expect(await screen.findByText("Loading tokens…")).toBeInTheDocument();
    api.hold = null;
    await act(async () => release());
    expect(await screen.findByRole("button", { name: "Reveal the default token" })).toBeInTheDocument();
    expect(screen.queryByText("Loading tokens…")).toBeNull();
  });

  it('shows a failed first load ("Failed to load tokens") with Try again, which reads again', async () => {
    api.tokenFailures = [UNAVAILABLE()];
    const { getEnrollmentTokens } = serve();
    const user = renderTab();
    expect(await screen.findByText("Failed to load tokens")).toBeInTheDocument();
    await user.click(button("Try again"));
    expect(await screen.findByRole("button", { name: "Reveal the default token" })).toBeInTheDocument();
    expect(getEnrollmentTokens).toHaveBeenCalledTimes(2);
  });

  it("calls onFleetGone on a fleet found gone, with no toast and no failed state", async () => {
    api.tokenFailures = [GONE()];
    const error = vi.spyOn(toast, "error");
    serve();
    renderTab();
    await waitFor(() => expect(onFleetGone).toHaveBeenCalledTimes(1));
    expect(error).not.toHaveBeenCalled();
    expect(screen.queryByText("Failed to load tokens")).toBeNull();
  });

  it('shows "Fleet tokens", its help, "Refresh tokens" and "Rotate token", and the tokens in the API\'s order', async () => {
    serve();
    renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    expect(screen.getByRole("heading", { name: "Fleet tokens" })).toBeInTheDocument();
    expect(screen.getByText(TOKENS_HELP)).toBeInTheDocument();
    expect(TOKENS_HELP).toBe(
      "Collectors enroll with the fleet's default token and, if they accept connection settings, are then handed its current rotate token. Rotate to replace the rotate token with a grace period; revoke a token to refuse it within 10 seconds.",
    );
    expect(button("Refresh tokens")).toBeEnabled();
    expect(headerRotate()).toBeEnabled();
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[3]!.textContent)).toEqual([
      "Current",
      `Being replaceduntil ${formatDateTime(tokens.beingReplaced.expiresAt)}`,
      "Expired",
      "Revoked",
      "Valid",
    ]);
    expectNoBanner();
    expect(document.body).not.toHaveTextContent(/Fleet Tokens|Active in last 5m|Predecessor|Rotating →|deploy/);
  });

  it("disables only Rotate token on an archived fleet, with its reason beside it (Preflight ruling 8); no banner", async () => {
    serve();
    renderTab(fleetDetail({ status: "archived", summary: { ...EMPTY_SUMMARY, rotateToken: null } }));
    await screen.findByRole("button", { name: "Reveal the default token" });
    expect(headerRotate()).toBeDisabled();
    expect(screen.getByText(ARCHIVED_ROTATE)).toBeInTheDocument();
    expect(ARCHIVED_ROTATE).toBe("An archived fleet's tokens can't be rotated: unarchive it first.");
    expect(headerRotate()).toHaveAccessibleDescription(ARCHIVED_ROTATE);
    for (const name of ["Reveal the default token", "Revoke the default token", `Reveal ${ROTATE_NAME}`, `Revoke ${ROTATE_NAME}`]) {
      expect(button(name)).toBeEnabled();
    }
    expectNoBanner();
  });

  it("shows the banner above the table for a fleet whose current token nears its expiry", async () => {
    serve();
    renderTab(expiringFleet());
    await screen.findByRole("button", { name: "Reveal the default token" });
    expect(banner()).toHaveTextContent("The fleet's rotate token expires in 5 days");
    expect(banner().compareDocumentPosition(screen.getAllByRole("table")[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Ruling 31: no aria-live anywhere, so Radix's hideOthers hides the banner, and its button, behind a dialog.
  it("hides the banner from the accessibility tree while the rotate dialog it opened is open", async () => {
    serve();
    const user = renderTab(expiringFleet());
    await screen.findByRole("button", { name: "Reveal the default token" });
    await user.click(bannerRotate());
    await screen.findByRole("dialog", { name: "Rotate token" });
    expect(screen.queryByRole("region", { name: TOKEN_BANNER_LABEL })).toBeNull();
    expect(screen.getByRole("region", { name: TOKEN_BANNER_LABEL, hidden: true })).toHaveTextContent("The fleet's rotate token expires in 5 days");
  });
});

describe("TokensTab's poll and refresh (decisions 10 and 32)", () => {
  it("re-reads the tokens and the history's first page every 15 s, and a row follows", async () => {
    const { getEnrollmentTokens, getEnrollmentTokenEvents } = serve();
    renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    const reads = getEnrollmentTokens.mock.calls.length;
    const historyReads = getEnrollmentTokenEvents.mock.calls.length;
    api.tokens = api.tokens.map((token) => (token.id === tokens.defaultToken.id ? { ...token, activeCollectors: 7 } : token));
    await poll();
    expect(await screen.findByText("7 collectors")).toBeInTheDocument();
    expect(getEnrollmentTokens).toHaveBeenCalledTimes(reads + 1);
    expect(getEnrollmentTokenEvents).toHaveBeenCalledTimes(historyReads + 1);
    expect(getEnrollmentTokenEvents).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, { limit: 50 }, expect.anything());
  });

  it("pauses the polls while a dialog is open", async () => {
    const { getEnrollmentTokens } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: `Revoke ${ROTATE_NAME}` }));
    await screen.findByRole("alertdialog");
    const reads = getEnrollmentTokens.mock.calls.length;
    await poll();
    expect(getEnrollmentTokens).toHaveBeenCalledTimes(reads);
  });

  it("reads the tokens and the history from the top on Refresh tokens, spinning until it answers", async () => {
    const { getEnrollmentTokens, getEnrollmentTokenEvents } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    api.tokens = api.tokens.map((token) => (token.id === tokens.defaultToken.id ? { ...token, activeCollectors: 9 } : token));
    await user.click(button("Refresh tokens"));
    expect(button("Refresh tokens").querySelector("svg")).toHaveClass("animate-spin");
    api.hold = null;
    await act(async () => release());
    expect(await screen.findByText("9 collectors")).toBeInTheDocument();
    expect(button("Refresh tokens").querySelector("svg")).not.toHaveClass("animate-spin");
    expect(getEnrollmentTokens).toHaveBeenCalledTimes(2);
    expect(getEnrollmentTokenEvents).toHaveBeenCalledTimes(2);
  });
});

describe("TokensTab's history (decision 27)", () => {
  const historyRows = () => within(screen.getAllByRole("table")[1]!).getAllByRole("row").slice(1);

  it("lists the history beneath the table, newest first, each token named from the tokens read", async () => {
    serve();
    renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    expect(await screen.findByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(historyRows().map((row) => within(row).getAllByRole("cell").slice(1).map((cell) => cell.textContent))).toEqual([
      ["Issued", "Default token", CREATOR.email],
      ["Issued", `Rotate token created ${formatDateTime(tokens.current.createdAt)}`, CREATOR.email],
    ]);
  });

  it('pages with "Load more", and the poll leaves it alone once more than the first page is shown', async () => {
    api.events = manyTokenEvents(75);
    const { getEnrollmentTokenEvents } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    await waitFor(() => expect(historyRows()).toHaveLength(50));
    await user.click(button("Load more"));
    await waitFor(() => expect(historyRows()).toHaveLength(75));
    expect(getEnrollmentTokenEvents).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, { limit: 50, cursor: "50" }, expect.anything());
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    const reads = getEnrollmentTokenEvents.mock.calls.length;
    await poll();
    expect(getEnrollmentTokenEvents).toHaveBeenCalledTimes(reads);
    expect(historyRows()).toHaveLength(75);
  });

  it("shows the history's own failure apart from the tokens, Try again reading both", async () => {
    const { getEnrollmentTokenEvents, getEnrollmentTokens } = serve();
    getEnrollmentTokenEvents.mockRejectedValueOnce(UNAVAILABLE());
    const user = renderTab();
    expect(await screen.findByText("Failed to load the token history")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal the default token" })).toBeInTheDocument();
    await user.click(button("Try again"));
    expect(await screen.findByRole("heading", { name: "History" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Failed to load the token history")).toBeNull());
    expect(getEnrollmentTokens).toHaveBeenCalledTimes(2);
  });
});

describe("TokensTab's writes (decisions 22 and 29–31)", () => {
  it("rotates from the header: the result's bearer, then the tokens, the history and the fleet read again", async () => {
    const { rotateEnrollmentToken, getEnrollmentTokens } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    const reads = getEnrollmentTokens.mock.calls.length;
    await user.click(headerRotate());
    const dialog = await screen.findByRole("dialog", { name: "Rotate token" });
    await user.click(within(dialog).getByRole("button", { name: "Rotate token" }));

    const result = await screen.findByRole("dialog", { name: "Token rotated" });
    expect(within(result).getByText(ROTATED_BEARER)).toBeInTheDocument();
    expect(rotateEnrollmentToken).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getEnrollmentTokens).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);

    await user.click(within(result).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const newName = `the rotate token created ${formatDateTime(api.tokens[0]!.createdAt)}`;
    expect(await screen.findByRole("button", { name: `Reveal ${newName}` })).toBeInTheDocument();
    expect(within(screen.getAllByRole("table")[1]!).getAllByText("Rotated")).toHaveLength(1);
    expect(document.body).not.toHaveTextContent(ROTATED_BEARER);
  });

  it("reveals a row's token: its bearer in the dialog, the history gaining the reveal, nothing left after closing", async () => {
    const { revealEnrollmentToken } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Reveal the default token" }));
    const dialog = await screen.findByRole("dialog", { name: "Default token" });
    expect(await within(dialog).findByText(maskSecret(DEFAULT_BEARER))).toBeInTheDocument();
    expect(revealEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(revealEnrollmentToken).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, tokens.defaultToken.id, expect.anything());
    expect(await within(screen.getAllByRole("table", { hidden: true })[1]!).findByText("Revealed")).toBeInTheDocument();
    expect(onFleetChanged).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent(DEFAULT_BEARER);
    expect(document.body).not.toHaveTextContent(maskSecret(DEFAULT_BEARER));
  });

  it("revokes a row's token after confirming: toasted, the row Revoked with no actions, the history and the fleet read again", async () => {
    const { revokeEnrollmentToken } = serve();
    const toastSuccess = vi.spyOn(toast, "success");
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: `Revoke ${REPLACED_NAME}` }));
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke this token?" });
    expect(dialog).toHaveTextContent("2 collectors seen in the last 5 minutes are on it.");
    await user.click(within(dialog).getByRole("button", { name: "Revoke token" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(revokeEnrollmentToken).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, tokens.beingReplaced.id, expect.anything());
    expect(toastSuccess).toHaveBeenCalledWith("Token revoked");
    await waitFor(() => expect(screen.queryByRole("button", { name: `Revoke ${REPLACED_NAME}` })).toBeNull());
    expect(within(screen.getAllByRole("table")[1]!).getByText("Revoked")).toBeInTheDocument();
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });

  it('opens the rotation from the banner\'s "Rotate token"', async () => {
    serve();
    const user = renderTab(expiringFleet());
    await screen.findByRole("button", { name: "Reveal the default token" });
    await user.click(bannerRotate());
    expect(await screen.findByRole("dialog", { name: "Rotate token" })).toBeInTheDocument();
  });

  it.each([
    ["the rotation", () => headerRotate(), "dialog"],
    ["the reveal", () => button("Reveal the default token"), "dialog"],
    ["the revoke", () => button(`Revoke ${ROTATE_NAME}`), "alertdialog"],
  ] as const)("closes %s when the organization changes", async (_which, opener, role) => {
    serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    await user.click(opener());
    expect(await screen.findByRole(role)).toBeInTheDocument();
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
  });
});

describe("TokensTab's focus as a dialog closes (decision 33; Preflight ruling 14)", () => {
  const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
  /**
   * Holds the route's reload after the write: begun as the tab asks for it
   * (numbered above the read the write recorded), its fleet (`next`'s, by
   * default one with no banner) given only when released.
   */
  function holdFleetReload(next: () => FleetDetail = () => fleetDetail()): { release: () => void } {
    const held = { release: () => {} };
    onFleetChanged.mockImplementation(() => {
      const read = beginFleetRead();
      held.release = () => act(() => setFleet(next(), read));
    });
    return held;
  }
  /** Holds every tokens read until released. */
  function holdTokens(): () => Promise<void> {
    let release: () => void = () => {};
    api.hold = new Promise((resolve) => {
      release = resolve;
    });
    return async () => {
      api.hold = null;
      await act(async () => release());
    };
  }
  const done = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole("dialog", { name: "Token rotated" });
    await user.click(button("Done"));
  };

  it.each([
    ["the header's rotation", () => headerRotate(), "dialog"],
    ["the banner's rotation", () => bannerRotate(), "dialog"],
    ["a reveal", () => button("Reveal the default token"), "dialog"],
    ["a revoke", () => button(`Revoke ${ROTATE_NAME}`), "alertdialog"],
  ] as const)("returns to the opener after %s closes by Escape", async (_which, opener, role) => {
    serve();
    const user = renderTab(expiringFleet());
    await screen.findByRole("button", { name: "Reveal the default token" });
    await user.click(opener());
    await screen.findByRole(role);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    await focusIsOn(opener);
  });

  it("returns to the row's Reveal after a reveal", async () => {
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Reveal the default token" }));
    await screen.findByText(maskSecret(DEFAULT_BEARER));
    await user.click(button("Done"));
    await focusIsOn(() => button("Reveal the default token"));
  });

  it("goes to the first row action after a revoke takes the row's actions away", async () => {
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: `Revoke ${REPLACED_NAME}` }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Revoke ${REPLACED_NAME}` })).toBeNull());
    await focusIsOn(() => button(`Reveal ${ROTATE_NAME}`));
  });

  it("goes to the first row action after a rotation takes the banner away", async () => {
    serve();
    // The route's reload after the rotation: the fleet's new current token expires in a year, so no banner.
    onFleetChanged.mockImplementation(() => setFleet(fleetDetail()));
    const user = renderTab(expiringFleet());
    await screen.findByRole("button", { name: "Reveal the default token" });
    await user.click(bannerRotate());
    await user.click(within(await screen.findByRole("dialog", { name: "Rotate token" })).getByRole("button", { name: "Rotate token" }));
    await screen.findByRole("dialog", { name: "Token rotated" });
    await waitFor(expectNoBanner);
    await user.click(button("Done"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => screen.getAllByRole("button", { name: /^Reveal / })[0]!);
    expect(document.activeElement).toHaveAccessibleName(`Reveal the rotate token created ${formatDateTime(api.tokens[0]!.createdAt)}`);
  });

  // Ruling 25 (D17b-1 Ruling 42's invariant): the fleet the tab is given is a read too. After a write,
  // a fleet read answering after the close that takes the banner away moves the focus on, whichever
  // of the tokens' reload and the fleet's answers first.
  describe("a rotation from the banner whose fleet reload answers after the close", () => {
    const closeUnknown = async (user: ReturnType<typeof userEvent.setup>) => {
      const dialog = screen.getByRole("dialog", { name: "Rotate token" });
      await within(dialog).findByText(FLEETS_UNAVAILABLE_MESSAGE);
      await user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((each) => each.textContent === "Close")!);
    };
    const spinner = () => button("Refresh tokens").querySelector("svg");
    /** The fallback: a row's Reveal (the first row action), never the body. */
    const onARowsReveal = async () =>
      waitFor(() => {
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement).toHaveAccessibleName(/^Reveal the rotate token created /);
        expect(screen.getAllByRole("table")[0]).toContainElement(document.activeElement as HTMLElement);
      });

    it.each([
      ["an unknown outcome closed by Close", "unknown"],
      ["a success closed by Done", "success"],
    ] as const)("tokens first, then the fleet: %s ends on the first row action", async (_which, outcome) => {
      const served = serve();
      if (outcome === "unknown") served.rotateEnrollmentToken.mockRejectedValueOnce(UNAVAILABLE());
      const fleetReload = holdFleetReload();
      const user = renderTab(expiringFleet());
      await screen.findByRole("button", { name: "Reveal the default token" });
      await user.click(bannerRotate());
      const readsBefore = served.getEnrollmentTokens.mock.calls.length;
      await user.click(within(await screen.findByRole("dialog", { name: "Rotate token" })).getByRole("button", { name: "Rotate token" }));
      if (outcome === "unknown") await closeUnknown(user);
      else await done(user);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // The tab's reload (after the rotation, or after the close of an unknown outcome) has answered, its rows rendered.
      await waitFor(() => expect(served.getEnrollmentTokens.mock.calls.length).toBeGreaterThan(readsBefore));
      await waitFor(() => expect(spinner()).not.toHaveClass("animate-spin"));
      await waitFor(() => expect(document.activeElement).toBe(bannerRotate()));
      // Now the fleet's reload answers: the rotation took, the banner goes.
      fleetReload.release();
      await waitFor(expectNoBanner);
      await onARowsReveal();
    });

    it.each([
      ["an unknown outcome closed by Close", "unknown"],
      ["a success closed by Done", "success"],
    ] as const)("the fleet first, then the tokens: %s ends on the first row action", async (_which, outcome) => {
      const served = serve();
      if (outcome === "unknown") served.rotateEnrollmentToken.mockRejectedValueOnce(UNAVAILABLE());
      const fleetReload = holdFleetReload();
      const user = renderTab(expiringFleet());
      await screen.findByRole("button", { name: "Reveal the default token" });
      await user.click(bannerRotate());
      const releaseTokens = holdTokens();
      await user.click(within(await screen.findByRole("dialog", { name: "Rotate token" })).getByRole("button", { name: "Rotate token" }));
      if (outcome === "unknown") await closeUnknown(user);
      else await done(user);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(bannerRotate()));
      // The fleet's reload answers first, the tokens' still held.
      fleetReload.release();
      await waitFor(expectNoBanner);
      await onARowsReveal();
      const focused = document.activeElement;
      expect(spinner()).toHaveClass("animate-spin");
      await releaseTokens();
      // The tokens' reload has answered: its rows leave the focus where the fleet's put it.
      await waitFor(() => expect(spinner()).not.toHaveClass("animate-spin"));
      expect(document.activeElement).toBe(focused);
      await onARowsReveal();
    });

    it("leaves the focus where the person put it when the fleet's reload takes the banner away", async () => {
      serve();
      const fleetReload = holdFleetReload();
      const user = renderTab(expiringFleet());
      await screen.findByRole("button", { name: "Reveal the default token" });
      await user.click(bannerRotate());
      await user.click(within(await screen.findByRole("dialog", { name: "Rotate token" })).getByRole("button", { name: "Rotate token" }));
      await done(user);
      await waitFor(() => expect(document.activeElement).toBe(bannerRotate()));
      button("Refresh tokens").focus();
      fleetReload.release();
      await waitFor(expectNoBanner);
      expect(document.activeElement).toBe(button("Refresh tokens"));
    });

    it("leaves the focus alone after a close that made no write (Escape)", async () => {
      serve();
      const user = renderTab(expiringFleet());
      await screen.findByRole("button", { name: "Reveal the default token" });
      await user.click(bannerRotate());
      await screen.findByRole("dialog", { name: "Rotate token" });
      await user.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).toBe(bannerRotate()));
      // A rotation made elsewhere: the route's poll takes the banner away; no write here, so the focus isn't moved.
      act(() => setFleet(fleetDetail()));
      await waitFor(expectNoBanner);
      expect(document.activeElement).toBe(document.body);
    });
  });

  // Ruling 28 (D17b-1 Ruling 42's rule for the fleet's read; the fix-wave review's probes P1–P5): the first
  // fleet from a read begun after the write spends it, moving the focus only after the close, the button the
  // focus went back to gone or disabled and the focus lost; a fleet from an older read moves and spends nothing.
  describe("the fleet's read after a write", () => {
    const blurToBody = () => act(() => (document.activeElement as HTMLElement | null)?.blur());
    const rotateFrom = async (user: ReturnType<typeof userEvent.setup>, opener: () => HTMLElement) => {
      await screen.findByRole("button", { name: "Reveal the default token" });
      await user.click(opener());
      await user.click(within(await screen.findByRole("dialog", { name: "Rotate token" })).getByRole("button", { name: "Rotate token" }));
    };
    /** The first row action: the new rotate token's Reveal, in the table. */
    const onFirstRowAction = async () =>
      waitFor(() => {
        expect(document.activeElement).toHaveAccessibleName(`Reveal the rotate token created ${formatDateTime(api.tokens[0]!.createdAt)}`);
        expect(screen.getAllByRole("table")[0]).toContainElement(document.activeElement as HTMLElement);
      });

    it("leaves the focus on the body at a later poll once the reload's fleet has spent the write (a banner's rotation, the focus moved meanwhile)", async () => {
      serve();
      const fleetReload = holdFleetReload();
      const user = renderTab(expiringFleet());
      await rotateFrom(user, bannerRotate);
      await done(user);
      await focusIsOn(bannerRotate);
      button("Refresh tokens").focus();
      // The reload's fleet takes the banner away: the focus, put elsewhere, stays; the write is spent.
      fleetReload.release();
      await waitFor(expectNoBanner);
      expect(document.activeElement).toBe(button("Refresh tokens"));
      // The person clicks the page's background, and the route's poll gives the fleet again (no write since).
      blurToBody();
      act(() => setFleet(fleetDetail()));
      await act(async () => {});
      expect(document.activeElement).toBe(document.body);
    });

    it("leaves the focus on the body at a later poll once the reload's fleet has spent the write (a revoke, the rows' reload moving it first)", async () => {
      serve();
      const fleetReload = holdFleetReload();
      const user = renderTab();
      await user.click(await screen.findByRole("button", { name: `Revoke ${REPLACED_NAME}` }));
      const releaseTokens = holdTokens();
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke token" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await focusIsOn(() => button(`Revoke ${REPLACED_NAME}`));
      // The tokens' reload takes the row's actions away: the rows move the focus on.
      await releaseTokens();
      await waitFor(() => expect(screen.queryByRole("button", { name: `Revoke ${REPLACED_NAME}` })).toBeNull());
      await focusIsOn(() => button(`Reveal ${ROTATE_NAME}`));
      // The reload's fleet spends the fleet's side, the focus where the rows put it.
      fleetReload.release();
      await act(async () => {});
      expect(document.activeElement).toBe(button(`Reveal ${ROTATE_NAME}`));
      blurToBody();
      act(() => setFleet(fleetDetail()));
      await act(async () => {});
      expect(document.activeElement).toBe(document.body);
    });

    it("moves nothing for a fleet from a read begun before the write (the banner kept), then the reload's fleet moves the focus on", async () => {
      serve();
      const fleetReload = holdFleetReload();
      const user = renderTab(expiringFleet());
      // A poll begun before the write, answering after the close.
      const older = beginFleetRead();
      await rotateFrom(user, bannerRotate);
      await done(user);
      await focusIsOn(bannerRotate);
      act(() => setFleet(expiringFleet(), older));
      await act(async () => {});
      expect(document.activeElement).toBe(bannerRotate());
      // The write wasn't spent: the reload's fleet takes the banner away, and the focus lost with it moves on.
      fleetReload.release();
      await waitFor(expectNoBanner);
      await onFirstRowAction();
    });

    it("leaves the focus on the header's Rotate token when the reload's fleet keeps it", async () => {
      serve();
      const fleetReload = holdFleetReload();
      const user = renderTab();
      await rotateFrom(user, headerRotate);
      await done(user);
      await focusIsOn(headerRotate);
      fleetReload.release();
      await act(async () => {});
      expect(document.activeElement).toBe(headerRotate());
    });

    // The fix-wave review's m1: the :disabled branch.
    it("moves the focus to the first row action when the reload's fleet comes back archived, disabling the header's Rotate token it was on", async () => {
      serve();
      const fleetReload = holdFleetReload(() => fleetDetail({ status: "archived" }));
      const user = renderTab();
      await rotateFrom(user, headerRotate);
      await done(user);
      await focusIsOn(headerRotate);
      fleetReload.release();
      await waitFor(() => expect(headerRotate()).toBeDisabled());
      await onFirstRowAction();
    });

    it("moves nothing at a poll after the spend, the focus on the body, even when the poll disables the button the focus went back to", async () => {
      serve();
      const fleetReload = holdFleetReload();
      const user = renderTab();
      await rotateFrom(user, headerRotate);
      await done(user);
      await focusIsOn(headerRotate);
      // The reload's fleet keeps the header's button: spent, nothing moved.
      fleetReload.release();
      await act(async () => {});
      expect(document.activeElement).toBe(headerRotate());
      blurToBody();
      // An archive made elsewhere: the poll's fleet disables the button; the write is spent, so nothing moves.
      act(() => setFleet(fleetDetail({ status: "archived" })));
      await waitFor(() => expect(headerRotate()).toBeDisabled());
      await act(async () => {});
      expect(document.activeElement).toBe(document.body);
    });

    it("only spends when the reload's fleet lands before the close (Done): the close goes to the first row action, and a later poll moves nothing", async () => {
      serve();
      onFleetChanged.mockImplementation(() => setFleet(fleetDetail()));
      const user = renderTab(expiringFleet());
      await rotateFrom(user, bannerRotate);
      await screen.findByRole("dialog", { name: "Token rotated" });
      await waitFor(expectNoBanner);
      await user.click(button("Done"));
      await onFirstRowAction();
      const focused = document.activeElement;
      act(() => setFleet(fleetDetail()));
      await act(async () => {});
      expect(document.activeElement).toBe(focused);
      blurToBody();
      act(() => setFleet(fleetDetail()));
      await act(async () => {});
      expect(document.activeElement).toBe(document.body);
    });
  });

  it("goes to Refresh tokens when no row action is left", async () => {
    api.tokens = [tokens.expired, tokens.revoked, tokens.defaultToken];
    serve();
    const user = renderTab(fleetDetail({ summary: { ...EMPTY_SUMMARY, rotateToken: null } }));
    await user.click(await screen.findByRole("button", { name: "Revoke the default token" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke the default token" })).toBeNull());
    await focusIsOn(() => button("Refresh tokens"));
  });
});

describe("TokensTab's New default token (D17c-1 decision 45; Preflight ruling 31)", () => {
  const newDefault = () => button("New default token");
  const queryNewDefault = () => screen.queryByRole("button", { name: "New default token" });
  /** The fleet's default token revoked: no valid default token. */
  const withRevokedDefault = () => {
    api.tokens = [tokens.current, tokens.beingReplaced, tokens.expired, tokens.revoked, tokens.revokedDefaultToken];
  };
  const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
  /** The new default token's row name, once the fleet holds two default tokens. */
  const newDefaultName = () => `the default token created ${formatDateTime(api.tokens.find((each) => each.id === NEW_DEFAULT_ID)!.createdAt)}`;

  it("offers no New default token while the fleet's default token is valid, nor before the tokens are read or after a failed read", async () => {
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    withRevokedDefault();
    api.tokenFailures = [UNAVAILABLE()];
    serve();
    const user = renderTab();
    expect(await screen.findByText("Loading tokens…")).toBeInTheDocument();
    expect(queryNewDefault()).toBeNull();
    api.hold = null;
    await act(async () => release());
    expect(await screen.findByText("Failed to load tokens")).toBeInTheDocument();
    expect(queryNewDefault()).toBeNull();
    await user.click(button("Try again"));
    expect(await screen.findByRole("button", { name: "New default token" })).toBeEnabled();
  });

  it("shows it beside Rotate token once no default token is valid", async () => {
    serve();
    renderTab();
    await screen.findByRole("button", { name: "Reveal the default token" });
    expect(queryNewDefault()).toBeNull();
    withRevokedDefault();
    await poll();
    await waitFor(() => expect(queryNewDefault()).toBeInTheDocument());
    expect(newDefault().compareDocumentPosition(headerRotate()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newDefault()).toBeEnabled();
  });

  it("is disabled on an archived fleet, one sentence giving both buttons' reason", async () => {
    withRevokedDefault();
    serve();
    renderTab(fleetDetail({ status: "archived", summary: { ...EMPTY_SUMMARY, rotateToken: null } }));
    await waitFor(() => expect(newDefault()).toBeDisabled());
    expect(headerRotate()).toBeDisabled();
    expect(screen.getByText(ARCHIVED_ROTATE_AND_DEFAULT)).toBeInTheDocument();
    expect(ARCHIVED_ROTATE_AND_DEFAULT).toBe("An archived fleet's tokens can't be rotated, and it can't be given a new default token: unarchive it first.");
    expect(screen.queryByText(ARCHIVED_ROTATE)).toBeNull();
    // The sentence describes both disabled buttons (Ruling 61's nit).
    expect(newDefault()).toHaveAccessibleDescription(ARCHIVED_ROTATE_AND_DEFAULT);
    expect(headerRotate()).toHaveAccessibleDescription(ARCHIVED_ROTATE_AND_DEFAULT);
  });

  it("tells the revoke and the new default token a Kubernetes-supervisor fleet's type: the Helm releases' words (Ruling 55)", async () => {
    serve();
    const user = renderTab(fleetDetail({ type: "kubernetes-supervisor" }));
    await user.click(await screen.findByRole("button", { name: "Revoke the default token" }));
    const revoke = await screen.findByRole("alertdialog");
    expect(revoke).toHaveTextContent(DEFAULT_REVOKE_KUBERNETES);
    await user.click(within(revoke).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(queryNewDefault()).toBeInTheDocument());

    await user.click(newDefault());
    const dialog = await screen.findByRole("dialog", { name: "New default token" });
    expect(dialog).toHaveAccessibleDescription(NEW_DEFAULT_DESCRIPTION_KUBERNETES);
    await user.click(within(dialog).getByRole("button", { name: "Issue token" }));
    expect(await within(dialog).findByText(NEW_DEFAULT_BEARER)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(NEW_DEFAULT_RESULT_KUBERNETES);
    expect(dialog).not.toHaveTextContent(/install command|docker/);
  });

  it("follows a revoke of the default token: issued, its bearer shown, the button gone, both default tokens named by their dates", async () => {
    const { issueDefaultEnrollmentToken, getEnrollmentTokens } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Revoke the default token" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(queryNewDefault()).toBeInTheDocument());

    await user.click(newDefault());
    const dialog = await screen.findByRole("dialog", { name: "New default token" });
    const reads = getEnrollmentTokens.mock.calls.length;
    const changes = onFleetChanged.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Issue token" }));
    expect(await within(dialog).findByText(NEW_DEFAULT_BEARER)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(NEW_DEFAULT_RESULT);
    expect(issueDefaultEnrollmentToken).toHaveBeenCalledTimes(1);
    expect(issueDefaultEnrollmentToken).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.anything());
    await waitFor(() => expect(getEnrollmentTokens).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(changes + 1);
    // The reload behind the dialog takes the button away.
    await waitFor(() => expect(screen.queryByRole("button", { name: "New default token", hidden: true })).toBeNull());

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent(NEW_DEFAULT_BEARER);
    // Two default tokens: each row named by its date; the revoked one has no actions.
    expect(button(`Reveal ${newDefaultName()}`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal the default token" })).toBeNull();
    const defaultCells = within(screen.getAllByRole("table")[1]!)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell").slice(1, 3).map((cell) => cell.textContent));
    expect(defaultCells.slice(0, 2)).toEqual([
      ["Issued", `Default token created ${formatDateTime(api.tokens[0]!.createdAt)}`],
      ["Revoked", `Default token created ${formatDateTime(tokens.revokedDefaultToken.createdAt)}`],
    ]);
  });

  it("returns the focus to New default token when its dialog closes by Escape", async () => {
    withRevokedDefault();
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "New default token" }));
    await screen.findByRole("dialog", { name: "New default token" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(newDefault);
  });

  // The first row action: the new default token's Reveal (the newest token, first in the API's order).
  it("moves the focus to the first row action once the issue has taken New default token away", async () => {
    withRevokedDefault();
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "New default token" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Issue token" }));
    await screen.findByText(NEW_DEFAULT_BEARER);
    await waitFor(() => expect(screen.queryByRole("button", { name: "New default token", hidden: true })).toBeNull());
    await user.click(button("Done"));
    await focusIsOn(() => screen.getAllByRole("button", { name: /^Reveal / })[0]!);
    expect(document.activeElement).toHaveAccessibleName(`Reveal ${newDefaultName()}`);
  });

  it("moves the focus on when the reload takes the button away after the close", async () => {
    withRevokedDefault();
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "New default token" }));
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Issue token" }));
    await screen.findByText(NEW_DEFAULT_BEARER);
    await user.click(button("Done"));
    // The reload is held: the button is still there, and the focus goes back to it.
    await focusIsOn(newDefault);
    api.hold = null;
    await act(async () => release());
    await waitFor(() => expect(queryNewDefault()).toBeNull());
    await focusIsOn(() => button(`Reveal ${newDefaultName()}`));
  });

  // Task 1's review: a 500 after the opamp-server made the token leaves a valid default token nobody received.
  it("after a 500 that made the token anyway: the reload takes the button away, a retry says Reveal shows it, and Reveal does", async () => {
    withRevokedDefault();
    api.issueFailuresAfterMaking = [new ApiError("internal_error", "Something went wrong.", { status: 500 })];
    const { issueDefaultEnrollmentToken } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "New default token" }));
    const dialog = await screen.findByRole("dialog", { name: "New default token" });
    await user.click(within(dialog).getByRole("button", { name: "Issue token" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    // The tab read its tokens again: the new default token is valid, so the button is gone behind the dialog.
    await waitFor(() => expect(screen.queryByRole("button", { name: "New default token", hidden: true })).toBeNull());

    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(DEFAULT_TOKEN_EXISTS);
    expect(issueDefaultEnrollmentToken).toHaveBeenCalledTimes(2);
    expect(document.body).not.toHaveTextContent(NEW_DEFAULT_BEARER);
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((each) => each.textContent === "Close")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => button(`Reveal ${newDefaultName()}`));

    // Reveal shows it.
    await user.click(button(`Reveal ${newDefaultName()}`));
    const reveal = await screen.findByRole("dialog", { name: "Default token" });
    expect(await within(reveal).findByText(maskSecret(NEW_DEFAULT_REVEALED_BEARER))).toBeInTheDocument();
  });

  it("closes its dialog when the organization changes", async () => {
    withRevokedDefault();
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "New default token" }));
    await screen.findByRole("dialog", { name: "New default token" });
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the new bearer inside ph-no-capture, gone once Done", async () => {
    withRevokedDefault();
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "New default token" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Issue token" }));
    await screen.findByText(NEW_DEFAULT_BEARER);
    expect(expectTextOnlyInsideNoCapture(NEW_DEFAULT_BEARER)).toBe(1);
    await user.click(button("Done"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent(NEW_DEFAULT_BEARER);
    expectNoAttributeHolds(NEW_DEFAULT_BEARER);
  });
});

// ADR 0024, decisions 12 and 34: bearers only inside ph-no-capture; no fleet label or email in an attribute or the title.
describe("TokensTab's privacy", () => {
  it("keeps every bearer inside ph-no-capture and no label or email in an attribute or the title, with every dialog open", async () => {
    const label = "canary-fleet-tokens-5d0e";
    const email = "canary-member-tokens-a71c@example.com";
    api.events = [
      tokenEvent({ id: "00000000-0000-4000-b000-0000000000f1", tokenId: tokens.current.id, actor: { ...CREATOR, email } }),
      tokenEvent({ id: "00000000-0000-4000-b000-0000000000f2", tokenId: tokens.defaultToken.id, event: "viewed", actor: { ...CREATOR, email } }),
    ];
    api.tokens = api.tokens.map((token) => ({ ...token, createdBy: { ...CREATOR, email } }));
    serve();
    const user = renderTab({ ...expiringFleet(), label });
    await screen.findByRole("button", { name: "Reveal the default token" });
    expect(await screen.findAllByText(email)).toHaveLength(2);
    const names = [label, email];
    const expectNamesNowhereButText = () => {
      for (const text of names) {
        expectNoAttributeHolds(text);
        expect(document.title, "document.title").not.toContain(text);
      }
    };
    expectNamesNowhereButText();

    // The rotation, its form and its result.
    await user.click(headerRotate());
    const rotate = await screen.findByRole("dialog", { name: "Rotate token" });
    expectNamesNowhereButText();
    await user.click(within(rotate).getByRole("button", { name: "Rotate token" }));
    await screen.findByRole("dialog", { name: "Token rotated" });
    expect(expectTextOnlyInsideNoCapture(ROTATED_BEARER)).toBe(1);
    expectNamesNowhereButText();
    await user.click(button("Done"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent(ROTATED_BEARER);

    // A reveal of each kind: masked, then whole once shown, and only inside ph-no-capture.
    for (const [opener, show, bearer] of [
      ["Reveal the default token", "Show default token", DEFAULT_BEARER],
      [`Reveal ${ROTATE_NAME}`, "Show rotate token", REVEALED_ROTATE_BEARER],
    ] as const) {
      await user.click(await screen.findByRole("button", { name: opener }));
      await screen.findByText(maskSecret(bearer));
      expect(document.body).not.toHaveTextContent(bearer);
      await user.click(button(show));
      await screen.findByText(bearer);
      expect(expectTextOnlyInsideNoCapture(bearer)).toBe(1);
      expectNamesNowhereButText();
      await user.click(button("Done"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.body).not.toHaveTextContent(bearer);
      expect(document.body).not.toHaveTextContent(maskSecret(bearer));
    }

    // The revoke.
    await user.click(button(`Revoke ${ROTATE_NAME}`));
    await screen.findByRole("alertdialog");
    expectNamesNowhereButText();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    // No bearer is anywhere once every dialog has closed.
    for (const bearer of [ROTATED_BEARER, DEFAULT_BEARER, REVEALED_ROTATE_BEARER]) {
      expectNoAttributeHolds(bearer);
      expect(document.title).not.toContain(bearer);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Install Links (D17c-2 decisions 4, 5, 14, 31 and 32; Preflight rulings
 * 21–24): the links, their View, Extend and Revoke (no masked token, Copy
 * or JSON options).
 */

const HOUR = 3_600_000;
const OLD_DEFAULT_ID = "c0ffee00-0000-4000-8000-0000000000e3";

/** The fixture link's choices, a Linux link's (D17d-2: a link's choices are a Linux or a Helm values link's). */
function linuxChoices(): QuickDeployLinuxChoices {
  const { choices } = quickDeployLink();
  if (choices.kind === "helm") throw new Error("The fixture's link is a Linux link.");
  return choices;
}

/** Link `n`: created `n` hours ago, expiring a day after its making, on the fleet's default token. */
function linkNumbered(n: number, overrides: Partial<QuickDeployLink> = {}): QuickDeployLink {
  return quickDeployLink({
    id: `0192f1a4-7b3c-7d2e-8f10-${n.toString(16).padStart(12, "0")}`,
    createdAt: new Date(NOW - n * HOUR).toISOString(),
    expiresAt: new Date(NOW - n * HOUR + DAY).toISOString(),
    defaultTokenId: tokens.defaultToken.id,
    ...overrides,
  });
}

/** A link's name, by its creation to the second (Ruling 39). */
const linkName = (link: QuickDeployLink) =>
  `the install link created ${new Date(link.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
const linksSection = () => screen.getByRole("heading", { name: "Install links" }).closest("section") as HTMLElement;
const linksTable = () => within(linksSection()).getByRole("table");
const linkRows = () => within(linksTable()).getAllByRole("row").slice(1);
const linkCells = (row: HTMLElement) => within(row).getAllByRole("cell").map((cell) => cell.textContent);
const rowOf = (link: QuickDeployLink) => button(`View ${linkName(link)}`).closest("tr") as HTMLElement;
const linkFocusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
/** The links read so far. */
const linkReads = (served: ReturnType<typeof serve>) => served.getQuickDeployLinks.mock.calls.length;

describe("TokensTab's install links (D17c-2 decision 31; Preflight rulings 21 and 22)", () => {
  // D17d-2 decision 22; Preflight ruling 30 (D17d-1 hid them until its Helm link).
  it("shows Install links on a Kubernetes-supervisor fleet in its words, read with the tokens and the history, each poll alike", async () => {
    const served = serve();
    renderTab(fleetDetail({ type: "kubernetes-supervisor" }));
    expect(await screen.findByRole("heading", { name: "Install links" })).toBeInTheDocument();
    expect(await within(linksSection()).findByText(INSTALL_LINKS_EMPTY)).toBeInTheDocument();
    expect(within(linksSection()).getByText(KUBERNETES_INSTALL_LINKS_HELP)).toBeInTheDocument();
    expect(KUBERNETES_INSTALL_LINKS_HELP).toBe(
      "Helm values links made when installing groups. Revoke a link to stop further downloads; a values.yaml already downloaded keeps the fleet's default token: issue a new default token to take it back.",
    );
    expect(within(linksSection()).getByText(KUBERNETES_INSTALL_LINKS_EMPTY_HINT)).toBeInTheDocument();
    expect(KUBERNETES_INSTALL_LINKS_EMPTY_HINT).toBe("Links appear here when you make a Quick Deploy command in the Helm install dialog.");
    expect(within(linksSection()).queryByText(INSTALL_LINKS_HELP)).toBeNull();
    const tokenReads = served.getEnrollmentTokens.mock.calls.length;
    await poll();
    await waitFor(() => expect(linkReads(served)).toBe(2));
    expect(served.getEnrollmentTokens).toHaveBeenCalledTimes(tokenReads + 1);
  });

  it("shows Install links on a server fleet", async () => {
    serve();
    renderTab(fleetDetail({ type: "server" }));
    expect(await screen.findByRole("heading", { name: "Install links" })).toBeInTheDocument();
  });

  it('shows "Loading install links…" until the first read answers, then the empty state', async () => {
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    const { getQuickDeployLinks } = serve();
    renderTab();
    expect(await screen.findByText("Loading install links…")).toBeInTheDocument();
    api.hold = null;
    await act(async () => release());
    expect(await screen.findByText(INSTALL_LINKS_EMPTY)).toBeInTheDocument();
    expect(INSTALL_LINKS_EMPTY).toBe("No install links for this fleet yet.");
    expect(screen.getByText(INSTALL_LINKS_EMPTY_HINT)).toBeInTheDocument();
    expect(INSTALL_LINKS_EMPTY_HINT).toBe("Links appear here when you make a Quick Deploy command in the install dialog.");
    expect(screen.queryByText("Loading install links…")).toBeNull();
    expect(getQuickDeployLinks).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { limit: 50 }, expect.anything());
  });

  it("lists each link between the tokens and the History: who made it, the group, the install, its dates, its status and its downloads", async () => {
    const first = linkNumbered(1, { downloadCount: 3, lastDownloadedAt: new Date(NOW - 5 * 60_000 - 1000).toISOString() });
    const second = linkNumbered(2, {
      groupName: null,
      createdBy: null,
      expiresAt: null,
      choices: { method: "own-binary", arch: "arm64", rootPath: "/opt/otel", executablePath: "/usr/bin/otelcol-contrib", systemd: false, envNames: [] },
    });
    api.links = [first, second];
    serve();
    renderTab();
    await screen.findByRole("button", { name: `View ${linkName(first)}` });
    expect(within(linksSection()).getByText(INSTALL_LINKS_HELP)).toBeInTheDocument();
    expect(INSTALL_LINKS_HELP).toBe(
      "Quick Deploy links made when installing collectors. Revoke a link to stop further downloads; collectors already installed are unaffected.",
    );
    expect(within(linksTable()).getAllByRole("columnheader").map((each) => each.textContent)).toEqual([
      "Created by",
      "Group",
      "Install",
      "Created",
      "Expires",
      "Status",
      "Downloads",
      "Last downloaded",
      "Actions",
    ]);
    expect(linkRows().map((row) => linkCells(row).slice(0, 8))).toEqual([
      [CREATOR.email, "gateways", "All In One (amd64) · systemd", formatDateTime(first.createdAt), formatDateTime(first.expiresAt), "Active", "3", "5 minutes ago"],
      ["—", "A deleted group", "Own otelcol-contrib (arm64)", formatDateTime(second.createdAt), "Never", "Group deleted", "0", "—"],
    ]);
    // Between the tokens' table and the History.
    const tokensTable = screen.getAllByRole("table")[0]!;
    const historyHeading = screen.getByRole("heading", { name: "History" });
    expect(tokensTable.compareDocumentPosition(linksSection()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(linksSection().compareDocumentPosition(historyHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No secret, no Copy, no masked token (`first8****`).
    expect(document.body).not.toHaveTextContent(/\*\*\*\*|Copy|tqd_/);
  });

  it("shows each status with its actions: Active and Expired every action, Token revoked and Group deleted no Extend, Revoked View only, an expired link whose token is revoked or whose group is deleted no Extend (Rulings 39 and 47)", async () => {
    api.tokens = [...api.tokens, listedToken({ id: OLD_DEFAULT_ID, kind: "default", revokedAt: new Date(NOW - DAY).toISOString(), createdAt: new Date(NOW - 99 * DAY).toISOString() })];
    const active = linkNumbered(1);
    const expired = linkNumbered(30);
    const tokenRevoked = linkNumbered(3, { defaultTokenId: OLD_DEFAULT_ID });
    const revoked = linkNumbered(4, { revokedAt: new Date(NOW - HOUR).toISOString(), status: "revoked" });
    // Expired, and its token revoked too: extending it can't make it download.
    const expiredTokenRevoked = linkNumbered(31, { defaultTokenId: OLD_DEFAULT_ID });
    // Expired, its token gone from the list altogether.
    const expiredTokenGone = linkNumbered(32, { defaultTokenId: "c0ffee00-0000-4000-8000-0000000000ff" });
    // Its group deleted: the download refuses it for good (Ruling 47); its token revoked too, Token revoked first.
    const groupDeleted = linkNumbered(5, { groupName: null });
    const groupDeletedTokenRevoked = linkNumbered(6, { groupName: null, defaultTokenId: OLD_DEFAULT_ID });
    const expiredGroupDeleted = linkNumbered(33, { groupName: null });
    api.links = [active, tokenRevoked, revoked, groupDeleted, groupDeletedTokenRevoked, expired, expiredTokenRevoked, expiredTokenGone, expiredGroupDeleted];
    serve();
    renderTab();
    await screen.findByRole("button", { name: `View ${linkName(active)}` });
    expect(linkRows().map((row) => linkCells(row)[5])).toEqual([
      "Active",
      "Token revoked",
      "Revoked",
      "Group deleted",
      "Token revoked",
      "Expired",
      "Expired",
      "Expired",
      "Expired",
    ]);
    const actions = (link: QuickDeployLink) => within(rowOf(link)).getAllByRole("button").map((each) => each.textContent);
    expect(actions(active)).toEqual(["View", "Extend", "Revoke"]);
    expect(actions(expired)).toEqual(["View", "Extend", "Revoke"]);
    expect(actions(tokenRevoked)).toEqual(["View", "Revoke"]);
    expect(actions(revoked)).toEqual(["View"]);
    expect(actions(expiredTokenRevoked)).toEqual(["View", "Revoke"]);
    expect(actions(expiredTokenGone)).toEqual(["View", "Revoke"]);
    expect(actions(groupDeleted)).toEqual(["View", "Revoke"]);
    expect(actions(groupDeletedTokenRevoked)).toEqual(["View", "Revoke"]);
    expect(actions(expiredGroupDeleted)).toEqual(["View", "Revoke"]);
    // Group deleted is an outline badge, as Token revoked and Expired.
    expect(within(rowOf(groupDeleted)).getByText("Group deleted").className).toBe(within(rowOf(tokenRevoked)).getByText("Token revoked").className);
    // Each named by its creation only.
    for (const verb of ["View", "Extend", "Revoke"]) expect(button(`${verb} ${linkName(expired)}`)).toBeInTheDocument();
  });

  it("names two links made in the same minute apart: their creation to the second, still no name, path or email (Ruling 39)", async () => {
    const minute = Math.floor((NOW - 2 * HOUR) / 60_000) * 60_000;
    const later = linkNumbered(1, { createdAt: new Date(minute + 42_000).toISOString() });
    const earlier = linkNumbered(2, { createdAt: new Date(minute + 7_000).toISOString() });
    api.links = [later, earlier];
    serve();
    renderTab();
    await screen.findByRole("button", { name: `View ${linkName(later)}` });
    // One minute: the Created cells read the same, the names apart.
    expect(linkCells(linkRows()[0]!)[3]).toBe(linkCells(linkRows()[1]!)[3]);
    expect(linkName(later)).not.toBe(linkName(earlier));
    expect(linkName(later)).toMatch(/^the install link created [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:42 [AP]M$/);
    for (const verb of ["View", "Extend", "Revoke"]) {
      expect(screen.getAllByRole("button", { name: `${verb} ${linkName(later)}` })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: `${verb} ${linkName(earlier)}` })).toHaveLength(1);
      expect(within(rowOf(earlier)).getByRole("button", { name: `${verb} ${linkName(earlier)}` })).toBeInTheDocument();
    }
  });

  it('shows a failed first read ("Failed to load install links") with Try again, which reads again; a later failed read toasts it and keeps the rows', async () => {
    api.links = [linkNumbered(1)];
    api.linkFailures = [UNAVAILABLE()];
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const user = renderTab();
    expect(await within(linksSection()).findByText(INSTALL_LINKS_FAILED_MESSAGE)).toBeInTheDocument();
    expect(INSTALL_LINKS_FAILED_MESSAGE).toBe("Failed to load install links");
    expect(screen.getByRole("button", { name: "Reveal the default token" })).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
    await user.click(within(linksSection()).getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: `View ${linkName(api.links[0]!)}` });
    expect(linkReads(served)).toBe(2);

    api.linkFailures = [UNAVAILABLE()];
    await user.click(button("Refresh tokens"));
    await waitFor(() => expect(error).toHaveBeenCalledWith(INSTALL_LINKS_FAILED_MESSAGE));
    expect(error).toHaveBeenCalledTimes(1);
    expect(button(`View ${linkName(api.links[0]!)}`)).toBeInTheDocument();
  });

  it('pages 50 at a time with "Load more"; a poll leaves the links alone after it, and Refresh reads the first page again', async () => {
    api.links = Array.from({ length: 60 }, (_, index) => linkNumbered(index + 1));
    const served = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: `View ${linkName(api.links[0]!)}` });
    expect(linkRows()).toHaveLength(50);
    await user.click(within(linksSection()).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(linkRows()).toHaveLength(60));
    expect(served.getQuickDeployLinks).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, { limit: 50, cursor: "50" }, expect.anything());
    expect(within(linksSection()).queryByRole("button", { name: "Load more" })).toBeNull();
    const reads = linkReads(served);
    await poll();
    expect(linkReads(served)).toBe(reads);
    expect(linkRows()).toHaveLength(60);
    await user.click(button("Refresh tokens"));
    await waitFor(() => expect(linkRows()).toHaveLength(50));
    expect(served.getQuickDeployLinks).toHaveBeenLastCalledWith(GROUP_ID, FLEET_ID, { limit: 50 }, expect.anything());
  });

  it("polls the links with the tab every 15 s, a row following, and pauses while each link dialog is open", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    const served = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: `View ${linkName(link)}` });
    api.links = [{ ...link, downloadCount: 4 }];
    await poll();
    await waitFor(() => expect(linkCells(rowOf(link))[6]).toBe("4"));

    for (const [verb, role] of [
      ["View", "dialog"],
      ["Extend", "dialog"],
      ["Revoke", "alertdialog"],
    ] as const) {
      await user.click(button(`${verb} ${linkName(link)}`));
      await screen.findByRole(role);
      const reads = linkReads(served);
      await poll();
      expect(linkReads(served)).toBe(reads);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    }
  });
});

describe("TokensTab's install link View (D17c-2 decisions 31 and 32; Preflight ruling 24)", () => {
  it("shows what the link installs and its variables' names each set, inside ph-no-capture, with no request, no value and no secret", async () => {
    const link = linkNumbered(1, {
      choices: {
        method: "own-binary",
        arch: "arm64",
        rootPath: "/opt/otel",
        executablePath: "/usr/local/bin/otelcol-contrib",
        systemd: false,
        envNames: ["NGINX_ENV", "API_KEY"],
      },
    });
    api.links = [link];
    const served = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: `View ${linkName(link)}` }));
    const reads = [served.getEnrollmentTokens.mock.calls.length, served.getEnrollmentTokenEvents.mock.calls.length, linkReads(served)];
    const dialog = await screen.findByRole("dialog", { name: "Install link" });
    const body = dialog.querySelector(".ph-no-capture") as HTMLElement;
    expect(body).not.toBeNull();
    expect(within(body).getAllByRole("term").map((each) => each.textContent)).toEqual(["Group", "Install", "Root path", "Executable path"]);
    expect(within(body).getAllByRole("definition").map((each) => each.textContent)).toEqual([
      "gateways",
      "Own otelcol-contrib (arm64)",
      "/opt/otel",
      "/usr/local/bin/otelcol-contrib",
    ]);
    expect(body).toHaveTextContent("Systemd service: no");
    expect(within(body).getAllByRole("listitem").map((each) => each.textContent)).toEqual(["NGINX_ENVset", "API_KEYset"]);
    for (const text of ["/opt/otel", "/usr/local/bin/otelcol-contrib", "NGINX_ENV", "API_KEY"]) expectTextOnlyInsideNoCapture(text);
    expect(document.body).not.toHaveTextContent(QUICK_DEPLOY_SECRET);
    expect(document.body).not.toHaveTextContent(QUICK_DEPLOY_URL);
    expect(dialog).not.toHaveTextContent(/curl|opamp\.env|export /);
    expect([served.getEnrollmentTokens.mock.calls.length, served.getEnrollmentTokenEvents.mock.calls.length, linkReads(served)]).toEqual(reads);
    expect(served.extendQuickDeployLink).not.toHaveBeenCalled();
    expect(served.revokeQuickDeployLink).not.toHaveBeenCalled();

    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((each) => each.textContent === "Close")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await linkFocusIsOn(() => button(`View ${linkName(link)}`));
  });

  it('shows "Systemd service: yes", no executable path for All In One, and "None." with no variables', async () => {
    const link = linkNumbered(1, { choices: { ...quickDeployLink().choices, envNames: [] } });
    api.links = [link];
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: `View ${linkName(link)}` }));
    const dialog = await screen.findByRole("dialog", { name: "Install link" });
    expect(dialog).toHaveTextContent("Systemd service: yes");
    expect(within(dialog).queryByText("Executable path")).toBeNull();
    expect(within(dialog).getByText("None.")).toBeInTheDocument();
    expect(within(dialog).getByText("All In One (amd64) · systemd")).toBeInTheDocument();
  });
});

describe("TokensTab's install link Extend (D17c-2 decisions 5 and 31; Preflight rulings 24 and 25)", () => {
  const radios = (dialog: HTMLElement) => within(dialog).getAllByRole("radio");
  const openExtend = async (user: ReturnType<typeof userEvent.setup>, link: QuickDeployLink) => {
    await user.click(await screen.findByRole("button", { name: `Extend ${linkName(link)}` }));
    return screen.findByRole("dialog", { name: "Extend install link" });
  };

  it("offers the six presets as native radios, 1 day chosen, in the spec's words", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    serve();
    const user = renderTab();
    const dialog = await openExtend(user, link);
    expect(dialog).toHaveTextContent(EXTEND_DESCRIPTION);
    expect(EXTEND_DESCRIPTION).toBe("Set a new expiry, counted from now.");
    expect(radios(dialog).map((each) => each.closest("label")!.textContent)).toEqual(["1 day", "1 week", "1 month", "180 days", "1 year", "Never"]);
    expect(within(dialog).getByRole("radio", { name: "1 day" })).toBeChecked();
    expect(radios(dialog).filter((each) => (each as HTMLInputElement).checked)).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Extend" })).toBeEnabled();
  });

  it("extends an expired link by the chosen preset: toasted, closed, the tab read again with the row Active and Never, the fleet not read again", async () => {
    const link = linkNumbered(30);
    api.links = [link];
    const success = vi.spyOn(toast, "success");
    const served = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: `View ${linkName(link)}` });
    expect(linkCells(rowOf(link))[5]).toBe("Expired");
    const dialog = await openExtend(user, link);
    await user.click(within(dialog).getByRole("radio", { name: "Never" }));
    const reads = linkReads(served);
    await user.click(within(dialog).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(served.extendQuickDeployLink).toHaveBeenCalledTimes(1);
    expect(served.extendQuickDeployLink).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, link.id, "never", expect.anything());
    expect(success).toHaveBeenCalledWith(EXTENDED_MESSAGE);
    expect(EXTENDED_MESSAGE).toBe("Install link extended");
    await waitFor(() => expect(linkCells(rowOf(link))[4]).toBe("Never"));
    expect(linkCells(rowOf(link))[5]).toBe("Active");
    expect(linkReads(served)).toBe(reads + 1);
    expect(onFleetChanged).not.toHaveBeenCalled();
    await linkFocusIsOn(() => button(`Extend ${linkName(link)}`));
  });

  it("sends 1 day when Extend is pressed without a choice: the new expiry a day from now, not from the old one", async () => {
    const link = linkNumbered(30);
    api.links = [link];
    const served = serve();
    const user = renderTab();
    const dialog = await openExtend(user, link);
    const before = Date.now();
    await user.click(within(dialog).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const after = Date.now();
    expect(served.extendQuickDeployLink).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, link.id, "1d", expect.anything());
    const expiresAt = Date.parse(api.links[0]!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + DAY);
    expect(expiresAt).toBeLessThanOrEqual(after + DAY);
    await waitFor(() => expect(linkCells(rowOf(link))[4]).toBe(formatDateTime(api.links[0]!.expiresAt)));
  });

  it("chooses 1 day again at each opening, whatever the last one chose", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    serve();
    const user = renderTab();
    let dialog = await openExtend(user, link);
    await user.click(within(dialog).getByRole("radio", { name: "1 year" }));
    expect(within(dialog).getByRole("radio", { name: "1 year" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = await openExtend(user, link);
    expect(within(dialog).getByRole("radio", { name: "1 day" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "1 year" })).not.toBeChecked();
  });

  it.each([
    ["a 429, with its words", () => new ApiError("rate_limited", "Too many attempts. Please wait and try again.", { status: 429, retryAfterSeconds: 30 }), "Too many attempts. Please wait and try again."],
    ["any other refusal, with the fallback", () => new ApiError("invalid_request", "The request was not valid.", { status: 400 }), EXTEND_FAILED_MESSAGE],
  ])("keeps the dialog open and reloads nothing on a rejected extend: %s", async (_name, failure, message) => {
    const link = linkNumbered(1);
    api.links = [link];
    api.linkWriteFailures = [failure()];
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    const served = serve();
    const user = renderTab();
    const dialog = await openExtend(user, link);
    const reads = linkReads(served);
    await user.click(within(dialog).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(message));
    expect(EXTEND_FAILED_MESSAGE).toBe("Failed to extend the install link");
    expect(screen.getByRole("dialog", { name: "Extend install link" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Extend" })).toBeEnabled();
    expect(success).not.toHaveBeenCalled();
    expect(linkReads(served)).toBe(reads);
  });

  it("shows quick_deploy_link_revoked in the dialog, takes Extend away and reads the tab again: the row Revoked, the focus back on its View", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    const served = serve();
    const user = renderTab();
    const dialog = await openExtend(user, link);
    // Another member revoked it meanwhile.
    api.links = [{ ...link, revokedAt: new Date().toISOString(), status: "revoked" }];
    const reads = linkReads(served);
    await user.click(within(dialog).getByRole("button", { name: "Extend" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_revoked);
    expect(within(dialog).queryByRole("button", { name: "Extend" })).toBeNull();
    await waitFor(() => expect(linkReads(served)).toBe(reads + 1));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(linkCells(rowOf(link))[5]).toBe("Revoked");
    await linkFocusIsOn(() => button(`View ${linkName(link)}`));
  });

  it("toasts a link gone (404), closes and reads the tab again: the row gone, the focus on the first row's View", async () => {
    const [newer, gone] = [linkNumbered(1), linkNumbered(2)];
    api.links = [newer, gone];
    const error = vi.spyOn(toast, "error");
    serve();
    const user = renderTab();
    const dialog = await openExtend(user, gone);
    api.links = [newer];
    await user.click(within(dialog).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledWith(QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_not_found);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    await linkFocusIsOn(() => button(`View ${linkName(newer)}`));
  });

  it("toasts an unknown outcome's words, closes and reads the tab again", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    api.linkWriteFailures = [UNAVAILABLE()];
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const user = renderTab();
    const dialog = await openExtend(user, link);
    const reads = linkReads(served);
    await user.click(within(dialog).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
    await waitFor(() => expect(linkReads(served)).toBe(reads + 1));
  });

  it('says "Extending…" while it runs, Cancel and the presets disabled and Escape doing nothing; a double click sends once', async () => {
    const link = linkNumbered(1);
    api.links = [link];
    let release!: () => void;
    api.linkWriteHold = new Promise((resolve) => (release = resolve));
    const served = serve();
    const user = renderTab();
    const dialog = await openExtend(user, link);
    await user.dblClick(within(dialog).getByRole("button", { name: "Extend" }));
    expect(await within(dialog).findByRole("button", { name: "Extending…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    for (const radio of radios(dialog)) expect(radio).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Extend install link" })).toBeInTheDocument();
    api.linkWriteHold = null;
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(served.extendQuickDeployLink).toHaveBeenCalledTimes(1);
  });

  it("drops an extend's late answer once the organization has changed: the dialog closed, nothing toasted", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    let release!: () => void;
    api.linkWriteHold = new Promise((resolve) => (release = resolve));
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    serve();
    const user = renderTab();
    const dialog = await openExtend(user, link);
    await user.click(within(dialog).getByRole("button", { name: "Extend" }));
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    api.linkWriteHold = null;
    await act(async () => release());
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("TokensTab's install link Revoke (D17c-2 decision 31; Preflight ruling 24)", () => {
  const openRevoke = async (user: ReturnType<typeof userEvent.setup>, link: QuickDeployLink) => {
    await user.click(await screen.findByRole("button", { name: `Revoke ${linkName(link)}` }));
    return screen.findByRole("alertdialog", { name: "Revoke this install link?" });
  };

  it("revokes after confirming: the spec's words, toasted, the row Revoked with View alone, the focus on its View, the fleet not read again", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    const success = vi.spyOn(toast, "success");
    const served = serve();
    const user = renderTab();
    const dialog = await openRevoke(user, link);
    expect(dialog).toHaveTextContent(REVOKE_LINK_WORDS);
    expect(REVOKE_LINK_WORDS).toBe(
      'Revoking stops further downloads at once: a host that runs the command afterwards gets "revoked". Collectors already installed keep running. The link stays listed for the record and can\'t be re-enabled: make a new one instead.',
    );
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    const reads = linkReads(served);
    await user.click(within(dialog).getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(served.revokeQuickDeployLink).toHaveBeenCalledTimes(1);
    expect(served.revokeQuickDeployLink).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, link.id, expect.anything());
    expect(success).toHaveBeenCalledWith(LINK_REVOKED_MESSAGE);
    expect(LINK_REVOKED_MESSAGE).toBe("Install link revoked");
    await waitFor(() => expect(linkCells(rowOf(link))[5]).toBe("Revoked"));
    expect(within(rowOf(link)).getAllByRole("button").map((each) => each.textContent)).toEqual(["View"]);
    expect(linkReads(served)).toBe(reads + 1);
    expect(onFleetChanged).not.toHaveBeenCalled();
    await linkFocusIsOn(() => button(`View ${linkName(link)}`));
  });

  it('says "Revoking…" while it runs, Cancel disabled and Escape doing nothing; a double click sends once', async () => {
    const link = linkNumbered(1);
    api.links = [link];
    let release!: () => void;
    api.linkWriteHold = new Promise((resolve) => (release = resolve));
    const served = serve();
    const user = renderTab();
    const dialog = await openRevoke(user, link);
    await user.dblClick(within(dialog).getByRole("button", { name: "Revoke link" }));
    expect(await within(dialog).findByRole("button", { name: "Revoking…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    api.linkWriteHold = null;
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(served.revokeQuickDeployLink).toHaveBeenCalledTimes(1);
  });

  it("toasts a link gone (404), closes and reads the tab again; with no row left the focus goes to Refresh tokens", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    const error = vi.spyOn(toast, "error");
    serve();
    const user = renderTab();
    const dialog = await openRevoke(user, link);
    api.links = [];
    await user.click(within(dialog).getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(error).toHaveBeenCalledWith(QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_not_found);
    expect(await screen.findByText(INSTALL_LINKS_EMPTY)).toBeInTheDocument();
    await linkFocusIsOn(() => button("Refresh tokens"));
  });

  it("keeps the dialog open on a refusal, with its words or the fallback", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    api.linkWriteFailures = [new ApiError("invalid_request", "The request was not valid.", { status: 400 })];
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const user = renderTab();
    const dialog = await openRevoke(user, link);
    const reads = linkReads(served);
    await user.click(within(dialog).getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(REVOKE_LINK_FAILED_MESSAGE));
    expect(REVOKE_LINK_FAILED_MESSAGE).toBe("Failed to revoke the install link");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(linkReads(served)).toBe(reads);
  });
});

describe("TokensTab's install link dialogs as they close (D17c-2 Preflight ruling 23)", () => {
  it.each([
    ["View", "dialog"],
    ["Extend", "dialog"],
    ["Revoke", "alertdialog"],
  ] as const)("returns to the row's %s after its dialog closes by Escape", async (verb, role) => {
    const link = linkNumbered(1);
    api.links = [linkNumbered(0), link];
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: `${verb} ${linkName(link)}` }));
    await screen.findByRole(role);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    await linkFocusIsOn(() => button(`${verb} ${linkName(link)}`));
  });

  it("closes a link dialog when the organization changes", async () => {
    const link = linkNumbered(1);
    api.links = [link];
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: `Revoke ${linkName(link)}` }));
    await screen.findByRole("alertdialog");
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

// Ruling 39: a poll begun before a link dialog opened, answering while it is open. The dialog keeps the opening's
// link (its snapshot), the row behind it follows the read.
describe("TokensTab's install link dialogs while a poll lands", () => {
  it.each([
    ["View", "dialog"],
    ["Extend", "dialog"],
    ["Revoke", "alertdialog"],
  ] as const)("%s keeps the opening's link; the row updates behind it", async (verb, role) => {
    const opened = linkNumbered(1, { groupName: "first-group", choices: { ...linuxChoices(), rootPath: "/first/root" } });
    api.links = [opened];
    const served = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: `View ${linkName(opened)}` });
    const reads = linkReads(served);

    // The poll's reads begin, held; the link changes meanwhile (another member's doing).
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    await poll();
    await waitFor(() => expect(linkReads(served)).toBe(reads + 1));
    const later = { ...opened, groupName: "later-group", choices: { ...linuxChoices(), rootPath: "/later/root" }, downloadCount: 7 };
    api.links = [later];

    await user.click(button(`${verb} ${linkName(opened)}`));
    const dialog = await screen.findByRole(role);
    api.hold = null;
    await act(async () => release());

    // The row behind the dialog shows the poll's answer (hidden from the tree while the dialog is modal).
    const hiddenSection = () => screen.getByRole("heading", { name: "Install links", hidden: true }).closest("section") as HTMLElement;
    await waitFor(() => expect(within(hiddenSection()).getByText("later-group")).toBeInTheDocument());
    expect(within(hiddenSection()).queryByText("first-group")).toBeNull();
    // The dialog is still the opening's: open, and showing (View) or sending (Extend, Revoke) the link it opened with.
    expect(screen.getByRole(role)).toBe(dialog);
    if (verb === "View") {
      expect(dialog).toHaveTextContent("first-group");
      expect(dialog).toHaveTextContent("/first/root");
      expect(dialog).not.toHaveTextContent(/later-group|\/later\/root/);
    } else {
      await user.click(within(dialog).getByRole("button", { name: verb === "Extend" ? "Extend" : "Revoke link" }));
      const write = verb === "Extend" ? served.extendQuickDeployLink : served.revokeQuickDeployLink;
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(write.mock.calls[0]![2]).toBe(opened.id);
    }
  });
});

// The rulings' snapshot (D17c-1 Ruling 66): a dialog's link is the opening's, never a prop a parent's reload changes.
describe("each install link dialog keeps the link its opening found", () => {
  function renderDialog(Dialog: (props: { link: QuickDeployLink }) => ReactNode, first: QuickDeployLink) {
    let setLink: (link: QuickDeployLink) => void = () => {};
    function Host() {
      const [link, set] = useState(first);
      useEffect(() => {
        setLink = set;
      }, []);
      return <Dialog link={link} />;
    }
    const Stub = createRoutesStub([{ path: "/", Component: Host }]);
    render(<Stub initialEntries={["/"]} />);
    return { user: userEvent.setup(), setLink: (link: QuickDeployLink) => act(() => setLink(link)) };
  }
  const opened = linkNumbered(1, { groupName: "first-group", choices: { ...linuxChoices(), rootPath: "/first/root" } });
  const later = linkNumbered(2, { groupName: "later-group", choices: { ...linuxChoices(), rootPath: "/later/root" } });

  it("View", async () => {
    serve();
    const { setLink } = renderDialog(({ link }) => <InstallLinkDialog open onOpenChange={() => {}} link={link} />, opened);
    const dialog = await screen.findByRole("dialog", { name: "Install link" });
    setLink(later);
    expect(dialog).toHaveTextContent("first-group");
    expect(dialog).toHaveTextContent("/first/root");
    expect(dialog).not.toHaveTextContent(/later-group|\/later\/root/);
  });

  it.each(["Extend", "Revoke"] as const)("%s sends the opening's link", async (which) => {
    api.links = [opened, later];
    const served = serve();
    const { user, setLink } = renderDialog(
      ({ link }) =>
        which === "Extend" ? (
          <ExtendInstallLinkDialog open onOpenChange={() => {}} link={link} organizationId={GROUP_ID} fleetId={FLEET_ID} onChanged={() => {}} />
        ) : (
          <RevokeInstallLinkDialog open onOpenChange={() => {}} link={link} organizationId={GROUP_ID} fleetId={FLEET_ID} onRevoked={() => {}} />
        ),
      opened,
    );
    const dialog = await screen.findByRole(which === "Extend" ? "dialog" : "alertdialog");
    setLink(later);
    await user.click(within(dialog).getByRole("button", { name: which === "Extend" ? "Extend" : "Revoke link" }));
    const write = which === "Extend" ? served.extendQuickDeployLink : served.revokeQuickDeployLink;
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0]![2]).toBe(opened.id);
  });
});

// Decision 32 (ADR 0024): no group name, path, variable name or email in an attribute or the title; paths and names only inside ph-no-capture; no secret or value anywhere.
// D17d-2 decision 22; Preflight ruling 30: a Kubernetes-supervisor fleet's Helm values links.
describe("TokensTab's Helm values links", () => {
  const kubernetes = () => fleetDetail({ type: "kubernetes-supervisor" });
  const helmChoices = (role: "node" | "cluster" | "gateway", release: string): QuickDeployHelmChoices => ({
    kind: "helm",
    role,
    release,
    namespace: "observability",
    envNames: ["NGINX_ENV"],
  });

  it("lists each Helm link: Install Helm values, the Group by its role (Agent, Cluster) or the gateway's name, A deleted group once gone", async () => {
    const agent = linkNumbered(1, { groupName: "Default", choices: helmChoices("node", "telflo-node") });
    const cluster = linkNumbered(2, { groupName: "cluster", choices: helmChoices("cluster", "telflo-cluster") });
    const gateway = linkNumbered(3, { choices: helmChoices("gateway", "gateways") });
    const gone = linkNumbered(4, { groupName: null, choices: helmChoices("gateway", "old-pool") });
    api.links = [agent, cluster, gateway, gone];
    serve();
    renderTab(kubernetes());
    await screen.findByRole("button", { name: `View ${linkName(agent)}` });
    expect([agent, cluster, gateway, gone].map((link) => linkCells(rowOf(link)).slice(1, 3))).toEqual([
      ["Agent", "Helm values"],
      ["Cluster", "Helm values"],
      ["gateways", "Helm values"],
      ["A deleted group", "Helm values"],
    ]);
    expect(linkCells(rowOf(gone))[5]).toBe("Group deleted");
    expect(linksTable()).not.toHaveTextContent("Default");
  });

  it("shows a Helm link's View: Group, Install, Release, Namespace and its variables, inside ph-no-capture, no root path or systemd", async () => {
    const link = linkNumbered(1, { groupName: "Default", choices: helmChoices("node", "telflo-node") });
    api.links = [link];
    serve();
    const user = renderTab(kubernetes());
    await user.click(await screen.findByRole("button", { name: `View ${linkName(link)}` }));
    const dialog = await screen.findByRole("dialog", { name: "Install link" });
    const body = dialog.querySelector(".ph-no-capture") as HTMLElement;
    expect(within(body).getAllByRole("term").map((each) => each.textContent)).toEqual(["Group", "Install", "Release", "Namespace"]);
    expect(within(body).getAllByRole("definition").map((each) => each.textContent)).toEqual(["Agent", "Helm values", "telflo-node", "observability"]);
    expect(within(body).getAllByRole("listitem").map((each) => each.textContent)).toEqual(["NGINX_ENVset"]);
    expect(dialog).not.toHaveTextContent(/Root path|Systemd/);
    expect(expectTextOnlyInsideNoCapture("observability")).toBe(1);
  });

  it("extends and revokes a Helm link as a Linux one, the revoke saying a downloaded values.yaml keeps the token", async () => {
    const link = linkNumbered(1, { choices: helmChoices("gateway", "gateways") });
    api.links = [link];
    const served = serve();
    const user = renderTab(kubernetes());
    await user.click(await screen.findByRole("button", { name: `Extend ${linkName(link)}` }));
    const extend = await screen.findByRole("dialog", { name: "Extend install link" });
    await user.click(within(extend).getByRole("button", { name: "Extend" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(served.extendQuickDeployLink).toHaveBeenCalledTimes(1);

    await user.click(button(`Revoke ${linkName(link)}`));
    const revoke = await screen.findByRole("alertdialog", { name: "Revoke this install link?" });
    expect(revoke).toHaveAccessibleDescription(`${REVOKE_LINK_WORDS} ${REVOKE_HELM_LINK_WORDS}`);
    expect(REVOKE_HELM_LINK_WORDS).toBe("A values.yaml already downloaded still holds the fleet's default token.");
    await user.click(within(revoke).getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(served.revokeQuickDeployLink).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, link.id, expect.anything());
  });

  it("keeps a Helm link's gateway name, release, namespace and variables' names out of every attribute, each link dialog open", async () => {
    const gateway = "canary-helm-gateway-2a7c";
    const namespace = "canary-helm-namespace-6d1e";
    const variable = "CANARY_HELM_VAR_8b3f";
    const link = linkNumbered(1, { groupName: gateway, choices: { kind: "helm", role: "gateway", release: gateway, namespace, envNames: [variable] } });
    api.links = [link];
    serve();
    const user = renderTab(kubernetes());
    await screen.findByRole("button", { name: `View ${linkName(link)}` });
    for (const text of [gateway, namespace, variable]) expectNoAttributeHolds(text);
    for (const [verb, role] of [
      ["View", "dialog"],
      ["Extend", "dialog"],
      ["Revoke", "alertdialog"],
    ] as const) {
      await user.click(button(`${verb} ${linkName(link)}`));
      await screen.findByRole(role);
      for (const text of [gateway, namespace, variable]) expectNoAttributeHolds(text);
      if (verb === "View") for (const text of [namespace, variable]) expect(expectTextOnlyInsideNoCapture(text)).toBe(1);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    }
  });
});

describe("TokensTab's install links' privacy", () => {
  it("keeps the links' group names, paths, variables' names and emails out of every attribute and the title, with populated rows and each link dialog open", async () => {
    const group = "canary-group-links-4be1";
    const email = "canary-member-links-90d3@example.com";
    const root = "/canary/root-links-77c2";
    const executable = "/canary/bin/otelcol-links-1f0a";
    const variable = "CANARY_LINK_VAR_3d5e";
    const link = linkNumbered(1, {
      groupName: group,
      createdBy: { ...CREATOR, email },
      choices: { method: "own-binary", arch: "amd64", rootPath: root, executablePath: executable, systemd: true, envNames: [variable] },
    });
    api.links = [link, linkNumbered(2, { groupName: group, createdBy: { ...CREATOR, email } })];
    serve();
    const user = renderTab();
    await screen.findByRole("button", { name: `View ${linkName(link)}` });
    expect(within(linksTable()).getAllByText(group)).toHaveLength(2);
    expect(within(linksTable()).getAllByText(email)).toHaveLength(2);
    const canaries = [group, email, root, executable, variable];
    const expectCanariesInNoAttribute = () => {
      for (const text of canaries) {
        expectNoAttributeHolds(text);
        expect(document.title, "document.title").not.toContain(text);
      }
      for (const secret of [QUICK_DEPLOY_SECRET, QUICK_DEPLOY_URL, "tqd_"]) {
        expect(document.documentElement.outerHTML).not.toContain(secret);
      }
    };
    expectCanariesInNoAttribute();
    // The paths and the variables' names are not in the rows.
    for (const text of [root, executable, variable]) expect(document.body).not.toHaveTextContent(text);

    for (const [verb, role] of [
      ["View", "dialog"],
      ["Extend", "dialog"],
      ["Revoke", "alertdialog"],
    ] as const) {
      await user.click(button(`${verb} ${linkName(link)}`));
      await screen.findByRole(role);
      expectCanariesInNoAttribute();
      if (verb === "View") {
        for (const text of [root, executable, variable]) expect(expectTextOnlyInsideNoCapture(text)).toBe(1);
      }
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    }
    for (const text of [root, executable, variable]) expect(document.body).not.toHaveTextContent(text);
    expectCanariesInNoAttribute();
  });
});
