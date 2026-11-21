import type { SessionErrorCode } from "@telflo/contracts";
import type { AuthContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import type { IMailer } from "../../mail/mailer.js";
import type { AppSettings } from "../../settings.js";
import { buildPasswordChangedEmail } from "../identity/emails.js";
import { hashPassword as hashPasswordWithArgon2 } from "../identity/password.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IUserRepository } from "../identity/repositories/user-repository.js";
import type { IPasswordResetTokenRepository } from "../password-resets/repositories/password-reset-token-repository.js";
import { currentPasswordIncorrect, passwordNotSet } from "./errors.js";
import {
  recordReauthenticationFailure,
  verifyCurrentPassword,
  type ReauthenticationOrigin,
} from "./reauthenticate.js";

/**
 * The repositories the change writes through, bound to its one transaction:
 * whatever is written through them commits together or not at all.
 *
 * `users` offers only the lock, the locked reread and the hash's write, which
 * run in the transaction they are bound to; `createAccount` opens one of its
 * own, so leaving it out of the type makes calling it a compile error.
 */
export interface AccountTransaction {
  users: Pick<IUserRepository, "lockForUpdate" | "findPasswordHashForShare" | "setPasswordHash">;
  passwordResetTokens: Pick<IPasswordResetTokenRepository, "consumeAllForUser">;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * the transaction commits. If `work` rejects, the transaction rolls back and
 * the rejection propagates. `work` must write only through the repositories
 * it is handed, and must not do anything that cannot be rolled back.
 */
export type WithAccountTransaction = <Result>(work: (transaction: AccountTransaction) => Promise<Result>) => Promise<Result>;

export interface AccountServiceDependencies {
  /** Outside any transaction: the first read. */
  users: Pick<IUserRepository, "findById">;
  /** Outside any transaction: a refusal's audit row, which stands whatever follows. */
  audit: IAuditRepository;
  withTransaction: WithAccountTransaction;
  mailer: IMailer;
  settings: Pick<AppSettings, "publicWebUrl">;
  now: () => Date;
  runAfterResponse: RunAfterResponse;
  /** Injectable so tests can observe the order; default to identity's Argon2id. */
  verifyPassword?: ((hashValue: string, plaintext: string) => Promise<boolean>) | undefined;
  hashPassword?: ((plaintext: string) => Promise<string>) | undefined;
}

export interface ChangePasswordInput {
  /** The request's session: whose password, and the audit rows' organization. */
  context: AuthContext;
  currentPassword: string;
  newPassword: string;
  origin: ReauthenticationOrigin;
}

export interface IAccountService {
  changePassword(input: ChangePasswordInput): Promise<void>;
}

/**
 * What the change's transaction decided. It returns rather than throws, so a
 * refusal's audit row is written after the rollback and never with it.
 */
type ChangeOutcome = { status: "changed" } | { status: "changed_since" } | { status: "gone" };

function unauthenticated(): AppError {
  return new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
}

export function createAccountService(deps: AccountServiceDependencies): IAccountService {
  const { users, audit, withTransaction, mailer, settings, now, runAfterResponse } = deps;
  const hashPassword = deps.hashPassword ?? hashPasswordWithArgon2;

  return {
    /**
     * Changes the password with the current one, in this order: read the user;
     * no password is `409 password_not_set`; verify the current one and hash
     * the new one, both outside any transaction; then, in one transaction, lock
     * the user's row first, reread the hash under the lock and refuse if it
     * changed since the verify (a reset or another change committed in between:
     * the password verified is no longer the account's), set the new hash,
     * consume every outstanding reset link, and audit the change.
     *
     * Every session is kept, this one included. A sign-in that verified
     * the old password rereads the hash `for share` before its session
     * starts, and so is refused once this commits. The email follows the
     * commit; a failed send is the runner's to log, and never undoes the
     * change.
     */
    async changePassword(input: ChangePasswordInput): Promise<void> {
      const { context, origin } = input;
      const user = await users.findById(context.userId);
      // Deleted since `authenticate` accepted the token: the session is over.
      if (!user) throw unauthenticated();
      if (user.passwordHash === null) throw passwordNotSet();

      const verifiedHash = user.passwordHash;
      const attempt = { user: { id: user.id, email: user.email }, purpose: "password_change" as const, context, origin };
      await verifyCurrentPassword(
        { audit, verifyPassword: deps.verifyPassword },
        { ...attempt, user: { ...attempt.user, passwordHash: verifiedHash }, currentPassword: input.currentPassword },
      );
      const newHash = await hashPassword(input.newPassword);
      const at = now();

      // Lock order: the user's row, then token rows. Every account
      // transaction locks the user first.
      const outcome = await withTransaction(async (transaction): Promise<ChangeOutcome> => {
        await transaction.users.lockForUpdate(user.id);
        const currentHash = await transaction.users.findPasswordHashForShare(user.id);
        if (currentHash === undefined) return { status: "gone" };
        if (currentHash !== verifiedHash) return { status: "changed_since" };
        if (!(await transaction.users.setPasswordHash(user.id, newHash, at))) return { status: "gone" };
        // A link requested before the change would replace the new password
        // within its hour: every outstanding one goes.
        await transaction.passwordResetTokens.consumeAllForUser(user.id, at);
        await transaction.audit.record({
          action: "user.password_changed",
          actorUserId: user.id,
          actorEmail: user.email,
          organizationId: context.organizationId,
          subjectType: "user",
          subjectId: user.id,
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        return { status: "changed" };
      });

      if (outcome.status === "gone") throw unauthenticated();
      if (outcome.status === "changed_since") {
        await recordReauthenticationFailure(audit, attempt);
        throw currentPasswordIncorrect();
      }

      // After the commit: an email must never announce a change that rolled back.
      runAfterResponse(() =>
        mailer.send({
          to: user.email,
          ...buildPasswordChangedEmail({ forgotPasswordUrl: `${settings.publicWebUrl}/forgot-password` }),
        }),
      );
    },
  };
}
