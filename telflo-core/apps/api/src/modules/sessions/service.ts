import { randomBytes } from "node:crypto";
import type { SessionErrorCode } from "@telflo/contracts";
import type { AuthContext, DatabaseContext } from "../../database/context.js";
import type { AppSettings } from "../../settings.js";
import { AppError } from "../../errors.js";
import { hashPassword, verifyPassword as verifyPasswordWithArgon2 } from "../identity/password.js";
import { generateToken, hashToken } from "../identity/tokens.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { organizationAccessDenied } from "../organizations/errors.js";
import type { IMemberRepository } from "../organizations/repositories/member-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import type {
  IActiveOrganizationRepository,
  IOrganizationRepository,
  Organization,
  WithUserOrganizations,
} from "../organizations/repositories/organization-repository.js";
import type { IUserRepository, User } from "../identity/repositories/user-repository.js";
import type { IAccessTokens } from "./access-tokens.js";
import type { IRefreshTokenRepository } from "./repositories/refresh-token-repository.js";
import type { ISessionRepository, SessionOrganization } from "./repositories/session-repository.js";

/**
 * The repositories a unit of work writes through, bound to its transaction:
 * whatever is written through them commits together or not at all.
 *
 * `users` offers only the read that locks the row for the transaction.
 * `createAccount` opens a transaction of its own, so a transaction-bound user
 * repository must never call it; leaving it out of the type makes that a
 * compile error rather than a convention.
 *
 * `setDatabaseContext` sets whom the rest of the transaction acts for. Reading
 * a session's membership needs it: row-level security hides every membership
 * from a transaction with no context.
 *
 * `inOrganization` hands out the switch's locking reads of its target,
 * scoped to that organization. Row-level security applies a locking read's
 * update policy, so the context must name the target first. A new
 * sign-in's landing takes the same reads.
 *
 * `organizations` reads the user's own memberships, in the user's context:
 * where a new sign-in may land.
 */
export interface SessionTransaction {
  users: Pick<IUserRepository, "findPasswordHashForShare">;
  sessions: ISessionRepository;
  organizations: Pick<IOrganizationRepository, "findNewestJoinedForUser">;
  refreshTokens: IRefreshTokenRepository;
  audit: IAuditRepository;
  setDatabaseContext(context: DatabaseContext): Promise<void>;
  inOrganization(organizationId: string): {
    organization: Pick<IActiveOrganizationRepository, "findActive" | "findActiveForShare">;
    members: Pick<IMemberRepository, "find" | "findForShare">;
  };
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * the transaction commits. If `work` rejects, the transaction rolls back and
 * the rejection propagates. `work` must write only through the repositories
 * it is handed, and must not do anything that cannot be rolled back.
 */
export type WithSessionTransaction = <Result>(work: (transaction: SessionTransaction) => Promise<Result>) => Promise<Result>;

export interface SessionServiceDependencies {
  users: IUserRepository;
  /** Sign-in's personal organization, read in the user's database context. */
  withUserOrganizations: WithUserOrganizations;
  /**
   * Outside any transaction: reads, and writes that stand alone. Refresh
   * tokens are only ever written inside one, so they come only through
   * `withTransaction`.
   */
  sessions: ISessionRepository;
  audit: IAuditRepository;
  /** Sign-in's and refresh's writes, each in one transaction. */
  withTransaction: WithSessionTransaction;
  accessTokens: IAccessTokens;
  /** The refresh tokens' lifetime, and the site's Terms version, which `authenticate` compares. */
  settings: Pick<AppSettings, "refreshTokenTtlDays" | "site">;
  now: () => Date;
  /** Injectable so tests can observe the calls; defaults to identity's Argon2id verify. */
  verifyPassword?: (hashValue: string, plaintext: string) => Promise<boolean>;
}

/** Where a request came from, for the audit trail. */
export interface RequestOrigin {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface SignInInput extends RequestOrigin {
  email: string;
  password: string;
}

export interface RefreshInput extends RequestOrigin {
  refreshToken: string;
}

export interface SignOutInput extends RequestOrigin {
  /** From the access token, valid or expired. Absent when there is no token. */
  sessionId?: string | undefined;
  /** The token's user and organization, recorded on the audit row. */
  userId?: string | undefined;
  organizationId?: string | undefined;
}

export interface SignOutEverywhereInput extends RequestOrigin {
  userId: string;
  /** The authenticated user's email, for the audit row. */
  email: string;
  organizationId?: string | undefined;
}

export interface SwitchOrganizationInput extends RequestOrigin {
  /** The request's context: its session, user and the organization its token names. */
  context: AuthContext;
  /** The authenticated user's email, for the audit row. */
  email: string;
  organizationId: string;
}

/**
 * The organization the session now acts in, and a new access token for it.
 * No token when the request's own token already names it: nothing changed.
 */
export interface SwitchOrganizationResult {
  organization: SessionOrganization;
  access?: { token: string; expiresAt: Date } | undefined;
}

/**
 * One session start, shared by password sign-in, a provider's and an
 * invitation's: a session, its first refresh token, and `user.signed_in` with
 * `auditMetadata`. The session starts in `organizationId`, which the caller
 * chose (an invitation's, which its `check` confirms), or, for a new sign-in
 * (password or a provider's), in the organization `landing` chooses in the
 * session's transaction, the personal organization the last resort.
 */
export type StartSessionInput = StartSessionBase &
  (
    | { organizationId: string; landing?: never }
    | { landing: { personalOrganizationId: string }; organizationId?: never }
  );

interface StartSessionBase {
  user: { id: string; email: string };
  origin: RequestOrigin;
  auditMetadata?: Record<string, unknown> | undefined;
  /**
   * Runs first inside the session's transaction (after a landing's choice,
   * whose organization locks come before it). False refuses the start:
   * nothing is created and nothing is audited, which is the caller's to do.
   * Password sign-in checks that the hash is still the one it verified;
   * a provider's sign-in, that the user is still live.
   */
  check: (transaction: SessionTransaction) => Promise<boolean>;
}

/** A new session's, or a rotated session's, credentials. */
export interface IssuedSession {
  user: { id: string; email: string };
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * What a refresh issued. `rotated` is a new pair. `grace` is only a new access
 * token: the refresh token presented was consumed moments ago by a concurrent
 * refresh, whose response carries the new refresh token.
 */
export type RefreshResult =
  | { kind: "rotated"; issued: IssuedSession }
  | { kind: "grace"; user: { id: string; email: string }; accessToken: string; accessTokenExpiresAt: Date };

export type AuthenticationResult =
  | {
      status: "authenticated";
      userId: string;
      email: string;
      /**
       * Whether the user's Terms are satisfied, from their accepted version as
       * the session check read it, so `requireCurrentTerms` needs no query:
       * the site asks for none (its Terms version is ""), or the user has
       * accepted that version. False for an older version and for none (a
       * federated sign-up), alike.
       */
      hasAcceptedCurrentTerms: boolean;
      /** The row's flag, as the session check read it on this request. */
      isProductAdmin: boolean;
      sessionId: string;
      organization: SessionOrganization;
    }
  /**
   * Validly signed but past `exp`, or naming an organization the session has
   * since left: the cases a refresh can fix.
   */
  | { status: "expired"; sessionId: string }
  | { status: "unauthenticated" };

export type SignInFailureReason =
  | "unknown_email"
  | "no_password"
  | "wrong_password"
  | "email_not_verified"
  | "no_personal_organization"
  | "password_changed";

export interface ISessionService {
  signIn(input: SignInInput): Promise<IssuedSession>;
  /** `undefined` when `check` refused the start. */
  startSession(input: StartSessionInput): Promise<IssuedSession | undefined>;
  refresh(input: RefreshInput): Promise<RefreshResult>;
  signOut(input: SignOutInput): Promise<void>;
  signOutEverywhere(input: SignOutEverywhereInput): Promise<{ count: number }>;
  authenticate(accessToken: string | undefined): Promise<AuthenticationResult>;
  switchOrganization(input: SwitchOrganizationInput): Promise<SwitchOrganizationResult>;
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * How long after a refresh token was consumed presenting it again is taken for
 * a concurrent refresh (two tabs at once) rather than a reuse. A constant, not
 * a setting.
 */
export const REFRESH_GRACE_SECONDS = 10;
const REFRESH_GRACE_MILLISECONDS = REFRESH_GRACE_SECONDS * 1000;

/**
 * Verified against when there is no real hash to verify: an unknown email,
 * or an account with no password (federated only). Built once, at module
 * load, by the same `hashPassword` and so with the same Argon2id parameters
 * as every stored hash, so those paths pay the same verify cost as a wrong
 * password. The password it hashes is random and discarded, so nothing can
 * ever match it. Not dead code: removing the verify that uses it makes an
 * unknown email measurably faster than a known one.
 */
const dummyPasswordHash: Promise<string> = hashPassword(randomBytes(32).toString("base64url"));

/**
 * Resolves once the dummy hash exists. Awaited before the server listens, so
 * the first unknown-email sign-in doesn't also pay for building it, which
 * would make that one request measurably slower than a known email's.
 */
export async function warmUpSessionService(): Promise<void> {
  await dummyPasswordHash;
}

function invalidCredentials(): AppError {
  // Fixed words, under a stable code.
  return new AppError("invalid_credentials" satisfies SessionErrorCode, "Invalid login credentials", 401);
}

function unauthenticated(): AppError {
  return new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
}


/**
 * What the transaction in `refresh` decided. It returns rather than throws,
 * so a reuse's revocation and audit row, written after it, are never rolled
 * back with it.
 */
type RefreshOutcome =
  | { status: "issued"; result: RefreshResult }
  | { status: "reused"; sessionId: string; userId: string }
  | { status: "refused" };

export function createSessionService(deps: SessionServiceDependencies): ISessionService {
  const { users, withUserOrganizations, sessions, audit, withTransaction, accessTokens, settings, now } = deps;

  /** The site asks for no Terms, or the user accepted its version. Read per call. */
  function termsSatisfied(acceptedTermsVersion: string | null): boolean {
    const current = settings.site.terms.version;
    return current === "" || acceptedTermsVersion === current;
  }
  const verifyPassword = deps.verifyPassword ?? verifyPasswordWithArgon2;

  function refreshTokenExpiry(from: Date): Date {
    return new Date(from.getTime() + settings.refreshTokenTtlDays * DAY_IN_MILLISECONDS);
  }

  /** A new refresh-token row, written through `refreshTokens`, and a new access token for a session. */
  async function issueCredentials(
    refreshTokens: IRefreshTokenRepository,
    user: { id: string; email: string },
    sessionId: string,
    organizationId: string,
    at: Date,
  ): Promise<IssuedSession> {
    const { token: refreshToken, tokenHash } = generateToken();
    const refreshTokenExpiresAt = refreshTokenExpiry(at);
    await refreshTokens.create({ sessionId, tokenHash, expiresAt: refreshTokenExpiresAt });
    const access = await accessTokens.issue({ userId: user.id, sessionId, organizationId });
    return {
      user: { id: user.id, email: user.email },
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  async function recordSignInFailure(
    reason: SignInFailureReason,
    input: SignInInput,
    user: User | undefined,
  ): Promise<void> {
    const event: AuditEvent = {
      action: "user.sign_in_failed",
      actorUserId: user?.id,
      actorEmail: user?.email,
      metadata: { reason },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };
    await audit.record(event);
  }

  /**
   * Where a new sign-in lands, chosen in the session's transaction:
   * 1. the active organization of the user's most recently used earlier
   *    session (the one refreshed last; revoked and expired sessions count,
   *    as they still record where the person was), while it is live and the
   *    user a live member of it;
   * 2. otherwise the live organization they joined most recently (their
   *    newest live membership, the personal one included);
   * 3. otherwise `personalOrganizationId`, the personal organization the
   *    caller read (and whose absence it refuses, as before).
   * A candidate is taken only under the switch's locks: the organization
   * `for share`, then the membership `for share`, both held until the
   * session commits. A removal or a delete (which locks the organization
   * first) then either waits and reassigns the new session as it does any
   * other, or committed first and the candidate is passed over: the session
   * never starts somewhere the user can't act. Both candidates are locked
   * before either is chosen, in id order, as an account's delete locks a
   * person's organizations (migration 042), so a passed-over candidate's
   * lock, held to the commit, never closes a cycle with it. These locks
   * come before `check`'s on the user: organization -> user -> session, the
   * order every path takes.
   */
  async function landingOrganizationId(
    transaction: SessionTransaction,
    userId: string,
    personalOrganizationId: string,
  ): Promise<string> {
    // Row-level security shows the user's own memberships in this context; sessions have no policy.
    await transaction.setDatabaseContext({ userId, organizationId: null });
    const earlier = await transaction.sessions.findMostRecentlyUsedOrganizationId(userId);
    const newest = await transaction.organizations.findNewestJoinedForUser(userId);
    const candidates = [...new Set([earlier, newest])].filter((id): id is string => id !== undefined);
    const live = new Set<string>();
    for (const candidate of [...candidates].sort()) {
      await transaction.setDatabaseContext({ userId, organizationId: candidate });
      const target = transaction.inOrganization(candidate);
      if ((await target.organization.findActiveForShare()) && (await target.members.findForShare(userId))) {
        live.add(candidate);
      }
    }
    const chosen = candidates.find((candidate) => live.has(candidate)) ?? personalOrganizationId;
    await transaction.setDatabaseContext({ userId, organizationId: chosen });
    return chosen;
  }

  /**
   * The session and its first refresh token commit together: a session
   * without one could never be refreshed. A landing's choice, then `check`,
   * run first, in the same transaction, so whatever they read under a lock
   * holds until the commit. The audit row follows the commit, so it never
   * records a sign-in that rolled back.
   */
  async function startSession(input: StartSessionInput): Promise<IssuedSession | undefined> {
    const { user, origin } = input;
    const at = now();
    const created = await withTransaction(async (transaction) => {
      const organizationId =
        input.landing === undefined
          ? input.organizationId
          : await landingOrganizationId(transaction, user.id, input.landing.personalOrganizationId);
      if (!(await input.check(transaction))) return undefined;
      const session = await transaction.sessions.create({
        userId: user.id,
        activeOrganizationId: organizationId,
        ipAddress: origin.ipAddress ?? null,
        userAgent: origin.userAgent ?? null,
      });
      const credentials = await issueCredentials(transaction.refreshTokens, user, session.id, organizationId, at);
      return { session, issued: credentials, organizationId };
    });
    if (!created) return undefined;

    await audit.record({
      action: "user.signed_in",
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: created.organizationId,
      subjectType: "session",
      subjectId: created.session.id,
      metadata: input.auditMetadata,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
    return created.issued;
  }

  return {
    /**
     * Enumeration-safe in the same sense as registration: an unknown
     * email, an account without a password, a soft-deleted account (which
     * findByEmail does not find) and a wrong password all fail with the
     * identical `invalid_credentials`, and each pays exactly one Argon2id
     * verify, the dominant cost. Every failure also writes one audit row.
     * Database latency still varies, so this is not constant time, but the
     * deliberately slow part is paid on every path.
     *
     * `email_not_verified` is checked only after the password verifies, so
     * it tells nothing to someone without the password.
     */
    async signIn(input: SignInInput): Promise<IssuedSession> {
      const user = await users.findByEmail(input.email);

      if (!user) {
        await verifyPassword(await dummyPasswordHash, input.password);
        await recordSignInFailure("unknown_email", input, undefined);
        throw invalidCredentials();
      }

      if (user.passwordHash === null) {
        await verifyPassword(await dummyPasswordHash, input.password);
        await recordSignInFailure("no_password", input, user);
        throw invalidCredentials();
      }

      if (!(await verifyPassword(user.passwordHash, input.password))) {
        await recordSignInFailure("wrong_password", input, user);
        throw invalidCredentials();
      }

      if (user.emailVerifiedAt === null) {
        await recordSignInFailure("email_not_verified", input, user);
        throw new AppError("email_not_verified" satisfies SessionErrorCode, "Email not confirmed", 403);
      }

      // The personal organization: where a sign-in lands when nothing else
      // will do (the last resort of `startSession`'s landing). A person
      // always has one, so its absence is a bug to surface, not a case to
      // paper over by picking another organization. A service account, which
      // has none, never gets here: the lookup matches people only, and no
      // session is ever made for one.
      const personal = await withUserOrganizations(user.id, (organizations) =>
        organizations.findPersonalForUser(user.id),
      );
      if (!personal) {
        await recordSignInFailure("no_personal_organization", input, user);
        // The same code and text the error handler gives any unexpected
        // failure, so the client learns nothing; the audit row has the reason.
        throw new AppError("internal_error", "Something went wrong. Please try again.", 500);
      }

      // The password was verified outside the transaction, so a reset may
      // have committed since. Rereading the hash `for share` either waits for
      // a reset in flight, whose `for update` holds the row, or makes a later
      // one wait for this commit, whose session it then revokes. A hash that
      // changed refuses the sign-in and creates nothing.
      const verifiedHash = user.passwordHash;
      const issued = await startSession({
        user,
        landing: { personalOrganizationId: personal.id },
        origin: { ipAddress: input.ipAddress, userAgent: input.userAgent },
        check: async (transaction) => (await transaction.users.findPasswordHashForShare(user.id)) === verifiedHash,
      });
      if (!issued) {
        await recordSignInFailure("password_changed", input, user);
        throw invalidCredentials();
      }
      return issued;
    },

    startSession,

    /**
     * Rotates the pair. `consume` is the atomic gate, so of two
     * presentations of one token exactly one gets here as `consumed`; the
     * other sees `already_consumed`, which is a grace (below) or a reuse.
     * Inside the transaction, a concurrent presentation waits on the first
     * one's row lock: it sees `already_consumed` once the first commits, or
     * consumes the token itself if the first rolled back.
     *
     * A reuse, a consumed token presented after the grace window, revokes
     * the whole session: either the legitimate client or a thief
     * is holding a token that was already rotated, and the server cannot
     * tell which, so neither keeps the session.
     *
     * An expired token is refused without revoking: it was consumed just
     * now for the first time, so nothing was reused.
     *
     * The grace window: a token consumed at most REFRESH_GRACE_SECONDS before
     * this presentation, unexpired, for a session that is still live, gets
     * only a new access token. Nothing is written: the concurrent refresh that
     * consumed it already rotated the pair and set the new refresh cookie in
     * the same browser's jar. The difference may be negative: a presentation
     * that waited on the winner's row lock read its clock before the winner
     * wrote `consumed_at`, and that is exactly the two-tab case the window
     * exists for.
     *
     * The session's membership is read in its user's database context, set
     * once `consume` has named the user, in the same transaction.
     */
    async refresh(input: RefreshInput): Promise<RefreshResult> {
      const at = now();

      // Consume, the new token and the touch commit together. If anything
      // after consume fails, consume rolls back with it, so the client,
      // which keeps its cookies on a non-AppError failure, can retry with
      // the same token instead of having it treated as a reuse.
      const outcome = await withTransaction(async (transaction): Promise<RefreshOutcome> => {
        const result = await transaction.refreshTokens.consume(hashToken(input.refreshToken), at);
        if (result.status === "not_found") return { status: "refused" };
        if (result.status === "already_consumed") {
          if (at.getTime() - result.consumedAt.getTime() > REFRESH_GRACE_MILLISECONDS) {
            return { status: "reused", sessionId: result.sessionId, userId: result.userId };
          }
          // Within the window, but the token had expired (its first
          // presentation consumed it and was refused) or the session has
          // since ended: refused, and not a reuse, so nothing is revoked or
          // audited.
          if (result.expiresAt.getTime() <= at.getTime()) return { status: "refused" };
          await transaction.setDatabaseContext({ userId: result.userId, organizationId: null });
          const live = await transaction.sessions.findLiveWithUser(result.sessionId);
          if (!live) return { status: "refused" };
          const access = await accessTokens.issue({
            userId: live.user.id,
            sessionId: live.session.id,
            organizationId: live.organization.id,
          });
          return {
            status: "issued",
            result: {
              kind: "grace",
              user: { id: live.user.id, email: live.user.email },
              accessToken: access.token,
              accessTokenExpiresAt: access.expiresAt,
            },
          };
        }
        if (result.expiresAt.getTime() <= at.getTime()) return { status: "refused" };

        await transaction.setDatabaseContext({ userId: result.userId, organizationId: null });
        const live = await transaction.sessions.findLiveWithUser(result.sessionId);
        if (!live) return { status: "refused" };

        // The session row, not the old access token, says which organization
        // the new token carries.
        const issued = await issueCredentials(
          transaction.refreshTokens,
          live.user,
          live.session.id,
          live.organization.id,
          at,
        );
        await transaction.sessions.touchRefreshed(live.session.id, at);
        return { status: "issued", result: { kind: "rotated", issued } };
      });

      if (outcome.status === "issued") return outcome.result;
      if (outcome.status === "refused") throw unauthenticated();

      // A reuse, handled after the transaction so its revocation and audit
      // row stand on their own. Looked up first only for the audit row: once
      // revoked, the session is no longer live and its user and
      // organization are not returned.
      const { sessionId, userId } = outcome;
      const live = await withTransaction(async (transaction) => {
        await transaction.setDatabaseContext({ userId, organizationId: null });
        return transaction.sessions.findLiveWithUser(sessionId);
      });
      const isRevoked = await sessions.revoke(outcome.sessionId, "refresh_token_reused");
      await audit.record({
        action: "session.refresh_token_reused",
        actorUserId: live?.user.id,
        actorEmail: live?.user.email,
        organizationId: live?.organization.id,
        subjectType: "session",
        subjectId: outcome.sessionId,
        metadata: { isRevoked },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      throw unauthenticated();
    },

    /** Never fails: logging out of an unknown or already revoked session is a no-op. */
    async signOut(input: SignOutInput): Promise<void> {
      if (!input.sessionId) return;
      const isRevoked = await sessions.revoke(input.sessionId, "logout");
      if (!isRevoked) return;
      // The email is a snapshot for the audit row; the user may since have
      // been soft-deleted, in which case it is left out.
      const user = input.userId ? await users.findById(input.userId) : undefined;
      await audit.record({
        action: "user.signed_out",
        actorUserId: input.userId,
        actorEmail: user?.email,
        organizationId: input.organizationId,
        subjectType: "session",
        subjectId: input.sessionId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    },

    async signOutEverywhere(input: SignOutEverywhereInput): Promise<{ count: number }> {
      const count = await sessions.revokeAllForUser(input.userId, "sign_out_everywhere");
      await audit.record({
        action: "user.signed_out_everywhere",
        actorUserId: input.userId,
        actorEmail: input.email,
        organizationId: input.organizationId,
        subjectType: "user",
        subjectId: input.userId,
        metadata: { count },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      return { count };
    },

    /**
     * The per-request check. A valid JWT is not enough: the session row must
     * still be live, so revocation takes effect on the next request rather
     * than when the token expires.
     *
     * The token's `sub` and `organization_id` must also agree with the
     * session row. The row is authoritative and the token only caches it. A
     * token naming another user is forged or misrouted, and is
     * `unauthenticated`. A token naming the right user but another
     * organization is stale: the session was switched in another tab, or
     * moved when the user lost that organization. It gets `expired`, and
     * the refresh the client answers with issues a token for the session's
     * current organization. Either way the request is refused rather than
     * silently acting in the row's organization: a request must never act
     * in an organization other than the one its token names, which is also
     * the organization audit rows record for it.
     *
     * The lookup runs in the database context the token claims. Row-level
     * security shows it the claimed user's memberships and the claimed
     * organization's, and the query's joins then confirm both.
     */
    async authenticate(accessToken: string | undefined): Promise<AuthenticationResult> {
      if (!accessToken) return { status: "unauthenticated" };

      const verified = await accessTokens.verify(accessToken);
      if (verified.status === "invalid") return { status: "unauthenticated" };
      if (verified.status === "expired") return { status: "expired", sessionId: verified.claims.sessionId };

      const { claims } = verified;
      const live = await withTransaction(async (transaction) => {
        await transaction.setDatabaseContext({ userId: claims.userId, organizationId: claims.organizationId });
        return transaction.sessions.findLiveWithUser(claims.sessionId);
      });
      if (!live) return { status: "unauthenticated" };
      if (live.user.id !== claims.userId) return { status: "unauthenticated" };
      if (live.organization.id !== claims.organizationId) return { status: "expired", sessionId: live.session.id };

      return {
        status: "authenticated",
        userId: live.user.id,
        email: live.user.email,
        hasAcceptedCurrentTerms: termsSatisfied(live.user.acceptedTermsVersion),
        isProductAdmin: live.user.isProductAdmin,
        sessionId: live.session.id,
        organization: live.organization,
      };
    },

    /**
     * Switches the session's organization, in one transaction. Its locks, in
     * order:
     * 1. the target organization, `for share`, which must be live, so a
     *    concurrent delete (which locks it `for no key update`) either waits
     *    for the switch and then reassigns the session, or commits first and
     *    the switch finds it gone;
     * 2. the session, `for update`, which must still be live;
     * 3. the user's live membership there, `for share`, so a concurrent
     *    removal waits for the switch and then reassigns the session.
     *
     * The organization comes before the session so that every path locks
     * organization -> user -> session. A removal, deletion or restore locks
     * the organization and then the user; a password reset (and a takeover)
     * locks the user and then their sessions. A switch that locked its
     * session first and then waited on the organization closed a three-way
     * cycle with those two (40P01).
     *
     * An unknown or deleted organization, and one the user isn't an active
     * member of, all get the same 403. Switching to the organization the
     * session already acts in changes and audits nothing, and takes no lock
     * (below).
     *
     * The session row is authoritative: the new access token is issued only
     * once the switch has committed, and the refresh token,
     * which belongs to the session, is untouched.
     *
     * The request's id is lowercased before any comparison: Postgres matches
     * an id in capitals to the same row, so the current organization in
     * capitals would skip the no-op, audit a switch from it to itself and
     * issue a token naming it in capitals. Anything that isn't a uuid is
     * nothing's id: the same 403.
     */
    async switchOrganization(input: SwitchOrganizationInput): Promise<SwitchOrganizationResult> {
      const { context } = input;
      const organizationId = canonicalIdOf(input.organizationId);
      if (organizationId === undefined) throw organizationAccessDenied();
      const switched = await withTransaction(async (transaction) => {
        await transaction.setDatabaseContext({ userId: context.userId, organizationId });
        const target = transaction.inOrganization(organizationId);

        /** The no-op's answer, from an unlocked read of the membership. */
        const alreadyThere = async (organization: Organization | undefined) => {
          if (!organization) throw organizationAccessDenied();
          const member = await target.members.find(context.userId);
          if (!member || member.deletedAt !== null) throw organizationAccessDenied();
          return {
            id: organization.id,
            name: organization.name,
            type: organization.type,
            logoId: organization.logoId,
            role: member.role,
          };
        };

        // Read unlocked first: the no-op must not lock the organization. A
        // delete (and a removal) locks the organization first and then,
        // reassigning, every session active in it. This session is active
        // in it, so a lock on the organization here could wait on a delete
        // that then waits on this session. An unlocked read answers the
        // no-op: if the delete or removal committed first, the organization
        // or membership is gone and the answer is the same 403 a switch
        // into it gets; if it commits later, it reassigns this session.
        const current = await transaction.sessions.findLive(context.sessionId);
        if (!current || current.userId !== context.userId) throw unauthenticated();
        if (current.activeOrganizationId === organizationId) {
          return alreadyThere(await target.organization.findActive());
        }

        const organization = await target.organization.findActiveForShare();
        if (!organization) throw organizationAccessDenied();
        const session = await transaction.sessions.lockLive(context.sessionId);
        if (!session || session.userId !== context.userId) throw unauthenticated();
        // Moved into the target since the read above (another switch of the
        // same session): a no-op after all, answered under the share lock
        // this already holds, which no delete or removal can be waiting past.
        if (session.activeOrganizationId === organizationId) return alreadyThere(organization);
        const membership = await target.members.findForShare(context.userId);
        if (!membership) throw organizationAccessDenied();

        const fromOrganizationId = session.activeOrganizationId;
        await transaction.sessions.setActiveOrganization(session.id, organizationId);
        await transaction.audit.record({
          action: "session.organization_switched",
          actorUserId: context.userId,
          actorEmail: input.email,
          organizationId,
          subjectType: "session",
          subjectId: session.id,
          metadata: { fromOrganizationId },
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        return {
          id: organization.id,
          name: organization.name,
          type: organization.type,
          logoId: organization.logoId,
          role: membership.role,
        };
      });

      if (context.organizationId === organizationId) return { organization: switched };
      const access = await accessTokens.issue({ userId: context.userId, sessionId: context.sessionId, organizationId });
      return { organization: switched, access: { token: access.token, expiresAt: access.expiresAt } };
    },
  };
}
