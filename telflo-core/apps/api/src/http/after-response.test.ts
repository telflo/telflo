import { afterEach, describe, expect, it, vi } from "vitest";
import { createAfterResponseRunner, createCollectingRunner } from "./after-response.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createAfterResponseRunner", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
  });

  it("runs the task after the current turn, not during it", async () => {
    const log = { error: vi.fn() };
    const run = createAfterResponseRunner(log);
    const task = vi.fn(async () => undefined);

    run(task);
    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();

    await nextTurn();
    await nextTurn();
    expect(task).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a rejecting task at error and lets no unhandled rejection escape", async () => {
    process.on("unhandledRejection", onUnhandled);
    const log = { error: vi.fn() };
    const run = createAfterResponseRunner(log);
    const failure = new Error("the mail server is down");

    run(async () => {
      throw failure;
    });
    run(() => {
      throw failure;
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();

    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
    expect(unhandled).toEqual([]);
  });
});

describe("createCollectingRunner", () => {
  it("only queues on run, and settle runs and waits for every task", async () => {
    const runner = createCollectingRunner();
    const done: string[] = [];

    runner.run(async () => {
      await nextTurn();
      done.push("first");
    });
    runner.run(async () => {
      done.push("second");
    });
    await nextTurn();
    expect(done).toEqual([]);

    await runner.settle();
    expect(done).toEqual(["first", "second"]);
  });

  it("rethrows the first failure from settle, after running the rest", async () => {
    const runner = createCollectingRunner();
    const later = vi.fn(async () => undefined);

    runner.run(async () => {
      throw new Error("first failure");
    });
    runner.run(async () => {
      throw new Error("second failure");
    });
    runner.run(later);

    await expect(runner.settle()).rejects.toThrow("first failure");
    expect(later).toHaveBeenCalledTimes(1);
    // The queue is empty afterwards.
    await expect(runner.settle()).resolves.toBeUndefined();
  });
});
