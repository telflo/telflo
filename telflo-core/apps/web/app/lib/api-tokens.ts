import { useEffect, useState } from "react";
import type { CreateApiTokenRequest, CreatedApiTokenResponse } from "@telflo/contracts";
import { ApiError, getSignInMethods } from "~/lib/api-client.js";

/*
 * What the token dialogs need of whoever owns the tokens: a service account's
 * (lib/service-accounts.ts' `useServiceAccountTokenCalls`) or the signed-in
 * person's own (lib/personal-api-tokens.ts' `usePersonalApiTokenCalls`). The
 * create and the revoke, whether an answer still belongs on screen, a failure
 * that ends the page's purpose, and the failure words. Every word is fixed: a
 * token, its prefix and its name never reach a toast.
 */
export interface ApiTokenCalls {
  /** The create, with the signed-in person's current password when asked: its reply is the only one that carries the token. */
  create(request: CreateApiTokenRequest): Promise<CreatedApiTokenResponse>;
  /** The revoke (204). */
  revoke(tokenId: string): Promise<undefined>;
  /** Starts a call: the function answers whether its answer, when it comes, still belongs on screen. */
  startCall(): () => boolean;
  /** A failure the page leaves on (a service account's management lost): `close` called and true; else false. */
  leaveOn(failure: unknown, close: () => void): boolean;
  /** Whether a failure is the API refusing with a fixed message (so a create made nothing). */
  isRefusal(failure: unknown): boolean;
  /** What a failure toasts: a refusal's own fixed message, else `fallback`. */
  failureMessage(failure: unknown, fallback: string): string;
}

/** The current password's field, on the create dialog (a person's own token or a service account's) and the CLI's approval page. */
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

/**
 * Whether the signed-in person's account has a password, read when `enabled`
 * (a dialog opened): undefined until read, and if the read fails (the field
 * then shown without blocking, the API deciding).
 */
export function useAccountHasPassword(enabled: boolean): boolean | undefined {
  const [hasPassword, setHasPassword] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getSignInMethods({ signal: controller.signal }).then(
      (methods) => setHasPassword(methods.hasPassword),
      () => undefined,
    );
    return () => controller.abort();
  }, [enabled]);
  return hasPassword;
}
