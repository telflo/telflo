import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import {
  FAKE_OTELCOL_TESTING_SECRET,
  fakeOtelcolTestingMarker,
  startFakeOtelcolTesting,
} from "../apps/api/src/testing/fake-otelcol-testing.js";
import { E2E_OTELCOL_TESTING_CONTROL_URL, E2E_OTELCOL_TESTING_URL } from "./support/environment.js";
import {
  assertNoFakeOtelcolTestingViolations,
  heldRuns,
  startE2eFakeOtelcolTesting,
  startFakeOtelcolTestingControl,
} from "./support/fake-otelcol-testing.js";

// The browser tests' collector tester (D14a Task 6): the web server
// start-fake-otelcol-testing.ts runs is up where the E2E API's settings
// point, and its start helper and the teardown's check do what
// global-setup.ts relies on: a violation is written down as it is seen, and
// fails the run. No page: these need no browser.

test("the E2E API's collector tester answers its health", async () => {
  const response = await fetch(`${E2E_OTELCOL_TESTING_URL}/testing/v1/health`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", kwok: "ready" });
});

test("the start helper writes each violation to stderr and its file, and the check then fails", async () => {
  const violationsPath = test.info().outputPath("violations.log");
  writeFileSync(violationsPath, "left over from an earlier run\n");
  const written: string[] = [];
  const fake = await startE2eFakeOtelcolTesting({
    port: 0,
    violationsPath,
    stderr: { write: (text: string) => written.push(text) },
  });
  try {
    // Emptied as it started.
    assertNoFakeOtelcolTestingViolations(violationsPath);
    expect((await fetch(`${fake.url}/testing/v1/health`)).status).toBe(200);

    await fetch(`${fake.url}/nowhere`, { headers: { authorization: `Bearer ${FAKE_OTELCOL_TESTING_SECRET}` } });

    expect(written).toEqual(["fake otelcol-testing: contract violation: GET /nowhere: the route isn't documented\n"]);
    expect(readFileSync(violationsPath, "utf8")).toBe("GET /nowhere: the route isn't documented\n");
    expect(() => assertNoFakeOtelcolTestingViolations(violationsPath)).toThrow(
      "The fake otelcol-testing saw 1 contract violation(s) from the E2E API:\nGET /nowhere: the route isn't documented",
    );
  } finally {
    fake.takeViolations();
    await fake.close();
  }
});

test("the check fails when the fake's file is missing", async () => {
  expect(() => assertNoFakeOtelcolTestingViolations(test.info().outputPath("never-written.log"))).toThrow(
    /The fake otelcol-testing's violations file is missing/,
  );
});

test("the E2E fake's control route answers for a token, and refuses a request without one", async () => {
  expect(await heldRuns(`nobody-${Date.now()}`)).toBe(0);
  expect((await fetch(`${E2E_OTELCOL_TESTING_CONTROL_URL}/held`)).status).toBe(400);
  expect((await fetch(`${E2E_OTELCOL_TESTING_CONTROL_URL}/release?contains=`, { method: "POST" })).status).toBe(400);
});

test("the control route counts and releases only the held runs whose text holds its token (D14a Ruling 36)", async () => {
  const fake = await startFakeOtelcolTesting();
  const control = await startFakeOtelcolTestingControl(Promise.resolve(fake), 0);
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  const run = (token: string) =>
    fetch(`${fake.url}/testing/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        runId: "0190a6f2-1c1e-7cc8-9f3a-8a5b6c7d8e9f",
        yaml: `# token: ${token}\n${fakeOtelcolTestingMarker("slow")}\nreceivers:\n  otlp: {}\n`,
        pipeline: "logs",
        signal: "logs",
        durationSeconds: 1,
        distribution: "otelcol-contrib",
        version: "0.162.0",
        input: { base64: Buffer.from("{}").toString("base64") },
      }),
    });
  const ask = async (method: "GET" | "POST", path: string) => (await fetch(`${controlUrl}${path}`, { method })).json();
  try {
    const mine = run("mine");
    const theirs = run("theirs");
    await fake.waitForHeld(2);

    expect(await ask("GET", "/held?contains=token%3A%20mine")).toEqual({ held: 1 });
    expect(await ask("POST", "/release?contains=token%3A%20mine")).toEqual({ released: 1 });
    expect((await mine).status).toBe(200);
    expect(fake.heldCount()).toBe(1);
    expect(await ask("GET", "/held?contains=token%3A%20mine")).toEqual({ held: 0 });

    expect(await ask("POST", "/release?contains=token%3A%20theirs")).toEqual({ released: 1 });
    expect((await theirs).status).toBe(200);
  } finally {
    control.closeAllConnections();
    await new Promise<void>((done) => control.close(() => done()));
    await fake.close();
  }
});
