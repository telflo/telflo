import type { CreateValidationRuleRequest, UpdateValidationRuleRequest, ValidationPipeline, ValidationRule } from "@telflo/contracts";
import { create } from "zustand";
import {
  ApiError,
  createValidationPipeline,
  createValidationRule,
  deleteValidationPipeline,
  deleteValidationRule,
  updateValidationRule,
} from "~/lib/api-client.js";
import { readFailure } from "~/lib/stores/test-suites-store.js";
import { abortAfter, RUNS_REQUEST_TIMEOUT_MS, type RunTarget } from "~/lib/stores/testing-store.js";
import { readsFor } from "~/lib/workspace-reads.js";

/*
 * The Validation subtab's memory: the validation pipelines and their rules, in
 * a store of their own, as the Suites subtab's (`test-suites-store.ts`).
 * - the pipelines are read each time the Validation subtab shows and when the
 *   version changes, and a card's rules each time it mounts, so a teammate's
 *   edits show;
 * - a failed read is kept, shown inline with Retry ("Failed to load
 *   validation pipelines", "Failed to load validation rules"; a refusal, a
 *   4xx but 408 and 429, in the API's words); a read that never answers is aborted after
 *   RUNS_REQUEST_TIMEOUT_MS (10 s), as the suites' are;
 * - a rule's place is the API's (`position`, max + 1): nothing here counts
 *   the pipeline's rules to choose it, so adding one never first reads a
 *   pipeline's rules; a rule added to a pipeline whose rules were never
 *   read (their read failed) reads them, so the list is whole;
 * - everything is held for one version, in the organization it was loaded
 *   in (`target`): an answer for another version, or one that arrives after
 *   signing out (`reset`), adds nothing;
 * - a read under way never overwrites a write made here meanwhile: its
 *   answer, taken before the write, is dropped and the list read again;
 * - a rule's change, create or delete answered while its version is still
 *   held (never left) is placed, and a read of that pipeline's rules under
 *   way reads again; one answered after its version was left and come back
 *   to (mid-save) is not placed, as a teammate may have written since:
 *   that pipeline's rules are read again instead, by a read sent after the
 *   answer, while the pipeline is listed, and the rule's hold is released
 *   once that read answers or fails; a pipeline not listed is not read, and
 *   the hold is released at once;
 * - a delete the API answers "not found" (another tab deleted it) drops the
 *   pipeline or rule here too: it is gone either way; so does a rule's change
 *   or create, or a pipeline's create, the API answers so: a rule's
 *   `validation_rule_not_found` drops the rule, a rule's
 *   `validation_pipeline_not_found` (its change, create or delete) its
 *   pipeline, and a pipeline's create answered 404 (the version itself gone)
 *   reads the pipelines again, so the list shows the API's refusal;
 * - a rule's change or delete under way is held here (`ruleWritesInFlight`)
 *   until the API answers, refused or not, whether or not the dialog that
 *   sent it is still open, and released once its answer is in the store (or,
 *   answered after its version was left and come back to, once its
 *   pipeline's rules are read again): the card holds that rule's Edit and
 *   Delete, so it can't be reopened on its old text mid-save (and a plain
 *   Save revert the change that lands);
 * - no rename of a validation pipeline (`updateValidationPipeline`): the API
 *   creates and deletes them, never changes one.
 *
 * A pipeline's name and a rule's name, description, pattern and OTTL are
 * configuration text: they never reach an attribute outside `ph-no-capture`,
 * a log line or an analytics event, and signing out forgets them (`reset`,
 * from useLogout).
 */

/** What the subtab says when the validation pipelines can't be read. */
export const PIPELINES_LOAD_FAILED_MESSAGE = "Failed to load validation pipelines";

/** What a card says when its rules can't be read. */
export const RULES_LOAD_FAILED_MESSAGE = "Failed to load validation rules";

/** A read of a pipeline's rules for a version the store doesn't hold (`loadRules`): nothing is read, nothing changes. */
export class StaleValidationTargetError extends Error {
  constructor() {
    super("That version's validation pipelines aren't the ones shown.");
    this.name = "StaleValidationTargetError";
  }
}

export interface ValidationPipelinesState {
  /** The version the pipelines belong to, in the organization it was loaded in; null before any read. */
  target: RunTarget | null;
  /** The version's validation pipelines, oldest first, as the API lists them. */
  pipelines: ValidationPipeline[];
  /** Whether a read of the pipelines is under way. */
  pipelinesLoading: boolean;
  /** Whether `pipelines` holds an answer for `target`. */
  pipelinesLoaded: boolean;
  /** Why the last read failed, shown with Retry; null otherwise. */
  pipelinesError: string | null;
  /** Each pipeline's rules, in position order, once read. */
  rulesByPipeline: Record<string, ValidationRule[]>;
  /** The pipelines whose rules are being read. */
  rulesLoadingByPipeline: Record<string, boolean>;
  /** Why a pipeline's last read of its rules failed, shown with Retry. */
  rulesErrorByPipeline: Record<string, string>;
  /**
   * Each rule change or delete under way, by write, with the rule it writes
   * (`ruleWriteKey`: its version's and its own ids); kept across versions,
   * forgotten on signing out. A rule listed here is held (`isRuleWriteInFlight`).
   */
  ruleWritesInFlight: Record<string, string>;

  /** Reads `target`'s validation pipelines afresh (another version's start from none), aborted after RUNS_REQUEST_TIMEOUT_MS. Never rejects: a failure is `pipelinesError`. */
  loadPipelines: (target: RunTarget) => Promise<void>;
  /**
   * A pipeline's rules: the read under way, else a fresh one, aborted after
   * RUNS_REQUEST_TIMEOUT_MS. Rejects as the API did (and records why in
   * `rulesErrorByPipeline`), and with StaleValidationTargetError, reading
   * nothing, when `target` isn't the version the store holds.
   */
  loadRules: (target: RunTarget, validationPipelineId: string) => Promise<ValidationRule[]>;
  /** Creates a YAML pipeline's validation pipeline; it joins the list's end, or the list is read again when it isn't shown. Rejects as the API did; a 404 (the version gone) reads the list again. */
  createPipeline: (target: RunTarget, pipeline: string) => Promise<ValidationPipeline>;
  /** Deletes a validation pipeline, its rules with it. Rejects as the API did; one already gone ("not found") is dropped here too. */
  deletePipeline: (target: RunTarget, validationPipelineId: string) => Promise<void>;
  /** Adds a rule; it joins its pipeline's list's end (the API's place), or, answered after its version was left and come back to, its pipeline's rules are read again. Rejects as the API did; a pipeline already gone ("not found") is dropped here too. */
  createRule: (target: RunTarget, validationPipelineId: string, request: CreateValidationRuleRequest) => Promise<ValidationRule>;
  /** Changes a rule; it keeps its place. Held in `ruleWritesInFlight` until the API answers (answered after its version was left and come back to, until its pipeline's rules are read again). Rejects as the API did; a rule or pipeline already gone ("not found") is dropped here too. */
  updateRule: (
    target: RunTarget,
    validationPipelineId: string,
    ruleId: string,
    request: UpdateValidationRuleRequest,
  ) => Promise<ValidationRule>;
  /** Deletes a rule. Held in `ruleWritesInFlight` until the API answers (answered after its version was left and come back to, until its pipeline's rules are read again). Rejects as the API did; a rule or pipeline already gone ("not found") is dropped here too. */
  deleteRule: (target: RunTarget, validationPipelineId: string, ruleId: string) => Promise<void>;
  /** Forgets everything (signing out). */
  reset: () => void;
}

const EMPTY = {
  target: null,
  pipelines: [],
  pipelinesLoading: false,
  pipelinesLoaded: false,
  pipelinesError: null,
  rulesByPipeline: {},
  rulesLoadingByPipeline: {},
  rulesErrorByPipeline: {},
} satisfies Partial<ValidationPipelinesState>;

/** Whether `left` and `right` name the same version in the same organization. */
export function sameTarget(left: RunTarget | null, right: RunTarget | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.organizationId === right.organizationId &&
    left.configurationId === right.configurationId &&
    left.versionId === right.versionId
  );
}

/** A rule as `ruleWritesInFlight` names it: its version (in its organization) and its id. */
export function ruleWriteKey(target: RunTarget, ruleId: string): string {
  return `${target.organizationId}/${target.configurationId}/${target.versionId}/${ruleId}`;
}

/** Whether a change or delete of `target`'s rule `ruleId` is under way: its Edit and Delete are held until the API answers. */
export function isRuleWriteInFlight(writes: Record<string, string>, target: RunTarget, ruleId: string): boolean {
  const key = ruleWriteKey(target, ruleId);
  return Object.values(writes).includes(key);
}

/** Whether a delete was refused because the validation pipeline or rule is already gone (another tab deleted it). */
export function isAlreadyGone(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "validation_pipeline_not_found" || error.code === "validation_rule_not_found");
}

/** `record` without `key`. */
function without<Value>(record: Record<string, Value>, key: string): Record<string, Value> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** Counts sign-outs and target changes: an answer to a request made before one adds nothing. */
let epoch = 0;

/** Counts sign-outs alone: a rule write's answer from before one adds nothing (`holding`). */
let signOuts = 0;

/** The latest pipelines read: an answer to an earlier one is dropped. */
let pipelinesRead = 0;

/** Each pipeline's rules read under way, by pipeline id, for the target of `epoch`. */
let rulesReads = new Map<string, Promise<ValidationRule[]>>();

/** Counts the writes made here to the pipelines: a read whose answer was taken before one is read again. */
let pipelinesWrites = 0;

/** Counts the writes made here to each pipeline's rules, by pipeline id, as `pipelinesWrites`. */
let rulesWrites = new Map<string, number>();

/** Counts the rule changes and deletes sent: each one's key in `ruleWritesInFlight`. */
let ruleWritesSent = 0;

/** Notes a write to a pipeline's rules. */
function wroteRules(validationPipelineId: string): void {
  rulesWrites.set(validationPipelineId, (rulesWrites.get(validationPipelineId) ?? 0) + 1);
}

export const useValidationPipelinesStore = create<ValidationPipelinesState>()((set, get) => {
  /** Starts holding `target`: another version's pipelines and rules are forgotten. */
  const hold = (target: RunTarget) => {
    if (sameTarget(get().target, target)) return;
    epoch += 1;
    rulesReads = new Map();
    rulesWrites = new Map();
    set({ ...EMPTY, target });
  };

  /** Whether an answer for `target`, asked at `at`, may still change the store. */
  const current = (target: RunTarget, at: number) => epoch === at && sameTarget(get().target, target);

  /**
   * Whether a rule write's answer for `target`, sent before `signedOut`
   * sign-outs, still concerns the store: `target` is the version held, even
   * when the store left it and came back meanwhile. Not left (`current`),
   * the answer is placed; left and come back to, the rules read since may
   * predate the write, so they are read again (`rereadRules`).
   */
  const holding = (target: RunTarget, signedOut: number) => signedOut === signOuts && sameTarget(get().target, target);

  /**
   * A rule write answered after its version was left and come back to: the
   * answer isn't placed, as a teammate may have written since; the
   * pipeline's rules are read again instead, by a read sent after the answer
   * (one under way reads again as it answers), so the store shows what the
   * API holds now, the write's or a later one. Only while the pipeline is
   * listed: one gone has nothing to read. Settles once that read answers or
   * fails, never rejecting: the rule's hold is released then, and Edit opens
   * on what was read.
   */
  const rereadRules = async (target: RunTarget, validationPipelineId: string) => {
    if (!get().pipelines.some((listed) => listed.id === validationPipelineId)) return;
    wroteRules(validationPipelineId);
    await get()
      .loadRules(target, validationPipelineId)
      .catch(() => undefined);
  };

  /** Forgets a validation pipeline and its rules (deleted, here or by a teammate). */
  const dropPipeline = (validationPipelineId: string) => {
    pipelinesWrites += 1;
    // Its rules went with it (on delete cascade): their cache goes too.
    set((state) => ({
      pipelines: state.pipelines.filter((listed) => listed.id !== validationPipelineId),
      rulesByPipeline: without(state.rulesByPipeline, validationPipelineId),
      rulesErrorByPipeline: without(state.rulesErrorByPipeline, validationPipelineId),
    }));
  };

  /** Forgets a rule (deleted, here or by a teammate). */
  const dropRule = (validationPipelineId: string, ruleId: string) => {
    wroteRules(validationPipelineId);
    set((state) => {
      const listed = state.rulesByPipeline[validationPipelineId];
      return listed === undefined
        ? {}
        : { rulesByPipeline: { ...state.rulesByPipeline, [validationPipelineId]: listed.filter((each) => each.id !== ruleId) } };
    });
  };

  /**
   * A rule write answered "not found" (another tab deleted the rule, or its
   * pipeline): what is gone is dropped here too, while `target` is still the
   * one held (`holding`).
   */
  const dropGone = (target: RunTarget, signedOut: number, error: unknown, validationPipelineId: string, ruleId: string | null) => {
    if (!isAlreadyGone(error) || !holding(target, signedOut)) return;
    if ((error as ApiError).code === "validation_pipeline_not_found") dropPipeline(validationPipelineId);
    else if (ruleId !== null) dropRule(validationPipelineId, ruleId);
  };

  /**
   * Notes a change or delete of a rule under way (`ruleWritesInFlight`);
   * what it returns forgets it, called once the API has answered and the
   * answer is in the store, so a held Edit opens on what the API kept. On
   * the late path (version left and come back to) that is after the rules
   * are read again, or at once when the pipeline isn't listed.
   */
  const writingRule = (target: RunTarget, ruleId: string) => {
    ruleWritesSent += 1;
    const write = String(ruleWritesSent);
    set((state) => ({ ruleWritesInFlight: { ...state.ruleWritesInFlight, [write]: ruleWriteKey(target, ruleId) } }));
    return () =>
      set((state) => (write in state.ruleWritesInFlight ? { ruleWritesInFlight: without(state.ruleWritesInFlight, write) } : {}));
  };

  /** Puts `rule` in its pipeline's list: in its place when listed, else at the end. */
  const placeRule = (validationPipelineId: string, rule: ValidationRule) =>
    set((state) => {
      const listed = state.rulesByPipeline[validationPipelineId] ?? [];
      const rules = listed.some((each) => each.id === rule.id)
        ? listed.map((each) => (each.id === rule.id ? rule : each))
        : [...listed, rule];
      return { rulesByPipeline: { ...state.rulesByPipeline, [validationPipelineId]: rules } };
    });

  return {
    ...EMPTY,
    ruleWritesInFlight: {},

    loadPipelines: async (target) => {
      hold(target);
      const at = epoch;
      const thisRead = ++pipelinesRead;
      const writesAt = pipelinesWrites;
      set({ pipelinesLoading: true, pipelinesError: null });
      const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
      try {
        const { validationPipelines } = await readsFor(target.organizationId).getValidationPipelines(target.organizationId, target.configurationId, target.versionId, {
          signal: timeout.signal,
        });
        if (!current(target, at) || thisRead !== pipelinesRead) return;
        // Taken before a write made here meanwhile: read again, rather than lose the write.
        if (writesAt !== pipelinesWrites) return get().loadPipelines(target);
        // A pipeline gone since keeps no rules here.
        const listed = new Set(validationPipelines.map((pipeline) => pipeline.id));
        set((state) => ({
          pipelines: validationPipelines,
          pipelinesLoading: false,
          pipelinesLoaded: true,
          rulesByPipeline: Object.fromEntries(Object.entries(state.rulesByPipeline).filter(([id]) => listed.has(id))),
        }));
      } catch (error) {
        if (!current(target, at) || thisRead !== pipelinesRead) return;
        set({ pipelinesLoading: false, pipelinesError: readFailure(error, PIPELINES_LOAD_FAILED_MESSAGE) });
      } finally {
        timeout.clear();
      }
    },

    loadRules: (target, validationPipelineId) => {
      if (!sameTarget(get().target, target)) return Promise.reject(new StaleValidationTargetError());
      const under = rulesReads.get(validationPipelineId);
      if (under !== undefined) return under;
      const at = epoch;
      const reads = rulesReads;
      const writesAt = rulesWrites.get(validationPipelineId) ?? 0;
      set((state) => ({
        rulesLoadingByPipeline: { ...state.rulesLoadingByPipeline, [validationPipelineId]: true },
        rulesErrorByPipeline: without(state.rulesErrorByPipeline, validationPipelineId),
      }));
      const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
      const reading = readsFor(target.organizationId).getValidationRules(target.organizationId, target.configurationId, target.versionId, validationPipelineId, {
        signal: timeout.signal,
      }).then(
        ({ rules }): ValidationRule[] | Promise<ValidationRule[]> => {
          timeout.clear();
          reads.delete(validationPipelineId);
          // Taken before a write made here meanwhile: read again, rather than lose the write.
          if (current(target, at) && writesAt !== (rulesWrites.get(validationPipelineId) ?? 0)) {
            return get().loadRules(target, validationPipelineId);
          }
          if (current(target, at)) {
            set((state) => ({
              rulesByPipeline: { ...state.rulesByPipeline, [validationPipelineId]: rules },
              rulesLoadingByPipeline: without(state.rulesLoadingByPipeline, validationPipelineId),
            }));
          }
          return rules;
        },
        (error: unknown) => {
          timeout.clear();
          reads.delete(validationPipelineId);
          if (current(target, at)) {
            const message = readFailure(error, RULES_LOAD_FAILED_MESSAGE);
            set((state) => ({
              rulesLoadingByPipeline: without(state.rulesLoadingByPipeline, validationPipelineId),
              rulesErrorByPipeline:
                message === null ? state.rulesErrorByPipeline : { ...state.rulesErrorByPipeline, [validationPipelineId]: message },
            }));
          }
          throw error;
        },
      );
      reads.set(validationPipelineId, reading);
      return reading;
    },

    createPipeline: async (target, pipeline) => {
      const at = epoch;
      let validationPipeline: ValidationPipeline;
      try {
        ({ validationPipeline } = await createValidationPipeline(target.organizationId, target.configurationId, target.versionId, {
          pipeline,
        }));
      } catch (error) {
        // The version (or its configuration) is gone: the list is read again, and shows the API's refusal.
        if (error instanceof ApiError && error.status === 404 && current(target, at)) void get().loadPipelines(target);
        throw error;
      }
      if (!current(target, at)) return validationPipeline;
      pipelinesWrites += 1;
      if (get().pipelinesLoaded) {
        set((state) => ({
          pipelines: [...state.pipelines.filter((listed) => listed.id !== validationPipeline.id), validationPipeline],
          // A new pipeline has no rules: nothing to read.
          rulesByPipeline: { ...state.rulesByPipeline, [validationPipeline.id]: [] },
        }));
      } else {
        // Not shown (the first read failed, or is under way): read them now, the new one with the rest.
        void get().loadPipelines(target);
      }
      return validationPipeline;
    },

    deletePipeline: async (target, validationPipelineId) => {
      const at = epoch;
      let refusal: unknown = null;
      try {
        await deleteValidationPipeline(target.organizationId, target.configurationId, target.versionId, validationPipelineId);
      } catch (error) {
        // Already gone (another tab deleted it): dropped here too, and the refusal still answered.
        if (!isAlreadyGone(error)) throw error;
        refusal = error;
      }
      if (current(target, at)) dropPipeline(validationPipelineId);
      if (refusal !== null) throw refusal;
    },

    createRule: async (target, validationPipelineId, request) => {
      const at = epoch;
      const signedOut = signOuts;
      let rule: ValidationRule;
      try {
        ({ rule } = await createValidationRule(target.organizationId, target.configurationId, target.versionId, validationPipelineId, request));
      } catch (error) {
        // Rethrown straight after dropGone, no await between: RuleEditorDialog's and the regex library picker's unmount
        // bumps, deferred a microtask, rely on it.
        dropGone(target, signedOut, error, validationPipelineId, null);
        throw error;
      }
      if (!current(target, at)) {
        // Answered after the version was left and come back to: read, not placed.
        if (holding(target, signedOut)) void rereadRules(target, validationPipelineId);
        return rule;
      }
      wroteRules(validationPipelineId);
      if (get().rulesByPipeline[validationPipelineId] !== undefined) {
        placeRule(validationPipelineId, rule);
      } else {
        // Never read (its read failed): read it now, the new one with the rest, so the list is whole.
        get()
          .loadRules(target, validationPipelineId)
          .catch(() => undefined);
      }
      return rule;
    },

    updateRule: async (target, validationPipelineId, ruleId, request) => {
      const at = epoch;
      const signedOut = signOuts;
      const written = writingRule(target, ruleId);
      try {
        let rule: ValidationRule;
        try {
          ({ rule } = await updateValidationRule(
            target.organizationId,
            target.configurationId,
            target.versionId,
            validationPipelineId,
            ruleId,
            request,
          ));
        } catch (error) {
          // Rethrown straight after dropGone, no await between: RuleEditorDialog's unmount bump, deferred a microtask, relies on it.
          dropGone(target, signedOut, error, validationPipelineId, ruleId);
          throw error;
        }
        if (current(target, at)) {
          // A read under way reads again: its answer may have been taken before the write.
          wroteRules(validationPipelineId);
          if (get().rulesByPipeline[validationPipelineId] !== undefined) placeRule(validationPipelineId, rule);
        } else if (holding(target, signedOut)) {
          // Answered after the version was left and come back to: read, not placed.
          await rereadRules(target, validationPipelineId);
        }
        return rule;
      } finally {
        // Answered (refused or not) and its answer in the store, or read again: the rule's Edit opens on what the API keeps.
        written();
      }
    },

    deleteRule: async (target, validationPipelineId, ruleId) => {
      const at = epoch;
      const signedOut = signOuts;
      const written = writingRule(target, ruleId);
      try {
        try {
          await deleteValidationRule(target.organizationId, target.configurationId, target.versionId, validationPipelineId, ruleId);
        } catch (error) {
          // Already gone (another tab deleted it, or its pipeline): dropped here too, and the refusal still answered.
          dropGone(target, signedOut, error, validationPipelineId, ruleId);
          throw error;
        }
        if (current(target, at)) dropRule(validationPipelineId, ruleId);
        // Answered after the version was left and come back to: read, not dropped.
        else if (holding(target, signedOut)) await rereadRules(target, validationPipelineId);
      } finally {
        written();
      }
    },

    reset: () => {
      epoch += 1;
      signOuts += 1;
      pipelinesRead += 1;
      rulesReads = new Map();
      rulesWrites = new Map();
      set({ ...EMPTY, ruleWritesInFlight: {} });
    },
  };
});
