import { EMAIL_RESERVED_MESSAGE, isReservedEmail, type IdentityErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/**
 * `422 email_reserved`: an address at a reserved domain, the service
 * accounts' or the deleted accounts', which no person may hold. Fixed words:
 * the refusal is about the domain, never about an account, so every address
 * at it gets the same answer whether or not a service account holds it.
 */
export function emailReserved(): AppError {
  return new AppError("email_reserved" satisfies IdentityErrorCode, EMAIL_RESERVED_MESSAGE, 422);
}

/**
 * Refuses an address at `@service-accounts.telflo.invalid` or
 * `@deleted-accounts.telflo.invalid` (case aside, trimmed; a subdomain is not
 * the domain). Registration, inviting and registering from an invitation call
 * it before any lookup by email, so no person's flow ever reaches the unique
 * index with a service account's address. Sign-in, the reset request and
 * resend never call it: there such an address is an unknown one, with its
 * uniform answer.
 */
export function assertAddressNotReserved(email: string): void {
  if (isReservedEmail(email)) throw emailReserved();
}
