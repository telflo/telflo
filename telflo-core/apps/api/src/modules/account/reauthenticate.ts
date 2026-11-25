import type { SessionErrorCode } from "@telflo/contracts";
import type { ActorContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import { verifyPassword as verifyPasswordWithArgon2 } from "../identity/password.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IUserRepository } from "../identity/repositories/user-repository.js";
import { currentPasswordIncorrect } from "./errors.js";

/**
 * What a current password is asked for, recorded as
 * `user.reauthentication_failed`'s only metadata.
 */
export type ReauthenticationPurpose =
  | "password_change"
  | "identity_link"
  | "identity_unlink"
  | "personal_api_token_create"
  | "service_account_token_create";

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
  context: ActorContext;
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
 * change, the link start, the unlink and a personal token's create: one
 * Argon2id verify, outside any transaction so no row is held for its
 * duration. A wrong password is audited, as sign-in audits its failures,
 * then refused with
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

/** The session's person is gone (deleted since `authenticate` accepted it): the session is over. */
export function accountGone(): AppError {
  return new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
}

export interface TokenCreateReauthenticationDependencies {
  /** Outside any transaction: the account's password hash, for the verify. */
  users: Pick<IUserRepository, "findById">;
  /** Outside any transaction: a refused password's row stands whatever follows. */
  audit: IAuditRepository;
  /** Injectable so tests can hold or observe it; defaults to identity's Argon2id verify. */
  verifyPassword?: ((hashValue: string, plaintext: string) => Promise<boolean>) | undefined;
}

/** Who asks for an API token, from the session, and for which. */
export interface TokenCreateReauthenticationInput {
  context: ActorContext;
  origin: ReauthenticationOrigin;
  purpose: "personal_api_token_create" | "service_account_token_create";
  currentPassword: string | undefined;
}

/** What `reauthenticateForTokenCreate` verified, for the recheck under the lock and a late refusal's row. */
export interface TokenCreateReauthentication {
  /** The hash the password was verified against; null for an account without one (nothing asked). */
  verifiedHash: string | null;
  attempt: ReauthenticationAttempt;
}

/**
 * An API token's create, a person's own or a service account's: the
 * signed-in person's current password, when their account has one, as a
 * link's start asks it (an account without one, OIDC only, is asked
 * nothing; a missing one is as wrong, audited alike). Verified outside any
 * transaction, before anything is made.
 *
 * The caller then reads the hash again under its lock
 * (`passwordChangedSince`) and refuses one changed, reset or set since with
 * `refuseChangedSince`.
 */
export async function reauthenticateForTokenCreate(
  deps: TokenCreateReauthenticationDependencies,
  input: TokenCreateReauthenticationInput,
): Promise<TokenCreateReauthentication> {
  const user = await deps.users.findById(input.context.userId);
  if (!user) throw accountGone();
  const attempt: ReauthenticationAttempt = {
    user: { id: user.id, email: user.email },
    purpose: input.purpose,
    context: input.context,
    origin: input.origin,
  };
  if (user.passwordHash === null) return { verifiedHash: null, attempt };
  if (input.currentPassword === undefined) {
    await recordReauthenticationFailure(deps.audit, attempt);
    throw currentPasswordIncorrect();
  }
  await verifyCurrentPassword(
    { audit: deps.audit, verifyPassword: deps.verifyPassword },
    { ...attempt, user: { ...attempt.user, passwordHash: user.passwordHash }, currentPassword: input.currentPassword },
  );
  return { verifiedHash: user.passwordHash, attempt };
}

/**
 * Under the caller's lock: the account's hash read again (`for share`, so a
 * change waits for this transaction), and whether it is still the verified
 * one. "gone" for an account deleted since.
 */
export async function passwordChangedSince(
  users: Pick<IUserRepository, "findPasswordHashForShare">,
  verified: TokenCreateReauthentication,
): Promise<"unchanged" | "changed" | "gone"> {
  const currentHash = await users.findPasswordHashForShare(verified.attempt.user.id);
  if (currentHash === undefined) return "gone";
  return currentHash === verified.verifiedHash ? "unchanged" : "changed";
}

/** After the rollback: a password changed since the verify, audited and refused as a wrong one. */
export async function refuseChangedSince(audit: IAuditRepository, verified: TokenCreateReauthentication): Promise<never> {
  await recordReauthenticationFailure(audit, verified.attempt);
  throw currentPasswordIncorrect();
}
