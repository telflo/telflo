import type { IdentityErrorCode } from "@telflo/contracts";
import type { AppSettings } from "../../settings.js";
import { AppError } from "../../errors.js";
import type { IMailer } from "../../mail/mailer.js";
import { buildPasswordResetEmail } from "../identity/emails.js";
import { hashPassword } from "../identity/password.js";
import { generateToken, hashToken } from "../identity/tokens.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IUserRepository, User } from "../identity/repositories/user-repository.js";
import type { ISessionRepository } from "../sessions/repositories/session-repository.js";
import type { IPasswordResetTokenRepository } from "./repositories/password-reset-token-repository.js";

/**
 * How long a reset link works. A constant, not a setting.
 */
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 60;
const PASSWORD_RESET_TOKEN_TTL_MILLISECONDS = PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000;

/**
 * The repositories a unit of work writes through, bound to one transaction:
 * whatever is written through them commits together or not at all.
 *
 * `users` offers only `lockForUpdate` and `setPasswordAndConfirmEmail`,
 * which run in the transaction they are bound to. `createAccount` opens a transaction of its own,
 * so a transaction-bound user repository must never call it; leaving it out
 * of the type makes that a compile error rather than a convention.
 */
export interface PasswordResetTransaction {
  users: Pick<IUserRepository, "lockForUpdate" | "setPasswordAndConfirmEmail">;
  passwordResetTokens: IPasswordResetTokenRepository;
  sessions: Pick<ISessionRepository, "revokeAllForUser">;
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * the transaction commits. If `work` rejects, the transaction rolls back and
 * the rejection propagates. `work` must write only through the repositories
 * it is handed, and must not do anything that cannot be rolled back.
 */
export type WithPasswordResetTransaction = <Result>(
  work: (transaction: PasswordResetTransaction) => Promise<Result>,
) => Promise<Result>;

export interface PasswordResetServiceDependencies {
  /** Outside any transaction: the lookups, and the audit row's email. */
  users: IUserRepository;
  audit: IAuditRepository;
  mailer: IMailer;
  settings: Pick<AppSettings, "publicWebUrl">;
  now: () => Date;
  withTransaction: WithPasswordResetTransaction;
}

/** Where a request came from, for the audit trail. */
interface RequestOrigin {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface RequestResetInput extends RequestOrigin {
  email: string;
}

/** `issueResetLink`'s input: an address, and where the request came from. */
export interface IssueResetLinkInput extends RequestOrigin {
  email: string;
  /**
   * The operator's command that asked, recorded in the audit row's
   * metadata: `telflo-admin reset-link`. Absent for
   * `telflo-admin bootstrap`'s link, whose account it just made.
   */
  via?: "admin_command";
}

export interface CompleteResetInput extends RequestOrigin {
  token: string;
  password: string;
}

export interface CompletedReset {
  userId: string;
  email: string;
  revokedSessions: number;
  /** True when this reset confirmed an unconfirmed email. */
  emailConfirmed: boolean;
}

export type PasswordResetFailureReason = "unknown_token" | "used" | "expired" | "no_account";

export interface IPasswordResetService {
  requestReset(input: RequestResetInput): Promise<void>;
  /**
   * requestReset's token, handed back as its link instead of mailed
   * (`telflo-admin bootstrap` and `telflo-admin reset-link`): the same
   * hashed row, 60 minutes and single use, the earlier links consumed; no
   * email is sent. `undefined` when no live account has the address. The
   * link is a secret: the caller shows it to the one person who asked and
   * never logs it.
   */
  issueResetLink(input: IssueResetLinkInput): Promise<string | undefined>;
  completeReset(input: CompleteResetInput): Promise<CompletedReset>;
}

/**
 * What the transaction in `completeReset` decided. It returns rather than
 * throws, so the consume of an expired or orphaned token commits and the
 * token cannot be presented as unconsumed again.
 */
type ResetOutcome =
  | { status: "reset"; reset: CompletedReset }
  | { status: "refused"; reason: PasswordResetFailureReason; userId?: string };

function invalidResetToken(): AppError {
  return new AppError(
    "invalid_reset_token" satisfies IdentityErrorCode,
    "That reset link is invalid or has expired. Request a new one.",
    400,
  );
}

export function createPasswordResetService(deps: PasswordResetServiceDependencies): IPasswordResetService {
  const { users, audit, mailer, settings, now, withTransaction } = deps;

  /** The link to the reset page: the token in its fragment. */
  const resetUrlOf = (token: string) => `${settings.publicWebUrl}/reset-password#token=${token}`;

  /** The audit row of a request for an account (its outcome added by the caller). */
  const requested = (user: User, input: RequestOrigin) => ({
    action: "user.password_reset_requested",
    actorUserId: user.id,
    actorEmail: user.email,
    subjectType: "user",
    subjectId: user.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  /**
   * A request's token, committed: requestReset mails its link,
   * issueResetLink hands it back. `findByEmail` skips soft-deleted users, so
   * a soft-deleted account gets nothing, like no account at all (audited
   * `no_account`, and `undefined`).
   *
   * Only the newest link works: the earlier ones are consumed in the same
   * transaction that writes the new one. The user's row is locked first, so
   * two requests for one user run one after the other: the second consumes
   * the first's token rather than missing it. The partial unique index
   * uq_password_reset_tokens_one_live_per_user backs this up.
   *
   * Lock order, the same in completeReset: the user's row, then token
   * rows, then sessions. Taking them in any other order lets a request
   * and a completion for one user deadlock.
   */
  async function issue(input: IssueResetLinkInput): Promise<{ user: User; token: string } | undefined> {
    const user = await users.findByEmail(input.email);
    if (!user) {
      await audit.record({
        action: "user.password_reset_requested",
        metadata: { outcome: "no_account" },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      return undefined;
    }

    const at = now();
    const { token, tokenHash } = generateToken();
    await withTransaction(async (transaction) => {
      await transaction.users.lockForUpdate(user.id);
      await transaction.passwordResetTokens.consumeAllForUser(user.id, at);
      await transaction.passwordResetTokens.create({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(at.getTime() + PASSWORD_RESET_TOKEN_TTL_MILLISECONDS),
      });
    });
    return { user, token };
  }

  return {
    /**
     * Runs after the response, so nothing here can change what the
     * requester sees, and the response time is the same whether or not an
     * account exists. `findByEmail` skips soft-deleted users, so a
     * soft-deleted account gets nothing, like no account at all.
     *
     * An unverified account gets a link too: opening it proves the user
     * controls the mailbox.
     */
    async requestReset(input: RequestResetInput): Promise<void> {
      const issued = await issue(input);
      if (!issued) return;
      const { user, token } = issued;

      // After the commit: an email must never carry a token that rolled back.
      // The token goes in the link's fragment, which the browser never sends
      // to a server, so no access log records it.
      // A failed send is audited, then rethrown for the runner to log: the
      // requester was already told to check their email.
      const message = buildPasswordResetEmail({ resetUrl: resetUrlOf(token) });
      try {
        await mailer.send({ to: user.email, ...message });
      } catch (error) {
        await audit.record({ ...requested(user, input), metadata: { outcome: "send_failed" } });
        throw error;
      }
      await audit.record({ ...requested(user, input), metadata: { outcome: "sent" } });
    },

    async issueResetLink(input: IssueResetLinkInput): Promise<string | undefined> {
      const issued = await issue(input);
      if (!issued) return undefined;
      // The audit row says the link was handed back rather than mailed; it
      // never holds the link or its token.
      await audit.record({
        ...requested(issued.user, input),
        metadata: { outcome: "returned", ...(input.via === undefined ? {} : { via: input.via }) },
      });
      return resetUrlOf(issued.token);
    },

    /**
     * The password is hashed before the transaction opens, so no row is
     * locked for Argon2id's duration; an invalid token therefore pays for one
     * hash too, which the per-IP limit bounds.
     *
     * Lock order, the same as requestReset's: the user's row, then token rows,
     * then sessions. So the token's user is found first by a read that locks
     * nothing, and the user's row is locked before the token is consumed.
     * Consuming first would hold the token's row while waiting for the user's,
     * the reverse of a concurrent request, which holds the user's row while it
     * consumes the user's tokens: a deadlock.
     *
     * `consume` is the atomic gate: of two completions with one token,
     * exactly one sees `consumed`, and the other sees `already_consumed` once
     * the first commits. An expired token is consumed by its first
     * presentation and refused, so a second presentation is audited as
     * `used`.
     *
     * The user is not signed in: the caller clears this browser's cookies,
     * and every session the user had is revoked.
     */
    async completeReset(input: CompleteResetInput): Promise<CompletedReset> {
      const passwordHash = await hashPassword(input.password);
      const at = now();

      const outcome = await withTransaction(async (transaction): Promise<ResetOutcome> => {
        const tokenHash = hashToken(input.token);
        const tokenUserId = await transaction.passwordResetTokens.findUserIdByHash(tokenHash);
        if (tokenUserId === undefined) return { status: "refused", reason: "unknown_token" };
        await transaction.users.lockForUpdate(tokenUserId);

        const consumed = await transaction.passwordResetTokens.consume(tokenHash, at);
        if (consumed.status === "not_found") return { status: "refused", reason: "unknown_token" };
        if (consumed.status === "already_consumed") {
          return { status: "refused", reason: "used", userId: consumed.userId };
        }
        if (consumed.expiresAt.getTime() <= at.getTime()) {
          return { status: "refused", reason: "expired", userId: consumed.userId };
        }

        const { userId } = consumed;
        const set = await transaction.users.setPasswordAndConfirmEmail(userId, passwordHash, at);
        if (!set) return { status: "refused", reason: "no_account", userId };

        await transaction.passwordResetTokens.consumeAllForUser(userId, at);
        const revokedSessions = await transaction.sessions.revokeAllForUser(userId, "password_reset");
        return {
          status: "reset",
          reset: { userId, email: set.email, revokedSessions, emailConfirmed: set.wasUnconfirmed },
        };
      });

      if (outcome.status === "refused") {
        // The email is a snapshot for the audit row; a soft-deleted user's is
        // left out, as findById does not find them.
        const user = outcome.userId ? await users.findById(outcome.userId) : undefined;
        await audit.record({
          action: "user.password_reset_failed",
          actorUserId: outcome.userId,
          actorEmail: user?.email,
          ...(outcome.userId ? { subjectType: "user", subjectId: outcome.userId } : {}),
          metadata: { reason: outcome.reason },
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        throw invalidResetToken();
      }

      const { reset } = outcome;
      await audit.record({
        action: "user.password_reset",
        actorUserId: reset.userId,
        actorEmail: reset.email,
        subjectType: "user",
        subjectId: reset.userId,
        metadata: { revokedSessions: reset.revokedSessions, emailConfirmed: reset.emailConfirmed },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      return reset;
    },
  };
}
