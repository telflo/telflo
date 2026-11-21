import type { RunAfterResponse } from "../../apps/api/src/http/after-response.js";

// The E2E API's after-response jobs, counted. The API runs some of its calls
// to the opamp-server after the response (an organization's registration, a
// deleted configuration's snapshots' clean-up), so the last test can end
// before they reach the fake. global-setup.ts's teardown reads the fake's
// violations file then, and a job that lands later would go unchecked.
// start-api.ts (never the API itself) wraps the runner it gives the server in
// createCountingRunner and answers the count on
// E2E_AFTER_RESPONSE_PENDING_PATH; the teardown waits for it to reach 0
// (waitForAfterResponseDrain) before it reads the file.
//
// The count holds each attempt while it runs, not the wait between
// attempts: an organization's delete that failed waits on its own unref'd
// timer before its next attempt is handed to the runner, and in that wait
// the count can read 0, so a retry still to come is not waited for.

/** The E2E API's route answering `{ pending: <jobs scheduled and not yet settled> }`. Registered by start-api.ts only. */
export const E2E_AFTER_RESPONSE_PENDING_PATH = "/__e2e/after-response-pending";

export interface CountingRunner {
  /** Runs each task through the runner wrapped, counting it from now until it settles. */
  run: RunAfterResponse;
  /** The tasks scheduled and not yet settled, a failure counting as settled. */
  pending(): number;
}

/** `inner`, counting its tasks: up when one is scheduled, down when it resolves or rejects. */
export function createCountingRunner(inner: RunAfterResponse): CountingRunner {
  let pending = 0;
  return {
    run(task) {
      pending += 1;
      try {
        inner(async () => {
          try {
            await task();
          } finally {
            pending -= 1;
          }
        });
      } catch (error) {
        // Never scheduled, so it will never settle.
        pending -= 1;
        throw error;
      }
    },
    pending: () => pending,
  };
}

export interface DrainOptions {
  /** How many times to ask; default 50. */
  attempts?: number;
  /** Between two asks; default a 100 ms pause. Tests pass their own. */
  pause?: () => Promise<void>;
}

/**
 * Resolves once `readPending` answers 0; asks at most `attempts` times, and
 * then throws, naming how many jobs were still pending. A read that fails
 * fails it at once.
 */
export async function waitForAfterResponseDrain(
  readPending: () => Promise<number>,
  options: DrainOptions = {},
): Promise<void> {
  const { attempts = 50 } = options;
  const pause = options.pause ?? (() => new Promise<void>((done) => setTimeout(done, 100)));
  let pending = await readPending();
  for (let attempt = 1; attempt < attempts && pending !== 0; attempt += 1) {
    await pause();
    pending = await readPending();
  }
  if (pending !== 0) {
    throw new Error(
      `The E2E API still had ${pending} after-response job(s) pending after ${attempts} attempts: the fake opamp-server's violations can't be read yet.`,
    );
  }
}

/** The E2E API's pending count, from its route at `apiUrl`. */
export async function readAfterResponsePending(apiUrl: string): Promise<number> {
  const response = await fetch(`${apiUrl}${E2E_AFTER_RESPONSE_PENDING_PATH}`);
  if (response.status !== 200) {
    throw new Error(`The E2E API answered ${E2E_AFTER_RESPONSE_PENDING_PATH} with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { pending?: unknown };
  if (typeof body.pending !== "number" || !Number.isInteger(body.pending) || body.pending < 0) {
    throw new Error(`The E2E API's ${E2E_AFTER_RESPONSE_PENDING_PATH} answered no count.`);
  }
  return body.pending;
}
