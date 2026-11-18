import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TesterHealthResult } from "./client.js";
import {
  createOtelcolTestingHealthMonitor,
  OTELCOL_TESTING_DOWN_AFTER_FAILURES,
  OTELCOL_TESTING_HEALTH_INTERVAL_MS,
  type OtelcolTestingHealthMonitor,
} from "./health-monitor.js";

// The tester's health monitor (D14a decision 12, Preflight ruling 7, Ruling
// 38), with fake timers, a scripted health check and a shared row held in
// memory, every write recorded: down on the second failed check in a row and
// not the first, a success clearing the row whenever it says down (up wins),
// a write only when the row disagrees with the check, a 503
// version_unavailable no failure. health-monitor.integration.test.ts writes
// the real row.

const UP: TesterHealthResult = { kind: "up" };
const DOWN: TesterHealthResult = { kind: "down", reason: "connection_refused" };
const VERSION_UNAVAILABLE: TesterHealthResult = { kind: "version_unavailable" };

const WENT_DOWN = new Date("2026-10-09T10:00:00.000Z");
/** When another process marked the row down. */
const OTHER_PROCESS_WENT_DOWN = new Date("2026-10-09T09:00:00.000Z");

interface Harness {
  monitor: OtelcolTestingHealthMonitor;
  /** The check's next answers, in order; the last repeats. */
  answers: TesterHealthResult[];
  /** Every write of this monitor, in order: true for up, false for down. */
  writes: boolean[];
  /** The shared row, as every process sees it: another process may change it. */
  row: { downSince: Date | null };
  checks: () => number;
  failNextWrite: () => void;
  failNextRead: () => void;
}

function harness(answers: TesterHealthResult[], row: { downSince: Date | null } = { downSince: null }): Harness {
  const writes: boolean[] = [];
  let checks = 0;
  let isNextWriteFailing = false;
  let isNextReadFailing = false;
  const state = { answers };
  const monitor = createOtelcolTestingHealthMonitor({
    check: async () => {
      checks += 1;
      return state.answers.length > 1 ? state.answers.shift()! : state.answers[0]!;
    },
    // otelcol_testing_mark's rule: up clears; down keeps the first time.
    mark: async (isUp) => {
      if (isNextWriteFailing) {
        isNextWriteFailing = false;
        throw new Error("the database is unreachable");
      }
      writes.push(isUp);
      row.downSince = isUp ? null : (row.downSince ?? WENT_DOWN);
      return row.downSince;
    },
    read: async () => {
      if (isNextReadFailing) {
        isNextReadFailing = false;
        throw new Error("the database is unreachable");
      }
      return row.downSince;
    },
    log: { warn: () => undefined, error: () => undefined },
  });
  return {
    monitor,
    answers: state.answers,
    writes,
    row,
    checks: () => checks,
    failNextWrite: () => {
      isNextWriteFailing = true;
    },
    failNextRead: () => {
      isNextReadFailing = true;
    },
  };
}

/** Runs `count` checks by the monitor's own timer: the first at once, then every interval. */
async function tick(count: number, isFirst = false): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await vi.advanceTimersByTimeAsync(isFirst && index === 0 ? 0 : OTELCOL_TESTING_HEALTH_INTERVAL_MS);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the collector tester's health monitor", () => {
  it("checks every 5 s, counting the tester down after 2 failed checks (decision 12)", () => {
    expect(OTELCOL_TESTING_HEALTH_INTERVAL_MS).toBe(5_000);
    expect(OTELCOL_TESTING_DOWN_AFTER_FAILURES).toBe(2);
  });

  it("checks at once, then 5 s after each check, until stopped", async () => {
    const { monitor, checks } = harness([UP]);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(OTELCOL_TESTING_HEALTH_INTERVAL_MS - 1);
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks()).toBe(2);

    await monitor.stop();
    await vi.advanceTimersByTimeAsync(OTELCOL_TESTING_HEALTH_INTERVAL_MS * 10);
    expect(checks()).toBe(2);
  });

  it("is not down after one failed check, and is after the second in a row, with the time the row gives", async () => {
    const { monitor, writes } = harness([DOWN]);
    monitor.start();

    await tick(1, true);
    expect(monitor.view()).toEqual({ state: "unknown", consecutiveFailures: 1, downSince: null });
    expect(writes).toEqual([]);

    await tick(1);
    expect(monitor.view()).toEqual({ state: "down", consecutiveFailures: 2, downSince: WENT_DOWN });
    expect(writes).toEqual([false]);
    await monitor.stop();
  });

  it("one failed check between successes never counts it down", async () => {
    const { monitor, writes } = harness([UP, DOWN, UP, DOWN, UP]);
    monitor.start();
    await tick(5, true);

    // The row said up all along: nothing to write.
    expect(writes).toEqual([]);
    expect(monitor.view()).toEqual({ state: "up", consecutiveFailures: 0, downSince: null });
    await monitor.stop();
  });

  it("is up again after the first successful check", async () => {
    const { monitor, writes } = harness([DOWN, DOWN, UP]);
    monitor.start();
    await tick(2, true);
    expect(monitor.view().state).toBe("down");

    await tick(1);
    expect(monitor.view()).toEqual({ state: "up", consecutiveFailures: 0, downSince: null });
    expect(writes).toEqual([false, true]);
    await monitor.stop();
  });

  it("writes only when the row disagrees with the check, never a check that changes nothing", async () => {
    const { monitor, writes } = harness([UP, UP, UP, DOWN, DOWN, DOWN, DOWN, UP, UP, DOWN, UP]);
    monitor.start();
    await tick(11, true);

    // Down at the second failure in a row, up at the next success; nothing else.
    expect(writes).toEqual([false, true]);
    await monitor.stop();
  });

  it("a 503 version_unavailable is not a failed check (Preflight ruling 13): it breaks a run of failures", async () => {
    const { monitor, writes } = harness([DOWN, VERSION_UNAVAILABLE, DOWN, VERSION_UNAVAILABLE, DOWN]);
    monitor.start();
    await tick(5, true);

    // Each version_unavailable answers as the tester up, and the row says so already.
    expect(writes).toEqual([]);
    expect(monitor.view()).toEqual({ state: "up", consecutiveFailures: 1, downSince: null });
    await monitor.stop();
  });

  describe("up wins across processes (Ruling 38)", () => {
    it("a down left in the row by a process that has died is cleared at this process's first success", async () => {
      const { monitor, writes, row } = harness([UP], { downSince: OTHER_PROCESS_WENT_DOWN });
      monitor.start();
      await tick(1, true);

      expect(writes).toEqual([true]);
      expect(row.downSince).toBeNull();
      expect(monitor.view()).toEqual({ state: "up", consecutiveFailures: 0, downSince: null });
      await monitor.stop();
    });

    it("a down written after this process last saw up is cleared at its next success: each check reads the row", async () => {
      const { monitor, writes, row } = harness([UP]);
      monitor.start();
      await tick(2, true);
      expect(writes).toEqual([]);

      // Another process's two failures, and then it dies.
      row.downSince = OTHER_PROCESS_WENT_DOWN;
      await tick(1);
      expect(writes).toEqual([true]);
      expect(row.downSince).toBeNull();
      await monitor.stop();
    });

    it("the row is marked down only after this process's own two failures in a row, whatever it says", async () => {
      const { monitor, writes, row } = harness([DOWN, UP, DOWN, DOWN]);
      monitor.start();
      await tick(3, true);
      expect(writes).toEqual([]);
      expect(row.downSince).toBeNull();

      await tick(1);
      expect(writes).toEqual([false]);
      expect(row.downSince).toEqual(WENT_DOWN);
      await monitor.stop();
    });

    it("a down another process marked is taken as it is: its time, no write", async () => {
      const { monitor, writes } = harness([DOWN], { downSince: OTHER_PROCESS_WENT_DOWN });
      monitor.start();
      await tick(2, true);

      expect(writes).toEqual([]);
      expect(monitor.view()).toEqual({ state: "down", consecutiveFailures: 2, downSince: OTHER_PROCESS_WENT_DOWN });
      await monitor.stop();
    });

    it("cleared by another process's success while this one still fails, it is marked down again at the next failure", async () => {
      const { monitor, writes, row } = harness([DOWN]);
      monitor.start();
      await tick(2, true);
      expect(writes).toEqual([false]);

      row.downSince = null;
      await tick(1);
      expect(writes).toEqual([false, false]);
      expect(monitor.view()).toEqual({ state: "down", consecutiveFailures: 3, downSince: WENT_DOWN });
      await monitor.stop();
    });

    it("a read that fails falls back on this process's view, and the next check reads again", async () => {
      const { monitor, writes, failNextRead, row } = harness([DOWN, DOWN, UP]);
      monitor.start();
      await tick(1, true);
      failNextRead();
      await tick(1);
      // The view was unknown, so the second failure writes.
      expect(writes).toEqual([false]);

      await tick(1);
      expect(writes).toEqual([false, true]);
      expect(row.downSince).toBeNull();
      await monitor.stop();
    });
  });

  it("a shared row that can't be read logs once, then at most once a minute, then one recovery line (Ruling 40)", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(0);
    const lines: string[] = [];
    let isReadable = false;
    const monitor = createOtelcolTestingHealthMonitor({
      check: async () => DOWN,
      mark: async () => WENT_DOWN,
      read: async () => {
        if (!isReadable) throw new Error("the database is unreachable");
        return WENT_DOWN;
      },
      log: { warn: (_details, message) => void lines.push(message), error: (_details, message) => void lines.push(message) },
    });
    monitor.start();
    // The first read is at the second check (5 s); 13 more checks reach 65 s.
    await tick(13, true);
    const unread = "the collector tester's shared health could not be read; the next check tries again";
    expect(lines.filter((line) => line === unread)).toHaveLength(1);
    await tick(1);
    expect(lines.filter((line) => line === unread)).toHaveLength(2);

    isReadable = true;
    await tick(2);
    expect(lines.filter((line) => line === "the collector tester's shared health can be read again")).toHaveLength(1);
    await monitor.stop();
  });

  it("a write that fails leaves the view as it was, so the next check writes again", async () => {
    const { monitor, writes, failNextWrite } = harness([DOWN]);
    monitor.start();
    await tick(1, true);
    failNextWrite();
    await tick(1);
    expect(monitor.view()).toEqual({ state: "unknown", consecutiveFailures: 2, downSince: null });
    expect(writes).toEqual([]);

    await tick(1);
    expect(monitor.view()).toEqual({ state: "down", consecutiveFailures: 3, downSince: WENT_DOWN });
    expect(writes).toEqual([false]);
    await monitor.stop();
  });

  it("checkOnce runs one check, and while one is in flight answers that one", async () => {
    let release = (): void => undefined;
    let checks = 0;
    const monitor = createOtelcolTestingHealthMonitor({
      check: () => {
        checks += 1;
        return new Promise<TesterHealthResult>((resolve) => {
          release = () => resolve(UP);
        });
      },
      mark: async () => null,
      read: async () => null,
    });
    const first = monitor.checkOnce();
    const second = monitor.checkOnce();
    expect(second).toBe(first);
    release();
    await first;
    expect(checks).toBe(1);
    expect(monitor.view().state).toBe("up");
  });

  it("stop aborts a check in flight, which then counts for nothing", async () => {
    let seenSignal: AbortSignal | undefined;
    const writes: boolean[] = [];
    const monitor = createOtelcolTestingHealthMonitor({
      check: ({ signal }) => {
        seenSignal = signal;
        return new Promise<TesterHealthResult>((resolve) => {
          signal.addEventListener("abort", () => resolve({ kind: "down", reason: "network" }), { once: true });
        });
      },
      mark: async (isUp) => {
        writes.push(isUp);
        return null;
      },
      read: async () => null,
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seenSignal?.aborted).toBe(false);

    await monitor.stop();
    expect(seenSignal?.aborted).toBe(true);
    expect(monitor.view()).toEqual({ state: "unknown", consecutiveFailures: 0, downSince: null });
    expect(writes).toEqual([]);
  });
});
