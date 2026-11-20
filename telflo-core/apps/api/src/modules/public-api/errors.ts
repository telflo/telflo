import {
  INSUFFICIENT_ACCESS_MESSAGE,
  INVALID_API_TOKEN_MESSAGE,
  ORGANIZATION_REQUIRED_MESSAGE,
  type PublicApiErrorCode,
  type ServiceAccountErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";

/**
 * The public surface's one refusal: every way a token check fails, a
 * missing header, another scheme, a malformed token, an unknown, revoked or
 * expired token, a deleted account, membership or organization, answers
 * this same 401, with `WWW-Authenticate: Bearer` (in the platform's
 * envelope), so a caller can't tell them apart. Its words are fixed: never
 * a token, its prefix or a name.
 */
export function invalidApiToken(): AppError {
  return new AppError("invalid_api_token" satisfies ServiceAccountErrorCode, INVALID_API_TOKEN_MESSAGE, 401, undefined, {
    "www-authenticate": "Bearer",
  });
}

/**
 * A read token on a `write` route: 403 `insufficient_access`, its words
 * fixed. No `WWW-Authenticate` scope: the envelope carries the code.
 */
export function insufficientAccess(): AppError {
  return new AppError("insufficient_access" satisfies PublicApiErrorCode, INSUFFICIENT_ACCESS_MESSAGE, 403);
}

/**
 * A personal token without a well-formed `X-Telflo-Org` where one is needed:
 * 400 `organization_required`, its words fixed. A header that isn't a uuid
 * gets the same answer: it never echoes the value.
 */
export function organizationRequired(): AppError {
  return new AppError("organization_required" satisfies PublicApiErrorCode, ORGANIZATION_REQUIRED_MESSAGE, 400);
}
