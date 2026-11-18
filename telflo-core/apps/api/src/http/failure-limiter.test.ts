import { describe, expect, it } from "vitest";
import { createFailureLimiter, DEFAULT_FAILURE_LIMITER_MAX_KEYS } from "./failure-limiter.js";

const WINDOW_MS = 15 * 60_000;

function limiterAt(start = 1_000_000, options: { max?: number; maxKeys?: number } = {}) {
  let clock = start;
  const limiter = createFailureLimiter({
    max: options.max ?? 3,
    windowMs: WINDOW_MS,
    ...(options.maxKeys === undefined ? {} : { maxKeys: options.maxKeys }),
    now: () => clock,
  });
  return {
    limiter,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const failTimes = (limiter: ReturnType<typeof createFailureLimiter>, key: string, times: number) => {
  for (let failure = 0; failure < times; failure += 1) limiter.recordFailure(key);
};

describe("createFailureLimiter", () => {
  it("allows a key with no failures, and checking counts nothing", () => {
    const { limiter } = limiterAt();
    for (let check = 0; check < 10; check += 1) {
      expect(limiter.check("a")).toEqual({ isBlocked: false, retryAfterSeconds: 0 });
    }
    expect(limiter.size).toBe(0);
  });

  it("blocks a key once it has max failures, not before", () => {
    const { limiter } = limiterAt();
    failTimes(limiter, "a", 2);
    expect(limiter.check("a").isBlocked).toBe(false);

    limiter.recordFailure("a");
    expect(limiter.check("a")).toEqual({ isBlocked: true, retryAfterSeconds: WINDOW_MS / 1000 });
    expect(limiter.check("b").isBlocked).toBe(false);
  });

  it("reports the whole seconds left in the window, rounded up", () => {
    const { limiter, advance } = limiterAt();
    failTimes(limiter, "a", 3);
    advance(WINDOW_MS - 1_500);
    expect(limiter.check("a").retryAfterSeconds).toBe(2);
    advance(1_499);
    expect(limiter.check("a")).toEqual({ isBlocked: true, retryAfterSeconds: 1 });
  });

  it("forgets a key when its window, opened by the first failure, ends", () => {
    const { limiter, advance } = limiterAt();
    limiter.recordFailure("a");
    advance(WINDOW_MS - 1);
    failTimes(limiter, "a", 2);
    expect(limiter.check("a").isBlocked).toBe(true);

    advance(1);
    expect(limiter.check("a").isBlocked).toBe(false);
    expect(limiter.size).toBe(0);

    // A failure after the window ends opens a fresh one.
    failTimes(limiter, "a", 2);
    expect(limiter.check("a").isBlocked).toBe(false);
  });

  it("counts a key's failures in its live window, 0 once it ends, and counting counts nothing", () => {
    const { limiter, advance } = limiterAt();
    expect(limiter.count("a")).toBe(0);
    failTimes(limiter, "a", 2);
    expect([limiter.count("a"), limiter.count("a"), limiter.count("b")]).toEqual([2, 2, 0]);
    advance(WINDOW_MS);
    expect(limiter.count("a")).toBe(0);
    expect(limiter.size).toBe(0);
  });

  it("starts a key again from zero on reset", () => {
    const { limiter } = limiterAt();
    failTimes(limiter, "a", 3);
    limiter.reset("a");
    expect(limiter.check("a").isBlocked).toBe(false);
    failTimes(limiter, "a", 2);
    expect(limiter.check("a").isBlocked).toBe(false);
  });

  it("takes back one failure on refund, and ignores a refund with nothing to take back", () => {
    const { limiter, advance } = limiterAt();
    failTimes(limiter, "a", 3);
    limiter.refund("a");
    expect(limiter.check("a").isBlocked).toBe(false);

    limiter.refund("a");
    limiter.refund("a");
    expect(limiter.size).toBe(0);
    limiter.refund("a");
    failTimes(limiter, "a", 2);
    expect(limiter.check("a").isBlocked).toBe(false);

    advance(WINDOW_MS);
    limiter.refund("a");
    expect(limiter.size).toBe(0);
  });

  it("says which window a failure was counted in, and refunds only while that window is live (Ruling 45)", () => {
    const { limiter, advance } = limiterAt();
    const first = limiter.recordFailure("a");
    advance(1_000);
    expect(limiter.recordFailure("a")).toBe(first);
    limiter.refund("a", first);
    limiter.refund("a", first + 1);
    failTimes(limiter, "a", 1);
    expect(limiter.check("a").isBlocked).toBe(false);

    advance(WINDOW_MS);
    const next = limiter.recordFailure("a");
    expect(next).toBeGreaterThan(first);
    failTimes(limiter, "a", 2);
    // A refund for the window that ended takes nothing from this one.
    limiter.refund("a", first);
    expect(limiter.check("a").isBlocked).toBe(true);
    limiter.refund("a", next);
    expect(limiter.check("a").isBlocked).toBe(false);
  });

  it("holds at most maxKeys keys, evicting the oldest window first", () => {
    const { limiter, advance } = limiterAt(1_000_000, { max: 1, maxKeys: 3 });
    for (const key of ["a", "b", "c"]) {
      limiter.recordFailure(key);
      advance(1_000);
    }
    limiter.recordFailure("d");

    expect(limiter.size).toBe(3);
    expect(limiter.check("a").isBlocked).toBe(false);
    for (const key of ["b", "c", "d"]) expect(limiter.check(key).isBlocked).toBe(true);

    // Another failure on a held key adds no key.
    limiter.recordFailure("d");
    expect(limiter.size).toBe(3);
  });

  it("stays bounded however many keys are sprayed", () => {
    const { limiter } = limiterAt(1_000_000, { maxKeys: 100 });
    for (let key = 0; key < 5_000; key += 1) limiter.recordFailure(`person-${key}@example.com`);
    expect(limiter.size).toBe(100);
    expect(limiter.check("person-4999@example.com")).toEqual({ isBlocked: false, retryAfterSeconds: 0 });
  });

  it("drops an expired window in front before a live one", () => {
    const { limiter, advance } = limiterAt(1_000_000, { max: 1, maxKeys: 2 });
    limiter.recordFailure("old");
    advance(WINDOW_MS);
    limiter.recordFailure("live");
    limiter.recordFailure("new");

    expect(limiter.size).toBe(2);
    expect(limiter.check("live").isBlocked).toBe(true);
    expect(limiter.check("new").isBlocked).toBe(true);
  });

  it("holds ten thousand keys by default", () => {
    expect(DEFAULT_FAILURE_LIMITER_MAX_KEYS).toBe(10_000);
    const limiter = createFailureLimiter({ max: 1, windowMs: WINDOW_MS });
    for (let key = 0; key < DEFAULT_FAILURE_LIMITER_MAX_KEYS + 5; key += 1) limiter.recordFailure(`k${key}`);
    expect(limiter.size).toBe(DEFAULT_FAILURE_LIMITER_MAX_KEYS);
  });
});
