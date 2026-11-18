import { useEffect } from "react";
import { create } from "zustand";
import {
  VariablesUndefinedDetailsSchema,
  type Collector,
  type CollectorGroup,
  type OrganizationVariable,
  type VariableGroup,
  type VariableGroupOverride,
  type VariablesUndefinedDetails,
} from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, getVariableGroups } from "~/lib/api-client.js";
import { useOrganizationForReads } from "~/lib/organization-for-reads.js";

/*
 * Variable groups in the fleet screens (D20 defaults 23–25; Q83, Q84, Q103;
 * ADR 0018): a collector's variable group is its pinned one, else its
 * collector group's, else none: "Organization values".
 * Each variable resolves per variable (Q84, coalesce(pin, group,
 * organization)): the pinned variable group's override, else the
 * collector group's variable group's, else the organization's value.
 *
 * A variable group's name, a variable's name, value and description are
 * configuration text (Q88): the screens show them as text (inside
 * `ph-no-capture` in a dialog), never in an attribute, a toast, a title, a
 * URL or browser storage. The names here live in memory only.
 */

/** A collector, or a collector group, with no variable group: the grid's and the rows' words (default 25). */
export const ORGANIZATION_VALUES = "Organization values";

/** The group dialogs' first choice (default 23): no variable group. */
export const NO_VARIABLE_GROUP_WORDS = "None (organization values)";

/** A variable group the shown list doesn't name (unread yet, or its read failed): fixed words, never blank. */
export const UNNAMED_VARIABLE_GROUP = "A variable group";

/** The dialogs' variable groups read failing. */
export const VARIABLE_GROUPS_FAILED_MESSAGE = "Failed to load variable groups";

/** A variable group chosen that the dialog's list no longer holds. */
export const VARIABLE_GROUP_NOT_LISTED_WORDS = "A variable group no longer listed";

/**
 * The variable group a collector's text is filled in with first: its
 * pinned one, else its group's; null for
 * none. `group` undefined (the groups unread) with no pin is undefined: not
 * known.
 */
export function effectiveVariableGroupId(
  collector: Pick<Collector, "pinnedVariableGroupId">,
  group: Pick<CollectorGroup, "variableGroupId"> | null | undefined,
): string | null | undefined {
  if (collector.pinnedVariableGroupId !== null) return collector.pinnedVariableGroupId;
  if (group === undefined) return undefined;
  return group?.variableGroupId ?? null;
}

/**
 * The single collector's Pin's first choice (default 24): "Follow group
 * (eu-edge)", the group's variable group's name; "Follow group (Organization
 * values)" when its group has none; "Follow group" when that isn't known.
 */
export function followGroupWords(groupVariableGroup: string | null | undefined): string {
  if (groupVariableGroup === undefined) return "Follow group";
  return `Follow group (${groupVariableGroup ?? ORGANIZATION_VALUES})`;
}

// ---------------------------------------------------------------------------
// The undefined names (Q86; Q102): what "Variables used" and a 422 list.

/** How many names a list shows before "… and N more" (the API's bound, Q102). */
export const UNDEFINED_NAMES_LISTED = 100;

/** `variables_undefined`'s details (a 422 of an assignment or a pin), or null for any other failure or details that don't parse. */
export function variablesUndefinedOf(error: unknown): VariablesUndefinedDetails | null {
  if (!(error instanceof ApiError) || error.code !== "variables_undefined") return null;
  const parsed = VariablesUndefinedDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

/** Whether a write was refused for a variable group the organization no longer holds (404): the dialog reads its list again. */
export function isVariableGroupGone(error: unknown): boolean {
  return error instanceof ApiError && error.code === "variable_group_not_found";
}

/** The names a version's text references that no organization variable has, in the order first referenced (decision 7: case as written). */
export function undefinedNames(references: readonly string[], defined: readonly { name: string }[]): string[] {
  const names = new Set(defined.map((variable) => variable.name));
  return references.filter((name) => !names.has(name));
}

/** Q102's last words: "… and 3 more". */
export function moreNamesText(count: number): string {
  return `… and ${count} more`;
}

// ---------------------------------------------------------------------------
// Each variable's value and where it comes from (Q84; VariableGroupLink's dialog).

/** One level of the resolution: a variable group's overrides, and the words its rows say where they come from. */
export interface ResolutionLevel {
  source: string;
  overrides: readonly VariableGroupOverride[];
}

export interface ResolvedVariable {
  variable: OrganizationVariable;
  /** The value the collector's text is filled in with. */
  value: string;
  /** Where it comes from: the first level that overrides it, else the organization's. */
  source: string;
}

/** The words of a value that is the organization's own. */
export const ORGANIZATION_VALUE_SOURCE = "Organization value";

/**
 * Every organization variable resolved through `levels`, first to last, the
 * organization's value last (D20's two levels): the list's order (the API's,
 * by name). An override of an empty value is a value (D20: an empty override
 * overrides).
 */
export function resolvedVariables(variables: readonly OrganizationVariable[], levels: readonly ResolutionLevel[]): ResolvedVariable[] {
  const maps = levels.map((level) => ({ source: level.source, values: new Map(level.overrides.map((each) => [each.variableId, each.value])) }));
  return variables.map((variable) => {
    for (const level of maps) {
      const value = level.values.get(variable.id);
      if (value !== undefined) return { variable, value, source: level.source };
    }
    return { variable, value: variable.value, source: ORGANIZATION_VALUE_SOURCE };
  });
}

// ---------------------------------------------------------------------------
// The variable groups' names, for the tables and the details (default 25).
//
// One shared read per organization (the picker's rule, Preflight ruling 34),
// started only when a row names a variable group the names don't hold: a fleet
// whose groups and collectors use none reads nothing. A dialog's own read of
// the list (its choices) seeds it. Another organization's names are never
// shown. In memory only, never browser storage.

/** The shared read's hang guard. */
export const VARIABLE_GROUP_NAMES_READ_TIMEOUT_MS = 10_000;

/** How old the names may be before a row naming one they don't hold reads them again. */
export const VARIABLE_GROUP_NAMES_REREAD_AFTER_MS = 60_000;

type NamesStatus = "idle" | "loading" | "ready" | "failed";

interface NamesState {
  organizationId: string | null;
  status: NamesStatus;
  names: ReadonlyMap<string, string>;
  /** When the latest read settled (`Date.now()`), 0 before. */
  settledAt: number;
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

const INITIAL: NamesState = { organizationId: null, status: "idle", names: NO_NAMES, settledAt: 0 };

const useNamesStore = create<NamesState>()(() => INITIAL);

let underWay: { organizationId: string; guard: ReturnType<typeof abortAfter>; token: object } | null = null;

function namesOf(groups: readonly Pick<VariableGroup, "id" | "name">[]): ReadonlyMap<string, string> {
  return new Map(groups.map((group) => [group.id, group.name]));
}

function readNames(organizationId: string): void {
  underWay?.guard.abort();
  const token = {};
  const guard = abortAfter(VARIABLE_GROUP_NAMES_READ_TIMEOUT_MS);
  underWay = { organizationId, guard, token };
  const shown = useNamesStore.getState();
  // Names shown for the organization stay while it reads again.
  useNamesStore.setState(
    shown.organizationId === organizationId ? { status: "loading" } : { organizationId, status: "loading", names: NO_NAMES, settledAt: 0 },
  );
  void getVariableGroups(organizationId, { signal: guard.signal })
    .then(
      (groups) => {
        if (underWay?.token !== token) return;
        underWay = null;
        useNamesStore.setState({ organizationId, status: "ready", names: namesOf(groups), settledAt: Date.now() });
      },
      () => {
        if (underWay?.token !== token) return;
        underWay = null;
        useNamesStore.setState({ status: "failed", settledAt: Date.now() });
      },
    )
    .finally(() => guard.clear());
}

/** A list a dialog just read for the organization: it replaces the shared names (a binding it saves is named at once). */
export function seedVariableGroupNames(organizationId: string, groups: readonly Pick<VariableGroup, "id" | "name">[]): void {
  underWay?.guard.abort();
  underWay = null;
  useNamesStore.setState({ organizationId, status: "ready", names: namesOf(groups), settledAt: Date.now() });
}

/**
 * A variable group a dialog just saved (`name`: created or renamed) or
 * deleted (`name` null): the shared names follow at once, so the fleet
 * screens name it as it now is without waiting for a re-read (D20 final
 * review side 2, Minor 1). Names held for another organization (or none) are
 * left as they are; a read under way for this one, whose answer may predate
 * the save, starts again (the names shown stay meanwhile).
 */
export function noteVariableGroupName(organizationId: string, variableGroupId: string, name: string | null): void {
  const state = useNamesStore.getState();
  if (state.organizationId !== organizationId) return;
  const names = new Map(state.names);
  if (name === null) names.delete(variableGroupId);
  else names.set(variableGroupId, name);
  useNamesStore.setState({ names });
  if (underWay?.organizationId === organizationId) readNames(organizationId);
}

/** The shared names as they stand, outside React: their organization, the read's state and the names by id. */
export function variableGroupNamesNow(): Readonly<{ organizationId: string | null; status: NamesStatus; names: ReadonlyMap<string, string> }> {
  const { organizationId, status, names } = useNamesStore.getState();
  return { organizationId, status, names };
}

/** Forgets the names and drops a read under way, whose answer then lands nowhere: the store as a page load finds it (Logout; a test's isolation). */
export function forgetVariableGroupNames(): void {
  underWay?.guard.abort();
  underWay = null;
  useNamesStore.setState(INITIAL);
}

/** Starts the organization's read when a wanted id isn't named: once, or again once the last read is a minute old. */
export function ensureVariableGroupNames(organizationId: string, wanted: readonly string[]): void {
  const state = useNamesStore.getState();
  if (state.organizationId !== organizationId || state.status === "idle") {
    readNames(organizationId);
    return;
  }
  if (state.status === "loading" || wanted.every((id) => state.names.has(id))) return;
  if (Date.now() - state.settledAt >= VARIABLE_GROUP_NAMES_REREAD_AFTER_MS) readNames(organizationId);
}

/**
 * The organization whose variable groups the fleet screens name and read:
 * the one `useCurrentUser()` answers (D31-1 Ruling
 * 289): the playground's visitor first, then the user store's. Inside the
 * playground that is the sample's, which has no variable groups and whose
 * names are no playground read (decision 22): it answers no names and
 * reads nothing, and a signed-in visitor's own organization never reaches
 * it: `useOrganizationForReads`, the one source for such reads (Ruling 292).
 */
export function useNamesOrganization(): string | null {
  return useOrganizationForReads();
}

/**
 * The names of the active organization's variable groups
 * (`useNamesOrganization`'s), by id, for the rows naming `wanted` (ids,
 * nulls skipped): read when one isn't named. A name not (yet) known is
 * absent; the row says `UNNAMED_VARIABLE_GROUP`. None inside the
 * playground, with no read.
 */
export function useVariableGroupNames(wanted: readonly (string | null | undefined)[]): ReadonlyMap<string, string> {
  const organizationId = useNamesOrganization();
  const state = useNamesStore();
  const ids = [...new Set(wanted.filter((id): id is string => typeof id === "string"))].sort();
  const key = ids.join(",");
  useEffect(() => {
    if (organizationId !== null && ids.length > 0) ensureVariableGroupNames(organizationId, ids);
    // `key` is the ids' identity: a poll's new array holding the same ids reads nothing.
  }, [organizationId, key]);
  return organizationId !== null && state.organizationId === organizationId ? state.names : NO_NAMES;
}
