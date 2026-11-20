import { z } from "zod";
import { emailSchema, PASSWORD_MAXIMUM_LENGTH } from "./shared.js";

/**
 * Twelve characters. The previous product required six (RegisterForm.tsx:72),
 * which is below current guidance; a clean break is the only free moment to
 * raise a password floor, since raising it later strands existing accounts.
 */
export const PASSWORD_MINIMUM_LENGTH = 12;

export const RegisterRequestSchema = z
  .object({
    email: emailSchema,
    // Deliberately not trimmed: leading and trailing spaces are legitimate
    // password characters, and silently removing them would lock people out.
    password: z.string().min(PASSWORD_MINIMUM_LENGTH).max(PASSWORD_MAXIMUM_LENGTH),
    // The Terms version the person accepted, when the site asks for Terms
    // (the version is the API's setting, TELFLO_TERMS_VERSION, "" asking for
    // none). Any version but the current one is refused by the API with
    // `terms_version_not_current`, not by this schema, as for the terms
    // acceptance endpoint. Optional, so a site that asks for no Terms sends
    // none.
    acceptedTermsVersion: z.string().min(1).max(32).optional(),
  })
  .strict();

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/**
 * Identical whether or not the email was already registered. Enumeration
 * safety is a property of the contract, not only of the implementation.
 */
export const RegisterResponseSchema = z
  .object({ status: z.literal("verification_sent") })
  .strict();

export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const VerifyEmailRequestSchema = z
  .object({ token: z.string().min(1).max(512) })
  .strict();

export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const VerifyEmailResponseSchema = z
  .object({ status: z.enum(["verified", "already_verified"]) })
  .strict();

export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponseSchema>;

/** `POST /api/v1/auth/password-reset-requests`: asks for a reset link. */
export const PasswordResetRequestSchema = z
  .object({ email: emailSchema })
  .strict();

export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

/** `POST /api/v1/auth/password-resets`: sets a new password with the emailed token. */
export const PasswordResetSchema = z
  .object({
    token: z.string().min(1).max(512),
    // Deliberately not trimmed, as in RegisterRequestSchema.
    password: z.string().min(PASSWORD_MINIMUM_LENGTH).max(PASSWORD_MAXIMUM_LENGTH),
  })
  .strict();

export type PasswordReset = z.infer<typeof PasswordResetSchema>;

/** `POST /api/v1/auth/verification-emails`: asks for another confirmation email. */
export const VerificationEmailRequestSchema = z
  .object({ email: emailSchema })
  .strict();

export type VerificationEmailRequest = z.infer<typeof VerificationEmailRequestSchema>;

/**
 * The answer of both email endpoints, for any well-formed address. Like
 * RegisterResponseSchema, it is identical whether or not an account exists.
 */
export const AcceptedResponseSchema = z
  .object({ status: z.literal("accepted") })
  .strict();

export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;

/**
 * `PUT /api/v1/auth/me/terms-acceptance`: records acceptance of the current
 * terms. Any version but the API's current one (its TELFLO_TERMS_VERSION
 * setting) is refused with `terms_version_not_current`, not by this schema,
 * so a stale page reads as that rather than as a malformed body.
 */
export const TermsAcceptanceRequestSchema = z
  .object({ version: z.string().min(1).max(32) })
  .strict();

export type TermsAcceptanceRequest = z.infer<typeof TermsAcceptanceRequestSchema>;

/**
 * The error codes the identity endpoints return in the error envelope, named
 * once so a misspelled code is a type error. One code for an unknown,
 * expired or used reset link. `terms_acceptance_required` is any data
 * endpoint's 403 for a user who hasn't accepted the current terms.
 * `product_admin_required` is the 403 of a product administration endpoint
 * for a user without the product-admin flag. `email_reserved` is the `422`
 * of registration, inviting and registering from an invitation for an
 * address at the service accounts' domain.
 */
export const IDENTITY_ERROR_CODES = [
  "invalid_verification_token",
  "invalid_reset_token",
  "terms_version_not_current",
  "terms_acceptance_required",
  "product_admin_required",
  "email_reserved",
] as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

/**
 * `email_reserved`'s words. The refusal is about the domain, never about an
 * account: every address at it gets these words, whether or not a service
 * account holds it.
 */
export const EMAIL_RESERVED_MESSAGE = "This address can't be used";
