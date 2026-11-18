/*
 * `telflo ottl lint [file|-]` (D27 decision 26): OTTL parse-checked with the real grammar (route 16), a
 * collector configuration's every expression, or raw expressions with
 * `--context`. Exit 0 when everything parses, 4 when something doesn't (or
 * the YAML itself doesn't parse: its errors are the output), 2 for a usage
 * error (the API's 400 `invalid_request` too), 1 when the evaluator couldn't lint (503: nothing checked).
 */

import { Option, type Command } from "commander";
import type { PublicOttlLintResponse } from "@telflo/contracts";
import { ApiError } from "../api.js";
import { requireClient } from "../context.js";
import { readInput } from "../input.js";
import { buildLintBody, lintOttl, OTTL_CONTEXTS, OTTL_KINDS, renderLint, type OttlLintOptions } from "../ops/ottl.js";
import { renderValidationErrors, rewordedError, validationErrorsOf } from "../ops/validate.js";
import { emit, EXIT, ExitError } from "../output.js";

export const LINT_FAILED_MESSAGE = "OTTL lint failed.";
export const YAML_INVALID_MESSAGE = "The configuration isn't valid YAML, so nothing was linted.";
export const LINT_UNAVAILABLE_MESSAGE = (message: string): string => `Couldn't lint (not a verdict on the OTTL): ${message}`;

export async function ottlLint(file: string | undefined, options: OttlLintOptions): Promise<void> {
  // Every usage check before the login (the input read, the expressions' count and lengths: exit 2).
  const input = file === undefined ? null : await readInput(file);
  const body = buildLintBody(input, options);
  const client = requireClient();
  let result: PublicOttlLintResponse;
  try {
    result = await lintOttl(client, body);
  } catch (error) {
    if (error instanceof ApiError && error.status === 422 && error.code === "configuration_invalid") {
      const errors = validationErrorsOf(error.details);
      emit({ valid: false, errors }, () => ["Invalid YAML:", ...renderValidationErrors(errors)].join("\n"));
      throw new ExitError(YAML_INVALID_MESSAGE, EXIT.FAILED, error.code, error.status);
    }
    if (error instanceof ApiError && error.status === 503) {
      throw rewordedError(error, LINT_UNAVAILABLE_MESSAGE);
    }
    // A request the API refused as such (more than 200 expressions in a YAML, say): a usage error, as validate's (Ruling 239).
    if (error instanceof ApiError && error.status === 400 && error.code === "invalid_request") {
      throw new ExitError(error.message, EXIT.USAGE, error.code, error.status);
    }
    throw error;
  }
  emit(result, () => renderLint(result));
  if (!result.valid) throw new ExitError(LINT_FAILED_MESSAGE, EXIT.FAILED);
}

export function registerOttlCommands(program: Command): void {
  const ottl = program.command("ottl").description("OTTL (OpenTelemetry Transformation Language) tools");
  const collect = (value: string, previous: string[]): string[] => [...previous, value];
  ottl
    .command("lint")
    .description(
      "Parse-check OTTL with the real grammar: a collector configuration (every transform, filter, routing and " +
        "tail_sampling expression), or raw expressions with --context",
    )
    .argument("[file]", "a collector configuration's YAML, or one expression a line with --context; - for stdin")
    .addOption(new Option("--context <context>", "lint raw expressions against this context").choices(OTTL_CONTEXTS))
    .addOption(new Option("--kind <kind>", "what the raw expressions are").choices(OTTL_KINDS).default("condition"))
    .option("--expr <ottl>", "an expression (repeatable; needs --context)", collect, [] as string[])
    .action((file: string | undefined, options: OttlLintOptions) => ottlLint(file, options));
}
