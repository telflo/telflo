/*
 * `telflo deploy` (D27 decision 28; Preflight ruling 22) on the platform's
 * collector groups (D25 routes 20, 21 and 23): the configuration's version
 * (the given one, else its highest published) goes to the one group of the
 * fleet serving the configuration (updated), or to a new group (`--name`).
 * A new fleet's first deploy (Ruling 248): no group serves it, no `--group`
 * or `--name`, and the fleet's Default group serves nothing, so the version
 * goes to the Default group (an update), which `fleet install` then joins.
 * Several groups serving it is exit 2 listing their ids: a group's name is
 * configuration text, never in an error. Every id goes through
 * `canonicalIdOf` before it's compared or sent. Data only: the command
 * prints.
 */

import type {
  KubernetesRole,
  PublicCollectorGroup,
  PublicConfigurationDetail,
  PublicCreateCollectorGroupRequest,
  PublicUpdateCollectorGroupRequest,
} from "@telflo/contracts";
import { segment, type ApiClient } from "../api.js";
import { canonicalIdOf, requireId } from "../ids.js";
import { EXIT, ExitError } from "../output.js";
import { listGroups } from "./fleets.js";

/** A Kubernetes group's roles (the contracts' `KUBERNETES_ROLES`). */
export const KUBERNETES_ROLES = ["node", "cluster", "gateway"] as const;

export const NOT_PUBLISHED_MESSAGE = (configurationId: string): string =>
  `This configuration has no published version: run telflo config publish ${configurationId} --version <n> first, or pass --version.`;
export const SEVERAL_SERVING_MESSAGE = (groupIds: readonly string[]): string =>
  ["Several groups serve this configuration: pass --group <id>, one of:", ...groupIds.map((id) => `  ${id}`)].join("\n");
export const NAME_NEEDED_MESSAGE = (fleetId: string): string =>
  "No group in that fleet serves this configuration yet: pass --group <id> to deploy to one of its groups " +
  `(telflo fleet groups ${fleetId} lists them), or --name to create one.`;
/**
 * `--role node` on a create: a Kubernetes group's role is its name's
 * (`cluster`, else a gateway pool) and the node role (the Agent) is the
 * Default group's; a server fleet's groups take no role. Words for both.
 */
export const NODE_ROLE_ON_CREATE_MESSAGE = (fleetId: string): string =>
  "A new group can't take --role node: on a Kubernetes fleet only the Default group has the node role, and a " +
  `server fleet's groups take no role. To deploy to the Default group, pass --group <id> (telflo fleet groups ${fleetId} lists them).`;

export interface DeployOptions {
  fleet: string;
  config: string;
  version?: number | undefined;
  group?: string | undefined;
  name?: string | undefined;
  replicas?: number | undefined;
  namespace?: string | undefined;
  role?: KubernetesRole | undefined;
}

/** The fields `resolveDeployTarget` reads of a group. */
export type GroupRef = Pick<PublicCollectorGroup, "id" | "configurationId" | "isDefault" | "assignedPublishedVersionId">;

/** The fleet's Default group, assigned no version (nothing published to it, nothing it could be serving). */
function servesNothingAsDefault(group: GroupRef): boolean {
  return group.isDefault === true && group.assignedPublishedVersionId === null && group.configurationId === null;
}

export type DeployTarget = { kind: "update"; id: string } | { kind: "create" } | { kind: "ambiguous"; candidates: string[] };

/** What a deploy asks for a new group: `--name`, and `--role` (a role but `node` means a new group: Ruling 254). */
export interface NewGroupIntent {
  name?: string | undefined;
  role?: KubernetesRole | undefined;
}

/**
 * Which group a deploy goes to: the one named; else the one group whose
 * configuration is this one (ids compared canonically); several are
 * ambiguous. When none serves it: a create when the deploy asks for a new
 * group (`--name`, or a `--role` but `node`); otherwise the fleet's
 * Default group when it serves no version (a new fleet's first deploy,
 * Ruling 248), else a create (which asks for `--name`).
 */
export function resolveDeployTarget(
  groups: readonly GroupRef[],
  configurationId: string,
  explicitGroupId?: string,
  newGroup: NewGroupIntent = {},
): DeployTarget {
  if (explicitGroupId !== undefined) return { kind: "update", id: canonicalIdOf(explicitGroupId) ?? explicitGroupId };
  const wanted = canonicalIdOf(configurationId);
  const matches = groups.filter((group) => group.configurationId !== null && wanted !== undefined && canonicalIdOf(group.configurationId) === wanted);
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return { kind: "update", id: canonicalIdOf(only.id) ?? only.id };
  if (matches.length === 0) {
    const wantsNewGroup = newGroup.name !== undefined || (newGroup.role !== undefined && newGroup.role !== "node");
    const unassignedDefault = wantsNewGroup ? undefined : groups.find(servesNothingAsDefault);
    const defaultId = unassignedDefault === undefined ? undefined : canonicalIdOf(unassignedDefault.id);
    return defaultId === undefined ? { kind: "create" } : { kind: "update", id: defaultId };
  }
  // The ids are printed: the canonical ones only (a reply's text never reaches the terminal unchecked).
  return { kind: "ambiguous", candidates: matches.flatMap((group) => canonicalIdOf(group.id) ?? []) };
}

export type DeployResult = PublicCollectorGroup & { action: "updated" | "created" };

/** Deploys the configuration's version to the fleet: the target group updated, or a group created. */
export async function deployConfiguration(client: ApiClient, options: DeployOptions): Promise<DeployResult> {
  const fleetId = requireId(options.fleet, "fleet");
  const configurationId = requireId(options.config, "configuration");
  const explicitGroupId = options.group === undefined ? undefined : requireId(options.group, "group");

  let versionNumber = options.version;
  if (versionNumber === undefined) {
    const configuration = await client.request<PublicConfigurationDetail>("GET", `/configurations/${segment(configurationId)}`);
    if (configuration.publishedVersionNumber === null) throw new ExitError(NOT_PUBLISHED_MESSAGE(configurationId), EXIT.FAILED);
    versionNumber = configuration.publishedVersionNumber;
  }

  // A group named needs no list: the PATCH answers 404 for one the fleet doesn't hold.
  const groups = explicitGroupId === undefined ? await listGroups(client, fleetId) : [];
  const target = resolveDeployTarget(groups, configurationId, explicitGroupId, { name: options.name, role: options.role });
  if (target.kind === "ambiguous") throw new ExitError(SEVERAL_SERVING_MESSAGE(target.candidates), EXIT.USAGE, "collector_group_ambiguous");

  const settings = {
    ...(options.replicas === undefined ? {} : { replicas: options.replicas }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
  };
  if (target.kind === "update") {
    const body: PublicUpdateCollectorGroupRequest = { configurationId, versionNumber, ...settings };
    const updated = await client.request<PublicCollectorGroup>("PATCH", `/fleets/${segment(fleetId)}/groups/${segment(target.id)}`, { body });
    return { action: "updated", ...updated };
  }

  if (options.name === undefined || options.name === "") throw new ExitError(NAME_NEEDED_MESSAGE(fleetId), EXIT.USAGE);
  // The API always refuses it (400 at `role`): said here, in words that name the way that works.
  if (options.role === "node") throw new ExitError(NODE_ROLE_ON_CREATE_MESSAGE(fleetId), EXIT.USAGE);
  const body: PublicCreateCollectorGroupRequest = {
    name: options.name,
    configurationId,
    versionNumber,
    ...settings,
    ...(options.role === undefined ? {} : { role: options.role }),
  };
  const created = await client.request<PublicCollectorGroup>("POST", `/fleets/${segment(fleetId)}/groups`, { body });
  return { action: "created", ...created };
}
