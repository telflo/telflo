import { API_TOKENS_LIVE_MAXIMUM, API_TOKEN_NOT_FOUND_MESSAGE, type ServiceAccountErrorCode } from "./service-accounts.js";

/**
 * A person's own API tokens (D25 decisions 3, 27-29 and 50; Preflight
 * ruling 14), on their Account page, beside D21's account routes:
 *
 *   GET    /api/v1/auth/me/api-tokens             → ApiTokensResponseSchema
 *   POST   /api/v1/auth/me/api-tokens             CreateApiTokenRequestSchema → 201 CreatedApiTokenResponseSchema (no-store)
 *   DELETE /api/v1/auth/me/api-tokens/{tokenId}   → 204 (a revoke)
 *
 * The shapes are D22's (service-accounts.ts): a token as listed (its prefix,
 * never the token), the create's request, and the create's reply, the only
 * place a personal token crosses the API. A personal token acts as its
 * person in every organization they belong to, named per request by
 * `X-Telflo-Org`; only its person lists or revokes it.
 *
 * The refusals are D22's `api_token_*` codes with a person's words: never a
 * token, its prefix or its name.
 */

/** The codes the personal-token routes answer (D22's, Preflight ruling 14). */
export const PERSONAL_API_TOKEN_ERROR_CODES = [
  "api_token_not_found",
  "api_token_name_taken",
  "api_token_limit_reached",
] as const satisfies readonly ServiceAccountErrorCode[];

export type PersonalApiTokenErrorCode = (typeof PERSONAL_API_TOKEN_ERROR_CODES)[number];

/** A person may hold this many live tokens (decision 27): D22's number for an account. */
export const PERSONAL_API_TOKENS_LIVE_MAXIMUM = API_TOKENS_LIVE_MAXIMUM;

/** A token of the person's not yet revoked, expired ones included, has the name, case aside. */
export const PERSONAL_API_TOKEN_NAME_TAKEN_MESSAGE = "You already have a token with this name.";
/** The person already has 20 live tokens. */
export const PERSONAL_API_TOKEN_LIMIT_REACHED_MESSAGE = `You have ${PERSONAL_API_TOKENS_LIVE_MAXIMUM} tokens. Revoke one first.`;

/** Each code's words for a person, as the API answers them and the web shows them. */
export const PERSONAL_API_TOKEN_ERROR_MESSAGES: Readonly<Record<PersonalApiTokenErrorCode, string>> = {
  api_token_not_found: API_TOKEN_NOT_FOUND_MESSAGE,
  api_token_name_taken: PERSONAL_API_TOKEN_NAME_TAKEN_MESSAGE,
  api_token_limit_reached: PERSONAL_API_TOKEN_LIMIT_REACHED_MESSAGE,
};
