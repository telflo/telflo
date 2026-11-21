import {
  ACCOUNT_ERROR_CODES,
  OIDC_LINK_RESULT_CODES,
  PASSWORD_MINIMUM_LENGTH,
  type AccountErrorCode,
  type AccountSession,
  type OidcLinkResultCode,
  type SessionBrowser,
  type SessionSystem,
} from "@telflo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded } from "~/lib/api-client.js";

/*
 * The Account page's words: fixed sentences only. Personal data (the email,
 * a linked identity's email, a session's IP, its browser and system and its
 * times) is visible text in the masked shell, never in a toast, a title, an
 * attribute or a URL.
 */

/** The browser families as the Sessions card words them. */
export const BROWSER_WORDS: Readonly<Record<SessionBrowser, string>> = {
  firefox: "Firefox",
  chrome: "Chrome",
  edge: "Edge",
  safari: "Safari",
  opera: "Opera",
  other: "Unknown browser",
};

/** The system families as the Sessions card words them. */
export const SYSTEM_WORDS: Readonly<Record<SessionSystem, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  chromeos: "ChromeOS",
  other: "unknown system",
};

/** A session's row title: "Firefox on macOS", "Unknown browser on unknown system". */
export function sessionTitle(session: Pick<AccountSession, "browser" | "os">): string {
  return `${BROWSER_WORDS[session.browser]} on ${SYSTEM_WORDS[session.os]}`;
}

/** What `/settings/account?link=<code>` shows: `linked` a success, the rest errors. */
export const LINK_RESULT_WORDS: Readonly<Record<OidcLinkResultCode, string>> = {
  linked: "Google sign-in linked.",
  identity_in_use: "That Google account is already linked to another Telflo account.",
  identity_exists: "Your account already has a Google sign-in.",
  email_unverified: "Google didn't confirm that account's email address.",
  link_failed: "Linking Google didn't work. Try again.",
};

/** Whether a `?link=` value is one of the result codes. Anything else shows nothing. */
export function isLinkResultCode(value: string): value is OidcLinkResultCode {
  return (OIDC_LINK_RESULT_CODES as readonly string[]).includes(value);
}

/** Change Password's words. */
export const PASSWORDS_DO_NOT_MATCH_MESSAGE = "Passwords do not match";
export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${PASSWORD_MINIMUM_LENGTH} characters`;
/**
 * The API's longest password, the contracts' `PASSWORD_MAXIMUM_LENGTH`
 * (`shared.ts`), which the package doesn't export; a test holds the two
 * equal through `ChangePasswordRequestSchema`.
 */
export const NEW_PASSWORD_MAXIMUM_LENGTH = 128;
export const PASSWORD_TOO_LONG_MESSAGE = `Password must be at most ${NEW_PASSWORD_MAXIMUM_LENGTH} characters`;
export const PASSWORD_UPDATED_MESSAGE = "Password updated successfully";
export const PASSWORD_UPDATE_FAILED_MESSAGE = "Failed to update password";

/** Set a Password's words. */
export const SET_PASSWORD_DESCRIPTION = "Your account signs in with Google. We'll email you a link to set a password.";
export const SET_PASSWORD_FAILED_MESSAGE = "Failed to send the link";

/** The sentence after the link was asked for, the email as visible text. */
export function setPasswordSentWords(email: string): string {
  return `We sent a link to ${email}. Open it to set your password. Setting it signs you out on every device.`;
}

/** Sign-in methods' words. */
export const SIGN_IN_METHODS_LOAD_FAILED_MESSAGE = "Failed to load sign-in methods";
export const LINK_START_FAILED_MESSAGE = LINK_RESULT_WORDS.link_failed;
export const UNLINK_FAILED_MESSAGE = "Failed to remove the sign-in";

/** Sessions' words. */
export const SESSIONS_LOAD_FAILED_MESSAGE = "Failed to load sessions";
export const SESSION_SIGNED_OUT_MESSAGE = "Session signed out.";
export const SESSION_SIGN_OUT_FAILED_MESSAGE = "Failed to sign out the session";
export const SIGNED_OUT_EVERYWHERE_MESSAGE = "Signed out everywhere";
export const SIGN_OUT_EVERYWHERE_FAILED_MESSAGE = "Failed to sign out everywhere";

/** The account routes' refusals, and a limit's 429: their messages are fixed words. */
const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set<string>([...ACCOUNT_ERROR_CODES, "rate_limited"]);

/** Whether `error` is the API refusing with `code`. */
export function isAccountRefusal(error: unknown, code: AccountErrorCode): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

/**
 * What a failed account request says: an account refusal's or a limit's
 * own fixed message, else `fallback` (no connection, a server error, a
 * drifted reply).
 */
export function accountFailureMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && ACCOUNT_REFUSALS.has(error.code) ? error.message : fallback;
}

/** A link start's failure: a provider that can't be reached says the link's own words. */
export function linkStartFailureMessage(error: unknown): string {
  return isAccountRefusal(error, "provider_unavailable") ? LINK_START_FAILED_MESSAGE : accountFailureMessage(error, LINK_START_FAILED_MESSAGE);
}

/** The Account page's reads' hang guard, as the fleet screens' (`FLEET_READ_TIMEOUT_MS`). */
export const ACCOUNT_READ_TIMEOUT_MS = 10_000;

export type AccountRead<Value> = { kind: "loading" } | { kind: "failed" } | { kind: "read"; value: Value };

/**
 * A read for an Account card, at mount and again on `reload`, under the
 * hang guard. A later read wins over an earlier one's late answer, and an
 * unmounted card takes none. A reload keeps what is shown until it answers
 * (a failed read shows "loading" again). A session that ended says nothing:
 * the session-ended handler takes the browser to sign in. `load` must keep
 * its identity (a module function).
 */
export function useAccountRead<Value>(load: (signal: AbortSignal) => Promise<Value>): {
  read: AccountRead<Value>;
  reload: () => void;
} {
  const [read, setRead] = useState<AccountRead<Value>>({ kind: "loading" });
  const reads = useRef(0);

  const run = useCallback(async () => {
    const number = ++reads.current;
    setRead((shown) => (shown.kind === "failed" ? { kind: "loading" } : shown));
    const guard = abortAfter(ACCOUNT_READ_TIMEOUT_MS);
    try {
      const value = await load(guard.signal);
      if (number === reads.current) setRead({ kind: "read", value });
    } catch (failure) {
      if (number !== reads.current || isSessionEnded(failure)) return;
      setRead({ kind: "failed" });
    } finally {
      guard.clear();
    }
  }, [load]);

  useEffect(() => {
    void run();
    return () => {
      // Unmounted: a late answer is dropped.
      reads.current += 1;
    };
  }, [run]);

  const reload = useCallback(() => void run(), [run]);
  return { read, reload };
}
