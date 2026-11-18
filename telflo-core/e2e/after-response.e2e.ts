import { expect, test } from "@playwright/test";
import { createAfterResponseRunner, type RunAfterResponse } from "../apps/api/src/http/after-response.js";
import {
  createCountingRunner,
  E2E_AFTER_RESPONSE_PENDING_PATH,
  readAfterResponsePending,
  waitForAfterResponseDrain,
} from "./support/after-response.js";
import { E2E_API_URL } from "./support/environment.js";

// The E2E API's after-response jobs, counted, and the teardown's wait for
// them (D11b Ruling 25): global-setup.ts reads the fake opamp-server's
// violations only once the count is 0. No page: these need no browser.

/** A promise and the function that resolves it. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the E2E API answers its pending after-response jobs on its e2e-only route", async () => {
  const response = await fetch(`${E2E_API_URL}${E2E_AFTER_RESPONSE_PENDING_PATH}`);

  expect(response.status).toBe(200);
  const body = (await response.json()) as { pending: unknown };
  expect(Object.keys(body)).toEqual(["pending"]);
  // Other tests run at once, so any count of their jobs.
  expect(Number.isInteger(body.pending) && (body.pending as number) >= 0).toBe(true);
  expect(await readAfterResponsePending(E2E_API_URL)).toBeGreaterThanOrEqual(0);
});

test("the counting runner counts a job from its scheduling until it resolves", async () => {
  const errors: unknown[] = [];
  const counting = createCountingRunner(
    createAfterResponseRunner({ error: (entry: unknown) => void errors.push(entry) }),
  );
  const job = deferred();
  const started = deferred();

  counting.run(async () => {
    started.resolve();
    await job.promise;
  });
  // The production runner starts it on a later turn: counted already.
  expect(counting.pending()).toBe(1);
  await started.promise;
  expect(counting.pending()).toBe(1);
  job.resolve();
  await expect.poll(() => counting.pending()).toBe(0);
  expect(errors).toEqual([]);
});

test("the counting runner counts a failed job as settled, and the runner still logs it", async () => {
  const logged = deferred();
  const errors: unknown[] = [];
  const counting = createCountingRunner(
    createAfterResponseRunner({
      error: (entry: unknown) => {
        errors.push(entry);
        logged.resolve();
      },
    }),
  );

  counting.run(() => Promise.reject(new Error("the job failed")));
  counting.run(() => {
    throw new Error("the job threw");
  });
  expect(counting.pending()).toBe(2);
  await logged.promise;

  await expect.poll(() => counting.pending()).toBe(0);
  await expect.poll(() => errors.length).toBe(2);
});

test("the counting runner doesn't count a job the runner it wraps refused to schedule", () => {
  const refusing: RunAfterResponse = () => {
    throw new Error("not scheduled");
  };
  const counting = createCountingRunner(refusing);

  expect(() => counting.run(() => Promise.resolve())).toThrow("not scheduled");
  expect(counting.pending()).toBe(0);
});

test("the teardown's wait asks until the count is 0", async () => {
  const answers = [2, 1, 1, 0];
  let reads = 0;
  let pauses = 0;

  await waitForAfterResponseDrain(() => Promise.resolve(answers[reads++]!), {
    pause: () => {
      pauses += 1;
      return Promise.resolve();
    },
  });

  expect(reads).toBe(4);
  expect(pauses).toBe(3);
});

test("the teardown's wait doesn't pause when nothing is pending", async () => {
  let pauses = 0;

  await waitForAfterResponseDrain(() => Promise.resolve(0), {
    pause: () => {
      pauses += 1;
      return Promise.resolve();
    },
  });

  expect(pauses).toBe(0);
});

test("the teardown's wait gives up after its attempts, 50 by default, failing the run", async () => {
  let reads = 0;
  const pause = () => Promise.resolve();

  await expect(
    waitForAfterResponseDrain(
      () => {
        reads += 1;
        return Promise.resolve(3);
      },
      { pause },
    ),
  ).rejects.toThrow("The E2E API still had 3 after-response job(s) pending after 50 attempts");
  expect(reads).toBe(50);

  reads = 0;
  await expect(
    waitForAfterResponseDrain(
      () => {
        reads += 1;
        return Promise.resolve(1);
      },
      { attempts: 3, pause },
    ),
  ).rejects.toThrow("pending after 3 attempts");
  expect(reads).toBe(3);
});

test("the teardown's wait fails at once when the count can't be read", async () => {
  let pauses = 0;

  await expect(
    waitForAfterResponseDrain(() => Promise.reject(new Error("the API is gone")), {
      pause: () => {
        pauses += 1;
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow("the API is gone");
  expect(pauses).toBe(0);
});
