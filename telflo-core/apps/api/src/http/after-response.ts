import type { FastifyBaseLogger } from "fastify";

/**
 * Schedules work to run after the response. The route replies without
 * waiting, so nothing the response waits for depends on what the work finds.
 */
export type RunAfterResponse = (task: () => Promise<void>) => void;

/**
 * The production runner, and buildServer's default. The task starts on the
 * next turn of the event loop, after the current request's handler has
 * returned. A failure is only logged: the response has already gone, and an
 * unhandled rejection would take the process down. Work in flight when the
 * process stops is lost; the user asks again.
 */
export function createAfterResponseRunner(log: Pick<FastifyBaseLogger, "error">): RunAfterResponse {
  return (task) => {
    setImmediate(() => {
      // Promise.resolve().then, so a task that throws synchronously is
      // caught too.
      Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          log.error({ err: error }, "work scheduled after the response failed");
        });
    });
  };
}

export interface CollectingRunner {
  run: RunAfterResponse;
  /**
   * Runs every queued task, in the order queued, including any queued while
   * settling; resolves once all have finished, and rejects with the first
   * failure after the rest have run.
   */
  settle(): Promise<void>;
}

/**
 * For tests. `run` only queues: nothing starts until `settle()`, so a test
 * can assert that nothing was sent, written or audited when a 202 arrives.
 * A runner that started tasks would let a route that awaited its work pass
 * the same test.
 */
export function createCollectingRunner(): CollectingRunner {
  const queue: Array<() => Promise<void>> = [];
  return {
    run: (task) => {
      queue.push(task);
    },
    async settle() {
      const failures: unknown[] = [];
      for (let task = queue.shift(); task !== undefined; task = queue.shift()) {
        try {
          await task();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}
