import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottledWarning, THROTTLED_WARNING_INTERVAL_MS } from "./throttled-warning.js";

// A repeated database call's warning (D14a Ruling 40): the first failure,
// then at most one a minute while they last, then one recovery line. Fake
// timers move the clock.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

function harness() {
  const lines: Array<{ details: Record<string, unknown>; message: string }> = [];
  const warning = createThrottledWarning(
    { warn: (details, message) => lines.push({ details, message }) },
    { failed: "it failed", recovered: "it works again" },
  );
  return { lines, warning };
}

describe("a throttled database warning", () => {
  it("waits a minute between failure lines", () => {
    expect(THROTTLED_WARNING_INTERVAL_MS).toBe(60_000);
  });

  it("logs the first failure, then at most one a minute while they last, counting what it left out", () => {
    const { lines, warning } = harness();
    warning.failed({ code: "ECONNREFUSED" });
    for (let second = 1; second < 60; second += 1) {
      vi.setSystemTime(second * 1000);
      warning.failed({ code: "ECONNREFUSED" });
    }
    expect(lines).toEqual([{ details: { code: "ECONNREFUSED" }, message: "it failed" }]);

    vi.setSystemTime(60_000);
    warning.failed({ code: "ECONNREFUSED" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ details: { code: "ECONNREFUSED", failures: 61, leftOut: 59 }, message: "it failed" });

    vi.setSystemTime(90_000);
    warning.failed({ code: "ECONNREFUSED" });
    expect(lines).toHaveLength(2);
  });

  it("logs one recovery line after failures, and nothing for a success that follows a success", () => {
    const { lines, warning } = harness();
    warning.succeeded();
    expect(lines).toEqual([]);

    warning.failed({});
    warning.failed({});
    vi.setSystemTime(5_000);
    warning.succeeded();
    warning.succeeded();
    expect(lines).toEqual([
      { details: {}, message: "it failed" },
      { details: { failures: 2, failingForMs: 5_000 }, message: "it works again" },
    ]);

    // A new run of failures starts with a line at once.
    warning.failed({});
    expect(lines).toHaveLength(3);
  });
});
