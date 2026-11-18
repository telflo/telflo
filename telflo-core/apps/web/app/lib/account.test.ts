import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_READ_TIMEOUT_MS, useAccountRead } from "./account.js";
import { ApiError } from "./api-client.js";

/*
 * The Account cards' read (D21 Task 10, Ruling 89): the 10 s hang guard, a
 * later read winning over an earlier one's late answer, an unmounted card
 * taking none, and a session that ended saying nothing. The reviewer's
 * probes P1-P3, kept as tests.
 */

/** A load whose answers the test gives, one per call, and the signals it was handed. */
function heldLoads() {
  const answers: Array<{ resolve: (value: string) => void; reject: (failure: unknown) => void }> = [];
  const signals: AbortSignal[] = [];
  const load = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      signals.push(signal);
      answers.push({ resolve, reject });
    });
  return { load, answers, signals };
}

const sessionEnded = () => new ApiError("unauthenticated", "Your session has ended.", { status: 401 });

describe("useAccountRead", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts a read that hasn't answered at 10 s, not a moment sooner, and shows it failed", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const load = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new ApiError("request_aborted", "The request was aborted."))),
      );
    };
    const { result } = renderHook(() => useAccountRead(load));
    expect(result.current.read).toEqual({ kind: "loading" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCOUNT_READ_TIMEOUT_MS - 1);
    });
    expect(ACCOUNT_READ_TIMEOUT_MS).toBe(10_000);
    expect(seen?.aborted).toBe(false);
    expect(result.current.read).toEqual({ kind: "loading" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(seen?.aborted).toBe(true);
    expect(result.current.read).toEqual({ kind: "failed" });
  });

  it("stands the guard down once the read answers", async () => {
    vi.useFakeTimers();
    const { load, answers, signals } = heldLoads();
    const { result } = renderHook(() => useAccountRead(load));
    await act(async () => {
      answers[0]?.resolve("read");
    });
    expect(result.current.read).toEqual({ kind: "read", value: "read" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCOUNT_READ_TIMEOUT_MS * 2);
    });
    expect(signals[0]?.aborted).toBe(false);
    expect(result.current.read).toEqual({ kind: "read", value: "read" });
  });

  it("a later read wins over an earlier read's late answer, and its late failure", async () => {
    const { load, answers } = heldLoads();
    const { result } = renderHook(() => useAccountRead(load));
    act(() => result.current.reload());
    expect(answers).toHaveLength(2);

    await act(async () => {
      answers[1]?.resolve("second");
    });
    expect(result.current.read).toEqual({ kind: "read", value: "second" });

    await act(async () => {
      answers[0]?.resolve("first");
    });
    expect(result.current.read).toEqual({ kind: "read", value: "second" });

    act(() => result.current.reload());
    await act(async () => {
      answers[2]?.resolve("third");
    });
    act(() => result.current.reload());
    await act(async () => {
      answers[3]?.resolve("fourth");
      answers[2]?.reject(new ApiError("internal_error", "Something went wrong.", { status: 500 }));
    });
    expect(result.current.read).toEqual({ kind: "read", value: "fourth" });
  });

  it("keeps what is shown while a reload runs, and a failed read shows loading again on its reload", async () => {
    const { load, answers } = heldLoads();
    const { result } = renderHook(() => useAccountRead(load));
    await act(async () => {
      answers[0]?.reject(new ApiError("internal_error", "Something went wrong.", { status: 500 }));
    });
    expect(result.current.read).toEqual({ kind: "failed" });

    act(() => result.current.reload());
    expect(result.current.read).toEqual({ kind: "loading" });
    await act(async () => {
      answers[1]?.resolve("read");
    });
    expect(result.current.read).toEqual({ kind: "read", value: "read" });

    act(() => result.current.reload());
    expect(result.current.read).toEqual({ kind: "read", value: "read" });
  });

  it("an unmounted card takes no answer", async () => {
    const error = vi.spyOn(console, "error");
    const { load, answers } = heldLoads();
    const { result, unmount } = renderHook(() => useAccountRead(load));
    unmount();
    await act(async () => {
      answers[0]?.resolve("late");
    });
    expect(result.current.read).toEqual({ kind: "loading" });
    expect(error).not.toHaveBeenCalled();
  });

  it("a session that ended says nothing: no failed state, what was shown stays", async () => {
    const { load, answers } = heldLoads();
    const { result } = renderHook(() => useAccountRead(load));
    await act(async () => {
      answers[0]?.reject(sessionEnded());
    });
    expect(result.current.read).toEqual({ kind: "loading" });

    act(() => result.current.reload());
    await act(async () => {
      answers[1]?.resolve("read");
    });
    act(() => result.current.reload());
    await act(async () => {
      answers[2]?.reject(sessionEnded());
    });
    expect(result.current.read).toEqual({ kind: "read", value: "read" });
  });
});
