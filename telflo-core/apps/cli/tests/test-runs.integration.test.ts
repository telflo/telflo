import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { TEST_RUNS_WAITING_MAXIMUM_PER_USER } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addServiceAccount,
  addTestRun,
  addValidationPipeline,
  addValidationRule,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { createFileStore } from "../../api/src/file-store/create-file-store.js";
import type { IFileStore } from "../../api/src/file-store/file-store.js";
import { createTestRunDispatcher, type TestRunDispatcher } from "../../api/src/modules/test-runs/dispatcher.js";
import { createTestRunQueueSignal, type TestRunQueueSignal } from "../../api/src/modules/test-runs/test-runs-dependencies.js";
import { loadSettings } from "../../api/src/settings.js";
import { fakeOttlEvaluatorMarker } from "../../api/src/testing/fake-ottl-evaluator.js";
import { UNCALLED_TESTING, useFakeOtelcolTesting } from "../../api/src/testing/otelcol-testing.js";
import { useFakeOttlEvaluator } from "../../api/src/testing/ottl-evaluator.js";
import { setTestRunClock } from "../src/ops/test-runs.js";
import { READ_ONLY_TOKEN_MESSAGE } from "../src/output.js";
import { RULES_FAILED_MESSAGE } from "../src/commands/test.js";
import { runCli, useApiServer, type CliRun } from "./harness.js";

/*
 * telflo test against the real API in process (D27 decisions 27 and 33):
 * the api's fake tester and fake OTTL evaluator, a local file store, and
 * the dispatcher carrying every waiting run each time the CLI sleeps
 * between polls (an operation, never a timer). A YAML run, a version's run
 * with inline rules and with saved rules (--save, --saved), the refusals
 * (a rule the server refuses, a pipeline the text lacks, no saved rules, a
 * full queue, a read token). Tokens are checked with boolean canaries; no
 * log line holds a token or the run's configuration text (Q168).
 */

const tester = useFakeOtelcolTesting();
const evaluator = useFakeOttlEvaluator();

let root: string;
let store: IFileStore;
let signal: TestRunQueueSignal;
let db: Kysely<Database>;
const dispatchers: TestRunDispatcher[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "telflo-cli-test-runs-"));
  store = await createFileStore({ kind: "local", root });
  signal = createTestRunQueueSignal();
  db = createDb(createPool(loadSettings(process.env).databaseUrl));
});

const api = useApiServer(() => ({
  fileStore: store,
  testing: { ...UNCALLED_TESTING, tester: tester.client, ottlEvaluator: evaluator.client, queued: signal },
}));

afterAll(async () => {
  await db?.destroy();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** Markers no log line may hold: the text, the sample and the rules are configuration text (Q168). */
const YAML_MARKER = "cli-yaml-marker-4e1d";
const SAMPLE_MARKER = "cli-sample-marker-8a2f";
const RULE_MARKER = "cli-rule-marker-c07b";

const YAML = [
  `# ${YAML_MARKER}`,
  "receivers:",
  "  otlp:",
  "exporters:",
  "  debug:",
  "service:",
  "  pipelines:",
  "    logs/in:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

const SAMPLE = `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"${SAMPLE_MARKER}"}}]}]}]}`;

/** A spec of two rules: a count control and an any; `condition` replaces the second's. */
function spec(options: { condition?: string; pipeline?: string; rules?: boolean } = {}): string {
  const lines = [
    "signal: logs",
    `pipeline: ${options.pipeline ?? "logs/in"}`,
    "duration: 2",
    `sample_text: '${SAMPLE}'`,
  ];
  if (options.rules !== false) {
    lines.push(
      "rules:",
      `  - name: total ${RULE_MARKER}`,
      "    context: log",
      "    quantifier: count",
      '    condition: "true"',
      "    count: { operator: gte, value: 1 }",
      "  - context: log",
      "    quantifier: any",
      `    condition: '${options.condition ?? `body != "${RULE_MARKER}"`}'`,
    );
  }
  return `${lines.join("\n")}\n`;
}

let folder: string;
let tokens: string[];

async function file(name: string, text: string): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, text);
  return path;
}

/** `telflo …` with TELFLO_TOKEN and TELFLO_SERVER; its output checked for every token (a boolean) first. */
async function cli(token: string, args: readonly string[]): Promise<CliRun> {
  vi.stubEnv("TELFLO_TOKEN", token);
  vi.stubEnv("TELFLO_SERVER", api.origin);
  const ran = await runCli(args);
  expect(tokens.some((each) => ran.stdout.includes(each) || ran.stderr.includes(each))).toBe(false);
  return ran;
}

/** A group organization's service account with a write and a read token, and its own draft configuration holding YAML. */
async function organization() {
  const at = new Date(Date.now() - 60_000);
  const admin = await createUserWithOrganization(api.ownerDb);
  const { organization: group } = await addMembership(api.ownerDb, { userId: admin.user.id, role: "admin" });
  const { user } = await addServiceAccount(api.ownerDb, { organizationId: group.id, createdAt: at });
  const tokenOf = async (access: "read" | "write") =>
    (await addApiToken(api.ownerDb, { organizationId: group.id, serviceAccountUserId: user.id, access, created_at: at })).token;
  const write = await tokenOf("write");
  const read = await tokenOf("read");
  tokens.push(write, read);
  const configuration = await addConfiguration(api.ownerDb, { organizationId: group.id, created_by_user_id: user.id });
  const version = await addConfigurationVersion(api.ownerDb, {
    configurationId: configuration.id,
    organizationId: group.id,
    version_number: 1,
    yaml_content: YAML,
    created_by_user_id: user.id,
  });
  return { id: group.id, userId: user.id, write, read, configurationId: configuration.id, versionId: version.id };
}

/** The dispatcher carrying every waiting run to its end, as the api's own tests do. */
async function runAll(): Promise<void> {
  const dispatcher = createTestRunDispatcher({
    db,
    fileStore: store,
    tester: tester.client,
    evaluator: evaluator.client,
    organizationVariables: UNCALLED_TESTING.organizationVariables,
    queued: signal,
    runsPerTester: 4,
    log: { warn: () => undefined, error: () => undefined },
  });
  dispatchers.push(dispatcher);
  await dispatcher.tick();
  await dispatcher.settled();
}

let sleeps: number;

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  folder = await mkdtemp(join(tmpdir(), "telflo-cli-test-runs-files-"));
  tokens = [];
  sleeps = 0;
  api.logLines.length = 0;
  tester.fake.takeRequests();
  evaluator.fake.takeRequests();
  // Each wait between polls carries the waiting runs: the next poll sees them ended.
  setTestRunClock({
    sleep: async () => {
      sleeps += 1;
      await runAll();
    },
  });
});

afterEach(async () => {
  setTestRunClock();
  vi.unstubAllEnvs();
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
  await rm(folder, { recursive: true, force: true });
  expect(tester.fake.takeViolations()).toEqual([]);
  expect(evaluator.fake.takeViolations()).toEqual([]);
  const logged = api.logLines.join("\n");
  expect(tokens.some((token) => logged.includes(token))).toBe(false);
  for (const marker of [YAML_MARKER, SAMPLE_MARKER, RULE_MARKER]) expect(logged.includes(marker)).toBe(false);
});

const results = (ran: CliRun) =>
  (JSON.parse(ran.stdout) as { results: Array<{ position: number; id: string; name: string; passed: boolean }> }).results;

describe("telflo test against the API", () => {
  it("a YAML run: queued, polled to succeeded, results named by position, its output saved (exit 0)", async () => {
    const org = await organization();
    const output = join(folder, "output.json");
    const ran = await cli(org.write, ["--json", "test", "--spec", await file("spec.yaml", spec()), "-f", await file("c.yaml", YAML), "--output", output]);
    expect(ran.code).toBe(0);
    const reply = JSON.parse(ran.stdout) as { status: string; rulesSource: string; distribution: string };
    expect(reply).toMatchObject({ status: "succeeded", rulesSource: "inline" });
    expect(results(ran).map(({ position, name, passed }) => ({ position, name, passed }))).toEqual([
      { position: 1, name: `total ${RULE_MARKER}`, passed: true },
      { position: 2, name: "rule 2", passed: true },
    ]);
    expect(sleeps).toBe(1);
    // The fake tester echoes the sample as the run's output.
    expect(readFileSync(output, "utf8") === SAMPLE).toBe(true);
    const run = await api.ownerDb.selectFrom("test_runs").selectAll().executeTakeFirstOrThrow();
    expect(run).toMatchObject({ configuration_id: null, target_pipeline: "logs/in", duration_seconds: 2 });
    expect((run.validation_rules as Array<{ ottl: unknown; name: string }>).map((rule) => rule.ottl)).toEqual([
      { context: "log", quantifier: "count", condition: "true", count: { operator: "gte", value: 1 } },
      { context: "log", quantifier: "any", condition: `body != "${RULE_MARKER}"` },
    ]);
  });

  it("a rule the evaluator fails is validation_failed: exit 4, its result FAIL in the table", async () => {
    const org = await organization();
    const ran = await cli(org.write, [
      "test",
      "--spec",
      await file("spec.yaml", spec({ condition: `body == "${fakeOttlEvaluatorMarker("fail")}"` })),
      "-f",
      await file("c.yaml", YAML),
    ]);
    expect(ran.code).toBe(4);
    const lines = ran.stdout.split("\n");
    expect(lines[0]?.startsWith("Run ") && lines[0].includes(": validation_failed")).toBe(true);
    expect(/^1\s+total \S+\s+PASS/.test(lines[3] ?? "")).toBe(true);
    expect(/^2\s+rule 2\s+FAIL/.test(lines[4] ?? "")).toBe(true);
    expect(ran.stderr.endsWith(`error: ${RULES_FAILED_MESSAGE}\n`)).toBe(true);
  });

  it("a version's run with the spec's rules (--config --version)", async () => {
    const org = await organization();
    const ran = await cli(org.write, ["--json", "test", "--spec", await file("spec.yaml", spec()), "--config", org.configurationId, "--version", "1"]);
    expect(ran.code).toBe(0);
    expect(results(ran).map((result) => result.passed)).toEqual([true, true]);
    const run = await api.ownerDb.selectFrom("test_runs").select(["configuration_id", "configuration_version_id"]).executeTakeFirstOrThrow();
    expect(run).toEqual({ configuration_id: org.configurationId, configuration_version_id: org.versionId });
  });

  it("--save replaces the API-owned rules (no pipeline name sent), keeps a person's, and runs them all, named by id", async () => {
    const org = await organization();
    const ids = { organizationId: org.id, configurationId: org.configurationId, configurationVersionId: org.versionId };
    const pipeline = await addValidationPipeline(api.ownerDb, { ...ids, pipeline_name: "logs/in", signal: "logs" });
    const kept = await addValidationRule(api.ownerDb, { ...ids, validationPipelineId: pipeline.id, pattern: SAMPLE_MARKER, name: "a person's" });
    const ran = await cli(org.write, ["--json", "test", "--spec", await file("spec.yaml", spec()), "--config", org.configurationId, "--save"]);
    expect(ran.code).toBe(0);
    const reply = JSON.parse(ran.stdout) as { rulesSource: string; savedPipeline: Record<string, unknown> };
    expect(reply.rulesSource).toBe("saved");
    expect(reply.savedPipeline).toEqual({ id: pipeline.id, pipeline: "logs/in", created: false, rulesReplaced: 0, rulesKept: 1 });
    const named = results(ran);
    expect(named).toHaveLength(3);
    expect(named.find((result) => result.id === kept.id)?.name).toBe("a person's");
    expect(named.every((result) => result.passed)).toBe(true);
    const saved = await api.ownerDb.selectFrom("validation_rules").select(["id", "name", "is_api_owned"]).orderBy("position").execute();
    expect(saved.map((rule) => ({ name: rule.name, isApiOwned: rule.is_api_owned }))).toEqual([
      { name: "a person's", isApiOwned: false },
      { name: `total ${RULE_MARKER}`, isApiOwned: true },
      { name: "", isApiOwned: true },
    ]);
    // Results by id: each saved rule's own name, in the run's (position) order.
    expect(named.map((result) => saved.find((rule) => rule.id === result.id)?.name ?? null)).toEqual(["a person's", `total ${RULE_MARKER}`, ""]);
    expect(named.map((result) => result.name)).toEqual(["a person's", `total ${RULE_MARKER}`, "rule 3"]);

    // --saved runs them again as they are, named from route 13.
    const again = await cli(org.write, ["--json", "test", "--spec", await file("bare.yaml", spec({ rules: false })), "--config", org.configurationId, "--saved"]);
    expect(again.code).toBe(0);
    expect(results(again).map((result) => result.name)).toEqual(["a person's", `total ${RULE_MARKER}`, "rule 3"]);
  });

  it("--saved with no saved rules is the API's 422: its words, exit 1, no run", async () => {
    const org = await organization();
    const ran = await cli(org.write, ["test", "--spec", await file("bare.yaml", spec({ rules: false })), "--config", org.configurationId, "--saved"]);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe("error: The configuration is not valid. The version has no saved validation rules for this pipeline.\n");
    expect(await api.ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
  });

  it("the server's refusals: a rule that can't fail (exit 2, its index), a pipeline the text lacks (exit 1)", async () => {
    const org = await organization();
    const yaml = await file("c.yaml", YAML);
    const tautology = await cli(org.write, ["test", "--spec", await file("t.yaml", spec({ condition: 'attributes["k"] == attributes["k"]' })), "-f", yaml]);
    expect(tautology.code).toBe(2);
    expect(tautology.stderr).toBe("error: test spec: rules[1] isn't a valid rule (condition): the server's rule check refused it.\n");
    const other = await cli(org.write, ["test", "--spec", await file("o.yaml", spec({ pipeline: "logs/other" })), "-f", yaml]);
    expect(other.code).toBe(1);
    expect(other.stderr).toBe("error: The configuration is not valid. The configuration has no pipeline of this name.\n");
    expect(await api.ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
  });

  it("a full queue's 429 (no Retry-After) isn't retried: its message, exit 1", async () => {
    const org = await organization();
    for (let index = 0; index < TEST_RUNS_WAITING_MAXIMUM_PER_USER; index += 1) {
      await addTestRun(api.ownerDb, { organizationId: org.id, configurationId: null, configurationVersionId: null, queuedByUserId: org.userId });
    }
    const ran = await cli(org.write, ["test", "--spec", await file("spec.yaml", spec()), "-f", await file("c.yaml", YAML)]);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(`error: You have ${TEST_RUNS_WAITING_MAXIMUM_PER_USER} test runs waiting already. Wait for some to finish.\n`);
    expect(ran.stderr.includes("Rate limited")).toBe(false);
  });

  it("a read token on the run's create is exit 3, nothing queued", async () => {
    const org = await organization();
    const ran = await cli(org.read, ["test", "--spec", await file("spec.yaml", spec()), "-f", await file("c.yaml", YAML)]);
    expect(ran.code).toBe(3);
    expect(ran.stderr).toBe(`error: ${READ_ONLY_TOKEN_MESSAGE}\n`);
    expect(await api.ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
  });
});
