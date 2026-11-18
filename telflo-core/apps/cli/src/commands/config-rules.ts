/*
 * `telflo config rules <id> [--version <n>]` (D27 decision 27, route 13),
 * added to the `config` command `program.ts`
 * creates (Preflight ruling 22): the validation pipelines saved on a
 * version (default the latest), what `telflo test --saved` runs and the
 * Validation tab shows. Rules' names and texts are configuration text:
 * printed for the person who asked, each server string one line without
 * control characters (`cell`, Ruling 237), never in a message.
 */

import type { Command } from "commander";
import type { PublicValidationPipeline, PublicValidationRule } from "@telflo/contracts";
import { requireClient } from "../context.js";
import { requireId } from "../ids.js";
import { latestVersionNumber, listValidationPipelines } from "../ops/pipelines.js";
import { emit, printTable } from "../output.js";
import { cell, positiveInteger } from "./test.js";

export const NO_PIPELINES_MESSAGE = (versionNumber: number): string => `No saved validation pipelines on version ${versionNumber}.`;

/** What a rule checks, in one line: an OTTL rule's context, quantifier, texts and count; another's pattern. */
export function describeRule(rule: Pick<PublicValidationRule, "kind" | "pattern" | "ottl">): string {
  if (rule.ottl === null) return cell(rule.pattern);
  const { context, quantifier, condition, expression, count } = rule.ottl;
  const parts: string[] = [context, quantifier];
  if (expression !== undefined) parts.push(expression);
  if (condition !== undefined) parts.push(quantifier === "distinct" ? `where ${condition}` : condition);
  if (count !== undefined) parts.push(`${count.operator} ${count.value}${count.value2 === undefined ? "" : `..${count.value2}`}`);
  return cell(parts.join(" "));
}

function renderPipeline(pipeline: PublicValidationPipeline): string {
  const owned = pipeline.rules.filter((rule) => rule.isApiOwned).length;
  return [
    `${cell(pipeline.pipeline)} (${cell(pipeline.signal)}): ${pipeline.rules.length} rules, ${owned} API-owned`,
    printTable(
      pipeline.rules.map((rule, index) => ({
        "#": index + 1,
        name: cell(rule.name),
        kind: cell(rule.kind),
        target: cell(rule.target),
        api: rule.isApiOwned ? "yes" : "",
        rule: describeRule(rule),
      })),
      ["#", "name", "kind", "target", "api", "rule"],
    ),
  ].join("\n");
}

/** `telflo config rules`. */
export async function showConfigRules(id: string, options: { version?: number }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configurationId = requireId(id, "configuration");
  const client = requireClient(env);
  const versionNumber = options.version ?? (await latestVersionNumber(client, configurationId));
  const items = await listValidationPipelines(client, configurationId, versionNumber);
  emit({ configurationId, versionNumber, items }, () =>
    items.length === 0 ? NO_PIPELINES_MESSAGE(versionNumber) : items.map(renderPipeline).join("\n\n"),
  );
}

export function registerConfigRulesCommand(config: Command): void {
  config
    .command("rules")
    .description("Show the validation rules saved on a version (what telflo test --saved runs)")
    .argument("<id>", "the configuration's id")
    .option("--version <n>", "the version (default the latest)", positiveInteger("--version"))
    .action((id: string, options: { version?: number }) => showConfigRules(id, options));
}
