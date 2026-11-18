/*
 * OTTL lint's request and rendering (D27 decision 26), on route 16 with D25's names: `valueExpressions`,
 * `ottlVersion`, an item's kind `valueExpression`. Two modes: a collector
 * configuration's YAML (every OTTL expression in it), or expressions
 * against one context. Nothing here prints; the expressions and the YAML
 * are configuration text and never reach an error's message.
 */

import type { PublicOttlLintRequest, PublicOttlLintResponse } from "@telflo/contracts";
import type { ApiClient } from "../api.js";
import { EXIT, ExitError, terminalText } from "../output.js";

/** The contexts a lint takes (the contract's `OTTL_CONTEXTS`; a drift test holds them equal). */
export const OTTL_CONTEXTS = ["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"] as const;

export type OttlContext = (typeof OTTL_CONTEXTS)[number];

/** How many expressions one lint checks (the contract's `PUBLIC_OTTL_LINT_MAXIMUM_EXPRESSIONS`). */
export const MAXIMUM_EXPRESSIONS = 200;

/** An expression's longest text (the contract's `PUBLIC_OTTL_LINT_EXPRESSION_MAXIMUM_LENGTH`). */
export const MAXIMUM_EXPRESSION_LENGTH = 8_192;

/** `--kind`'s values: the older CLI's three, and `valueExpression` (the platform's name) as `value`'s alias. */
export const OTTL_KINDS = ["condition", "statement", "value", "valueExpression"] as const;

export type OttlKind = (typeof OTTL_KINDS)[number];

export interface OttlLintOptions {
  /** Lint raw expressions against this context; without it the input is a collector configuration. */
  context?: OttlContext;
  /** What the raw expressions are (condition by default). */
  kind?: OttlKind;
  /** Inline expressions (repeatable). */
  expr?: string[];
}

export const EXPR_NEEDS_CONTEXT_MESSAGE = `--expr needs --context <context> (${OTTL_CONTEXTS.join(", ")}).`;
export const NO_INPUT_MESSAGE = "Give a collector configuration's file (or - for stdin), or --context with expressions.";
export const NOTHING_TO_LINT_MESSAGE = "Nothing to lint: give --expr '<ottl>' or a file with one expression a line.";
export const TOO_MANY_EXPRESSIONS_MESSAGE = `At most ${MAXIMUM_EXPRESSIONS} expressions can be linted at once.`;
export const EXPRESSION_TOO_LONG_MESSAGE = (index: number): string =>
  `Expression ${index + 1} is longer than ${MAXIMUM_EXPRESSION_LENGTH} characters, the most one lint takes.`;

/** One expression a line: blank lines and `#` comments left out. */
export function splitExpressions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Route 16's body, or a usage error (exit 2) before any request. */
export function buildLintBody(input: string | null, options: OttlLintOptions): PublicOttlLintRequest {
  const inline = options.expr ?? [];
  if (options.context === undefined) {
    if (inline.length > 0) throw new ExitError(EXPR_NEEDS_CONTEXT_MESSAGE, EXIT.USAGE);
    if (input === null) throw new ExitError(NO_INPUT_MESSAGE, EXIT.USAGE);
    return { yaml: input };
  }
  const expressions = [...inline, ...(input === null ? [] : splitExpressions(input))];
  if (expressions.length === 0) throw new ExitError(NOTHING_TO_LINT_MESSAGE, EXIT.USAGE);
  if (expressions.length > MAXIMUM_EXPRESSIONS) throw new ExitError(TOO_MANY_EXPRESSIONS_MESSAGE, EXIT.USAGE);
  const tooLong = expressions.findIndex((expression) => expression.length > MAXIMUM_EXPRESSION_LENGTH);
  if (tooLong !== -1) throw new ExitError(EXPRESSION_TOO_LONG_MESSAGE(tooLong), EXIT.USAGE);
  const kind = options.kind ?? "condition";
  if (kind === "statement") return { context: options.context, statements: expressions };
  if (kind === "condition") return { context: options.context, conditions: expressions };
  return { context: options.context, valueExpressions: expressions };
}

/** Route 16. */
export async function lintOttl(client: ApiClient, body: PublicOttlLintRequest): Promise<PublicOttlLintResponse> {
  return client.request<PublicOttlLintResponse>("POST", "/ottl/lint", { body });
}

/** The verdict as the terminal shows it: each item, what was skipped, and a summary; every reply string through `terminalText` (Ruling 237). */
export function renderLint(result: PublicOttlLintResponse): string {
  const lines: string[] = [];
  for (const item of result.items) {
    lines.push(`${item.valid ? "ok  " : "FAIL"} ${terminalText(item.location ?? `${item.kind}[${item.index}]`)}`);
    lines.push(`      ${terminalText(item.input)}`);
    if (item.error !== null) lines.push(`      error: ${terminalText(item.error)}`);
    if (item.note !== null) lines.push(`      note:  ${terminalText(item.note)}`);
  }
  for (const skipped of result.skipped) lines.push(`skip  ${terminalText(skipped)}`);
  const invalid = result.items.filter((item) => !item.valid).length;
  const version = result.ottlVersion === null ? "" : ` (OTTL ${terminalText(result.ottlVersion)})`;
  if (result.checked === 0) lines.push("No OTTL expressions found.");
  else if (invalid > 0) lines.push(`${invalid} of ${result.checked} expressions invalid${version}.`);
  else lines.push(`All ${result.checked} expressions parse${version}.`);
  return lines.join("\n");
}
