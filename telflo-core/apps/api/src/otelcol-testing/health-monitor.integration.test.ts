import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { useFakeOtelcolTesting } from "../testing/otelcol-testing.js";
import {
  createOtelcolTestingHealth,
  createOtelcolTestingHealthMonitor,
  markOtelcolTesting,
  readOtelcolTestingDownSince,
} from "./health-monitor.js";

// The tester's health monitor against the real row (migration 028's
// otelcol_testing_state and otelcol_testing_mark): the client of the
// OpenAPI-checked fake asks its health, and each change goes through
// withDispatcherContext to the one row every API process reads. Checks run one
// at a time (checkOnce), so nothing waits on a clock; health-monitor.test.ts
// has the timer's tests.

const tester = useFakeOtelcolTesting();

describe("the collector tester's health, in the shared row", () => {
  let databases: TestDatabases;
  /** The API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: reading the row back. */
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
    tester.fake.setHealth("ready");
  });

  async function rowDownSince(): Promise<Date | null> {
    const row = await ownerDb.selectFrom("otelcol_testing_state").select("down_since").executeTakeFirstOrThrow();
    return row.down_since;
  }

  /** A monitor of the fake, writing through the real function, each write counted. */
  function monitorCountingWrites() {
    const writes: boolean[] = [];
    const monitor = createOtelcolTestingHealthMonitor({
      check: (options) => tester.client.health(options),
      mark: async (isUp) => {
        writes.push(isUp);
        return markOtelcolTesting(db, isUp);
      },
      read: () => readOtelcolTestingDownSince(db),
    });
    return { monitor, writes };
  }

  it("marks the row down at the second failed check, not the first, keeping the time it went down", async () => {
    const { monitor, writes } = monitorCountingWrites();
    tester.fake.setHealth("unavailable");

    await monitor.checkOnce();
    expect(await rowDownSince()).toBeNull();
    expect(writes).toEqual([]);

    await monitor.checkOnce();
    const downSince = await rowDownSince();
    expect(downSince).toBeInstanceOf(Date);
    expect(monitor.view()).toEqual({ state: "down", consecutiveFailures: 2, downSince });
    expect(await readOtelcolTestingDownSince(db)).toEqual(downSince);

    // Still down: nothing is written, and the time stays the first one.
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(writes).toEqual([false]);
    expect(await rowDownSince()).toEqual(downSince);
  });

  it("marks it up at the first successful check after, and writes only on a change", async () => {
    const { monitor, writes } = monitorCountingWrites();
    tester.fake.setHealth("starting");
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(await rowDownSince()).not.toBeNull();

    tester.fake.setHealth("ready");
    await monitor.checkOnce();
    expect(await rowDownSince()).toBeNull();
    expect(monitor.view()).toEqual({ state: "up", consecutiveFailures: 0, downSince: null });

    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(writes).toEqual([false, true]);
  });

  it("a process starting after another marked it down clears the row at its first success", async () => {
    const first = monitorCountingWrites();
    tester.fake.setHealth("unavailable");
    await first.monitor.checkOnce();
    await first.monitor.checkOnce();
    expect(await rowDownSince()).not.toBeNull();

    tester.fake.setHealth("ready");
    const second = monitorCountingWrites();
    await second.monitor.checkOnce();
    expect(await rowDownSince()).toBeNull();
    expect(second.writes).toEqual([true]);
  });

  it("up wins: a down left by a process that died is cleared by a live process whose view was up already", async () => {
    const live = monitorCountingWrites();
    await live.monitor.checkOnce();
    expect(live.monitor.view().state).toBe("up");
    expect(live.writes).toEqual([]);

    // A process marks it down after its own two failures, then dies.
    const dying = monitorCountingWrites();
    tester.fake.setHealth("unavailable");
    await dying.monitor.checkOnce();
    await dying.monitor.checkOnce();
    expect(await rowDownSince()).not.toBeNull();

    tester.fake.setHealth("ready");
    await live.monitor.checkOnce();
    expect(await rowDownSince()).toBeNull();
    expect(live.writes).toEqual([true]);
  });

  it("a second process counting it down keeps the first process's time", async () => {
    const first = monitorCountingWrites();
    const second = monitorCountingWrites();
    tester.fake.setHealth("unavailable");
    await first.monitor.checkOnce();
    await first.monitor.checkOnce();
    const firstTime = await rowDownSince();

    await second.monitor.checkOnce();
    await second.monitor.checkOnce();
    expect(second.monitor.view()).toEqual({ state: "down", consecutiveFailures: 2, downSince: firstTime });
    expect(await rowDownSince()).toEqual(firstTime);
  });

  it("the API's own role reads the shared row with no context, and only the dispatcher's context writes it", async () => {
    expect(await readOtelcolTestingDownSince(db)).toBeNull();
    await expect(sql`select otelcol_testing_mark(false)`.execute(db)).rejects.toMatchObject({ code: "42501" });
    expect(await rowDownSince()).toBeNull();

    const since = await markOtelcolTesting(db, false);
    expect(since).toBeInstanceOf(Date);
    expect(await readOtelcolTestingDownSince(db)).toEqual(since);
    expect(await markOtelcolTesting(db, true)).toBeNull();
  });

  it("createOtelcolTestingHealth wires the client's checks to the row", async () => {
    const monitor = createOtelcolTestingHealth({ client: tester.client, db });
    tester.fake.setHealth("unavailable");
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(await readOtelcolTestingDownSince(db)).not.toBeNull();

    tester.fake.setHealth("ready");
    await monitor.checkOnce();
    expect(await readOtelcolTestingDownSince(db)).toBeNull();
  });
});
