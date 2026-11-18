import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import type { CollectorGroup } from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import { isSessionEnded } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { FLEET_READ_TIMEOUT_MS, FLEETS_POLL_INTERVAL_MS, isFleetGone, useReadOrder, useTermsRequired } from "~/lib/fleets.js";
import { useVisiblePolling } from "~/lib/hooks/use-visible-polling.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { readsFor } from "~/lib/workspace-reads.js";

/*
 * A server fleet's Groups tab's data (D17b-2 decisions 10, 23 and 32;
 * Preflight ruling 10): the fleet's groups, the Default group first, then by
 * name, polled every 15 seconds while the tab is visible. Nothing here puts
 * a group's or a configuration's name anywhere but the data it returns: no
 * toast, log or attribute carries one (ADR 0024).
 */

/** The toast of a person's read that failed over rows shown, and the failed state's words (decision 23). */
export const GROUPS_LOAD_FAILED_MESSAGE = "Failed to load groups";

/** What the tab shows: the fleet's groups, for the organization and fleet they were read in. */
interface ShownGroups {
  organizationId: string;
  fleetId: string;
  groups: CollectorGroup[];
  /** The number of the read the rows came from (`useReadOrder`'s): a person's or a poll's. */
  read: number;
}

/** A read's answer: the groups, or why there are none. */
type Answer = { ok: true; groups: CollectorGroup[] } | { ok: false; error: unknown };

export interface GroupsTabOptions {
  /** Called when a read finds the fleet gone (404 `fleet_not_found`): the route's `useFleet().reload`, so the page shows "Fleet not found". */
  onFleetGone: () => void;
  /**
   * A second reader of the same groups (the setup checklist, D17c-1 Ruling 61): a person's read that fails over rows
   * shown says nothing (the Groups tab's own read toasts it), so the page never shows the toast twice; with none
   * shown it is still `failed`.
   */
  quiet?: boolean;
}

export interface GroupsTabRead {
  /** The fleet's groups, the Default group first; null until the first read has answered, or after it failed with nothing shown. */
  groups: CollectorGroup[] | null;
  /** The number of the read `groups` came from, 0 with none shown (`useReturnFocus`'s `rowsChanged`). */
  rowsRead: number;
  /** The latest read's number, begun or not yet answered (`useReturnFocus`'s `wrote`, taken before a write's `reload`). */
  latestRead: () => number;
  /** Whether a person's read (the first, a refresh, a write's reload, "Try again") is under way: the refresh button spins. */
  personsRead: boolean;
  /** Whether the latest person's read failed with nothing shown: "Failed to load groups", with "Try again" (`reload`). */
  failed: boolean;
  /** Reads the groups again, as a person's read: after a write, the refresh button, or "Try again". */
  reload: () => void;
}

/**
 * A fleet's groups, both fleet types' (D17b-2 decisions 10, 23 and 32;
 * Preflight ruling 10; D17d-1 decision 24), for the Groups tab: a server
 * fleet's `GroupsTab` and a Kubernetes-supervisor fleet's
 * `KubernetesGroupsTab`; `onFleetGone` is the route's `useFleet().reload`.
 *
 * - The groups load for the active organization and the fleet; an
 *   organization switch, or another fleet, drops what was shown and starts
 *   over. Nothing loads while the layout says the terms need accepting.
 * - Every read takes the next number from `useReadOrder` and aborts the read
 *   under way; only the latest read's answer is used, so a late answer, an
 *   answer superseded by a newer read, or one for an organization left
 *   meanwhile is dropped. Each read has its 10 s hang guard.
 * - `reload` is a person's read: it supersedes a poll under way, the rows
 *   stay shown meanwhile, and its failure toasts "Failed to load groups" and
 *   keeps them (or is `failed` with none shown); `quiet` (a second reader's)
 *   keeps them with no toast. `organization_not_found`
 *   and `terms_acceptance_required` revalidate the layout, and a 401 is the
 *   session-ended handler's: no toast.
 * - A poll every 15 s while the tab is visible and no dialog is open
 *   (`useVisiblePolling`) reads the groups and replaces the rows. It never
 *   starts before the first read is in, during a person's read, or while a
 *   429 holds the polls; its 503, network failure, abort or 401 is silent
 *   and the rows stay.
 * - A 404 `fleet_not_found` on any read calls `onFleetGone`: no toast, no
 *   failed state.
 * - A 429 anywhere holds this hook's polls until its `Retry-After`.
 */
export function useGroupsTab(fleetId: string, { onFleetGone, quiet = false }: GroupsTabOptions): GroupsTabRead {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const termsRequired = useTermsRequired();
  const { revalidate } = useRevalidator();
  const { begin, holdPollsFor, pollsHeld, latestRead } = useReadOrder();

  const latestOnFleetGone = useRef(onFleetGone);
  useEffect(() => {
    latestOnFleetGone.current = onFleetGone;
  });

  const [shown, setShown] = useState<ShownGroups | null>(null);
  const shownRef = useRef<ShownGroups | null>(null);
  const show = useCallback((next: ShownGroups | null) => {
    shownRef.current = next;
    setShown(next);
  }, []);

  const [personsRead, setPersonsReadState] = useState(false);
  const personsReadRef = useRef(false);
  const setPersonsRead = useCallback((next: boolean) => {
    personsReadRef.current = next;
    setPersonsReadState(next);
  }, []);

  const [failed, setFailed] = useState(false);

  /** The groups shown, if they are this organization's and this fleet's. */
  const shownFor = useCallback(
    (organization: string): ShownGroups | null => {
      const current = shownRef.current;
      return current !== null && current.organizationId === organization && current.fleetId === fleetId ? current : null;
    },
    [fleetId],
  );

  /**
   * Takes a read's answer in: the groups are shown with the read's number. A
   * failure: a 429 holds the polls, a fleet found gone goes to
   * `onFleetGone`, the organization's and the terms' refusals revalidate the
   * layout, a 401 says nothing; otherwise a poll's is silent, and a person's
   * toasts over rows shown or is `failed` with none.
   */
  const takeIn = useCallback(
    (organization: string, answer: Answer, read: number, persons: boolean) => {
      if (answer.ok) {
        show({ organizationId: organization, fleetId, groups: answer.groups, read });
        return;
      }
      const { error } = answer;
      holdPollsFor(error);
      if (isFleetGone(error)) {
        latestOnFleetGone.current();
        return;
      }
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
        void revalidate();
        return;
      }
      // The session is over: the session-ended handler, or Logout, has the page (D12 Ruling 39).
      if (!persons || isSessionEnded(error)) return;
      if (shownFor(organization) !== null) {
        if (!quiet) toast.error(GROUPS_LOAD_FAILED_MESSAGE);
        return;
      }
      setFailed(true);
    },
    [fleetId, holdPollsFor, quiet, revalidate, show, shownFor],
  );

  /** One read of the groups under its own hang guard; null once a newer read has begun. */
  const readGroups = useCallback(
    async (organization: string, read: ReturnType<typeof begin>): Promise<Answer | null> => {
      const guard = abortAfter(FLEET_READ_TIMEOUT_MS);
      read.track(guard);
      try {
        const answer: Answer = await readsFor(organization).getCollectorGroups(organization, fleetId, { signal: guard.signal }).then(
          ({ groups }) => ({ ok: true, groups }),
          (error: unknown) => ({ ok: false, error }),
        );
        return read.isCurrent() ? answer : null;
      } finally {
        guard.clear();
        read.settle();
      }
    },
    [fleetId],
  );

  /** A person's read: the first, a refresh, a write's reload or "Try again". */
  const readAsPerson = useCallback(
    (organization: string) => {
      const read = begin();
      setPersonsRead(true);
      setFailed(false);
      void readGroups(organization, read).then((answer) => {
        if (answer === null) return;
        setPersonsRead(false);
        takeIn(organization, answer, read.number, true);
      });
    },
    [begin, readGroups, setPersonsRead, takeIn],
  );

  useEffect(() => {
    // Another organization's or another fleet's groups are never shown.
    show(null);
    setFailed(false);
    if (organizationId === null || termsRequired) {
      begin();
      setPersonsRead(false);
      return;
    }
    readAsPerson(organizationId);
  }, [organizationId, fleetId, termsRequired, begin, readAsPerson, setPersonsRead, show]);

  const reload = useCallback(() => {
    if (organizationId === null || termsRequired) return;
    readAsPerson(organizationId);
  }, [organizationId, termsRequired, readAsPerson]);

  const poll = useCallback(async () => {
    if (organizationId === null || termsRequired) return;
    // Nothing polls before the first read is in, during a person's read, or while a 429 holds it.
    if (shownFor(organizationId) === null || personsReadRef.current || pollsHeld()) return;
    const read = begin();
    const answer = await readGroups(organizationId, read);
    if (answer !== null) takeIn(organizationId, answer, read.number, false);
  }, [organizationId, termsRequired, begin, pollsHeld, readGroups, shownFor, takeIn]);

  useVisiblePolling(poll, FLEETS_POLL_INTERVAL_MS);

  const current =
    shown !== null && shown.organizationId === organizationId && shown.fleetId === fleetId ? shown : null;
  return {
    groups: current?.groups ?? null,
    rowsRead: current?.read ?? 0,
    latestRead,
    personsRead,
    failed: failed && current === null,
    reload,
  };
}
