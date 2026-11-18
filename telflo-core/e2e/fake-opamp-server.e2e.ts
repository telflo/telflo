import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_OPAMP_URL } from "./support/environment.js";
import { assertNoFakeOpampServerViolations, startE2eFakeOpampServer } from "./support/fake-opamp-server.js";

// The browser tests' opamp-server (D11b decision 8): the web server
// start-fake-opamp-server.ts runs is up where the E2E API's settings point,
// and its start helper and the teardown's check do what global-setup.ts
// relies on: a violation is written down as it is seen, and fails the run.
// No page: these need no browser.

test("the E2E API's opamp-server answers /health", async () => {
  const response = await fetch(`${E2E_OPAMP_URL}/health`);

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});

test("the start helper writes each violation to stderr and its file, and the check then fails", async () => {
  const violationsPath = test.info().outputPath("violations.log");
  writeFileSync(violationsPath, "left over from an earlier run\n");
  const written: string[] = [];
  const fake = await startE2eFakeOpampServer({
    port: 0,
    violationsPath,
    stderr: { write: (text: string) => written.push(text) },
  });
  try {
    // Emptied as it started.
    assertNoFakeOpampServerViolations(violationsPath);
    expect((await fetch(`${fake.url}/health`)).status).toBe(200);

    await fetch(`${fake.url}/nowhere`);

    expect(written).toEqual(["fake opamp-server: contract violation: GET /nowhere: the route isn't documented\n"]);
    expect(readFileSync(violationsPath, "utf8")).toBe("GET /nowhere: the route isn't documented\n");
    expect(() => assertNoFakeOpampServerViolations(violationsPath)).toThrow(
      "The fake opamp-server saw 1 contract violation(s) from the E2E API:\nGET /nowhere: the route isn't documented",
    );
  } finally {
    fake.takeViolations();
    await fake.close();
  }
});

test("the check fails when the fake's file is missing", async () => {
  expect(() => assertNoFakeOpampServerViolations(test.info().outputPath("never-written.log"))).toThrow(
    /The fake opamp-server's violations file is missing/,
  );
});
