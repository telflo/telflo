import { Readable } from "node:stream";
import {
  INVITATION_TTL_DAYS,
  ORGANIZATION_LOGO_MAXIMUM_BYTES,
  mayInviteFrom,
  type OrganizationCreation,
  type RegistrationMode,
} from "@telflo/contracts";
import type { OrganizationLogoContentType, OrganizationRole } from "@telflo/db";
import type { FastifyBaseLogger } from "fastify";
import type { ActorContext, AuthContext } from "../../database/context.js";
import type { AppError } from "../../errors.js";
import type { FileKey, IFileStore } from "../../file-store/file-store.js";
import type { IMailer } from "../../mail/mailer.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { assertAddressNotReserved } from "../identity/reserved-domain.js";
import { generateToken } from "../identity/tokens.js";
import { mayCreateOrganizations } from "../site-settings/organization-creation.js";
import { buildInvitationEmail } from "./emails.js";
import type { OpampRegistration } from "./opamp-registration.js";
import {
  cannotChangeOwnRole,
  cannotRemoveYourself,
  invitationAlreadyPending,
  invitationEmailFailed,
  memberAlreadyActive,
  memberIsServiceAccount,
  memberNotActiveForRemoval,
  memberNotActiveForRoleChange,
  memberNotFound,
  memberNotRemoved,
  memberRemovedFromOrganization,
  organizationAdminRequired,
  organizationCreationRestricted,
  organizationNameTaken,
  organizationNotFound,
  pendingInvitationNotFound,
  personalOrganizationInvitationsDisabled,
  personalOrganizationNotDeletable,
  personalOrganizationOwnerProtected,
  resentInvitationEmailFailed,
} from "./errors.js";
import {
  InvitationAlreadyPendingError,
  type IInvitationRepository,
  type Invitation,
} from "./repositories/invitation-repository.js";
import type { IMemberRepository, Member } from "./repositories/member-repository.js";
import {
  OrganizationNameTakenError,
  type IActiveOrganizationRepository,
  type IOrganizationRepository,
  type Organization,
  type OrganizationSettings,
} from "./repositories/organization-repository.js";

/** One organization's scoped repositories, bound to the transaction. */
export interface OrganizationRepositories {
  organization: IActiveOrganizationRepository;
  members: IMemberRepository;
  invitations: IInvitationRepository;
}

/**
 * The repositories a unit of work writes through, bound to one transaction
 * that carries the request's database context: whatever is written through
 * them commits together or not at all.
 *
 * `active` is the context's organization. `enterOrganization` points the
 * database context at another organization, keeping the caller as the user,
 * and hands out its repositories: row-level security admits a membership,
 * and shows an invitation, only in the context's organization. Two things
 * call it: creating an organization, for the one it has just made, and
 * accepting an invitation, for the one whose invitation the token found.
 * Nothing else changes the context.
 */
export interface OrganizationTransaction {
  organizations: Pick<IOrganizationRepository, "createGroup">;
  audit: IAuditRepository;
  active: OrganizationRepositories;
  enterOrganization(organizationId: string): Promise<OrganizationRepositories>;
}

/**
 * Runs `work` in one database transaction in `context`'s database context,
 * and resolves with its result once the transaction commits. If `work`
 * rejects, the transaction rolls back and the rejection propagates.
 */
export type WithOrganizationTransaction = <Result>(
  context: ActorContext,
  work: (transaction: OrganizationTransaction) => Promise<Result>,
) => Promise<Result>;

export interface OrganizationServiceDependencies {
  withTransaction: WithOrganizationTransaction;
  now: () => Date;
  mailer: IMailer;
  /** Where the invitation link points: `${publicWebUrl}/accept-invitation#token=…`. */
  publicWebUrl: string;
  /**
   * Counts one invitation email for the user, or throws 429 rate_limited
   * when they have none left.
   */
  consumeInvitationEmail: (userId: string) => void;
  /**
   * Where a failed invitation email's error goes (the 502 carries none of
   * it), and a logo's bytes that couldn't be removed (codes only).
   */
  log: Pick<FastifyBaseLogger, "error" | "warn">;
  /** Keeps the opamp-server's registry in step after each commit. */
  opampRegistration: OpampRegistration;
  /** Where logos' bytes live. */
  fileStore: IFileStore;
  /** A new id, picked before anything is written (`select uuidv7()`). */
  nextId: () => Promise<string>;
  /** The product admins' switch, read on each create: who may create an organization. */
  organizationCreation: () => Promise<OrganizationCreation>;
  /**
   * The site's registration mode (settings' `site.registration`, fixed per
   * process): a personal organization invites only while it is `open`.
   */
  registration: RegistrationMode;
}

/**
 * A logo the route has read whole and typed from its bytes, under the logo
 * id `prepareCreate` or `prepareChange` picked.
 */
export interface NewLogo {
  logoId: string;
  contentType: OrganizationLogoContentType;
  bytes: Buffer;
}

/** A create with a logo: the organization's id picked first, and the logo. */
export interface CreateWithLogo {
  organizationId: string;
  logo: NewLogo;
}

/**
 * Edit's Save: the name, and a new logo or the current one's removal, all
 * or nothing.
 */
export interface OrganizationChange {
  name: string;
  logo?: NewLogo | undefined;
  removeLogo?: boolean | undefined;
}

/** Who is acting, and from where, for the checks and the audit trail. */
export interface Actor {
  context: ActorContext;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * An actor signed in with a session: for the one path that needs the session
 * itself, accepting an invitation, which switches the session's active
 * organization to the one joined.
 */
export type SessionActor = Actor & { context: AuthContext };

/**
 * Who creates an organization: the actor, and whether they are a product
 * admin as this request's session check read the flag (the bootstrap's
 * account, which the bootstrap has just made one, alike).
 */
export type CreatingActor = Actor & { isProductAdmin: boolean };

export interface IOrganizationService {
  /**
   * The ids a create with a logo needs before its body is read: the
   * organization's and the logo's.
   */
  prepareCreate(actor: CreatingActor): Promise<{ organizationId: string; logoId: string }>;
  /**
   * Creates a group organization with the caller as its admin, with its
   * logo when given (all or nothing). It doesn't switch to it. Refused
   * while only product admins may create one and the caller isn't one.
   */
  create(actor: CreatingActor, name: string, withLogo?: CreateWithLogo): Promise<Organization>;
  /**
   * The checks a change with a logo makes before its body is read (the
   * active organization, the request's role), and the new logo's id.
   */
  prepareChange(actor: Actor, organizationId: string): Promise<{ logoId: string }>;
  /** Renames it and sets or removes its logo, all or nothing. */
  change(actor: Actor, organizationId: string, change: OrganizationChange): Promise<Organization>;
  delete(actor: Actor, organizationId: string): Promise<void>;
  /** The organization's settings. Any member. */
  findSettings(actor: Actor, organizationId: string): Promise<OrganizationSettings>;
  /**
   * Changes the settings (the "Public install links" switch). Admin only;
   * setting the value it already has changes and audits nothing.
   */
  changeSettings(actor: Actor, organizationId: string, settings: OrganizationSettings): Promise<OrganizationSettings>;
  /**
   * Every person with a live account who is a member, active or removed;
   * never a service account (Permissions doesn't show them). Admin only.
   */
  listMembers(actor: Actor, organizationId: string): Promise<Member[]>;
  /**
   * Setting the role a member already has changes and audits nothing. This
   * and the removal and the restoration refuse a service account with 409
   * member_is_service_account: it is managed in Settings › Service
   * Accounts.
   */
  changeMemberRole(actor: Actor, organizationId: string, userId: string, role: OrganizationRole): Promise<void>;
  /**
   * Removes a member softly and reassigns their sessions acting in the
   * organization. An admin's pending invitations are canceled with them.
   */
  removeMember(actor: Actor, organizationId: string, userId: string): Promise<void>;
  restoreMember(actor: Actor, organizationId: string, userId: string): Promise<void>;
  /** Invites an address, and emails it the link once the invitation has committed. */
  invite(actor: Actor, organizationId: string, input: InviteInput): Promise<PendingInvitation>;
  /** Pending invitations, expired ones included, newest first. Admin only. */
  listInvitations(actor: Actor, organizationId: string): Promise<PendingInvitation[]>;
  /** A new token and expiry for a pending invitation, expired or not, and the email again. */
  resendInvitation(actor: Actor, organizationId: string, invitationId: string): Promise<PendingInvitation>;
  cancelInvitation(actor: Actor, organizationId: string, invitationId: string): Promise<void>;
}

export interface InviteInput {
  email: string;
  role: OrganizationRole;
}

/** A pending invitation as an admin sees it, with whether it has expired by the service's clock. */
export interface PendingInvitation extends Invitation {
  isExpired: boolean;
}

const INVITATION_TTL_MILLISECONDS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Whether an invitation has expired at `at`, the injected clock's time,
 * never the database's: its last moment is `expires_at` itself.
 */
export function isInvitationExpired(invitation: Pick<Invitation, "expiresAt">, at: Date): boolean {
  return invitation.expiresAt.getTime() <= at.getTime();
}

/**
 * Management acts on the active organization only. Checked before
 * anything else, the role included, so a path naming any other
 * organization gets the same 404 whether or not the caller belongs to it.
 * The configuration endpoints check it first too.
 */
export function assertActiveOrganization(actor: Actor, organizationId: string): void {
  if (organizationId !== actor.context.organizationId) throw organizationNotFound();
}

/** What `lockAsAdmin` reads: the active organization's lock and its members' re-check. */
export interface LockingRepositories {
  organization: Pick<IActiveOrganizationRepository, "lockActive">;
  members: Pick<IMemberRepository, "find">;
}

/**
 * The request's copy of the role: a cheap first refusal. The lock's re-check
 * is the one that counts. Exported for the service accounts' routes,
 * admins' only, reads included.
 */
export function assertAdminRole(actor: Pick<Actor, "context">): void {
  if (actor.context.role !== "admin") throw organizationAdminRequired();
}

/**
 * The organization lock: the organization's row `for no key update`, taken
 * first by every change to it or its members, then the re-check that the
 * caller is still an active admin of a live organization. The request's
 * role was read before the lock, so a concurrent demotion that committed
 * while this request waited is seen here. Not `for update`: a foreign-key
 * check (a session reassigned into this organization by another change)
 * must not wait on it (see `lockActive`).
 *
 * Exported for the service accounts' and their tokens' writes: each takes
 * this lock first, so their counts are exact and a demoted admin is
 * refused under it. It needs only the organization's lock and the members'
 * `find`.
 */
export async function lockAsAdmin(
  transaction: { active: LockingRepositories },
  actor: Pick<Actor, "context">,
): Promise<Organization> {
  const organization = await transaction.active.organization.lockActive();
  if (!organization) throw organizationNotFound();
  const caller = await transaction.active.members.find(actor.context.userId);
  if (!caller || caller.deletedAt !== null || caller.role !== "admin") throw organizationAdminRequired();
  return organization;
}

/** A UUID in its canonical, hyphenated form, in either case. */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path's id (a member's, an invitation's, a configuration's), lowercased as Postgres prints a
 * uuid, or undefined when it isn't one: nothing has that id (404, not a 400
 * or a database error). Lowercased because the self and owner checks compare
 * a member's, as a string, with ids read from the database, while Postgres
 * matches an uppercased id to the same row: the caller's own, past the self
 * check. For the same reason every other spelling Postgres accepts (no
 * hyphens, braces) is refused as not found.
 */
export function canonicalIdOf(id: string): string | undefined {
  return CANONICAL_UUID.test(id) ? id.toLowerCase() : undefined;
}

/** Where an organization's logo's bytes live: one file per logo id. */
export function organizationLogoKey(organizationId: string, logoId: string): FileKey {
  return { kind: "organization-logo", organizationId, logoId };
}

/**
 * Removes a logo's bytes, logging (never throwing) a failure: with no row
 * pointing at them they are unreachable (an orphan, until a sweep removes
 * it; none is built yet). The log line holds codes and the organization's
 * id only. Exported for a person's delete, which removes the logos of the
 * organizations it deletes after its commit, as an organization's own
 * delete does.
 */
export async function removeLogoQuietly(
  deps: { fileStore: Pick<IFileStore, "remove">; log: Pick<FastifyBaseLogger, "warn"> },
  organizationId: string,
  logoId: string,
): Promise<void> {
  try {
    await deps.fileStore.remove(organizationLogoKey(organizationId, logoId));
  } catch (error) {
    const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
    deps.log.warn({ organizationId, code, syscall }, "an organization's logo's bytes could not be removed");
  }
}

export function createOrganizationService(deps: OrganizationServiceDependencies): IOrganizationService {
  const {
    withTransaction,
    now,
    mailer,
    publicWebUrl,
    consumeInvitationEmail,
    log,
    opampRegistration,
    fileStore,
    nextId,
    organizationCreation,
    registration,
  } = deps;

  /**
   * The product admins' switch: while it is on, only a product admin may
   * create an organization. Read before any id is picked or any logo byte
   * is written. A switch turned on while a create is past this check lets
   * that one create through: accepted, as the switch guards creations to
   * come, not one already under way.
   */
  async function assertMayCreate(actor: CreatingActor): Promise<void> {
    if (!mayCreateOrganizations(await organizationCreation(), actor.isProductAdmin)) throw organizationCreationRestricted();
  }

  /** Writes a logo's bytes, read whole and typed already, under `key`. */
  async function writeLogo(key: FileKey, bytes: Buffer): Promise<void> {
    await fileStore.write(key, Readable.from([bytes]), { maxBytes: ORGANIZATION_LOGO_MAXIMUM_BYTES });
  }

  /** removeLogoQuietly (above) with this service's file store and log. */
  function removeLogoBytes(organizationId: string, logoId: string): Promise<void> {
    return removeLogoQuietly({ fileStore, log }, organizationId, logoId);
  }

  /** An organization's logo audit row: ids only. */
  function logoAuditEvent(actor: Actor, organizationId: string, logoId: string | null): AuditEvent {
    return auditEvent(actor, organizationId, {
      action: logoId === null ? "organization.logo_removed" : "organization.logo_changed",
      subjectType: "organization",
      subjectId: organizationId,
      metadata: logoId === null ? {} : { logoId },
    });
  }

  /** An audit row for `actor`, in `organizationId`. */
  function auditEvent(
    actor: Actor,
    organizationId: string,
    event: Omit<AuditEvent, "actorUserId" | "actorEmail">,
  ): AuditEvent {
    return {
      actorUserId: actor.context.userId,
      actorEmail: actor.email,
      organizationId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      ...event,
    };
  }

  /**
   * The member a change names, read under the organization lock: every
   * change to a membership takes that lock first, so what is read here
   * holds until the commit. 404 when there is no membership or the account
   * is deleted. A service account's membership is never changed here: each
   * change checks `isServiceAccount` right after this, before anything is
   * written.
   */
  async function lockedMember(transaction: OrganizationTransaction, memberId: string | undefined): Promise<Member> {
    const member = memberId === undefined ? undefined : await transaction.active.members.find(memberId);
    if (!member) throw memberNotFound();
    return member;
  }

  /** An audit row about `member`, in the organization. */
  function memberAuditEvent(
    actor: Actor,
    organizationId: string,
    member: Member,
    action: string,
    metadata?: Record<string, unknown>,
  ): AuditEvent {
    return auditEvent(actor, organizationId, { action, subjectType: "user", subjectId: member.userId, metadata });
  }

  /** Runs a write that may clash on the group-name index, answering a clash with 409. */
  async function withNameClash<Result>(write: () => Promise<Result>): Promise<Result> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof OrganizationNameTakenError) throw organizationNameTaken();
      throw error;
    }
  }

  /** An audit row about `invitation`, in the organization. */
  function invitationAuditEvent(
    actor: Actor,
    invitation: Invitation,
    action: string,
    metadata?: Record<string, unknown>,
  ): AuditEvent {
    return auditEvent(actor, invitation.organizationId, {
      action,
      subjectType: "organization_invitation",
      subjectId: invitation.id,
      metadata,
    });
  }

  const pendingView = (invitation: Invitation, at: Date = now()): PendingInvitation => ({
    ...invitation,
    isExpired: isInvitationExpired(invitation, at),
  });

  /**
   * The invitation a resend or a cancel names, locked `for update` after the
   * organization, so a concurrent accept, resend or cancel of it waits for
   * this one's commit. 404 unless it is pending; expired is still pending.
   * The token's hash is dropped here: nothing after needs it.
   */
  async function lockedPendingInvitation(
    transaction: OrganizationTransaction,
    invitationId: string | undefined,
  ): Promise<Invitation> {
    const locked =
      invitationId === undefined ? undefined : await transaction.active.invitations.lockForUpdate(invitationId);
    if (!locked || locked.acceptedAt !== null || locked.revokedAt !== null) throw pendingInvitationNotFound();
    const { tokenHash: _currentHash, ...invitation } = locked;
    return invitation;
  }

  /**
   * An invitation is authority an admin delegated, and it doesn't outlive
   * their being an admin. Removing an admin, or demoting one, cancels every
   * pending invitation they sent, expired ones included, in the same
   * transaction. Called under the organization lock and before any other:
   * every other writer of these rows takes that lock first, so this waits on
   * nothing, and it keeps the lock order (organization, invitation, user,
   * session). Each invitation gets the `revoked` row a cancel writes (every
   * change to an invitation has its own row), naming the membership change
   * that caused it; the caller puts the count on that change's own row.
   */
  async function revokeInvitationsOf(
    transaction: OrganizationTransaction,
    actor: Actor,
    member: Member,
    via: "organization_member.removed" | "organization_member.role_changed",
    at: Date,
  ): Promise<number> {
    const revoked = await transaction.active.invitations.revokePendingInvitedBy(member.userId, at);
    for (const invitation of revoked) {
      await transaction.audit.record(invitationAuditEvent(actor, invitation, "organization_invitation.revoked", { via }));
    }
    return revoked.length;
  }

  /**
   * Emails the invitation's link, after its transaction has committed: an
   * email must never carry a token that rolled back. The token goes in the
   * link's fragment, which the browser never sends to a server. A failed send
   * is logged, audited in a transaction of its own (the invitation's has
   * committed), and answered with `failure`'s 502, which says what did
   * commit: the invitation stands, and Resend tries again.
   */
  async function sendInvitation(
    actor: Actor,
    organization: Pick<Organization, "name" | "type">,
    invitation: Invitation,
    token: string,
    failure: () => AppError,
  ): Promise<void> {
    try {
      await mailer.send({
        to: invitation.email,
        ...buildInvitationEmail({
          organizationName: organization.name,
          organizationType: organization.type,
          acceptUrl: `${publicWebUrl}/accept-invitation#token=${token}`,
        }),
      });
    } catch (error) {
      log.error({ err: error }, "an invitation email couldn't be sent");
      await withTransaction(actor.context, (transaction) =>
        transaction.audit.record(invitationAuditEvent(actor, invitation, "organization_invitation.email_failed")),
      );
      throw failure();
    }
  }

  /**
   * While the site's registration isn't open, a personal organization sends
   * no invitation (an invite or a resend). Checked under the organization's
   * lock, as its type is read there, so after the mail limit has counted the
   * request (refusals buy no extra tries) and before anything is written: no
   * row, no audit, no email.
   */
  function assertMayInviteFrom(organization: Organization): void {
    if (!mayInviteFrom(registration, organization.type)) throw personalOrganizationInvitationsDisabled();
  }

  /**
   * The checks every invitation endpoint makes before anything else, in this
   * order: the active organization (its 404 comes first), the request's role,
   * and then, for the two that send mail, the per-inviter mail limit. The
   * limit counts every request that gets this far, a refused one included, so
   * refusals buy no extra tries. An invite names its address: one at the
   * service accounts' domain is refused after the role and before the limit,
   * so it spends none of the budget, opens no transaction and no invitation to
   * the domain is ever written.
   */
  function assertMayManageInvitations(
    actor: Actor,
    organizationId: string,
    sendsEmail: boolean,
    invitedEmail?: string,
  ): void {
    assertActiveOrganization(actor, organizationId);
    assertAdminRole(actor);
    if (invitedEmail !== undefined) assertAddressNotReserved(invitedEmail);
    if (sendsEmail) consumeInvitationEmail(actor.context.userId);
  }

  return {
    async prepareCreate(actor: CreatingActor) {
      await assertMayCreate(actor);
      return { organizationId: await nextId(), logoId: await nextId() };
    },

    /**
     * One transaction: the organization, the context pointed at it, the
     * caller's admin membership, and both audit rows. Only a product admin
     * may create one while the product admins' switch is on, as a fresh
     * install has it; anyone signed in once it's off. Checked first, before
     * any logo byte is written.
     *
     * With a logo: its bytes are written first, under the ids
     * `prepareCreate` picked, then the one transaction (the organization
     * with its logo's columns, and `organization.logo_changed` after the
     * two rows above). If anything after the write fails (a name clash, the
     * transaction), the bytes are removed quietly and nothing is left. The
     * write itself counts: a store may leave a file behind a rejected
     * write.
     */
    async create(actor: CreatingActor, name: string, withLogo?: CreateWithLogo): Promise<Organization> {
      await assertMayCreate(actor);
      let organization: Organization;
      try {
        if (withLogo) {
          await writeLogo(organizationLogoKey(withLogo.organizationId, withLogo.logo.logoId), withLogo.logo.bytes);
        }
        organization = await withTransaction(actor.context, async (transaction) => {
          const organization = await withNameClash(() =>
            transaction.organizations.createGroup(
              name,
              withLogo
                ? {
                    id: withLogo.organizationId,
                    logo: { logoId: withLogo.logo.logoId, contentType: withLogo.logo.contentType },
                  }
                : {},
            ),
          );
          const created = await transaction.enterOrganization(organization.id);
          await created.members.add({ userId: actor.context.userId, role: "admin" });
          await transaction.audit.record(
            auditEvent(actor, organization.id, {
              action: "organization.created",
              subjectType: "organization",
              subjectId: organization.id,
              metadata: { type: organization.type, name: organization.name },
            }),
          );
          await transaction.audit.record(
            auditEvent(actor, organization.id, {
              action: "organization_member.added",
              subjectType: "user",
              subjectId: actor.context.userId,
              metadata: { role: "admin" },
            }),
          );
          if (withLogo) await transaction.audit.record(logoAuditEvent(actor, organization.id, withLogo.logo.logoId));
          return organization;
        });
      } catch (error) {
        if (withLogo) await removeLogoBytes(withLogo.organizationId, withLogo.logo.logoId);
        throw error;
      }
      // Committed: the opamp-server registers it after the response.
      opampRegistration.created(organization);
      return organization;
    },

    async prepareChange(actor: Actor, organizationId: string) {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      return { logoId: await nextId() };
    },

    /**
     * Edit's Save, all or nothing. A new logo's bytes are written under its
     * new id before the transaction; then, under the lock, the rename (if
     * the name differs), the logo's columns (the new logo, or none for
     * `removeLogo` when there is one), and their audit rows
     * (`organization.renamed` as before, then `organization.logo_changed` or
     * `organization.logo_removed`). The old logo's id is read from the
     * locked row, never before the lock: of two Saves at once, the second
     * removes the first's bytes, and the first the original's. After the
     * commit, the old bytes are removed quietly; any failure before it
     * removes the new bytes and changes nothing.
     *
     * The current name, exactly, with no new logo and nothing to remove
     * changes and audits nothing, and sends the opamp-server nothing.
     */
    async change(actor: Actor, organizationId: string, change: OrganizationChange): Promise<Organization> {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      const { logo } = change;
      let changed: { organization: Organization; isRenamed: boolean; replacedLogoId: string | null };
      try {
        if (logo) await writeLogo(organizationLogoKey(organizationId, logo.logoId), logo.bytes);
        changed = await withTransaction(actor.context, async (transaction) => {
          const current = await lockAsAdmin(transaction, actor);
          const isRenaming = current.name !== change.name;
          const isLogoChanging = logo !== undefined || (change.removeLogo === true && current.logoId !== null);
          if (!isRenaming && !isLogoChanging) return { organization: current, isRenamed: false, replacedLogoId: null };
          let organization = current;
          if (isRenaming) {
            const renamed = await withNameClash(() => transaction.active.organization.rename(change.name));
            // Live under the lock just taken, so this can't happen; answered as a delete would be.
            if (!renamed) throw organizationNotFound();
            organization = renamed;
          }
          if (isLogoChanging) {
            const updated = await transaction.active.organization.setLogo(
              logo ? { logoId: logo.logoId, contentType: logo.contentType } : null,
            );
            // Live under the lock, as above.
            if (!updated) throw organizationNotFound();
            organization = updated;
          }
          if (isRenaming) {
            await transaction.audit.record(
              auditEvent(actor, organizationId, {
                action: "organization.renamed",
                subjectType: "organization",
                subjectId: organizationId,
                metadata: { from: current.name, to: organization.name },
              }),
            );
          }
          if (isLogoChanging) await transaction.audit.record(logoAuditEvent(actor, organizationId, logo?.logoId ?? null));
          return { organization, isRenamed: isRenaming, replacedLogoId: isLogoChanging ? current.logoId : null };
        });
      } catch (error) {
        if (logo) await removeLogoBytes(organizationId, logo.logoId);
        throw error;
      }
      // Committed: the old logo's bytes are unreachable now, and removed.
      if (changed.replacedLogoId !== null) await removeLogoBytes(organizationId, changed.replacedLogoId);
      // The opamp-server renames it after the response.
      // A Save that kept the name has nothing to send.
      if (changed.isRenamed) opampRegistration.renamed(changed.organization);
      return changed.organization;
    },

    /**
     * Under the lock: the organization is marked deleted, every account whose
     * only live membership it held is soft-deleted, and every session acting
     * in it, the caller's own included, is reassigned to its user's fallback
     * organization. They stay signed in: each one's next request refreshes
     * into the organization its session now names.
     *
     * Its logo's id is read from the locked row; after the commit, the logo's
     * bytes are removed quietly. An organization with no logo never calls the
     * store.
     */
    async delete(actor: Actor, organizationId: string): Promise<void> {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      const logoId = await withTransaction(actor.context, async (transaction) => {
        const organization = await lockAsAdmin(transaction, actor);
        if (organization.type === "personal") throw personalOrganizationNotDeletable();
        // Every member's account, before any session: the invariant locks
        // them all at commit (see `lockAccounts`).
        await transaction.active.members.lockAccounts();
        const organizations = transaction.active.organization;
        if (!(await organizations.markDeleted(now()))) throw organizationNotFound();
        const deletedAccounts = await organizations.deleteAccountsOnlyInOrganization();
        const reassignedSessions = await organizations.reassignSessionsLeavingOrganization();
        await transaction.audit.record(
          auditEvent(actor, organizationId, {
            action: "organization.deleted",
            subjectType: "organization",
            subjectId: organizationId,
            metadata: { deletedAccounts, reassignedSessions },
          }),
        );
        return organization.logoId;
      });
      if (logoId !== null) await removeLogoBytes(organizationId, logoId);
      // Committed: the opamp-server deletes it, and its publications, after the response.
      opampRegistration.deleted(organizationId);
    },

    /**
     * Read-only, for any member (the install dialogs read it at their
     * opening). The active organization only, as every management read:
     * another's is 404.
     */
    async findSettings(actor: Actor, organizationId: string): Promise<OrganizationSettings> {
      assertActiveOrganization(actor, organizationId);
      const settings = await withTransaction(actor.context, (transaction) => transaction.active.organization.findSettings());
      if (!settings) throw organizationNotFound();
      return settings;
    },

    /**
     * Under the organization lock, as a rename: the caller still an admin,
     * then the switch. Its audit row, organization.settings_changed, holds
     * the new value only. The value it already has is a no-op.
     */
    async changeSettings(actor: Actor, organizationId: string, settings: OrganizationSettings): Promise<OrganizationSettings> {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsAdmin(transaction, actor);
        const current = await transaction.active.organization.findSettings();
        // Live under the lock just taken, so this can't happen; answered as a delete would be.
        if (!current) throw organizationNotFound();
        if (current.publicInstallLinks === settings.publicInstallLinks) return current;
        if (!(await transaction.active.organization.setPublicInstallLinks(settings.publicInstallLinks))) {
          throw organizationNotFound();
        }
        await transaction.audit.record(
          auditEvent(actor, organizationId, {
            action: "organization.settings_changed",
            subjectType: "organization",
            subjectId: organizationId,
            metadata: { publicInstallLinks: settings.publicInstallLinks },
          }),
        );
        return { publicInstallLinks: settings.publicInstallLinks };
      });
    },

    /** Read-only, so no lock: the request's role is the check. */
    async listMembers(actor: Actor, organizationId: string): Promise<Member[]> {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      return withTransaction(actor.context, (transaction) => transaction.active.members.list());
    },

    /**
     * Under the organization lock, in this order: the caller still an admin,
     * not their own membership, not the personal organization's owner, a
     * member who is active. Either role; the one the member already has is
     * a no-op. Demoting an admin cancels the invitations they sent, before
     * the membership's update, in the lock order.
     */
    async changeMemberRole(
      actor: Actor,
      organizationId: string,
      userId: string,
      role: OrganizationRole,
    ): Promise<void> {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      const memberId = canonicalIdOf(userId);
      await withTransaction(actor.context, async (transaction) => {
        const organization = await lockAsAdmin(transaction, actor);
        if (memberId === actor.context.userId) throw cannotChangeOwnRole();
        if (memberId !== undefined && memberId === organization.ownerUserId) {
          throw personalOrganizationOwnerProtected();
        }
        const member = await lockedMember(transaction, memberId);
        if (member.isServiceAccount) throw memberIsServiceAccount();
        if (member.deletedAt !== null) throw memberNotActiveForRoleChange();
        if (member.role === role) return;
        // An admin no longer: their invitations go with it.
        const revokedInvitations =
          member.role === "admin"
            ? await revokeInvitationsOf(transaction, actor, member, "organization_member.role_changed", now())
            : undefined;
        // Active, and in another role, under the lock just taken: this can't miss.
        if (!(await transaction.active.members.changeRole(member.userId, role))) throw memberNotFound();
        await transaction.audit.record(
          memberAuditEvent(actor, organizationId, member, "organization_member.role_changed", {
            from: member.role,
            to: role,
            ...(revokedInvitations === undefined ? {} : { revokedInvitations }),
          }),
        );
      });
    },

    /**
     * The checks of a role change, then the soft removal and, in the same
     * transaction, an admin's invitations canceled and the reassignment of
     * the member's sessions acting here. The member stays signed in: their
     * next request refreshes into the organization their session now names.
     *
     * The locks come in this order: the organization, an admin's pending
     * invitations, the member's account (`lockAccounts`: before the
     * sessions, as a password reset takes them), the membership (the
     * update), then the member's sessions (the reassignment). A switch to
     * the organization its session is already in takes no organization lock,
     * so it can't close a cycle.
     */
    async removeMember(actor: Actor, organizationId: string, userId: string): Promise<void> {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      const memberId = canonicalIdOf(userId);
      await withTransaction(actor.context, async (transaction) => {
        const organization = await lockAsAdmin(transaction, actor);
        if (memberId === actor.context.userId) throw cannotRemoveYourself();
        if (memberId !== undefined && memberId === organization.ownerUserId) {
          throw personalOrganizationOwnerProtected();
        }
        const member = await lockedMember(transaction, memberId);
        if (member.isServiceAccount) throw memberIsServiceAccount();
        if (member.deletedAt !== null) throw memberNotActiveForRemoval();
        const at = now();
        // An admin's invitations go with them, before the account's lock.
        const revokedInvitations =
          member.role === "admin"
            ? await revokeInvitationsOf(transaction, actor, member, "organization_member.removed", at)
            : undefined;
        await transaction.active.members.lockAccounts(member.userId);
        // Active under the lock just taken: this can't miss.
        if (!(await transaction.active.members.remove(member.userId, at))) throw memberNotFound();
        const reassignedSessions = await transaction.active.organization.reassignSessionsLeavingOrganization(
          member.userId,
        );
        await transaction.audit.record(
          memberAuditEvent(actor, organizationId, member, "organization_member.removed", {
            reassignedSessions,
            ...(revokedInvitations === undefined ? {} : { revokedInvitations }),
          }),
        );
      });
    },

    /**
     * Restores a removed member, in the role they had. The caller is an
     * active admin under the lock, so naming themselves is restoring an
     * active member: 409 member_not_removed. No session moves: the member
     * switches back in when they choose.
     *
     * The member's account is locked `for no key update` after the
     * organization and must still be live: a product admin's delete of the
     * person that committed while this waited would otherwise restore a
     * live membership of a deleted account (the commit-time invariant
     * passes a deleted user). The order is organization -> user, as the
     * delete's (organizations -> person) and the acceptance's
     * (organization -> invitation -> user, invitations-service.ts); the
     * delete never locks this group, which the person was removed from, so
     * it never waits on this while holding the person. The mode is the
     * commit-time trigger's own, so it needs no upgrade at commit. A
     * deleted account is 404 member_not_found, as the find answers once
     * the delete has committed.
     */
    async restoreMember(actor: Actor, organizationId: string, userId: string): Promise<void> {
      assertActiveOrganization(actor, organizationId);
      assertAdminRole(actor);
      const memberId = canonicalIdOf(userId);
      await withTransaction(actor.context, async (transaction) => {
        await lockAsAdmin(transaction, actor);
        const member = await lockedMember(transaction, memberId);
        if (member.isServiceAccount) throw memberIsServiceAccount();
        if (member.deletedAt === null) throw memberNotRemoved();
        if (!(await transaction.active.members.lockRestoredAccount(member.userId))) throw memberNotFound();
        // Removed under the lock just taken: this can't miss.
        if (!(await transaction.active.members.restore(member.userId))) throw memberNotFound();
        await transaction.audit.record(memberAuditEvent(actor, organizationId, member, "organization_member.restored"));
      });
    },

    /**
     * Under the organization lock, in this order: the caller still an admin,
     * the address not a member's (active: already a member, the caller's own
     * included; removed: restore them instead), and no pending invitation to
     * it, expired or not. Then the row, with a fresh token, and its audit
     * row. Only membership of this organization is checked, which an admin
     * can already see: nothing here says whether the address has an account.
     *
     * Two invites of one address wait on the same lock, so the second sees
     * the first's invitation. The partial unique index backs that up: a
     * clash on it is the same 409.
     */
    async invite(actor: Actor, organizationId: string, input: InviteInput): Promise<PendingInvitation> {
      assertMayManageInvitations(actor, organizationId, true, input.email);
      // Lowercased by the contract already; again here, since the member
      // check compares it with stored, lowercased addresses.
      const email = input.email.toLowerCase();
      const { token, tokenHash } = generateToken();
      const { organization, invitation } = await withTransaction(actor.context, async (transaction) => {
        const organization = await lockAsAdmin(transaction, actor);
        assertMayInviteFrom(organization);
        const member = await transaction.active.members.findByEmail(email);
        if (member) throw member.deletedAt === null ? memberAlreadyActive() : memberRemovedFromOrganization(email);
        const { invitations } = transaction.active;
        if (await invitations.findPendingByEmail(email)) throw invitationAlreadyPending();
        let invitation: Invitation;
        try {
          invitation = await invitations.create({
            email,
            role: input.role,
            tokenHash,
            invitedByUserId: actor.context.userId,
            expiresAt: new Date(now().getTime() + INVITATION_TTL_MILLISECONDS),
          });
        } catch (error) {
          if (error instanceof InvitationAlreadyPendingError) throw invitationAlreadyPending();
          throw error;
        }
        await transaction.audit.record(
          invitationAuditEvent(actor, invitation, "organization_invitation.created", {
            email: invitation.email,
            role: invitation.role,
          }),
        );
        return { organization, invitation };
      });
      await sendInvitation(actor, organization, invitation, token, invitationEmailFailed);
      return pendingView(invitation);
    },

    /** Read-only, so no lock: the request's role is the check. */
    async listInvitations(actor: Actor, organizationId: string): Promise<PendingInvitation[]> {
      assertMayManageInvitations(actor, organizationId, false);
      const invitations = await withTransaction(actor.context, (transaction) =>
        transaction.active.invitations.listPending(),
      );
      const at = now();
      return invitations.map((invitation) => pendingView(invitation, at));
    },

    /**
     * Under the organization lock, then the invitation's: a new token and a
     * new expiry on the same row, so the old link stops working and an
     * expired invitation is revived. Anything but a pending invitation is
     * 404. The email goes after the commit, as an invite's.
     */
    async resendInvitation(actor: Actor, organizationId: string, invitationId: string): Promise<PendingInvitation> {
      assertMayManageInvitations(actor, organizationId, true);
      const id = canonicalIdOf(invitationId);
      const { token, tokenHash } = generateToken();
      const { organization, invitation } = await withTransaction(actor.context, async (transaction) => {
        const organization = await lockAsAdmin(transaction, actor);
        assertMayInviteFrom(organization);
        const pending = await lockedPendingInvitation(transaction, id);
        const sentAt = now();
        const expiresAt = new Date(sentAt.getTime() + INVITATION_TTL_MILLISECONDS);
        // Pending under the lock just taken: this can't miss.
        if (!(await transaction.active.invitations.reissue(pending.id, tokenHash, expiresAt, sentAt))) {
          throw pendingInvitationNotFound();
        }
        await transaction.audit.record(invitationAuditEvent(actor, pending, "organization_invitation.resent"));
        return { organization, invitation: { ...pending, expiresAt } };
      });
      await sendInvitation(actor, organization, invitation, token, resentInvitationEmailFailed);
      return pendingView(invitation);
    },

    /** Under both locks, as a resend. The row stays, revoked, for the audit trail. */
    async cancelInvitation(actor: Actor, organizationId: string, invitationId: string): Promise<void> {
      assertMayManageInvitations(actor, organizationId, false);
      const id = canonicalIdOf(invitationId);
      await withTransaction(actor.context, async (transaction) => {
        await lockAsAdmin(transaction, actor);
        const pending = await lockedPendingInvitation(transaction, id);
        // Pending under the lock just taken: this can't miss.
        if (!(await transaction.active.invitations.revoke(pending.id, now()))) throw pendingInvitationNotFound();
        await transaction.audit.record(invitationAuditEvent(actor, pending, "organization_invitation.revoked"));
      });
    },
  };
}
