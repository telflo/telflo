import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";
import { toast } from "sonner";
import {
  CONFIGURATION_ERROR_CODES,
  ORGANIZATION_ERROR_CODES,
  type Configuration,
  type ConfigurationErrorCode,
  type ConfigurationsListFilter,
  type FleetErrorCode,
  type IdentityErrorCode,
  type OrganizationErrorCode,
  type OrganizationRole,
  type SessionErrorCode,
} from "@telflo/contracts";
import { ApiError, getConfigurations, isSessionEnded } from "~/lib/api-client.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import type { AppLayoutData } from "~/routes/app-layout.js";

/** The toast for a list, or an editor, that didn't load (D7 Parity Notes; D8 decision 12). */
export const LOAD_FAILED_MESSAGE = "Failed to load configuration";

/** How long the search waits after the last keystroke before it asks the API (D7 decision 12). */
export const SEARCH_DELAY_MS = 300;

const TERMS_ACCEPTANCE_REQUIRED: IdentityErrorCode = "terms_acceptance_required";
const ORGANIZATION_NOT_FOUND: OrganizationErrorCode = "organization_not_found";
const CONFIGURATION_NOT_FOUND: ConfigurationErrorCode = "configuration_not_found";
const FLEETS_UNAVAILABLE: FleetErrorCode = "fleets_unavailable";
const RATE_LIMITED: SessionErrorCode = "rate_limited";

/**
 * The refusals whose message the configurations page shows as it is (D7
 * Preflight ruling 2): the configuration's own codes (D11b's among them:
 * the delete's 403, a published version's 409, publishing's 503; D16b's
 * delete refused while a fleet uses the configuration, 409), the
 * organization's, the terms', and two more a delete answers (D16b
 * Preflight ruling 6): `fleets_unavailable`, its fleet usage unreadable
 * (503, "nothing was deleted"), and `rate_limited`, the person's fleet
 * limit spent (429). It is an allow-list, so a server error's "Something went wrong"
 * or `invalid_request`'s "The request was not valid." never reaches the user.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ...CONFIGURATION_ERROR_CODES,
  ...ORGANIZATION_ERROR_CODES,
  TERMS_ACCEPTANCE_REQUIRED,
  FLEETS_UNAVAILABLE,
  RATE_LIMITED,
]);

/** Whether a failure is the API refusing, with one of those codes. */
export function isConfigurationRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && REFUSAL_CODES.has(error.code);
}

/**
 * What the user is told about a failed configurations request: an API
 * refusal's own message, or the caller's fallback for
 * anything else, as `lib/organizations.ts`'s `refusalMessage` does.
 */
export function configurationRefusalMessage(error: unknown, fallback: string): string {
  return isConfigurationRefusal(error) ? error.message : fallback;
}

/**
 * Whether a request found the page's organization no longer the session's
 * active one (a switch in another tab, a removal, a deletion). The page then
 * revalidates the signed-in layout, whose fresh `/me` names the session's
 * organization, and the list starts over there; nothing is toasted.
 */
export function isOrganizationGone(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === ORGANIZATION_NOT_FOUND;
}

/** Whether a request found the configuration gone: deleted by someone else, meanwhile. */
export function isConfigurationGone(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === CONFIGURATION_NOT_FOUND;
}

/** Whether a request was refused because the current terms aren't accepted (D7 decision 10). */
export function isTermsAcceptanceRequired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === TERMS_ACCEPTANCE_REQUIRED;
}

/**
 * For a dialog's create or delete: whether an answer that arrives now is
 * still the dialog's to act on. It isn't once the dialog has unmounted (the
 * page went away, and a fresh dialog may be open in its place), or once the
 * page's organization is no longer the one the request was sent in. Such an
 * answer closes nothing, reloads nothing, toasts and captures nothing.
 */
export function useStillCurrent(organizationId: string): (sentIn: string) => boolean {
  const mounted = useRef(false);
  const latestOrganizationId = useRef(organizationId);
  useEffect(() => {
    latestOrganizationId.current = organizationId;
  }, [organizationId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback((sentIn: string) => mounted.current && latestOrganizationId.current === sentIn, []);
}

/**
 * Whether the signed-in member may delete a configuration (D11b decision 2):
 * its author, or an admin of the organization. One whose author's account is
 * gone is an admin's alone. The API decides (403
 * `configuration_delete_forbidden`); this only hides Delete where it would
 * be refused.
 */
export function canDeleteConfiguration(
  configuration: Configuration,
  currentUserId: string,
  role: OrganizationRole | undefined,
): boolean {
  if (role === "admin") return true;
  return configuration.createdBy !== null && currentUserId !== "" && configuration.createdBy.userId === currentUserId;
}

/** What the list shows, and the query and the load that produced it. */
interface ShownList {
  /** The load (the first page, and the "Load more"s after it) that this list belongs to. */
  load: number;
  organizationId: string;
  q: string;
  filter: ConfigurationsListFilter;
  items: Configuration[];
  nextCursor: string | null;
}

export interface ConfigurationsList {
  /** The configurations shown, newest update first; null until the organization's first page has answered. */
  items: Configuration[] | null;
  /** Whether the shown list was searched or filtered (Mine, Published), which decides its empty state. */
  isFiltered: boolean;
  /** Whether a next page exists. */
  hasMore: boolean;
  /** Whether "Load more" is under way. */
  isLoadingMore: boolean;
  /**
   * Whether the shown list is an older load's than the latest one asked for:
   * a new first page (a search, a filter, a reload) is under way. Such a list
   * isn't paged. A first page that fails keeps the organization's list, which
   * becomes the failed load's and is paged again, with its own query.
   */
  isStale: boolean;
  /**
   * Fetches the next page and appends it, dropping any configuration already
   * shown. It does nothing unless the shown list is the latest load's.
   */
  loadMore: () => void;
  /** Starts over, with the same search and filter. */
  reload: () => void;
}

/**
 * The configurations list of the active organization, a page at a time (D7
 * decision 6), through the browser client in effects rather than a server
 * loader (D2b's Handoffs).
 *
 * - The first page loads for the active organization, the search and the
 *   filter. A change of any of them starts over; so does `reload()`. The
 *   organization is `useCurrentUser()`'s, since a removal elsewhere changes it
 *   without the page remounting (D7 Preflight ruling 10).
 * - What is shown stays until the new answer replaces it, so a search doesn't
 *   blank the page; another organization's list is never shown.
 * - Only the latest load's answer is used, as in `org-admin.tsx`: an older
 *   response arriving late, or a "Load more" overtaken by a new search, is
 *   ignored. The shown list remembers its load, and "Load more" pages only
 *   the latest load's list: while a new first page is under way it sends
 *   nothing, so an old list's next page is never appended to a new one.
 * - Nothing loads while the layout's `/me` says the current terms need
 *   accepting (the dialog is over the page); the list loads once they are
 *   accepted and the dialog's revalidation says so. A 403
 *   `terms_acceptance_required` (terms that changed since `/me`) revalidates
 *   the layout, whose dialog then opens, and waits the same way, with no toast.
 * - A 404 `organization_not_found` revalidates the layout too, with no toast:
 *   the session's organization comes back, and the list starts over in it.
 * - A 401 `unauthenticated` toasts nothing either (D12 Ruling 39): the
 *   session-ended handler takes the browser to sign in, or Logout, which
 *   has it suspended, is taking the page to `/login`.
 * - Any other failure toasts "Failed to load configuration".
 */
export function useConfigurationsList({
  search,
  filter,
}: {
  search: string;
  filter: ConfigurationsListFilter;
}): ConfigurationsList {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const layoutData = useRouteLoaderData<AppLayoutData>("routes/app-layout");
  const termsRequired = layoutData?.status === "signed_in" && layoutData.currentUser.termsAcceptanceRequired;
  const { revalidate } = useRevalidator();
  const q = search.trim();

  const [shown, setShown] = useState<ShownList | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [generation, setGeneration] = useState(0);
  const latestLoad = useRef(0);
  /** The latest first page asked for, for rendering; `latestLoad` is what the answers are checked against. */
  const [startedLoad, setStartedLoad] = useState(0);

  const fail = useCallback(
    (error: unknown) => {
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
        void revalidate();
        return;
      }
      // The session is over: the session-ended handler, or Logout, has the page (D12 Ruling 39).
      if (isSessionEnded(error)) return;
      toast.error(LOAD_FAILED_MESSAGE);
    },
    [revalidate],
  );

  useEffect(() => {
    if (organizationId === null || termsRequired) return;
    const thisLoad = ++latestLoad.current;
    setStartedLoad(thisLoad);
    setIsLoadingMore(false);
    getConfigurations(organizationId, { q, filter }).then(
      (page) => {
        if (thisLoad !== latestLoad.current) return;
        setShown({ load: thisLoad, organizationId, q, filter, items: page.items, nextCursor: page.nextCursor });
      },
      (error: unknown) => {
        if (thisLoad !== latestLoad.current) return;
        // A failed first page shows the empty list; a
        // list already shown for this organization stays, and becomes this
        // load's, so "Load more" isn't left disabled. It is still paged with
        // its own query, filter and cursor.
        if (!isOrganizationGone(error) && !isTermsAcceptanceRequired(error)) {
          setShown((current) =>
            current?.organizationId === organizationId
              ? { ...current, load: thisLoad }
              : { load: thisLoad, organizationId, q, filter, items: [], nextCursor: null },
          );
        }
        fail(error);
      },
    );
    return () => {
      latestLoad.current++;
    };
  }, [organizationId, q, filter, termsRequired, generation, fail]);

  const current = shown !== null && shown.organizationId === organizationId ? shown : null;

  const loadMore = useCallback(() => {
    if (current === null || current.nextCursor === null || isLoadingMore) return;
    // Only the latest load's list is paged: while a search, a filter or a
    // reload is under way, the shown list is an older load's, and its next
    // page would be appended to the new one.
    const thisLoad = current.load;
    if (thisLoad !== latestLoad.current) return;
    const { organizationId: listOrganizationId, q: listQ, filter: listFilter, nextCursor } = current;
    setIsLoadingMore(true);
    getConfigurations(listOrganizationId, { q: listQ, filter: listFilter, cursor: nextCursor }).then(
      (page) => {
        if (thisLoad !== latestLoad.current) return;
        setIsLoadingMore(false);
        setShown((before) => {
          if (before?.load !== thisLoad) return before;
          // A configuration changed while paging can come round again
          // (decision 6); it is shown once.
          const seen = new Set(before.items.map((item) => item.id));
          const added = page.items.filter((item) => !seen.has(item.id));
          return { ...before, items: [...before.items, ...added], nextCursor: page.nextCursor };
        });
      },
      (error: unknown) => {
        if (thisLoad !== latestLoad.current) return;
        setIsLoadingMore(false);
        fail(error);
      },
    );
  }, [current, isLoadingMore, fail]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  return {
    items: current?.items ?? null,
    isFiltered: current !== null && (current.q !== "" || current.filter !== "all"),
    hasMore: current?.nextCursor != null,
    isLoadingMore,
    isStale: current !== null && current.load !== startedLoad,
    loadMore,
    reload,
  };
}
