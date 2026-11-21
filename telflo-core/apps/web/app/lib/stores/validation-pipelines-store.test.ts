import type { ValidationPipelinesResponse, ValidationRulesResponse } from "@telflo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { GROUP_ID, MINE, VERSION_ID } from "~/test/configurations.js";
import { validationPipelineFixture, validationRuleFixture } from "~/test/validation-pipelines.js";
import {
  isRuleWriteInFlight,
  PIPELINES_LOAD_FAILED_MESSAGE,
  RULES_LOAD_FAILED_MESSAGE,
  StaleValidationTargetError,
  useValidationPipelinesStore,
} from "./validation-pipelines-store.js";

/*
 * The Validation subtab's store. The first six are the slice's basics, on the
 * platform's API (the rule's place is the API's; a validation pipeline is
 * created by its YAML pipeline's name alone); the rest: answers for another
 * version, another organization or after signing out dropped, a read never
 * overwriting a write, failures' words, and a delete of one already gone; then
 * a rule's change or delete held until it answers, and a 404 that isn't the
 * validation pipeline's or rule's dropping nothing; a rule write answered
 * after the version was left and come back to showing, a rule's delete
 * answered "validation pipeline not found" dropping the pipeline, and a
 * refused change releasing its rule; and such a late answer read again rather
 * than placed, a teammate's later change kept, a create and a delete
 * converging, the hold released as the read again answers or fails, and
 * nothing read for a pipeline no longer listed.
 */

const TARGET = { organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION_ID };
const OTHER = { ...TARGET, versionId: "0199c000-0000-7000-8000-000000000002" };
/** The same configuration and version ids under another organization: another target. */
const OTHER_ORGANIZATION = { ...TARGET, organizationId: "00000000-0000-4000-8000-0000000000aa" };
const VP = validationPipelineFixture();
const RULE = validationRuleFixture({ position: 3 });

/** A promise and the means to settle it, for an answer the test releases. */
function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const store = () => useValidationPipelinesStore.getState();

beforeEach(() => {
  vi.restoreAllMocks();
  store().reset();
});

describe("the validation pipelines slice", () => {
  it("loadPipelines stores the list; another version's starts with no rules cached", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    expect(store().rulesByPipeline).toEqual({ [VP.id]: [RULE] });

    const other = validationPipelineFixture({ id: "0199f300-0000-7000-8000-000000000002", versionId: OTHER.versionId });
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [other] });
    await store().loadPipelines(OTHER);

    expect(store().pipelines).toEqual([other]);
    expect(store().target).toEqual(OTHER);
    expect(store().rulesByPipeline).toEqual({});
  });

  it("createPipeline appends only when the version still matches", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [] });
    await store().loadPipelines(OTHER);
    const create = vi.spyOn(apiClient, "createValidationPipeline").mockResolvedValue({ validationPipeline: VP });

    await store().createPipeline(TARGET, "logs");

    expect(create).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, { pipeline: "logs" });
    expect(store().pipelines).toEqual([]);
  });

  it("deletePipeline prunes the pipeline and its rule cache", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    vi.spyOn(apiClient, "deleteValidationPipeline").mockResolvedValue(undefined);

    await store().deletePipeline(TARGET, VP.id);

    expect(store().pipelines).toEqual([]);
    expect(store().rulesByPipeline[VP.id]).toBeUndefined();
  });

  it("loadRules caches per pipeline", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);

    await store().loadRules(TARGET, VP.id);

    expect(store().rulesByPipeline[VP.id]).toEqual([RULE]);
    expect(read).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, VP.id, { signal: expect.any(AbortSignal) });
  });

  it("createRule leaves the rule's place to the API, computing no sort order: it joins its pipeline's list at the end", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const added = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 4, pattern: "world" });
    const create = vi.spyOn(apiClient, "createValidationRule").mockResolvedValue({ rule: added });

    await store().createRule(TARGET, VP.id, { kind: "contains_text", target: "output", pattern: "world" });

    // No position sent: max + 1 is the API's.
    expect(create).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, VP.id, { kind: "contains_text", target: "output", pattern: "world" });
    expect(store().rulesByPipeline[VP.id]).toEqual([RULE, added]);
  });

  it("createRule on a pipeline whose rules were never read reads them, so the list is whole", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    await store().loadPipelines(TARGET);
    const added = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 6 });
    vi.spyOn(apiClient, "createValidationRule").mockResolvedValue({ rule: added });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [validationRuleFixture({ position: 5 }), added] });

    await store().createRule(TARGET, VP.id, { kind: "contains_text", target: "output", pattern: "world" });

    await vi.waitFor(() => expect(store().rulesByPipeline[VP.id]).toHaveLength(2));
    expect(read).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, VP.id, { signal: expect.any(AbortSignal) });
  });
});

describe("the pipelines' reads", () => {
  it("drop an answer for a version left since, and an earlier read's answer", async () => {
    const first = deferred<ValidationPipelinesResponse>();
    const second = deferred<ValidationPipelinesResponse>();
    vi.spyOn(apiClient, "getValidationPipelines").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const stale = store().loadPipelines(TARGET);
    const fresh = store().loadPipelines(OTHER);

    first.resolve({ validationPipelines: [VP] });
    await stale;
    expect(store().pipelines).toEqual([]);
    second.resolve({ validationPipelines: [] });
    await fresh;
    expect(store()).toMatchObject({ target: OTHER, pipelines: [], pipelinesLoaded: true });
  });

  it("keep a failed read's words: a refusal's own, else 'Failed to load validation pipelines'; a session that ended, none", async () => {
    const read = vi.spyOn(apiClient, "getValidationPipelines");
    read.mockRejectedValueOnce(new ApiError("configuration_version_not_found", "Version not found", { status: 404 }));
    await store().loadPipelines(TARGET);
    expect(store().pipelinesError).toBe("Version not found");

    read.mockRejectedValueOnce(new ApiError("internal_error", "Something broke", { status: 500 }));
    await store().loadPipelines(TARGET);
    expect(store().pipelinesError).toBe(PIPELINES_LOAD_FAILED_MESSAGE);

    read.mockRejectedValueOnce(new ApiError("unauthenticated", "Sign in", { status: 401 }));
    await store().loadPipelines(TARGET);
    expect(store()).toMatchObject({ pipelinesError: null, pipelinesLoading: false });
  });

  it("read again when a write was made here while one was under way, so the write isn't lost", async () => {
    const answer = deferred<ValidationPipelinesResponse>();
    const read = vi
      .spyOn(apiClient, "getValidationPipelines")
      .mockResolvedValueOnce({ validationPipelines: [] })
      .mockReturnValueOnce(answer.promise)
      .mockResolvedValueOnce({ validationPipelines: [VP] });
    await store().loadPipelines(TARGET);
    const reading = store().loadPipelines(TARGET);
    vi.spyOn(apiClient, "createValidationPipeline").mockResolvedValue({ validationPipeline: VP });
    await store().createPipeline(TARGET, "logs");

    // The answer taken before the create: dropped, and the list read again.
    answer.resolve({ validationPipelines: [] });
    await reading;

    expect(read).toHaveBeenCalledTimes(3);
    expect(store().pipelines).toEqual([VP]);
  });

  it("drop answers for an organization left since, its configuration and version ids alike", async () => {
    vi.spyOn(apiClient, "getValidationPipelines")
      .mockResolvedValueOnce({ validationPipelines: [VP] })
      .mockResolvedValueOnce({ validationPipelines: [] });
    await store().loadPipelines(TARGET);
    const rules = deferred<ValidationRulesResponse>();
    vi.spyOn(apiClient, "getValidationRules").mockReturnValue(rules.promise);
    const created = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "createValidationRule").mockReturnValue(created.promise);
    const reading = store().loadRules(TARGET, VP.id);
    const creating = store().createRule(TARGET, VP.id, { kind: "contains_text", target: "output", pattern: "zq" });

    await store().loadPipelines(OTHER_ORGANIZATION);
    expect(store()).toMatchObject({ target: OTHER_ORGANIZATION, pipelines: [], rulesByPipeline: {} });
    rules.resolve({ rules: [RULE] });
    created.resolve({ rule: RULE });
    await reading;
    await creating;

    // The first organization's answers add nothing to the second's.
    expect(store()).toMatchObject({ target: OTHER_ORGANIZATION, pipelines: [], rulesByPipeline: {}, rulesLoadingByPipeline: {} });
    // And a read for the organization left is refused, reading nothing.
    await expect(store().loadRules(TARGET, VP.id)).rejects.toBeInstanceOf(StaleValidationTargetError);
    expect(apiClient.getValidationRules).toHaveBeenCalledTimes(1);
  });

  it("are forgotten on reset (signing out): an answer that arrives after adds nothing", async () => {
    const answer = deferred<ValidationPipelinesResponse>();
    vi.spyOn(apiClient, "getValidationPipelines").mockReturnValue(answer.promise);
    const reading = store().loadPipelines(TARGET);

    store().reset();
    answer.resolve({ validationPipelines: [VP] });
    await reading;

    expect(store()).toMatchObject({ target: null, pipelines: [], pipelinesLoaded: false, pipelinesLoading: false });
  });
});

describe("a pipeline's rules", () => {
  it("answer the read under way rather than start another; a read for a version not held is refused, reading nothing", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    await store().loadPipelines(TARGET);
    const answer = deferred<ValidationRulesResponse>();
    const read = vi.spyOn(apiClient, "getValidationRules").mockReturnValue(answer.promise);

    const one = store().loadRules(TARGET, VP.id);
    const two = store().loadRules(TARGET, VP.id);
    answer.resolve({ rules: [RULE] });

    await expect(one).resolves.toEqual([RULE]);
    await expect(two).resolves.toEqual([RULE]);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(store().loadRules(OTHER, VP.id)).rejects.toBeInstanceOf(StaleValidationTargetError);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keep a failed read's words, 'Failed to load validation rules', cleared by the next read", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    await store().loadPipelines(TARGET);
    const read = vi.spyOn(apiClient, "getValidationRules").mockRejectedValueOnce(new ApiError("internal_error", "x", { status: 500 }));

    await expect(store().loadRules(TARGET, VP.id)).rejects.toBeInstanceOf(ApiError);
    expect(store().rulesErrorByPipeline[VP.id]).toBe(RULES_LOAD_FAILED_MESSAGE);

    read.mockResolvedValueOnce({ rules: [RULE] });
    await store().loadRules(TARGET, VP.id);
    expect(store().rulesErrorByPipeline[VP.id]).toBeUndefined();
    expect(store().rulesByPipeline[VP.id]).toEqual([RULE]);
  });

  it("are read again when a rule was changed here while a read was under way", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    await store().loadPipelines(TARGET);
    const changed = { ...RULE, name: "renamed" };
    const answer = deferred<ValidationRulesResponse>();
    const read = vi
      .spyOn(apiClient, "getValidationRules")
      .mockResolvedValueOnce({ rules: [RULE] })
      .mockReturnValueOnce(answer.promise)
      .mockResolvedValueOnce({ rules: [changed] });
    await store().loadRules(TARGET, VP.id);
    const reading = store().loadRules(TARGET, VP.id);
    vi.spyOn(apiClient, "updateValidationRule").mockResolvedValue({ rule: changed });
    await store().updateRule(TARGET, VP.id, RULE.id, { name: "renamed" });

    answer.resolve({ rules: [RULE] });

    await expect(reading).resolves.toEqual([changed]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(store().rulesByPipeline[VP.id]).toEqual([changed]);
  });

  it("keep their places when one is changed, and lose one deleted; one already gone (404) is dropped too, the refusal still answered", async () => {
    const second = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 4 });
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE, second] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const changed = { ...RULE, pattern: "zq-other" };
    vi.spyOn(apiClient, "updateValidationRule").mockResolvedValue({ rule: changed });

    await store().updateRule(TARGET, VP.id, RULE.id, { kind: "not_contains_text", target: "output", pattern: "zq-other" });
    expect(store().rulesByPipeline[VP.id]).toEqual([changed, second]);

    const gone = new ApiError("validation_rule_not_found", "Validation rule not found", { status: 404 });
    vi.spyOn(apiClient, "deleteValidationRule").mockRejectedValueOnce(gone);
    await expect(store().deleteRule(TARGET, VP.id, RULE.id)).rejects.toBe(gone);
    expect(store().rulesByPipeline[VP.id]).toEqual([second]);

    vi.spyOn(apiClient, "deleteValidationRule").mockRejectedValueOnce(new ApiError("internal_error", "x", { status: 500 }));
    await expect(store().deleteRule(TARGET, VP.id, second.id)).rejects.toBeInstanceOf(ApiError);
    expect(store().rulesByPipeline[VP.id]).toEqual([second]);
  });

  it("drops a pipeline already gone (404) from the list on its delete, the refusal still answered", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    await store().loadPipelines(TARGET);
    const gone = new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 });
    vi.spyOn(apiClient, "deleteValidationPipeline").mockRejectedValueOnce(gone);

    await expect(store().deletePipeline(TARGET, VP.id)).rejects.toBe(gone);

    expect(store().pipelines).toEqual([]);
  });

  it("drop a rule a teammate deleted when its change is answered 404, and its pipeline when the pipeline is gone; the refusal still answered", async () => {
    const second = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 4 });
    const other = validationPipelineFixture({ id: "0199f300-0000-7000-8000-000000000002", pipeline: "traces", signal: "traces" });
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP, other] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE, second] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const change = { kind: "not_contains_text", target: "output", pattern: "zq-other" } as const;

    const ruleGone = new ApiError("validation_rule_not_found", "Validation rule not found", { status: 404 });
    vi.spyOn(apiClient, "updateValidationRule").mockRejectedValueOnce(ruleGone);
    await expect(store().updateRule(TARGET, VP.id, RULE.id, change)).rejects.toBe(ruleGone);
    expect(store().rulesByPipeline[VP.id]).toEqual([second]);
    expect(store().pipelines).toEqual([VP, other]);

    // Any other refusal changes nothing.
    vi.spyOn(apiClient, "updateValidationRule").mockRejectedValueOnce(new ApiError("rules_unavailable", "x", { status: 503 }));
    await expect(store().updateRule(TARGET, VP.id, second.id, change)).rejects.toBeInstanceOf(ApiError);
    expect(store().rulesByPipeline[VP.id]).toEqual([second]);

    const pipelineGone = new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 });
    vi.spyOn(apiClient, "updateValidationRule").mockRejectedValueOnce(pipelineGone);
    await expect(store().updateRule(TARGET, VP.id, second.id, change)).rejects.toBe(pipelineGone);
    expect(store().pipelines).toEqual([other]);
    expect(store().rulesByPipeline[VP.id]).toBeUndefined();
  });

  it("drop a pipeline a teammate deleted when a rule's create is answered 404; a pipeline's create answered 404 reads the list again", async () => {
    const read = vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);

    const pipelineGone = new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 });
    vi.spyOn(apiClient, "createValidationRule").mockRejectedValueOnce(pipelineGone);
    await expect(store().createRule(TARGET, VP.id, { kind: "contains_text", target: "output", pattern: "zq" })).rejects.toBe(pipelineGone);
    expect(store().pipelines).toEqual([]);
    expect(store().rulesByPipeline).toEqual({});

    const versionGone = new ApiError("configuration_version_not_found", "Configuration version not found", { status: 404 });
    vi.spyOn(apiClient, "createValidationPipeline").mockRejectedValueOnce(versionGone);
    read.mockRejectedValueOnce(versionGone);
    await expect(store().createPipeline(TARGET, "traces")).rejects.toBe(versionGone);
    await vi.waitFor(() => expect(store().pipelinesError).toBe("Configuration version not found"));
    expect(read).toHaveBeenCalledTimes(2);

    // A refusal that isn't a 404 reads nothing again.
    vi.spyOn(apiClient, "createValidationPipeline").mockRejectedValueOnce(new ApiError("validation_pipeline_exists", "x", { status: 409 }));
    await expect(store().createPipeline(TARGET, "logs")).rejects.toBeInstanceOf(ApiError);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("a rule's change or delete held, and a 404 that drops nothing", () => {
  it("drops nothing on a 404 that isn't the validation pipeline's or rule's (the configuration's, the organization's), the refusal still answered", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const change = { kind: "not_contains_text", target: "output", pattern: "zq-other" } as const;

    for (const gone of [
      new ApiError("configuration_not_found", "Configuration not found", { status: 404 }),
      new ApiError("organization_not_found", "Organization not found", { status: 404 }),
    ]) {
      vi.spyOn(apiClient, "updateValidationRule").mockRejectedValueOnce(gone);
      await expect(store().updateRule(TARGET, VP.id, RULE.id, change)).rejects.toBe(gone);
      vi.spyOn(apiClient, "createValidationRule").mockRejectedValueOnce(gone);
      await expect(store().createRule(TARGET, VP.id, change)).rejects.toBe(gone);
      vi.spyOn(apiClient, "deleteValidationRule").mockRejectedValueOnce(gone);
      await expect(store().deleteRule(TARGET, VP.id, RULE.id)).rejects.toBe(gone);
      vi.spyOn(apiClient, "deleteValidationPipeline").mockRejectedValueOnce(gone);
      await expect(store().deletePipeline(TARGET, VP.id)).rejects.toBe(gone);

      expect(store().pipelines).toEqual([VP]);
      expect(store().rulesByPipeline).toEqual({ [VP.id]: [RULE] });
    }
  });

  it("holds a rule while its change or delete is under way, until its answer is in the store, answered or refused; signing out forgets it", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const held = (target = TARGET) => isRuleWriteInFlight(store().ruleWritesInFlight, target, RULE.id);
    const change = { kind: "not_contains_text", target: "output", pattern: "zq-other" } as const;
    expect(held()).toBe(false);

    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);
    expect(held()).toBe(true);
    // Another version's rule of the same id isn't held.
    expect(held(OTHER)).toBe(false);
    // Released only once the answer is in the store.
    const unsubscribe = useValidationPipelinesStore.subscribe((state) => {
      if (!isRuleWriteInFlight(state.ruleWritesInFlight, TARGET, RULE.id)) {
        expect(state.rulesByPipeline[VP.id]?.[0]?.pattern).toBe("zq-other");
      }
    });
    answer.resolve({ rule: { ...RULE, pattern: "zq-other" } });
    await changing;
    unsubscribe();
    expect(held()).toBe(false);

    const refusal = deferred<undefined>();
    vi.spyOn(apiClient, "deleteValidationRule").mockReturnValueOnce(refusal.promise);
    const deleting = store().deleteRule(TARGET, VP.id, RULE.id);
    expect(held()).toBe(true);
    refusal.reject(new ApiError("internal_error", "Internal error", { status: 500 }));
    await expect(deleting).rejects.toBeInstanceOf(ApiError);
    expect(held()).toBe(false);

    const late = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(late.promise);
    const abandoned = store().updateRule(TARGET, VP.id, RULE.id, change);
    store().reset();
    expect(store().ruleWritesInFlight).toEqual({});
    late.resolve({ rule: RULE });
    await abandoned;
    expect(store().ruleWritesInFlight).toEqual({});
  });
});

describe("a rule write answered late, or for a pipeline gone", () => {
  const change = { kind: "not_contains_text", target: "output", pattern: "zq-new" } as const;

  /** TARGET's pipeline and its rules read, then another version's, mid-write, and TARGET's again: the store holds TARGET anew. */
  async function awayAndBack() {
    await store().loadPipelines(OTHER);
    await store().loadPipelines(TARGET);
  }

  it("shows a change answered after the version was left and come back to mid-save by reading the rules again, over a read taken before it; released only after", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);

    // Away and back mid-save; the rules read again before the change commits: the old text.
    await awayAndBack();
    await store().loadRules(TARGET, VP.id);
    expect(store().rulesByPipeline[VP.id]?.[0]?.pattern).toBe(RULE.pattern);
    expect(isRuleWriteInFlight(store().ruleWritesInFlight, TARGET, RULE.id)).toBe(true);

    // What the rules held as the hold was released.
    const atRelease: (string | null | undefined)[] = [];
    const unsubscribe = useValidationPipelinesStore.subscribe((state, before) => {
      const released = (writes: Record<string, string>) => !isRuleWriteInFlight(writes, TARGET, RULE.id);
      if (released(state.ruleWritesInFlight) && !released(before.ruleWritesInFlight)) {
        atRelease.push(state.rulesByPipeline[VP.id]?.[0]?.pattern);
      }
    });
    // The change committed: the API now lists it.
    read.mockResolvedValue({ rules: [{ ...RULE, pattern: "zq-new" }] });
    const readsBefore = read.mock.calls.length;
    answer.resolve({ rule: { ...RULE, pattern: "zq-new" } });
    await changing;
    unsubscribe();

    // Read again after the answer; released, and what Edit opens on is what the API kept.
    expect(read.mock.calls.length).toBe(readsBefore + 1);
    expect(atRelease).toEqual(["zq-new"]);
    expect(isRuleWriteInFlight(store().ruleWritesInFlight, TARGET, RULE.id)).toBe(false);
    expect(store().rulesByPipeline[VP.id]).toEqual([{ ...RULE, pattern: "zq-new" }]);
  });

  it("reads the rules again when a read is under way as such a change answers: the read taken before the change isn't kept", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);

    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);
    await awayAndBack();
    // A read taken before the change commits, answered after it.
    const stale = deferred<ValidationRulesResponse>();
    read.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ rules: [{ ...RULE, pattern: "zq-new" }] });
    const reading = store().loadRules(TARGET, VP.id);
    answer.resolve({ rule: { ...RULE, pattern: "zq-new" } });
    // Held until the read again answers.
    await new Promise((settle) => setTimeout(settle, 0));
    expect(isRuleWriteInFlight(store().ruleWritesInFlight, TARGET, RULE.id)).toBe(true);
    stale.resolve({ rules: [RULE] });
    await changing;
    await expect(reading).resolves.toEqual([{ ...RULE, pattern: "zq-new" }]);
    expect(store().rulesByPipeline[VP.id]).toEqual([{ ...RULE, pattern: "zq-new" }]);
    expect(store().ruleWritesInFlight).toEqual({});
  });
  it("places nothing answered after signing out, the same version held again since", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);

    store().reset();
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    answer.resolve({ rule: { ...RULE, pattern: "zq-new" } });
    await changing;

    expect(store().rulesByPipeline[VP.id]).toEqual([RULE]);
  });

  it("drops a pipeline a teammate deleted when a rule's delete is answered 'validation pipeline not found', the refusal still answered", async () => {
    const other = validationPipelineFixture({ id: "0199f300-0000-7000-8000-000000000002", pipeline: "traces", signal: "traces" });
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP, other] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const gone = new ApiError("validation_pipeline_not_found", "Validation pipeline not found", { status: 404 });
    vi.spyOn(apiClient, "deleteValidationRule").mockRejectedValueOnce(gone);

    await expect(store().deleteRule(TARGET, VP.id, RULE.id)).rejects.toBe(gone);

    expect(store().pipelines).toEqual([other]);
    expect(store().rulesByPipeline[VP.id]).toBeUndefined();
    expect(store().ruleWritesInFlight).toEqual({});
  });

  it.each([
    ["a rule the API refuses (400)", new ApiError("validation_rule_invalid", "OTTL syntax error: zq", { status: 400 })],
    ["the evaluator down (503)", new ApiError("rules_unavailable", "Rules can't be checked right now.", { status: 503 })],
    ["the server not reached", new ApiError("network_error", "Could not reach the server. Check your connection.")],
  ])("releases a rule whose change is refused: %s, the rule unchanged", async (_what, refusal) => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);
    expect(isRuleWriteInFlight(store().ruleWritesInFlight, TARGET, RULE.id)).toBe(true);

    answer.reject(refusal);

    await expect(changing).rejects.toBe(refusal);
    expect(isRuleWriteInFlight(store().ruleWritesInFlight, TARGET, RULE.id)).toBe(false);
    expect(store().ruleWritesInFlight).toEqual({});
    expect(store().rulesByPipeline[VP.id]).toEqual([RULE]);
  });
});

describe("a rule write answered after its version was left and come back to is read again, not placed", () => {
  const change = { kind: "not_contains_text", target: "output", pattern: "zq-mine" } as const;
  const SECOND = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000002", position: 4, pattern: "zq-second" });

  /** TARGET's pipeline and its rules read, then another version's, mid-write, and TARGET's again: the store holds TARGET anew. */
  async function awayAndBack() {
    await store().loadPipelines(OTHER);
    await store().loadPipelines(TARGET);
  }

  /** Settles what the store has under way (its answers are all resolved promises here). */
  const settled = () => new Promise((settle) => setTimeout(settle, 0));

  it("keeps a teammate's later change over mine answered late: the store and what Edit opens on are what the API holds", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);

    // The API commits my change, then a teammate's; away and back, the rules read show the teammate's.
    const teammates = { ...RULE, pattern: "zq-teammate" };
    read.mockResolvedValue({ rules: [teammates] });
    await awayAndBack();
    await store().loadRules(TARGET, VP.id);
    expect(store().rulesByPipeline[VP.id]).toEqual([teammates]);

    // My change's answer arrives last: not placed over the teammate's.
    const atRelease: (string | null | undefined)[] = [];
    const unsubscribe = useValidationPipelinesStore.subscribe((state, before) => {
      const released = (writes: Record<string, string>) => !isRuleWriteInFlight(writes, TARGET, RULE.id);
      if (released(state.ruleWritesInFlight) && !released(before.ruleWritesInFlight)) {
        atRelease.push(state.rulesByPipeline[VP.id]?.[0]?.pattern);
      }
    });
    answer.resolve({ rule: { ...RULE, pattern: "zq-mine" } });
    await expect(changing).resolves.toEqual({ ...RULE, pattern: "zq-mine" });
    unsubscribe();

    expect(atRelease).toEqual(["zq-teammate"]);
    expect(store().rulesByPipeline[VP.id]).toEqual([teammates]);
    expect(store().ruleWritesInFlight).toEqual({});
  });

  it("converges a create and a delete answered so by the read again: a rule a teammate deleted since isn't brought back, one re-created is kept", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);

    // A create the API commits, then a teammate deletes the new rule: the late answer doesn't bring it back.
    const created = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "createValidationRule").mockReturnValueOnce(created.promise);
    const creating = store().createRule(TARGET, VP.id, change);
    await awayAndBack();
    await store().loadRules(TARGET, VP.id);
    const readsBefore = read.mock.calls.length;
    created.resolve({ rule: SECOND });
    await expect(creating).resolves.toEqual(SECOND);
    await settled();
    expect(read.mock.calls.length).toBe(readsBefore + 1);
    expect(store().rulesByPipeline[VP.id]).toEqual([RULE]);

    // A create the API commits, read again: the new rule shows, in the API's place.
    const again = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "createValidationRule").mockReturnValueOnce(again.promise);
    const recreating = store().createRule(TARGET, VP.id, change);
    await awayAndBack();
    await store().loadRules(TARGET, VP.id);
    read.mockResolvedValue({ rules: [RULE, SECOND] });
    again.resolve({ rule: SECOND });
    await recreating;
    await settled();
    expect(store().rulesByPipeline[VP.id]).toEqual([RULE, SECOND]);

    // A delete the API commits, then a teammate adds a rule: the read again shows the API's list, the hold released after.
    const deleted = deferred<undefined>();
    vi.spyOn(apiClient, "deleteValidationRule").mockReturnValueOnce(deleted.promise);
    const deleting = store().deleteRule(TARGET, VP.id, SECOND.id);
    await awayAndBack();
    await store().loadRules(TARGET, VP.id);
    const third = validationRuleFixture({ id: "0199f400-0000-7000-8000-000000000003", position: 5, pattern: "zq-third" });
    read.mockResolvedValue({ rules: [RULE, third] });
    deleted.resolve(undefined);
    await deleting;
    expect(store().rulesByPipeline[VP.id]).toEqual([RULE, third]);
    expect(store().ruleWritesInFlight).toEqual({});
  });

  it("releases the rule when the read again fails, its words kept with Retry", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);
    await awayAndBack();
    await store().loadRules(TARGET, VP.id);
    const failed = deferred<ValidationRulesResponse>();
    read.mockReturnValueOnce(failed.promise);

    answer.resolve({ rule: { ...RULE, pattern: "zq-mine" } });
    await settled();
    expect(isRuleWriteInFlight(store().ruleWritesInFlight, TARGET, RULE.id)).toBe(true);
    failed.reject(new ApiError("network_error", "Could not reach the server. Check your connection."));
    await changing;

    expect(store().ruleWritesInFlight).toEqual({});
    expect(store().rulesErrorByPipeline[VP.id]).toBe(RULES_LOAD_FAILED_MESSAGE);
  });

  it("reads nothing for a pipeline no longer listed: no request, no error kept for it, the rule released", async () => {
    const pipelines = vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const created = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "createValidationRule").mockReturnValueOnce(created.promise);
    const creating = store().createRule(TARGET, VP.id, change);
    const answer = deferred<{ rule: typeof RULE }>();
    vi.spyOn(apiClient, "updateValidationRule").mockReturnValueOnce(answer.promise);
    const changing = store().updateRule(TARGET, VP.id, RULE.id, change);

    // A teammate deleted the pipeline meanwhile: back on the version, it isn't listed.
    pipelines.mockResolvedValue({ validationPipelines: [] });
    await awayAndBack();
    const readsBefore = read.mock.calls.length;
    created.resolve({ rule: SECOND });
    answer.resolve({ rule: { ...RULE, pattern: "zq-mine" } });
    await creating;
    await changing;
    await settled();

    expect(read.mock.calls.length).toBe(readsBefore);
    expect(store().rulesErrorByPipeline).toEqual({});
    expect(store().rulesByPipeline).toEqual({});
    expect(store().ruleWritesInFlight).toEqual({});
  });

  it("still places a change answered with the version never left, reading nothing more", async () => {
    vi.spyOn(apiClient, "getValidationPipelines").mockResolvedValue({ validationPipelines: [VP] });
    const read = vi.spyOn(apiClient, "getValidationRules").mockResolvedValue({ rules: [RULE] });
    await store().loadPipelines(TARGET);
    await store().loadRules(TARGET, VP.id);
    const readsBefore = read.mock.calls.length;
    vi.spyOn(apiClient, "updateValidationRule").mockResolvedValueOnce({ rule: { ...RULE, pattern: "zq-mine" } });

    await store().updateRule(TARGET, VP.id, RULE.id, change);
    await settled();

    expect(read.mock.calls.length).toBe(readsBefore);
    expect(store().rulesByPipeline[VP.id]).toEqual([{ ...RULE, pattern: "zq-mine" }]);
  });
});
