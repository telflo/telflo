/*
 * `telflo deploy --fleet --config [--version] [--group | --name]
 * [--replicas] [--namespace] [--role]` (D27 decisions 11 and 28), the
 * older CLI's `--deployment` renamed `--group`:
 * updates the one group of the fleet serving the configuration, or creates
 * one named `--name` (`ops/deploy.ts`).
 */

import { InvalidArgumentError, Option, type Command } from "commander";
import type { ApiClient } from "../api.js";
import { requireClient } from "../context.js";
import { requireId } from "../ids.js";
import { deployConfiguration, KUBERNETES_ROLES, type DeployOptions } from "../ops/deploy.js";
import { emit, terminalText, writeNote } from "../output.js";

/** `--role` on a group that exists: its role is fixed (not patchable), so the flag does nothing. */
export const ROLE_ON_UPDATE_NOTE = "--role applies only to a new group.";

/** A positive whole number (`--version`, `--replicas`): anything else is commander's usage error (exit 2). */
export function positiveInteger(value: string): number {
  const number = /^\d{1,9}$/.test(value) ? Number(value) : 0;
  if (number < 1) throw new InvalidArgumentError("Use a whole number of at least 1.");
  return number;
}

/** `telflo deploy`. */
export async function deployCommand(client: ApiClient, options: DeployOptions): Promise<void> {
  const result = await deployConfiguration(client, options);
  if (result.action === "updated" && options.role !== undefined) writeNote(ROLE_ON_UPDATE_NOTE);
  const version = result.versionNumber === null ? "" : ` v${result.versionNumber}`;
  emit(result, () =>
    terminalText(result.action === "updated" ? `Group ${result.id} now serves${version}.` : `Created group ${result.id} serving${version}.`),
  );
}

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy a configuration's version to a fleet: updates the group serving it, or creates one with --name")
    .requiredOption("--fleet <id>", "the fleet's id (telflo fleet list)")
    .requiredOption("--config <id>", "the configuration's id")
    .option("--version <n>", "the version's number (default: the highest published)", positiveInteger)
    .addOption(new Option("--group <id>", "the group to update (telflo fleet groups)").conflicts("name"))
    .option("--name <name>", "the new group's name, when no group serves the configuration yet")
    .option("--replicas <n>", "a gateway's replicas (kubernetes-supervisor fleets)", positiveInteger)
    .option("--namespace <namespace>", "a Kubernetes group's namespace")
    .addOption(new Option("--role <role>", "a new Kubernetes group's role").choices(KUBERNETES_ROLES))
    .action((options: DeployOptions) => {
      // A malformed id is exit 2 before the login is read.
      requireId(options.fleet, "fleet");
      requireId(options.config, "configuration");
      if (options.group !== undefined) requireId(options.group, "group");
      return deployCommand(requireClient(), options);
    });
}
