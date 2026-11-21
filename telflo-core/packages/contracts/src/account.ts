import { z } from "zod";
import { PASSWORD_MINIMUM_LENGTH } from "./identity.js";
import { OidcProviderSchema } from "./sessions.js";
import { PASSWORD_MAXIMUM_LENGTH } from "./shared.js";

/**
 * The account's own security routes: changing the password, the sign-in
 * methods, linking and unlinking a provider, and the sessions list. Every
 * refusal is a fixed message; no reply carries a raw user agent.
 */

/**
 * The error codes the account routes return in the error envelope, named once
 * so a misspelled code is a type error. An unknown provider is the OIDC
 * start's `404 not_found`, and a limit the existing `429 rate_limited`.
 */
export const ACCOUNT_ERROR_CODES = [
  "current_password_incorrect",
  "password_not_set",
  "identity_already_linked",
  "identity_not_linked",
  "unlink_requires_password",
  "session_not_found",
  "cannot_revoke_current_session",
  "provider_unavailable",
] as const;

export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];

/**
 * A current password as typed: anything not empty, as sign-in takes it, up
 * to the Argon2id bound. Deliberately not trimmed (`RegisterRequestSchema`).
 */
const CurrentPasswordSchema = z.string().min(1).max(PASSWORD_MAXIMUM_LENGTH);

/** `PUT /api/v1/auth/me/password`. */
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: CurrentPasswordSchema,
    // Deliberately not trimmed, as in RegisterRequestSchema.
    newPassword: z.string().min(PASSWORD_MINIMUM_LENGTH).max(PASSWORD_MAXIMUM_LENGTH),
  })
  .strict();

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** The browser families the API's user-agent parser names. */
export const SESSION_BROWSERS = ["firefox", "chrome", "edge", "safari", "opera", "other"] as const;
export const SessionBrowserSchema = z.enum(SESSION_BROWSERS);
export type SessionBrowser = z.infer<typeof SessionBrowserSchema>;

/** The operating system families the API's user-agent parser names. */
export const SESSION_SYSTEMS = ["macos", "windows", "linux", "ios", "android", "chromeos", "other"] as const;
export const SessionSystemSchema = z.enum(SESSION_SYSTEMS);
export type SessionSystem = z.infer<typeof SessionSystemSchema>;

/** At most this many live sessions are listed, the current one always among them. */
export const ACCOUNT_SESSIONS_MAXIMUM = 100;

const instant = z.string().datetime();

/**
 * One of the caller's live sessions. `signedInAt` is the session's
 * `created_at`, `lastActiveAt` its `last_refreshed_at`, `ipAddress` the
 * sign-in's (null when none was recorded); the user agent travels only as
 * its two families.
 */
export const AccountSessionSchema = z
  .object({
    id: z.string().uuid(),
    isCurrent: z.boolean(),
    signedInAt: instant,
    lastActiveAt: instant,
    ipAddress: z.string().nullable(),
    browser: SessionBrowserSchema,
    os: SessionSystemSchema,
  })
  .strict();

export type AccountSession = z.infer<typeof AccountSessionSchema>;

/** `GET /api/v1/auth/sessions`: the current session first, then by last activity. */
export const AccountSessionsResponseSchema = z
  .object({
    items: z.array(AccountSessionSchema).max(ACCOUNT_SESSIONS_MAXIMUM),
    total: z.number().int().min(0),
  })
  .strict();

export type AccountSessionsResponse = z.infer<typeof AccountSessionsResponseSchema>;

/** A provider's id, as the OIDC flow cookie checks it (`oidc/flow-cookie.ts:25`). */
export const IDENTITY_PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * A linked identity: its provider's id (listed even when that provider is no
 * longer configured), the provider's email at link time, when it was linked,
 * and whether a sign-in with that provider links it again by the account's
 * own address after an unlink (`relinksByEmail`: the provider is configured
 * and has an email-authority rule).
 */
export const LinkedIdentitySchema = z
  .object({
    provider: z.string().min(1),
    email: z.string(),
    linkedAt: instant,
    relinksByEmail: z.boolean(),
  })
  .strict();

export type LinkedIdentity = z.infer<typeof LinkedIdentitySchema>;

/** `GET /api/v1/auth/me/sign-in-methods`. */
export const SignInMethodsResponseSchema = z
  .object({
    hasPassword: z.boolean(),
    identities: z.array(LinkedIdentitySchema),
    providers: z.array(OidcProviderSchema),
  })
  .strict();

export type SignInMethodsResponse = z.infer<typeof SignInMethodsResponseSchema>;

/**
 * `POST /api/v1/auth/me/identity-link-requests`. The current password is
 * required when the account has one; the API decides.
 */
export const IdentityLinkRequestSchema = z
  .object({
    provider: z.string().regex(IDENTITY_PROVIDER_ID_PATTERN),
    currentPassword: CurrentPasswordSchema.optional(),
  })
  .strict();

export type IdentityLinkRequest = z.infer<typeof IdentityLinkRequestSchema>;

/** The provider's authorization URL, where the browser goes next. */
export const IdentityLinkResponseSchema = z.object({ authorizationUrl: z.string().url() }).strict();

export type IdentityLinkResponse = z.infer<typeof IdentityLinkResponseSchema>;

/** `DELETE /api/v1/auth/me/identities/{provider}`'s body. */
export const UnlinkIdentityRequestSchema = z.object({ currentPassword: CurrentPasswordSchema }).strict();

export type UnlinkIdentityRequest = z.infer<typeof UnlinkIdentityRequestSchema>;
