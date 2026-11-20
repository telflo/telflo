import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";
import { toast } from "sonner";
import {
  FLEET_ERROR_CODES,
  type ConfigurationErrorCode,
  FLEETS_PAGE_DEFAULT_LIMIT,
  FLEETS_PAGE_MAXIMUM_LIMIT,
  QUICK_DEPLOY_LINK_ERROR_CODES,
  type FleetDetail,
  type FleetErrorCode,
  type FleetStatus,
  type OrganizationErrorCode,
  type SessionErrorCode,
  VARIABLE_ERROR_CODES,
  type VariableErrorCode,
} from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded, REQUEST_ABORTED } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { useVisiblePolling } from "~/lib/hooks/use-visible-polling.js";
import { isCanonicalUuid } from "~/lib/ids.js";
import { issuePathOf } from "~/lib/issue-path.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { readsFor } from "~/lib/workspace-reads.js";
import type { AppLayoutData } from "~/routes/app-layout.js";

/*
 * The fleet screens' data: which refusals they show, and the two hooks that
 * read the fleet list and one fleet, each polled every 15 seconds while the
 * tab is visible. Nothing here puts a fleet's label anywhere but the data it
 * returns: no toast, log or attribute carries one.
 */

/** How often the list and a fleet's page read again. */
export const FLEETS_POLL_INTERVAL_MS = 15_000;

/**
 * Each read's hang guard: the browser's client has no timeout, and a read
 * that never answers would stop the polling for good (a poll never starts
 * while one is in flight). The person's reads carry it too, since a poll
 * waits on them as well.
 */
export const FLEET_READ_TIMEOUT_MS = 10_000;

/** The words for a list that didn't load, without the error. */
export const FLEETS_LOAD_FAILED_MESSAGE = "Failed to load fleets";

/** The same, for a fleet's page. */
export const FLEET_LOAD_FAILED_MESSAGE = "Failed to load fleet";

const ORGANIZATION_NOT_FOUND: OrganizationErrorCode = "organization_not_found";
const RATE_LIMITED: SessionErrorCode = "rate_limited";
const FLEET_NOT_FOUND: FleetErrorCode = "fleet_not_found";
const INSTALL_UNAVAILABLE: FleetErrorCode = "install_unavailable";
const CONFIGURATION_VERSION_NOT_FOUND: ConfigurationErrorCode = "configuration_version_not_found";
const CONFIGURATION_NOT_FOUND: ConfigurationErrorCode = "configuration_not_found";

/** The variables codes the fleet routes answer, taken from the contracts' list, never added to it. */
const FLEET_VARIABLE_CODE_NAMES: ReadonlySet<VariableErrorCode> = new Set<VariableErrorCode>(["variable_group_not_found", "variables_undefined"]);
const FLEET_VARIABLE_CODES: readonly VariableErrorCode[] = VARIABLE_ERROR_CODES.filter((code) => FLEET_VARIABLE_CODE_NAMES.has(code));

/**
 * The refusals whose message a fleet screen shows as it is: the fleets' own
 * codes (the one 503 `fleets_unavailable` among them), the organization's, the
 * person's fleet limits, and the two configuration codes a collector's pin and
 * the pin picker's versions read answer: `configuration_version_not_found` and
 * `configuration_not_found`, and the quick-deploy links' own
 * (`quick_deploy_link_not_found`, `quick_deploy_link_revoked`,
 * `quick_deploy_link_limit_reached`, `enrollment_token_default_missing`,
 * `collector_group_variables_changed`), and the two variables codes a group's
 * assignment and variable group, a collector's pin and the bulk pin answer:
 * `variable_group_not_found` (404) and `variables_undefined` (422, whose
 * details the dialogs list), each taken from the contracts'
 * `VARIABLE_ERROR_CODES` by its typed name. An allow-list, so
 * `invalid_request`'s own message ("The request was not valid."), a server
 * error's or `terms_acceptance_required`'s (which closes the dialog and opens
 * the terms instead) never reaches the person.
 */
export const FLEET_REFUSAL_CODES: readonly string[] = [
  ...FLEET_ERROR_CODES,
  ...QUICK_DEPLOY_LINK_ERROR_CODES,
  ORGANIZATION_NOT_FOUND,
  RATE_LIMITED,
  CONFIGURATION_VERSION_NOT_FOUND,
  CONFIGURATION_NOT_FOUND,
  ...FLEET_VARIABLE_CODES,
];

const REFUSAL_CODES: ReadonlySet<string> = new Set(FLEET_REFUSAL_CODES);

/** Whether a failure is the API refusing, with one of `FLEET_REFUSAL_CODES`. */
export function isFleetRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && REFUSAL_CODES.has(error.code);
}

/**
 * What the person is told about a failed fleet request: a refusal's own
 * message, or the caller's fallback ("Failed to create fleet", "Failed to
 * rename fleet", "Failed to update fleet", "Failed to delete fleet") for
 * anything else, as `configurationRefusalMessage`.
 */
export function fleetRefusalMessage(error: unknown, fallback: string): string {
  return isFleetRefusal(error) ? error.message : fallback;
}

/** Whether a request was refused for the person's fleet limits (429, with its `Retry-After`). */
export function isRateLimited(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === RATE_LIMITED || error.status === 429);
}

/** Whether a request found the fleet gone: deleted, meanwhile, or never the organization's. */
export function isFleetGone(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === FLEET_NOT_FOUND;
}

/**
 * The hang guard of a fleet's create, rename and archive, and of the create's
 * reads and reveals when a retry finds the fleet made: above the platform's
 * usual worst case (up to three 5 s opamp-server calls and its own database
 * reads and audit write, which have no timeout of their own), since every way
 * out of the dialog is blocked while it works and the browser's client has no
 * timeout.
 */
export const FLEET_WRITE_TIMEOUT_MS = 30_000;

/**
 * Whether a write's failure leaves its outcome unknown: any 5xx (the 503
 * `fleets_unavailable` among them), no connection (`network_error`), a reply
 * that doesn't parse (`unexpected_response`, whatever its status: a
 * gateway's HTML page, or a success the contract doesn't know), or the
 * request aborted (the hang guard's abort). The write may or may not have
 * been made. Any other refusal is the API saying, in its own words, that it
 * made nothing this time.
 *
 * `install_unavailable` (503) is checked first and is known: the API read the
 * install templates and couldn't, before it rendered or sent anything, and
 * says so in its own words ("Ask your administrator."), which the install
 * dialog shows.
 */
export function isUnknownOutcome(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.code === INSTALL_UNAVAILABLE) return false;
  if (error.code === "network_error" || error.code === "unexpected_response" || error.code === REQUEST_ABORTED) return true;
  return error.status !== undefined && error.status >= 500;
}

/**
 * A 400 `invalid_request`'s problems, keyed by the caller's fields: each of
 * its `details` whose path (`issuePathOf`, "env.0.value",
 * "annotations.telflo.dockerMounts.1.hostPath") `pathToKey` maps to a key,
 * with its own words; the first detail on a key is the one kept. `pathToKey`
 * answers undefined for a path the caller shows nothing for. Empty for any
 * other failure, or for details naming none of the caller's fields; the dialog
 * then shows its fallback. The details' words are the platform's or the
 * contract's, never a value of the request's (`modules/fleets/errors.ts`).
 */
export function fieldProblemsOf<Key extends string>(
  error: unknown,
  pathToKey: (path: string) => Key | undefined,
): Partial<Record<Key, string>> {
  if (!(error instanceof ApiError) || error.code !== "invalid_request" || !Array.isArray(error.details)) return {};
  // No prototype, and own keys only: a key a caller derives from a name (`env:{NAME}`) never reads or writes an inherited one.
  const problems = Object.create(null) as Partial<Record<Key, string>>;
  for (const detail of error.details as unknown[]) {
    if (typeof detail !== "object" || detail === null || !("message" in detail) || typeof detail.message !== "string") continue;
    const path = issuePathOf(detail);
    const key = path === undefined ? undefined : pathToKey(path);
    if (key !== undefined && !Object.hasOwn(problems, key)) problems[key] = detail.message;
  }
  return problems;
}

/**
 * A Linux install's fields a 400 `invalid_request` can name, the bundle's
 * download and the quick-deploy link's create alike: the root path,
 * the executable path, and an included variable by its name
 * (`env:{NAME}`, a key `fieldProblemsOf` keeps on an object without a
 * prototype).
 */
export type BundleField = "rootPath" | "executablePath" | `env:${string}`;

const BUNDLE_ENV_PATH = /^env\.(\d+)\.(?:value|name)$/;

/**
 * The install form's field of a 400's detail path (`fieldProblemsOf`'s
 * mapper): `rootPath` and `executablePath` as they are, `env.N.value` and
 * `env.N.name` as the request's Nth variable's `env:{NAME}`, anything else
 * (`method`, `arch`, `systemd`, a variable the request doesn't hold)
 * undefined: the dialog then shows its fallback.
 */
export function bundleFieldOf(path: string, request: { env: readonly { name: string }[] }): BundleField | undefined {
  if (path === "rootPath" || path === "executablePath") return path;
  const index = BUNDLE_ENV_PATH.exec(path)?.[1];
  const name = index === undefined ? undefined : request.env[Number(index)]?.name;
  return name === undefined ? undefined : `env:${name}`;
}

/** A 400 `invalid_request`'s problems with the install form's fields (`bundleFieldOf`), with their own words. */
export function bundleFieldProblemsOf(
  error: unknown,
  request: { env: readonly { name: string }[] },
): Partial<Record<BundleField, string>> {
  return fieldProblemsOf<BundleField>(error, (path) => bundleFieldOf(path, request));
}

/**
 * The fields a 400 `invalid_request` can name: a fleet's create or rename's
 * Name (`label`) and Token expiry, a collector's edit's and a group's
 * dialog's Name (`name`), and a rotation's new expiry and grace end
 * (`expiresAt`, `graceEndsAt`).
 */
export type FleetField = "label" | "rotateExpiresAt" | "name" | "expiresAt" | "graceEndsAt";

const FLEET_FIELDS: readonly FleetField[] = ["label", "rotateExpiresAt", "name", "expiresAt", "graceEndsAt"];

/**
 * A 400 `invalid_request`'s problems with the fleet's fields: each of its
 * `details` whose path is one of `FleetField`'s, with its own words, keyed by
 * that field (`fieldProblemsOf`). It maps nothing: each dialog decides what it
 * shows (the rotate dialog maps the grace end's to its own words).
 */
export function fleetFieldProblemsOf(error: unknown): Partial<Record<FleetField, string>> {
  return fieldProblemsOf(error, (path) => FLEET_FIELDS.find((each) => each === path));
}

/**
 * Whether a list's read was refused for its cursor: 400 `invalid_request`
 * whose details name `cursor` (`modules/fleets/errors.ts`'s `invalidCursor`;
 * the fake answers the same), a cursor the opamp-server no longer takes. The
 * collectors' pages and the token history read from the top again.
 */
export function isStaleCursor(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.code === "invalid_request" &&
    Array.isArray(error.details) &&
    (error.details as unknown[]).some(
      (detail) => typeof detail === "object" && detail !== null && issuePathOf(detail) === "cursor",
    )
  );
}

/** A request's hang guard, as `abortAfter` makes it. */
type ReadGuard = ReturnType<typeof abortAfter>;

/**
 * The list's pages from the first, until `target` fleets have answered or the
 * list ends: each page asks for at most what is still missing
 * (`min(100, target - have)`), so the last page's `nextCursor` continues
 * exactly after the last fleet read, and "Load more" after it skips nothing.
 * A fleet read twice (the list moved between pages) is kept once. Each page
 * carries its own hang guard, handed to `track` so that a load that
 * supersedes this one, or an unmount, aborts it. Null when `isCurrent` says a
 * newer load has superseded this one.
 */
async function readFirstPages(
  organizationId: string,
  status: FleetStatus | undefined,
  target: number,
  track: (guard: ReadGuard) => void,
  isCurrent: () => boolean,
): Promise<{ fleets: FleetDetail[]; nextCursor: string | null } | null> {
  const fleets: FleetDetail[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const limit = Math.min(FLEETS_PAGE_MAXIMUM_LIMIT, target - fleets.length);
    const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
    track(guard);
    let page;
    try {
      page = await readsFor(organizationId).getFleets(organizationId, { status, limit, cursor }, { signal: guard.signal });
    } finally {
      guard.clear();
    }
    if (!isCurrent()) return null;
    for (const fleet of page.fleets) {
      if (seen.has(fleet.id)) continue;
      seen.add(fleet.id);
      fleets.push(fleet);
    }
    if (page.nextCursor === null || fleets.length >= target || page.fleets.length === 0) {
      return { fleets, nextCursor: page.nextCursor };
    }
    cursor = page.nextCursor;
  }
}

/**
 * Whether the layout's `/me` says the current terms need accepting: nothing
 * loads until they are. Shared with the collectors page's hook
 * (`lib/collectors.ts`).
 */
export function useTermsRequired(): boolean {
  const layoutData = useRouteLoaderData<AppLayoutData>("routes/app-layout");
  return layoutData?.status === "signed_in" && layoutData.currentUser.termsAcceptanceRequired;
}

/**
 * The bookkeeping the fleet screens' hooks share (these two, and the
 * collectors page's): the latest-load counter, the request under way (to
 * abort it), and how long a 429 holds the polls. Each hook holds its own:
 * one hook's 429 holds only its own polls.
 *
 * Every read, the person's and the poll's, takes the next number from the
 * counter as it starts, and aborts the read under way; an answer is used
 * only while its number is still the latest, so a late answer, an answer
 * superseded by a newer read, or one for an organization left meanwhile is
 * dropped. An unmount aborts the read under way. The number (`begin`'s,
 * and `latestRead` for the latest begun) also tells `useReturnFocus`
 * whether rows came from a read begun after a write.
 */
export function useReadOrder() {
  const latest = useRef(0);
  const underWay = useRef<ReadGuard | null>(null);
  const pollsHeldUntil = useRef(0);

  const begin = useCallback((): { number: number; isCurrent: () => boolean; track: (guard: ReadGuard) => void; settle: () => void } => {
    underWay.current?.abort();
    underWay.current = null;
    const read = ++latest.current;
    const isCurrent = () => read === latest.current;
    return {
      number: read,
      isCurrent,
      track: (guard) => {
        if (isCurrent()) underWay.current = guard;
      },
      settle: () => {
        if (isCurrent()) underWay.current = null;
      },
    };
  }, []);

  /**
   * A 429 holds the polls until its `Retry-After` has passed,
   * the person's reads' as the polls'. A 429 without `Retry-After` (one the
   * client couldn't read, or a proxy's) holds nothing: the next poll comes
   * at its usual tick, 15 s on, which is pause enough.
   */
  const holdPollsFor = useCallback((error: unknown) => {
    if (!isRateLimited(error) || error.retryAfterSeconds === undefined) return;
    pollsHeldUntil.current = Math.max(pollsHeldUntil.current, Date.now() + error.retryAfterSeconds * 1000);
  }, []);

  const pollsHeld = useCallback(() => Date.now() < pollsHeldUntil.current, []);

  /** The latest read's number: the last `begin`'s (0 before any). */
  const latestRead = useCallback(() => latest.current, []);

  useEffect(
    () => () => {
      underWay.current?.abort();
      underWay.current = null;
      latest.current += 1;
    },
    [],
  );

  return { begin, holdPollsFor, pollsHeld, latestRead };
}

/** What the list shows: the organization's fleets with one status filter (none for every fleet), and where its next page starts. */
interface ShownFleets {
  organizationId: string;
  status: FleetStatus | undefined;
  fleets: FleetDetail[];
  nextCursor: string | null;
  /** The number of the read the rows came from (`useReadOrder`'s): the first pages', "Load more"'s or a poll's. */
  read: number;
}

/** A read the person asked for, under way: the first pages (a filter, a reload, "Try again") or "Load more". */
type PersonsRead = "first" | "more" | null;

export interface FleetsList {
  /** The fleets shown, newest first; null until the organization's first page has answered, or after it failed. */
  fleets: FleetDetail[] | null;
  /** The number of the read `fleets` came from, 0 with none shown (`useReturnFocus`'s `rowsChanged`). */
  rowsRead: number;
  /** The latest read's number, begun or not yet answered (`useReturnFocus`'s `wrote`, taken before a write's `reload`). */
  latestRead: () => number;
  /** The status the shown list was read with (undefined for every fleet), which decides its empty state. */
  shownStatus: FleetStatus | undefined;
  /** Whether a next page exists. */
  hasMore: boolean;
  /** Whether "Load more" is under way. */
  isLoadingMore: boolean;
  /**
   * Whether a person's read of the first pages (a filter, a reload) is under
   * way while an older list is shown. With `isLoadingMore`, what disables
   * "Load more"; a poll never does.
   */
  isStale: boolean;
  /** Whether the latest first load failed with nothing of this filter to show: the page's error, with "Try again" (`reload`). */
  failed: boolean;
  /** Fetches the next page and appends it, each fleet once. Nothing while a person's read is under way. */
  loadMore: () => void;
  /** Reads the list again, as far as it is shown (50 at least): after a write, or "Try again". */
  reload: () => void;
}

/**
 * The active organization's fleets, a page at a time, through the browser
 * client in effects, as `useConfigurationsList`.
 *
 * - The first page (50) loads for the active organization (`useCurrentUser`'s,
 *   so a switch elsewhere starts over) and `status`; a change of either
 *   starts over, and `reload()` reads again as far as the list is shown.
 *   Another organization's list is never shown, and its answers are
 *   dropped.
 * - The latest-load counter (`useReadOrder`) orders every read, the polls
 *   too: only the latest read's answer is used.
 * - A poll every 15 s while the tab is visible and no dialog is open
 *   (`useVisiblePolling`) reads from the first page until it has
 *   `max(shown, 50)` fleets, and replaces the rows and the cursor. It never
 *   starts before the first load is in, while a person's read is under way
 *   or while a 429 holds the polls; a person's read supersedes a poll under
 *   way (aborting it). A poll's 404 `organization_not_found` or 403
 *   `terms_acceptance_required` revalidates the layout; its 401 is the
 *   session-ended handler's; anything else (a 503, no connection, the 10 s
 *   abort) is silent, and the rows stay.
 * - Nothing loads while the layout says the terms need accepting.
 * - A person's read refused with `organization_not_found` or
 *   `terms_acceptance_required` revalidates the layout, with no toast; a
 *   401 says nothing (the session-ended handler has the page). Anything
 *   else: a list of this organization and filter already shown stays, and
 *   "Failed to load fleets" is toasted; with none, `failed` (the page's
 *   error and "Try again", never the onboarding card).
 *   "Load more"'s failure toasts the same and keeps the rows.
 * - A 429 anywhere (a poll's, a person's read's, "Load more"'s) holds the
 *   polls until its `Retry-After` has passed; one without `Retry-After`
 *   holds nothing, and the next poll comes 15 s on.
 */
export function useFleetsList({ status }: { status: FleetStatus | undefined }): FleetsList {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const termsRequired = useTermsRequired();
  const { revalidate } = useRevalidator();
  const { begin, holdPollsFor, pollsHeld, latestRead } = useReadOrder();

  const [shown, setShown] = useState<ShownFleets | null>(null);
  const shownRef = useRef<ShownFleets | null>(null);
  const show = useCallback((next: ShownFleets | null) => {
    shownRef.current = next;
    setShown(next);
  }, []);

  const [personsRead, setPersonsReadState] = useState<PersonsRead>(null);
  const personsReadRef = useRef<PersonsRead>(null);
  const setPersonsRead = useCallback((next: PersonsRead) => {
    personsReadRef.current = next;
    setPersonsReadState(next);
  }, []);

  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

  /** Whether the shown list is this organization's, with this filter. */
  const isShownFor = useCallback(
    (listed: ShownFleets | null, organization: string, filter: FleetStatus | undefined): listed is ShownFleets =>
      listed !== null && listed.organizationId === organization && listed.status === filter,
    [],
  );

  useEffect(() => {
    const read = begin();
    if (organizationId === null || termsRequired) {
      setPersonsRead(null);
      setFailed(false);
      return;
    }
    const listed = shownRef.current;
    const target = isShownFor(listed, organizationId, status)
      ? Math.max(listed.fleets.length, FLEETS_PAGE_DEFAULT_LIMIT)
      : FLEETS_PAGE_DEFAULT_LIMIT;
    setPersonsRead("first");
    setFailed(false);
    void (async () => {
      try {
        const answer = await readFirstPages(organizationId, status, target, read.track, read.isCurrent);
        if (answer === null) return;
        show({ organizationId, status, ...answer, read: read.number });
        setPersonsRead(null);
      } catch (error) {
        if (!read.isCurrent()) return;
        setPersonsRead(null);
        holdPollsFor(error);
        if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
          void revalidate();
          return;
        }
        // The session is over: the session-ended handler, or Logout, has the page.
        if (isSessionEnded(error)) return;
        if (isShownFor(shownRef.current, organizationId, status)) {
          toast.error(FLEETS_LOAD_FAILED_MESSAGE);
          return;
        }
        show(null);
        setFailed(true);
      } finally {
        read.settle();
      }
    })();
  }, [organizationId, status, termsRequired, generation, begin, holdPollsFor, isShownFor, revalidate, setPersonsRead, show]);

  const loadMore = useCallback(() => {
    const listed = shownRef.current;
    if (organizationId === null || !isShownFor(listed, organizationId, status) || listed.nextCursor === null) return;
    if (personsReadRef.current !== null) return;
    const read = begin();
    setPersonsRead("more");
    const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
    read.track(guard);
    readsFor(listed.organizationId)
      .getFleets(listed.organizationId, { status: listed.status, cursor: listed.nextCursor }, { signal: guard.signal })
      .then(
        (page) => {
          if (!read.isCurrent()) return;
          setPersonsRead(null);
          const before = shownRef.current ?? listed;
          // A fleet the list moved past while paging is shown once.
          const seen = new Set(before.fleets.map((fleet) => fleet.id));
          const added = page.fleets.filter((fleet) => !seen.has(fleet.id));
          show({ ...before, fleets: [...before.fleets, ...added], nextCursor: page.nextCursor, read: read.number });
        },
        (error: unknown) => {
          if (!read.isCurrent()) return;
          setPersonsRead(null);
          holdPollsFor(error);
          if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
            void revalidate();
            return;
          }
          if (isSessionEnded(error)) return;
          toast.error(FLEETS_LOAD_FAILED_MESSAGE);
        },
      )
      .finally(() => {
        guard.clear();
        read.settle();
      });
  }, [organizationId, status, begin, holdPollsFor, isShownFor, revalidate, setPersonsRead, show]);

  const poll = useCallback(async () => {
    if (organizationId === null || termsRequired) return;
    const listed = shownRef.current;
    // Nothing polls before the first load is in, while a person's read is under way, or while a 429 holds it.
    if (!isShownFor(listed, organizationId, status) || personsReadRef.current !== null || pollsHeld()) return;
    const read = begin();
    try {
      const target = Math.max(listed.fleets.length, FLEETS_PAGE_DEFAULT_LIMIT);
      const answer = await readFirstPages(organizationId, listed.status, target, read.track, read.isCurrent);
      if (answer === null) return;
      show({ organizationId, status: listed.status, ...answer, read: read.number });
    } catch (error) {
      if (!read.isCurrent()) return;
      holdPollsFor(error);
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) void revalidate();
      // Anything else is silent and the rows stay: a 401 is the session-ended handler's.
    } finally {
      read.settle();
    }
  }, [organizationId, status, termsRequired, begin, holdPollsFor, isShownFor, pollsHeld, revalidate, show]);

  useVisiblePolling(poll, FLEETS_POLL_INTERVAL_MS);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  const current = shown !== null && shown.organizationId === organizationId ? shown : null;
  return {
    fleets: current?.fleets ?? null,
    rowsRead: current?.read ?? 0,
    latestRead,
    shownStatus: current?.status,
    hasMore: current?.nextCursor != null,
    isLoadingMore: personsRead === "more",
    isStale: personsRead === "first" && current !== null,
    failed: failed && current === null,
    loadMore,
    reload,
  };
}

/** What a fleet's page shows: the fleet, or what its read found, for the organization and fleet it was read in. */
type ShownFleet =
  | { organizationId: string; fleetId: string; kind: "loaded"; fleet: FleetDetail; read: number }
  | { organizationId: string; fleetId: string; kind: "not_found" | "failed" };

export interface FleetRead {
  /** The fleet, with its summary; null until it has answered, or when it isn't there. */
  fleet: FleetDetail | null;
  /**
   * `loading` until the first read answers; `not_found` for a fleet the API
   * doesn't have (deleted, meanwhile too, or another organization's) or an
   * id that isn't a UUID (no request); `failed` for a first read that
   * failed otherwise (the page's "Try again", `reload`).
   */
  state: "loading" | "loaded" | "not_found" | "failed";
  /** Whether a person's read is under way while the fleet is shown (after a rename, say). */
  isReloading: boolean;
  /**
   * The number of the read `fleet` came from (`useReadOrder`'s), 0 with
   * none shown: a tab's focus after its write follows only a fleet read
   * begun after it (the Tokens tab's banner).
   */
  fleetRead: number;
  /** The latest read's number, begun or not yet answered: taken by a tab's write before it calls `reload`. */
  latestRead: () => number;
  /** Reads the fleet again: after a write, or "Try again". */
  reload: () => void;
}

/**
 * One fleet of the active organization, for its page, polled every 15 s while
 * the tab is visible so its header follows a rename or an archive made
 * elsewhere.
 *
 * - An id that isn't a canonical UUID is `not_found` with no request.
 * - The read orders as the list's (`useReadOrder`): only the latest read's
 *   answer is used, a person's read supersedes a poll, a poll never starts
 *   before the first read is in or while a person's read is under way or a
 *   429 holds it, each read carries the 10 s hang guard, and an unmount
 *   aborts it. An organization switch reads again, in the new organization
 *   (whose answer for another's fleet is `not_found`).
 * - A 404 `fleet_not_found`, a person's or a poll's, is `not_found` (a fleet
 *   deleted while open). `organization_not_found` and
 *   `terms_acceptance_required` revalidate the layout; a 401 is the
 *   session-ended handler's. Otherwise a poll is silent and the fleet stays;
 *   a person's read toasts "Failed to load fleet" over a fleet shown, or is
 *   `failed` with none.
 * - Nothing loads while the layout says the terms need accepting.
 * - The fleet carries the number of the read it came from (`fleetRead`),
 *   beside `latestRead`, as the list's rows do: the Tokens tab's focus
 *   after a write follows only a fleet from a read begun after it.
 */
export function useFleet(fleetId: string): FleetRead {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const termsRequired = useTermsRequired();
  const { revalidate } = useRevalidator();
  const { begin, holdPollsFor, pollsHeld, latestRead } = useReadOrder();
  const wellFormed = isCanonicalUuid(fleetId);
  const id = fleetId.toLowerCase();

  const [shown, setShown] = useState<ShownFleet | null>(null);
  const shownRef = useRef<ShownFleet | null>(null);
  const show = useCallback((next: ShownFleet) => {
    shownRef.current = next;
    setShown(next);
  }, []);

  const [reading, setReadingState] = useState(false);
  const readingRef = useRef(false);
  const setReading = useCallback((next: boolean) => {
    readingRef.current = next;
    setReadingState(next);
  }, []);

  const [generation, setGeneration] = useState(0);

  const loadedFleet = useCallback(
    (organization: string): FleetDetail | null => {
      const current = shownRef.current;
      return current?.kind === "loaded" && current.organizationId === organization && current.fleetId === id
        ? current.fleet
        : null;
    },
    [id],
  );

  useEffect(() => {
    const read = begin();
    if (organizationId === null || termsRequired || !wellFormed) {
      setReading(false);
      return;
    }
    setReading(true);
    const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
    read.track(guard);
    readsFor(organizationId)
      .getFleet(organizationId, id, { signal: guard.signal })
      .then(
        (fleet) => {
          if (!read.isCurrent()) return;
          setReading(false);
          show({ organizationId, fleetId: id, kind: "loaded", fleet, read: read.number });
        },
        (error: unknown) => {
          if (!read.isCurrent()) return;
          setReading(false);
          holdPollsFor(error);
          if (isFleetGone(error)) {
            show({ organizationId, fleetId: id, kind: "not_found" });
            return;
          }
          if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
            void revalidate();
            return;
          }
          if (isSessionEnded(error)) return;
          if (loadedFleet(organizationId) !== null) {
            toast.error(FLEET_LOAD_FAILED_MESSAGE);
            return;
          }
          show({ organizationId, fleetId: id, kind: "failed" });
        },
      )
      .finally(() => {
        guard.clear();
        read.settle();
      });
  }, [organizationId, id, wellFormed, termsRequired, generation, begin, holdPollsFor, loadedFleet, revalidate, setReading, show]);

  const poll = useCallback(async () => {
    if (organizationId === null || termsRequired || !wellFormed) return;
    if (loadedFleet(organizationId) === null || readingRef.current || pollsHeld()) return;
    const read = begin();
    const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
    read.track(guard);
    try {
      const fleet = await readsFor(organizationId).getFleet(organizationId, id, { signal: guard.signal });
      if (read.isCurrent()) show({ organizationId, fleetId: id, kind: "loaded", fleet, read: read.number });
    } catch (error) {
      if (!read.isCurrent()) return;
      holdPollsFor(error);
      if (isFleetGone(error)) show({ organizationId, fleetId: id, kind: "not_found" });
      else if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) void revalidate();
      // Anything else is silent and the fleet stays: a 401 is the session-ended handler's.
    } finally {
      guard.clear();
      read.settle();
    }
  }, [organizationId, id, wellFormed, termsRequired, begin, holdPollsFor, loadedFleet, pollsHeld, revalidate, show]);

  useVisiblePolling(poll, FLEETS_POLL_INTERVAL_MS);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  const none = { fleet: null, isReloading: false, fleetRead: 0, latestRead, reload };
  if (!wellFormed) return { ...none, state: "not_found" };
  const current = shown !== null && shown.organizationId === organizationId && shown.fleetId === id ? shown : null;
  // "Try again" after a failed first read shows the loading state again.
  if (current === null || (current.kind === "failed" && reading)) return { ...none, state: "loading" };
  if (current.kind !== "loaded") return { ...none, state: current.kind };
  return { fleet: current.fleet, state: "loaded", isReloading: reading, fleetRead: current.read, latestRead, reload };
}
