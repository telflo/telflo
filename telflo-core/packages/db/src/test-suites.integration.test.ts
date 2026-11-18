import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestDefinition,
  addTestDefinitionInput,
  addTestRun,
  addTestSuite,
  addTestTemplate,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type AddTestDefinitionInput,
  type TestDatabases,
} from "./testing.js";

/** The two-session races' own timeout: above waitsOnLock's bound, so a race that never waits fails there first (Ruling 32). */
const LOCK_RACE_TIMEOUT = 30_000;

/** waitsOnLock's deadline, a hang guard well below LOCK_RACE_TIMEOUT (Ruling 36's nit): a race that never waits fails there, not at the test's timeout. */
const LOCK_WAIT_DEADLINE_MS = 10_000;

/*
 * Migration 1700000000029 (D14b decisions 1 to 5 and 8 to 13; Preflight
 * rulings 1 to 7 and 21): test suites, their definitions, the definitions'
 * inputs, test templates, the runs' breadcrumb and the per-organization
 * waiting count. Its up, down and up again are schema.integration.test.ts's
 * ("the test suites migration …"). The cross-tenant suite covers the three
 * organization tables from the resource registry, and apps/api's
 * draft-privacy.integration.test.ts the suites', definitions' and inputs'
 * visibility within an organization through the API's context.
 *
 * The database context is set here with set_config, as context.ts sets it:
 * these tests are the database's own. The reference count (Preflight ruling
 * 7) is checked with two sessions as the API's login role, running the
 * statements the ruling names, since its repositories are Task 3's and 4's;
 * one session waits for the other's lock by a condition (pg_stat_activity),
 * never a time.
 */

/** Whom a transaction acts as: a member (a user, an organization), or nobody. */
interface Context {
  userId?: string;
  organizationId?: string;
}

describe("test suites, definitions, inputs and templates (migration 1700000000029)", () => {
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
               set_config('telflo.organization_id', ${context.organizationId ?? ""}, true)
      `.execute(transaction);
      return work(transaction);
    });

  /**
   * Two group organizations. A: Ana (an admin, who authored a draft and a
   * published configuration) and Ben (a contributor); B: Cara, with her
   * published configuration. Each keeps their personal organization. The
   * published configuration has a published v1 and a draft v2.
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

  /** A suite on `target`'s version (v1 by default), as the owner. */
  const suiteOn = (target: Target, overrides: Record<string, unknown> = {}, versionId = target.v1) =>
    addTestSuite(ownerDb, {
      organizationId: target.organizationId,
      configurationId: target.configurationId,
      configurationVersionId: versionId,
      ...overrides,
    });
  /** An input on `target`'s configuration, as the owner. */
  const inputOn = (target: Target, overrides: Record<string, unknown> = {}) =>
    addTestDefinitionInput(ownerDb, {
      organizationId: target.organizationId,
      configurationId: target.configurationId,
      ...overrides,
    });
  /** A definition in `suite` on `input`, as the owner. */
  const definitionIn = (
    target: Target,
    suite: { id: string; configuration_version_id: string },
    input: { id: string },
    overrides: Partial<AddTestDefinitionInput> = {},
  ) =>
    addTestDefinition(ownerDb, {
      organizationId: target.organizationId,
      configurationId: target.configurationId,
      configurationVersionId: suite.configuration_version_id,
      testSuiteId: suite.id,
      inputId: input.id,
      ...overrides,
    });
  /** Everything on one configuration: a suite on v1, an input and a definition using it. */
  const tree = async (target: Target, creatorId: string) => {
    const suite = await suiteOn(target, { created_by_user_id: creatorId });
    const input = await inputOn(target);
    const definition = await definitionIn(target, suite, input, { created_by_user_id: creatorId });
    return { suite, input, definition };
  };

  /** The ids `context` can select from each table, with no filter of our own. */
  const selectable = (context: Context) =>
    inContext(context, async (transaction) => {
      const ids = async (table: string) =>
        (await sql<{ id: string }>`select id from ${sql.table(table)}`.execute(transaction)).rows.map((row) => row.id).sort();
      return {
        suites: await ids("test_suites"),
        inputs: await ids("test_definition_inputs"),
        definitions: await ids("test_definitions"),
      };
    });

  const refusedBy = (constraint: string, code = "23514") => ({ code, constraint });

  describe("constraints, as the owner", () => {
    it("refuses a suite's name untrimmed, empty or over 200 characters and a description over 2,000, and takes 200 and 2,000", async () => {
      const w = await world();
      await expect(suiteOn(w.published, { name: " Smoke" })).rejects.toMatchObject(refusedBy("ck_test_suites_name_trimmed"));
      await expect(suiteOn(w.published, { name: "" })).rejects.toMatchObject(refusedBy("ck_test_suites_name_length"));
      await expect(suiteOn(w.published, { name: "x".repeat(201) })).rejects.toMatchObject(
        refusedBy("ck_test_suites_name_length"),
      );
      await expect(suiteOn(w.published, { description: "x".repeat(2001) })).rejects.toMatchObject(
        refusedBy("ck_test_suites_description_length"),
      );
      const taken = await suiteOn(w.published, { name: "x".repeat(200), description: "y".repeat(2000) });
      expect(taken).toMatchObject({ name: "x".repeat(200), description: "y".repeat(2000) });
      expect(taken.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect((await suiteOn(w.published)).description).toBe("");
    });

    it("refuses a definition's name untrimmed, empty or over 200, a description over 2,000, a pipeline empty or over 200, and takes the limits", async () => {
      const w = await world();
      const suite = await suiteOn(w.published);
      const input = await inputOn(w.published);
      const define = (overrides: Partial<AddTestDefinitionInput>) => definitionIn(w.published, suite, input, overrides);
      await expect(define({ name: "Logs " })).rejects.toMatchObject(refusedBy("ck_test_definitions_name_trimmed"));
      await expect(define({ name: "" })).rejects.toMatchObject(refusedBy("ck_test_definitions_name_length"));
      await expect(define({ name: "x".repeat(201) })).rejects.toMatchObject(refusedBy("ck_test_definitions_name_length"));
      await expect(define({ description: "x".repeat(2001) })).rejects.toMatchObject(
        refusedBy("ck_test_definitions_description_length"),
      );
      // An empty pipeline names no signal either; either check answers.
      await expect(define({ target_pipeline: "" })).rejects.toMatchObject({
        code: "23514",
        constraint: expect.stringMatching(/^ck_test_definitions_(target_pipeline_length|pipeline_signal)$/),
      });
      await expect(define({ target_pipeline: `logs/${"x".repeat(196)}` })).rejects.toMatchObject(
        refusedBy("ck_test_definitions_target_pipeline_length"),
      );
      const taken = await define({
        name: "x".repeat(200),
        description: "y".repeat(2000),
        target_pipeline: `logs/${"x".repeat(195)}`,
      });
      expect(taken.target_pipeline).toHaveLength(200);
      expect(taken.description).toHaveLength(2000);
    });

    it("refuses a duration outside 1 to 60 seconds (ck_test_definitions_duration_seconds), and takes 1 and 60; and has no default", async () => {
      const w = await world();
      const suite = await suiteOn(w.published);
      const input = await inputOn(w.published);
      for (const duration_seconds of [0, 61, -1]) {
        await expect(definitionIn(w.published, suite, input, { duration_seconds })).rejects.toMatchObject(
          refusedBy("ck_test_definitions_duration_seconds"),
        );
      }
      for (const duration_seconds of [1, 60]) {
        expect((await definitionIn(w.published, suite, input, { duration_seconds })).duration_seconds).toBe(
          duration_seconds,
        );
      }
      await expect(
        sql`insert into test_definitions (organization_id, configuration_id, configuration_version_id, test_suite_id,
                                          input_id, name, target_pipeline, signal, created_at)
            values (${w.a}, ${w.published.configurationId}, ${w.published.v1}, ${suite.id}, ${input.id}, 'No duration',
                    'logs', 'logs', now())`.execute(ownerDb),
      ).rejects.toMatchObject({ code: "23502", column: "duration_seconds" });
    });

    it("refuses a signal outside traces, metrics and logs, and a pipeline that doesn't begin with its signal (ck_test_definitions_pipeline_signal)", async () => {
      const w = await world();
      const suite = await suiteOn(w.published);
      const input = await inputOn(w.published);
      const define = (target_pipeline: string, signal: string) =>
        definitionIn(w.published, suite, input, { target_pipeline, signal: signal as never });
      await expect(define("profiles", "profiles")).rejects.toMatchObject(refusedBy("ck_test_definitions_signal"));
      for (const [pipeline, signal] of [
        ["traces", "logs"],
        ["logs/app", "traces"],
        ["logsx", "logs"],
        ["metrics", "logs"],
      ] as const) {
        await expect(define(pipeline, signal), `${pipeline} as ${signal}`).rejects.toMatchObject(
          refusedBy("ck_test_definitions_pipeline_signal"),
        );
      }
      for (const [pipeline, signal] of [
        ["logs", "logs"],
        ["logs/app", "logs"],
        ["traces/2", "traces"],
        ["metrics", "metrics"],
      ] as const) {
        expect((await define(pipeline, signal)).target_pipeline).toBe(pipeline);
      }
    });

    it("refuses an input's file name empty or over 255, a blank content type, a size below 0 or over 10 MiB, and a SHA-256 of another length", async () => {
      const w = await world();
      await expect(inputOn(w.published, { file_name: "" })).rejects.toMatchObject(
        refusedBy("ck_test_definition_inputs_file_name_length"),
      );
      await expect(inputOn(w.published, { file_name: `${"x".repeat(251)}.json` })).rejects.toMatchObject(
        refusedBy("ck_test_definition_inputs_file_name_length"),
      );
      await expect(inputOn(w.published, { content_type: " " })).rejects.toMatchObject(
        refusedBy("ck_test_definition_inputs_content_type_present"),
      );
      for (const size_bytes of [-1, 10_485_761]) {
        await expect(inputOn(w.published, { size_bytes })).rejects.toMatchObject(
          refusedBy("ck_test_definition_inputs_size_bytes"),
        );
      }
      for (const sha256 of [Buffer.alloc(31), Buffer.alloc(33)]) {
        await expect(inputOn(w.published, { sha256 })).rejects.toMatchObject(
          refusedBy("ck_test_definition_inputs_sha256_length"),
        );
      }
      const taken = await inputOn(w.published, { file_name: `${"x".repeat(250)}.json`, size_bytes: 10_485_760 });
      expect(taken).toMatchObject({ size_bytes: 10_485_760 });
      expect(taken.file_name).toHaveLength(255);
    });

    it("refuses a template's name untrimmed, empty or over 200, a description over 2,000, a receiver type or signal off its format or list, a file name, size or SHA-256 out of bounds", async () => {
      await expect(addTestTemplate(ownerDb, { name: " OTLP" })).rejects.toMatchObject(
        refusedBy("ck_test_templates_name_trimmed"),
      );
      await expect(addTestTemplate(ownerDb, { name: "" })).rejects.toMatchObject(refusedBy("ck_test_templates_name_length"));
      await expect(addTestTemplate(ownerDb, { name: "x".repeat(201) })).rejects.toMatchObject(
        refusedBy("ck_test_templates_name_length"),
      );
      await expect(addTestTemplate(ownerDb, { description: "x".repeat(2001) })).rejects.toMatchObject(
        refusedBy("ck_test_templates_description_length"),
      );
      for (const receiver_type of ["OTLP", "", "1otlp", "otlp-http", `a${"b".repeat(64)}`]) {
        await expect(addTestTemplate(ownerDb, { receiver_type }), receiver_type).rejects.toMatchObject(
          refusedBy("ck_test_templates_receiver_type_format"),
        );
      }
      await expect(addTestTemplate(ownerDb, { signal: "profiles" as never })).rejects.toMatchObject(
        refusedBy("ck_test_templates_signal"),
      );
      await expect(addTestTemplate(ownerDb, { file_name: "" })).rejects.toMatchObject(
        refusedBy("ck_test_templates_file_name_length"),
      );
      await expect(addTestTemplate(ownerDb, { content_type: "" })).rejects.toMatchObject(
        refusedBy("ck_test_templates_content_type_present"),
      );
      for (const size_bytes of [-1, 10_485_761]) {
        await expect(addTestTemplate(ownerDb, { size_bytes })).rejects.toMatchObject(
          refusedBy("ck_test_templates_size_bytes"),
        );
      }
      await expect(addTestTemplate(ownerDb, { sha256: Buffer.alloc(16) })).rejects.toMatchObject(
        refusedBy("ck_test_templates_sha256_length"),
      );
      expect(
        await addTestTemplate(ownerDb, {
          name: "x".repeat(200),
          description: "y".repeat(2000),
          receiver_type: `a${"b".repeat(63)}`,
          size_bytes: 10_485_760,
        }),
      ).toMatchObject({ deleted_at: null, size_bytes: 10_485_760 });
    });

    it("keeps a run's breadcrumb all set or all null (ck_test_runs_breadcrumb_together), each name 1 to 200 characters", async () => {
      const w = await world();
      const queue = (overrides: Record<string, unknown>) =>
        addTestRun(ownerDb, {
          organizationId: w.a,
          configurationId: w.published.configurationId,
          configurationVersionId: w.published.v1,
          queuedByUserId: w.ana,
          ...overrides,
        });
      const breadcrumb = {
        test_suite_id: randomUUID(),
        test_suite_name: "Smoke tests",
        test_definition_id: randomUUID(),
        test_definition_name: "Logs only",
      };
      for (const left of Object.keys(breadcrumb)) {
        await expect(queue({ ...breadcrumb, [left]: null }), left).rejects.toMatchObject(
          refusedBy("ck_test_runs_breadcrumb_together"),
        );
        await expect(queue({ [left]: (breadcrumb as Record<string, string>)[left] }), left).rejects.toMatchObject(
          refusedBy("ck_test_runs_breadcrumb_together"),
        );
      }
      await expect(queue({ ...breadcrumb, test_suite_name: "" })).rejects.toMatchObject(
        refusedBy("ck_test_runs_test_suite_name_length"),
      );
      await expect(queue({ ...breadcrumb, test_definition_name: "x".repeat(201) })).rejects.toMatchObject(
        refusedBy("ck_test_runs_test_definition_name_length"),
      );
      expect(await queue({ ...breadcrumb, test_suite_name: "x".repeat(200) })).toMatchObject({
        ...breadcrumb,
        test_suite_name: "x".repeat(200),
      });
      expect(await queue({})).toMatchObject({
        test_suite_id: null,
        test_suite_name: null,
        test_definition_id: null,
        test_definition_name: null,
      });
    });

    it("refuses a definition naming a suite of another version (23503, fk_test_definitions_suite), even of its own configuration", async () => {
      const w = await world();
      const suiteInV1 = await suiteOn(w.published);
      const input = await inputOn(w.published);
      await expect(
        definitionIn(w.published, { id: suiteInV1.id, configuration_version_id: w.published.v2 }, input),
      ).rejects.toMatchObject(refusedBy("fk_test_definitions_suite", "23503"));
      const suiteOfDraft = await suiteOn(w.draft);
      await expect(
        definitionIn(w.published, { id: suiteOfDraft.id, configuration_version_id: w.published.v1 }, input),
      ).rejects.toMatchObject(refusedBy("fk_test_definitions_suite", "23503"));
      expect(await ownerDb.selectFrom("test_definitions").select("id").execute()).toEqual([]);
    });

    it("refuses, at commit, a definition naming another configuration's input (23503, fk_test_definitions_input), and a suite naming another configuration's version", async () => {
      const w = await world();
      const suite = await suiteOn(w.published);
      const inputOfDraft = await inputOn(w.draft);
      const inputInB = await inputOn(w.inB);
      for (const input of [inputOfDraft, inputInB]) {
        await expect(
          ownerDb.transaction().execute(async (transaction) => {
            await transaction
              .insertInto("test_definitions")
              .values({
                organization_id: w.a,
                configuration_id: w.published.configurationId,
                configuration_version_id: w.published.v1,
                test_suite_id: suite.id,
                input_id: input.id,
                name: "Elsewhere",
                target_pipeline: "logs",
                signal: "logs",
                duration_seconds: 5,
                created_by_user_id: w.ana,
                created_at: new Date(),
              })
              .execute();
            // Accepted until the commit: the key is deferred (Preflight ruling 3).
            return "inserted";
          }),
        ).rejects.toMatchObject(refusedBy("fk_test_definitions_input", "23503"));
      }
      await expect(
        suiteOn({ ...w.published, configurationId: w.draft.configurationId }, {}, w.published.v1),
      ).rejects.toMatchObject(refusedBy("fk_test_suites_configuration_version", "23503"));
      expect(await ownerDb.selectFrom("test_definitions").select("id").execute()).toEqual([]);
    });

    it("refuses, at commit, removing an input a definition still names (fk_test_definitions_input), and removes an unused one", async () => {
      const w = await world();
      const { input } = await tree(w.published, w.ana);
      const unused = await inputOn(w.published);
      await expect(
        ownerDb.transaction().execute(async (transaction) => {
          await transaction.deleteFrom("test_definition_inputs").where("id", "=", input.id).execute();
        }),
      ).rejects.toMatchObject(refusedBy("fk_test_definitions_input", "23503"));
      await ownerDb.deleteFrom("test_definition_inputs").where("id", "=", unused.id).execute();
      expect((await ownerDb.selectFrom("test_definition_inputs").select("id").execute()).map((row) => row.id)).toEqual([
        input.id,
      ]);
    });

    it("takes a suite's definitions with it, and leaves their inputs", async () => {
      const w = await world();
      const { suite, input } = await tree(w.published, w.ana);
      const other = await tree(w.published, w.ana);
      await ownerDb.deleteFrom("test_suites").where("id", "=", suite.id).execute();
      expect((await ownerDb.selectFrom("test_definitions").select("id").execute()).map((row) => row.id)).toEqual([
        other.definition.id,
      ]);
      expect(
        (await ownerDb.selectFrom("test_definition_inputs").select("id").orderBy("id").execute()).map((row) => row.id),
      ).toEqual([input.id, other.input.id].sort());
    });

    it("lets an operator hard-delete a configuration, its suites, definitions and inputs going with it (the deferred key, Preflight ruling 3), and an organization likewise, leaving others'", async () => {
      const w = await world();
      await tree(w.draft, w.ana);
      const kept = await tree(w.published, w.ana);
      const inB = await tree(w.inB, w.cara);
      await ownerDb.deleteFrom("configurations").where("id", "=", w.draft.configurationId).execute();
      const remaining = async () => ({
        suites: (await ownerDb.selectFrom("test_suites").select("id").orderBy("id").execute()).map((row) => row.id),
        inputs: (await ownerDb.selectFrom("test_definition_inputs").select("id").orderBy("id").execute()).map(
          (row) => row.id,
        ),
        definitions: (await ownerDb.selectFrom("test_definitions").select("id").orderBy("id").execute()).map(
          (row) => row.id,
        ),
      });
      expect(await remaining()).toEqual({
        suites: [kept.suite.id, inB.suite.id].sort(),
        inputs: [kept.input.id, inB.input.id].sort(),
        definitions: [kept.definition.id, inB.definition.id].sort(),
      });
      await ownerDb.deleteFrom("organizations").where("id", "=", w.a).execute();
      expect(await remaining()).toEqual({
        suites: [inB.suite.id],
        inputs: [inB.input.id],
        definitions: [inB.definition.id],
      });
    });

    it("keeps a hard-deleted account's suites, definitions and templates, with no creator", async () => {
      const w = await world();
      const { suite, definition } = await tree(w.published, w.ben);
      const template = await addTestTemplate(ownerDb, { created_by_user_id: w.ben });
      await ownerDb.deleteFrom("users").where("id", "=", w.ben).execute();
      expect(await ownerDb.selectFrom("test_suites").selectAll().where("id", "=", suite.id).executeTakeFirst()).toEqual({
        ...suite,
        created_by_user_id: null,
      });
      expect(
        await ownerDb.selectFrom("test_definitions").selectAll().where("id", "=", definition.id).executeTakeFirst(),
      ).toEqual({ ...definition, created_by_user_id: null });
      expect(
        await ownerDb.selectFrom("test_templates").selectAll().where("id", "=", template.id).executeTakeFirst(),
      ).toEqual({ ...template, created_by_user_id: null });
    });
  });

  describe("the triggers, for every role (here the owner, past row-level security)", () => {
    it("keeps a suite's identity (P0001, naming only the suite): its id, organization, configuration, version and created_at, and its creator but to null; lets its name, description and updated_at change", async () => {
      const w = await world();
      const suite = await suiteOn(w.published, { created_by_user_id: w.ana });
      const change = (values: Record<string, unknown>) =>
        ownerDb
          .updateTable("test_suites")
          .set(values as never)
          .where("id", "=", suite.id)
          .execute();
      const changes: Record<string, unknown> = {
        id: randomUUID(),
        organization_id: w.b,
        configuration_id: w.draft.configurationId,
        configuration_version_id: w.published.v2,
        created_at: new Date(Date.UTC(2020, 0, 1)),
        created_by_user_id: w.ben,
      };
      for (const [column, value] of Object.entries(changes)) {
        await expect(change({ [column]: value }), column).rejects.toMatchObject({
          code: "P0001",
          message: `test suite ${suite.id} keeps its version and its creator`,
        });
      }
      const at = new Date(suite.created_at.getTime() + 1000);
      await change({ name: "Renamed", description: "Now described", updated_at: at, created_by_user_id: w.ana });
      await change({ created_by_user_id: null });
      expect(await ownerDb.selectFrom("test_suites").selectAll().where("id", "=", suite.id).executeTakeFirst()).toEqual({
        ...suite,
        name: "Renamed",
        description: "Now described",
        updated_at: at,
        created_by_user_id: null,
      });
    });

    it("keeps a template's file and creator (P0001), lets deleted_at go only from null to a time, and lets its name, description, receiver type and signal change", async () => {
      const template = await addTestTemplate(ownerDb, { created_by_user_id: (await createUserWithOrganization(ownerDb)).user.id });
      const other = (await createUserWithOrganization(ownerDb)).user.id;
      const change = (values: Record<string, unknown>) =>
        ownerDb
          .updateTable("test_templates")
          .set(values as never)
          .where("id", "=", template.id)
          .execute();
      const changes: Record<string, unknown> = {
        id: randomUUID(),
        file_name: "other.json",
        content_type: "text/plain",
        size_bytes: 1,
        sha256: createHash("sha256").update("other").digest(),
        created_at: new Date(Date.UTC(2020, 0, 1)),
        created_by_user_id: other,
      };
      for (const [column, value] of Object.entries(changes)) {
        await expect(change({ [column]: value }), column).rejects.toMatchObject({
          code: "P0001",
          message: `test template ${template.id} keeps its file and its creator`,
        });
      }
      await change({ name: "Renamed", description: "d", receiver_type: "filelog", signal: "traces", updated_at: new Date() });
      const deletedAt = new Date();
      await change({ deleted_at: deletedAt });
      for (const deleted_at of [null, new Date(deletedAt.getTime() + 1000)]) {
        await expect(change({ deleted_at }), String(deleted_at)).rejects.toMatchObject({
          code: "P0001",
          message: `test template ${template.id} stays deleted`,
        });
      }
      await change({ created_by_user_id: null });
      expect(
        await ownerDb.selectFrom("test_templates").selectAll().where("id", "=", template.id).executeTakeFirst(),
      ).toMatchObject({
        name: "Renamed",
        receiver_type: "filelog",
        signal: "traces",
        file_name: template.file_name,
        deleted_at: deletedAt,
        created_by_user_id: null,
      });
    });

    it("refuses a change to a run's breadcrumb, each of its four columns (P0001, test_runs_guard), and the dispatcher's claim and finish keep it", async () => {
      const w = await world();
      const breadcrumb = {
        test_suite_id: randomUUID(),
        test_suite_name: "Smoke tests",
        test_definition_id: randomUUID(),
        test_definition_name: "Logs only",
      };
      const run = await addTestRun(ownerDb, {
        organizationId: w.a,
        configurationId: w.published.configurationId,
        configurationVersionId: w.published.v1,
        queuedByUserId: w.ana,
        ...breadcrumb,
      });
      const changes: Record<string, unknown> = {
        test_suite_id: randomUUID(),
        test_suite_name: "Other",
        test_definition_id: randomUUID(),
        test_definition_name: "Other",
      };
      for (const [column, value] of Object.entries(changes)) {
        await expect(
          ownerDb
            .updateTable("test_runs")
            .set({ [column]: value } as never)
            .where("id", "=", run.id)
            .execute(),
          column,
        ).rejects.toMatchObject({ code: "P0001", message: `test run ${run.id} keeps its snapshot` });
      }
      // All four cleared at once still changes the snapshot.
      await expect(
        ownerDb
          .updateTable("test_runs")
          .set({ test_suite_id: null, test_suite_name: null, test_definition_id: null, test_definition_name: null } as never)
          .where("id", "=", run.id)
          .execute(),
      ).rejects.toMatchObject({ code: "P0001" });

      const dispatcher = <Result>(work: (transaction: Transaction<Database>) => Promise<Result>) =>
        db.transaction().execute(async (transaction) => {
          await sql`select set_config('telflo.dispatcher', 'on', true)`.execute(transaction);
          return work(transaction);
        });
      const claimed = await dispatcher((transaction) =>
        sql<{ run_id: string; lease_id: string }>`select run_id, lease_id from test_runs_claim(4, 30)`.execute(transaction),
      );
      expect(claimed.rows.map((row) => row.run_id)).toEqual([run.id]);
      const finished = await dispatcher((transaction) =>
        sql<{ done: boolean }>`
          select test_runs_finish(${run.id}::uuid, ${claimed.rows[0]!.lease_id}::uuid, 'succeeded', '{}'::jsonb) as done
        `.execute(transaction),
      );
      expect(finished.rows[0]!.done).toBe(true);
      expect(
        await ownerDb.selectFrom("test_runs").selectAll().where("id", "=", run.id).executeTakeFirst(),
      ).toMatchObject({ status: "succeeded", ...breadcrumb });
    });
  });

  describe("row-level security, as the application role", () => {
    it("shows a draft's suites, definitions and inputs to its author only: not a teammate, not an admin of another organization", async () => {
      const w = await world();
      const draft = await tree(w.draft, w.ana);
      const ids = (t: typeof draft) => ({ suites: [t.suite.id], inputs: [t.input.id], definitions: [t.definition.id] });
      expect(await selectable({ userId: w.ana, organizationId: w.a })).toEqual(ids(draft));
      expect(await selectable({ userId: w.ben, organizationId: w.a })).toEqual({ suites: [], inputs: [], definitions: [] });
      expect(await selectable({ userId: w.cara, organizationId: w.b })).toEqual({ suites: [], inputs: [], definitions: [] });
      // Nor through a context naming another organization, or none.
      expect(await selectable({ userId: w.ana, organizationId: w.b })).toEqual({ suites: [], inputs: [], definitions: [] });
      expect(await selectable({ userId: w.ana })).toEqual({ suites: [], inputs: [], definitions: [] });
    });

    it("shows a published configuration's suites, definitions and inputs, on any of its versions, to every member, and to no one in another organization", async () => {
      const w = await world();
      const onV1 = await tree(w.published, w.ana);
      const onV2 = await suiteOn(w.published, { created_by_user_id: w.ana }, w.published.v2);
      const expected = {
        suites: [onV1.suite.id, onV2.id].sort(),
        inputs: [onV1.input.id],
        definitions: [onV1.definition.id],
      };
      expect(await selectable({ userId: w.ana, organizationId: w.a })).toEqual(expected);
      expect(await selectable({ userId: w.ben, organizationId: w.a })).toEqual(expected);
      expect(await selectable({ userId: w.cara, organizationId: w.b })).toEqual({ suites: [], inputs: [], definitions: [] });
    });

    it("lets every member create, rename and delete suites, and add and delete definitions and inputs, on a published configuration's versions, published or not, as themselves", async () => {
      const w = await world();
      const ben = { userId: w.ben, organizationId: w.a };
      for (const versionId of [w.published.v1, w.published.v2]) {
        const at = new Date();
        const { suite, input, definition } = await inContext(ben, async (transaction) => {
          const suite = await transaction
            .insertInto("test_suites")
            .values({
              organization_id: w.a,
              configuration_id: w.published.configurationId,
              configuration_version_id: versionId,
              name: "Ben's",
              created_by_user_id: w.ben,
              created_at: at,
              updated_at: at,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const input = await transaction
            .insertInto("test_definition_inputs")
            .values({
              organization_id: w.a,
              configuration_id: w.published.configurationId,
              file_name: "logs.json",
              content_type: "application/json",
              size_bytes: 0,
              sha256: createHash("sha256").digest(),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const definition = await transaction
            .insertInto("test_definitions")
            .values({
              organization_id: w.a,
              configuration_id: w.published.configurationId,
              configuration_version_id: versionId,
              test_suite_id: suite.id,
              input_id: input.id,
              name: "Logs",
              target_pipeline: "logs",
              signal: "logs",
              duration_seconds: 5,
              created_by_user_id: w.ben,
              created_at: at,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return { suite, input, definition };
        });
        const renamed = await inContext({ userId: w.ana, organizationId: w.a }, (transaction) =>
          transaction
            .updateTable("test_suites")
            .set({ name: "Renamed by Ana", updated_at: new Date(at.getTime() + 1) })
            .where("id", "=", suite.id)
            .executeTakeFirstOrThrow(),
        );
        expect(renamed.numUpdatedRows).toBe(1n);
        const deleted = await inContext(ben, async (transaction) => ({
          definitions: (await transaction.deleteFrom("test_definitions").where("id", "=", definition.id).executeTakeFirstOrThrow())
            .numDeletedRows,
          inputs: (await transaction.deleteFrom("test_definition_inputs").where("id", "=", input.id).executeTakeFirstOrThrow())
            .numDeletedRows,
          suites: (await transaction.deleteFrom("test_suites").where("id", "=", suite.id).executeTakeFirstOrThrow())
            .numDeletedRows,
        }));
        expect(deleted).toEqual({ definitions: 1n, inputs: 1n, suites: 1n });
      }
    });

    it("refuses a suite or a definition whose creator isn't the context's user (42501), on a configuration the member can see", async () => {
      const w = await world();
      const { suite, input } = await tree(w.published, w.ana);
      const ben = { userId: w.ben, organizationId: w.a };
      const at = new Date();
      for (const forged of [w.ana, null]) {
        await expect(
          inContext(ben, (transaction) =>
            transaction
              .insertInto("test_suites")
              .values({
                organization_id: w.a,
                configuration_id: w.published.configurationId,
                configuration_version_id: w.published.v1,
                name: "Forged",
                created_by_user_id: forged as string,
                created_at: at,
                updated_at: at,
              })
              .execute(),
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          inContext(ben, (transaction) =>
            transaction
              .insertInto("test_definitions")
              .values({
                organization_id: w.a,
                configuration_id: w.published.configurationId,
                configuration_version_id: w.published.v1,
                test_suite_id: suite.id,
                input_id: input.id,
                name: "Forged",
                target_pipeline: "logs",
                signal: "logs",
                duration_seconds: 5,
                created_by_user_id: forged as string,
                created_at: at,
              })
              .execute(),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
      // Nor can the suite's creator be changed to someone else afterwards (the trigger, before the policy).
      await expect(
        inContext(ben, (transaction) =>
          transaction
            .updateTable("test_suites")
            .set({ created_by_user_id: w.ben } as never)
            .where("id", "=", suite.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(await ownerDb.selectFrom("test_suites").select("id").execute()).toEqual([{ id: suite.id }]);
    });

    it("refuses adding a suite, an input or a definition to another member's draft, or naming another organization (42501)", async () => {
      const w = await world();
      const draft = await tree(w.draft, w.ana);
      const at = new Date();
      const attempts = (organizationId: string, target: Target, userId: string) => ({
        suite: () =>
          inContext({ userId, organizationId }, (transaction) =>
            transaction
              .insertInto("test_suites")
              .values({
                organization_id: target.organizationId,
                configuration_id: target.configurationId,
                configuration_version_id: target.v1,
                name: "Slipped in",
                created_by_user_id: userId,
                created_at: at,
                updated_at: at,
              })
              .execute(),
          ),
        input: () =>
          inContext({ userId, organizationId }, (transaction) =>
            transaction
              .insertInto("test_definition_inputs")
              .values({
                organization_id: target.organizationId,
                configuration_id: target.configurationId,
                file_name: "slipped.json",
                content_type: "application/json",
                size_bytes: 0,
                sha256: createHash("sha256").digest(),
              })
              .execute(),
          ),
        definition: () =>
          inContext({ userId, organizationId }, (transaction) =>
            transaction
              .insertInto("test_definitions")
              .values({
                organization_id: target.organizationId,
                configuration_id: target.configurationId,
                configuration_version_id: target.v1,
                test_suite_id: draft.suite.id,
                input_id: draft.input.id,
                name: "Slipped in",
                target_pipeline: "logs",
                signal: "logs",
                duration_seconds: 5,
                created_by_user_id: userId,
                created_at: at,
              })
              .execute(),
          ),
      });
      for (const [who, attempt] of [
        ["Ben on Ana's draft", attempts(w.a, w.draft, w.ben)],
        ["Cara from B naming A's published", attempts(w.b, w.published, w.cara)],
      ] as const) {
        for (const [table, insert] of Object.entries(attempt)) {
          await expect(insert(), `${who}: ${table}`).rejects.toMatchObject({ code: "42501" });
        }
      }
      expect(await ownerDb.selectFrom("test_suites").select("id").execute()).toEqual([{ id: draft.suite.id }]);
    });

    it("updates, renames and deletes none of another member's draft's rows", async () => {
      const w = await world();
      const draft = await tree(w.draft, w.ana);
      const results = await inContext({ userId: w.ben, organizationId: w.a }, async (transaction) => ({
        renamed: await sql`update test_suites set name = 'Taken' where id = ${draft.suite.id}`.execute(transaction),
        definitions: await sql`delete from test_definitions where id = ${draft.definition.id}`.execute(transaction),
        inputs: await sql`delete from test_definition_inputs where id = ${draft.input.id}`.execute(transaction),
        suites: await sql`delete from test_suites where id = ${draft.suite.id}`.execute(transaction),
      }));
      for (const result of Object.values(results)) expect(result.numAffectedRows).toBe(0n);
      expect(await selectable({ userId: w.ana, organizationId: w.a })).toEqual({
        suites: [draft.suite.id],
        inputs: [draft.input.id],
        definitions: [draft.definition.id],
      });
    });

    /*
     * A statement with no WHERE clause and no RETURNING reads no column, so
     * Postgres applies only its command's policy, not the select policy: the
     * probes above, by id, would pass with the update and delete policies cut
     * to the organization (D14b Ruling 29). These reach Ana's draft through
     * the update and delete policies alone.
     */
    it("updates and deletes none of another member's draft's rows by a bare statement with no WHERE clause (the update and delete policies alone)", async () => {
      const w = await world();
      const draft = await tree(w.draft, w.ana);
      const ben = { userId: w.ben, organizationId: w.a };
      for (const [label, statement] of [
        ["update test_suites", sql`update test_suites set name = 'x'`],
        ["delete from test_definitions", sql`delete from test_definitions`],
        ["delete from test_definition_inputs", sql`delete from test_definition_inputs`],
        ["delete from test_suites", sql`delete from test_suites`],
      ] as const) {
        // Each in its own transaction, checked before its commit, so one statement's rows can't hide another's.
        await inContext(ben, async (transaction) => {
          expect((await statement.execute(transaction)).numAffectedRows, label).toBe(0n);
        });
      }
      expect(await ownerDb.selectFrom("test_suites").selectAll().execute()).toEqual([draft.suite]);
      expect(await ownerDb.selectFrom("test_definitions").selectAll().execute()).toEqual([draft.definition]);
      expect(await ownerDb.selectFrom("test_definition_inputs").selectAll().execute()).toEqual([draft.input]);
    });

    it("updates no definition and no input, their creator's included (update policies using (false))", async () => {
      const w = await world();
      const { input, definition } = await tree(w.published, w.ana);
      const ana = { userId: w.ana, organizationId: w.a };
      const results = await inContext(ana, async (transaction) => ({
        definition: await sql`update test_definitions set duration_seconds = 9 where id = ${definition.id}`.execute(
          transaction,
        ),
        input: await sql`update test_definition_inputs set file_name = 'changed.json' where id = ${input.id}`.execute(
          transaction,
        ),
        // A locking read takes the update policy too: it locks nothing (Preflight ruling 7).
        locked: await sql`select id from test_definition_inputs where id = ${input.id} for update`.execute(transaction),
      }));
      expect(results.definition.numAffectedRows).toBe(0n);
      expect(results.input.numAffectedRows).toBe(0n);
      expect(results.locked.rows).toEqual([]);
      expect(await ownerDb.selectFrom("test_definitions").selectAll().where("id", "=", definition.id).executeTakeFirst()).toEqual(
        definition,
      );
    });

    it("lets the application role read, add and change templates, and refuses its DELETE (42501): deletes are soft", async () => {
      const at = new Date();
      const template = await db
        .insertInto("test_templates")
        .values({
          name: "OTLP logs",
          receiver_type: "otlp",
          signal: "logs",
          file_name: "logs.json",
          content_type: "application/json",
          size_bytes: 0,
          sha256: createHash("sha256").digest(),
          created_by_user_id: (await createUserWithOrganization(ownerDb)).user.id,
          created_at: at,
          updated_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect((await db.selectFrom("test_templates").select("id").execute()).map((row) => row.id)).toEqual([template.id]);
      await db.updateTable("test_templates").set({ deleted_at: new Date() }).where("id", "=", template.id).execute();
      await expect(db.deleteFrom("test_templates").where("id", "=", template.id).execute()).rejects.toMatchObject({
        code: "42501",
      });
      expect(await ownerDb.selectFrom("test_templates").select("id").execute()).toEqual([{ id: template.id }]);
    });
  });

  /*
   * The reference count (D14b decision 4, Preflight rulings 2 and 7): an
   * input is in use while a definition names it. Every path that adds or
   * removes a reference locks the organization FOR SHARE, then the
   * configuration FOR UPDATE, so "no definition names it" can't change
   * under a delete; fk_test_definitions_input, deferred, refuses the
   * loser's commit when a path forgets the lock. These run the statements
   * the ruling names, as the API's login role in two sessions: Ana deletes
   * v1's last definition on input I while Ben creates a version from v1,
   * whose copy names I.
   */
  describe("the reference count, two sessions as the API's role (Preflight ruling 7)", () => {
    /** A session as the API's login role, in its own transaction with `context`. */
    const session = async (context: Required<Context>) => {
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

    /**
     * Resolves once `pid` waits on a lock: a condition, polled with a short pause between until a
     * deadline. It throws when the session has ended or the deadline passes, so a failing race
     * reaches its finally and ends both sessions, rather than spinning past the test's timeout with
     * them open (which would hold the locks truncateAll then waits on).
     */
    const waitsOnLock = async (pid: number) => {
      // A time deadline, not a count of attempts: a slow query can't stretch it past LOCK_RACE_TIMEOUT (Rulings 32 and 36).
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

    /** The two locks every reference-changing path takes (Preflight ruling 7). */
    const lockConfiguration = async (s: Session, target: Target) => {
      await s.query("select id from organizations where id = $1 and deleted_at is null for share", [target.organizationId]);
      await s.query("select id from configurations where id = $1 and deleted_at is null for update", [target.configurationId]);
    };
    /** A definition delete's first step: the row, returning its input. */
    const deleteDefinition = async (s: Session, definitionId: string) =>
      (await s.query<{ input_id: string }>("delete from test_definitions where id = $1 returning input_id", [definitionId])).rows.map(
        (row) => row.input_id,
      );
    /** The free: each candidate input that no definition names. */
    const freeUnused = async (s: Session, inputIds: string[]) =>
      (
        await s.query<{ id: string }>(
          `delete from test_definition_inputs i
            where i.id = any($1::uuid[])
              and not exists (select 1 from test_definitions d where d.input_id = i.id)
           returning i.id`,
          [inputIds],
        )
      ).rows
        .map((row) => row.id)
        .sort();
    /** A version create from `sourceVersionId`, then its copy of the suites and definitions, as Task 4's statement. */
    const createVersionWithCopy = async (s: Session, target: Target, sourceVersionId: string, userId: string) => {
      const version = await s.query<{ id: string }>(
        `insert into configuration_versions (configuration_id, organization_id, version_number, yaml_content,
                                             created_by_user_id, created_at, updated_at, collector_distribution,
                                             collector_version)
         select v.configuration_id, v.organization_id,
                (select max(o.version_number) + 1 from configuration_versions o where o.configuration_id = v.configuration_id),
                v.yaml_content, $3, now(), now(), v.collector_distribution, v.collector_version
           from configuration_versions v
          where v.id = $1 and v.configuration_id = $2
         returning id`,
        [sourceVersionId, target.configurationId, userId],
      );
      const copied = await s.query<{ suites: number; definitions: number }>(
        `with map as materialized (
           select o.id as old_id, uuidv7() as new_id, o.position
             from (select s.id, row_number() over (order by s.created_at, s.id) as position
                     from test_suites s
                    where s.configuration_version_id = $1 and s.configuration_id = $5 and s.organization_id = $6) o
         ), suites as (
           insert into test_suites (id, organization_id, configuration_id, configuration_version_id, name, description,
                                    created_by_user_id, created_at, updated_at)
           select m.new_id, s.organization_id, s.configuration_id, $2, s.name, s.description, $3, $4, $4
             from map m join test_suites s on s.id = m.old_id
            order by m.position
           returning id
         ), definitions as (
           insert into test_definitions (organization_id, configuration_id, configuration_version_id, test_suite_id,
                                         input_id, name, description, target_pipeline, signal, duration_seconds,
                                         created_by_user_id, created_at)
           select d.organization_id, d.configuration_id, $2, m.new_id, d.input_id, d.name, d.description,
                  d.target_pipeline, d.signal, d.duration_seconds, $3, $4
             from map m join test_definitions d on d.test_suite_id = m.old_id
            order by m.position, d.created_at, d.id
           returning id
         )
         select (select count(*) from suites)::int as suites, (select count(*) from definitions)::int as definitions`,
        [sourceVersionId, version.rows[0]!.id, userId, new Date(), target.configurationId, target.organizationId],
      );
      return copied.rows[0]!;
    };

    /** Definitions whose input is gone, and inputs no definition names, on `target`'s configuration. */
    const invariants = async (target: Target) =>
      (
        await sql<{ dangling: number; orphans: number; versions: number }>`
          select (select count(*) from test_definitions d
                   where d.configuration_id = ${target.configurationId}
                     and not exists (select 1 from test_definition_inputs i where i.id = d.input_id))::int as dangling,
                 (select count(*) from test_definition_inputs i
                   where i.configuration_id = ${target.configurationId}
                     and not exists (select 1 from test_definitions d where d.input_id = i.id))::int as orphans,
                 (select count(*) from configuration_versions v
                   where v.configuration_id = ${target.configurationId})::int as versions
        `.execute(ownerDb)
      ).rows[0]!;

    /** v1's suite with its one definition on input I, and Ana's and Ben's sessions, both begun. */
    const fresh = async () => {
      const w = await world();
      const { suite, input, definition } = await tree(w.published, w.ana);
      const ana = await session({ userId: w.ana, organizationId: w.a });
      const ben = await session({ userId: w.ben, organizationId: w.a });
      return { w, suite, input, definition, ana, ben };
    };
    const end = async (...sessions: Session[]) => {
      for (const s of sessions) await s.client.end();
    };

    it("with the configuration's lock, Ana's delete first: Ben waits, copies nothing of the deleted definition, and nothing dangles or is orphaned", async () => {
      const { w, input, definition, ana, ben } = await fresh();
      try {
        await lockConfiguration(ana, w.published);
        const candidates = await deleteDefinition(ana, definition.id);
        expect(await freeUnused(ana, candidates)).toEqual([input.id]);
        const benLocked = settle(lockConfiguration(ben, w.published));
        await waitsOnLock(ben.pid);
        await ana.query("commit");
        expect((await benLocked).ok).toBe(true);
        expect(await createVersionWithCopy(ben, w.published, w.published.v1, w.ben)).toEqual({ suites: 1, definitions: 0 });
        await ben.query("commit");
      } finally {
        await end(ana, ben);
      }
      expect(await invariants(w.published)).toEqual({ dangling: 0, orphans: 0, versions: 3 });
    }, LOCK_RACE_TIMEOUT);

    it("with the configuration's lock, Ben's copy first: Ana waits, then frees nothing, since the copy names the input; nothing dangles or is orphaned", async () => {
      const { w, definition, ana, ben } = await fresh();
      try {
        await lockConfiguration(ben, w.published);
        expect(await createVersionWithCopy(ben, w.published, w.published.v1, w.ben)).toEqual({ suites: 1, definitions: 1 });
        const anaLocked = settle(lockConfiguration(ana, w.published));
        await waitsOnLock(ana.pid);
        await ben.query("commit");
        expect((await anaLocked).ok).toBe(true);
        const candidates = await deleteDefinition(ana, definition.id);
        expect(await freeUnused(ana, candidates)).toEqual([]);
        await ana.query("commit");
      } finally {
        await end(ana, ben);
      }
      expect(await invariants(w.published)).toEqual({ dangling: 0, orphans: 0, versions: 3 });
    }, LOCK_RACE_TIMEOUT);

    it("without the lock in Ana's delete (a bug), her free first: Ben's commit waits on the input, then the deferred key refuses it (23503), and nothing dangles", async () => {
      const { w, input, definition, ana, ben } = await fresh();
      try {
        const candidates = await deleteDefinition(ana, definition.id);
        expect(await freeUnused(ana, candidates)).toEqual([input.id]);
        await lockConfiguration(ben, w.published);
        // Ana's delete is uncommitted, so Ben still sees her definition and copies it.
        expect(await createVersionWithCopy(ben, w.published, w.published.v1, w.ben)).toEqual({ suites: 1, definitions: 1 });
        const benCommitted = settle(ben.query("commit"));
        await waitsOnLock(ben.pid);
        await ana.query("commit");
        expect(await benCommitted).toEqual({ ok: false, code: "23503" });
      } finally {
        await end(ana, ben);
      }
      expect(await invariants(w.published)).toEqual({ dangling: 0, orphans: 0, versions: 2 });
    }, LOCK_RACE_TIMEOUT);

    it("without the lock in Ana's delete (a bug), Ben's copy first: Ana frees the input his uncommitted copy names, and the deferred key refuses his commit (23503); nothing dangles", async () => {
      const { w, input, definition, ana, ben } = await fresh();
      try {
        await lockConfiguration(ben, w.published);
        expect(await createVersionWithCopy(ben, w.published, w.published.v1, w.ben)).toEqual({ suites: 1, definitions: 1 });
        const candidates = await deleteDefinition(ana, definition.id);
        expect(await freeUnused(ana, candidates)).toEqual([input.id]);
        await ana.query("commit");
        expect(await settle(ben.query("commit"))).toEqual({ ok: false, code: "23503" });
      } finally {
        await end(ana, ben);
      }
      expect(await invariants(w.published)).toEqual({ dangling: 0, orphans: 0, versions: 2 });
    }, LOCK_RACE_TIMEOUT);

    it("two deletes sharing an input: without the lock each sees the other's definition and the input is orphaned; with it, the second frees it", async () => {
      for (const withLock of [false, true]) {
        await truncateAll(ownerDb);
        const w = await world();
        const input = await inputOn(w.published);
        const inV1 = await definitionIn(w.published, await suiteOn(w.published), input);
        const inV2 = await definitionIn(w.published, await suiteOn(w.published, {}, w.published.v2), input);
        const ana = await session({ userId: w.ana, organizationId: w.a });
        const ben = await session({ userId: w.ben, organizationId: w.a });
        try {
          if (withLock) {
            await lockConfiguration(ana, w.published);
            const fromAna = await deleteDefinition(ana, inV1.id);
            expect(await freeUnused(ana, fromAna)).toEqual([]);
            const benLocked = settle(lockConfiguration(ben, w.published));
            await waitsOnLock(ben.pid);
            await ana.query("commit");
            expect((await benLocked).ok).toBe(true);
            const fromBen = await deleteDefinition(ben, inV2.id);
            expect(await freeUnused(ben, fromBen)).toEqual([input.id]);
            await ben.query("commit");
          } else {
            const fromAna = await deleteDefinition(ana, inV1.id);
            const fromBen = await deleteDefinition(ben, inV2.id);
            expect(await freeUnused(ana, fromAna)).toEqual([]);
            expect(await freeUnused(ben, fromBen)).toEqual([]);
            await ana.query("commit");
            await ben.query("commit");
          }
        } finally {
          await end(ana, ben);
        }
        expect({ withLock, ...(await invariants(w.published)) }).toEqual({
          withLock,
          dangling: 0,
          orphans: withLock ? 0 : 1,
          versions: 2,
        });
      }
    }, LOCK_RACE_TIMEOUT);

    it("a suite delete frees exactly the inputs nothing else names: its definitions' distinct inputs read first, the suite deleted, then the candidates freed", async () => {
      const w = await world();
      const [i1, i2, i3] = [await inputOn(w.published), await inputOn(w.published), await inputOn(w.published)];
      const kept = await inputOn(w.published);
      const suite = await suiteOn(w.published);
      await definitionIn(w.published, suite, i1);
      await definitionIn(w.published, suite, i2);
      await definitionIn(w.published, suite, i3);
      await definitionIn(w.published, suite, i1);
      const other = await suiteOn(w.published, {}, w.published.v2);
      await definitionIn(w.published, other, i3);
      await definitionIn(w.published, other, kept);
      const ana = await session({ userId: w.ana, organizationId: w.a });
      try {
        await lockConfiguration(ana, w.published);
        const candidates = (
          await ana.query<{ input_id: string }>("select distinct input_id from test_definitions where test_suite_id = $1", [
            suite.id,
          ])
        ).rows.map((row) => row.input_id);
        expect(candidates.sort()).toEqual([i1.id, i2.id, i3.id].sort());
        expect((await ana.query("delete from test_suites where id = $1", [suite.id])).rowCount).toBe(1);
        expect(await freeUnused(ana, candidates)).toEqual([i1.id, i2.id].sort());
        await ana.query("commit");
      } finally {
        await end(ana);
      }
      expect(
        (await ownerDb.selectFrom("test_definition_inputs").select("id").orderBy("id").execute()).map((row) => row.id),
      ).toEqual([i3.id, kept.id].sort());
      expect(await invariants(w.published)).toMatchObject({ dangling: 0, orphans: 0 });
    });
  });
});
