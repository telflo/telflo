import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { useFakeOttlEvaluator } from "../testing/ottl-evaluator.js";
import {
  createOttlEvaluatorHealth,
  createOttlEvaluatorHealthMonitor,
  isOttlEvaluatorKnownDown,
  markOttlEvaluator,
  readOttlEvaluatorDownSince,
} from "./health-monitor.js";

// The OTTL evaluator's health monitor against the real row (D15a decision
// 15, Preflight ruling 23; migration 030's ottl_evaluator_state and
// ottl_evaluator_mark): the client of the OpenAPI-checked fake asks its
// health, and each change goes through withDispatcherContext to the one row
// every API process reads, which queuing reads (isOttlEvaluatorKnownDown).
// Checks run one at a time (checkOnce), so nothing waits on a clock;
// health-monitor.test.ts has the timer's tests.

const evaluator = useFakeOttlEvaluator();

describe("the OTTL evaluator's health, in the shared row", () => {
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
    evaluator.fake.setHealth("up");
  });

  async function rowDownSince(): Promise<Date | null> {
    const row = await ownerDb.selectFrom("ottl_evaluator_state").select("down_since").executeTakeFirstOrThrow();
    return row.down_since;
  }

  /** A monitor of the fake, writing through the real function, each write counted. */
  function monitorCountingWrites() {
    const writes: boolean[] = [];
    const monitor = createOttlEvaluatorHealthMonitor({
      check: (options) => evaluator.client.health(options),
      mark: async (isUp) => {
        writes.push(isUp);
        return markOttlEvaluator(db, isUp);
      },
      read: () => readOttlEvaluatorDownSince(db),
    });
    return { monitor, writes };
  }

  it("marks the row down at the second failed check, not the first, keeping the time it went down; queuing then reads it down", async () => {
    const { monitor, writes } = monitorCountingWrites();
    evaluator.fake.setHealth("down");

    await monitor.checkOnce();
    expect(await rowDownSince()).toBeNull();
    expect(await isOttlEvaluatorKnownDown(db)).toBe(false);
    expect(writes).toEqual([]);

    await monitor.checkOnce();
    const downSince = await rowDownSince();
    expect(downSince).toBeInstanceOf(Date);
    expect(monitor.view()).toEqual({ state: "down", consecutiveFailures: 2, downSince });
    expect(await isOttlEvaluatorKnownDown(db)).toBe(true);

    await monitor.checkOnce();
    expect(writes).toEqual([false]);
    expect(await rowDownSince()).toEqual(downSince);
  });

  it("marks it up at the first successful check after, and writes only on a change", async () => {
    const { monitor, writes } = monitorCountingWrites();
    evaluator.fake.setHealth("down");
    await monitor.checkOnce();
    await monitor.checkOnce();

    evaluator.fake.setHealth("up");
    await monitor.checkOnce();
    expect(await rowDownSince()).toBeNull();
    expect(await isOttlEvaluatorKnownDown(db)).toBe(false);
    await monitor.checkOnce();
    expect(writes).toEqual([false, true]);
  });

  it("is the evaluator's own row: the tester's isn't touched", async () => {
    const { monitor } = monitorCountingWrites();
    evaluator.fake.setHealth("down");
    await monitor.checkOnce();
    await monitor.checkOnce();

    const tester = await ownerDb.selectFrom("otelcol_testing_state").select("down_since").executeTakeFirstOrThrow();
    expect(tester.down_since).toBeNull();
  });

  it("the API's own role reads the shared row with no context, and only the dispatcher's context writes it", async () => {
    expect(await readOttlEvaluatorDownSince(db)).toBeNull();
    await expect(sql`select ottl_evaluator_mark(false)`.execute(db)).rejects.toMatchObject({ code: "42501" });
    expect(await rowDownSince()).toBeNull();

    const since = await markOttlEvaluator(db, false);
    expect(since).toBeInstanceOf(Date);
    expect(await readOttlEvaluatorDownSince(db)).toEqual(since);
    expect(await markOttlEvaluator(db, true)).toBeNull();
  });

  it("createOttlEvaluatorHealth wires the client's checks to the row", async () => {
    const monitor = createOttlEvaluatorHealth({ client: evaluator.client, db });
    evaluator.fake.setHealth("down");
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(await readOttlEvaluatorDownSince(db)).not.toBeNull();

    evaluator.fake.setHealth("up");
    await monitor.checkOnce();
    expect(await readOttlEvaluatorDownSince(db)).toBeNull();
  });
});
