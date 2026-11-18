import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { OrganizationVariable } from "@telflo/contracts";
import { abortAfter } from "~/lib/abort-after.js";
import { getOrganizationVariables } from "~/lib/api-client.js";
import { useOrganizationForReads } from "~/lib/organization-for-reads.js";

/*
 * The organization's variables' names, for VaultAwareInput's `$` picker (D9b
 * decision 5; D20 default 26 and decision 39), the flows page's marks
 * (default 28) and the group dialogs' "Variables used" (Task 14), and the
 * web's port of the opamp-server's reference scan (decision 36).
 *
 * One shared read per organization (D20 Preflight ruling 34): every input on
 * a page subscribes to the same names, read once from the API
 * (`GET …/variables`) when the first one mounts for the active organization,
 * never one read per input. The Variables page's own list read seeds them
 * (`seedOrgVariableNames`), so a variable added, renamed or deleted there is
 * in the picker after. A picker opened after the read failed, or a minute
 * after it answered, reads again (`refresh`); the rows shown stay meanwhile.
 * Another organization's names are never shown: an organization switch reads
 * the new one's.
 *
 * A picker row is `{id, name, description}`: no value ever reaches the
 * picker, its state or this store; the read's values are dropped as it
 * answers. The names live in memory only, never in browser storage (no
 * `localStorage`, `sessionStorage` or IndexedDB; decision 39). A name and a
 * description are configuration text (Q88): the picker shows them as text
 * inside the masked shell, never in an attribute.
 */

/** A variable as the picker lists it: its name, the reference `${org:NAME}`, over its description. */
export interface OrgVariableName {
  id: string;
  /** The name a reference uses: `${org:NAME}`. */
  name: string;
  /** Shown under the reference; null for none. */
  description: string | null;
}

/** The shared read's hang guard: the browser's client has no timeout, and a read that never answers would hold the picker on "Loading…". */
export const ORG_VARIABLE_NAMES_READ_TIMEOUT_MS = 10_000;

/** How old the names may be when a picker opens before they are read again (in the background, the rows staying). */
export const ORG_VARIABLE_NAMES_REREAD_AFTER_MS = 60_000;

export type NamesStatus = "idle" | "loading" | "ready" | "failed";

interface NamesState {
  /** The organization the names are, or are being read, for; null before any read. */
  organizationId: string | null;
  status: NamesStatus;
  names: readonly OrgVariableName[];
  /** When the names answered (`Date.now()`), 0 before. */
  readAt: number;
}

const NO_NAMES: readonly OrgVariableName[] = [];

const INITIAL: NamesState = { organizationId: null, status: "idle", names: NO_NAMES, readAt: 0 };

const useNamesStore = create<NamesState>()(() => INITIAL);

/** The read under way, if any: its organization, its hang guard, and its token (only the latest read's answer is kept). */
let underWay: { organizationId: string; guard: ReturnType<typeof abortAfter>; token: object } | null = null;

/** The picker's rows of a list read: names and descriptions, the values dropped. */
function namesOf(variables: readonly OrganizationVariable[]): readonly OrgVariableName[] {
  return variables.map(({ id, name, description }) => ({ id, name, description }));
}

/** Reads the organization's names, superseding any read under way. Names already shown for it stay while it reads. */
function readNames(organizationId: string): void {
  underWay?.guard.abort();
  const token = {};
  const guard = abortAfter(ORG_VARIABLE_NAMES_READ_TIMEOUT_MS);
  underWay = { organizationId, guard, token };
  const shown = useNamesStore.getState();
  if (shown.organizationId !== organizationId || shown.status !== "ready") {
    useNamesStore.setState({ organizationId, status: "loading", names: NO_NAMES, readAt: 0 });
  }
  void getOrganizationVariables(organizationId, { signal: guard.signal })
    .then(
      (variables) => {
        if (underWay?.token !== token) return;
        underWay = null;
        useNamesStore.setState({ organizationId, status: "ready", names: namesOf(variables), readAt: Date.now() });
      },
      () => {
        if (underWay?.token !== token) return;
        underWay = null;
        // A re-read that failed keeps the names it was refreshing; a first read is `failed` (the picker says so).
        const current = useNamesStore.getState();
        if (current.organizationId === organizationId && current.status === "ready") return;
        useNamesStore.setState({ organizationId, status: "failed", names: NO_NAMES, readAt: 0 });
      },
    )
    .finally(() => guard.clear());
}

/**
 * Starts the organization's one read, unless its names are read or being
 * read. With `opening` (a picker opening), also reads again after a failed
 * read, or names older than ORG_VARIABLE_NAMES_REREAD_AFTER_MS.
 */
export function ensureOrgVariableNames(organizationId: string, { opening = false }: { opening?: boolean } = {}): void {
  const state = useNamesStore.getState();
  if (state.organizationId !== organizationId || state.status === "idle") {
    readNames(organizationId);
    return;
  }
  if (underWay?.organizationId === organizationId || !opening) return;
  if (state.status === "failed" || Date.now() - state.readAt >= ORG_VARIABLE_NAMES_REREAD_AFTER_MS) readNames(organizationId);
}

/**
 * The names of a list the Variables page just read for the organization
 * (its values are dropped here): they replace the shared names, and a read
 * under way is dropped, so the picker shows what the page shows.
 */
export function seedOrgVariableNames(organizationId: string, variables: readonly OrganizationVariable[]): void {
  underWay?.guard.abort();
  underWay = null;
  useNamesStore.setState({ organizationId, status: "ready", names: namesOf(variables), readAt: Date.now() });
}

/** The shared names as they stand, outside React: their organization, the read's state and the names. */
export function orgVariableNamesNow(): Readonly<{ organizationId: string | null; status: NamesStatus; names: readonly OrgVariableName[] }> {
  const { organizationId, status, names } = useNamesStore.getState();
  return { organizationId, status, names };
}

/** Forgets the names and drops a read under way, whose answer then lands nowhere: the store as a page load finds it (Logout; a test's isolation). */
export function forgetOrgVariableNames(): void {
  underWay?.guard.abort();
  underWay = null;
  useNamesStore.setState(INITIAL);
}

/** What `useOrgVariables` gives: the active organization's names, and the read's state. */
export interface OrgVariableNames {
  /** The active organization's variables, by name as the API lists them; empty until read. */
  names: readonly OrgVariableName[];
  /** True until the first read for the active organization has answered: the picker shows "Loading organization variables...". */
  loading: boolean;
  /** True when that read failed: the picker says so, and its next opening reads again. */
  failed: boolean;
  /**
   * True only once the active organization's names are read: what is not
   * among them is known not to be defined. False with no organization yet
   * (a full page load seeds the user store in an effect, after the first
   * render), while they are read, and when they couldn't be: a mark of "not
   * defined" waits for it (D20 final review side 2, Minor 2).
   */
  known: boolean;
  /** A picker opening: reads again after a failure, or once the names are a minute old. */
  refresh: () => void;
}

/**
 * The active organization's variables' names (default 26), from the one
 * shared read. The organization comes from the user store, which the
 * signed-in layout seeds: with none (signed out, a test rendering a form
 * alone, a full page load's first render) nothing is read and the list is
 * empty, not loading, and not `known`. Inside the playground there is none
 * either (`useOrganizationForReads`, D31-1 Ruling 292): the sample has no
 * variables, and a signed-in visitor's own organization is never read.
 */
export function useOrgVariables(): OrgVariableNames {
  const organizationId = useOrganizationForReads();
  const state = useNamesStore();

  useEffect(() => {
    if (organizationId !== null) ensureOrgVariableNames(organizationId);
  }, [organizationId]);

  const refresh = useCallback(() => {
    if (organizationId !== null) ensureOrgVariableNames(organizationId, { opening: true });
  }, [organizationId]);

  if (organizationId === null) return { names: NO_NAMES, loading: false, failed: false, known: false, refresh };
  const mine = state.organizationId === organizationId;
  return {
    names: mine ? state.names : NO_NAMES,
    loading: !mine || state.status === "idle" || state.status === "loading",
    failed: mine && state.status === "failed",
    known: mine && state.status === "ready",
    refresh,
  };
}

/** The reference a picked variable inserts. */
export function createOrgVariableReference(name: string): string {
  return `\${org:${name}}`;
}

// ---------------------------------------------------------------------------
// The web's port of the opamp-server's `orgvariables.References` (D20
// decisions 16 and 36; Preflight ruling 31), held to it by the shared corpus
// (vendor/opamp-server/org-token-corpus.json, the opamp-server's
// handlers/testdata/org-token-corpus.json at the pinned release), as the
// API's and the validator's ports are.
//
// A live reference is `${org:NAME}`, NAME the grammar [A-Za-z_][A-Za-z0-9_]*
// of any length, opened by a `$` that an even run of `$` precedes (none
// included): confmap collapses each `$$` to `$` in one left-to-right pass, so
// `$${org:X}` is the literal text `${org:X}`, while `$$${org:X}` is a `$`
// followed by a live reference. The legacy `$orgvar:NAME` is plain text
// (Q95), and so is `${org:NAME:-default}`.

const OPENER = "${org:";

/** True when an even number of `$` immediately precede index `i`. */
function precedingDollarRunEven(text: string, i: number): boolean {
  let count = 0;
  for (let k = i - 1; k >= 0 && text.charCodeAt(k) === 0x24; k -= 1) count += 1;
  return count % 2 === 0;
}

/** The length of the longest NAME of the grammar at `text[from..]`, 0 when none starts there. */
function nameLength(text: string, from: number): number {
  let n = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const letter = c === 0x5f || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (!letter && (n === 0 || c < 0x30 || c > 0x39)) break;
    n += 1;
  }
  return n;
}

/**
 * Every live reference's NAME in `text`, defined or not, each once, in the
 * order first seen: `orgvariables.References`. A name over 128 characters is
 * listed too (no variable can have it; Ruling 51).
 */
export function orgVariableReferences(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length; ) {
    const start = text.indexOf(OPENER, i);
    if (start < 0) break;
    const nameStart = start + OPENER.length;
    const nameEnd = nameStart + nameLength(text, nameStart);
    if (nameEnd === nameStart || nameEnd >= text.length || text.charCodeAt(nameEnd) !== 0x7d) {
      i = start + 1;
      continue;
    }
    if (precedingDollarRunEven(text, start)) {
      const name = text.slice(nameStart, nameEnd);
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    i = nameEnd + 1;
  }
  return names;
}
