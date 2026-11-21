import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { FAKE_OTELCOL_VALIDATOR_SECRET } from "../apps/api/src/testing/fake-otelcol-validator.js";
import { E2E_OTELCOL_VALIDATOR_URL } from "./support/environment.js";
import {
  assertNoFakeOtelcolValidatorViolations,
  startE2eFakeOtelcolValidator,
} from "./support/fake-otelcol-validator.js";

// The browser tests' collector validator: the web server
// start-fake-otelcol-validator.ts runs is up where the E2E API's settings
// point, and its start helper and the teardown's check do what
// global-setup.ts relies on: a violation is written down as it is seen, and
// fails the run. No page: these need no browser.

test("the E2E API's collector validator answers /health", async () => {
  const response = await fetch(`${E2E_OTELCOL_VALIDATOR_URL}/health`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("the start helper writes each violation to stderr and its file, and the check then fails", async () => {
  const violationsPath = test.info().outputPath("violations.log");
  writeFileSync(violationsPath, "left over from an earlier run\n");
  const written: string[] = [];
  const fake = await startE2eFakeOtelcolValidator({
    port: 0,
    violationsPath,
    stderr: { write: (text: string) => written.push(text) },
  });
  try {
    // Emptied as it started.
    assertNoFakeOtelcolValidatorViolations(violationsPath);
    expect((await fetch(`${fake.url}/health`)).status).toBe(200);

    await fetch(`${fake.url}/nowhere`, { headers: { authorization: `Bearer ${FAKE_OTELCOL_VALIDATOR_SECRET}` } });

    expect(written).toEqual(["fake otelcol-validator: contract violation: GET /nowhere: the route isn't documented\n"]);
    expect(readFileSync(violationsPath, "utf8")).toBe("GET /nowhere: the route isn't documented\n");
    expect(() => assertNoFakeOtelcolValidatorViolations(violationsPath)).toThrow(
      "The fake otelcol-validator saw 1 contract violation(s) from the E2E API:\nGET /nowhere: the route isn't documented",
    );
  } finally {
    fake.takeViolations();
    await fake.close();
  }
});

test("the check fails when the fake's file is missing", async () => {
  expect(() => assertNoFakeOtelcolValidatorViolations(test.info().outputPath("never-written.log"))).toThrow(
    /The fake otelcol-validator's violations file is missing/,
  );
});
