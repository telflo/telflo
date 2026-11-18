/*
 * Test runs (D27 decision 27, routes 26-28): the queue's body, the target
 * (a text or a stored version) and its collector, the poll, the output.
 * Data only: `commands/test.ts` prints and decides the exit codes.
 *
 * - The create and the output wait 120 s (decision 16), every poll 30 s.
 * - Polling: every second, five times slower after ten
 *   polls, so a long run stays inside the 60 requests a minute per token;
 *   until an ended status or the deadline. A 429 while polling is the
 *   client's: retried after its `Retry-After` (decision 17).
 * - The run's text, sample and rules are configuration text (Q168): in the
 *   body only, never a URL or a message.
 */

import type { PublicConfigurationDetail, PublicQueuedTestRun, PublicQueueTestRunRequest, PublicTestRun } from "@telflo/contracts";
import { LONG_TIMEOUT_MS, segment, type ApiClient } from "../api.js";
import { requireId } from "../ids.js";
import { EXIT, ExitError } from "../output.js";
import { resolvePin, type CollectorPin } from "../pin.js";
import type { TestSpec } from "../test-spec-file.js";

/** The platform's statuses; the last three are a run's end. */
export const TEST_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "validation_failed"] as const;
export const ENDED_TEST_RUN_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "validation_failed"]);

/** Polls at the interval this many times, then five times slower. */
export const BACKOFF_AFTER_POLLS = 10;
export const BACKOFF_MULTIPLIER = 5;
export const POLL_INTERVAL_MS = 1_000;
/** How long past the run's own duration `telflo test` waits by default. */
export const DEFAULT_WAIT_MARGIN_SECONDS = 120;

/** The clock polling reads and sleeps on: the process's, or a test's. */
export interface TestRunClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const REAL_CLOCK: TestRunClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

let clock: TestRunClock = REAL_CLOCK;

/** The clock in use. */
export function testRunClock(): TestRunClock {
  return clock;
}

/** Replaces the clock (a test's), or puts the real one back with no argument. */
export function setTestRunClock(next?: Partial<TestRunClock>): void {
  clock = { ...REAL_CLOCK, ...next };
}

export const NEED_A_TARGET_MESSAGE = "Give -f <file>, --config <id>, or both (-f for the YAML, --config for the collector it's pinned to).";
export const VERSION_NEEDS_CONFIG_MESSAGE = "--version needs --config <id>.";

/** What the run tests: a text, or a stored configuration's version. */
export type TestSource = { yaml: string } | { configurationId: string; versionNumber: number };

/** The collector the flags (or a configuration's pin) name; unset fields fall back to the spec's, then the server's. */
export interface CollectorChoice {
  collectorVersion?: string | undefined;
  distribution?: string | undefined;
}

/** The usage rules, before any file is read: something to test, and a version only with a configuration. */
export function assertTestTargetUsage(input: { hasYaml: boolean; configurationId?: string | undefined; version?: number | undefined }): void {
  if (!input.hasYaml && input.configurationId === undefined) throw new ExitError(NEED_A_TARGET_MESSAGE, EXIT.USAGE);
  if (input.version !== undefined && input.configurationId === undefined) throw new ExitError(VERSION_NEEDS_CONFIG_MESSAGE, EXIT.USAGE);
}

export interface TestTargetInput {
  /** The text (not a path). */
  yaml?: string | undefined;
  configurationId?: string | undefined;
  version?: number | undefined;
  collectorVersion?: string | undefined;
  distribution?: string | undefined;
}

export interface TestTarget {
  source: TestSource;
  pin: CollectorChoice;
  /** The stored pin a text was given (-f with --config) and its configuration's canonical id, so the command can say where it came from. */
  storedPin?: CollectorPin & { configurationId: string };
}

/**
 * What to test, and on which collector.
 * The flags win; a text with `--config` takes that configuration's pin
 * (its latest version's, or `--version`'s) for what they leave unset. A
 * version's run needs no pin: the server uses the version's. Without
 * `--version`, the configuration's latest version.
 */
export async function resolveTestTarget(client: ApiClient, input: TestTargetInput): Promise<TestTarget> {
  assertTestTargetUsage({ hasYaml: input.yaml !== undefined, configurationId: input.configurationId, version: input.version });
  const pin: CollectorChoice = { collectorVersion: input.collectorVersion, distribution: input.distribution };
  if (input.yaml !== undefined) {
    if (input.configurationId === undefined) return { source: { yaml: input.yaml }, pin };
    const configurationId = requireId(input.configurationId, "configuration");
    const storedPin = await resolvePin(client, configurationId, input.version);
    pin.collectorVersion ??= storedPin.collectorVersion;
    pin.distribution ??= storedPin.distribution;
    return { source: { yaml: input.yaml }, pin, storedPin: { ...storedPin, configurationId } };
  }
  const configurationId = requireId(input.configurationId!, "configuration");
  let versionNumber = input.version;
  if (versionNumber === undefined) {
    const configuration = await client.request<PublicConfigurationDetail>("GET", `/configurations/${segment(configurationId)}`);
    versionNumber = configuration.versionNumber;
  }
  return { source: { configurationId, versionNumber }, pin };
}

/**
 * `POST /test-runs`'s body: the spec's sample, signal, pipeline and
 * duration; the spec's rules, or `useSavedRules`; the collector (the
 * choice's fields over the spec's); the text or the version.
 */
export function buildTestRunBody(
  spec: TestSpec,
  source: TestSource,
  options: { useSavedRules?: boolean; pin?: CollectorChoice } = {},
): PublicQueueTestRunRequest {
  const body: PublicQueueTestRunRequest = {
    sample: spec.sample,
    signal: spec.signal,
    pipeline: spec.pipeline,
    durationSeconds: spec.duration,
  };
  if (options.useSavedRules === true) body.useSavedRules = true;
  else body.rules = spec.rules;
  const collectorVersion = options.pin?.collectorVersion ?? spec.collectorVersion;
  const distribution = options.pin?.distribution ?? spec.distribution;
  if (collectorVersion !== undefined) body.collectorVersion = collectorVersion;
  if (distribution !== undefined) body.distribution = distribution;
  if ("yaml" in source) {
    body.yaml = source.yaml;
  } else {
    body.configurationId = source.configurationId;
    body.versionNumber = source.versionNumber;
  }
  return body;
}

/** Route 26: the run queued (202), its id. */
export async function queueTestRun(client: ApiClient, body: PublicQueueTestRunRequest): Promise<string> {
  const queued = await client.request<PublicQueuedTestRun>("POST", "/test-runs", { body, timeoutMs: LONG_TIMEOUT_MS });
  return queued.id;
}

/** Route 27: the run as it is. */
export function getTestRun(client: ApiClient, runId: string): Promise<PublicTestRun> {
  return client.request<PublicTestRun>("GET", `/test-runs/${segment(runId)}`);
}

/** Route 28: the run's output, its bytes exactly (Ruling 238: written to `--output` as they are). */
export function getTestRunOutput(client: ApiClient, runId: string): Promise<Buffer> {
  return client.request<Buffer>("GET", `/test-runs/${segment(runId)}/output`, { bytes: true, timeoutMs: LONG_TIMEOUT_MS });
}

export type WaitOutcome = { finished: true; run: PublicTestRun } | { finished: false; lastStatus: string | null };

/**
 * Polls the run until it has ended or `timeoutMs` has passed (an outcome,
 * not an error: the caller names the run's id). The first poll is at once;
 * the first BACKOFF_AFTER_POLLS are an interval apart, the rest five.
 */
export async function waitForTestRun(
  client: ApiClient,
  runId: string,
  options: { timeoutMs: number; pollIntervalMs?: number },
): Promise<WaitOutcome> {
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = clock.now() + options.timeoutMs;
  let lastStatus: string | null = null;
  for (let polls = 0; clock.now() < deadline; ) {
    const run = await getTestRun(client, runId);
    polls += 1;
    lastStatus = run.status;
    if (ENDED_TEST_RUN_STATUSES.has(run.status)) return { finished: true, run };
    await clock.sleep(polls <= BACKOFF_AFTER_POLLS ? interval : interval * BACKOFF_MULTIPLIER);
  }
  return { finished: false, lastStatus };
}
