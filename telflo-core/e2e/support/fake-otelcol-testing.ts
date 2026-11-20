import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { expect } from "@playwright/test";
import { startFakeOtelcolTesting, type FakeOtelcolTesting } from "../../apps/api/src/testing/fake-otelcol-testing.js";
import { E2E_OTELCOL_TESTING_CONTROL_URL } from "./environment.js";

// The browser tests' collector tester: the OpenAPI-checked fake from
// apps/api/src/testing, which start-fake-otelcol-testing.ts runs as a
// Playwright web server. It checks every request the E2E API sends it, and
// every reply it sends, against services/otelcol-testing/openapi.yaml, and
// answers by markers in the text, so tests running in parallel each get the
// answer their own text asks for (fake-otelcol-testing.ts lists them).
//
// As with the fake validator (support/fake-otelcol-validator.ts), it runs in
// a process of its own, so each violation, as the fake sees it, is written
// to stderr and appended to a file, and global-setup.ts's teardown, which
// runs before the web servers stop, fails the run if the file holds any
// (assertNoFakeOtelcolTestingViolations).
//
// A violation names an operation, a field or a path, never a value: the
// fake's messages carry no secret, text or input.

export interface E2eFakeOtelcolTestingOptions {
  port: number;
  /** Emptied now; each violation is appended as one line. */
  violationsPath: string;
  /** Where each violation is also written as it is seen. Default process.stderr. */
  stderr?: { write(text: string): unknown };
}

/** Starts the fake on 127.0.0.1:`port`, recording each violation to `violationsPath` and `stderr`. */
export async function startE2eFakeOtelcolTesting(options: E2eFakeOtelcolTestingOptions): Promise<FakeOtelcolTesting> {
  const { port, violationsPath } = options;
  const stderr = options.stderr ?? process.stderr;
  mkdirSync(dirname(violationsPath), { recursive: true });
  writeFileSync(violationsPath, "");
  return startFakeOtelcolTesting({
    port,
    onViolation(message) {
      // One violation per line, whatever the message holds.
      const line = message.replace(/\s+/g, " ");
      appendFileSync(violationsPath, `${line}\n`);
      stderr.write(`fake otelcol-testing: contract violation: ${line}\n`);
    },
  });
}

/**
 * Throws, listing them, if the fake recorded any violation, and if the file
 * is missing (the fake never started, or something else removed it).
 */
export function assertNoFakeOtelcolTestingViolations(violationsPath: string): void {
  let text: string;
  try {
    text = readFileSync(violationsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The fake otelcol-testing's violations file is missing (${violationsPath}): did it start?`);
    }
    throw error;
  }
  const violations = text.split("\n").filter((line) => line !== "");
  if (violations.length > 0) {
    throw new Error(
      `The fake otelcol-testing saw ${violations.length} contract violation(s) from the E2E API:\n${violations.join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The control route: test-only, on a port of its own.
//
// A `slow` run (fakeOtelcolTestingMarker("slow") in its text) is held by the
// fake, unanswered, so the browser shows it Running until the test releases
// it. The browsers' tests run in parallel against one fake, so each counts
// and releases only its own runs: the ones whose text holds `contains`, a
// token unique to the test (a comment line in its configuration's text).
// start-fake-otelcol-testing.ts serves it beside the fake, in the fake's
// process, on E2E_OTELCOL_TESTING_CONTROL_PORT:
// - GET /held?contains=<token>: 200 {"held": n};
// - POST /release?contains=<token>: 200 {"released": n}, each answered as
//   the rest of its text asks;
// - a missing or empty `contains` is 400: no test releases every run.
// The E2E API never calls it, and it never ships.

/**
 * Serves the control route for `fake` on 127.0.0.1:`port`. Given the fake as
 * a promise, so it can listen before the fake does: Playwright waits for the
 * fake's health, and the route is then already there.
 */
export async function startFakeOtelcolTestingControl(fakeStarted: Promise<FakeOtelcolTesting>, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    void answerControl(fakeStarted, request, response);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  return server;
}

/** One control request, answered once the fake has started. */
async function answerControl(fakeStarted: Promise<FakeOtelcolTesting>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  request.resume();
  const fake = await fakeStarted;
  const url = new URL(request.url ?? "/", "http://fake-otelcol-testing-control.invalid");
  const contains = url.searchParams.get("contains") ?? "";
  if (contains === "") return reply(400, { error: "contains is required" });
  if (request.method === "GET" && url.pathname === "/held") return reply(200, { held: fake.heldCount(contains) });
  if (request.method === "POST" && url.pathname === "/release") return reply(200, { released: fake.releaseHeld(contains) });
  return reply(404, { error: "no such route" });
}

async function control(method: "GET" | "POST", path: "/held" | "/release", contains: string): Promise<unknown> {
  const response = await fetch(`${E2E_OTELCOL_TESTING_CONTROL_URL}${path}?contains=${encodeURIComponent(contains)}`, { method });
  if (response.status !== 200) throw new Error(`The fake otelcol-testing's control route answered ${response.status} to ${method} ${path}`);
  return response.json();
}

/** How many `slow` runs whose text holds `contains` the E2E API's fake tester holds now. */
export async function heldRuns(contains: string): Promise<number> {
  return ((await control("GET", "/held", contains)) as { held: number }).held;
}

/** Waits, by polling a condition, until the fake holds at least `count` `slow` runs whose text holds `contains`. */
export async function waitForHeldRuns(contains: string, count = 1): Promise<void> {
  await expect.poll(() => heldRuns(contains), { message: `the fake tester holds ${count} run(s) of this test` }).toBeGreaterThanOrEqual(count);
}

/** Answers every `slow` run whose text holds `contains`, as the rest of its text asks; resolves to how many. */
export async function releaseHeldRuns(contains: string): Promise<number> {
  return ((await control("POST", "/release", contains)) as { released: number }).released;
}
