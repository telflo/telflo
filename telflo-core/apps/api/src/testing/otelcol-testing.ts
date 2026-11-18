import { afterAll, beforeAll } from "vitest";
import type { IOrganizationVariables } from "../modules/test-runs/organization-variables.js";
import type { TestingDependencies } from "../modules/test-runs/test-runs-dependencies.js";
import { createOtelcolTestingClient, type OtelcolTestingClient } from "../otelcol-testing/client.js";
import type { OtelcolTestingHealthMonitor } from "../otelcol-testing/health-monitor.js";
import { startFakeOtelcolTesting, type FakeOtelcolTesting } from "./fake-otelcol-testing.js";
import { UNCALLED_OTTL_EVALUATOR, UNCALLED_OTTL_EVALUATOR_HEALTH } from "./ottl-evaluator.js";

// The collector tester's fake for a test file (D14a Task 6), as
// useFakeOtelcolValidator is for the validator (otelcol-validator.ts). A test
// file about test runs starts the OpenAPI-checked fake
// (fake-otelcol-testing.ts) and uses its client. One fake per file:
//
//   const tester = useFakeOtelcolTesting();
//   ...
//   await tester.client.run({ ... });
//
// Call it at the top of the file, outside any describe: its beforeAll then
// runs before the file's own, and its afterAll after them, once the servers
// are closed. The afterAll closes the fake, which fails the file if the
// platform sent it a request (or it sent a reply) that broke the contract
// and no test read the violation. Tests that inspect or steer the fake read
// `tester.fake`.
//
// A test server about test runs passes its own `testing` dependency (this
// fake's client) and its own file store (buildServer's `fileStore`, D23-2
// decision 31); every other test server passes UNCALLED_TESTING and
// UNCALLED_FILE_STORE (testing/file-store.ts).

export interface FakeOtelcolTestingForFile {
  /** The file's fake; read it inside a hook or a test, once it has started. */
  readonly fake: FakeOtelcolTesting;
  /** A client of the fake. */
  readonly client: OtelcolTestingClient;
}

export function useFakeOtelcolTesting(): FakeOtelcolTestingForFile {
  let started: { fake: FakeOtelcolTesting; client: OtelcolTestingClient } | undefined;

  beforeAll(async () => {
    const fake = await startFakeOtelcolTesting();
    started = { fake, client: createOtelcolTestingClient({ url: fake.url, secret: fake.secret }) };
  });

  afterAll(async () => {
    const closing = started;
    started = undefined;
    await closing?.fake.close();
  });

  function current(): { fake: FakeOtelcolTesting; client: OtelcolTestingClient } {
    if (started === undefined) {
      throw new Error("useFakeOtelcolTesting's fake is read before its beforeAll ran, or after its afterAll");
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

/** A rejection naming what this test server lacks: the test reached the test runs' collaborators unasked. */
function uncalled(what: string): Promise<never> {
  return Promise.reject(
    new Error(`This test server has no ${what}: pass a testing dependency of its own to test runs.`),
  );
}

const UNCALLED_TESTER: OtelcolTestingClient = {
  run: () => uncalled("collector tester"),
  health: () => uncalled("collector tester"),
};

const UNCALLED_HEALTH: OtelcolTestingHealthMonitor = {
  start: () => {
    throw new Error("This test server has no collector tester health monitor.");
  },
  stop: () => Promise.resolve(),
  checkOnce: () => uncalled("collector tester health monitor"),
  view: () => ({ state: "unknown", consecutiveFailures: 0, downSince: null }),
};

/**
 * An organization variables' source no test meant to reach (D20 Task 11):
 * a run's text with no live `${org:NAME}` never reads one, so a test whose
 * runs hold none passes this, and a read fails it.
 */
export const UNCALLED_ORGANIZATION_VARIABLES: IOrganizationVariables = {
  read: () => uncalled("organization variables' source"),
};

/**
 * buildServer's `testing` for every test server not about test runs or
 * validation rules (D14a Preflight ruling 17): any use of the tester, the
 * OTTL evaluator (testing/ottl-evaluator.ts's UNCALLED_OTTL_EVALUATOR) or
 * the organization variables' source rejects, so the request fails with a
 * 500 and the test with it, rather than reach a tester, an evaluator or a
 * source nobody set up. Its queue signal is a no-op: nothing listens. The
 * file store is buildServer's own `fileStore` (D23-2 decision 31;
 * UNCALLED_FILE_STORE, testing/file-store.ts).
 */
export const UNCALLED_TESTING: TestingDependencies = {
  tester: UNCALLED_TESTER,
  health: UNCALLED_HEALTH,
  queued: { notify: () => undefined, subscribe: () => () => undefined },
  ottlEvaluator: UNCALLED_OTTL_EVALUATOR,
  ottlEvaluatorHealth: UNCALLED_OTTL_EVALUATOR_HEALTH,
  organizationVariables: UNCALLED_ORGANIZATION_VARIABLES,
};
