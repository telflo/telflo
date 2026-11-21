import type { AuthContext } from "../../database/context.js";
import { verifyPassword as verifyPasswordWithArgon2 } from "../identity/password.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import { currentPasswordIncorrect } from "./errors.js";

/**
 * What a current password is asked for, recorded as
 * `user.reauthentication_failed`'s only metadata.
 */
export type ReauthenticationPurpose = "password_change" | "identity_link" | "identity_unlink";

/** Where a request came from, for the audit trail: the audit row's own columns. */
export interface ReauthenticationOrigin {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface ReauthenticationDependencies {
  /** Outside any transaction: the failure's row stands whatever follows. */
  audit: IAuditRepository;
  /** Injectable so tests can hold or observe it; defaults to identity's Argon2id verify. */
  verifyPassword?: ((hashValue: string, plaintext: string) => Promise<boolean>) | undefined;
}

/** Whose password was asked for, for what, and from where. */
export interface ReauthenticationAttempt {
  user: { id: string; email: string };
  purpose: ReauthenticationPurpose;
  /** The request's session: its organization is the audit row's (as `user.terms_accepted` records it). */
  context: AuthContext;
  origin: ReauthenticationOrigin;
}

export interface VerifyCurrentPasswordInput extends ReauthenticationAttempt {
  /** The account's hash as read for this request; the caller refuses an account without one first. */
  user: { id: string; email: string; passwordHash: string };
  currentPassword: string;
}

/**
 * Audits a current password that didn't verify, or that verified but is no
 * longer the account's (a reset or another change committed in between):
 * `user.reauthentication_failed` with `{ purpose }`, ids and fixed values
 * only, the IP and user agent in their columns. Never the password.
 */
export async function recordReauthenticationFailure(
  audit: IAuditRepository,
  attempt: ReauthenticationAttempt,
): Promise<void> {
  await audit.record({
    action: "user.reauthentication_failed",
    actorUserId: attempt.user.id,
    actorEmail: attempt.user.email,
    organizationId: attempt.context.organizationId,
    subjectType: "user",
    subjectId: attempt.user.id,
    metadata: { purpose: attempt.purpose },
    ipAddress: attempt.origin.ipAddress,
    userAgent: attempt.origin.userAgent,
  });
}

/**
 * Re-authentication by the current password, shared by the password
 * change, the link start and the unlink: one Argon2id verify, outside any
 * transaction so no row is held for its duration. A wrong password is
 * audited, as sign-in audits its failures, then refused with
 * `400 current_password_incorrect`.
 *
 * The verify proves the password only as of the read: the caller rechecks
 * the hash under the user row's lock before it changes anything.
 */
export async function verifyCurrentPassword(
  deps: ReauthenticationDependencies,
  input: VerifyCurrentPasswordInput,
): Promise<void> {
  const verifyPassword = deps.verifyPassword ?? verifyPasswordWithArgon2;
  if (await verifyPassword(input.user.passwordHash, input.currentPassword)) return;
  await recordReauthenticationFailure(deps.audit, input);
  throw currentPasswordIncorrect();
}
