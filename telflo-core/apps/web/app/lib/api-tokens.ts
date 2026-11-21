import type { CreateApiTokenRequest, CreatedApiTokenResponse } from "@telflo/contracts";

/*
 * What the token dialogs need of whoever owns the tokens: a service account's
 * (lib/service-accounts.ts' `useServiceAccountTokenCalls`) or the signed-in
 * person's own (lib/personal-api-tokens.ts' `usePersonalApiTokenCalls`). The
 * create and the revoke, whether an answer still belongs on screen, a failure
 * that ends the page's purpose, and the failure words. Every word is fixed: a
 * token, its prefix and its name never reach a toast.
 */
export interface ApiTokenCalls {
  /** The create: its reply is the only one that carries the token. */
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
