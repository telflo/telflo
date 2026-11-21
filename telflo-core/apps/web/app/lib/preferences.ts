import type { UpdateUserPreferencesRequest } from "@telflo/contracts";
import { useCallback } from "react";
import { toast } from "sonner";
import { abortAfter } from "~/lib/abort-after.js";
import { isSessionEnded, updatePreferences } from "~/lib/api-client.js";
import { useUserStore, type PreferenceKey, type PreferenceValues } from "~/lib/stores/user-store.js";

/*
 * Saving a preference from Settings: one key per PATCH, optimistic in the user
 * store, so the shell's theme and every open Monaco follow at once. A refusal
 * or a network failure restores that key and toasts fixed words; a success
 * says nothing. An answer, or a `/me` re-seed, never overwrites a newer choice
 * of the same key (the store's pending markers).
 */

/** Appearance's and Editor's failure. */
export const PREFERENCES_FAILED_MESSAGE = "Failed to update preferences";
/** Notifications' failure. */
export const EMAIL_PREFERENCES_FAILED_MESSAGE = "Failed to update email preferences";

/** The save's hang guard: a request that never answers would keep its key pending. */
export const PREFERENCES_WRITE_TIMEOUT_MS = 30_000;

/** The PATCH's body for one key: `{ theme }`, or its group holding the key alone. */
export function preferenceChange<Key extends PreferenceKey>(key: Key, value: PreferenceValues[Key]): UpdateUserPreferencesRequest {
  if (key === "theme") return { theme: value as PreferenceValues["theme"] };
  const [group, name] = key.split(".") as ["editor" | "email", string];
  return { [group]: { [name]: value } } as UpdateUserPreferencesRequest;
}

/** The fixed words a failed save of `key` toasts. */
export function preferenceFailureMessage(key: PreferenceKey): string {
  return key.startsWith("email.") ? EMAIL_PREFERENCES_FAILED_MESSAGE : PREFERENCES_FAILED_MESSAGE;
}

/**
 * Saves one preference: shows it at once, then PATCHes it. Resolves true
 * when this choice's answer was taken (the key holds what the API stored),
 * false when it failed, was overtaken by a later choice of the same key, or
 * the person is signed out. A failure restores the key and toasts, unless a
 * later choice of the key is pending (it stands) or the session ended (the
 * session-ended handler takes the browser to sign in).
 */
export function useSavePreference(): <Key extends PreferenceKey>(key: Key, value: PreferenceValues[Key]) => Promise<boolean> {
  return useCallback(async <Key extends PreferenceKey>(key: Key, value: PreferenceValues[Key]): Promise<boolean> => {
    const sequence = useUserStore.getState().setPreference(key, value);
    if (sequence === null) return false;
    const guard = abortAfter(PREFERENCES_WRITE_TIMEOUT_MS);
    try {
      const answer = await updatePreferences(preferenceChange(key, value), { signal: guard.signal });
      return useUserStore.getState().takePreferenceAnswer(key, sequence, answer);
    } catch (failure) {
      const restored = useUserStore.getState().restorePreference(key, sequence);
      if (restored && !isSessionEnded(failure)) toast.error(preferenceFailureMessage(key));
      return false;
    } finally {
      guard.clear();
    }
  }, []);
}
