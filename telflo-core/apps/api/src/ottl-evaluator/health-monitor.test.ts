import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OttlEvaluatorHealthResult } from "./client.js";
import {
  createOttlEvaluatorHealthMonitor,
  OTTL_EVALUATOR_DOWN_AFTER_FAILURES,
  OTTL_EVALUATOR_HEALTH_INTERVAL_MS,
  type OttlEvaluatorHealthMonitor,
} from "./health-monitor.js";

// The OTTL evaluator's health monitor: the tester's monitor, a second instance
// (createServiceHealthMonitor, whose every rule
// otelcol-testing/health-monitor.test.ts tests), with fake timers, a scripted
// check and the shared row held in memory, every write recorded and counted:
// down at the second failed check in a row, not the first; up at the first
// success; a write only when the row disagrees; its own words in the log.
// health-monitor.integration.test.ts writes the real row.

const UP: OttlEvaluatorHealthResult = { kind: "up", ottlVersion: "v0.162.0" };
const DOWN: OttlEvaluatorHealthResult = { kind: "down", reason: "connection_refused" };
const WENT_DOWN = new Date("2026-10-11T10:00:00.000Z");

interface Harness {
  monitor: OttlEvaluatorHealthMonitor;
  writes: boolean[];
  row: { downSince: Date | null };
  checks: () => number;
  warnings: string[];
}

function harness(answers: OttlEvaluatorHealthResult[], row: { downSince: Date | null } = { downSince: null }): Harness {
  const writes: boolean[] = [];
  const warnings: string[] = [];
  let checks = 0;
  const monitor = createOttlEvaluatorHealthMonitor({
    check: async () => {
      checks += 1;
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
    // ottl_evaluator_mark's rule: up clears; down keeps the first time.
    mark: async (isUp) => {
      writes.push(isUp);
      row.downSince = isUp ? null : (row.downSince ?? WENT_DOWN);
      return row.downSince;
    },
    read: async () => row.downSince,
    log: { warn: (_details, message) => void warnings.push(message), error: (_details, message) => void warnings.push(message) },
  });
  return { monitor, writes, row, checks: () => checks, warnings };
}

/** Runs `count` checks by the monitor's own timer: the first at once, then every interval. */
async function tick(count: number, isFirst = false): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await vi.advanceTimersByTimeAsync(isFirst && index === 0 ? 0 : OTTL_EVALUATOR_HEALTH_INTERVAL_MS);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the OTTL evaluator's health monitor", () => {
  it("checks every 5 s, counting the evaluator down after 2 failed checks, as the tester's", () => {
    expect(OTTL_EVALUATOR_HEALTH_INTERVAL_MS).toBe(5_000);
    expect(OTTL_EVALUATOR_DOWN_AFTER_FAILURES).toBe(2);
  });

  it("checks at once, then 5 s after each check, until stopped", async () => {
    const { monitor, checks } = harness([UP]);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(OTTL_EVALUATOR_HEALTH_INTERVAL_MS - 1);
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks()).toBe(2);

    await monitor.stop();
    await vi.advanceTimersByTimeAsync(OTTL_EVALUATOR_HEALTH_INTERVAL_MS * 10);
    expect(checks()).toBe(2);
  });

  it("is not down after one failed check; is after the second in a row, with the row's time, and says so in its own words", async () => {
    const { monitor, writes, warnings } = harness([DOWN]);
    monitor.start();

    await tick(1, true);
    expect(monitor.view()).toEqual({ state: "unknown", consecutiveFailures: 1, downSince: null });
    expect(writes).toEqual([]);

    await tick(1);
    expect(monitor.view()).toEqual({ state: "down", consecutiveFailures: 2, downSince: WENT_DOWN });
    expect(writes).toEqual([false]);
    expect(warnings).toEqual(["the OTTL evaluator is down: runs with validation rules are refused until it answers"]);

    // Still down: nothing more is written.
    await tick(3);
    expect(writes).toEqual([false]);
    await monitor.stop();
  });

  it("is up again at the first successful check, and writes only on a change", async () => {
    const { monitor, writes } = harness([DOWN, DOWN, UP, UP, UP]);
    monitor.start();
    await tick(2, true);
    expect(monitor.view().state).toBe("down");

    await tick(1);
    expect(monitor.view()).toEqual({ state: "up", consecutiveFailures: 0, downSince: null });
    await tick(2);
    expect(writes).toEqual([false, true]);
    await monitor.stop();
  });

  it("one failed check between successes never counts it down", async () => {
    const { monitor, writes } = harness([UP, DOWN, UP, DOWN, UP]);
    monitor.start();
    await tick(5, true);
    expect(writes).toEqual([]);
    expect(monitor.view()).toEqual({ state: "up", consecutiveFailures: 0, downSince: null });
    await monitor.stop();
  });

  it("up wins: a down another process left in the row is cleared at this process's first success", async () => {
    const other = new Date("2026-10-11T09:00:00.000Z");
    const { monitor, writes, row } = harness([UP], { downSince: other });
    monitor.start();
    await tick(1, true);
    expect(writes).toEqual([true]);
    expect(row.downSince).toBeNull();
    await monitor.stop();
  });

  it("a check that throws counts as failed", async () => {
    const writes: boolean[] = [];
    const monitor = createOttlEvaluatorHealthMonitor({
      check: async () => {
        throw new Error("unexpected");
      },
      mark: async (isUp) => {
        writes.push(isUp);
        return isUp ? null : WENT_DOWN;
      },
      read: async () => null,
    });
    monitor.start();
    await tick(2, true);
    expect(writes).toEqual([false]);
    await monitor.stop();
  });
});
