import { PERSONAL_API_TOKEN_ERROR_MESSAGES, type AccountErrorCode, type PersonalApiTokenErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The refusals of the account's own routes (D21 decision 21), each under its
 * contract code with the table's status and fixed message, word for word.
 * No message ever names an email, a provider's email, an address, a user
 * agent or a password (decision 45). Not 401 for a wrong current password:
 * the web client treats a 401 as about the session.
 */

function accountError(code: AccountErrorCode, message: string, statusCode: number): AppError {
  return new AppError(code, message, statusCode);
}

/** A wrong current password on a change, a link start or an unlink, or one changed since it was verified. */
export function currentPasswordIncorrect(): AppError {
  return accountError("current_password_incorrect", "The current password is incorrect.", 400);
}

/** A change on an account that has no password (a Google-only account). */
export function passwordNotSet(): AppError {
  return accountError("password_not_set", "Your account has no password yet. Set one from the emailed link.", 409);
}

/** A link start for a provider the account already signs in with. */
export function identityAlreadyLinked(): AppError {
  return accountError("identity_already_linked", "Your account already has a sign-in with this provider.", 409);
}

/** An unlink of a provider the account has no sign-in with. */
export function identityNotLinked(): AppError {
  return accountError("identity_not_linked", "Your account has no sign-in with this provider.", 404);
}

/** An unlink on an account with no password: it would leave no way to sign in. */
export function unlinkRequiresPassword(): AppError {
  return accountError("unlink_requires_password", "Set a password before removing this sign-in.", 409);
}

/** Another person's session, an unknown one or one already ended: all alike. */
export function sessionNotFound(): AppError {
  return accountError("session_not_found", "Session not found", 404);
}

/** The caller's own session is ended by Log out, not from the list. */
export function cannotRevokeCurrentSession(): AppError {
  return accountError("cannot_revoke_current_session", "Use Log out to sign out of this browser.", 409);
}

/** A link start whose provider's discovery failed. */
export function providerUnavailable(): AppError {
  return accountError(
    "provider_unavailable",
    "That sign-in provider isn't available right now. Try again later.",
    503,
  );
}

/*
 * A person's own API tokens' refusals (D25 decision 28; Preflight ruling
 * 14): D22's `api_token_*` codes with a person's words
 * (PERSONAL_API_TOKEN_ERROR_MESSAGES). Never a token, its prefix or its name.
 */

function personalApiTokenError(code: PersonalApiTokenErrorCode, statusCode: number): AppError {
  return new AppError(code, PERSONAL_API_TOKEN_ERROR_MESSAGES[code], statusCode);
}

/** An unknown token, another person's, one already revoked and a malformed id, alike. */
export function personalApiTokenNotFound(): AppError {
  return personalApiTokenError("api_token_not_found", 404);
}

/** A token of the person's not yet revoked, expired ones included, has the name, case aside. */
export function personalApiTokenNameTaken(): AppError {
  return personalApiTokenError("api_token_name_taken", 409);
}

/** The person already has 20 live tokens. */
export function personalApiTokenLimitReached(): AppError {
  return personalApiTokenError("api_token_limit_reached", 409);
}
