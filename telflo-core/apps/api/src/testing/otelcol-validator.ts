import { afterAll, beforeAll } from "vitest";
import { createOtelcolValidatorClient, type OtelcolValidatorClient } from "../otelcol-validator/client.js";
import { startFakeOtelcolValidator, type FakeOtelcolValidator } from "./fake-otelcol-validator.js";

// Every server needs a collector validator. A test file about validation
// starts the OpenAPI-checked fake (fake-otelcol-validator.ts) and passes its
// client as buildServer's `otelcolValidator`. One fake per file:
//
//   const validator = useFakeOtelcolValidator();
//   ...
//   buildServer({ ..., otelcolValidator: validator.client });
//
// Call it at the top of the file, outside any describe: its beforeAll then
// runs before the file's own, and its afterAll after them, once the servers
// are closed. The afterAll closes the fake, which fails the file if the
// platform sent it a request (or it sent a reply) that broke the contract
// and no test read the violation. Tests that inspect the fake read
// `validator.fake`.
//
// Every other test server passes UNCALLED_OTELCOL_VALIDATOR: a test not about
// validation that reaches the validator fails.

export interface FakeOtelcolValidatorForFile {
  /** The file's fake; read it inside a hook or a test, once it has started. */
  readonly fake: FakeOtelcolValidator;
  /** A client of the fake, for buildServer's `otelcolValidator`. */
  readonly client: OtelcolValidatorClient;
}

export function useFakeOtelcolValidator(): FakeOtelcolValidatorForFile {
  let started: { fake: FakeOtelcolValidator; client: OtelcolValidatorClient } | undefined;

  beforeAll(async () => {
    const fake = await startFakeOtelcolValidator();
    started = { fake, client: createOtelcolValidatorClient({ url: fake.url, secret: fake.secret }) };
  });

  afterAll(async () => {
    const closing = started;
    started = undefined;
    await closing?.fake.close();
  });

  function current(): { fake: FakeOtelcolValidator; client: OtelcolValidatorClient } {
    if (started === undefined) {
      throw new Error("useFakeOtelcolValidator's fake is read before its beforeAll ran, or after its afterAll");
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

/**
 * buildServer's `otelcolValidator` for every test server not about
 * validation: a check rejects, so the request fails with a 500 and the test
 * with it, rather than reach a validator nobody set up.
 */
export const UNCALLED_OTELCOL_VALIDATOR: OtelcolValidatorClient = {
  validate: () =>
    Promise.reject(
      new Error("This test server has no collector validator: pass useFakeOtelcolValidator()'s client to test validation."),
    ),
};
