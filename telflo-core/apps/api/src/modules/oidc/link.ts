import type { OidcLinkResultCode } from "@telflo/contracts";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import {
  IdentityLinkConflictError,
  type IUserIdentityRepository,
} from "../identity/repositories/user-identity-repository.js";
import type { IUserRepository, User } from "../identity/repositories/user-repository.js";
import type { ISessionRepository } from "../sessions/repositories/session-repository.js";
import type { RequestOrigin } from "../sessions/service.js";

/*
 * Linking a provider's account from Settings: the callback's link branch, once
 * the flow, the state, a provider error and the exchange have been checked as
 * for a sign-in. Nothing here is matched by email: the signed-in person proved
 * the account with their session (and their current password when they have
 * one) and the provider's account at the provider, so the provider's `sub` is
 * linked to the flow's user, whatever address the provider gives. The
 * email-authority rule guards matching by email, and is not applied.
 */

/** `user.identity_link_failed`'s reasons. */
export type IdentityLinkFailureReason =
  /** A decoded link flow whose provider is unknown, or isn't the callback's. */
  | "flow_cookie_invalid"
  | "state_mismatch"
  | "provider_error"
  | "exchange_failed"
  /** The flow's session was signed out, or the flow's user is gone, before the callback. */
  | "session_ended"
  /** The ID token's email didn't parse, or `email_verified` wasn't the boolean `true`. */
  | "email_unverified"
  /** The provider's account is linked to another Telflo account. */
  | "identity_in_use"
  /** This account already has another identity at the provider. */
  | "identity_exists"
  /** Anything unexpected; the row names it by a label. */
  | "internal_error";

/**
 * The repositories the link writes through, bound to its one transaction.
 * Lock order: the user's row first, then the session `for share`, then
 * the identity.
 */
export interface LinkTransaction {
  users: Pick<IUserRepository, "lockForUpdate" | "findById">;
  identities: Pick<IUserIdentityRepository, "findUserBySubject" | "findForUser" | "link">;
  sessions: Pick<ISessionRepository, "findLiveForShare">;
  audit: IAuditRepository;
}

export interface LinkDependencies {
  withTransaction: <Result>(work: (transaction: LinkTransaction) => Promise<Result>) => Promise<Result>;
  /** Outside any transaction: the reread after a unique-index race. */
  identities: Pick<IUserIdentityRepository, "findUserBySubject">;
}

export interface LinkInput {
  providerId: string;
  /** The provider's `sub`, from the validated ID token. */
  subject: string;
  /**
   * The ID token's email, trimmed and lowercased, when it parses and
   * `email_verified` is the boolean `true`; else `undefined`. Checked here,
   * after the session, in the link's order.
   */
  verifiedEmail: string | undefined;
  /** The flow's signed-in person: whose account, and which session started the link. */
  userId: string;
  sessionId: string;
  origin: RequestOrigin;
}

/**
 * What the link came to.
 * - `linked`: the `sub` is this account's now. `isWritten` is true only when
 *   this callback wrote the row (and its audit), which is when the email
 *   goes: a second callback of the same link (a double submit) writes nothing.
 * - `refused`: the result code, the audit row's reason, and what was read
 *   for that row: the user while live, and the session's organization once
 *   the session was read.
 */
export type LinkOutcome =
  | { status: "linked"; isWritten: boolean; user: User | undefined }
  | {
      status: "refused";
      code: OidcLinkResultCode;
      reason: IdentityLinkFailureReason;
      /** The flow's user, when read live. */
      user: User | undefined;
      /** The flow's session's active organization, once the session was read. */
      organizationId: string | undefined;
    };

/**
 * The link, in one transaction: lock the user's row; the user live; the
 * flow's session live and the user's own, held `for share` so a sign-out
 * waits for the link; the email verified; then by the `sub`: another
 * account's is `identity_in_use`, this account's is `linked` with nothing
 * written, and this account holding another identity at the provider is
 * `identity_exists`. Else the link and `user.identity_linked`
 * `{ provider, via: "settings" }`, with the session's organization.
 *
 * A link that loses a unique index to a concurrent one is read again after
 * the rollback, as the sign-in's `afterLinkConflict` does: the `sub` now this
 * account's is `linked` (the other callback wrote it), another's is
 * `identity_in_use`, else this account gained another identity at the
 * provider meanwhile: `identity_exists`.
 *
 * Throws only on something unexpected; the caller audits that.
 */
export async function linkIdentityFromSettings(deps: LinkDependencies, input: LinkInput): Promise<LinkOutcome> {
  const { providerId, subject, verifiedEmail, userId, sessionId, origin } = input;
  // What the transaction read, for a refusal's audit row after a race.
  const read: { user: User | undefined; organizationId: string | undefined } = {
    user: undefined,
    organizationId: undefined,
  };
  const refused = (code: OidcLinkResultCode, reason: IdentityLinkFailureReason): LinkOutcome => ({
    status: "refused",
    code,
    reason,
    user: read.user,
    organizationId: read.organizationId,
  });

  try {
    return await deps.withTransaction(async (transaction): Promise<LinkOutcome> => {
      await transaction.users.lockForUpdate(userId);
      const user = await transaction.users.findById(userId);
      if (!user) return refused("link_failed", "session_ended");
      read.user = user;
      const session = await transaction.sessions.findLiveForShare(sessionId, userId);
      if (!session) return refused("link_failed", "session_ended");
      read.organizationId = session.activeOrganizationId;

      if (verifiedEmail === undefined) return refused("email_unverified", "email_unverified");

      const holder = await transaction.identities.findUserBySubject(providerId, subject);
      if (holder && holder.user.id !== userId) return refused("identity_in_use", "identity_in_use");
      if (holder) return { status: "linked", isWritten: false, user };
      if (await transaction.identities.findForUser(userId, providerId)) {
        return refused("identity_exists", "identity_exists");
      }

      await transaction.identities.link({ userId, provider: providerId, subject, email: verifiedEmail });
      await transaction.audit.record({
        action: "user.identity_linked",
        actorUserId: userId,
        actorEmail: user.email,
        organizationId: session.activeOrganizationId,
        subjectType: "user",
        subjectId: userId,
        metadata: { provider: providerId, via: "settings" },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return { status: "linked", isWritten: true, user };
    });
  } catch (error) {
    // Postgres aborted the transaction on the violation, and it has rolled
    // back: this reads afresh.
    if (!(error instanceof IdentityLinkConflictError)) throw error;
    const holder = await deps.identities.findUserBySubject(providerId, subject);
    if (holder?.user.id === userId) return { status: "linked", isWritten: false, user: read.user };
    if (holder) return refused("identity_in_use", "identity_in_use");
    return refused("identity_exists", "identity_exists");
  }
}
