import { z } from "zod";
import { hasUnstorableCharacter } from "./configurations.js";

/**
 * Service accounts and their API tokens (D22). A service account is a
 * `users` row of kind `service` (ADR 0025) with a name row beside it, a
 * fixed contributor of one organization, managed by that organization's
 * admins in Settings › Service Accounts:
 *
 *   GET    /api/v1/organizations/{organizationId}/service-accounts                      → ServiceAccountsResponseSchema
 *   POST   /api/v1/organizations/{organizationId}/service-accounts                      CreateServiceAccountRequestSchema → 201 ServiceAccountResponseSchema
 *   GET    /api/v1/organizations/{organizationId}/service-accounts/{serviceAccountId}   → ServiceAccountResponseSchema
 *   PATCH  /api/v1/organizations/{organizationId}/service-accounts/{serviceAccountId}   RenameServiceAccountRequestSchema → ServiceAccountResponseSchema
 *   DELETE /api/v1/organizations/{organizationId}/service-accounts/{serviceAccountId}   → 204
 *   GET    …/service-accounts/{serviceAccountId}/api-tokens                              → ApiTokensResponseSchema
 *   POST   …/service-accounts/{serviceAccountId}/api-tokens                              CreateApiTokenRequestSchema → 201 CreatedApiTokenResponseSchema (no-store)
 *   DELETE …/service-accounts/{serviceAccountId}/api-tokens/{tokenId}                    → 204 (a revoke)
 *   GET    /api/public/v1/whoami (Authorization: Bearer tf_…)                            → WhoAmIResponseSchema (no-store)
 *
 * A `tf_` token is a secret like a fleet's bearer (decision 48): it crosses
 * the API only in the create's reply, and a list item holds its prefix
 * only. A service account's name and address are organization content
 * (decision 49): no error message here holds one, nor a token or a prefix.
 */

/**
 * The domain every service account's address is at (decision 5). `.invalid`
 * is reserved (RFC 2606): such an address never resolves and never receives
 * mail. Registration, invitations and Google sign-in refuse it (decisions
 * 23, 24); it is deliberately not in the shared `emailSchema`, so sign-in,
 * reset and resend keep their uniform answers for it (decision 22).
 */
export const SERVICE_ACCOUNT_EMAIL_DOMAIN = "service-accounts.telflo.invalid";

const SERVICE_ACCOUNT_EMAIL_SUFFIX = `@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`;

/**
 * Whether an address is at the reserved domain, trimmed and case aside.
 * The exact domain only: a subdomain of it, or a domain that merely ends
 * with its letters, is not reserved (decision 23).
 */
export function isServiceAccountEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(SERVICE_ACCOUNT_EMAIL_SUFFIX);
}

/**
 * The domain a deleted person's address moves to (D29 decision 10):
 * `deleted-<24 hex>@deleted-accounts.telflo.invalid`, so the original
 * address is free to register again. `.invalid` never receives mail.
 */
export const DELETED_ACCOUNT_EMAIL_DOMAIN = "deleted-accounts.telflo.invalid";

const RESERVED_EMAIL_SUFFIXES = [SERVICE_ACCOUNT_EMAIL_SUFFIX, `@${DELETED_ACCOUNT_EMAIL_DOMAIN}`];

/**
 * Whether an address is at a domain no person may hold (D29 decision 10,
 * Preflight ruling 6): the service accounts' (isServiceAccountEmail) or the
 * deleted accounts'. Trimmed and case aside; the exact domains only, as
 * isServiceAccountEmail. Registration, inviting, registering from an
 * invitation and Google sign-in refuse both (`email_reserved`).
 */
export function isReservedEmail(email: string): boolean {
  const address = email.trim().toLowerCase();
  return RESERVED_EMAIL_SUFFIXES.some((suffix) => address.endsWith(suffix));
}

/** The longest slug an address carries. */
const SERVICE_ACCOUNT_SLUG_MAXIMUM_LENGTH = 32;

/** The address's random part: eight lowercase hex digits. */
const SERVICE_ACCOUNT_RANDOM_HEX_PATTERN = /^[0-9a-f]{8}$/;

/**
 * A service account's address (decision 5): the name is lowercased, every run
 * of characters outside `[a-z0-9]` becomes one `-`, `-` is trimmed from both
 * ends, the slug is cut at 32 characters and a `-` the cut leaves at its end
 * is dropped. The address is `<slug>-<hex>@service-accounts.telflo.invalid`,
 * or `<hex>@service-accounts.telflo.invalid` when no slug is left.
 *
 * `randomHex` (eight lowercase hex digits, from `randomBytes(4)`) is passed
 * in so the rule is pure; anything else is a programming error and throws.
 * The address is fixed at creation: a rename keeps it.
 */
export function serviceAccountEmail(name: string, randomHex: string): string {
  if (!SERVICE_ACCOUNT_RANDOM_HEX_PATTERN.test(randomHex)) {
    throw new Error("A service account's address takes eight lowercase hex digits.");
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SERVICE_ACCOUNT_SLUG_MAXIMUM_LENGTH)
    .replace(/-+$/, "");
  return slug ? `${slug}-${randomHex}${SERVICE_ACCOUNT_EMAIL_SUFFIX}` : `${randomHex}${SERVICE_ACCOUNT_EMAIL_SUFFIX}`;
}

/** A service account's name, after trimming (default 16). */
export const SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH = 64;

/** A token's name follows the account's rule (decision 31). */
export const API_TOKEN_NAME_MAXIMUM_LENGTH = SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH;

/** Live service accounts per organization (decision 8). */
export const SERVICE_ACCOUNTS_MAXIMUM = 100;

/** Live tokens (neither revoked nor expired) per service account (decision 8). */
export const API_TOKENS_LIVE_MAXIMUM = 20;

/** The longest expiry a token can be given, in days of 24 hours (decision 8). */
export const API_TOKEN_EXPIRY_DAYS_MAXIMUM = 3650;

const UNSTORABLE_NAME_MESSAGE = "The name can't contain U+0000 or a lone surrogate.";

/**
 * Trimmed, then 1 to 64 characters, refusing text Postgres can't store
 * exactly (`hasUnstorableCharacter`, as `ConfigurationNameSchema`).
 */
function nameSchema(emptyMessage: string, maximumLength: number) {
  return z
    .string()
    .trim()
    .min(1, emptyMessage)
    .max(maximumLength)
    .refine((name) => !hasUnstorableCharacter(name), UNSTORABLE_NAME_MESSAGE);
}

/** A service account's name (decision 26). */
export const ServiceAccountNameSchema = nameSchema("Service account name is required", SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH);

/** A token's name (decision 31): the account's rule. */
export const ApiTokenNameSchema = nameSchema("Token name is required", API_TOKEN_NAME_MAXIMUM_LENGTH);

const uuid = z.string().uuid();
const instant = z.string().datetime();

/** The admin who created an account, or null once that user is hard-deleted. */
export const ServiceAccountCreatorSchema = z.object({ userId: uuid, email: z.string() }).strict();

export type ServiceAccountCreator = z.infer<typeof ServiceAccountCreatorSchema>;

/**
 * A service account (decision 26). `id` is its user's id; `email` its slug
 * address; `tokenCount` the tokens its page lists (not revoked, expired
 * included), so the list's column and the page agree.
 */
export const ServiceAccountSchema = z
  .object({
    id: uuid,
    name: z.string(),
    email: z.string(),
    createdAt: instant,
    createdBy: ServiceAccountCreatorSchema.nullable(),
    tokenCount: z.number().int().min(0),
  })
  .strict();

export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;

/** The organization's live accounts, newest first. */
export const ServiceAccountsResponseSchema = z
  .object({ items: z.array(ServiceAccountSchema).max(SERVICE_ACCOUNTS_MAXIMUM) })
  .strict();

export type ServiceAccountsResponse = z.infer<typeof ServiceAccountsResponseSchema>;

export const ServiceAccountResponseSchema = z.object({ serviceAccount: ServiceAccountSchema }).strict();

export type ServiceAccountResponse = z.infer<typeof ServiceAccountResponseSchema>;

export const CreateServiceAccountRequestSchema = z.object({ name: ServiceAccountNameSchema }).strict();

export type CreateServiceAccountRequest = z.infer<typeof CreateServiceAccountRequestSchema>;

export const RenameServiceAccountRequestSchema = z.object({ name: ServiceAccountNameSchema }).strict();

export type RenameServiceAccountRequest = z.infer<typeof RenameServiceAccountRequestSchema>;

/** Read (the default) or Read & write (decision 8); D25 enforces it per route. */
export const API_TOKEN_ACCESS = ["read", "write"] as const;
export const ApiTokenAccessSchema = z.enum(API_TOKEN_ACCESS);
export type ApiTokenAccess = z.infer<typeof ApiTokenAccessSchema>;

/**
 * A token (decision 7): `tf_` and the base64url of 32 random bytes, 46
 * characters, so secret scanners can match it. Stored only as its SHA-256
 * and its first 11 characters.
 */
export const API_TOKEN_PATTERN = /^tf_[A-Za-z0-9_-]{43}$/;

/** A token's prefix as listed: its first 11 characters (`tf_` and eight). */
export const API_TOKEN_PREFIX_PATTERN = /^tf_[A-Za-z0-9_-]{8}$/;

/**
 * A token as listed (decision 31): its prefix, never the token. `isExpired`
 * is the API's clock's, so the badge never depends on the browser's.
 */
export const ApiTokenSchema = z
  .object({
    id: uuid,
    name: z.string(),
    prefix: z.string().regex(API_TOKEN_PREFIX_PATTERN),
    access: ApiTokenAccessSchema,
    expiresAt: instant.nullable(),
    lastUsedAt: instant.nullable(),
    createdAt: instant,
    isExpired: z.boolean(),
  })
  .strict();

export type ApiToken = z.infer<typeof ApiTokenSchema>;

/** An account's tokens not revoked, live and expired, newest first. */
export const ApiTokensResponseSchema = z.object({ items: z.array(ApiTokenSchema) }).strict();

export type ApiTokensResponse = z.infer<typeof ApiTokensResponseSchema>;

/** The words for an expiry outside the rule (Preflight ruling 31). */
export const API_TOKEN_EXPIRY_DAYS_MESSAGE = `Enter a whole number of days from 1 to ${API_TOKEN_EXPIRY_DAYS_MAXIMUM}.`;

/**
 * `expiresInDays` is a whole number from 1 to 3650, or null for never
 * (decision 31); `access` is required (the web's checkbox defaults to read).
 */
export const CreateApiTokenRequestSchema = z
  .object({
    name: ApiTokenNameSchema,
    access: ApiTokenAccessSchema,
    expiresInDays: z
      .number({ invalid_type_error: API_TOKEN_EXPIRY_DAYS_MESSAGE })
      .int(API_TOKEN_EXPIRY_DAYS_MESSAGE)
      .min(1, API_TOKEN_EXPIRY_DAYS_MESSAGE)
      .max(API_TOKEN_EXPIRY_DAYS_MAXIMUM, API_TOKEN_EXPIRY_DAYS_MESSAGE)
      .nullable(),
  })
  .strict();

export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequestSchema>;

/** The create's reply, the only place the token crosses the API (`Cache-Control: no-store`). */
export const CreatedApiTokenResponseSchema = z
  .object({ apiToken: ApiTokenSchema, token: z.string().regex(API_TOKEN_PATTERN) })
  .strict();

export type CreatedApiTokenResponse = z.infer<typeof CreatedApiTokenResponseSchema>;

/**
 * `GET /api/public/v1/whoami` (decision 39; D25 decision 30): who the token
 * is, in camelCase, its claims as `access`, a union on `kind`:
 * - `service_account`: the token's organization, as D22's;
 * - `person` (a personal token, D25): the organization `X-Telflo-Org` named
 *   and the membership check accepted, or null when none was sent.
 */
export const WhoAmIResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      organizationId: uuid,
      tokenName: z.string(),
      access: ApiTokenAccessSchema,
      kind: z.literal("service_account"),
    })
    .strict(),
  z
    .object({
      organizationId: uuid.nullable(),
      tokenName: z.string(),
      access: ApiTokenAccessSchema,
      kind: z.literal("person"),
    })
    .strict(),
]);

export type WhoAmIResponse = z.infer<typeof WhoAmIResponseSchema>;

/**
 * The error codes of the service-account and token routes and of the token
 * check, named once so a misspelled code is a type error (decisions 26-34).
 * A contributor's refusal is the existing `403 organization_admin_required`,
 * another organization's id `404 organization_not_found`, and a blocked
 * address the existing `429 rate_limited`.
 */
export const SERVICE_ACCOUNT_ERROR_CODES = [
  "service_account_not_found",
  "service_account_name_taken",
  "service_account_limit_reached",
  "api_token_not_found",
  "api_token_name_taken",
  "api_token_limit_reached",
  "invalid_api_token",
] as const;

export type ServiceAccountErrorCode = (typeof SERVICE_ACCOUNT_ERROR_CODES)[number];

/** An unknown, deleted or another organization's account, alike. */
export const SERVICE_ACCOUNT_NOT_FOUND_MESSAGE = "Service account not found.";
/** A live account has the name, case aside (decision 27): fixed words, never the name. */
export const SERVICE_ACCOUNT_NAME_TAKEN_MESSAGE = "A service account with this name already exists.";
export const SERVICE_ACCOUNT_LIMIT_REACHED_MESSAGE = `This organization has ${SERVICE_ACCOUNTS_MAXIMUM} service accounts. Delete one first.`;
/** An unknown, another account's or an already revoked token, alike (decision 31). */
export const API_TOKEN_NOT_FOUND_MESSAGE = "Token not found";
export const API_TOKEN_NAME_TAKEN_MESSAGE = "This service account already has a token with this name.";
/** The owner's words (decision 8). */
export const API_TOKEN_LIMIT_REACHED_MESSAGE = `This service account has ${API_TOKENS_LIVE_MAXIMUM} tokens. Revoke one first.`;
/** Every refusal of the token check, with `WWW-Authenticate: Bearer` (decision 34). */
export const INVALID_API_TOKEN_MESSAGE = "Missing or invalid API token";

/** Each code's words, as the API answers them and the web shows them. */
export const SERVICE_ACCOUNT_ERROR_MESSAGES: Readonly<Record<ServiceAccountErrorCode, string>> = {
  service_account_not_found: SERVICE_ACCOUNT_NOT_FOUND_MESSAGE,
  service_account_name_taken: SERVICE_ACCOUNT_NAME_TAKEN_MESSAGE,
  service_account_limit_reached: SERVICE_ACCOUNT_LIMIT_REACHED_MESSAGE,
  api_token_not_found: API_TOKEN_NOT_FOUND_MESSAGE,
  api_token_name_taken: API_TOKEN_NAME_TAKEN_MESSAGE,
  api_token_limit_reached: API_TOKEN_LIMIT_REACHED_MESSAGE,
  invalid_api_token: INVALID_API_TOKEN_MESSAGE,
};
