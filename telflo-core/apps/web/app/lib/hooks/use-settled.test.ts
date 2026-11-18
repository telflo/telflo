import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettled } from "./use-settled.js";

describe("useSettled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the value once it has stopped changing for the delay, the last one only", () => {
    const { result, rerender } = renderHook(({ value }) => useSettled(value, 300), { initialProps: { value: "" } });
    expect(result.current).toBe("");

    rerender({ value: "a" });
    act(() => void vi.advanceTimersByTime(299));
    rerender({ value: "ab" });
    act(() => void vi.advanceTimersByTime(299));
    expect(result.current).toBe("");

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe("ab");
  });
});
