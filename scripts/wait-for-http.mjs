#!/usr/bin/env node
// Waits until a URL answers 200, a bounded number of times, then exits 0; or
// gives up and exits 1. `npm run dev:services` (telflo-core/package.json)
// waits with it for the opamp-server's management /health, then the collector
// validator's /health, then the collector tester's /testing/v1/health through
// its forwarder (200 once kwok's cluster is up), then the OTTL evaluator's
// /health through its own forwarder, then the object store's /healthz on
// 127.0.0.1:51240 (for the API's S3 tests), since `docker compose up --wait`
// never returns on Compose 2.6.0 once a one-shot service (opamp-bootstrap,
// opamp-migrate) is in the dependency closure. The object store's wait is
// given no compose file and service, so a give-up prints no logs: SeaweedFS's
// log names the access key id. Each wait is 60 attempts, counted after `docker
// compose up -d` returns, so the validator's, the tester's and the
// evaluator's first image builds (minutes, with every offered collector)
// happen before their waits.
//
// Usage: wait-for-http.mjs <url> <attempts> [<compose-file> <service>]
//
// Each attempt is one GET with a 2-second timeout, then a second's pause
// before the next. The bound is the number of attempts, not a clock. Given a
// compose file and a service, it prints the tail of that service's logs when
// it gives up (`docker compose -f <file> logs --tail 50 <service>`), which is
// where the reason is: a failed bootstrap, a migration, a port in use.
import { spawnSync } from "node:child_process";

const ATTEMPT_TIMEOUT_MS = 2_000;
const PAUSE_MS = 1_000;
const LOG_LINES = "50";

const [url, rawAttempts, composeFile, service] = process.argv.slice(2);
const attempts = /^\d+$/.test(rawAttempts ?? "") ? Number(rawAttempts) : Number.NaN;
if (!url || !Number.isSafeInteger(attempts) || attempts < 1 || (composeFile === undefined) !== (service === undefined)) {
  console.error("usage: wait-for-http.mjs <url> <attempts> [<compose-file> <service>]");
  process.exit(2);
}

/** What the last attempt saw, for the message when the wait gives up. */
let last = "no answer";

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    await response.body?.cancel();
    if (response.status === 200) {
      console.log(`${url} answered 200 (attempt ${attempt} of ${attempts})`);
      process.exit(0);
    }
    last = `HTTP ${response.status}`;
  } catch (error) {
    // The cause's code (ECONNREFUSED, ...) when there is one: never a body.
    last = error?.cause?.code ?? error?.name ?? "an error";
  }
  if (attempt < attempts) await new Promise((done) => setTimeout(done, PAUSE_MS));
}

console.error(`${url} didn't answer 200 after ${attempts} attempts (the last: ${last})`);
if (composeFile !== undefined) {
  console.error(`The last ${LOG_LINES} lines of ${service}'s logs:`);
  const logs = spawnSync("docker", ["compose", "-f", composeFile, "logs", "--no-color", "--tail", LOG_LINES, service], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (logs.error) console.error(`(docker compose logs failed: ${logs.error.message})`);
}
process.exit(1);
