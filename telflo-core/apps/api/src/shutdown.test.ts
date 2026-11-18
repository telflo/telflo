import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShutdownHandlers, SHUTDOWN_GRACE_MS } from "./shutdown.js";

// The API's shutdown (D14a Preflight ruling 7): SIGTERM and SIGINT close the
// server and exit, with a hard exit after about 8 s, inside compose's 10 s.
// A process stand-in carries the signals; fake timers stand in for the
// grace period.

function harness(close: () => Promise<void>) {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const lines: string[] = [];
  installShutdownHandlers({
    close,
    exit: (code) => exits.push(code),
    log: { info: (_details, message) => lines.push(message), error: (_details, message) => lines.push(message) },
    signals: signals as unknown as Pick<NodeJS.Process, "on">,
  });
  return { signals, exits, lines };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the API's shutdown", () => {
  it("gives a shutdown 8 s", () => {
    expect(SHUTDOWN_GRACE_MS).toBe(8_000);
  });

  it.each(["SIGTERM", "SIGINT"])("%s closes the server, then exits 0", async (signal) => {
    let closes = 0;
    const { signals, exits } = harness(async () => {
      closes += 1;
    });
    signals.emit(signal, signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
    // The hard exit was cleared.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS * 2);
    expect(exits).toEqual([0]);
  });

  it("a close that fails exits 1", async () => {
    const { signals, exits } = harness(() => Promise.reject(new Error("the pool would not end")));
    signals.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([1]);
  });

  it("a close that hangs: a hard exit 1 after the grace period, not before", async () => {
    const { signals, exits } = harness(() => new Promise<void>(() => undefined));
    signals.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([1]);
  });

  it("SIGTERM twice: the second finds the handler (no default kill) and changes nothing (Ruling 41)", async () => {
    let closes = 0;
    let finish = (): void => undefined;
    const { signals, exits } = harness(() => {
      closes += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    signals.emit("SIGTERM", "SIGTERM");
    // Node ends the process on a signal with no listener: one must remain.
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    signals.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(closes).toBe(1);
    expect(exits).toEqual([]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([0]);
  });

  it("a second signal while shutting down changes nothing", async () => {
    let closes = 0;
    let finish = (): void => undefined;
    const { signals, exits } = harness(() => {
      closes += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGINT", "SIGINT");
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
  });
});
