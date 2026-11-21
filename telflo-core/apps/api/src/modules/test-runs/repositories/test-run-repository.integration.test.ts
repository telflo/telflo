import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestRun,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext } from "../../../database/context.js";
import { createTestRunRepository, type ITestRunRepository } from "./test-run-repository.js";

/*
 * The test runs' repository. Visibility is checked twice: as the API's role,
 * where row-level security stands behind the repository, and as the tables'
 * owner, which it doesn't constrain, so the repository's own rule answers.
 */
describe("test run repository", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
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

  /** Ana and Ben in one group organization; Ana's draft and her published configuration, each with a version. */
  async function world() {
    const ana = await createUserWithOrganization(ownerDb);
    const { organization: group } = await addMembership(ownerDb, { userId: ana.user.id, role: "admin" });
    const ben = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: ben.user.id, role: "contributor", organizationId: group.id });
    const draft = await addConfiguration(ownerDb, { organizationId: group.id, created_by_user_id: ana.user.id });
    const draftVersion = await addConfigurationVersion(ownerDb, { configurationId: draft.id, organizationId: group.id });
    const published = await addConfiguration(ownerDb, { organizationId: group.id, created_by_user_id: ana.user.id });
    const publishedVersion = await addConfigurationVersion(ownerDb, {
      configurationId: published.id,
      organizationId: group.id,
      publishedAt: new Date(),
    });
    return {
      ana: ana.user.id,
      ben: ben.user.id,
      anaPersonal: ana.organization.id,
      group: group.id,
      draft: { configurationId: draft.id, versionId: draftVersion.id },
      published: { configurationId: published.id, versionId: publishedVersion.id },
    };
  }

  const run = (
    organizationId: string,
    target: { configurationId: string; versionId: string },
    queuedByUserId: string,
    state: Parameters<typeof addTestRun>[1]["state"] = {},
  ) =>
    addTestRun(ownerDb, {
      organizationId,
      configurationId: target.configurationId,
      configurationVersionId: target.versionId,
      queuedByUserId,
      state,
    });

  const as = <Result>(
    connection: Kysely<Database>,
    userId: string,
    organizationId: string,
    work: (runs: ITestRunRepository) => Promise<Result>,
  ) =>
    withDatabaseContext(connection, { userId, organizationId }, (transaction) =>
      work(createTestRunRepository(transaction, { organizationId, userId })),
    );

  describe.each([
    ["as the API's role", () => db],
    ["as the tables' owner, past row-level security", () => ownerDb],
  ] as const)("%s", (_label, connection) => {
    it("shows a draft's runs to its author only, and a published configuration's to every member", async () => {
      const w = await world();
      const draftRun = await run(w.group, w.draft, w.ana);
      const publishedRun = await run(w.group, w.published, w.ana);

      await as(connection(), w.ben, w.group, async (runs) => {
        // A teammate can't reach another member's draft's run by its id.
        expect(await runs.find(draftRun.id)).toBeUndefined();
        expect(await runs.listForVersion(w.draft.configurationId, w.draft.versionId, 100)).toEqual([]);
        expect((await runs.find(publishedRun.id))?.id).toBe(publishedRun.id);
      });
      await as(connection(), w.ana, w.group, async (runs) => {
        expect((await runs.find(draftRun.id))?.id).toBe(draftRun.id);
      });
    });

    it("hides a deleted configuration's runs", async () => {
      const w = await world();
      const publishedRun = await run(w.group, w.published, w.ana);
      await ownerDb
        .updateTable("configurations")
        .set({ deleted_at: new Date() })
        .where("id", "=", w.published.configurationId)
        .execute();

      await as(connection(), w.ana, w.group, async (runs) => {
        expect(await runs.find(publishedRun.id)).toBeUndefined();
        expect(await runs.listForVersion(w.published.configurationId, w.published.versionId, 100)).toEqual([]);
      });
    });

    it("never finds another organization's run, nor one of another version by its version", async () => {
      const w = await world();
      const publishedRun = await run(w.group, w.published, w.ana);

      await as(connection(), w.ana, w.anaPersonal, async (runs) => {
        expect(await runs.find(publishedRun.id)).toBeUndefined();
      });
      await as(connection(), w.ana, w.group, async (runs) => {
        expect(await runs.findInVersion(w.draft.configurationId, w.draft.versionId, publishedRun.id)).toBeUndefined();
        expect(
          (await runs.findInVersion(w.published.configurationId, w.published.versionId, publishedRun.id))?.id,
        ).toBe(publishedRun.id);
      });
    });
  });

  it("lists a version's runs newest first, at most the limit", async () => {
    const w = await world();
    const ids = [];
    for (let minute = 0; minute < 3; minute += 1) {
      const queuedAt = new Date(Date.UTC(2026, 0, 1, 0, minute));
      ids.push((await run(w.group, w.published, w.ana, { queued_at: queuedAt })).id);
    }
    const listed = await as(db, w.ben, w.group, (runs) =>
      runs.listForVersion(w.published.configurationId, w.published.versionId, 2),
    );
    expect(listed.map((each) => each.id)).toEqual([ids[2], ids[1]]);
  });

  it("counts the person's waiting runs in the context's organization only", async () => {
    const w = await world();
    const personal = await addConfiguration(ownerDb, { organizationId: w.anaPersonal, created_by_user_id: w.ana });
    const personalVersion = await addConfigurationVersion(ownerDb, {
      configurationId: personal.id,
      organizationId: w.anaPersonal,
    });
    await run(w.group, w.published, w.ana);
    await run(w.group, w.draft, w.ana);
    await run(w.anaPersonal, { configurationId: personal.id, versionId: personalVersion.id }, w.ana);
    // Not waiting, or not hers.
    await run(w.group, w.published, w.ana, {
      status: "failed",
      queued_at: new Date(Date.UTC(2026, 0, 1, 0, 0)),
      finished_at: new Date(Date.UTC(2026, 0, 1, 0, 1)),
      error_code: "interrupted",
      error_message: "The run was interrupted. Run it again.",
    });
    await run(w.group, w.published, w.ben);

    // Her run in her personal organization counts there, not in the group.
    expect(await as(db, w.ana, w.group, (runs) => runs.waitingForCurrentUser())).toBe(2);
    expect(await as(db, w.ana, w.anaPersonal, (runs) => runs.waitingForCurrentUser())).toBe(1);
    expect(await as(db, w.ben, w.group, (runs) => runs.waitingForCurrentUser())).toBe(1);
  });

  it("keys the person's queue lock by person and organization: hers elsewhere and a teammate's never wait on it; hers here does", async () => {
    const w = await world();

    /** How many backends of this database wait on an advisory lock. */
    const advisoryWaits = async () => {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting
          from pg_locks
         where locktype = 'advisory'
           and not granted
           and database = (select oid from pg_database where datname = current_database())
      `.execute(ownerDb);
      return rows[0]?.waiting ?? 0;
    };

    /** Takes the lock as `userId` in `organizationId`; answers whether it ended without ever waiting, or waited (then ends once released). */
    const lockAs = (userId: string, organizationId: string) => {
      const tracked = { isSettled: false, done: as(db, userId, organizationId, (runs) => runs.lockQueueForCurrentUser()) };
      void tracked.done.then(() => {
        tracked.isSettled = true;
      });
      return tracked;
    };
    const outcome = async (tracked: ReturnType<typeof lockAs>): Promise<"took it" | "waited"> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (tracked.isSettled) return "took it";
        if ((await advisoryWaits()) >= 1) return "waited";
        if (Date.now() > deadline) throw new Error("the lock neither ended nor waited");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let isHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      isHeld = resolve;
    });
    const holder = as(db, w.ana, w.group, async (runs) => {
      await runs.lockQueueForCurrentUser();
      isHeld();
      await released;
    });
    const others: Array<ReturnType<typeof lockAs>> = [];
    try {
      await held;
      // Hers in another organization, and a teammate's in the group: neither waits on hers in the group.
      for (const [userId, organizationId] of [
        [w.ana, w.anaPersonal],
        [w.ben, w.group],
      ] as const) {
        const other = lockAs(userId, organizationId);
        others.push(other);
        expect(await outcome(other)).toBe("took it");
      }
      // Hers in the group waits for it.
      const again = lockAs(w.ana, w.group);
      others.push(again);
      expect(await outcome(again)).toBe("waited");
    } finally {
      release();
      await holder;
      await Promise.all(others.map((other) => other.done));
    }
  });

  it("answers ahead only for the waiting runs the viewer can see", async () => {
    const w = await world();
    const first = await run(w.group, w.draft, w.ana, { queued_at: new Date(Date.UTC(2026, 0, 1, 0, 0)) });
    const second = await run(w.group, w.published, w.ana, { queued_at: new Date(Date.UTC(2026, 0, 1, 0, 1)) });

    const forAna = await as(db, w.ana, w.group, (runs) => runs.aheadOf([first.id, second.id, randomUUID()]));
    expect(Object.fromEntries(forAna)).toEqual({ [first.id]: 0, [second.id]: 1 });
    const forBen = await as(db, w.ben, w.group, (runs) => runs.aheadOf([first.id, second.id]));
    expect(Object.fromEntries(forBen)).toEqual({ [second.id]: 1 });
    expect(await as(db, w.ben, w.group, (runs) => runs.aheadOf([]))).toEqual(new Map());
  });
});
