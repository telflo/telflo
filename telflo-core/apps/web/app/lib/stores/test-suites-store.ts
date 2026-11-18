import type { CreateTestDefinitionRequest, TestDefinition, TestSuite } from "@telflo/contracts";
import { create } from "zustand";
import {
  ApiError,
  createTestDefinition,
  createTestSuite,
  deleteTestDefinition,
  deleteTestSuite,
  isSessionEnded,
  updateTestSuite,
} from "~/lib/api-client.js";
import { abortAfter, isRefusal, RUNS_REQUEST_TIMEOUT_MS, type RunTarget } from "~/lib/stores/testing-store.js";
import { readsFor } from "~/lib/workspace-reads.js";

/*
 * The Suites subtab's memory (D14b decisions 1, 2, 5, 8 and 9; Preflight
 * rulings 14, 18 and 20): the suites and their definitions, in a store of
 * their own.
 * - the suites are read each time the Suites subtab shows and when the
 *   version changes, and a suite's definitions each time its card expands
 *   (Preflight ruling 18), so a teammate's edits show;
 * - a failed read is kept, shown inline with Retry ("Failed to load test
 *   suites", "Failed to load test configurations"; a refusal, a 4xx but 408
 *   and 429, in the API's words); a read that never answers is aborted after
 *   RUNS_REQUEST_TIMEOUT_MS (10 s), as the runs' reads are, and fails so
 *   (D14b Ruling 50): its spinner ends, and a Play all awaiting it lets go
 *   of its hold;
 * - each suite's definitions read under way is kept (`loadDefinitions`
 *   answers it rather than start another), so a Play all can await it
 *   (Preflight ruling 14) rather than find the suite empty; a read for a
 *   version the store doesn't hold is refused (`StaleSuitesTargetError`),
 *   never a switch to it: a late Play all can't empty the version shown;
 * - everything is held for one version, in the organization it was loaded
 *   in (`target`): an answer for another version, or one that arrives after
 *   signing out (`reset`), adds nothing;
 * - a read under way never overwrites a write made here meanwhile (D14b
 *   Ruling 38): its answer, taken before the write, is dropped and the list
 *   read again; a suite created while the suites aren't shown (a failed
 *   first read) reads them again, so it shows;
 * - a delete the API answers "not found" (another tab deleted it) drops the
 *   suite or definition here too: it is gone either way.
 *
 * The suites' and definitions' names and descriptions are configuration
 * text (ADR 0024): they never reach an attribute, a log line or an
 * analytics event, and signing out forgets them (`reset`, from useLogout).
 */

/** What the subtab says when the suites can't be read. */
export const SUITES_LOAD_FAILED_MESSAGE = "Failed to load test suites";

/** What a card says when its definitions can't be read. */
export const DEFINITIONS_LOAD_FAILED_MESSAGE = "Failed to load test configurations";

/** A read of a suite's definitions for a version the store doesn't hold (`loadDefinitions`): nothing is read, nothing changes. */
export class StaleSuitesTargetError extends Error {
  constructor() {
    super("That version's suites aren't the ones shown.");
    this.name = "StaleSuitesTargetError";
  }
}

export interface TestSuitesState {
  /** The version the suites belong to, in the organization it was loaded in; null before any read. */
  target: RunTarget | null;
  /** The version's suites, oldest first, as the API lists them. */
  suites: TestSuite[];
  /** Whether a read of the suites is under way. */
  suitesLoading: boolean;
  /** Whether `suites` holds an answer for `target`. */
  suitesLoaded: boolean;
  /** Why the last read failed, shown with Retry; null otherwise. */
  suitesError: string | null;
  /** Each suite's definitions, oldest first, once read. */
  definitionsBySuite: Record<string, TestDefinition[]>;
  /** The suites whose definitions are being read. */
  definitionsLoadingBySuite: Record<string, boolean>;
  /** Why a suite's last read of its definitions failed, shown with Retry. */
  definitionsErrorBySuite: Record<string, string>;

  /**
   * Reads `target`'s suites afresh (another version's start from none),
   * aborted after RUNS_REQUEST_TIMEOUT_MS. Never rejects: a failure is
   * `suitesError`.
   */
  loadSuites: (target: RunTarget) => Promise<void>;
  /**
   * A suite's definitions: the read under way, else a fresh one, aborted
   * after RUNS_REQUEST_TIMEOUT_MS. Rejects as the API did (and records why in `definitionsErrorBySuite`), and with
   * StaleSuitesTargetError, reading nothing, when `target` isn't the version
   * the store holds (`loadSuites` decides that, never this).
   */
  loadDefinitions: (target: RunTarget, suiteId: string) => Promise<TestDefinition[]>;
  /** Creates a suite; it joins the list's end, or the list is read again when it isn't shown. Rejects as the API did. */
  createSuite: (target: RunTarget, suite: { name: string; description: string }) => Promise<TestSuite>;
  /** Renames and describes a suite. Rejects as the API did. */
  updateSuite: (target: RunTarget, suiteId: string, patch: { name: string; description: string }) => Promise<TestSuite>;
  /** Deletes a suite, its definitions with it. Rejects as the API did; one already gone ("not found") is dropped here too. */
  deleteSuite: (target: RunTarget, suiteId: string) => Promise<void>;
  /** Creates a definition, its input copied by the API; it joins its suite's list's end. Rejects as the API did. */
  createDefinition: (target: RunTarget, suiteId: string, request: CreateTestDefinitionRequest) => Promise<TestDefinition>;
  /** Deletes a definition. Rejects as the API did; one already gone ("not found") is dropped here too. */
  deleteDefinition: (target: RunTarget, suiteId: string, definitionId: string) => Promise<void>;
  /** Forgets everything (signing out). */
  reset: () => void;
}

const EMPTY = {
  target: null,
  suites: [],
  suitesLoading: false,
  suitesLoaded: false,
  suitesError: null,
  definitionsBySuite: {},
  definitionsLoadingBySuite: {},
  definitionsErrorBySuite: {},
} satisfies Partial<TestSuitesState>;

/** Whether `left` and `right` name the same version in the same organization. */
function sameTarget(left: RunTarget | null, right: RunTarget): boolean {
  return (
    left !== null &&
    left.organizationId === right.organizationId &&
    left.configurationId === right.configurationId &&
    left.versionId === right.versionId
  );
}

/**
 * What a failed read shows: nothing when the session ended, the API's words
 * for a refusal (a 4xx but 408 and 429), else `fallback` (a timeout, the
 * network, a 5xx). A card's read and a Play all's say the same (D14b Ruling
 * 50).
 */
export function readFailure(error: unknown, fallback: string): string | null {
  if (isSessionEnded(error)) return null;
  return isRefusal(error) ? error.message : fallback;
}

/** Whether a delete was refused because the suite or definition is already gone (another tab deleted it). */
export function isAlreadyGone(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "test_suite_not_found" || error.code === "test_definition_not_found");
}

/** `record` without `key`. */
function without<Value>(record: Record<string, Value>, key: string): Record<string, Value> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** Counts sign-outs and target changes: an answer to a request made before one adds nothing. */
let epoch = 0;

/** The latest suites read: an answer to an earlier one is dropped. */
let suitesRead = 0;

/** Each suite's definitions read under way, by suite id, for the target of `epoch`. */
let definitionsReads = new Map<string, Promise<TestDefinition[]>>();

/** Counts the writes made here to the suites: a read whose answer was taken before one is read again. */
let suitesWrites = 0;

/** Counts the writes made here to each suite's definitions, by suite id, as `suitesWrites`. */
let definitionsWrites = new Map<string, number>();

/** Notes a write to a suite's definitions. */
function wroteDefinitions(suiteId: string): void {
  definitionsWrites.set(suiteId, (definitionsWrites.get(suiteId) ?? 0) + 1);
}

export const useTestSuitesStore = create<TestSuitesState>()((set, get) => {
  /** Starts holding `target`: another version's suites and definitions are forgotten. */
  const hold = (target: RunTarget) => {
    if (sameTarget(get().target, target)) return;
    epoch += 1;
    definitionsReads = new Map();
    definitionsWrites = new Map();
    set({ ...EMPTY, target });
  };

  /** Whether an answer for `target`, asked at `at`, may still change the store. */
  const current = (target: RunTarget, at: number) => epoch === at && sameTarget(get().target, target);

  return {
    ...EMPTY,

    loadSuites: async (target) => {
      hold(target);
      const at = epoch;
      const thisRead = ++suitesRead;
      const writesAt = suitesWrites;
      set({ suitesLoading: true, suitesError: null });
      const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
      try {
        const { suites } = await readsFor(target.organizationId).getTestSuites(target.organizationId, target.configurationId, target.versionId, {
          signal: timeout.signal,
        });
        if (!current(target, at) || thisRead !== suitesRead) return;
        // Taken before a write made here meanwhile: read again, rather than lose the write.
        if (writesAt !== suitesWrites) return get().loadSuites(target);
        // A suite gone since keeps no definitions here.
        const listed = new Set(suites.map((suite) => suite.id));
        set((state) => ({
          suites,
          suitesLoading: false,
          suitesLoaded: true,
          definitionsBySuite: Object.fromEntries(Object.entries(state.definitionsBySuite).filter(([id]) => listed.has(id))),
        }));
      } catch (error) {
        if (!current(target, at) || thisRead !== suitesRead) return;
        set({ suitesLoading: false, suitesError: readFailure(error, SUITES_LOAD_FAILED_MESSAGE) });
      } finally {
        timeout.clear();
      }
    },

    loadDefinitions: (target, suiteId) => {
      if (!sameTarget(get().target, target)) return Promise.reject(new StaleSuitesTargetError());
      const under = definitionsReads.get(suiteId);
      if (under !== undefined) return under;
      const at = epoch;
      const reads = definitionsReads;
      const writesAt = definitionsWrites.get(suiteId) ?? 0;
      set((state) => ({
        definitionsLoadingBySuite: { ...state.definitionsLoadingBySuite, [suiteId]: true },
        definitionsErrorBySuite: without(state.definitionsErrorBySuite, suiteId),
      }));
      const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
      const reading = readsFor(target.organizationId).getTestDefinitions(target.organizationId, target.configurationId, target.versionId, suiteId, {
        signal: timeout.signal,
      }).then(
        ({ definitions }): TestDefinition[] | Promise<TestDefinition[]> => {
          timeout.clear();
          reads.delete(suiteId);
          // Taken before a write made here meanwhile: read again, rather than lose the write.
          if (current(target, at) && writesAt !== (definitionsWrites.get(suiteId) ?? 0)) return get().loadDefinitions(target, suiteId);
          if (current(target, at)) {
            set((state) => ({
              definitionsBySuite: { ...state.definitionsBySuite, [suiteId]: definitions },
              definitionsLoadingBySuite: without(state.definitionsLoadingBySuite, suiteId),
            }));
          }
          return definitions;
        },
        (error: unknown) => {
          timeout.clear();
          reads.delete(suiteId);
          if (current(target, at)) {
            const message = readFailure(error, DEFINITIONS_LOAD_FAILED_MESSAGE);
            set((state) => ({
              definitionsLoadingBySuite: without(state.definitionsLoadingBySuite, suiteId),
              definitionsErrorBySuite:
                message === null ? state.definitionsErrorBySuite : { ...state.definitionsErrorBySuite, [suiteId]: message },
            }));
          }
          throw error;
        },
      );
      reads.set(suiteId, reading);
      return reading;
    },

    createSuite: async (target, suite) => {
      const at = epoch;
      const { suite: created } = await createTestSuite(target.organizationId, target.configurationId, target.versionId, suite);
      if (!current(target, at)) return created;
      suitesWrites += 1;
      if (get().suitesLoaded) {
        set((state) => ({ suites: [...state.suites.filter((listed) => listed.id !== created.id), created] }));
      } else {
        // Not shown (the first read failed, or is under way): read them now, the new one with the rest.
        void get().loadSuites(target);
      }
      return created;
    },

    updateSuite: async (target, suiteId, patch) => {
      const at = epoch;
      const { suite: updated } = await updateTestSuite(target.organizationId, target.configurationId, target.versionId, suiteId, patch);
      if (current(target, at)) {
        suitesWrites += 1;
        set((state) => ({ suites: state.suites.map((listed) => (listed.id === suiteId ? updated : listed)) }));
      }
      return updated;
    },

    deleteSuite: async (target, suiteId) => {
      const at = epoch;
      let refusal: unknown = null;
      try {
        await deleteTestSuite(target.organizationId, target.configurationId, target.versionId, suiteId);
      } catch (error) {
        // Already gone (another tab deleted it): dropped here too, and the refusal still answered.
        if (!isAlreadyGone(error)) throw error;
        refusal = error;
      }
      if (current(target, at)) {
        suitesWrites += 1;
        set((state) => ({
          suites: state.suites.filter((listed) => listed.id !== suiteId),
          definitionsBySuite: without(state.definitionsBySuite, suiteId),
          definitionsErrorBySuite: without(state.definitionsErrorBySuite, suiteId),
        }));
      }
      if (refusal !== null) throw refusal;
    },

    createDefinition: async (target, suiteId, request) => {
      const at = epoch;
      const { definition } = await createTestDefinition(
        target.organizationId,
        target.configurationId,
        target.versionId,
        suiteId,
        request,
      );
      if (!current(target, at)) return definition;
      wroteDefinitions(suiteId);
      const listed = get().definitionsBySuite[suiteId];
      if (listed !== undefined) {
        set((state) => ({
          definitionsBySuite: {
            ...state.definitionsBySuite,
            [suiteId]: [...(state.definitionsBySuite[suiteId] ?? []).filter((each) => each.id !== definition.id), definition],
          },
        }));
      } else {
        // Never read (its read failed): read it now, the new one with the rest.
        get()
          .loadDefinitions(target, suiteId)
          .catch(() => undefined);
      }
      return definition;
    },

    deleteDefinition: async (target, suiteId, definitionId) => {
      const at = epoch;
      let refusal: unknown = null;
      try {
        await deleteTestDefinition(target.organizationId, target.configurationId, target.versionId, suiteId, definitionId);
      } catch (error) {
        // Already gone (another tab deleted it, or its suite): dropped here too, and the refusal still answered.
        if (!isAlreadyGone(error)) throw error;
        refusal = error;
      }
      if (current(target, at)) {
        wroteDefinitions(suiteId);
        set((state) => {
          const listed = state.definitionsBySuite[suiteId];
          return listed === undefined
            ? {}
            : { definitionsBySuite: { ...state.definitionsBySuite, [suiteId]: listed.filter((each) => each.id !== definitionId) } };
        });
      }
      if (refusal !== null) throw refusal;
    },

    reset: () => {
      epoch += 1;
      suitesRead += 1;
      definitionsReads = new Map();
      definitionsWrites = new Map();
      set({ ...EMPTY });
    },
  };
});
