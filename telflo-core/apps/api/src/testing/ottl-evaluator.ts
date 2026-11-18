import { afterAll, beforeAll, beforeEach } from "vitest";
import { createOttlEvaluatorClient, type OttlEvaluatorClient } from "../ottl-evaluator/client.js";
import type { OttlEvaluatorHealthMonitor } from "../ottl-evaluator/health-monitor.js";
import { startFakeOttlEvaluator, type FakeOttlEvaluator } from "./fake-ottl-evaluator.js";

// The OTTL evaluator's fake for a test file (D15a Task 5), as
// useFakeOtelcolTesting is for the tester (otelcol-testing.ts). A test file
// about validation rules or their runs starts the OpenAPI-checked fake
// (fake-ottl-evaluator.ts) and uses its client. One fake per file:
//
//   const evaluator = useFakeOttlEvaluator();
//   ...
//   buildServer({ ..., testing: { ...UNCALLED_TESTING, ottlEvaluator: evaluator.client } });
//
// Call it at the top of the file, outside any describe: its beforeAll then
// runs before the file's own, and its afterAll after them, once the servers
// are closed. The afterAll closes the fake, which fails the file if the
// platform sent it a request (or it sent a reply) that broke the contract
// and no test read the violation. Tests that inspect or steer the fake read
// `evaluator.fake`. Before each test, the faults a test queued and its
// requests didn't take are dropped, so they never answer the next test's
// (D15a Ruling 41).
//
// Every other test server's `testing` (UNCALLED_TESTING) carries
// UNCALLED_OTTL_EVALUATOR, which fails a test that reaches the evaluator
// (its lint too, since D25 Task 3).

export interface FakeOttlEvaluatorForFile {
  /** The file's fake; read it inside a hook or a test, once it has started. */
  readonly fake: FakeOttlEvaluator;
  /** A client of the fake. */
  readonly client: OttlEvaluatorClient;
}

export function useFakeOttlEvaluator(): FakeOttlEvaluatorForFile {
  let started: { fake: FakeOttlEvaluator; client: OttlEvaluatorClient } | undefined;

  beforeAll(async () => {
    const fake = await startFakeOttlEvaluator();
    started = { fake, client: createOttlEvaluatorClient({ url: fake.url, secret: fake.secret }) };
  });

  beforeEach(() => {
    started?.fake.clearFaults();
  });

  afterAll(async () => {
    const closing = started;
    started = undefined;
    await closing?.fake.close();
  });

  function current(): { fake: FakeOttlEvaluator; client: OttlEvaluatorClient } {
    if (started === undefined) {
      throw new Error("useFakeOttlEvaluator's fake is read before its beforeAll ran, or after its afterAll");
    }
    return started;
  }

  return {
    get fake() {
      return current().fake;
    },
    get client() {
      return current().client;
    },
  };
}

/** A rejection naming what this test server lacks: the test reached the evaluator unasked. */
function uncalled(): Promise<never> {
  return Promise.reject(
    new Error("This test server has no OTTL evaluator: pass useFakeOttlEvaluator()'s client to test validation rules."),
  );
}

/**
 * The evaluator's client for every test server not about validation rules:
 * any call rejects, so the request fails with a 500 and the test with it,
 * rather than reach an evaluator nobody set up.
 */
export const UNCALLED_OTTL_EVALUATOR: OttlEvaluatorClient = {
  evaluate: () => uncalled(),
  validate: () => uncalled(),
  lint: () => uncalled(),
  health: () => uncalled(),
};

/** Its health monitor: never started on a test server (only the background starter starts one). */
export const UNCALLED_OTTL_EVALUATOR_HEALTH: OttlEvaluatorHealthMonitor = {
  start: () => {
    throw new Error("This test server has no OTTL evaluator health monitor.");
  },
  stop: () => Promise.resolve(),
  checkOnce: () => uncalled(),
  view: () => ({ state: "unknown", consecutiveFailures: 0, downSince: null }),
};
