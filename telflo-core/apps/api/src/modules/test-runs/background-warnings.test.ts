import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { createTestRunDispatcher } from "./dispatcher.js";
import { createTestRunReaper } from "./reaper.js";
import { createTestRunQueueSignal } from "./test-runs-dependencies.js";

// The dispatcher's and the reaper's database warnings: while the database is
// down every tick and every pass fails, and each would log a line; instead
// the first is logged, then at most one a minute, then one line when it
// works again. A stand-in database fails or answers every transaction; fake
// timers move the clock.

/** A database whose every transaction fails (a refused connection) until `isUp`, then answers `answer`. */
function standInDatabase(answer: unknown) {
  const state = { isUp: false };
  const db = {
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async () => {
          if (!state.isUp) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
          return answer;
        },
      }),
    }),
  } as unknown as Kysely<Database>;
  return { db, state };
}

function recordingLog() {
  const lines: Array<{ details: Record<string, unknown>; message: string }> = [];
  return {
    lines,
    warn: (details: Record<string, unknown>, message: string) => void lines.push({ details, message }),
    error: (details: Record<string, unknown>, message: string) => void lines.push({ details, message }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the background loops' database warnings", () => {
  it("the dispatcher: a claim failing every second logs once, then once a minute, then one recovery line", async () => {
    const { db, state } = standInDatabase([]);
    const log = recordingLog();
    const dispatcher = createTestRunDispatcher({
      db,
      fileStore: UNCALLED_FILE_STORE,
      tester: UNCALLED_TESTING.tester,
      evaluator: UNCALLED_TESTING.ottlEvaluator,
      organizationVariables: UNCALLED_TESTING.organizationVariables,
      queued: createTestRunQueueSignal(),
      runsPerTester: 4,
      log,
    });

    for (let second = 0; second < 60; second += 1) {
      vi.setSystemTime(second * 1000);
      expect(await dispatcher.tick()).toBe(0);
    }
    expect(log.lines.map((line) => line.message)).toEqual(["test runs could not be claimed; the next tick tries again"]);
    expect(log.lines[0]!.details).toEqual({ err: { name: "Error", code: "ECONNREFUSED" } });

    vi.setSystemTime(60_000);
    await dispatcher.tick();
    expect(log.lines).toHaveLength(2);

    state.isUp = true;
    vi.setSystemTime(61_000);
    await dispatcher.tick();
    await dispatcher.tick();
    expect(log.lines.map((line) => line.message)).toEqual([
      "test runs could not be claimed; the next tick tries again",
      "test runs could not be claimed; the next tick tries again",
      "test runs can be claimed again",
    ]);
    await dispatcher.stop();
  });

  it("the reaper: passes failing every 5 s log once, then once a minute, then one recovery line", async () => {
    const { db, state } = standInDatabase([]);
    const log = recordingLog();
    const reaper = createTestRunReaper({ db, downFailAfterSeconds: 600, log });

    for (let second = 0; second < 60; second += 5) {
      vi.setSystemTime(second * 1000);
      expect(await reaper.runOnce()).toEqual({ reaped: [], failedWaiting: [] });
    }
    // Both rules fail on each pass: one failure a pass, one line in all, naming both rules.
    const facts = { name: "Error", code: "ECONNREFUSED" };
    expect(log.lines).toEqual([
      { details: { rules: { reap: facts, fail_waiting: facts } }, message: "the test-run reaper's rules failed; the next pass tries again" },
    ]);

    vi.setSystemTime(60_000);
    await reaper.runOnce();
    expect(log.lines).toHaveLength(2);
    // Twelve passes before it, eleven left out: passes are counted, not rules.
    expect(log.lines[1]!.details).toMatchObject({ failures: 13, leftOut: 11 });

    state.isUp = true;
    await reaper.runOnce();
    await reaper.runOnce();
    expect(log.lines.at(-1)!.message).toBe("the test-run reaper's rules run again");
    expect(log.lines).toHaveLength(3);
  });
});
