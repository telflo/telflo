import { SERVICE_ACCOUNT_ERROR_MESSAGES, type ServiceAccountErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The refusals of the service-account and token routes, each under its
 * contract code, in the contracts' words, which the web shows as they are.
 * Fixed words only: an account's name and address, and a token's name, token
 * and prefix, never go in an error. A contributor's refusal and another
 * organization's id are the organizations module's
 * (`organizationAdminRequired`, `organizationNotFound`).
 */

function serviceAccountError(code: ServiceAccountErrorCode, statusCode: number): AppError {
  return new AppError(code, SERVICE_ACCOUNT_ERROR_MESSAGES[code], statusCode);
}

/** An unknown, deleted or another organization's account, or an id that isn't a canonical uuid, alike. */
export function serviceAccountNotFound(): AppError {
  return serviceAccountError("service_account_not_found", 404);
}

/** A live account of the organization has the name, case aside. */
export function serviceAccountNameTaken(): AppError {
  return serviceAccountError("service_account_name_taken", 409);
}

/** The organization already has 100 live accounts. */
export function serviceAccountLimitReached(): AppError {
  return serviceAccountError("service_account_limit_reached", 409);
}

/** An unknown token, another account's and one already revoked, alike. */
export function apiTokenNotFound(): AppError {
  return serviceAccountError("api_token_not_found", 404);
}

/** A token of the account not yet revoked, expired ones included, has the name, case aside. */
export function apiTokenNameTaken(): AppError {
  return serviceAccountError("api_token_name_taken", 409);
}

/** The account already has 20 live tokens. */
export function apiTokenLimitReached(): AppError {
  return serviceAccountError("api_token_limit_reached", 409);
}
