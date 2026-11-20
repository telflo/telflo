import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  VARIABLE_ERROR_CODES,
  VARIABLES_UNAVAILABLE_MESSAGE,
  VariableGroupInUseDetailsSchema,
  VariableInUseDetailsSchema,
  type FleetActor,
  type OrganizationVariable,
  type OrganizationErrorCode,
  type SessionErrorCode,
  type VariableDraftsResponse,
  type VariableErrorCode,
  type VariableGroup,
  type VariableGroupDetail,
  type VariableGroupInUseDetails,
  type VariableInUseDetails,
  type VariableUseGroup,
} from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import {
  ApiError,
  getOrganizationVariables,
  getVariableGroup,
  getVariableGroups,
  isSessionEnded,
} from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { fieldProblemsOf, useReadOrder, useTermsRequired } from "~/lib/fleets.js";
import { formatDateTime } from "~/lib/format.js";
import { isCanonicalUuid } from "~/lib/ids.js";
import { seedOrgVariableNames } from "~/lib/org-variables.js";
import { seedVariableGroupNames } from "~/lib/variable-group-display.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * The Variables pages' data and words: the reads of the variables, the
 * variable groups and one variable group, which refusals the dialogs show,
 * the in-use refusals' lists, the drafts warning, and the search.
 *
 * A variable's value, name and description, and a variable group's name and
 * description, are configuration text. Nothing here puts one anywhere
 * but the data it returns and the text the pages show: every toast, dialog
 * title and page title is fixed words; no attribute, URL, analytics property
 * or browser storage holds one; the search runs in the browser over the one
 * list (≤ 500), never in a URL.
 */

/** Each read's hang guard: the browser's client has no timeout (the fleet screens' 10 s). */
export const VARIABLES_READ_TIMEOUT_MS = 10_000;

/** Each write's hang guard: above the API's worst case of an opamp-server call and its audit write (the fleet screens' 30 s). */
export const VARIABLES_WRITE_TIMEOUT_MS = 30_000;

export const VARIABLES_LOAD_FAILED_MESSAGE = "Failed to load variables";
export const VARIABLE_GROUPS_LOAD_FAILED_MESSAGE = "Failed to load variable groups";
export const VARIABLE_GROUP_LOAD_FAILED_MESSAGE = "Failed to load variable group";
export const VARIABLE_GROUP_NOT_FOUND_MESSAGE = "Variable group not found";

/** The fixed toasts: never a name, a value or a description. */
export const VARIABLE_ADDED_MESSAGE = "Variable added";
export const VARIABLE_SAVED_MESSAGE = "Variable saved";
export const VARIABLE_DELETED_MESSAGE = "Variable deleted";
export const VARIABLE_GROUP_ADDED_MESSAGE = "Variable group added";
export const VARIABLE_GROUP_SAVED_MESSAGE = "Variable group saved";
export const VARIABLE_GROUP_DELETED_MESSAGE = "Variable group deleted";
export const OVERRIDE_SAVED_MESSAGE = "Override saved";
export const OVERRIDE_RESET_MESSAGE = "Override reset";

/** The dialogs' words for a failure that isn't one of the refusals shown as they are. */
export const SAVE_VARIABLE_FAILED_MESSAGE = "Failed to save variable";
export const DELETE_VARIABLE_FAILED_MESSAGE = "Failed to delete variable";
export const SAVE_VARIABLE_GROUP_FAILED_MESSAGE = "Failed to save variable group";
export const DELETE_VARIABLE_GROUP_FAILED_MESSAGE = "Failed to delete variable group";
export const SAVE_OVERRIDE_FAILED_MESSAGE = "Failed to save override";
export const RESET_OVERRIDE_FAILED_MESSAGE = "Failed to reset override";

/**
 * A write whose outcome is unknown (no connection, the hang guard, a reply
 * that doesn't parse) says the API's own 503 words (the contracts' one
 * message, neutral about whether a change was made). The page
 * reads its list again.
 */
export { VARIABLES_UNAVAILABLE_MESSAGE };

/** The page's note under its title, exact. */
export const VARIABLES_NOTE_REFERENCE = "${org:NAME}";
export const VARIABLES_NOTE = "Referenced in configurations as ${org:NAME}.";

/**
 * The warning atop each page, exact: fixed words, its lead in bold and
 * each reference in a code element. The Variables page's adds that a test
 * run fills in the organization's values and keeps its filled-in Test YAML
 * and the collector's logs with its results; the Variable groups page's
 * stops at the shared sentence.
 */
export const SECRETS_WARNING_LEAD = "Not for secrets.";
export const SECRETS_WARNING_ENV_REFERENCE = "${env:NAME}";
export const VARIABLES_SECRETS_WARNING =
  "Not for secrets. Keep passwords, tokens and keys in environment variables (${env:NAME}), set when you install. Test runs use these values in place of ${org:NAME}, and each run keeps its Test YAML and the collector's logs, values included, with its results.";
export const VARIABLE_GROUPS_SECRETS_WARNING =
  "Not for secrets. Keep passwords, tokens and keys in environment variables (${env:NAME}), set when you install.";

/** The warning when the drafts couldn't be read: the delete or rename stays allowed. */
export const DRAFTS_UNREAD_MESSAGE = "Drafts using this variable couldn't be checked.";

// ---------------------------------------------------------------------------
// Refusals.

const ORGANIZATION_NOT_FOUND: OrganizationErrorCode = "organization_not_found";
const RATE_LIMITED: SessionErrorCode = "rate_limited";

/**
 * The refusals whose message a variables dialog shows as it is: the
 * variables' own codes (the 503 `variables_unavailable` among them; each
 * message the API's fixed words, never a name or a value), the
 * organization's and the person's limit. An allow-list, as the fleet
 * screens' (`FLEET_REFUSAL_CODES`).
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<string>([...VARIABLE_ERROR_CODES, ORGANIZATION_NOT_FOUND, RATE_LIMITED]);

/** Whether a failure is the API refusing with one of the variables' refusals. */
export function isVariableRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && REFUSAL_CODES.has(error.code);
}

/** What the person is told about a failed write: a refusal's own words, else the dialog's fallback. */
export function variableRefusalMessage(error: unknown, fallback: string): string {
  return isVariableRefusal(error) ? error.message : fallback;
}

/** Whether a failure carries this code. */
export function hasVariableCode(error: unknown, code: VariableErrorCode): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

/** The fields a variable's or a variable group's dialog shows a 400's problem beside. */
export type VariableField = "name" | "value" | "description";

const VARIABLE_FIELDS: readonly VariableField[] = ["name", "value", "description"];

/** A 400 `invalid_request`'s problems with the dialog's fields, in the contract's own words (never a value). */
export function variableFieldProblemsOf(error: unknown): Partial<Record<VariableField, string>> {
  return fieldProblemsOf(error, (path) => VARIABLE_FIELDS.find((field) => field === path));
}

/** `variable_in_use`'s details (a delete's or a rename's 409), or null for any other failure or details that don't parse. */
export function variableInUseDetailsOf(error: unknown): VariableInUseDetails | null {
  if (!hasVariableCode(error, "variable_in_use")) return null;
  const parsed = VariableInUseDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

/** `variable_group_in_use`'s details (a variable group's delete's 409), or null. */
export function variableGroupInUseDetailsOf(error: unknown): VariableGroupInUseDetails | null {
  if (!hasVariableCode(error, "variable_group_in_use")) return null;
  const parsed = VariableGroupInUseDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// The in-use lists. A name the API couldn't look up came back null, and is
// said in fixed words.

export const DELETED_CONFIGURATION_VERSION = "a published version of a deleted configuration";
export const ANOTHER_FLEET = "another fleet";
export const A_GROUP = "a group";

/** "s" for any count but one. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A collector group in a list: "gateways in edge-prod", or "a group in another fleet". */
export function describeGroupUse(group: VariableUseGroup): string {
  return `${group.groupName ?? A_GROUP} in ${group.fleetLabel ?? ANOTHER_FLEET}`;
}

/** How many collectors a version or a variable group is pinned on. */
export function pinnedText(count: number): string {
  return `pinned on ${plural(count, "collector")}`;
}

/**
 * One used published version: "edge-config v3 (gateways in edge-prod, pinned
 * on 2 collectors)", or, for a deleted configuration, "a published version of
 * a deleted configuration (a group in another fleet)".
 */
export function describeVersionUse(use: VariableInUseDetails["usedBy"][number]): string {
  const version =
    use.configurationName === null
      ? DELETED_CONFIGURATION_VERSION
      : use.versionNumber === null
        ? `a published version of ${use.configurationName}`
        : `${use.configurationName} v${use.versionNumber}`;
  const parts = use.groups.map(describeGroupUse);
  if (use.pinnedCollectors > 0) parts.push(pinnedText(use.pinnedCollectors));
  return parts.length === 0 ? version : `${version} (${parts.join(", ")})`;
}

/** A variable group pinned on collectors, as its own line: "Pinned on 2 collectors". */
export function pinnedCollectorsLine(count: number): string {
  return `Pinned on ${plural(count, "collector")}`;
}

/** A versions list's last line, from the totals: "… and 3 more published versions". */
export function moreVersionsText(count: number): string {
  return `… and ${count} more published version${count === 1 ? "" : "s"}`;
}

/** The variable group's: "… and 3 more collector groups". */
export function moreGroupsText(count: number): string {
  return `… and ${count} more collector group${count === 1 ? "" : "s"}`;
}

/** How many published versions the list leaves out (the totals are exact over every use). */
export function versionsLeftOut(details: VariableInUseDetails): number {
  return Math.max(0, details.totalPublications - details.usedBy.length);
}

/**
 * How many of the versions' collector groups the list leaves out: the 100
 * entries are counted as group rows, so a version's groups can be cut short
 * while every version is listed; the total is exact.
 */
export function versionGroupsLeftOut(details: VariableInUseDetails): number {
  const listed = details.usedBy.reduce((sum, use) => sum + use.groups.length, 0);
  return Math.max(0, details.totalGroups - listed);
}

/** How many collector groups the list leaves out. */
export function groupsLeftOut(details: VariableGroupInUseDetails): number {
  return Math.max(0, details.totalCollectorGroups - details.collectorGroups.length);
}

/** The drafts warning, exact: "Drafts using OTLP_EP: edge-config". */
export function draftsWarning(name: string, configurations: VariableDraftsResponse["configurations"]): string {
  return `Drafts using ${name}: ${configurations.map((configuration) => configuration.name).join(", ")}`;
}

// ---------------------------------------------------------------------------
// The page's words.

/** The Variables page's search, over name, description and value, case-insensitive; an empty search matches all. */
export function matchesVariableSearch(variable: OrganizationVariable, search: string): boolean {
  const query = search.toLowerCase();
  if (query === "") return true;
  return (
    variable.name.toLowerCase().includes(query) ||
    (variable.description?.toLowerCase().includes(query) ?? false) ||
    variable.value.toLowerCase().includes(query)
  );
}

/** A row's Changed: the time, and who. */
export function changedLines(changedAt: string, changedBy: FleetActor | null): { at: string; by: string | null } {
  return { at: formatDateTime(changedAt), by: changedBy?.email ?? null };
}

/** The groups list's Used by: collector groups and pins, counted; "Unused" for neither. */
export function usageText(usage: VariableGroup["usage"]): string {
  const parts: string[] = [];
  if (usage.collectorGroups > 0) parts.push(plural(usage.collectorGroups, "collector group"));
  if (usage.pinnedCollectors > 0) parts.push(plural(usage.pinnedCollectors, "pinned collector"));
  return parts.length === 0 ? "Unused" : parts.join(", ");
}

/** ASCII white space at either end (never `trim()`, which strips a U+FEFF a description may hold). */
const ASCII_SPACE_AT_ENDS = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/** A typed description as the contract takes it: its ASCII white space at either end dropped, and none for an empty one. */
export function descriptionOf(typed: string): string | null {
  const stripped = typed.replace(ASCII_SPACE_AT_ENDS, "");
  return stripped === "" ? null : stripped;
}

/** A typed name or group name with its ASCII white space at either end dropped. */
export function strippedName(typed: string): string {
  return typed.replace(ASCII_SPACE_AT_ENDS, "");
}

// ---------------------------------------------------------------------------
// The pages' reads.

/** What a page shows: its read's answer for the organization and the key it was read for. */
interface Shown<Value> {
  organizationId: string;
  key: string;
  value: Value;
}

export interface VariablesRead<Value> {
  /** The answer; null until the first read has answered, after it failed with nothing shown, or for one not found. */
  value: Value | null;
  /** Whether a read is under way (the first, or a reload). */
  loading: boolean;
  /** Whether the latest read failed with nothing shown: the page says so, with "Try again" (`reload`). */
  failed: boolean;
  /** Whether the read found nothing (a variable group gone, or a page address that names none). */
  notFound: boolean;
  /** Reads again: after a write, an unknown outcome, or "Try again". */
  reload: () => void;
}

interface ReadOptions<Value> {
  /** The read's identity besides the organization (a variable group's id): another key drops what was shown. */
  key: string;
  /** The read itself, under its hang guard's signal. */
  read: (organizationId: string, signal: AbortSignal) => Promise<Value>;
  /** The toast of a reload that failed over what is shown. */
  failedMessage: string;
  /** Whether a failure means there is nothing to show (no toast, no failed state). */
  isNotFound?: (error: unknown) => boolean;
  /** Takes in an answer besides showing it (the shared names' seed). */
  onValue?: (organizationId: string, value: Value) => void;
  /** False to read nothing and show "not found" (an address naming no id). */
  readable?: boolean;
}

/**
 * One page's read (the fleet screens' rules, without polling): it reads for
 * the active organization once the terms are accepted; an organization
 * switch, or another key, drops what was shown and reads again. Each read
 * takes the next number from `useReadOrder` and aborts the one under way, so
 * only the latest answer is used, and has its 10 s hang guard. A failure:
 * `organization_not_found` and `terms_acceptance_required` revalidate the
 * layout, a 401 is the session-ended handler's (silent), a not-found is
 * `notFound`; otherwise a reload over rows shown toasts the fixed words and
 * keeps them, and one with none shown is `failed`.
 */
function useVariablesRead<Value>({
  key,
  read,
  failedMessage,
  isNotFound,
  onValue,
  readable = true,
}: ReadOptions<Value>): VariablesRead<Value> {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const termsRequired = useTermsRequired();
  const { revalidate } = useRevalidator();
  const { begin } = useReadOrder();

  // The latest options, read when a read runs: the page's inline functions never restart it.
  const latest = useRef({ read, failedMessage, isNotFound, onValue });
  useEffect(() => {
    latest.current = { read, failedMessage, isNotFound, onValue };
  });

  const [shown, setShown] = useState<Shown<Value> | null>(null);
  const shownRef = useRef<Shown<Value> | null>(null);
  const show = useCallback((next: Shown<Value> | null) => {
    shownRef.current = next;
    setShown(next);
  }, []);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const readNow = useCallback(
    (organization: string) => {
      const order = begin();
      const guard = abortAfter(VARIABLES_READ_TIMEOUT_MS);
      order.track(guard);
      setLoading(true);
      setFailed(false);
      void latest.current
        .read(organization, guard.signal)
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .then((answer) => {
          guard.clear();
          order.settle();
          if (!order.isCurrent()) return;
          setLoading(false);
          if (answer.ok) {
            setNotFound(false);
            show({ organizationId: organization, key, value: answer.value });
            latest.current.onValue?.(organization, answer.value);
            return;
          }
          const { error } = answer;
          if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
            void revalidate();
            return;
          }
          if (isSessionEnded(error)) return;
          if (latest.current.isNotFound?.(error) === true) {
            show(null);
            setNotFound(true);
            return;
          }
          const current = shownRef.current;
          if (current !== null && current.organizationId === organization && current.key === key) {
            toast.error(latest.current.failedMessage);
            return;
          }
          setFailed(true);
        });
    },
    [begin, key, revalidate, show],
  );

  useEffect(() => {
    // Another organization's, or another key's, answer is never shown.
    show(null);
    setFailed(false);
    setNotFound(!readable);
    if (organizationId === null || termsRequired || !readable) {
      begin();
      setLoading(false);
      return;
    }
    readNow(organizationId);
  }, [organizationId, termsRequired, readable, begin, readNow, show]);

  const reload = useCallback(() => {
    if (organizationId === null || termsRequired || !readable) return;
    readNow(organizationId);
  }, [organizationId, termsRequired, readable, readNow]);

  const current = shown !== null && shown.organizationId === organizationId && shown.key === key ? shown : null;
  return {
    value: current?.value ?? null,
    loading,
    failed: failed && current === null,
    notFound,
    reload,
  };
}

/**
 * The Variables page's list: every variable of the organization with its
 * value, by name. Each answer also seeds the picker's shared names
 * (`seedOrgVariableNames`), so a change made here is in the picker after.
 */
export function useOrganizationVariablesList(): VariablesRead<OrganizationVariable[]> {
  return useVariablesRead({
    key: "variables",
    read: (organizationId, signal) => getOrganizationVariables(organizationId, { signal }),
    failedMessage: VARIABLES_LOAD_FAILED_MESSAGE,
    onValue: seedOrgVariableNames,
  });
}

/**
 * The Variable groups page's list: every variable group, with its overrides
 * counted and what uses it. Each answer also seeds the fleet screens'
 * shared names (`seedVariableGroupNames`), so a group renamed here is named
 * so there after.
 */
export function useVariableGroupsList(): VariablesRead<VariableGroup[]> {
  return useVariablesRead({
    key: "variable-groups",
    read: (organizationId, signal) => getVariableGroups(organizationId, { signal }),
    failedMessage: VARIABLE_GROUPS_LOAD_FAILED_MESSAGE,
    onValue: seedVariableGroupNames,
  });
}

/** A variable group's page: the group with its overrides, and the organization's variables (each row's organization value). */
export interface VariableGroupPage {
  detail: VariableGroupDetail;
  variables: OrganizationVariable[];
}

/**
 * A variable group's page: the group and the organization's variables, read
 * together. An address whose id isn't a canonical UUID reads nothing and is
 * "not found", as is a 404 `variable_group_not_found`.
 */
export function useVariableGroupPage(variableGroupId: string): VariablesRead<VariableGroupPage> {
  return useVariablesRead({
    key: `variable-group:${variableGroupId}`,
    readable: isCanonicalUuid(variableGroupId),
    read: async (organizationId, signal) => {
      const [detail, variables] = await Promise.all([
        getVariableGroup(organizationId, variableGroupId, { signal }),
        getOrganizationVariables(organizationId, { signal }),
      ]);
      return { detail, variables };
    },
    failedMessage: VARIABLE_GROUP_LOAD_FAILED_MESSAGE,
    isNotFound: (error) => hasVariableCode(error, "variable_group_not_found"),
    onValue: (organizationId, { variables }) => seedOrgVariableNames(organizationId, variables),
  });
}

/** One row of a variable group's page: a variable, its value in the group, and where that comes from. */
export interface VariableGroupRow {
  variable: OrganizationVariable;
  /** The group's override, or null when the variable takes the organization's value. */
  override: VariableGroupDetail["overrides"][number] | null;
  /** The value a collector bound to the group gets. */
  value: string;
  source: "Override" | "Organization value";
}

/** Every organization variable with its value in the group and its source, in the list's order. */
export function variableGroupRows(page: VariableGroupPage): VariableGroupRow[] {
  const overrides = new Map(page.detail.overrides.map((override) => [override.variableId, override]));
  return page.variables.map((variable) => {
    const override = overrides.get(variable.id) ?? null;
    return override === null
      ? { variable, override, value: variable.value, source: "Organization value" }
      : { variable, override, value: override.value, source: "Override" };
  });
}
