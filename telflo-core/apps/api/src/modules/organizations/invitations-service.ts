import type { InvitationStatus, OrganizationType, RegistrationMode, SessionErrorCode } from "@telflo/contracts";
import type { OrganizationRole } from "@telflo/db";
import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../../errors.js";
import type { AuditEvent } from "../identity/repositories/audit-repository.js";
import { DuplicateEmailError, type Account, type IUserRepository } from "../identity/repositories/user-repository.js";
import { hashPassword } from "../identity/password.js";
import {
  allowsInvitationRegistration,
  personalInvitationRegistrationRefused,
  registrationNotOpen,
} from "../identity/registration.js";
import { assertAddressNotReserved } from "../identity/reserved-domain.js";
import { assertCurrentTermsVersion, siteAsksForTerms } from "../identity/terms.js";
import { hashToken } from "../identity/tokens.js";
import type { SessionOrganization } from "../sessions/repositories/session-repository.js";
import type { ISessionService, IssuedSession, RequestOrigin } from "../sessions/service.js";
import {
  accountExists,
  invitationAlreadyAccepted,
  invitationEmailMismatch,
  invitationExpired,
  invitationNotFound,
  removedMemberCannotAccept,
} from "./errors.js";
import type { Invitation, InvitationByToken } from "./repositories/invitation-repository.js";
import type { OpampRegistration } from "./opamp-registration.js";
import type { Organization } from "./repositories/organization-repository.js";
import {
  isInvitationExpired,
  type OrganizationRepositories,
  type SessionActor,
  type WithOrganizationTransaction,
} from "./service.js";

/*
 * The invitee's side of an invitation (D6 decision 9): previewing it,
 * accepting it while signed in, and creating an account from it. The token
 * is the credential. It finds its invitation through the one definer
 * function that reads past row-level security; from there the database
 * context names the invitation's organization, and everything goes through
 * the scoped repositories and the policy.
 *
 * Nothing here logs, audits or returns the token or its hash.
 */

export interface InviteeServiceDependencies {
  /** The invitation whose token hashes to this, in any state, read past row-level security (decision 9). */
  findInvitationByTokenHash: (tokenHash: string) => Promise<InvitationByToken | undefined>;
  /** Acceptance's transaction, in the caller's database context, as the management endpoints' is. */
  withTransaction: WithOrganizationTransaction;
  users: Pick<IUserRepository, "findByEmailIncludingDeleted" | "createAccount">;
  /** Acceptance ends in D5's switch, and registration in a session start: no session logic of its own. */
  sessions: Pick<ISessionService, "switchOrganization" | "startSession">;
  /** Every expiry comparison reads this clock, never the database's (a Preflight minor). */
  now: () => Date;
  /** Where a join whose session couldn't follow it is reported (Preflight ruling 5). */
  log: Pick<FastifyBaseLogger, "warn">;
  /** Registers a new account's personal organization in the opamp-server after the commit (D11a decision 20). */
  opampRegistration: OpampRegistration;
  /**
   * The site's Terms version (settings' `site.terms.version`, D36-1 decision
   * 29), which a registration must accept; "" when the site asks for none
   * (decision 32), and a registration records none.
   */
  termsVersion: string;
  /**
   * The site's registration mode (settings' `site.registration`, D36-1
   * decision 35): under `invite-only`, a personal organization's invitation
   * can't make an account (decision 52). `closed` is refused by the route's
   * gate before this service runs.
   */
  registration: RegistrationMode;
}

/** What the accept page shows. A revoked or superseded invitation has no preview: it is a 404. */
export interface InvitationPreview {
  organizationName: string;
  /** Its type: the page names a personal workspace called by its owner's email "<email>'s organization" (D36-1 Q264). */
  organizationType: OrganizationType;
  email: string;
  role: OrganizationRole;
  status: InvitationStatus;
  /** Whether an account, live or soft-deleted, holds the address. */
  hasAccount: boolean;
  /**
   * Whether this invitation can make a new account on this site (D36-1
   * decisions 35 and 52): the site's mode and the organization's type,
   * nothing about the address.
   */
  mayRegister: boolean;
}

/**
 * The organization joined, and the access token the switch into it issued.
 * No token when the session didn't move: it was already there, or the
 * switch failed after the join had committed (Preflight ruling 5).
 */
export interface AcceptedInvitation {
  organization: SessionOrganization;
  access?: { token: string; expiresAt: Date } | undefined;
}

export interface RegisterFromInvitationInput extends RequestOrigin {
  token: string;
  password: string;
  /** The Terms version the invitee accepted; refused unless it is the site's (D36-1 decision 29), unread when the site asks for none. */
  acceptedTermsVersion?: string | undefined;
}

/**
 * The new account's session, and the organization it acts in: the inviting
 * one, or the new personal one when the session couldn't start there
 * (Preflight ruling 5).
 */
export interface RegisteredFromInvitation {
  organization: SessionOrganization;
  issued: IssuedSession;
}

export interface IInviteeService {
  /** No lock, no audit: a read for whoever holds the token. */
  preview(token: string): Promise<InvitationPreview>;
  /** Joins the caller to the invitation's organization, then switches their session into it. */
  accept(actor: SessionActor, token: string): Promise<AcceptedInvitation>;
  /** A verified account for the invited address, joined to the organization, signed in. Sends no email. */
  register(input: RegisterFromInvitationInput): Promise<RegisteredFromInvitation>;
}

/** The caller's account was deleted while the acceptance waited (D29 Ruling 271): refused as a revoked session is. */
function accountDeleted(): AppError {
  return new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
}

/** The invitation a token names, as the lookup found it, unlocked, and the token's hash. */
interface FoundInvitation {
  found: InvitationByToken;
  tokenHash: string;
}

/** The invitation under its lock and its organization's, pending and unexpired at `at`. */
interface LockedPending {
  organization: Organization;
  invitation: Invitation;
  at: Date;
}

export function createInviteeService(deps: InviteeServiceDependencies): IInviteeService {
  const { findInvitationByTokenHash, withTransaction, users, sessions, now, log, opampRegistration, termsVersion, registration } =
    deps;

  /**
   * The unlocked lookup. An unknown token, a revoked invitation and a
   * deleted organization are all the same 404: whoever holds a dead link
   * learns nothing more. Whatever it finds is only a first answer; the
   * locked read decides.
   */
  async function findByToken(token: string): Promise<FoundInvitation> {
    const tokenHash = hashToken(token);
    const found = await findInvitationByTokenHash(tokenHash);
    if (!found || found.revokedAt !== null || !found.organizationIsLive) throw invitationNotFound();
    return { found, tokenHash };
  }

  /**
   * Decision 10's locks, the organization and then the invitation, and
   * under them decision 9's refusals in their order. The transaction's
   * context already names the invitation's organization: under row-level
   * security a locking read applies the update policy, so without it the
   * invitation isn't found at all.
   *
   * The hash is compared under the lock (Preflight ruling 1): a Resend that
   * committed after the lookup gave the row a new token, and the old one
   * names nothing. The clock is read under the lock too, so an invitation
   * that expired while this waited for it has expired.
   */
  async function lockPending(
    target: OrganizationRepositories,
    { found, tokenHash }: FoundInvitation,
  ): Promise<LockedPending> {
    const organization = await target.organization.lockActive();
    if (!organization) throw invitationNotFound();
    const locked = await target.invitations.lockForUpdate(found.id);
    if (!locked || locked.tokenHash !== tokenHash || locked.revokedAt !== null) throw invitationNotFound();
    if (locked.acceptedAt !== null) throw invitationAlreadyAccepted();
    const at = now();
    if (isInvitationExpired(locked, at)) throw invitationExpired();
    const { tokenHash: _currentHash, ...invitation } = locked;
    return { organization, invitation, at };
  }

  /** Decision 11's two rows for a join by invitation, in the invitation's organization. */
  function joinAuditEvents(
    actor: Omit<AuditEvent, "action">,
    invitation: Invitation,
    userId: string,
    isNewMember: boolean,
  ): AuditEvent[] {
    const accepted: AuditEvent = {
      ...actor,
      action: "organization_invitation.accepted",
      subjectType: "organization_invitation",
      subjectId: invitation.id,
    };
    if (!isNewMember) return [accepted];
    // D5's shape for a member added: the subject is the user.
    return [
      accepted,
      {
        ...actor,
        action: "organization_member.added",
        subjectType: "user",
        subjectId: userId,
        metadata: { role: invitation.role, invitationId: invitation.id },
      },
    ];
  }

  return {
    async preview(token: string): Promise<InvitationPreview> {
      const { found } = await findByToken(token);
      const status: InvitationStatus =
        found.acceptedAt !== null ? "accepted" : isInvitationExpired(found, now()) ? "expired" : "pending";
      return {
        organizationName: found.organizationName,
        organizationType: found.organizationType,
        email: found.email,
        role: found.role,
        status,
        hasAccount: (await users.findByEmailIncludingDeleted(found.email)) !== undefined,
        mayRegister: allowsInvitationRegistration(registration, found.organizationType),
      };
    },

    /**
     * One transaction in the caller's context, pointed at the invitation's
     * organization once the token has found it. The caller doesn't belong to
     * it yet: that is the point. Then, under the locks, the address check
     * (decision 3) and the membership: a removed member is refused, an
     * active one only marks the invitation accepted (a race: inviting
     * refuses both), and anyone else joins in the invitation's role. The
     * membership insert and `markAccepted` (its `accepted_by_user_id`) take
     * key-share locks on the caller's account. Those wait on anything
     * holding it `for update` (a password reset, a takeover, D2c's plain
     * link), and none of those waits on an organization or an invitation
     * (Preflight ruling 6).
     *
     * Before them, the caller's own account is locked `for share` and must
     * still be live (D29 Ruling 271): a product admin's delete of the
     * caller that committed while this waited would otherwise leave a live
     * membership of a deleted account (its foreign keys pass: the row
     * stays). The order is organization -> invitation -> user, as the
     * delete's is organizations -> person (D29 decision 29): the delete
     * takes every organization lock before any user lock, so while it
     * holds the caller's row it waits on no organization this holds, and
     * this waits on the row only after its own organization and
     * invitation. The other holders of the row `for update` are Preflight
     * ruling 6's, which wait on no organization or invitation. A deleted
     * account is refused as a revoked session is (401 unauthenticated):
     * the delete revoked its sessions in the same transaction.
     *
     * After the commit, D5's switch moves the session, in its own
     * transaction and its own lock order. If it refuses (a removal or a
     * revocation in between), the member has still joined: the answer is the
     * organization, with no new access token, and they switch from the
     * sidebar (Preflight ruling 5).
     */
    async accept(actor: SessionActor, token: string): Promise<AcceptedInvitation> {
      const lookup = await findByToken(token);
      const { userId } = actor.context;
      const joined = await withTransaction(actor.context, async (transaction) => {
        const target = await transaction.enterOrganization(lookup.found.organizationId);
        const { organization, invitation, at } = await lockPending(target, lookup);
        if (!(await target.members.lockJoiningAccountForShare(userId))) throw accountDeleted();
        // Both stored lowercased; lowered again so the comparison can't depend on it.
        if (invitation.email !== actor.email.toLowerCase()) throw invitationEmailMismatch(invitation.email);
        const member = await target.members.find(userId);
        if (member && member.deletedAt !== null) throw removedMemberCannotAccept();
        if (!member) await target.members.add({ userId, role: invitation.role });
        // Pending under the lock just taken: this can't miss.
        if (!(await target.invitations.markAccepted(invitation.id, userId, at))) throw invitationNotFound();
        const auditActor = {
          actorUserId: userId,
          actorEmail: actor.email,
          organizationId: organization.id,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        };
        for (const event of joinAuditEvents(auditActor, invitation, userId, !member)) {
          await transaction.audit.record(event);
        }
        return {
          id: organization.id,
          name: organization.name,
          type: organization.type,
          logoId: organization.logoId,
          role: member?.role ?? invitation.role,
        };
      });

      try {
        const switched = await sessions.switchOrganization({
          context: actor.context,
          email: actor.email,
          organizationId: joined.id,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        });
        return { organization: switched.organization, access: switched.access };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        log.warn(
          { err: error, organizationId: joined.id },
          "joined an organization, but the session couldn't switch to it",
        );
        return { organization: joined };
      }
    },

    /**
     * Registration's rules (the terms first, then the password's contract),
     * and the invitation's refusals before the password is hashed. Then, in
     * the account's one transaction: the account, verified, since the token
     * proves the mailbox; D1b's personal organization and membership; the
     * audit trail; and, with the context pointed at the inviting
     * organization, the same locks and re-checks as an acceptance (a cancel
     * or a resend may have committed since the lookup), the membership and
     * the invitation accepted. The new account is invisible to every other
     * transaction until the commit, so no lock on it is needed.
     *
     * Then a session in the inviting organization, checked under its locks.
     * If that check refuses (a removal or a deletion since the commit), the
     * session starts in the new personal organization instead (Preflight
     * ruling 5). No verification email: the account is already verified.
     */
    async register(input: RegisterFromInvitationInput): Promise<RegisteredFromInvitation> {
      // A site that asks for no Terms (D36-1 decision 32) checks nothing
      // here, whatever the request carries, and the account records none.
      const asksForTerms = siteAsksForTerms(termsVersion);
      if (asksForTerms) assertCurrentTermsVersion(input.acceptedTermsVersion, termsVersion);
      const lookup = await findByToken(input.token);
      const { found } = lookup;
      // Before the invitation's other refusals and the lookup by email (D22
      // decision 23, Preflight ruling 13): only an invitation written
      // before D22 can name the domain, since inviting now refuses it.
      assertAddressNotReserved(found.email);
      if (found.acceptedAt !== null) throw invitationAlreadyAccepted();
      if (isInvitationExpired(found, now())) throw invitationExpired();
      // Once the token has found a live, pending invitation (a bad or expired
      // one answers as before): under invite-only, a personal organization's
      // invitation makes no account (D36-1 decision 52). Before anything is
      // read by the address or written; the page offers sign-in instead.
      if (!allowsInvitationRegistration(registration, found.organizationType)) {
        // `closed` never gets here (the route's gate), but answers in its own words if it did.
        throw registration === "closed" ? registrationNotOpen(registration) : personalInvitationRegistrationRefused();
      }
      // Only a race gets past the page's hasAccount; the unique index backs this up.
      if (await users.findByEmailIncludingDeleted(found.email)) throw accountExists();

      const passwordHash = await hashPassword(input.password);
      const origin: RequestOrigin = { ipAddress: input.ipAddress, userAgent: input.userAgent };
      const createdAt = now();
      const result: { joined?: SessionOrganization } = {};
      let account: Account;
      try {
        account = await users.createAccount(
          {
            email: found.email,
            passwordHash,
            terms: asksForTerms ? { version: termsVersion, acceptedAt: createdAt } : null,
            emailVerifiedAt: createdAt,
            createdAt,
            origin,
          },
          async ({ user, organization: personal, membership }, writes) => {
            const actor = {
              actorUserId: user.id,
              actorEmail: user.email,
              ipAddress: origin.ipAddress,
              userAgent: origin.userAgent,
            };
            // D1b's rows, as registration writes them, in the personal organization.
            await writes.audit.record({
              ...actor,
              organizationId: personal.id,
              action: "user.registered",
              subjectType: "user",
              subjectId: user.id,
              // The accepted version, and no key at all when none was (Preflight ruling 1).
              metadata: asksForTerms ? { via: "invitation", acceptedTermsVersion: termsVersion } : { via: "invitation" },
            });
            await writes.audit.record({
              ...actor,
              organizationId: personal.id,
              action: "organization.created",
              subjectType: "organization",
              subjectId: personal.id,
              metadata: { type: personal.type },
            });
            await writes.audit.record({
              ...actor,
              organizationId: personal.id,
              action: "organization_member.added",
              subjectType: "organization_member",
              subjectId: membership.id,
              metadata: { role: membership.role },
            });

            if (!writes.enterOrganization) throw new Error("the account's transaction can't enter an organization");
            const target = await writes.enterOrganization(found.organizationId);
            const { organization, invitation, at } = await lockPending(target, lookup);
            await target.members.add({ userId: user.id, role: invitation.role });
            // Pending under the lock just taken: this can't miss.
            if (!(await target.invitations.markAccepted(invitation.id, user.id, at))) throw invitationNotFound();
            const joinActor = { ...actor, organizationId: organization.id };
            for (const event of joinAuditEvents(joinActor, invitation, user.id, true)) {
              await writes.audit.record(event);
            }
            result.joined = {
              id: organization.id,
              name: organization.name,
              type: organization.type,
              logoId: organization.logoId,
              role: invitation.role,
            };
          },
        );
      } catch (error) {
        if (error instanceof DuplicateEmailError) throw accountExists();
        throw error;
      }
      const joined = result.joined!;
      const { user, organization: personal, membership } = account;
      // Committed: the opamp-server registers it after the response (D11a decision 20).
      opampRegistration.created(personal);
      const auditMetadata = { via: "invitation" };

      const issued = await sessions.startSession({
        user,
        organizationId: joined.id,
        origin,
        auditMetadata,
        // As the switch checks its target: the organization live and the
        // membership in it, each held until the session commits.
        check: async (transaction) => {
          await transaction.setDatabaseContext({ userId: user.id, organizationId: joined.id });
          const target = transaction.inOrganization(joined.id);
          if (!(await target.organization.findActiveForShare())) return false;
          return (await target.members.findForShare(user.id)) !== undefined;
        },
      });
      if (issued) return { organization: joined, issued };

      log.warn(
        { organizationId: joined.id },
        "joined an organization, but the new account's session couldn't start in it",
      );
      const fallback = await sessions.startSession({
        user,
        organizationId: personal.id,
        origin,
        auditMetadata,
        // The account is still live: `null` is its absent password, `undefined` its absence.
        check: async (transaction) => (await transaction.users.findPasswordHashForShare(user.id)) !== undefined,
      });
      // Deleted in the moments since it was created: there is no session to give.
      if (!fallback) throw new Error("the account created from an invitation was deleted before its session started");
      return {
        organization: {
          id: personal.id,
          name: personal.name,
          type: personal.type,
          logoId: personal.logoId,
          role: membership.role,
        },
        issued: fallback,
      };
    },
  };
}
