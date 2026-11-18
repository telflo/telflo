import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestRun,
  addValidationPipeline,
  addValidationRule,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type AddTestRunInput,
  type AddValidationRuleInput,
  type TestDatabases,
} from "./testing.js";

/** The two-session race's own timeout: above waitsOnLock's bound, so a race that never waits fails there first. */
const LOCK_RACE_TIMEOUT = 30_000;

/** waitsOnLock's deadline, a hang guard well below LOCK_RACE_TIMEOUT (D14b Rulings 32 and 36). */
const LOCK_WAIT_DEADLINE_MS = 10_000;

/*
 * Migration 1700000000030 (D15a decisions 3, 12 to 15, details 23;
 * Preflight rulings 10, 16, 17, 18 and 23): validation pipelines and their
 * rules, the runs' validation_failed status with the rules' snapshot and
 * results, test_runs_finish's final status, test_runs_rules and the
 * evaluator's state. Its up, down and up again are
 * schema.integration.test.ts's ("the validation rules migration …"). The
 * cross-tenant suite covers both tables from the resource registry, and
 * apps/api's draft-privacy.integration.test.ts their visibility within an
 * organization through the API's context, test-run-functions' the
 * dispatcher's functions refused from members' real contexts.
 *
 * The database context is set here with set_config, as context.ts sets it:
 * these tests are the database's own. A rule's position (Preflight ruling
 * 16) is checked with two sessions as the API's login role, running the
 * statements the ruling names, since the rules' repository is Task 6's; one
 * session waits for the other's lock by a condition (pg_stat_activity),
 * never a time.
 */

/** Whom a transaction acts as: a member (a user, an organization), the dispatcher, or nobody. */
interface Context {
  userId?: string;
  organizationId?: string;
  dispatcher?: boolean;
}

/** A text rule's snapshot on a run, as Task 7's queue writes it (its shape is the API's). */
const snapshotRule = (pattern = "secret") => ({ id: randomUUID(), kind: "contains_text", target: "output", pattern });

describe("validation pipelines, rules and the runs' validation status (migration 1700000000030)", () => {
  let databases: TestDatabases;
  /** The API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** Runs `work` as the API's role in `context`, set as context.ts sets it, in one transaction. */
  const inContext = <Result>(context: Context, work: (transaction: Transaction<Database>) => Promise<Result>) =>
    db.transaction().execute(async (transaction) => {
      await sql`
        select set_config('telflo.user_id', ${context.userId ?? ""}, true),
               set_config('telflo.organization_id', ${context.organizationId ?? ""}, true),
               set_config('telflo.dispatcher', ${context.dispatcher === true ? "on" : ""}, true)
      `.execute(transaction);
      return work(transaction);
    });
  const asDispatcher = <Result>(work: (transaction: Transaction<Database>) => Promise<Result>) =>
    inContext({ dispatcher: true }, work);

  /**
   * Two group organizations. A: Ana (an admin, who authored a draft and a
   * published configuration) and Ben (a contributor); B: Cara, with her
   * published configuration. Each keeps their personal organization. Each
   * configuration has a v1 (published on the published ones) and a draft v2.
   */
  const world = async () => {
    const person = async () => (await createUserWithOrganization(ownerDb)).user.id;
    const ana = await person();
    const ben = await person();
    const cara = await person();
    const { organization: a } = await addMembership(ownerDb, { userId: ana });
    await addMembership(ownerDb, { userId: ben, organizationId: a.id, role: "contributor" });
    const { organization: b } = await addMembership(ownerDb, { userId: cara });
    const configuration = async (organizationId: string, authorId: string, published: boolean) => {
      const row = await addConfiguration(ownerDb, { organizationId, created_by_user_id: authorId });
      const v1 = await addConfigurationVersion(ownerDb, {
        configurationId: row.id,
        organizationId,
        created_by_user_id: authorId,
        ...(published ? { publishedAt: new Date() } : {}),
      });
      const v2 = await addConfigurationVersion(ownerDb, {
        configurationId: row.id,
        organizationId,
        version_number: 2,
        created_by_user_id: authorId,
      });
      return { organizationId, configurationId: row.id, v1: v1.id, v2: v2.id };
    };
    return {
      ana,
      ben,
      cara,
      a: a.id,
      b: b.id,
      draft: await configuration(a.id, ana, false),
      published: await configuration(a.id, ana, true),
      inB: await configuration(b.id, cara, true),
    };
  };
  type World = Awaited<ReturnType<typeof world>>;
  type Target = World["draft"];

  /** A validation pipeline on `target`'s version (v1 by default), as the owner. */
  const pipelineOn = (target: Target, overrides: Record<string, unknown> = {}, versionId = target.v1) =>
    addValidationPipeline(ownerDb, {
      organizationId: target.organizationId,
      configurationId: target.configurationId,
      configurationVersionId: versionId,
      ...overrides,
    });
  /** A rule in `pipeline`, as the owner; any column may be given, a value the checks refuse included. */
  const ruleIn = (
    pipeline: { id: string; organization_id: string; configuration_id: string; configuration_version_id: string },
    overrides: Record<string, unknown> = {},
  ) =>
    addValidationRule(ownerDb, {
      organizationId: pipeline.organization_id,
      configurationId: pipeline.configuration_id,
      configurationVersionId: pipeline.configuration_version_id,
      validationPipelineId: pipeline.id,
      ...(overrides as Partial<AddValidationRuleInput>),
    });
  /** An OTTL rule's columns: every log record's env is prod (Ana's rule), with `overrides`. */
  const ottl = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: "ottl",
    target: "output",
    pattern: null,
    ottl_context: "log",
    ottl_condition: 'attributes["env"] == "prod"',
    ottl_quantifier: "all",
    ...overrides,
  });
  /** A pipeline on `target`'s v1 with one rule, created by `creatorId`. */
  const tree = async (target: Target, creatorId: string) => {
    const pipeline = await pipelineOn(target, { created_by_user_id: creatorId });
    const rule = await ruleIn(pipeline, { created_by_user_id: creatorId });
    return { pipeline, rule };
  };

  /** The ids `context` can select from both tables, with no filter of our own. */
  const selectable = (context: Context) =>
    inContext(context, async (transaction) => {
      const ids = async (table: string) =>
        (await sql<{ id: string }>`select id from ${sql.table(table)}`.execute(transaction)).rows.map((row) => row.id).sort();
      return { pipelines: await ids("validation_pipelines"), rules: await ids("validation_rules") };
    });

  const refusedBy = (constraint: string, code = "23514") => ({ code, constraint });

  describe("constraints, as the owner", () => {
    it("refuses a pipeline's name empty or over 200 characters, a signal off the list or not its name's first part, and a second validation pipeline for one version's pipeline (23505); takes the limits", async () => {
      const w = await world();
      // An empty name names no signal either; either check answers.
      await expect(pipelineOn(w.published, { pipeline_name: "" })).rejects.toMatchObject({
        code: "23514",
        constraint: expect.stringMatching(/^ck_validation_pipelines_(pipeline_name_length|pipeline_signal)$/),
      });
      await expect(pipelineOn(w.published, { pipeline_name: `logs/${"x".repeat(196)}` })).rejects.toMatchObject(
        refusedBy("ck_validation_pipelines_pipeline_name_length"),
      );
      await expect(pipelineOn(w.published, { pipeline_name: "profiles", signal: "profiles" })).rejects.toMatchObject(
        refusedBy("ck_validation_pipelines_signal"),
      );
      for (const [pipeline_name, signal] of [
        ["traces", "logs"],
        ["logs/default", "traces"],
        ["logsx", "logs"],
      ] as const) {
        await expect(pipelineOn(w.published, { pipeline_name, signal }), pipeline_name).rejects.toMatchObject(
          refusedBy("ck_validation_pipelines_pipeline_signal"),
        );
      }
      const taken = await pipelineOn(w.published, { pipeline_name: `logs/${"x".repeat(195)}` });
      expect(taken.pipeline_name).toHaveLength(200);
      expect(taken.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      await pipelineOn(w.published, { pipeline_name: "logs/default" });
      await pipelineOn(w.published, { pipeline_name: "traces/2", signal: "traces" });
      await expect(pipelineOn(w.published, { pipeline_name: "logs/default" })).rejects.toMatchObject(
        refusedBy("uq_validation_pipelines_version_pipeline_name", "23505"),
      );
      // The same pipeline on another version is another validation pipeline.
      expect((await pipelineOn(w.published, { pipeline_name: "logs/default" }, w.published.v2)).pipeline_name).toBe(
        "logs/default",
      );
    });

    it("refuses a kind outside the five (a retired one included) and a target outside output and stderr, and an OTTL rule on stderr (ck_validation_rules_ottl_output_only)", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published);
      for (const kind of ["json_path", "contains", "OTTL", "regex"]) {
        await expect(ruleIn(pipeline, { kind: kind as never }), kind).rejects.toMatchObject(
          refusedBy("ck_validation_rules_kind"),
        );
      }
      await expect(ruleIn(pipeline, { target: "stdout" as never })).rejects.toMatchObject(
        refusedBy("ck_validation_rules_target"),
      );
      await expect(ruleIn(pipeline, ottl({ target: "stderr" }))).rejects.toMatchObject(
        refusedBy("ck_validation_rules_ottl_output_only"),
      );
      let position = 1;
      for (const kind of ["contains_text", "not_contains_text", "contains_regex", "not_contains_regex"] as const) {
        for (const target of ["output", "stderr"] as const) {
          expect(await ruleIn(pipeline, { kind, target, position: position++ }), `${kind} on ${target}`).toMatchObject({
            kind,
            target,
          });
        }
      }
      expect(await ruleIn(pipeline, { ...ottl(), position })).toMatchObject({ kind: "ottl", target: "output", pattern: null });
    });

    it("gives a text or regex rule a pattern and no OTTL column, and an OTTL rule its context and quantifier and no pattern", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published);
      await expect(ruleIn(pipeline, { pattern: null })).rejects.toMatchObject(
        refusedBy("ck_validation_rules_pattern_only_text_and_regex"),
      );
      await expect(ruleIn(pipeline, ottl({ pattern: "x" }))).rejects.toMatchObject(
        refusedBy("ck_validation_rules_pattern_only_text_and_regex"),
      );
      for (const column of [
        { ottl_context: "log" },
        { ottl_condition: "true" },
        { ottl_quantifier: "all" },
        { ottl_count_operator: "eq", ottl_count_value: 1 },
        { ottl_expression: "body" },
      ]) {
        await expect(ruleIn(pipeline, { kind: "contains_regex", ...column } as never), Object.keys(column)[0]).rejects.toMatchObject(
          refusedBy("ck_validation_rules_ottl_only_ottl"),
        );
      }
      await expect(ruleIn(pipeline, ottl({ ottl_context: null }))).rejects.toMatchObject(
        refusedBy("ck_validation_rules_ottl_only_ottl"),
      );
      await expect(ruleIn(pipeline, ottl({ ottl_quantifier: null, ottl_condition: null }))).rejects.toMatchObject(
        refusedBy("ck_validation_rules_ottl_only_ottl"),
      );
    });

    it("counts a pattern's, a condition's and an expression's 8,192 in bytes, not characters: 8,192 'é' (16,384 bytes) are refused, 4,096 (8,192 bytes) taken; and refuses a blank one", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published);
      let position = 1;
      const rule = (overrides: Record<string, unknown>) => ruleIn(pipeline, { position: position++, ...overrides });
      const twoByte = (count: number) => "é".repeat(count);
      expect(Buffer.byteLength(twoByte(8192))).toBe(16_384);
      // The pattern.
      expect((await rule({ pattern: "x".repeat(8192) })).pattern).toHaveLength(8192);
      expect((await rule({ pattern: twoByte(4096) })).pattern).toHaveLength(4096);
      for (const pattern of ["x".repeat(8193), twoByte(8192), `${twoByte(4096)}x`]) {
        await expect(rule({ pattern }), `${pattern.length} characters`).rejects.toMatchObject(
          refusedBy("ck_validation_rules_pattern_length"),
        );
      }
      for (const pattern of ["", " ", " \t\n\r\f\v "]) {
        await expect(rule({ pattern }), JSON.stringify(pattern)).rejects.toMatchObject(
          refusedBy("ck_validation_rules_pattern_length"),
        );
      }
      // The condition.
      const condition = (text: string) => `body == "${text}"`;
      const padded = (bytes: number) => condition("x".repeat(bytes - condition("").length));
      expect(Buffer.byteLength(padded(8192))).toBe(8192);
      expect((await rule(ottl({ ottl_condition: padded(8192) }))).ottl_condition).toHaveLength(8192);
      for (const ottl_condition of [padded(8193), condition(twoByte(4096)), " ", ""]) {
        await expect(rule(ottl({ ottl_condition })), `${ottl_condition.length} characters`).rejects.toMatchObject(
          refusedBy("ck_validation_rules_ottl_condition_length"),
        );
      }
      // The expression (distinct's).
      const distinct = (ottl_expression: string) =>
        ottl({ ottl_quantifier: "distinct", ottl_condition: null, ottl_expression, ottl_count_operator: "gte", ottl_count_value: 1 });
      expect((await rule(distinct(`attributes["${"k".repeat(8192 - 14)}"]`))).ottl_expression).toHaveLength(8192);
      for (const ottl_expression of [`attributes["${"k".repeat(8193 - 14)}"]`, `attributes["${twoByte(4096)}"]`, "\t"]) {
        await expect(rule(distinct(ottl_expression)), `${ottl_expression.length} characters`).rejects.toMatchObject(
          refusedBy("ck_validation_rules_ottl_expression_length"),
        );
      }
    });

    it("refuses an OTTL context outside the seven names, and takes each of them (the signal's are the API's check)", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published);
      for (const ottl_context of ["logs", "Log", "datapoints", "instrumentation_scope"]) {
        await expect(ruleIn(pipeline, ottl({ ottl_context })), ottl_context).rejects.toMatchObject(
          refusedBy("ck_validation_rules_ottl_context"),
        );
      }
      let position = 1;
      for (const ottl_context of ["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"]) {
        // A logs pipeline with a span context: the database takes it; the API refuses it (Preflight ruling 16).
        expect((await ruleIn(pipeline, { ...ottl({ ottl_context }), position: position++ } as never)).ottl_context).toBe(
          ottl_context,
        );
      }
    });

    it("refuses a quantifier outside the five, and each quantifier's wrong shape: all, any and none with a count or an expression or no condition, count without its operator, distinct without its expression (ck_validation_rules_ottl_shape)", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published);
      await expect(ruleIn(pipeline, ottl({ ottl_quantifier: "every" }))).rejects.toMatchObject(
        refusedBy("ck_validation_rules_ottl_quantifier"),
      );
      for (const shape of [
        { ottl_quantifier: "all", ottl_count_operator: "eq", ottl_count_value: 1 },
        { ottl_quantifier: "any", ottl_expression: "body" },
        { ottl_quantifier: "none", ottl_condition: null },
        { ottl_quantifier: "count" },
        { ottl_quantifier: "count", ottl_condition: null, ottl_count_operator: "eq", ottl_count_value: 1 },
        { ottl_quantifier: "count", ottl_count_operator: "eq", ottl_count_value: 1, ottl_expression: "body" },
        { ottl_quantifier: "distinct", ottl_count_operator: "eq", ottl_count_value: 1 },
        { ottl_quantifier: "distinct", ottl_expression: "body" },
      ]) {
        await expect(ruleIn(pipeline, ottl(shape)), JSON.stringify(shape)).rejects.toMatchObject(
          refusedBy("ck_validation_rules_ottl_shape"),
        );
      }
      let position = 1;
      for (const shape of [
        { ottl_quantifier: "all" },
        { ottl_quantifier: "any" },
        { ottl_quantifier: "none" },
        { ottl_quantifier: "count", ottl_count_operator: "gt", ottl_count_value: 3 },
        { ottl_quantifier: "distinct", ottl_condition: null, ottl_expression: "body", ottl_count_operator: "eq", ottl_count_value: 2 },
        { ottl_quantifier: "distinct", ottl_expression: "body", ottl_count_operator: "eq", ottl_count_value: 2 },
      ]) {
        expect(await ruleIn(pipeline, { ...ottl(shape), position: position++ } as never), JSON.stringify(shape)).toMatchObject(shape);
      }
    });

    it("refuses a negative count, an unordered between, a second value off between, an unknown operator and a value without one (ck_validation_rules_ottl_count); takes between's equal bounds and 0", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published);
      const count = (values: Record<string, unknown>) => ottl({ ottl_quantifier: "count", ...values });
      for (const values of [
        { ottl_count_operator: "gte", ottl_count_value: -1 },
        { ottl_count_operator: "between", ottl_count_value: -1, ottl_count_value2: 3 },
        { ottl_count_operator: "between", ottl_count_value: 5, ottl_count_value2: 4 },
        { ottl_count_operator: "between", ottl_count_value: 5 },
        { ottl_count_operator: "between", ottl_count_value2: 5 },
        { ottl_count_operator: "eq", ottl_count_value: 1, ottl_count_value2: 2 },
        { ottl_count_operator: "eq" },
        { ottl_count_operator: "approx", ottl_count_value: 1 },
      ]) {
        await expect(ruleIn(pipeline, count(values)), JSON.stringify(values)).rejects.toMatchObject(
          refusedBy("ck_validation_rules_ottl_count"),
        );
      }
      // A value without an operator: the shape and the count both refuse it.
      await expect(ruleIn(pipeline, ottl({ ottl_count_value: 1 }))).rejects.toMatchObject({
        code: "23514",
        constraint: expect.stringMatching(/^ck_validation_rules_ottl_(count|shape)$/),
      });
      let position = 1;
      for (const values of [
        { ottl_count_operator: "between", ottl_count_value: 4, ottl_count_value2: 4 },
        { ottl_count_operator: "eq", ottl_count_value: 0 },
        { ottl_count_operator: "lt", ottl_count_value: 2_147_483_647 },
      ]) {
        expect(await ruleIn(pipeline, { ...count(values), position: position++ } as never)).toMatchObject(values);
      }
    });

    it("refuses a name untrimmed or over 200 characters, a description over 2,000, a position below 1 and a taken position (23505); takes the limits and defaults both to ''", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published);
      await expect(ruleIn(pipeline, { name: " SSN" })).rejects.toMatchObject(refusedBy("ck_validation_rules_name_trimmed"));
      await expect(ruleIn(pipeline, { name: "x".repeat(201) })).rejects.toMatchObject(
        refusedBy("ck_validation_rules_name_length"),
      );
      await expect(ruleIn(pipeline, { description: "x".repeat(2001) })).rejects.toMatchObject(
        refusedBy("ck_validation_rules_description_length"),
      );
      for (const position of [0, -1]) {
        await expect(ruleIn(pipeline, { position }), String(position)).rejects.toMatchObject(
          refusedBy("ck_validation_rules_position"),
        );
      }
      const first = await ruleIn(pipeline);
      expect(first).toMatchObject({ position: 1, name: "", description: "" });
      await expect(ruleIn(pipeline, { position: 1 })).rejects.toMatchObject(
        refusedBy("uq_validation_rules_pipeline_position", "23505"),
      );
      expect(await ruleIn(pipeline, { position: 3, name: "x".repeat(200), description: "y".repeat(2000) })).toMatchObject({
        position: 3,
      });
      // Another pipeline has its own places.
      expect((await ruleIn(await pipelineOn(w.published, { pipeline_name: "logs/2" }))).position).toBe(1);
    });

    it("refuses a rule naming a validation pipeline of another version, configuration or organization (23503, fk_validation_rules_validation_pipeline), and a validation pipeline naming another configuration's version", async () => {
      const w = await world();
      const inV1 = await pipelineOn(w.published);
      const ofDraft = await pipelineOn(w.draft);
      const ofB = await pipelineOn(w.inB);
      for (const [label, pipeline] of [
        ["v1's pipeline as v2's", { ...inV1, configuration_version_id: w.published.v2 }],
        ["the draft's pipeline as the published one's", { ...ofDraft, configuration_id: w.published.configurationId, configuration_version_id: w.published.v1 }],
        ["B's pipeline as A's", { ...ofB, organization_id: w.a, configuration_id: w.published.configurationId, configuration_version_id: w.published.v1 }],
      ] as const) {
        await expect(ruleIn(pipeline), label).rejects.toMatchObject(
          refusedBy("fk_validation_rules_validation_pipeline", "23503"),
        );
      }
      await expect(
        pipelineOn({ ...w.published, configurationId: w.draft.configurationId }, { pipeline_name: "logs/elsewhere" }, w.published.v1),
      ).rejects.toMatchObject(refusedBy("fk_validation_pipelines_configuration_version", "23503"));
      expect(await ownerDb.selectFrom("validation_rules").select("id").execute()).toEqual([]);
    });

    it("takes a validation pipeline's rules with it; lets an operator hard-delete a configuration or an organization, theirs going with it and others' staying; keeps a hard-deleted account's with no creator", async () => {
      const w = await world();
      const gone = await tree(w.published, w.ana);
      const other = await ruleIn(await pipelineOn(w.published, { pipeline_name: "logs/2" }));
      await ownerDb.deleteFrom("validation_pipelines").where("id", "=", gone.pipeline.id).execute();
      expect((await ownerDb.selectFrom("validation_rules").select("id").execute()).map((row) => row.id)).toEqual([other.id]);

      const ofDraft = await tree(w.draft, w.ana);
      const inB = await tree(w.inB, w.cara);
      const ofBen = await tree({ ...w.published }, w.ben);
      await ownerDb.deleteFrom("configurations").where("id", "=", w.draft.configurationId).execute();
      const remaining = async () => ({
        pipelines: (await ownerDb.selectFrom("validation_pipelines").select("id").orderBy("id").execute()).map((row) => row.id),
        rules: (await ownerDb.selectFrom("validation_rules").select("id").orderBy("id").execute()).map((row) => row.id),
      });
      expect((await remaining()).pipelines).not.toContain(ofDraft.pipeline.id);
      expect((await remaining()).rules).not.toContain(ofDraft.rule.id);

      await ownerDb.deleteFrom("users").where("id", "=", w.ben).execute();
      expect(
        await ownerDb.selectFrom("validation_pipelines").selectAll().where("id", "=", ofBen.pipeline.id).executeTakeFirst(),
      ).toEqual({ ...ofBen.pipeline, created_by_user_id: null });
      expect(await ownerDb.selectFrom("validation_rules").selectAll().where("id", "=", ofBen.rule.id).executeTakeFirst()).toEqual({
        ...ofBen.rule,
        created_by_user_id: null,
      });

      await ownerDb.deleteFrom("organizations").where("id", "=", w.a).execute();
      expect(await remaining()).toEqual({ pipelines: [inB.pipeline.id], rules: [inB.rule.id] });
    });
  });

  describe("the rules' identity trigger, for every role (here the owner, past row-level security)", () => {
    it("keeps a rule's id, organization, configuration, version, validation pipeline, position and created_at, and its creator but to null (P0001, naming only the rule); lets its kind, target, pattern, OTTL, name, description and updated_at change", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published, { created_by_user_id: w.ana });
      const sibling = await pipelineOn(w.published, { pipeline_name: "logs/2", created_by_user_id: w.ana });
      const rule = await ruleIn(pipeline, { created_by_user_id: w.ana, name: "SSN", pattern: "\\d{3}" });
      const change = (values: Record<string, unknown>) =>
        ownerDb
          .updateTable("validation_rules")
          .set(values as never)
          .where("id", "=", rule.id)
          .execute();
      const changes: Record<string, unknown> = {
        id: randomUUID(),
        organization_id: w.b,
        configuration_id: w.draft.configurationId,
        configuration_version_id: w.published.v2,
        validation_pipeline_id: sibling.id,
        position: 2,
        created_at: new Date(Date.UTC(2020, 0, 1)),
        created_by_user_id: w.ben,
      };
      for (const [column, value] of Object.entries(changes)) {
        await expect(change({ [column]: value }), column).rejects.toMatchObject({
          code: "P0001",
          message: `validation rule ${rule.id} keeps its pipeline, its place and its creator`,
        });
      }
      // The editor switches the rule to the OTTL mode, then names and describes it.
      const at = new Date(rule.created_at.getTime() + 1000);
      await change({ ...ottl(), name: "Prod only", description: "Every record is prod", updated_at: at, created_by_user_id: w.ana });
      await change({ created_by_user_id: null });
      expect(await ownerDb.selectFrom("validation_rules").selectAll().where("id", "=", rule.id).executeTakeFirst()).toEqual({
        ...rule,
        ...ottl(),
        name: "Prod only",
        description: "Every record is prod",
        updated_at: at,
        created_by_user_id: null,
      });
    });
  });

  describe("row-level security, as the application role", () => {
    it("shows a draft's validation pipelines and rules to its author only: not a teammate, not another organization, not a context naming another organization or none", async () => {
      const w = await world();
      const draft = await tree(w.draft, w.ana);
      const ids = { pipelines: [draft.pipeline.id], rules: [draft.rule.id] };
      const none = { pipelines: [], rules: [] };
      expect(await selectable({ userId: w.ana, organizationId: w.a })).toEqual(ids);
      expect(await selectable({ userId: w.ben, organizationId: w.a })).toEqual(none);
      expect(await selectable({ userId: w.cara, organizationId: w.b })).toEqual(none);
      expect(await selectable({ userId: w.ana, organizationId: w.b })).toEqual(none);
      expect(await selectable({ userId: w.ana })).toEqual(none);
    });

    it("shows a published configuration's validation pipelines and rules, on any of its versions, to every member, the draft's once published, and to no one in another organization", async () => {
      const w = await world();
      const onV1 = await tree(w.published, w.ana);
      const onV2 = await ruleIn(await pipelineOn(w.published, { created_by_user_id: w.ana }, w.published.v2));
      const draft = await tree(w.draft, w.ana);
      const expected = {
        pipelines: [onV1.pipeline.id, onV2.validation_pipeline_id].sort(),
        rules: [onV1.rule.id, onV2.id].sort(),
      };
      expect(await selectable({ userId: w.ana, organizationId: w.a })).toEqual({
        pipelines: [...expected.pipelines, draft.pipeline.id].sort(),
        rules: [...expected.rules, draft.rule.id].sort(),
      });
      expect(await selectable({ userId: w.ben, organizationId: w.a })).toEqual(expected);
      expect(await selectable({ userId: w.cara, organizationId: w.b })).toEqual({ pipelines: [], rules: [] });

      await ownerDb
        .updateTable("configuration_versions")
        .set({ published_at: new Date(), publication_id: randomUUID(), published_by_user_id: w.ana })
        .where("id", "=", w.draft.v1)
        .execute();
      expect(await selectable({ userId: w.ben, organizationId: w.a })).toEqual({
        pipelines: [...expected.pipelines, draft.pipeline.id].sort(),
        rules: [...expected.rules, draft.rule.id].sort(),
      });
    });

    it("lets every member add and delete validation pipelines, and add, change and delete rules, on a published configuration's versions, published or not, as themselves; changes no validation pipeline (using (false))", async () => {
      const w = await world();
      const ben = { userId: w.ben, organizationId: w.a };
      for (const versionId of [w.published.v1, w.published.v2]) {
        const at = new Date();
        const { pipeline, rule } = await inContext(ben, async (transaction) => {
          const pipeline = await transaction
            .insertInto("validation_pipelines")
            .values({
              organization_id: w.a,
              configuration_id: w.published.configurationId,
              configuration_version_id: versionId,
              pipeline_name: "logs/default",
              signal: "logs",
              created_by_user_id: w.ben,
              created_at: at,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const rule = await transaction
            .insertInto("validation_rules")
            .values({
              organization_id: w.a,
              configuration_id: w.published.configurationId,
              configuration_version_id: versionId,
              validation_pipeline_id: pipeline.id,
              position: 1,
              kind: "not_contains_regex",
              target: "output",
              pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
              created_by_user_id: w.ben,
              created_at: at,
              updated_at: at,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return { pipeline, rule };
        });
        const changed = await inContext({ userId: w.ana, organizationId: w.a }, async (transaction) => ({
          rule: (
            await transaction
              .updateTable("validation_rules")
              .set({ ...ottl(), name: "Changed by Ana", updated_at: new Date(at.getTime() + 1) })
              .where("id", "=", rule.id)
              .executeTakeFirstOrThrow()
          ).numUpdatedRows,
          pipeline: (
            await sql`update validation_pipelines set pipeline_name = 'logs/renamed' where id = ${pipeline.id}`.execute(
              transaction,
            )
          ).numAffectedRows,
          // A locking read takes the update policy too: it locks no validation pipeline.
          locked: (await sql`select id from validation_pipelines where id = ${pipeline.id} for update`.execute(transaction)).rows,
        }));
        expect(changed).toEqual({ rule: 1n, pipeline: 0n, locked: [] });
        const deleted = await inContext(ben, async (transaction) => ({
          rules: (await transaction.deleteFrom("validation_rules").where("id", "=", rule.id).executeTakeFirstOrThrow())
            .numDeletedRows,
          pipelines: (
            await transaction.deleteFrom("validation_pipelines").where("id", "=", pipeline.id).executeTakeFirstOrThrow()
          ).numDeletedRows,
        }));
        expect(deleted).toEqual({ rules: 1n, pipelines: 1n });
      }
    });

    it("refuses a validation pipeline or a rule whose creator isn't the context's user (42501), on a configuration the member can see; nor can a rule's creator be changed afterwards", async () => {
      const w = await world();
      const { pipeline, rule } = await tree(w.published, w.ana);
      const ben = { userId: w.ben, organizationId: w.a };
      const at = new Date();
      for (const forged of [w.ana, null]) {
        await expect(
          inContext(ben, (transaction) =>
            transaction
              .insertInto("validation_pipelines")
              .values({
                organization_id: w.a,
                configuration_id: w.published.configurationId,
                configuration_version_id: w.published.v1,
                pipeline_name: "logs/forged",
                signal: "logs",
                created_by_user_id: forged as string,
                created_at: at,
              })
              .execute(),
          ),
          `pipeline as ${String(forged)}`,
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          inContext(ben, (transaction) =>
            transaction
              .insertInto("validation_rules")
              .values({
                organization_id: w.a,
                configuration_id: w.published.configurationId,
                configuration_version_id: w.published.v1,
                validation_pipeline_id: pipeline.id,
                position: 2,
                kind: "contains_text",
                target: "output",
                pattern: "forged",
                created_by_user_id: forged as string,
                created_at: at,
                updated_at: at,
              })
              .execute(),
          ),
          `rule as ${String(forged)}`,
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        inContext(ben, (transaction) =>
          transaction
            .updateTable("validation_rules")
            .set({ created_by_user_id: w.ben } as never)
            .where("id", "=", rule.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(await ownerDb.selectFrom("validation_rules").selectAll().execute()).toEqual([rule]);
      expect(await ownerDb.selectFrom("validation_pipelines").selectAll().execute()).toEqual([pipeline]);
    });

    /*
     * A policy that checked the author only would let any member who knew a
     * pipeline's id insert a rule into it. Here each attempt
     * names the pipeline's own organization, configuration and version
     * (Preflight ruling 18): the composite key then lets it through, so only
     * the insert policy stands in the way.
     */
    it("refuses a rule forged into another organization's validation pipeline, or another member's draft's, naming that pipeline's own organization, configuration and version (42501)", async () => {
      const w = await world();
      const ofB = await tree(w.inB, w.cara);
      const ofDraft = await tree(w.draft, w.ana);
      const at = new Date();
      const forge = (context: Context, pipeline: typeof ofB.pipeline, userId: string) =>
        inContext(context, (transaction) =>
          transaction
            .insertInto("validation_rules")
            .values({
              organization_id: pipeline.organization_id,
              configuration_id: pipeline.configuration_id,
              configuration_version_id: pipeline.configuration_version_id,
              validation_pipeline_id: pipeline.id,
              position: 2,
              kind: "contains_text",
              target: "output",
              pattern: "forged",
              created_by_user_id: userId,
              created_at: at,
              updated_at: at,
            })
            .execute(),
        );
      await expect(forge({ userId: w.ben, organizationId: w.a }, ofB.pipeline, w.ben), "Ben in A, into B's").rejects.toMatchObject({
        code: "42501",
      });
      await expect(forge({ userId: w.ben, organizationId: w.a }, ofDraft.pipeline, w.ben), "Ben, into Ana's draft's").rejects.toMatchObject({
        code: "42501",
      });
      await expect(forge({ userId: w.cara, organizationId: w.b }, ofDraft.pipeline, w.cara), "Cara in B, into A's draft's").rejects.toMatchObject({
        code: "42501",
      });
      expect((await ownerDb.selectFrom("validation_rules").select("id").orderBy("id").execute()).map((row) => row.id)).toEqual(
        [ofB.rule.id, ofDraft.rule.id].sort(),
      );
    });

    it("refuses moving a rule to a validation pipeline of another version or organization: the identity trigger (P0001) before any policy", async () => {
      const w = await world();
      const { rule } = await tree(w.published, w.ana);
      const onV2 = await pipelineOn(w.published, { created_by_user_id: w.ana }, w.published.v2);
      const ofB = await pipelineOn(w.inB, { created_by_user_id: w.cara });
      const ana = { userId: w.ana, organizationId: w.a };
      for (const [label, values] of [
        ["to v2's", { validation_pipeline_id: onV2.id, configuration_version_id: w.published.v2 }],
        [
          "to B's",
          {
            validation_pipeline_id: ofB.id,
            organization_id: w.b,
            configuration_id: w.inB.configurationId,
            configuration_version_id: w.inB.v1,
          },
        ],
      ] as const) {
        await expect(
          inContext(ana, (transaction) =>
            transaction
              .updateTable("validation_rules")
              .set(values as never)
              .where("id", "=", rule.id)
              .execute(),
          ),
          label,
        ).rejects.toMatchObject({ code: "P0001" });
      }
      expect(await ownerDb.selectFrom("validation_rules").selectAll().execute()).toEqual([rule]);
    });

    it("refuses adding a validation pipeline to another member's draft or naming another organization (42501), and changes or deletes none of a draft's rows, by id or by a bare statement with no WHERE clause", async () => {
      const w = await world();
      const draft = await tree(w.draft, w.ana);
      const at = new Date();
      const addPipeline = (context: Context, target: Target, userId: string) =>
        inContext(context, (transaction) =>
          transaction
            .insertInto("validation_pipelines")
            .values({
              organization_id: target.organizationId,
              configuration_id: target.configurationId,
              configuration_version_id: target.v1,
              pipeline_name: "logs/slipped",
              signal: "logs",
              created_by_user_id: userId,
              created_at: at,
            })
            .execute(),
        );
      await expect(addPipeline({ userId: w.ben, organizationId: w.a }, w.draft, w.ben)).rejects.toMatchObject({ code: "42501" });
      await expect(addPipeline({ userId: w.cara, organizationId: w.b }, w.published, w.cara)).rejects.toMatchObject({
        code: "42501",
      });
      const ben = { userId: w.ben, organizationId: w.a };
      const byId = await inContext(ben, async (transaction) => ({
        renamed: await sql`update validation_rules set name = 'Taken' where id = ${draft.rule.id}`.execute(transaction),
        rules: await sql`delete from validation_rules where id = ${draft.rule.id}`.execute(transaction),
        pipelines: await sql`delete from validation_pipelines where id = ${draft.pipeline.id}`.execute(transaction),
      }));
      for (const result of Object.values(byId)) expect(result.numAffectedRows).toBe(0n);
      /*
       * A statement with no WHERE clause and no RETURNING reads no column, so
       * Postgres applies only its command's policy, not the select policy
       * (D14b Ruling 29): these reach the draft through the update and
       * delete policies alone.
       */
      for (const [label, statement] of [
        ["update validation_rules", sql`update validation_rules set name = 'x'`],
        ["delete from validation_rules", sql`delete from validation_rules`],
        ["delete from validation_pipelines", sql`delete from validation_pipelines`],
      ] as const) {
        await inContext(ben, async (transaction) => {
          expect((await statement.execute(transaction)).numAffectedRows, label).toBe(0n);
        });
      }
      expect(await ownerDb.selectFrom("validation_rules").selectAll().execute()).toEqual([draft.rule]);
      expect(await ownerDb.selectFrom("validation_pipelines").selectAll().execute()).toEqual([draft.pipeline]);
    });
  });

  describe("the runs' status, snapshot and results", () => {
    /** A run on `target`'s v1, queued by `userId`, as the owner. */
    const queue = (
      target: Target,
      userId: string,
      overrides: Partial<Omit<AddTestRunInput, "organizationId" | "configurationId" | "configurationVersionId">> = {},
    ) =>
      addTestRun(ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v1,
        queuedByUserId: userId,
        ...overrides,
      });
    /** A finished run's times, queued, started and finished in order in the past. */
    const finished = {
      queued_at: new Date("2026-01-01T10:00:00.000Z"),
      started_at: new Date("2026-01-01T10:00:01.000Z"),
      finished_at: new Date("2026-01-01T10:00:02.000Z"),
    };
    const passed = JSON.stringify([{ id: "r1", passed: true }, { id: "r2", passed: true }]);
    const oneFailed = JSON.stringify([{ id: "r1", passed: true }, { id: "r2", passed: false }]);
    const twoRules = () => JSON.stringify([snapshotRule("one"), snapshotRule("two")]);

    it("stores a queued run with no rules ('[]'), no validation pipeline and no results by default, and with the snapshot it's given", async () => {
      const w = await world();
      expect(await queue(w.published, w.ana)).toMatchObject({
        validation_pipeline_id: null,
        validation_rules: [],
        validation_results: null,
      });
      const pipelineId = randomUUID();
      const rules = [snapshotRule("one"), snapshotRule("two")];
      expect(
        await queue(w.published, w.ana, { validation_pipeline_id: pipelineId, validation_rules: JSON.stringify(rules) }),
      ).toMatchObject({ validation_pipeline_id: pipelineId, validation_rules: rules, validation_results: null });
    });

    it("refuses a rules' snapshot that isn't an array, holds over 200 or holds a rule that isn't an object with a string id (ck_test_runs_validation_rules), results that aren't an array or not one per rule (ck_test_runs_validation_results), and results on a run not finished", async () => {
      const w = await world();
      for (const validation_rules of ['{"rules": []}', "null", JSON.stringify(Array.from({ length: 201 }, () => snapshotRule()))]) {
        await expect(queue(w.published, w.ana, { validation_rules }), validation_rules.slice(0, 20)).rejects.toMatchObject({
          code: expect.stringMatching(/^(23514|23502)$/),
        });
      }
      expect(
        (await queue(w.published, w.ana, { validation_rules: JSON.stringify(Array.from({ length: 200 }, () => snapshotRule())) }))
          .validation_rules,
      ).toHaveLength(200);
      // Each rule an object with a string id (Ruling 32), which its result names.
      for (const [label, element] of [
        ["a string", "contains_text"],
        ["null", null],
        ["an array", [snapshotRule()]],
        ["no id", { kind: "contains_text", target: "output", pattern: "x" }],
        ["a number id", { ...snapshotRule(), id: 7 }],
        ["an id in an array", { ...snapshotRule(), id: [randomUUID()] }],
      ] as const) {
        await expect(
          queue(w.published, w.ana, { validation_rules: JSON.stringify([snapshotRule(), element]) }),
          label,
        ).rejects.toMatchObject(refusedBy("ck_test_runs_validation_rules"));
      }
      for (const validation_results of ['{"passed": false}', JSON.stringify([{ passed: false }])]) {
        await expect(
          queue(w.published, w.ana, {
            validation_rules: twoRules(),
            state: { status: "failed", ...finished, validation_results },
          }),
          validation_results,
        ).rejects.toMatchObject(refusedBy("ck_test_runs_validation_results"));
      }
      for (const status of ["queued", "running"] as const) {
        await expect(
          queue(w.published, w.ana, {
            validation_rules: twoRules(),
            state: {
              status,
              ...(status === "running"
                ? { started_at: finished.started_at, lease_id: randomUUID(), lease_expires_at: new Date(Date.now() + 60_000) }
                : {}),
              validation_results: passed,
            },
          }),
          status,
        ).rejects.toMatchObject(refusedBy("ck_test_runs_results_only_when_finished"));
      }
    });

    it("ties the status to the rules' results (ck_test_runs_validation_outcome): validation_failed needs no error code and a failed result; succeeded needs no rules and no results, or results none of which failed; failed takes either", async () => {
      const w = await world();
      const run = (status: "succeeded" | "failed" | "validation_failed", extra: Record<string, unknown>) =>
        queue(w.published, w.ana, {
          validation_rules: (extra.validation_rules as string | undefined) ?? twoRules(),
          state: { status, ...finished, ...(extra as object) },
        });
      for (const [label, status, extra] of [
        ["validation_failed with an error code", "validation_failed", { validation_results: oneFailed, error_code: "rules_unavailable" }],
        ["validation_failed without results", "validation_failed", {}],
        ["validation_failed with every rule passed", "validation_failed", { validation_results: passed }],
        ["validation_failed with no rules", "validation_failed", { validation_rules: "[]", validation_results: "[]" }],
        ["succeeded with rules unchecked", "succeeded", {}],
        ["succeeded with a failed rule", "succeeded", { validation_results: oneFailed }],
      ] as const) {
        await expect(run(status, extra), label).rejects.toMatchObject(refusedBy("ck_test_runs_validation_outcome"));
      }
      for (const [label, status, extra] of [
        ["validation_failed with a failed rule", "validation_failed", { validation_results: oneFailed }],
        ["succeeded with every rule passed", "succeeded", { validation_results: passed }],
        ["succeeded with no rules", "succeeded", { validation_rules: "[]" }],
        ["failed with rules unchecked (an outage)", "failed", { error_code: "rules_unavailable" }],
        ["failed with results", "failed", { validation_results: oneFailed }],
      ] as const) {
        expect(await run(status, extra), label).toMatchObject({ status });
      }
    });

    it("keeps a run's rules' snapshot (P0001, test_runs_guard): its validation pipeline and its rules never change, not even when it finishes", async () => {
      const w = await world();
      const rules = twoRules();
      const run = await queue(w.published, w.ana, { validation_pipeline_id: randomUUID(), validation_rules: rules });
      for (const [column, value] of Object.entries({
        validation_pipeline_id: randomUUID(),
        validation_rules: JSON.stringify([snapshotRule("other")]),
      })) {
        await expect(
          ownerDb
            .updateTable("test_runs")
            .set({ [column]: value } as never)
            .where("id", "=", run.id)
            .execute(),
          column,
        ).rejects.toMatchObject({ code: "P0001", message: `test run ${run.id} keeps its snapshot` });
      }
      await expect(
        ownerDb
          .updateTable("test_runs")
          .set({ validation_pipeline_id: null, validation_rules: "[]" } as never)
          .where("id", "=", run.id)
          .execute(),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        ownerDb
          .updateTable("test_runs")
          .set({ status: "validation_failed", ...finished, validation_rules: "[]", validation_results: "[]" } as never)
          .where("id", "=", run.id)
          .execute(),
      ).rejects.toMatchObject({ code: "P0001", message: `test run ${run.id} keeps its snapshot` });
      expect(await ownerDb.selectFrom("test_runs").selectAll().where("id", "=", run.id).executeTakeFirst()).toEqual(run);
    });

    it("refuses a finished run's results changing, a validation_failed run's included", async () => {
      const w = await world();
      const run = await queue(w.published, w.ana, {
        validation_rules: twoRules(),
        state: { status: "validation_failed", ...finished, validation_results: oneFailed },
      });
      await expect(
        ownerDb
          .updateTable("test_runs")
          .set({ validation_results: passed } as never)
          .where("id", "=", run.id)
          .execute(),
      ).rejects.toMatchObject({ code: "P0001", message: `test run ${run.id} changes only with its status` });
    });
  });

  describe("the dispatcher's functions", () => {
    /** A run on `target`'s v1 with `rules`, claimed by the dispatcher: its id and lease. */
    const claimed = async (target: Target, userId: string, rules: unknown[]) => {
      const run = await addTestRun(ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v1,
        queuedByUserId: userId,
        validation_pipeline_id: rules.length === 0 ? null : randomUUID(),
        validation_rules: JSON.stringify(rules),
        state: { queued_at: new Date(Date.now() - 60_000) },
      });
      const { rows } = await asDispatcher((transaction) =>
        sql<{ run_id: string; lease_id: string }>`select run_id, lease_id from test_runs_claim(10, 30)`.execute(transaction),
      );
      expect(rows.map((row) => row.run_id)).toEqual([run.id]);
      return { id: run.id, leaseId: rows[0]!.lease_id };
    };
    const finish = async (runId: string, leaseId: string, status: string | null, results: Record<string, unknown> = {}) =>
      (
        await asDispatcher((transaction) =>
          sql<{ done: boolean }>`
            select test_runs_finish(${runId}::uuid, ${leaseId}::uuid, ${status}::text, ${JSON.stringify(results)}::jsonb) as done
          `.execute(transaction),
        )
      ).rows[0]!.done;
    const rulesOf = async (runId: string, leaseId: string) =>
      (
        await asDispatcher((transaction) =>
          sql<{ rules: unknown[] | null }>`select test_runs_rules(${runId}::uuid, ${leaseId}::uuid) as rules`.execute(
            transaction,
          ),
        )
      ).rows[0]!.rules;
    const mark = async (up: boolean | null) =>
      (
        await asDispatcher((transaction) =>
          sql<{ since: Date | null }>`select ottl_evaluator_mark(${up}::boolean) as since`.execute(transaction),
        )
      ).rows[0]!.since;
    const runRow = (id: string) => ownerDb.selectFrom("test_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

    it("test_runs_finish writes each final status, with the rules' results: succeeded, failed and validation_failed", async () => {
      const w = await world();
      const rules = [snapshotRule("one"), snapshotRule("two")];
      const results = [
        { id: rules[0]!.id, passed: true, error: null, advisory: null, detail: null },
        { id: rules[1]!.id, passed: false, error: null, advisory: null, detail: { kind: "unexpected_match" } },
      ];

      const noRules = await claimed(w.published, w.ana, []);
      expect(await finish(noRules.id, noRules.leaseId, "succeeded", { logs: "ok" })).toBe(true);
      expect(await runRow(noRules.id)).toMatchObject({ status: "succeeded", validation_results: null, logs: "ok", lease_id: null });

      const failing = await claimed(w.published, w.ana, rules);
      expect(await finish(failing.id, failing.leaseId, "validation_failed", { validation_results: results })).toBe(true);
      expect(await runRow(failing.id)).toMatchObject({ status: "validation_failed", validation_results: results, error_code: null });

      const passing = await claimed(w.published, w.ana, rules);
      const allPassed = results.map((result) => ({ ...result, passed: true, detail: null }));
      expect(await finish(passing.id, passing.leaseId, "succeeded", { validation_results: allPassed })).toBe(true);
      expect(await runRow(passing.id)).toMatchObject({ status: "succeeded", validation_results: allPassed });

      const outage = await claimed(w.published, w.ana, rules);
      expect(
        await finish(outage.id, outage.leaseId, "failed", {
          error_code: "rules_unavailable",
          error_message: "Validation rules couldn't be checked: the rule evaluator is unavailable.",
          validation_results: null,
        }),
      ).toBe(true);
      expect(await runRow(outage.id)).toMatchObject({ status: "failed", error_code: "rules_unavailable", validation_results: null });
      // Finished: no longer the lease's.
      expect(await finish(outage.id, outage.leaseId, "succeeded")).toBe(false);
    });

    it("test_runs_finish refuses any other status (22023) and changes nothing; a status its results contradict is the check's refusal (23514)", async () => {
      const w = await world();
      const rule = snapshotRule();
      const run = await claimed(w.published, w.ana, [rule]);
      const before = await runRow(run.id);
      for (const status of ["queued", "running", "Fail", "Success", "validation-failed", "", null]) {
        await expect(finish(run.id, run.leaseId, status), String(status)).rejects.toMatchObject({ code: "22023" });
      }
      await expect(finish(run.id, run.leaseId, "succeeded", { validation_outcome: [] })).rejects.toMatchObject({ code: "22023" });
      await expect(
        finish(run.id, run.leaseId, "validation_failed", { validation_results: [{ id: rule.id, passed: true }] }),
      ).rejects.toMatchObject(refusedBy("ck_test_runs_validation_outcome"));
      await expect(finish(run.id, run.leaseId, "succeeded")).rejects.toMatchObject(
        refusedBy("ck_test_runs_validation_outcome"),
      );
      expect(await runRow(run.id)).toEqual(before);
    });

    it("test_runs_finish refuses results that aren't typed (Ruling 32, ck_test_runs_validation_results): a passed that is a string \"false\", null or an array, an element that isn't an object, an id missing or not a string; takes typed ones", async () => {
      const w = await world();
      const rules = [snapshotRule("one"), snapshotRule("two")];
      const typed = (first: unknown) => [first, { id: rules[1]!.id, passed: true }];
      // Every refusal leaves the run running and unchanged, so one run takes them all, then a typed finish.
      const passing = await claimed(w.published, w.ana, rules);
      const before = await runRow(passing.id);
      for (const [label, status, results] of [
        // A string "false" would read as no failure: succeeded with a "failed" rule.
        ['passed the string "false"', "succeeded", typed({ id: rules[0]!.id, passed: "false" })],
        ['passed the string "false", validation_failed', "validation_failed", [
          { id: rules[0]!.id, passed: "false" },
          { id: rules[1]!.id, passed: false },
        ]],
        ["passed null", "succeeded", typed({ id: rules[0]!.id, passed: null })],
        ["passed in an array", "succeeded", typed({ id: rules[0]!.id, passed: [true] })],
        ["no passed", "succeeded", typed({ id: rules[0]!.id })],
        ["a string element", "succeeded", typed("passed")],
        ["a null element", "succeeded", typed(null)],
        ["an array element", "succeeded", typed([{ id: rules[0]!.id, passed: true }])],
        ["no id", "succeeded", typed({ passed: true })],
        ["a number id", "succeeded", typed({ id: 1, passed: true })],
        ["an id in an array", "succeeded", typed({ id: [rules[0]!.id], passed: true })],
      ] as const) {
        await expect(finish(passing.id, passing.leaseId, status, { validation_results: results }), label).rejects.toMatchObject(
          refusedBy("ck_test_runs_validation_results"),
        );
        expect(await runRow(passing.id), label).toEqual(before);
      }
      const allPassed = rules.map((rule) => ({ id: rule.id, passed: true, error: null, advisory: null, detail: null }));
      expect(await finish(passing.id, passing.leaseId, "succeeded", { validation_results: allPassed })).toBe(true);
      expect(await runRow(passing.id)).toMatchObject({ status: "succeeded", validation_results: allPassed });
      const failing = await claimed(w.published, w.ana, rules);
      const oneFailed = [allPassed[0], { ...allPassed[1], passed: false, detail: { kind: "no_match" } }];
      expect(await finish(failing.id, failing.leaseId, "validation_failed", { validation_results: oneFailed })).toBe(true);
      expect(await runRow(failing.id)).toMatchObject({ status: "validation_failed", validation_results: oneFailed });
    });

    it("test_runs_rules returns a running run's snapshot only under its lease: null under another, once finished, or for a run it doesn't know", async () => {
      const w = await world();
      const rules = [snapshotRule("one"), snapshotRule("two")];
      const run = await claimed(w.published, w.ana, rules);
      expect(await rulesOf(run.id, run.leaseId)).toEqual(rules);
      expect(await rulesOf(run.id, randomUUID())).toBeNull();
      expect(await rulesOf(randomUUID(), run.leaseId)).toBeNull();
      const none = await claimed(w.published, w.ana, []);
      expect(await rulesOf(none.id, none.leaseId)).toEqual([]);
      expect(
        await finish(run.id, run.leaseId, "validation_failed", {
          validation_results: [
            { id: rules[0]!.id, passed: true },
            { id: rules[1]!.id, passed: false },
          ],
        }),
      ).toBe(true);
      expect(await rulesOf(run.id, run.leaseId)).toBeNull();
    });

    it("ottl_evaluator_mark sets down_since once, keeping the first time, and clears it on up; refuses null (22023)", async () => {
      const first = await mark(false);
      expect(first).toBeInstanceOf(Date);
      expect(await mark(false)).toEqual(first);
      expect(await ownerDb.selectFrom("ottl_evaluator_state").selectAll().execute()).toEqual([{ id: true, down_since: first }]);
      expect(await mark(true)).toBeNull();
      expect(await ownerDb.selectFrom("ottl_evaluator_state").selectAll().execute()).toEqual([{ id: true, down_since: null }]);
      await expect(mark(null)).rejects.toMatchObject({ code: "22023" });
      // The tester's own state is another row.
      expect(await ownerDb.selectFrom("otelcol_testing_state").selectAll().execute()).toEqual([{ id: true, down_since: null }]);
    });

    it("each refuses (42501) without the dispatcher's context: with none, and with the setting on beside a user or an organization; and the API's role writes the evaluator's state only through its mark", async () => {
      const w = await world();
      const run = await claimed(w.published, w.ana, [snapshotRule()]);
      const calls: Array<[string, ReturnType<typeof sql>]> = [
        ["test_runs_finish", sql`select test_runs_finish(${run.id}::uuid, ${run.leaseId}::uuid, 'failed', '{}')`],
        ["test_runs_rules", sql`select test_runs_rules(${run.id}::uuid, ${run.leaseId}::uuid)`],
        ["ottl_evaluator_mark", sql`select ottl_evaluator_mark(false)`],
      ];
      for (const context of [{}, { dispatcher: true, userId: w.ana }, { dispatcher: true, organizationId: w.a }] as Context[]) {
        for (const [name, call] of calls) {
          await expect(inContext(context, (transaction) => call.execute(transaction)), `${name} ${JSON.stringify(context)}`).rejects.toMatchObject({
            code: "42501",
            message: "only the test-run dispatcher may do this",
          });
        }
      }
      await expect(sql`update ottl_evaluator_state set down_since = now()`.execute(db)).rejects.toMatchObject({ code: "42501" });
      expect(await ownerDb.selectFrom("ottl_evaluator_state").selectAll().execute()).toEqual([{ id: true, down_since: null }]);
      expect(await rulesOf(run.id, run.leaseId)).toHaveLength(1);
    });
  });

  /*
   * A rule's position (Preflight ruling 16): unique per validation pipeline,
   * the next one max + 1 in the INSERT … SELECT, under the configuration's
   * row lock (the organization FOR SHARE, then the configuration FOR UPDATE,
   * as every configuration write takes them). Ana and Ben each add a rule to
   * one pipeline, as the API's login role in two sessions.
   */
  describe("a rule's position, two sessions as the API's role (Preflight ruling 16)", () => {
    /** A session as the API's login role, in its own transaction with `context`. */
    const session = async (context: Required<Pick<Context, "userId" | "organizationId">>) => {
      const client = new pg.Client({ connectionString: process.env.TELFLO_DATABASE_URL });
      await client.connect();
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await client.query("begin");
      await client.query("select set_config('telflo.user_id', $1, true), set_config('telflo.organization_id', $2, true)", [
        context.userId,
        context.organizationId,
      ]);
      return { client, pid, query: <Row extends pg.QueryResultRow>(text: string, values?: unknown[]) => client.query<Row>(text, values) };
    };
    type Session = Awaited<ReturnType<typeof session>>;

    /** Resolves once `pid` waits on a lock: a condition, polled until a deadline (a hang guard only). */
    const waitsOnLock = async (pid: number) => {
      const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
      while (Date.now() < deadline) {
        const { rows } = await sql<{ waiting: boolean }>`
          select coalesce(wait_event_type = 'Lock', false) as waiting from pg_stat_activity where pid = ${pid}
        `.execute(ownerDb);
        if (rows.length === 0) throw new Error(`session ${pid} ended before it waited on a lock`);
        if (rows[0]!.waiting) return;
        await pause(5);
      }
      throw new Error(`session ${pid} never waited on a lock within ${LOCK_WAIT_DEADLINE_MS} ms`);
    };

    /** Settles a promise into its value or its error's code, so a refusal can be awaited later. */
    const settle = <Value>(promise: Promise<Value>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: { code?: string }) => ({ ok: false as const, code: error.code }),
      );

    /** The configuration's lock, as every configuration write takes it. */
    const lockConfiguration = async (s: Session, target: Target) => {
      await s.query("select id from organizations where id = $1 and deleted_at is null for share", [target.organizationId]);
      await s.query("select id from configurations where id = $1 and deleted_at is null for update", [target.configurationId]);
    };
    /** The add: the rule at max + 1 in its validation pipeline, as Task 6's statement; its position. */
    const addRule = async (
      s: Session,
      pipeline: { id: string; organization_id: string; configuration_id: string; configuration_version_id: string },
      userId: string,
    ) =>
      (
        await s.query<{ position: number }>(
          `insert into validation_rules (organization_id, configuration_id, configuration_version_id,
                                         validation_pipeline_id, position, kind, target, pattern,
                                         created_by_user_id, created_at, updated_at)
           select $1::uuid, $2::uuid, $3::uuid, $4::uuid, coalesce(max(r.position), 0) + 1, 'contains_text', 'output',
                  'race', $5::uuid, now(), now()
             from validation_rules r
            where r.validation_pipeline_id = $4::uuid
           returning position`,
          [pipeline.organization_id, pipeline.configuration_id, pipeline.configuration_version_id, pipeline.id, userId],
        )
      ).rows[0]!.position;
    const positions = async (pipelineId: string) =>
      (
        await ownerDb.selectFrom("validation_rules").select("position").where("validation_pipeline_id", "=", pipelineId).orderBy("position").execute()
      ).map((row) => row.position);

    it("with the configuration's lock, Ben waits for Ana's add and takes the next place: 1 and 2", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published, { created_by_user_id: w.ana });
      const ana = await session({ userId: w.ana, organizationId: w.a });
      const ben = await session({ userId: w.ben, organizationId: w.a });
      try {
        await lockConfiguration(ana, w.published);
        expect(await addRule(ana, pipeline, w.ana)).toBe(1);
        const benLocked = settle(lockConfiguration(ben, w.published));
        await waitsOnLock(ben.pid);
        await ana.query("commit");
        expect((await benLocked).ok).toBe(true);
        expect(await addRule(ben, pipeline, w.ben)).toBe(2);
        await ben.query("commit");
      } finally {
        await ana.client.end();
        await ben.client.end();
      }
      expect(await positions(pipeline.id)).toEqual([1, 2]);
    }, LOCK_RACE_TIMEOUT);

    it("without the lock (a bug), both take place 1: Ben's insert waits on Ana's, and the unique key refuses it once she commits (23505); one rule stays", async () => {
      const w = await world();
      const pipeline = await pipelineOn(w.published, { created_by_user_id: w.ana });
      const ana = await session({ userId: w.ana, organizationId: w.a });
      const ben = await session({ userId: w.ben, organizationId: w.a });
      try {
        expect(await addRule(ana, pipeline, w.ana)).toBe(1);
        const benAdded = settle(addRule(ben, pipeline, w.ben));
        await waitsOnLock(ben.pid);
        await ana.query("commit");
        expect(await benAdded).toEqual({ ok: false, code: "23505" });
        await ben.query("rollback");
      } finally {
        await ana.client.end();
        await ben.client.end();
      }
      expect(await positions(pipeline.id)).toEqual([1]);
    }, LOCK_RACE_TIMEOUT);
  });
});
