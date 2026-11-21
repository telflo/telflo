/*
 * `telflo test`: a spec's sample and OTTL rules run in the sandbox on a text
 * (`-f`) or a stored version (`--config [--version]`), on routes 26-28.
 *
 * - The spec's rules are converted and checked first (`test-spec-file.ts`):
 *   exit 2 naming the rule's index and field. The server's own refusal of a
 *   rule (400 `invalid_request` at `rules.N…`, or `validation_rule_invalid`
 *   with its `ruleIndex`) is named the same way.
 * - `--save` replaces the version's API-owned rules on the spec's pipeline
 *   (route 14, no pipeline `name`), then runs the saved rules; `--saved`
 *   runs them as they are. Saved rules' results are matched by id, named
 *   from route 14's reply or route 13; inline rules' by position, named
 *   from the spec.
 * - `succeeded` exits 0; `failed` and `validation_failed` exit 4; a run
 *   that hasn't ended by the deadline (`--timeout`, else the run's duration
 *   and 120 s) exits 1. `--saved` with no saved rules is the API's 422
 *   `configuration_invalid` (exit 1); a full queue's 429 has no
 *   `Retry-After` and isn't retried (exit 1). A collector the catalog
 *   doesn't offer (400 `collector_version_unknown`, `…_retired`,
 *   `collector_distribution_unknown`) is exit 2, as validate's.
 *
 * A run's text, sample and rules are configuration text: sent in the body
 * only, never printed in a message. Results' names, errors and advisories are
 * printed in the human table, flattened to one line.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import type { PublicReplacedValidationRules, PublicTestRun, ValidationRuleResult, ValidationRuleResultDetail } from "@telflo/contracts";
import { ApiError } from "../api.js";
import { requireClient } from "../context.js";
import { requireId } from "../ids.js";
import { readInput } from "../input.js";
import { listValidationPipelines, replaceApiOwnedRules } from "../ops/pipelines.js";
import {
  assertTestTargetUsage,
  buildTestRunBody,
  DEFAULT_WAIT_MARGIN_SECONDS,
  getTestRunOutput,
  queueTestRun,
  resolveTestTarget,
  testRunClock,
  waitForTestRun,
} from "../ops/test-runs.js";
import { COLLECTOR_REFUSED_CODES } from "../ops/validate.js";
import { emit, EXIT, ExitError, isJsonMode, printTable, terminalText, writeErr, writeNote, writeOut } from "../output.js";
import { describePin } from "../pin.js";
import { parseTestSpec, rulePlace, type TestSpec } from "../test-spec-file.js";

export const SAVE_AND_SAVED_MESSAGE = "Give at most one of --save and --saved.";
export const SAVED_NEEDS_VERSION_MESSAGE = "--save and --saved need a stored version (--config), not -f.";
export const ONE_STDIN_MESSAGE = "Only one of --spec and -f can read stdin (-).";
export const RUN_FAILED_MESSAGE = "The test run failed.";
export const RULES_FAILED_MESSAGE = "The test run's rules didn't all pass.";
export const NOT_ENDED_MESSAGE = (runId: string, seconds: number, lastStatus: string | null): string =>
  `Test run ${cell(runId)} didn't end within ${seconds} s (its last status: ${cell(lastStatus ?? "unknown")}).`;
export const NO_OUTPUT_MESSAGE = "The run has no output to save.";
export const OUTPUT_NOT_SAVED_MESSAGE = (path: string): string => `Couldn't save the run's output to ${path}.`;

/** A cell's most characters in the human table (`--json` has them whole). */
const MAXIMUM_CELL_LENGTH = 300;

/** A whole number from 1 (`--version`, `--timeout`): commander's usage error otherwise. */
export function positiveInteger(what: string): (value: string) => number {
  return (value) => {
    if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw new InvalidArgumentError(`${what} must be a whole number from 1.`);
    return Number(value);
  };
}

/**
 * Server text (or a spec's) as one line for the terminal: C0 and C1 control
 * characters out (no escape sequence reaches the terminal), long text cut.
 * Every server string printed outside `--json` goes through it; `--output`
 * writes the run's output as it is.
 */
export function cell(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  // Line breaks and tabs become spaces (one line), then terminalText removes every other control character.
  const flat = terminalText(text.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, " ")).trim();
  return flat.length > MAXIMUM_CELL_LENGTH ? `${flat.slice(0, MAXIMUM_CELL_LENGTH)}…` : flat;
}

/** A result's detail in a few words: its kind and counts, never its snippets or samples. */
export function describeDetail(detail: ValidationRuleResultDetail | null): string {
  if (detail === null) return "";
  switch (detail.kind) {
    case "no_match":
      return `no match in ${detail.source} (${detail.searchedCharacters} characters searched)`;
    case "unexpected_match":
      return `${detail.totalMatchCount}${detail.moreMatches ? "+" : ""} unexpected matches in ${detail.source}`;
    case "record_mismatch":
      return `${detail.missCount} of ${detail.totalCount} ${detail.context} records missed (${detail.matchedCount} matched)`;
    case "distinct_mismatch":
      return `${detail.distinctCount} distinct values in ${detail.matchedCount} of ${detail.totalCount} records`;
  }
}

/** A rule's result with the name the person knows it by. */
export interface NamedResult extends ValidationRuleResult {
  position: number;
  name: string;
}

/**
 * Results named: inline rules' by position from the spec (their ids are fresh
 * per run); saved rules' by id from the saved pipeline. An unnamed rule is
 * `rule N`.
 */
export function nameResults(
  results: readonly ValidationRuleResult[] | null,
  names: { byPosition: readonly (string | undefined)[] } | { byId: ReadonlyMap<string, string> },
): NamedResult[] {
  return (results ?? []).map((result, index) => {
    const name = "byId" in names ? names.byId.get(result.id) : names.byPosition[index];
    return { ...result, position: index + 1, name: name === undefined || name === "" ? `rule ${index + 1}` : name };
  });
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The spec's own field names for an issue's path below a rule (`ottl.count.value` → `count.value`). */
const RULE_FIELDS = new Set(["name", "context", "quantifier", "condition", "expression", "count", "operator", "value", "value2"]);

function specFieldOf(path: readonly unknown[]): string | undefined {
  const parts = path[0] === "ottl" ? path.slice(1) : path;
  if (parts.length === 0 || !parts.every((part) => typeof part === "string" && RULE_FIELDS.has(part))) return undefined;
  return parts.join(".");
}

/**
 * The server's refusal of one of the spec's rules, named as the CLI's own
 * check names it (exit 2): a 400 `invalid_request` whose issue is at
 * `rules.N…`, or `validation_rule_invalid` with its `ruleIndex` (the
 * evaluator's problems quote the rule: only their fields are named).
 */
export function ruleRefusalOf(error: unknown): ExitError | undefined {
  if (!(error instanceof ApiError) || error.status !== 400) return undefined;
  if (error.code === "validation_rule_invalid") {
    const details = error.details as { ruleIndex?: unknown; problems?: unknown } | undefined;
    if (!isInteger(details?.ruleIndex)) return undefined;
    const fields = Array.isArray(details.problems)
      ? details.problems
          .map((problem: unknown) => (problem as { field?: unknown } | null)?.field)
          .map((field) => (typeof field === "string" ? specFieldOf(field.split(".")) : undefined))
          .filter((field): field is string => field !== undefined)
      : [];
    const where = fields.length === 0 ? "" : ` (${[...new Set(fields)].join(", ")})`;
    return new ExitError(`test spec: ${rulePlace(details.ruleIndex)} isn't a valid rule${where}: the server's rule check refused it.`, EXIT.USAGE, error.code, error.status);
  }
  if (error.code === "invalid_request" && Array.isArray(error.details)) {
    for (const issue of error.details as unknown[]) {
      const path = (issue as { path?: unknown } | null)?.path;
      if (!Array.isArray(path) || path[0] !== "rules" || !isInteger(path[1])) continue;
      return new ExitError(`test spec: the server refused ${rulePlace(path[1], specFieldOf(path.slice(2)))}.`, EXIT.USAGE, error.code, error.status);
    }
  }
  return undefined;
}

/** A 422 `configuration_invalid` with its errors' fixed words (`--saved` with none saved, a pipeline the text lacks): exit 1. */
export function configurationRefusalOf(error: unknown): ApiError | undefined {
  if (!(error instanceof ApiError) || error.status !== 422 || error.code !== "configuration_invalid") return undefined;
  const errors = (error.details as { errors?: unknown } | undefined)?.errors;
  const words = Array.isArray(errors)
    ? errors.map((item: unknown) => (item as { message?: unknown } | null)?.message).filter((message): message is string => typeof message === "string")
    : [];
  if (words.length === 0) return undefined;
  return new ApiError(error.status, error.code, cell(`${error.message} ${words.join(" ")}`), error.details);
}

/**
 * A 400 naming a collector the catalog doesn't offer (`--collector-version`,
 * `--distribution`, the spec's or the pin's): a usage error, exit 2, as
 * validate's (a deliberate mapping: its code and status kept).
 */
export function collectorRefusalOf(error: unknown): ExitError | undefined {
  if (!(error instanceof ApiError) || error.status !== 400 || !COLLECTOR_REFUSED_CODES.has(error.code ?? "")) return undefined;
  return new ExitError(error.message, EXIT.USAGE, error.code ?? undefined, error.status);
}

/** A call whose refusal may name a spec's rule, a text's error or an unknown collector. */
async function namingRefusals<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw ruleRefusalOf(error) ?? configurationRefusalOf(error) ?? collectorRefusalOf(error) ?? error;
  }
}

export interface TestCommandOptions {
  spec: string;
  file?: string;
  config?: string;
  version?: number;
  collectorVersion?: string;
  distribution?: string;
  save?: boolean;
  saved?: boolean;
  output?: string;
  timeout?: number;
}

/** What `--save` did, as `--json` reports it. */
function savedSummary(saved: PublicReplacedValidationRules) {
  return {
    id: saved.id,
    pipeline: saved.pipeline,
    created: saved.created,
    rulesReplaced: saved.rulesReplaced,
    rulesKept: saved.rulesKept,
  };
}

/** A count a reply gives: a whole number from 0 (the CLI prints only what it checked). */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** `--save`'s counts, or fixed words when the reply's aren't counts. */
export function savedCounts(saved: Pick<PublicReplacedValidationRules, "rulesReplaced" | "rulesKept">): string {
  return isCount(saved.rulesReplaced) && isCount(saved.rulesKept)
    ? `replaced ${saved.rulesReplaced} API-owned, kept ${saved.rulesKept}`
    : "the server's counts were unreadable";
}

function renderRun(run: PublicTestRun, results: readonly NamedResult[]): string {
  const lines = [`Run ${cell(run.id)}: ${cell(run.status)}${isCount(run.durationMs) ? ` (${run.durationMs} ms)` : ""}`];
  if (run.errorMessage !== null) lines.push(`Error: ${cell(run.errorMessage)}`);
  if (results.length > 0) {
    lines.push(
      printTable(
        results.map((result) => ({
          "#": result.position,
          rule: cell(result.name),
          result: result.passed ? "PASS" : "FAIL",
          error: cell(result.error),
          advisory: cell(result.advisory),
          detail: cell(describeDetail(result.detail)),
        })),
        ["#", "rule", "result", "error", "advisory", "detail"],
      ),
    );
  }
  return lines.join("\n");
}

/** `telflo test`. */
export async function runTestCommand(options: TestCommandOptions, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertTestTargetUsage({ hasYaml: options.file !== undefined, configurationId: options.config, version: options.version });
  const save = options.save === true;
  const saved = options.saved === true;
  if (save && saved) throw new ExitError(SAVE_AND_SAVED_MESSAGE, EXIT.USAGE);
  if ((save || saved) && options.file !== undefined) throw new ExitError(SAVED_NEEDS_VERSION_MESSAGE, EXIT.USAGE);
  if (options.spec === "-" && options.file === "-") throw new ExitError(ONE_STDIN_MESSAGE, EXIT.USAGE);

  const specText = await readInput(options.spec);
  const spec: TestSpec = parseTestSpec(specText, options.spec === "-" ? process.cwd() : dirname(resolve(options.spec)), {
    allowMissingRules: saved,
  });
  if (saved && spec.rules.length > 0) {
    writeNote(`Ignoring the spec's ${spec.rules.length} rules: --saved runs the version's saved rules.`);
  }

  // Every usage check before the login (a file that can't be read, a malformed --config: exit 2).
  const yaml = options.file === undefined ? undefined : await readInput(options.file);
  if (options.config !== undefined) requireId(options.config, "configuration");
  const client = requireClient(env, { sleep: (milliseconds) => testRunClock().sleep(milliseconds) });
  const target = await resolveTestTarget(client, {
    yaml,
    configurationId: options.config,
    version: options.version,
    collectorVersion: options.collectorVersion,
    distribution: options.distribution,
  });
  if (target.storedPin !== undefined && !isJsonMode()) {
    const { collectorVersion, distribution } = target.pin;
    writeErr(
      `Testing on ${cell(describePin({ collectorVersion: collectorVersion ?? "", distribution: distribution ?? "" }))} ` +
        `(the pin of configuration ${target.storedPin.configurationId} v${target.storedPin.versionNumber}).`,
    );
  }

  let names: Parameters<typeof nameResults>[1] = { byPosition: spec.rules.map((rule) => rule.name) };
  let savedPipeline: PublicReplacedValidationRules | undefined;
  if ((save || saved) && "configurationId" in target.source) {
    const { configurationId, versionNumber } = target.source;
    if (save) {
      savedPipeline = await namingRefusals(() =>
        replaceApiOwnedRules(client, configurationId, versionNumber, spec.pipeline, { signal: spec.signal, rules: spec.rules }),
      );
      names = { byId: new Map(savedPipeline.rules.map((rule) => [rule.id, rule.name])) };
      if (!isJsonMode()) {
        writeOut(
          `Saved ${spec.rules.length} rules to the ${cell(spec.pipeline)} validation pipeline of version ${versionNumber} ` +
            `(${savedCounts(savedPipeline)}).`,
        );
      }
    } else {
      const pipelines = await listValidationPipelines(client, configurationId, versionNumber);
      const pipeline = pipelines.find((each) => each.pipeline === spec.pipeline);
      names = { byId: new Map((pipeline?.rules ?? []).map((rule) => [rule.id, rule.name])) };
    }
  }

  const body = buildTestRunBody(spec, target.source, { useSavedRules: save || saved, pin: target.pin });
  const runId = await namingRefusals(() => queueTestRun(client, body));
  if (!isJsonMode()) writeErr(`Test run ${cell(runId)} queued: waiting for it to end.`);

  const timeoutSeconds = options.timeout ?? spec.duration + DEFAULT_WAIT_MARGIN_SECONDS;
  const outcome = await waitForTestRun(client, runId, { timeoutMs: timeoutSeconds * 1000 });
  if (!outcome.finished) throw new ExitError(NOT_ENDED_MESSAGE(runId, timeoutSeconds, outcome.lastStatus), EXIT.API, "test_run_not_ended");
  const run = outcome.run;

  if (options.output !== undefined) {
    try {
      writeFileSync(options.output, await getTestRunOutput(client, runId));
    } catch (error) {
      writeNote(error instanceof ApiError && error.status === 404 ? NO_OUTPUT_MESSAGE : OUTPUT_NOT_SAVED_MESSAGE(options.output));
    }
  }

  const results = nameResults(run.validationResults, names);
  emit(
    {
      ...run,
      rulesSource: save || saved ? "saved" : "inline",
      results,
      ...(savedPipeline === undefined ? {} : { savedPipeline: savedSummary(savedPipeline) }),
    },
    () => renderRun(run, results),
  );
  if (run.status === "failed") throw new ExitError(RUN_FAILED_MESSAGE, EXIT.FAILED, "test_run_failed");
  if (run.status === "validation_failed") throw new ExitError(RULES_FAILED_MESSAGE, EXIT.FAILED, "test_run_validation_failed");
}

export function registerTestCommand(program: Command): void {
  program
    .command("test")
    .description("Run a test (a sample and OTTL rules) on a configuration in the sandbox")
    .requiredOption("--spec <file>", "the test spec's YAML file, or - for stdin")
    .option("-f, --file <file>", "the configuration's YAML file, or - for stdin")
    .option("--config <id>", "a stored configuration to test; with -f, only its collector pin is used")
    .option("--version <n>", "the version to test (with --config; default the latest)", positiveInteger("--version"))
    .option("--collector-version <version>", "the collector version to run on (over the spec's and the pin's)")
    .option("--distribution <distribution>", "the collector distribution to run on (over the spec's and the pin's)")
    .option("--save", "save the spec's rules as the version's validation rules for its pipeline, then run them")
    .option("--saved", "run the version's saved validation rules instead of the spec's")
    .option("--output <file>", "save the run's output to a file")
    .option("--timeout <seconds>", "how long to wait for the run (default its duration and 120 s)", positiveInteger("--timeout"))
    .action((options: TestCommandOptions) => runTestCommand(options));
}
