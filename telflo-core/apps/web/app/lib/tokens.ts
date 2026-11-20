import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import type { EnrollmentTokenEvent, EnrollmentTokenListed, EnrollmentTokensResponse, QuickDeployLink } from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import { isSessionEnded, type PageQuery } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import {
  FLEET_READ_TIMEOUT_MS,
  FLEETS_POLL_INTERVAL_MS,
  isFleetGone,
  isStaleCursor,
  useReadOrder,
  useTermsRequired,
} from "~/lib/fleets.js";
import { useVisiblePolling } from "~/lib/hooks/use-visible-polling.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { readsFor } from "~/lib/workspace-reads.js";

/*
 * A server fleet's Tokens tab's data: the fleet's tokens, its token history
 * and its install links (quick-deploy links), polled every 15 seconds while
 * the tab is visible, a token's status by the opamp-server's own rules, and a
 * link's. Nothing here puts a member's email, a group's name or a link's paths
 * anywhere but the data it returns, and no bearer or link secret passes
 * through it: the tokens list, the history and the links list carry none.
 */

/** The toast of a person's read whose tokens failed over rows shown, and the tokens' failed state's words. */
export const TOKENS_LOAD_FAILED_MESSAGE = "Failed to load tokens";

/** The same for the history: its failed state's words, and the toast of a failed "Load more". */
export const TOKEN_HISTORY_FAILED_MESSAGE = "Failed to load the token history";

/** How many events a page of the history holds. */
export const TOKEN_HISTORY_PAGE_SIZE = 50;

/** The same for the install links: their failed state's words, and the toast of a later failure. */
export const INSTALL_LINKS_FAILED_MESSAGE = "Failed to load install links";

/** How many links a page of the install links holds. */
export const INSTALL_LINKS_PAGE_SIZE = 50;

/* ---------------------------------------------------------------------------
 * A token's status, by the opamp-server's rules (`store/enrollmenttokens`):
 * `Token.ValidAt` and `GetActiveRotate`. The collector details' Token row
 * (`CollectorTokenRow`) reads the same rules from here.
 */

type Token = Pick<EnrollmentTokenListed, "id" | "kind" | "expiresAt" | "revokedAt" | "doRefresh" | "createdAt">;

/** `Token.ValidAt`: not revoked, and no expiry or one after `now`. */
export function tokenValidAt(token: Pick<Token, "expiresAt" | "revokedAt">, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > now);
}

/**
 * `GetActiveRotate`'s order: `do_refresh` false first, then the newest
 * (`created_at desc`), then `id desc` (a uuid compares as its canonical
 * lowercase text does, by code units).
 */
function currentOrder(a: Token, b: Token): number {
  if (a.doRefresh !== b.doRefresh) return a.doRefresh ? 1 : -1;
  const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (created !== 0) return created;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The fleet's current rotate token at `now` (`GetActiveRotate`): the newest
 * valid rotate token not in a grace, else the newest valid one in a grace
 * (`doRefresh`); undefined when no rotate token is valid (the fleet is
 * suspended).
 */
export function currentRotateToken<T extends Token>(tokens: readonly T[], now: number): T | undefined {
  return tokens.filter((each) => each.kind === "rotate" && tokenValidAt(each, now)).sort(currentOrder)[0];
}

/**
 * A token's Status in the Tokens table, with its badge's variant
 * (`ui/badge.tsx`). "Being replaced" carries the token's expiry (`until`, an
 * instant, null for none), which the table shows as "until {date}".
 */
export type TokenStatus =
  | { label: "Revoked"; variant: "secondary" }
  | { label: "Expired"; variant: "outline" }
  | { label: "Valid"; variant: "secondary" }
  | { label: "Current"; variant: "success" }
  | { label: "Being replaced"; variant: "info"; until: string | null };

/**
 * `token`'s status among the fleet's `tokens` at `now`, in this order:
 * "Revoked"; "Expired" (at or past its expiry); "Valid" for the default
 * token; "Current" for the current rotate token (`currentRotateToken`);
 * "Being replaced" for any other valid rotate token (one a rotation is
 * replacing, its expiry capped at the grace's end). A revoked current token
 * hands "Current" to the token it was replacing, as the opamp-server does.
 */
export function tokenStatus(token: Token, tokens: readonly Token[], now: number): TokenStatus {
  if (token.revokedAt !== null) return { label: "Revoked", variant: "secondary" };
  if (!tokenValidAt(token, now)) return { label: "Expired", variant: "outline" };
  if (token.kind === "default") return { label: "Valid", variant: "secondary" };
  if (currentRotateToken(tokens, now)?.id === token.id) return { label: "Current", variant: "success" };
  return { label: "Being replaced", variant: "info", until: token.expiresAt };
}

/* ---------------------------------------------------------------------------
 * An install link's status.
 */

/** An install link's Status in Install Links, with its badge's variant. */
export type InstallLinkStatus =
  | { label: "Revoked"; variant: "secondary" }
  | { label: "Expired"; variant: "outline" }
  | { label: "Token revoked"; variant: "outline" }
  | { label: "Group deleted"; variant: "outline" }
  | { label: "Active"; variant: "success" };

/**
 * `link`'s status at `now`, among the fleet's `tokens` as the same read
 * gave them: "Revoked"; "Expired" (at or past its expiry); "Token revoked"
 * when the default token its command carries (`defaultTokenId`) is not
 * valid among those tokens (`tokenValidAt`; not among them at all
 * included), since the download refuses such a link; "Group deleted" when
 * its group is gone (the list's `groupName` null: the download refuses it
 * for good); else "Active". With the tokens unread (null) the link is
 * judged by its own times and its group.
 */
export function installLinkStatus(
  link: Pick<QuickDeployLink, "revokedAt" | "expiresAt" | "defaultTokenId" | "groupName">,
  tokens: readonly Pick<Token, "id" | "expiresAt" | "revokedAt">[] | null,
  now: number,
): InstallLinkStatus {
  if (link.revokedAt !== null) return { label: "Revoked", variant: "secondary" };
  if (link.expiresAt !== null && Date.parse(link.expiresAt) <= now) return { label: "Expired", variant: "outline" };
  if (!installLinkTokenValid(link, tokens, now)) return { label: "Token revoked", variant: "outline" };
  if (link.groupName === null) return { label: "Group deleted", variant: "outline" };
  return { label: "Active", variant: "success" };
}

/**
 * Whether Install Links offers Extend on `link`: not revoked, its group not
 * deleted, and its token valid (`installLinkTokenValid`), an expired link
 * included; extending any other can't make it download.
 */
export function installLinkExtendable(
  link: Pick<QuickDeployLink, "revokedAt" | "defaultTokenId" | "groupName">,
  tokens: readonly Pick<Token, "id" | "expiresAt" | "revokedAt">[] | null,
  now: number,
): boolean {
  return link.revokedAt === null && link.groupName !== null && installLinkTokenValid(link, tokens, now);
}

/**
 * Whether the default token a link's command carries is valid at `now`
 * among the same read's tokens (not revoked, not expired, still listed);
 * true while the tokens are unread (null: the link judged by its own times
 * alone). A link whose token isn't valid can't download whatever its
 * status, so extending it can't make it work.
 */
export function installLinkTokenValid(
  link: Pick<QuickDeployLink, "defaultTokenId">,
  tokens: readonly Pick<Token, "id" | "expiresAt" | "revokedAt">[] | null,
  now: number,
): boolean {
  if (tokens === null) return true;
  const token = tokens.find((each) => each.id === link.defaultTokenId);
  return token !== undefined && tokenValidAt(token, now);
}

/* ---------------------------------------------------------------------------
 * The tab's reads.
 */

type Settled<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

/** A request's answer or failure, never rejecting. */
function settled<Value>(request: Promise<Value>): Promise<Settled<Value>> {
  return request.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/** A page of a paged part (the history, the install links) as its read answers it: its items, newest first, and where the next page starts. */
interface PageOf<Item> {
  items: Item[];
  nextCursor: string | null;
}

/** A page's query: the first page (no cursor), or the one after `cursor`. */
function pageQuery(limit: number, cursor: string | undefined): PageQuery {
  return cursor === undefined ? { limit } : { limit, cursor };
}

/** A page of the token history. */
async function historyPage(organizationId: string, fleetId: string, cursor: string | undefined, signal: AbortSignal): Promise<PageOf<EnrollmentTokenEvent>> {
  const page = await readsFor(organizationId).getEnrollmentTokenEvents(organizationId, fleetId, pageQuery(TOKEN_HISTORY_PAGE_SIZE, cursor), { signal });
  return { items: page.events, nextCursor: page.nextCursor };
}

/** A page of the install links. */
async function linksPage(organizationId: string, fleetId: string, cursor: string | undefined, signal: AbortSignal): Promise<PageOf<QuickDeployLink>> {
  const page = await readsFor(organizationId).getQuickDeployLinks(organizationId, fleetId, pageQuery(INSTALL_LINKS_PAGE_SIZE, cursor), { signal });
  return { items: page.links, nextCursor: page.nextCursor };
}

/** A read from the top: the tokens, and each paged part's first page when it was read (null when it wasn't). */
interface TopOutcome {
  tokens: Settled<EnrollmentTokensResponse>;
  history: Settled<PageOf<EnrollmentTokenEvent>> | null;
  links: Settled<PageOf<QuickDeployLink>> | null;
}

/** Which paged parts a read from the top reads the first page of. */
interface TopParts {
  history: boolean;
  links: boolean;
}

const EVERY_PART: TopParts = { history: true, links: true };

/**
 * One read from the top (the first, a person's or a poll's): the tokens, and
 * the history's and the install links' first pages when asked for, together
 * under the read's one hang guard (`signal`), settled together as the
 * collectors' page and groups are. Any of them may fail alone.
 */
async function readTop(organizationId: string, fleetId: string, parts: TopParts, signal: AbortSignal): Promise<TopOutcome> {
  const [tokens, history, links] = await Promise.all([
    settled(readsFor(organizationId).getEnrollmentTokens(organizationId, fleetId, { signal })),
    parts.history ? settled(historyPage(organizationId, fleetId, undefined, signal)) : null,
    parts.links ? settled(linksPage(organizationId, fleetId, undefined, signal)) : null,
  ]);
  return { tokens, history, links };
}

/** The tokens as the latest read that answered them gave them, for the organization and fleet they were read in. */
interface ShownTokens {
  organizationId: string;
  fleetId: string;
  tokens: EnrollmentTokenListed[];
  /** The number of the read the rows came from (`useReadOrder`'s): a person's or a poll's. */
  read: number;
}

/** A paged part shown: its items, where its next page starts, and how many pages it holds. */
interface ShownPage<Item> {
  organizationId: string;
  fleetId: string;
  items: Item[];
  nextCursor: string | null;
  /** 1 for the first page alone; more once "Load more" has added pages, and then the polls leave it alone. */
  pages: number;
  /** The number of the read from the top its first page came from (`useReadOrder`'s). */
  read: number;
}

/** A paged part's state in the hook: what is shown, and whether the latest person's read failed it with nothing shown. */
interface PagedPart<Item> {
  shown: ShownPage<Item> | null;
  show: (next: ShownPage<Item> | null) => void;
  /** What is shown, if it is this organization's and this fleet's. */
  shownFor: (organization: string) => ShownPage<Item> | null;
  failed: boolean;
  setFailed: (failed: boolean) => void;
}

/** One paged part's state (the history's, the install links'), shared by both: they page alike. */
function usePagedPart<Item>(fleetId: string): PagedPart<Item> {
  const [shown, setShown] = useState<ShownPage<Item> | null>(null);
  const shownRef = useRef<ShownPage<Item> | null>(null);
  const show = useCallback((next: ShownPage<Item> | null) => {
    shownRef.current = next;
    setShown(next);
  }, []);
  const shownFor = useCallback(
    (organization: string): ShownPage<Item> | null => {
      const current = shownRef.current;
      return current !== null && current.organizationId === organization && current.fleetId === fleetId ? current : null;
    },
    [fleetId],
  );
  const [failed, setFailed] = useState(false);
  return { shown, show, shownFor, failed, setFailed };
}

/** A paged part's way to read its next page, and its words when that fails. */
interface PagedReader<Item> {
  part: "history" | "links";
  readPage: (organizationId: string, fleetId: string, cursor: string, signal: AbortSignal) => Promise<PageOf<Item>>;
  failedMessage: string;
}

const HISTORY_READER: PagedReader<EnrollmentTokenEvent> = {
  part: "history",
  readPage: (organizationId, fleetId, cursor, signal) => historyPage(organizationId, fleetId, cursor, signal),
  failedMessage: TOKEN_HISTORY_FAILED_MESSAGE,
};

const LINKS_READER: PagedReader<QuickDeployLink> = {
  part: "links",
  readPage: (organizationId, fleetId, cursor, signal) => linksPage(organizationId, fleetId, cursor, signal),
  failedMessage: INSTALL_LINKS_FAILED_MESSAGE,
};

/** A person's read under way: from the top (the first, a refresh, a write's reload, "Try again") or a part's "Load more". */
type PersonsRead = "top" | "history" | "links" | null;

export interface TokensTabOptions {
  /** Called when a read finds the fleet gone (404 `fleet_not_found`): the route's `useFleet().reload`, so the page shows "Fleet not found". */
  onFleetGone: () => void;
}

/** A paged part as the tab reads it, under its own name for its items. */
interface PagedRead {
  /** Whether a next page exists ("Load more"). */
  hasMore: boolean;
  /** Whether "Load more" is under way. */
  loadingMore: boolean;
  /** Whether the latest person's read failed the part with nothing shown: its failed words, with "Try again" (the tab's `reload`). */
  failed: boolean;
  /** Reads the next page and appends it, each item once. Nothing without one, or while a person's read is under way. */
  loadMore: () => void;
}

export interface TokenHistoryRead extends PagedRead {
  /** The history's events, newest first; null until a read of it has answered, or after it failed with nothing shown. */
  events: EnrollmentTokenEvent[] | null;
}

export interface InstallLinksRead extends PagedRead {
  /** The fleet's install links, newest first; null until a read of them has answered, or after it failed with nothing shown. */
  links: QuickDeployLink[] | null;
}

export interface TokensTabRead {
  /** The fleet's tokens, newest first; null until the first read has answered them, or after it failed with nothing shown. */
  tokens: EnrollmentTokenListed[] | null;
  /**
   * The number of the read the rows shown came from, 0 with none shown
   * (`useReturnFocus`'s `rowsChanged`): the later of the tokens' and the
   * install links' (both rows hold the actions a dialog opens from).
   */
  rowsRead: number;
  /** The latest read's number, begun or not yet answered (`useReturnFocus`'s `wrote`, taken before a write's `reload`). */
  latestRead: () => number;
  /** Whether a person's read from the top is under way: the refresh button spins. */
  personsRead: boolean;
  /** Whether the latest person's read failed the tokens with nothing shown: "Failed to load tokens", with "Try again" (`reload`). */
  failed: boolean;
  /** The token history. */
  history: TokenHistoryRead;
  /** The install links. */
  links: InstallLinksRead;
  /** Reads the tokens, the history and the install links from the top, as a person's read: after a write, the refresh button, or "Try again". */
  reload: () => void;
}

/**
 * A server fleet's tokens, token history and install links, for the Tokens
 * tab; `onFleetGone` is the route's `useFleet().reload`.
 *
 * - The tokens, the history's first page (50) and the install links' first
 *   page (50) load for the active organization and the fleet, together; an
 *   organization switch, or another fleet, drops what was shown and starts
 *   over. Nothing loads while the layout says the terms need accepting.
 * - One `useReadOrder` orders every read: each takes the next number and
 *   aborts the read under way, and only the latest read's answer is used, so
 *   a late answer, one superseded by a newer read, or one for an
 *   organization left meanwhile is dropped. Each read has one 10 s hang
 *   guard, its requests under one signal.
 * - `reload` reads the tokens, the history and the links from the top, as a
 *   person's read: it supersedes a poll or "Load more" under way. The three
 *   fail apart: a person's read failing over rows shown toasts (once: the
 *   tokens' words, else the history's, else the links') and keeps them;
 *   with none of that part shown, the part is `failed`.
 *   `organization_not_found` and `terms_acceptance_required` revalidate the
 *   layout, and a 401 is the session-ended handler's: no toast.
 * - `history.loadMore` and `links.loadMore` read their part's next page and
 *   append it, each item once (the paged logic is one, shared); each is a
 *   person's read too: it supersedes a poll under way, and polls skip while
 *   it runs. Its failure toasts the part's words ("Failed to load the token
 *   history", "Failed to load install links") and keeps the rows; a stale
 *   cursor (400 naming `cursor`) reads from the top instead, silently.
 * - A poll every 15 s while the tab is visible and no dialog is open
 *   (`useVisiblePolling`) reads the tokens, and each paged part's first page
 *   while at most its first page is shown (once "Load more" has added a page
 *   that part waits for the person's refresh), and replaces what it read.
 *   It never starts before a first read has shown something, during a
 *   person's read, or while a 429 holds the polls; its 503, network
 *   failure, abort or 401 is silent and the rows stay.
 * - A 404 `fleet_not_found` on any read calls `onFleetGone`: no toast, no
 *   failed state.
 * - A 429 anywhere holds this hook's polls until its `Retry-After`.
 */
export function useTokensTab(fleetId: string, { onFleetGone }: TokensTabOptions): TokensTabRead {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const termsRequired = useTermsRequired();
  const { revalidate } = useRevalidator();
  const { begin, holdPollsFor, pollsHeld, latestRead } = useReadOrder();

  const latestOnFleetGone = useRef(onFleetGone);
  useEffect(() => {
    latestOnFleetGone.current = onFleetGone;
  });

  const [shownTokens, setShownTokens] = useState<ShownTokens | null>(null);
  const shownTokensRef = useRef<ShownTokens | null>(null);
  const showTokens = useCallback((next: ShownTokens | null) => {
    shownTokensRef.current = next;
    setShownTokens(next);
  }, []);

  const {
    shown: shownHistory,
    show: showHistory,
    shownFor: historyFor,
    failed: historyFailed,
    setFailed: setHistoryFailed,
  } = usePagedPart<EnrollmentTokenEvent>(fleetId);
  const {
    shown: shownLinks,
    show: showLinks,
    shownFor: linksFor,
    failed: linksFailed,
    setFailed: setLinksFailed,
  } = usePagedPart<QuickDeployLink>(fleetId);

  const [personsRead, setPersonsReadState] = useState<PersonsRead>(null);
  const personsReadRef = useRef<PersonsRead>(null);
  const setPersonsRead = useCallback((next: PersonsRead) => {
    personsReadRef.current = next;
    setPersonsReadState(next);
  }, []);

  const [tokensFailed, setTokensFailed] = useState(false);

  /** The tokens shown, if they are this organization's and this fleet's. */
  const tokensFor = useCallback(
    (organization: string): ShownTokens | null => {
      const current = shownTokensRef.current;
      return current !== null && current.organizationId === organization && current.fleetId === fleetId ? current : null;
    },
    [fleetId],
  );

  /** Each paged part's handles, by its name: what `loadMore` and `takeIn` need of it. */
  const parts = useMemo(
    () => ({
      history: { reader: HISTORY_READER, show: showHistory, shownFor: historyFor, setFailed: setHistoryFailed },
      links: { reader: LINKS_READER, show: showLinks, shownFor: linksFor, setFailed: setLinksFailed },
    }),
    [historyFor, linksFor, setHistoryFailed, setLinksFailed, showHistory, showLinks],
  );

  /**
   * Takes a read from the top in: its 429s hold the polls, a fleet found
   * gone goes to `onFleetGone`, and what answered is shown (the tokens with
   * the read's number; each paged part as its first page alone). A failure:
   * the organization's and the terms' revalidate the layout, a 401 says
   * nothing; otherwise a poll's is silent, and a person's toasts once over
   * what is shown, or leaves the part with nothing shown `failed`.
   */
  const takeIn = useCallback(
    (organization: string, outcome: TopOutcome, read: number, persons: boolean) => {
      const errors: unknown[] = [];
      if (!outcome.tokens.ok) errors.push(outcome.tokens.error);
      if (outcome.history !== null && !outcome.history.ok) errors.push(outcome.history.error);
      if (outcome.links !== null && !outcome.links.ok) errors.push(outcome.links.error);
      for (const error of errors) holdPollsFor(error);
      if (errors.some(isFleetGone)) {
        latestOnFleetGone.current();
        return;
      }
      const revalidating = errors.some((error) => isOrganizationGone(error) || isTermsAcceptanceRequired(error));
      if (revalidating) void revalidate();
      if (outcome.tokens.ok) {
        showTokens({ organizationId: organization, fleetId, tokens: outcome.tokens.value.tokens, read });
      }
      // The paged parts' failures, in the toast's order: the history's, then the links'.
      const pagedFailures: Array<{ shownFor: (organization: string) => unknown; setFailed: (failed: boolean) => void; message: string }> = [];
      if (outcome.history !== null) {
        if (outcome.history.ok) {
          const { items, nextCursor } = outcome.history.value;
          showHistory({ organizationId: organization, fleetId, items, nextCursor, pages: 1, read });
        } else {
          pagedFailures.push({ shownFor: historyFor, setFailed: setHistoryFailed, message: TOKEN_HISTORY_FAILED_MESSAGE });
        }
      }
      if (outcome.links !== null) {
        if (outcome.links.ok) {
          const { items, nextCursor } = outcome.links.value;
          showLinks({ organizationId: organization, fleetId, items, nextCursor, pages: 1, read });
        } else {
          pagedFailures.push({ shownFor: linksFor, setFailed: setLinksFailed, message: INSTALL_LINKS_FAILED_MESSAGE });
        }
      }
      // The session is over: the session-ended handler, or Logout, has the page.
      if (!persons || revalidating || errors.some(isSessionEnded)) return;
      let toasted = false;
      if (!outcome.tokens.ok) {
        if (tokensFor(organization) !== null) {
          toast.error(TOKENS_LOAD_FAILED_MESSAGE);
          toasted = true;
        } else {
          setTokensFailed(true);
        }
      }
      for (const failure of pagedFailures) {
        if (failure.shownFor(organization) === null) failure.setFailed(true);
        else if (!toasted) {
          toast.error(failure.message);
          toasted = true;
        }
      }
    },
    [fleetId, historyFor, holdPollsFor, linksFor, revalidate, setHistoryFailed, setLinksFailed, showHistory, showLinks, showTokens, tokensFor],
  );

  /** One read from the top under its one hang guard; null once a newer read has begun. */
  const readFromTop = useCallback(
    async (organization: string, read: ReturnType<typeof begin>, which: TopParts): Promise<TopOutcome | null> => {
      const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
      read.track(guard);
      try {
        const outcome = await readTop(organization, fleetId, which, guard.signal);
        return read.isCurrent() ? outcome : null;
      } finally {
        guard.clear();
        read.settle();
      }
    },
    [fleetId],
  );

  /** A person's read from the top: the first, a refresh, a write's reload, "Try again", or after a stale cursor. */
  const readAsPerson = useCallback(
    (organization: string) => {
      const read = begin();
      setPersonsRead("top");
      setTokensFailed(false);
      setHistoryFailed(false);
      setLinksFailed(false);
      void readFromTop(organization, read, EVERY_PART).then((outcome) => {
        if (outcome === null) return;
        setPersonsRead(null);
        takeIn(organization, outcome, read.number, true);
      });
    },
    [begin, readFromTop, setHistoryFailed, setLinksFailed, setPersonsRead, takeIn],
  );

  useEffect(() => {
    // Another organization's or another fleet's tokens, history and links are never shown.
    showTokens(null);
    showHistory(null);
    showLinks(null);
    setTokensFailed(false);
    setHistoryFailed(false);
    setLinksFailed(false);
    if (organizationId === null || termsRequired) {
      begin();
      setPersonsRead(null);
      return;
    }
    readAsPerson(organizationId);
  }, [organizationId, fleetId, termsRequired, begin, readAsPerson, setHistoryFailed, setLinksFailed, setPersonsRead, showHistory, showLinks, showTokens]);

  const reload = useCallback(() => {
    if (organizationId === null || termsRequired) return;
    readAsPerson(organizationId);
  }, [organizationId, termsRequired, readAsPerson]);

  /** A paged part's "Load more" (the history's or the links': one logic). */
  const loadMoreOf = useCallback(
    <Item extends { id: string }>(part: {
      reader: PagedReader<Item>;
      show: (next: ShownPage<Item> | null) => void;
      shownFor: (organization: string) => ShownPage<Item> | null;
    }) => {
      if (organizationId === null || termsRequired || personsReadRef.current !== null) return;
      const organization = organizationId;
      const shown = part.shownFor(organization);
      if (shown === null || shown.nextCursor === null) return;
      const read = begin();
      setPersonsRead(part.reader.part);
      const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
      read.track(guard);
      part.reader
        .readPage(organization, fleetId, shown.nextCursor, guard.signal)
        .then(
          (page) => {
            if (!read.isCurrent()) return;
            setPersonsRead(null);
            const before = part.shownFor(organization) ?? shown;
            // An item the part moved past while paging is shown once.
            const seen = new Set(before.items.map((item) => item.id));
            const added = page.items.filter((item) => !seen.has(item.id));
            part.show({ ...before, items: [...before.items, ...added], nextCursor: page.nextCursor, pages: before.pages + 1 });
          },
          (error: unknown) => {
            if (!read.isCurrent()) return;
            setPersonsRead(null);
            holdPollsFor(error);
            if (isFleetGone(error)) {
              latestOnFleetGone.current();
              return;
            }
            if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
              void revalidate();
              return;
            }
            if (isSessionEnded(error)) return;
            // The cursor is no longer taken: everything from the top.
            if (isStaleCursor(error)) {
              readAsPerson(organization);
              return;
            }
            toast.error(part.reader.failedMessage);
          },
        )
        .finally(() => {
          guard.clear();
          read.settle();
        });
    },
    [organizationId, termsRequired, fleetId, begin, holdPollsFor, readAsPerson, revalidate, setPersonsRead],
  );

  const loadMoreHistory = useCallback(() => loadMoreOf(parts.history), [loadMoreOf, parts]);
  const loadMoreLinks = useCallback(() => loadMoreOf(parts.links), [loadMoreOf, parts]);

  const poll = useCallback(async () => {
    if (organizationId === null || termsRequired) return;
    const history = historyFor(organizationId);
    const links = linksFor(organizationId);
    // Nothing polls before a first read has shown something, during a person's read, or while a 429 holds it.
    if (tokensFor(organizationId) === null && history === null && links === null) return;
    if (personsReadRef.current !== null || pollsHeld()) return;
    // Each part's first page only while at most that page is shown: after "Load more" it waits for the person's refresh.
    const which: TopParts = { history: (history?.pages ?? 0) <= 1, links: (links?.pages ?? 0) <= 1 };
    const read = begin();
    const outcome = await readFromTop(organizationId, read, which);
    if (outcome !== null) takeIn(organizationId, outcome, read.number, false);
  }, [organizationId, termsRequired, begin, historyFor, linksFor, pollsHeld, readFromTop, takeIn, tokensFor]);

  useVisiblePolling(poll, FLEETS_POLL_INTERVAL_MS);

  const isCurrent = (shown: { organizationId: string; fleetId: string } | null) =>
    shown !== null && shown.organizationId === organizationId && shown.fleetId === fleetId;
  const tokens = isCurrent(shownTokens) ? shownTokens : null;
  const history = isCurrent(shownHistory) ? shownHistory : null;
  const links = isCurrent(shownLinks) ? shownLinks : null;
  return {
    tokens: tokens?.tokens ?? null,
    rowsRead: Math.max(tokens?.read ?? 0, links?.read ?? 0),
    latestRead,
    personsRead: personsRead === "top",
    failed: tokensFailed && tokens === null,
    history: {
      events: history?.items ?? null,
      hasMore: history?.nextCursor != null,
      loadingMore: personsRead === "history",
      failed: historyFailed && history === null,
      loadMore: loadMoreHistory,
    },
    links: {
      links: links?.items ?? null,
      hasMore: links?.nextCursor != null,
      loadingMore: personsRead === "links",
      failed: linksFailed && links === null,
      loadMore: loadMoreLinks,
    },
    reload,
  };
}
