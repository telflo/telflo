import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortAfter } from "./abort-after.js";

describe("abortAfter (the browser requests' hang guard)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts its signal when the time has passed, not before", () => {
    const guard = abortAfter(30_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(29_999);
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(guard.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clear() stands the timer down: the signal never aborts", () => {
    const guard = abortAfter(10_000);
    guard.clear();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(guard.signal.aborted).toBe(false);
  });

  it("abort() aborts at once and stands the timer down", () => {
    const guard = abortAfter(10_000);
    guard.abort();
    expect(guard.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
