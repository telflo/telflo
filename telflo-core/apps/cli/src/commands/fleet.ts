/*
 * `telflo fleet list|create|groups|install` (D27 decisions 11 and 28), on
 * the platform's names, the older CLI's renamed (`fleet
 * deployments` is `fleet groups`, `--deployment` is `--group`,
 * `--server-name` is `--display-name`, `server-supervisor` is `server`).
 *
 * `fleet install` prints a SECRET: its command holds the fleet's bearer, or
 * a link's secret whose download answers it. The command goes to stdout
 * only, exactly once, and never into an error; `--json` prints the reply as
 * is (its `command` included) to stdout; the notes go to stderr. So
 * `telflo fleet install … > install.sh` holds exactly what to run.
 */

import { Option, type Command } from "commander";
import type { ApiClient } from "../api.js";
import { requireClient } from "../context.js";
import { requireId } from "../ids.js";
import {
  createFleet,
  FLEET_TOKEN_EXPIRIES,
  FLEET_TYPES,
  INSTALL_ARCHES,
  INSTALL_PLATFORMS,
  installFleet,
  installRequestOf,
  listFleets,
  listGroups,
  type CreateFleetOptions,
  type FleetInstallOptions,
} from "../ops/fleets.js";
import { emit, isJsonMode, printTable, terminalText, writeErr, writeOut } from "../output.js";

export const NO_FLEETS_MESSAGE = "No fleets.";
export const NO_GROUPS_MESSAGE = "No groups in this fleet.";

/** `telflo fleet list`: every page. */
export async function fleetList(client: ApiClient): Promise<void> {
  const fleets = await listFleets(client);
  emit(fleets, () => (fleets.length === 0 ? NO_FLEETS_MESSAGE : printTable(fleets, ["id", "label", "type", "status", "createdAt"])));
}

/**
 * `telflo fleet create`: the fleet's id and its rotate token's id (no bearer:
 * the reply holds none), then the next steps: a new fleet's Default group
 * serves nothing, so a deploy comes first (it goes to the Default group,
 * Ruling 248), then the install, which joins it.
 */
export async function fleetCreate(client: ApiClient, options: CreateFleetOptions): Promise<void> {
  const fleet = await createFleet(client, options);
  const platform = fleet.type === "kubernetes-supervisor" ? "kubernetes" : "docker";
  emit(fleet, () =>
    [
      `Created fleet "${fleet.label}" (${fleet.id}). Connection token id: ${fleet.tokenId}.`,
      "Next, deploy a published configuration to its Default group, then install a collector:",
      `  telflo deploy --fleet ${fleet.id} --config <configuration-id>`,
      `  telflo fleet install ${fleet.id} --platform ${platform}`,
    ]
      .map(terminalText)
      .join("\n"),
  );
}

/** `telflo fleet groups <fleet-id>`. */
export async function fleetGroups(client: ApiClient, fleetId: string): Promise<void> {
  const groups = await listGroups(client, fleetId);
  emit(groups, () =>
    groups.length === 0
      ? NO_GROUPS_MESSAGE
      : printTable(groups, ["id", "name", "isDefault", "configurationId", "versionNumber", "replicas", "namespace", "role"]),
  );
}

/** `telflo fleet install <fleet-id>`: the command once on stdout (a secret), the rest on stderr. */
export async function fleetInstall(client: ApiClient, fleetId: string, options: FleetInstallOptions): Promise<void> {
  const reply = await installFleet(client, fleetId, options);
  if (isJsonMode()) {
    emit(reply, () => "");
    return;
  }
  // The reply's words through terminalText (Ruling 237); the command byte-exact: it is what to run.
  writeErr(terminalText(`# ${reply.platform} install for ${reply.fleetType} fleet ${reply.fleetId}, group "${reply.groupName}" (${reply.groupId})`));
  if (reply.expiresAt !== null) writeErr(terminalText(`# The command's link works until ${reply.expiresAt}.`));
  for (const note of reply.notes) writeErr(`# ${terminalText(note)}`);
  writeErr("");
  writeOut(reply.command);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerFleetCommands(program: Command): void {
  const fleet = program.command("fleet").description("List, create and install into the organization's fleets");

  fleet
    .command("list")
    .description("List the organization's fleets")
    .action(() => fleetList(requireClient()));

  fleet
    .command("create")
    .description("Create a fleet (its connection token is revealed in the browser; fleet install answers a ready command)")
    .requiredOption("--label <label>", "the fleet's label (unique in the organization)")
    .addOption(new Option("--type <type>", "the fleet's type").choices(FLEET_TYPES).makeOptionMandatory())
    .addOption(new Option("--expires-in <lifetime>", "the connection token's lifetime (default never)").choices(FLEET_TOKEN_EXPIRIES))
    .action((options: CreateFleetOptions) => fleetCreate(requireClient(), options));

  fleet
    .command("groups")
    .description("List a fleet's collector groups")
    .argument("<fleet-id>", "the fleet's id (telflo fleet list)")
    .action((fleetId: string) => {
      requireId(fleetId, "fleet");
      return fleetGroups(requireClient(), fleetId);
    });

  fleet
    .command("install")
    .description(
      "Print the command that installs a collector into a fleet (docker or linux for a server fleet, kubernetes for a " +
        "kubernetes-supervisor fleet). The command holds the fleet's credentials: keep it secret.",
    )
    .argument("<fleet-id>", "the fleet's id (telflo fleet list)")
    .addOption(new Option("--platform <platform>", "where the collector runs").choices(INSTALL_PLATFORMS).makeOptionMandatory())
    .option("--group <id>", "the collector group it joins (default: a server fleet's Default group, a Kubernetes fleet's only group)")
    .option("--display-name <name>", "docker, linux: the name shown for this collector")
    .addOption(new Option("--arch <arch>", "linux: the host's architecture (default amd64)").choices(INSTALL_ARCHES))
    .option("--root-path <dir>", "linux: the install folder (default /etc/otelcol)")
    .option("--no-systemd", "linux: run the collector in the foreground instead of as a systemd service")
    .option("--env <NAME=value>", "a variable the configuration reads (repeatable)", collect, [] as string[])
    .action((fleetId: string, options: FleetInstallOptions) => {
      // The usage checks (a malformed id, a flag for another platform, a malformed --env) are exit 2 before the login is read.
      requireId(fleetId, "fleet");
      installRequestOf(options);
      return fleetInstall(requireClient(), fleetId, options);
    });
}
