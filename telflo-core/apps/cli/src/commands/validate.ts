/*
 * `telflo validate <file|->`: checked by the collector validator, nothing stored.
 *
 * - Logged in (the file, or `TELFLO_TOKEN`): `POST /validate` (route 15),
 *   the organization's variables filled in, as `config push` validates.
 * - Not logged in: the anonymous route, no token, no organization.
 *   `--config <id>` reads a stored configuration's pin, so it needs a
 *   login. A server that doesn't offer the anonymous route (a self-hosted
 *   install's default) answers it 404: the CLI says to log in (exit 3), in
 *   fixed words.
 * - Exit 0 valid, 4 invalid (the collector's errors as the output), 2 for
 *   a version or distribution the catalog doesn't have (a 400), 1 when
 *   the validator couldn't check the text (503: not a verdict).
 */

import type { Command } from "commander";
import type { PublicValidateRequest, PublicValidateResponse } from "@telflo/contracts";
import { ApiError, type ApiClient } from "../api.js";
import { anonymousClient, clientFor, resolveLogin } from "../context.js";
import { requireId } from "../ids.js";
import { readInput } from "../input.js";
import { COLLECTOR_REFUSED_CODES, renderValidationErrors, rewordedError, validateConfiguration } from "../ops/validate.js";
import { emit, EXIT, ExitError, isJsonMode, terminalText, writeErr } from "../output.js";
import { describePin, resolvePin } from "../pin.js";

export const CONFIG_NEEDS_LOGIN_MESSAGE =
  "--config reads a stored configuration's pin, so it needs a login: run telflo login (or set TELFLO_TOKEN).";
/** A logged-out validate the server answers 404: it doesn't validate without a login. */
export const SIGN_IN_TO_VALIDATE_MESSAGE =
  "This server doesn't validate without a login: run telflo login (or set TELFLO_TOKEN).";
export const VALIDATION_FAILED_MESSAGE = "The configuration failed validation.";
export const VALIDATION_UNAVAILABLE_MESSAGE = (message: string): string => `Couldn't validate (not a verdict on the YAML): ${message}`;

/** A 400 about the request itself (the text, the distribution, the version): a usage error. */
const REQUEST_REFUSED_CODES: ReadonlySet<string> = new Set(["invalid_request", ...COLLECTOR_REFUSED_CODES]);

export interface ValidateOptions {
  collectorVersion?: string;
  distribution?: string;
  config?: string;
}

/** The verdict as the terminal shows it. */
export function renderVerdict(verdict: PublicValidateResponse): string {
  const collector = terminalText(verdict.collectorVersion);
  if (verdict.valid) return `Valid (collector ${collector}).`;
  return [`Invalid (collector ${collector}):`, ...renderValidationErrors(verdict.errors)].join("\n");
}

/** The client and route for this run: the login's, or the anonymous route's without one. */
function clientForValidate(options: ValidateOptions): { client: ApiClient; anonymous: boolean } {
  const login = resolveLogin();
  if (login !== null) return { client: clientFor(login), anonymous: false };
  if (options.config !== undefined) throw new ExitError(CONFIG_NEEDS_LOGIN_MESSAGE, EXIT.AUTH);
  return { client: anonymousClient(), anonymous: true };
}

export async function runValidate(file: string, options: ValidateOptions): Promise<void> {
  // The usage checks first (a malformed --config, a file that can't be read: exit 2), then the login.
  const configurationId = options.config === undefined ? undefined : requireId(options.config, "configuration");
  const yaml = await readInput(file);
  const { client, anonymous } = clientForValidate(options);
  let { collectorVersion, distribution } = options;
  if (configurationId !== undefined) {
    const pin = await resolvePin(client, configurationId);
    // An explicit --collector-version or --distribution still wins.
    collectorVersion ??= pin.collectorVersion;
    distribution ??= pin.distribution;
    if (!isJsonMode()) writeErr(`# validating on ${terminalText(describePin({ collectorVersion, distribution }))} (from configuration ${configurationId})`);
  }
  const body: PublicValidateRequest = {
    yaml,
    ...(distribution !== undefined && { distribution }),
    ...(collectorVersion !== undefined && { collectorVersion }),
  };
  let verdict: PublicValidateResponse;
  try {
    verdict = await validateConfiguration(client, body, { anonymous });
  } catch (error) {
    // Its anonymous route switched off: a login is the way (exit 3). A logged-in 404 stays as the API said it.
    if (anonymous && error instanceof ApiError && error.status === 404) {
      throw new ExitError(SIGN_IN_TO_VALIDATE_MESSAGE, EXIT.AUTH, "login_required", 404);
    }
    if (error instanceof ApiError && error.status === 400 && REQUEST_REFUSED_CODES.has(error.code ?? "")) {
      throw new ExitError(error.message, EXIT.USAGE, error.code ?? undefined, error.status);
    }
    if (error instanceof ApiError && error.status === 503) {
      throw rewordedError(error, VALIDATION_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
  emit(verdict, () => renderVerdict(verdict));
  if (!verdict.valid) throw new ExitError(VALIDATION_FAILED_MESSAGE, EXIT.FAILED);
}

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Validate collector YAML with a real collector (logged in, or without a login where the server allows it)")
    .argument("<file>", "the YAML file, or - for stdin")
    .option("--collector-version <version>", "the collector's version, e.g. 0.147.0")
    .option("--distribution <distribution>", "the collector's distribution, e.g. otelcol-contrib")
    .option("--config <id>", "validate on the collector a stored configuration is pinned to (an explicit flag still wins; needs a login)")
    .action((file: string, options: ValidateOptions) => runValidate(file, options));
}
