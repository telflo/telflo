import { SERVICE_ACCOUNT_ERROR_CODES, type ServiceAccountErrorCode } from "@telflo/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, createApiToken, isSessionEnded, revokeApiToken } from "~/lib/api-client.js";
import type { ApiTokenCalls } from "~/lib/api-tokens.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { isManagementLost, useLeaveManagement } from "~/lib/organizations.js";

/*
 * Settings › Service Accounts' words and reads. Every toast and failure is
 * fixed words: a service account's name and address, a token's name, the token
 * and its prefix are visible text in the masked shell only, never in a toast,
 * a title, an attribute or a URL.
 */

/** The failure toasts. */
export const SERVICE_ACCOUNTS_LOAD_FAILED_MESSAGE = "Failed to load service accounts";
export const SERVICE_ACCOUNT_LOAD_FAILED_MESSAGE = "Failed to load service account";
export const SERVICE_ACCOUNT_CREATE_FAILED_MESSAGE = "Failed to create service account";
export const SERVICE_ACCOUNT_RENAME_FAILED_MESSAGE = "Failed to rename";
export const SERVICE_ACCOUNT_DELETE_FAILED_MESSAGE = "Failed to delete service account";
export const API_TOKEN_CREATE_FAILED_MESSAGE = "Failed to create token";
/** A revoke's failure, in revoke's word. */
export const API_TOKEN_REVOKE_FAILED_MESSAGE = "Failed to revoke token";
/** The list read when the reveal closes, failed: the token was made and stays. */
export const API_TOKENS_REFRESH_FAILED_MESSAGE = "Token created, but the list could not refresh";

/** A failed first read says so, rather than showing the empty state. */
export const SERVICE_ACCOUNTS_UNREADABLE = "Service accounts could not be loaded.";
export const SERVICE_ACCOUNT_UNREADABLE = "The service account could not be loaded.";

/** The successes: fixed words, never a name. */
export const SERVICE_ACCOUNT_CREATED_MESSAGE = "Service account created";
export const SERVICE_ACCOUNT_RENAMED_MESSAGE = "Service account renamed";
export const SERVICE_ACCOUNT_DELETED_MESSAGE = "Service account deleted";
export const API_TOKEN_REVOKED_MESSAGE = "Token revoked";

/** The reveal's sentence. */
export const API_TOKEN_REVEAL_WORDS = "This is the only time you'll see it. If you lose it, revoke this token and create a new one.";

/** The delete dialog's kept-work sentence (only configurations and their versions show a creator). */
export const SERVICE_ACCOUNT_DELETE_KEPT_WORDS =
  "Configurations, configuration versions, validation pipelines and rules, and test suites and runs it created are kept; configurations and their versions still show its address as their creator.";
export const SERVICE_ACCOUNT_DELETE_CONFIRM_WORDS = "This cannot be undone. Type the account's name to confirm.";

/**
 * The delete dialog's token sentence by the listed count, never "Its 1
 * tokens" or "Its 0 tokens".
 */
export function serviceAccountDeleteTokenWords(tokenCount: number): string {
  if (tokenCount === 0) return "It will be removed from this organization.";
  if (tokenCount === 1) return "Its token will stop working immediately, and it will be removed from this organization.";
  return `Its ${tokenCount} tokens will stop working immediately, and it will be removed from this organization.`;
}

/**
 * A date as the pages show it ("Oct 23, 2026", en-US in the browser's time
 * zone), or "Never"
 * for none (an expiry, a last use).
 */
export function formatServiceAccountDate(iso: string | null): string {
  if (iso === null) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A token's prefix as listed: `tf_AbC12xYz…`. */
export function listedPrefix(prefix: string): string {
  return `${prefix}…`;
}

/**
 * The refusals whose message is toasted as it is: the service-account and
 * token codes, a request the API refused (`invalid_request`) and a limit's
 * 429. Their messages are fixed words.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ...SERVICE_ACCOUNT_ERROR_CODES,
  "current_password_incorrect",
  "invalid_request",
  "rate_limited",
]);

/** Whether a failure is the API refusing with one of those codes. */
export function isServiceAccountRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && REFUSAL_CODES.has(error.code);
}

/** Whether `error` is the API refusing with `code`. */
export function isServiceAccountError(error: unknown, code: ServiceAccountErrorCode): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

/** What a failed request says: a refusal's own fixed message, else `fallback`. */
export function serviceAccountFailureMessage(error: unknown, fallback: string): string {
  return isServiceAccountRefusal(error) ? error.message : fallback;
}

/** The pages' reads' hang guard, as the Account page's. */
export const SERVICE_ACCOUNT_READ_TIMEOUT_MS = 10_000;

export type ServiceAccountRead<Value> =
  | { kind: "loading" }
  | { kind: "failed" }
  /** `404 service_account_not_found` (the detail page's "Service account not found."). */
  | { kind: "not_found" }
  | { kind: "read"; value: Value };

/**
 * A page's read, at mount and again on `reload`, under the hang guard. A
 * later read wins over an earlier one's late answer, and an unmounted page
 * takes none (the pages are keyed by the organization and the account, so
 * an answer for an account no longer shown lands nowhere).
 *
 * - A refusal saying management is lost (a demotion, a switch in another
 *   tab: `organization_admin_required`, `organization_not_found`) leaves the
 *   page through `useLeaveManagement`.
 * - A session that ended says nothing: the session-ended handler has it.
 * - `service_account_not_found` is the not-found state.
 * - Anything else toasts (`failedMessage`, or a reload's own words) and,
 *   on the first read, shows the failed state; a failed reload keeps what
 *   is shown.
 *
 * `load` must keep its identity while the page is shown.
 */
export function useServiceAccountRead<Value>(
  load: (signal: AbortSignal) => Promise<Value>,
  failedMessage: string,
): { read: ServiceAccountRead<Value>; reload: (failureWords?: string) => void } {
  const [read, setRead] = useState<ServiceAccountRead<Value>>({ kind: "loading" });
  const reads = useRef(0);
  const leaveManagement = useLeaveManagement();
  const left = useRef(false);

  const run = useCallback(
    async (failureWords: string) => {
      const number = ++reads.current;
      const guard = abortAfter(SERVICE_ACCOUNT_READ_TIMEOUT_MS);
      try {
        const value = await load(guard.signal);
        if (number === reads.current) setRead({ kind: "read", value });
      } catch (failure) {
        if (number !== reads.current || isSessionEnded(failure)) return;
        if (isManagementLost(failure)) {
          if (!left.current) {
            left.current = true;
            leaveManagement(failure);
          }
          return;
        }
        if (isServiceAccountError(failure, "service_account_not_found")) {
          setRead({ kind: "not_found" });
          return;
        }
        toast.error(serviceAccountFailureMessage(failure, failureWords));
        setRead((shown) => (shown.kind === "read" ? shown : { kind: "failed" }));
      } finally {
        guard.clear();
      }
    },
    [load, leaveManagement],
  );

  useEffect(() => {
    void run(failedMessage);
    return () => {
      // Unmounted: a late answer is dropped.
      reads.current += 1;
    };
  }, [run, failedMessage]);

  const reload = useCallback((failureWords?: string) => void run(failureWords ?? failedMessage), [run, failedMessage]);
  return { read, reload };
}

/**
 * A service account's token calls for the token dialogs: the account's create
 * and revoke in the organization; an answer belongs on screen while that
 * organization is still the active one; a refusal saying management is lost
 * leaves the page through `useLeaveManagement`; the service-account words.
 */
export function useServiceAccountTokenCalls(organizationId: string, serviceAccountId: string): ApiTokenCalls {
  const leaveManagement = useLeaveManagement();
  const isStillCurrent = useStillCurrent(organizationId);
  return useMemo<ApiTokenCalls>(
    () => ({
      create: (request) => createApiToken(organizationId, serviceAccountId, request),
      revoke: (tokenId) => revokeApiToken(organizationId, serviceAccountId, tokenId),
      startCall: () => {
        const sentIn = organizationId;
        return () => isStillCurrent(sentIn);
      },
      leaveOn: (failure, close) => {
        if (!isManagementLost(failure)) return false;
        close();
        leaveManagement(failure);
        return true;
      },
      isRefusal: isServiceAccountRefusal,
      failureMessage: serviceAccountFailureMessage,
    }),
    [organizationId, serviceAccountId, isStillCurrent, leaveManagement],
  );
}
