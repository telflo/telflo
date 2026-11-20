import { z } from "zod";
import { OrganizationRoleSchema, OrganizationTypeSchema } from "./organizations.js";
import { emailSchema, PASSWORD_MAXIMUM_LENGTH } from "./shared.js";
import { UserPreferencesSchema } from "./user-preferences.js";

/**
 * Sign-in. The password has no minimum beyond "not empty": the 12-character
 * floor applies to registration only, and accounts must be able to sign in
 * with whatever they have. The maximum still applies, for the same Argon2id
 * cost reason as registration.
 */
export const CreateSessionRequestSchema = z
  .object({
    email: emailSchema,
    // Deliberately not trimmed, as in RegisterRequestSchema.
    password: z.string().min(1).max(PASSWORD_MAXIMUM_LENGTH),
  })
  .strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SessionUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
  })
  .strict();

export type SessionUser = z.infer<typeof SessionUserSchema>;

/** Returned by sign-in and by refresh. */
export const CreateSessionResponseSchema = z
  .object({ user: SessionUserSchema })
  .strict();

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/**
 * An organization as its member sees it: its type, its logo's id (null for
 * none), and the member's role in it.
 */
export const ActiveOrganizationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: OrganizationTypeSchema,
    logoId: z.string().uuid().nullable(),
    role: OrganizationRoleSchema,
  })
  .strict();

export type ActiveOrganization = z.infer<typeof ActiveOrganizationSchema>;

/**
 * `GET /api/v1/auth/me`. `organizations` lists every organization the user
 * belongs to, each with its type and the user's role, the same shape as the
 * active one. An invariant the database keeps means it is never empty in
 * practice, but the contract does not enforce that: it describes the wire
 * shape, and the invariant belongs to the database.
 *
 * `termsAcceptanceRequired` is true when the site asks for Terms (the API's
 * TELFLO_TERMS_VERSION setting) and the user's accepted terms version isn't
 * that one, and the web app then blocks the signed-in shell with the terms
 * dialog.
 *
 * `isProductAdmin` is the user row's `is_product_admin` as this request's
 * session check read it: an operator's SQL sets and clears it, and the
 * answer follows on the next request. It sits beside
 * `termsAcceptanceRequired`, not in `user`: like that flag it is a fact the
 * API reads about the user on this request, and `SessionUserSchema` is also
 * sign-in's and refresh's answer, which don't carry it.
 *
 * `mayCreateOrganizations` is whether "Create Organization" is offered: true
 * while the site lets everyone create one (the product-admin switch off), or
 * when the user is a product admin as this request read it. The create itself
 * checks again.
 *
 * `preferences` is the person's theme and editor and email preferences, every
 * key filled in (the defaults when nothing is saved): one primary-key read
 * more per `/me`. The signed-in pages render the stored theme from it.
 */
export const CurrentUserResponseSchema = z
  .object({
    user: SessionUserSchema,
    organization: ActiveOrganizationSchema,
    organizations: z.array(ActiveOrganizationSchema),
    termsAcceptanceRequired: z.boolean(),
    isProductAdmin: z.boolean(),
    mayCreateOrganizations: z.boolean(),
    preferences: UserPreferencesSchema,
  })
  .strict();

export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;

/**
 * `PUT /api/v1/auth/sessions/current/organization`: makes another of the
 * user's organizations the session's active one.
 */
export const SwitchOrganizationRequestSchema = z.object({ organizationId: z.string().uuid() }).strict();

export type SwitchOrganizationRequest = z.infer<typeof SwitchOrganizationRequestSchema>;

/** The organization the session now acts in. The API sets a new access cookie with it. */
export const SwitchOrganizationResponseSchema = z.object({ organization: ActiveOrganizationSchema }).strict();

export type SwitchOrganizationResponse = z.infer<typeof SwitchOrganizationResponseSchema>;

export const OidcProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type OidcProvider = z.infer<typeof OidcProviderSchema>;

/**
 * `GET /api/v1/auth/oidc-providers`: the configured federated providers.
 * Empty when none is configured, and the sign-in buttons don't render.
 */
export const OidcProvidersResponseSchema = z
  .object({ providers: z.array(OidcProviderSchema) })
  .strict();

export type OidcProvidersResponse = z.infer<typeof OidcProvidersResponseSchema>;

/**
 * The codes a federated sign-in puts in `/login?error=…` when it fails. The
 * callback is a navigation, not a fetch, so it reports failure in the URL
 * rather than in the error envelope:
 * - `oauth_failed`: cancelled, a missing or wrong flow cookie, a failed
 *   exchange or validation, or an account that can't be signed in to;
 * - `oauth_email_unverified`: the provider's email isn't verified, or the
 *   provider isn't authoritative for it, so nothing was linked or created;
 * - `oauth_email_reserved`: the provider's email is at the service accounts'
 *   domain, so nothing was linked or created;
 * - `registration_not_open`: no account holds the provider's email and the
 *   site's registration isn't open, so nothing was created.
 */
export const OIDC_QUERY_ERROR_CODES = [
  "oauth_failed",
  "oauth_email_unverified",
  "oauth_email_reserved",
  "registration_not_open",
] as const;

export type OidcQueryErrorCode = (typeof OIDC_QUERY_ERROR_CODES)[number];

/**
 * The codes a link started from Settings puts in `/settings/account?link=…`
 * when its callback ends. Fixed words, no personal data in the URL:
 * - `linked`: linked, or already linked to this account (a double submit);
 * - `identity_in_use`: the provider's account is linked to another account;
 * - `identity_exists`: this account already has an identity at the provider;
 * - `email_unverified`: the provider didn't confirm the account's email;
 * - `link_failed`: anything else (the flow, the session, the exchange).
 */
export const OIDC_LINK_RESULT_CODES = [
  "linked",
  "identity_in_use",
  "identity_exists",
  "email_unverified",
  "link_failed",
] as const;

export type OidcLinkResultCode = (typeof OIDC_LINK_RESULT_CODES)[number];

/**
 * Every POST, PUT, PATCH and DELETE under /api/v1/ must carry this header, or
 * it is refused with 403 `csrf_header_missing`. HTTP header names are
 * case-insensitive; this is the lowercase form Node reports them in.
 */
export const CSRF_HEADER_NAME = "x-telflo-csrf";
export const CSRF_HEADER_VALUE = "1";

/**
 * The error codes the session endpoints return in the error envelope. Both the
 * API and the web use these names, so a misspelled code is a type error.
 * Only `access_token_expired` should trigger a refresh.
 */
export const SESSION_ERROR_CODES = [
  "invalid_credentials",
  "email_not_verified",
  "unauthenticated",
  "access_token_expired",
  "csrf_header_missing",
  "rate_limited",
] as const;

export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];
