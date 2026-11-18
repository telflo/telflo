import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import type { Collector, CollectorGroup, CollectorsPage, FleetSummary } from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import { isSessionEnded, type CollectorsQuery } from "~/lib/api-client.js";
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
 * A server fleet's Collectors tab's data (D17b-1 decisions 2, 3, 21 and 29;
 * Preflight ruling 9): one page of the fleet's collectors at a time, with
 * Prev and Next over the cursors of the pages seen, a search, a Group
 * filter and a sort, and the fleet's groups, polled every 15 seconds while
 * the tab is visible. Nothing here puts a collector's or a group's name, an
 * address or the search text anywhere but the data it returns: no toast,
 * log or attribute carries one (ADR 0024).
 */

/** How many collectors a page holds (decision 21). */
export const COLLECTORS_PAGE_SIZE = 50;

/** The toast of a person's read that failed over rows shown, and the failed state's words (decision 21). */
export const COLLECTORS_LOAD_FAILED_MESSAGE = "Failed to load collectors";

/** The columns a person sorts by (decision 21): Name and Last seen. */
export type CollectorsSortColumn = "name" | "lastSeen";

/** What the page is read with: the search text, the Group filter and the sort. */
export interface CollectorsListQuery {
  /** The search text, trimmed; "" searches nothing. */
  q: string;
  /** One group's collectors, or null for "All groups". */
  groupId: string | null;
  /** The sorted column, or null for the API's default (newest first), shown as no column sorted. */
  sort: CollectorsSortColumn | null;
  /** The sorted column's order; unused while `sort` is null. */
  order: "asc" | "desc";
}

/** A first read's query: nothing searched or filtered, newest first. */
export const DEFAULT_COLLECTORS_QUERY: CollectorsListQuery = { q: "", groupId: null, sort: null, order: "desc" };

/** The reported attribute naming a Kubernetes collector's node (the collector image reports it from NODE_NAME). */
export const KUBERNETES_NODE_ATTRIBUTE = "k8s.node.name";

/**
 * The node a Kubernetes fleet's collector runs on (D17d-1 decision 23;
 * Preflight ruling 26): its reported `k8s.node.name`, read as an own key
 * only (never an inherited one), else null. Configuration text: shown
 * inside `ph-no-capture` only, never in an attribute.
 */
export function collectorNodeName(attributes: Record<string, string> | null): string | null {
  if (attributes === null || !Object.hasOwn(attributes, KUBERNETES_NODE_ATTRIBUTE)) return null;
  const node = attributes[KUBERNETES_NODE_ATTRIBUTE];
  return typeof node === "string" && node !== "" ? node : null;
}

/**
 * Where the page stands: its query, the cursors of the pages seen
 * (`cursors[0]` undefined, `cursors[i]` page i's; always `index + 1` of
 * them) and the page's index.
 */
interface Position {
  query: CollectorsListQuery;
  cursors: readonly (string | undefined)[];
  index: number;
}

function firstPageOf(query: CollectorsListQuery): Position {
  return { query, cursors: [undefined], index: 0 };
}

/** The API's query for a position: only what is asked, the page's size, and its cursor. */
function requestOf({ query, cursors, index }: Position): CollectorsQuery {
  return {
    q: query.q === "" ? undefined : query.q,
    groupId: query.groupId ?? undefined,
    sort: query.sort ?? undefined,
    order: query.sort === null ? undefined : query.order,
    limit: COLLECTORS_PAGE_SIZE,
    cursor: cursors[index],
  };
}

/**
 * What a read found. `errors` holds every failure it met (the page's and
 * the groups'), for the 429s and the fleet's, the organization's and the
 * terms' refusals; `groups` the fleet's groups when their read answered.
 */
type ReadOutcome =
  | { kind: "superseded" }
  | { kind: "read"; position: Position; page: CollectorsPage; groups: CollectorGroup[] | null; errors: unknown[] }
  | { kind: "failed"; error: unknown; groups: CollectorGroup[] | null; errors: unknown[] };

type Settled<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

function settledOf<Value>(result: PromiseSettledResult<Value>): Settled<Value> {
  return result.status === "fulfilled" ? { ok: true, value: result.value } : { ok: false, error: result.reason };
}

/**
 * One read (the first, a person's or a poll's; Preflight ruling 9): the page
 * at `start` and the fleet's groups together, both under the read's one
 * hang guard (`signal`); the read fails only when the page does. Within the
 * same read, under the same guard:
 * - a stale cursor reads the query's first page, silently;
 * - a filter whose group the groups' answer no longer holds reads the first
 *   page of "All groups";
 * - an empty page other than the first steps back a page, until a page has
 *   rows or the first is reached (so an emptied last page never shows the
 *   empty fleet's state).
 * `superseded` once `isCurrent` says a newer read has begun.
 */
async function readCollectors(
  organizationId: string,
  fleetId: string,
  start: Position,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ReadOutcome> {
  const reads = readsFor(organizationId);
  const readPage = (position: Position) => reads.getCollectors(organizationId, fleetId, requestOf(position), { signal });
  const [pageResult, groupsResult] = await Promise.allSettled([
    readPage(start),
    reads.getCollectorGroups(organizationId, fleetId, { signal }),
  ]);
  if (!isCurrent()) return { kind: "superseded" };
  const groupsAnswer = settledOf(groupsResult);
  const groups = groupsAnswer.ok ? groupsAnswer.value.groups : null;
  const errors: unknown[] = groupsAnswer.ok ? [] : [groupsAnswer.error];

  let position = start;
  let answer = settledOf(pageResult);
  for (;;) {
    let next: Position;
    if (!answer.ok) {
      if (position.index === 0 || !isStaleCursor(answer.error)) {
        return { kind: "failed", error: answer.error, groups, errors: [...errors, answer.error] };
      }
      next = firstPageOf(position.query);
    } else if (groups !== null && position.query.groupId !== null && !groups.some((group) => group.id === position.query.groupId)) {
      next = firstPageOf({ ...position.query, groupId: null });
    } else if (answer.value.collectors.length === 0 && position.index > 0) {
      next = { query: position.query, cursors: position.cursors.slice(0, position.index), index: position.index - 1 };
    } else {
      return { kind: "read", position, page: answer.value, groups, errors };
    }
    position = next;
    const [nextResult] = await Promise.allSettled([readPage(position)]);
    if (!isCurrent()) return { kind: "superseded" };
    answer = settledOf(nextResult);
  }
}

/** What the tab shows: a page of the fleet's collectors, for the organization and fleet it was read in. */
interface ShownPage {
  organizationId: string;
  fleetId: string;
  position: Position;
  collectors: Collector[];
  nextCursor: string | null;
  /** The number of the read the rows came from (`useReadOrder`'s): a person's or a poll's. */
  read: number;
}

/** The fleet's groups as the latest read that answered them gave them. */
interface ShownGroups {
  organizationId: string;
  fleetId: string;
  groups: CollectorGroup[];
}

/** The pager's numbers (decision 21): "Showing {from} to {to} of {total}" (an en dash between), without "of" when `total` is null. */
export interface CollectorsPager {
  from: number;
  to: number;
  /** `max(summary.collectors, to)` when nothing is searched or filtered; null otherwise (the API counts nothing). */
  total: number | null;
}

export interface CollectorsPageOptions {
  /** Called when a read finds the fleet gone (404 `fleet_not_found`): the route's `useFleet().reload`, so the page shows "Fleet not found". */
  onFleetGone: () => void;
}

export interface CollectorsPageRead {
  /** The page's collectors; null until the first read has answered, or after it failed with nothing shown. */
  collectors: Collector[] | null;
  /** The number of the read `collectors` came from, 0 with none shown (`useReturnFocus`'s `rowsChanged`). */
  rowsRead: number;
  /** The latest read's number, begun or not yet answered (`useReturnFocus`'s `wrote`, taken before a write's `reload`). */
  latestRead: () => number;
  /** The fleet's groups, the Default group first; null until a groups read has answered (the Group column shows a dash and the filter is disabled). */
  groups: CollectorGroup[] | null;
  /** The query of the rows shown (of the read asked for while none is shown): the search, the filter and the sort. */
  query: CollectorsListQuery;
  /** The shown page's index, 0 for the first. */
  pageIndex: number;
  /** Whether a page comes before the shown one. */
  hasPrev: boolean;
  /** Whether the shown page has a next one (its `nextCursor`). */
  hasNext: boolean;
  /** Whether a person's read (the first, a search, a filter, a sort, Prev, Next, a reload) is under way: Refresh spins; Prev and Next do nothing meanwhile. */
  personsRead: boolean;
  /** Whether the latest person's read failed with nothing shown: the failed state, with "Try again" (`reload`). */
  failed: boolean;
  /** The pager's numbers; null with no rows shown (the empty states have no pager). */
  pager: CollectorsPager | null;
  /** Searches for `text`, trimmed ("" searches nothing), from page 1. */
  search: (text: string) => void;
  /** Shows one group's collectors (null: every group's), from page 1. */
  filterByGroup: (groupId: string | null) => void;
  /** Sorts by a column: ascending on a first click, then alternating; from page 1. */
  sortBy: (column: CollectorsSortColumn) => void;
  /** Reads the next page; nothing without one, or while a person's read is under way. */
  next: () => void;
  /** Reads the previous page; nothing on the first, or while a person's read is under way. */
  prev: () => void;
  /** Reads the shown page again, as a person's read: after a write, Refresh, or "Try again". */
  reload: () => void;
}

/**
 * A server fleet's collectors, a page at a time (D17b-1 decisions 2, 21 and
 * 29; Preflight ruling 9), for the Collectors tab; `summary` is the fleet's
 * (the pager's total), `onFleetGone` the route's `useFleet().reload`.
 *
 * - Page 1 loads for the active organization and the fleet (newest first,
 *   nothing searched or filtered); an organization switch, or another fleet,
 *   drops what was shown and starts over. Nothing loads while the layout
 *   says the terms need accepting.
 * - Every read takes the next number from `useReadOrder` and aborts the read
 *   under way; only the latest read's answer is used, so a late answer, an
 *   answer superseded by a newer read, or one for an organization left
 *   meanwhile is dropped. Each read has one 10 s hang guard, for the page
 *   and the groups together (`readCollectors`).
 * - `search`, `filterByGroup` and `sortBy` read page 1 of the new query;
 *   `next` and `prev` move through the cursors of the pages seen; `reload`
 *   reads the shown page again. Each is a person's read: it supersedes a
 *   poll under way, the rows stay shown meanwhile, and its failure toasts
 *   "Failed to load collectors" and keeps them (or is `failed` with none
 *   shown). `organization_not_found` and `terms_acceptance_required`
 *   revalidate the layout, and a 401 is the session-ended handler's: no
 *   toast.
 * - A poll every 15 s while the tab is visible and no dialog is open
 *   (`useVisiblePolling`) reads the shown page with its cursor, query and
 *   sort, and the groups, and replaces the rows and the next cursor. It never
 *   starts before the first read is in, during a person's read, or while a
 *   429 holds the polls; its 503, network failure, abort or 401 is silent
 *   and the rows stay.
 * - A 404 `fleet_not_found` on any read calls `onFleetGone`: no toast, no
 *   failed state.
 * - A 429 anywhere holds this hook's polls until its `Retry-After`.
 * - A groups read's failure alone keeps the last groups (or none) and the
 *   rows are read as usual.
 */
export function useCollectorsPage(fleetId: string, summary: FleetSummary, { onFleetGone }: CollectorsPageOptions): CollectorsPageRead {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const termsRequired = useTermsRequired();
  const { revalidate } = useRevalidator();
  const { begin, holdPollsFor, pollsHeld, latestRead } = useReadOrder();

  const latestOnFleetGone = useRef(onFleetGone);
  useEffect(() => {
    latestOnFleetGone.current = onFleetGone;
  });

  const [shown, setShown] = useState<ShownPage | null>(null);
  const shownRef = useRef<ShownPage | null>(null);
  const show = useCallback((next: ShownPage | null) => {
    shownRef.current = next;
    setShown(next);
  }, []);

  const [shownGroups, setShownGroups] = useState<ShownGroups | null>(null);

  const [personsRead, setPersonsReadState] = useState(false);
  const personsReadRef = useRef(false);
  const setPersonsRead = useCallback((next: boolean) => {
    personsReadRef.current = next;
    setPersonsReadState(next);
  }, []);

  const [failed, setFailed] = useState(false);

  /**
   * The position of the latest read asked for: a person's under way, else
   * the one shown (or, after a failure with nothing shown, the one that
   * failed, which "Try again" reads again). A new query starts from its
   * query, so a search made while a filter's read is under way keeps the
   * filter.
   */
  const requestedRef = useRef<Position>(firstPageOf(DEFAULT_COLLECTORS_QUERY));
  const [requestedQuery, setRequestedQuery] = useState<CollectorsListQuery>(DEFAULT_COLLECTORS_QUERY);
  const request = useCallback((position: Position) => {
    requestedRef.current = position;
    setRequestedQuery(position.query);
  }, []);

  /** The page shown, if it is this organization's and this fleet's. */
  const shownFor = useCallback(
    (organization: string): ShownPage | null => {
      const current = shownRef.current;
      return current !== null && current.organizationId === organization && current.fleetId === fleetId ? current : null;
    },
    [fleetId],
  );

  /**
   * Takes a read's outcome in: its 429s hold the polls, a fleet found gone
   * goes to `onFleetGone`, the groups answered are kept, and the page is
   * shown with its read's number (`read`). A failure: the organization's
   * and the terms' revalidate the layout, a 401 says nothing; otherwise a
   * poll's is silent, and a person's toasts over rows shown or is `failed`
   * with none.
   */
  const takeIn = useCallback(
    (organization: string, outcome: Exclude<ReadOutcome, { kind: "superseded" }>, read: number, persons: boolean) => {
      for (const error of outcome.errors) holdPollsFor(error);
      if (outcome.errors.some(isFleetGone)) {
        latestOnFleetGone.current();
        return;
      }
      const revalidating = outcome.errors.some((error) => isOrganizationGone(error) || isTermsAcceptanceRequired(error));
      if (revalidating) void revalidate();
      if (outcome.groups !== null) setShownGroups({ organizationId: organization, fleetId, groups: outcome.groups });
      if (outcome.kind === "read") {
        show({
          organizationId: organization,
          fleetId,
          position: outcome.position,
          collectors: outcome.page.collectors,
          nextCursor: outcome.page.nextCursor,
          read,
        });
        request(outcome.position);
        return;
      }
      if (!persons) return;
      const current = shownFor(organization);
      // A failed person's read leaves the rows, their query and their page as they were.
      if (current !== null) request(current.position);
      // The session is over: the session-ended handler, or Logout, has the page (D12 Ruling 39).
      if (revalidating || isSessionEnded(outcome.error)) return;
      if (current !== null) {
        toast.error(COLLECTORS_LOAD_FAILED_MESSAGE);
        return;
      }
      setFailed(true);
    },
    [fleetId, holdPollsFor, request, revalidate, show, shownFor],
  );

  /** A person's read of `target`: the first, a search, a filter, a sort, Prev, Next or a reload. */
  const readAsPerson = useCallback(
    (organization: string, target: Position) => {
      const read = begin();
      request(target);
      setPersonsRead(true);
      setFailed(false);
      const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
      read.track(guard);
      void readCollectors(organization, fleetId, target, guard.signal, read.isCurrent)
        .then((outcome) => {
          if (outcome.kind === "superseded") return;
          setPersonsRead(false);
          takeIn(organization, outcome, read.number, true);
        })
        .finally(() => {
          guard.clear();
          read.settle();
        });
    },
    [fleetId, begin, request, setPersonsRead, takeIn],
  );

  useEffect(() => {
    // Another organization's or another fleet's page is never shown.
    show(null);
    setShownGroups(null);
    setFailed(false);
    const start = firstPageOf(DEFAULT_COLLECTORS_QUERY);
    if (organizationId === null || termsRequired) {
      begin();
      request(start);
      setPersonsRead(false);
      return;
    }
    readAsPerson(organizationId, start);
  }, [organizationId, fleetId, termsRequired, begin, readAsPerson, request, setPersonsRead, show]);

  /** A person's read from the latest position asked for, changed by `change`. */
  const readFrom = useCallback(
    (change: (latest: Position) => Position) => {
      if (organizationId === null || termsRequired) return;
      readAsPerson(organizationId, change(requestedRef.current));
    },
    [organizationId, termsRequired, readAsPerson],
  );

  const search = useCallback(
    (text: string) => readFrom((latest) => firstPageOf({ ...latest.query, q: text.trim() })),
    [readFrom],
  );

  const filterByGroup = useCallback(
    (groupId: string | null) => readFrom((latest) => firstPageOf({ ...latest.query, groupId })),
    [readFrom],
  );

  const sortBy = useCallback(
    (column: CollectorsSortColumn) =>
      readFrom((latest) => {
        const { query } = latest;
        const order = query.sort === column ? (query.order === "asc" ? "desc" : "asc") : "asc";
        return firstPageOf({ ...query, sort: column, order });
      }),
    [readFrom],
  );

  const next = useCallback(() => {
    if (organizationId === null || termsRequired || personsReadRef.current) return;
    const current = shownFor(organizationId);
    if (current === null || current.nextCursor === null) return;
    const { position } = current;
    readAsPerson(organizationId, {
      query: position.query,
      cursors: [...position.cursors, current.nextCursor],
      index: position.index + 1,
    });
  }, [organizationId, termsRequired, readAsPerson, shownFor]);

  const prev = useCallback(() => {
    if (organizationId === null || termsRequired || personsReadRef.current) return;
    const current = shownFor(organizationId);
    if (current === null || current.position.index === 0) return;
    const { position } = current;
    readAsPerson(organizationId, {
      query: position.query,
      cursors: position.cursors.slice(0, position.index),
      index: position.index - 1,
    });
  }, [organizationId, termsRequired, readAsPerson, shownFor]);

  const reload = useCallback(() => readFrom((latest) => latest), [readFrom]);

  const poll = useCallback(async () => {
    if (organizationId === null || termsRequired) return;
    const current = shownFor(organizationId);
    // Nothing polls before the first read is in, during a person's read, or while a 429 holds it.
    if (current === null || personsReadRef.current || pollsHeld()) return;
    const read = begin();
    const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
    read.track(guard);
    try {
      const outcome = await readCollectors(organizationId, fleetId, current.position, guard.signal, read.isCurrent);
      if (outcome.kind !== "superseded") takeIn(organizationId, outcome, read.number, false);
    } finally {
      guard.clear();
      read.settle();
    }
  }, [organizationId, fleetId, termsRequired, begin, pollsHeld, shownFor, takeIn]);

  useVisiblePolling(poll, FLEETS_POLL_INTERVAL_MS);

  const current =
    shown !== null && shown.organizationId === organizationId && shown.fleetId === fleetId ? shown : null;
  const groups =
    shownGroups !== null && shownGroups.organizationId === organizationId && shownGroups.fleetId === fleetId
      ? shownGroups.groups
      : null;
  const query = current?.position.query ?? requestedQuery;
  const pageIndex = current?.position.index ?? 0;
  const rows = current?.collectors.length ?? 0;
  let pager: CollectorsPager | null = null;
  if (current !== null && rows > 0) {
    const from = pageIndex * COLLECTORS_PAGE_SIZE + 1;
    const to = pageIndex * COLLECTORS_PAGE_SIZE + rows;
    const unsearched = query.q === "" && query.groupId === null;
    pager = { from, to, total: unsearched ? Math.max(summary.collectors, to) : null };
  }
  return {
    collectors: current?.collectors ?? null,
    rowsRead: current?.read ?? 0,
    latestRead,
    groups,
    query,
    pageIndex,
    hasPrev: pageIndex > 0,
    hasNext: current?.nextCursor != null,
    personsRead,
    failed: failed && current === null,
    pager,
    search,
    filterByGroup,
    sortBy,
    next,
    prev,
    reload,
  };
}
