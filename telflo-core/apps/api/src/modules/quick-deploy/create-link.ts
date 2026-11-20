import type { QuickDeployHelmChoicesColumn, QuickDeployLinuxChoicesColumn } from "@telflo/db";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import { QUICK_DEPLOY_LINK_CREATED, QUICK_DEPLOY_LINK_SUBJECT } from "./actions.js";
import type { Actor } from "../organizations/service.js";
import type { IActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import type { IQuickDeployLinkRepository, QuickDeployLink } from "./repositories/quick-deploy-link-repository.js";
import { sealValues, type EnvValue, type QuickDeployKeyRing } from "./sealed-values.js";

/*
 * A link's create, its database part, in the caller's one transaction, which
 * carries the actor's database context: the organization still live and its
 * "Public install links" switch on (one read, locked `for share`, so its
 * delete and an admin's change of the switch wait), the link's id picked, the
 * typed values sealed for that id, the insert within the fleet's cap (under
 * its advisory lock), and the `quick_deploy_link.created` audit row with the
 * member. A refusal writes nothing. The fleet routes' service runs it after
 * the opamp-server's checks (the facts, the default token).
 */

/** The repositories the create's transaction uses. */
export interface QuickDeployCreateTransaction {
  organization: Pick<IActiveOrganizationRepository, "findSettingsForShare">;
  quickDeployLinks: Pick<IQuickDeployLinkRepository, "nextId" | "createWithinCap">;
  audit: IAuditRepository;
}

export interface QuickDeployLinkToCreate {
  fleetId: string;
  groupId: string;
  /** The fleet's default token, valid at the create: the command carries its bearer. */
  defaultTokenId: string;
  /** sha-256 (hex) of the secret (secret.ts). */
  secretHash: string;
  /**
   * What the link installs, by kind, without its variables' names (they
   * come from `values`): a Linux link's request's validated fields, or a
   * Helm values link's role, release and namespace from the server's state.
   */
  choices: Omit<QuickDeployLinuxChoicesColumn, "envNames"> | Omit<QuickDeployHelmChoicesColumn, "envNames">;
  /** The values typed for the variables, in the request's order; none, and nothing is sealed. */
  values: readonly EnvValue[];
  createdAt: Date;
  expiresAt: Date;
}

export type CreateQuickDeployLinkResult =
  | { kind: "created"; link: QuickDeployLink }
  /** The fleet already holds the most active links (`quick_deploy_link_limit_reached`). */
  | { kind: "limit_reached" }
  /** The organization was deleted meanwhile. */
  | { kind: "organization_gone" }
  /** The organization's "Public install links" switch is off (`public_install_links_disabled`). */
  | { kind: "links_disabled" };

export { QUICK_DEPLOY_LINK_CREATED } from "./actions.js";

export async function createQuickDeployLink(
  transaction: QuickDeployCreateTransaction,
  actor: Actor,
  keyRing: QuickDeployKeyRing,
  link: QuickDeployLinkToCreate,
): Promise<CreateQuickDeployLinkResult> {
  const settings = await transaction.organization.findSettingsForShare();
  if (settings === undefined) return { kind: "organization_gone" };
  if (!settings.publicInstallLinks) return { kind: "links_disabled" };
  const id = await transaction.quickDeployLinks.nextId();
  const sealed =
    link.values.length === 0 ? null : sealValues(keyRing, link.values, { organizationId: actor.context.organizationId, linkId: id });
  const result = await transaction.quickDeployLinks.createWithinCap(
    {
      id,
      fleetId: link.fleetId,
      groupId: link.groupId,
      defaultTokenId: link.defaultTokenId,
      createdByUserId: actor.context.userId,
      secretHash: link.secretHash,
      choices: { ...link.choices, envNames: link.values.map(({ name }) => name) },
      sealed,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
    },
    link.createdAt,
  );
  if (result.kind === "limit_reached") return result;
  // Ids, and a Linux link's method, arch and systemd choice or a Helm link's kind: never a path, a release, a
  // namespace, a variable's name or value, or the secret.
  const choices = link.choices;
  const described =
    choices.kind === "helm" ? { kind: "helm" } : { method: choices.method, arch: choices.arch, systemd: choices.systemd };
  await transaction.audit.record({
    action: QUICK_DEPLOY_LINK_CREATED,
    actorUserId: actor.context.userId,
    actorEmail: actor.email,
    organizationId: actor.context.organizationId,
    subjectType: QUICK_DEPLOY_LINK_SUBJECT,
    subjectId: id,
    metadata: {
      linkId: id,
      fleetId: link.fleetId,
      groupId: link.groupId,
      ...described,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return result;
}
