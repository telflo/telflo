/*
 * The fleet calls (routes 17-20 and 19's install), on the platform's names
 * where the older CLI's differ: a deployment is a collector group,
 * `server-supervisor` is `server`, install's `server_name` is
 * `displayName`, `root_deploy_path` is `rootPath`, its `env` a list of
 * `{ name, value }`. Data only: `commands/fleet.ts` prints.
 *
 * - A linux install always sends `arch` (default amd64), `rootPath`
 *   (default the web's `DEFAULT_INSTALL_ROOT_PATH`) and `systemd` (default
 *   true): the public route needs all three.
 * - Install's reply is a SECRET (its `command` holds the fleet's bearer, or
 *   a link's secret): nothing here prints it, logs it or puts it in an
 *   error. A refusal is the API's fixed words, or the CLI's for
 *   `collector_group_required` (the group ids only).
 * - Env values are configuration text: never in an error (a malformed
 *   `--env` is named by its position, not echoed).
 *
 * The choices below copy the contracts' (no runtime import from a
 * workspace); `fleets.test.ts` checks each against them.
 */

import type {
  PublicCollectorGroup,
  PublicCollectorGroups,
  PublicCreateFleetRequest,
  PublicFleet,
  PublicFleetCreated,
  PublicInstallReply,
  PublicInstallRequestInput,
} from "@telflo/contracts";
import { ApiError, segment, type ApiClient } from "../api.js";
import { canonicalIdOf, requireId } from "../ids.js";
import { endingOf, EXIT, ExitError } from "../output.js";

/** A fleet's types (the contracts' `FLEET_TYPES`). */
export const FLEET_TYPES = ["server", "kubernetes-supervisor"] as const;
/** A new fleet's rotate token's lifetimes (the contracts' `PUBLIC_FLEET_TOKEN_EXPIRIES`). */
export const FLEET_TOKEN_EXPIRIES = ["180d", "1y", "2y", "never"] as const;
/** Install's platforms (the contracts' `PUBLIC_INSTALL_PLATFORMS`). */
export const INSTALL_PLATFORMS = ["docker", "linux", "kubernetes"] as const;
/** A linux install's arches (the contracts' `INSTALL_ARCHES`), the first the default. */
export const INSTALL_ARCHES = ["amd64", "arm64"] as const;
/** A linux install's root path when none is given: the web's dialog's (the contracts' `DEFAULT_INSTALL_ROOT_PATH`). */
export const DEFAULT_INSTALL_ROOT_PATH = "/etc/otelcol";

export type FleetType = (typeof FLEET_TYPES)[number];
export type FleetTokenExpiry = (typeof FLEET_TOKEN_EXPIRIES)[number];
export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number];
export type InstallArch = (typeof INSTALL_ARCHES)[number];

export const ENV_FLAG_MESSAGE = (position: number): string => `--env expects NAME=value (the --env at position ${position} has no name or no =).`;
export const LINUX_ONLY_MESSAGE = "--arch, --root-path and --no-systemd are for --platform linux.";
export const DISPLAY_NAME_PLATFORM_MESSAGE = "--display-name is for --platform docker or linux.";
/** A Kubernetes fleet with no group. */
export const NO_GROUP_MESSAGE = "This fleet has no group yet: run telflo deploy first.";
export const SEVERAL_GROUPS_MESSAGE = (groupIds: readonly string[]): string =>
  ["This fleet has several groups: pass --group <id>, one of:", ...groupIds.map((id) => `  ${id}`)].join("\n");

export interface CreateFleetOptions {
  label: string;
  type: FleetType;
  expiresIn?: FleetTokenExpiry | undefined;
}

export interface FleetInstallOptions {
  platform: InstallPlatform;
  group?: string | undefined;
  displayName?: string | undefined;
  arch?: InstallArch | undefined;
  rootPath?: string | undefined;
  /** commander's `--no-systemd`: true unless it was given. */
  systemd?: boolean | undefined;
  /** Each `--env NAME=value`, in the order given. */
  env?: readonly string[] | undefined;
}

/** `--env NAME=value` flags as install's list (the value may hold `=`); a flag with no name or no `=` is exit 2, never echoed. */
export function parseEnvFlags(flags: readonly string[] | undefined): Array<{ name: string; value: string }> {
  return (flags ?? []).map((flag, index) => {
    const equals = flag.indexOf("=");
    if (equals <= 0) throw new ExitError(ENV_FLAG_MESSAGE(index + 1), EXIT.USAGE);
    return { name: flag.slice(0, equals), value: flag.slice(equals + 1) };
  });
}

/** Every fleet of the organization, newest first (route 18, paged). */
export function listFleets(client: ApiClient): Promise<PublicFleet[]> {
  return client.listAll<PublicFleet>("/fleets");
}

/** A new fleet (route 17): its id and rotate token's id, never a bearer. */
export function createFleet(client: ApiClient, options: CreateFleetOptions): Promise<PublicFleetCreated> {
  const body: PublicCreateFleetRequest = {
    label: options.label,
    type: options.type,
    ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }),
  };
  return client.request<PublicFleetCreated>("POST", "/fleets", { body });
}

/** A fleet's groups, the Default group first (route 20, one page). The id is canonicalized first (exit 2 if malformed). */
export async function listGroups(client: ApiClient, fleetId: string): Promise<PublicCollectorGroup[]> {
  const id = requireId(fleetId, "fleet");
  const reply = await client.request<PublicCollectorGroups>("GET", `/fleets/${segment(id)}/groups`);
  return reply.items;
}

/** Install's body (route 19) from the options: linux's three fields always, the other platforms' none of them. */
export function installRequestOf(options: FleetInstallOptions): PublicInstallRequestInput {
  const linuxFlagGiven = options.arch !== undefined || options.rootPath !== undefined || options.systemd === false;
  if (options.platform !== "linux" && linuxFlagGiven) throw new ExitError(LINUX_ONLY_MESSAGE, EXIT.USAGE);
  if (options.platform === "kubernetes" && options.displayName !== undefined) throw new ExitError(DISPLAY_NAME_PLATFORM_MESSAGE, EXIT.USAGE);
  const env = parseEnvFlags(options.env);
  const shared = {
    ...(options.group === undefined ? {} : { groupId: requireId(options.group, "group") }),
    ...(env.length === 0 ? {} : { env }),
  };
  const displayName = options.displayName === undefined ? {} : { displayName: options.displayName };
  switch (options.platform) {
    case "docker":
      return { platform: "docker", ...shared, ...displayName };
    case "linux":
      return {
        platform: "linux",
        ...shared,
        ...displayName,
        arch: options.arch ?? INSTALL_ARCHES[0],
        rootPath: options.rootPath ?? DEFAULT_INSTALL_ROOT_PATH,
        systemd: options.systemd !== false,
      };
    case "kubernetes":
      return { platform: "kubernetes", ...shared };
  }
}

/** `collector_group_required`'s ids, the canonical ones only (they're printed). */
function groupIdsOf(details: unknown): string[] {
  const groupIds = (details as { groupIds?: unknown } | null | undefined)?.groupIds;
  if (!Array.isArray(groupIds)) return [];
  return groupIds.flatMap((id) => {
    const canonical = typeof id === "string" ? canonicalIdOf(id) : undefined;
    return canonical === undefined ? [] : [canonical];
  });
}

/**
 * The command that installs a collector into a fleet (route 19). A SECRET:
 * the caller prints it once, to stdout, and nowhere else. The fleet's id
 * is canonicalized first; `collector_group_required` becomes the CLI's
 * words: none (run telflo deploy) or the group ids to choose from.
 */
export async function installFleet(client: ApiClient, fleetId: string, options: FleetInstallOptions): Promise<PublicInstallReply> {
  const id = requireId(fleetId, "fleet");
  const body = installRequestOf(options);
  try {
    return await client.request<PublicInstallReply>("POST", `/fleets/${segment(id)}/install`, { body });
  } catch (error) {
    if (error instanceof ApiError && error.code === "collector_group_required") {
      // The words reworded only: the exit code, code and status are the refusal's own ending (an ApiError's ending holds its status).
      const groupIds = groupIdsOf(error.details);
      const ending = endingOf(error);
      throw new ExitError(groupIds.length === 0 ? NO_GROUP_MESSAGE : SEVERAL_GROUPS_MESSAGE(groupIds), ending.exitCode, ending.code, error.status);
    }
    throw error;
  }
}
