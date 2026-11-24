import { PERSONAL_API_TOKEN_ERROR_CODES } from "@telflo/contracts";
import { useEffect, useMemo, useRef } from "react";
import { ApiError, createPersonalApiToken, revokePersonalApiToken } from "~/lib/api-client.js";
import type { ApiTokenCalls } from "~/lib/api-tokens.js";

/*
 * Settings › Account's "API tokens": the signed-in person's own `tf_` tokens.
 * Every word here is fixed: a token, its prefix and its name are visible text
 * in the masked shell only (the token itself only in the reveal dialog,
 * inside ph-no-capture), never a toast, a title or an attribute.
 */

/** The card's title and its fixed sentences. */
export const PERSONAL_API_TOKENS_TITLE = "API tokens";
export const PERSONAL_API_TOKENS_DESCRIPTION = "Tokens for the Telflo API, the CLI and CI jobs. A token is shown only once when created.";
export const PERSONAL_API_TOKENS_SCOPE_WORDS =
  "A personal token acts as you, with your role, in every organization you belong to: send the organization's id in the X-Telflo-Org header (GET /api/public/v1/orgs lists your organizations and their ids). Organization admins can't see or revoke it.";
export const PERSONAL_API_TOKENS_EMPTY = "No tokens yet.";
/** A failed read of the list, with "Try again". */
export const PERSONAL_API_TOKENS_LOAD_FAILED_MESSAGE = "Failed to load API tokens";

/**
 * The refusals whose message is shown as it is: the personal-token codes
 * (a person's words), a wrong current password, a request the API refused,
 * and a limit's 429.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ...PERSONAL_API_TOKEN_ERROR_CODES,
  "current_password_incorrect",
  "invalid_request",
  "rate_limited",
]);

/** The current password's field, on the create dialog and the CLI's approval page. */
export const CURRENT_PASSWORD_LABEL = "Current password";

/**
 * Whether a create asks the current password: "required" when the account
 * has one, "optional" when that isn't known (the sign-in methods unread: the
 * field shown, never blocking an account without one, the API deciding),
 * and `undefined` for an account without one (OIDC only), which is asked
 * nothing.
 */
export type CurrentPasswordAsk = "required" | "optional" | undefined;

export function currentPasswordAskOf(hasPassword: boolean | undefined): CurrentPasswordAsk {
  if (hasPassword === undefined) return "optional";
  return hasPassword ? "required" : undefined;
}

/** A create refused for its current password: shown under the field, which is emptied; nothing was made. */
export function isCurrentPasswordIncorrect(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "current_password_incorrect";
}

/** Whether a failure is the API refusing with one of those codes. */
export function isPersonalApiTokenRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && REFUSAL_CODES.has(error.code);
}

/** What a failed request says: a refusal's own fixed message, else `fallback`. */
export function personalApiTokenFailureMessage(error: unknown, fallback: string): string {
  return isPersonalApiTokenRefusal(error) ? error.message : fallback;
}

/**
 * The person's own token calls for the token dialogs: no organization in
 * them, so an answer belongs on screen while the card is mounted, and no
 * failure leaves the page.
 */
export function usePersonalApiTokenCalls(): ApiTokenCalls {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useMemo<ApiTokenCalls>(
    () => ({
      create: (request) => createPersonalApiToken(request),
      revoke: (tokenId) => revokePersonalApiToken(tokenId),
      startCall: () => () => mounted.current,
      leaveOn: () => false,
      isRefusal: isPersonalApiTokenRefusal,
      failureMessage: personalApiTokenFailureMessage,
    }),
    [],
  );
}
