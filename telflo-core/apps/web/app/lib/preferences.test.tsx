import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type EditorFontSize, type UserPreferences } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { PREFERENCES_FAILED_MESSAGE, PREFERENCES_WRITE_TIMEOUT_MS, preferenceChange, useSavePreference } from "~/lib/preferences.js";
import { numberPreferenceRead, useUserStore } from "~/lib/stores/user-store.js";
import { signedInMember } from "~/test/configurations.js";

/*
 * Saving a preference (D21 decision 33; Preflight ruling 35; Ruling 86's
 * invariant): the confirmed value is always the last one the server is
 * known to hold, the page shows the newest pending choice else that, and a
 * failure shows the confirmed value again. Most cases here start from a
 * confirmed value that differs from the one shown before the click, so
 * "restore what was shown before the click" fails them. After the review's
 * probes P1-P11 (copy of d8079471).
 */

/** A promise answered by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const font = (fontSize: EditorFontSize): UserPreferences => ({
  ...DEFAULT_USER_PREFERENCES,
  editor: { ...DEFAULT_USER_PREFERENCES.editor, fontSize },
});
const shown = () => useUserStore.getState().current?.preferences.editor.fontSize;
const confirmed = () => useUserStore.getState().confirmedPreferences?.editor.fontSize;
const failure = () => new ApiError("internal_error", "Something went wrong.", { status: 500 });

/** Two saves of the font size in a row, each answered by hand. */
function twoSaves(first: EditorFontSize, second: EditorFontSize) {
  const a = held<UserPreferences>();
  const b = held<UserPreferences>();
  vi.spyOn(apiClient, "updatePreferences").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const { result } = renderHook(() => useSavePreference());
  return { a, b, savedA: result.current("editor.fontSize", first), savedB: result.current("editor.fontSize", second) };
}

describe("useSavePreference", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    useUserStore.getState().setCurrent(signedInMember()); // the font size 13, the default
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one key per PATCH", () => {
    expect(preferenceChange("theme", "navy")).toEqual({ theme: "navy" });
    expect(preferenceChange("editor.tabSize", 4)).toEqual({ editor: { tabSize: 4 } });
    expect(preferenceChange("email.productTips", false)).toEqual({ email: { productTips: false } });
  });

  it("two choices answered in reverse: the later stands, the earlier's answer doesn't undo it (P1)", async () => {
    const { a, b, savedA, savedB } = twoSaves(14, 16);
    b.resolve(font(16));
    expect(await savedB).toBe(true);
    a.resolve(font(14));
    expect(await savedA).toBe(false);
    expect([shown(), confirmed()]).toEqual([16, 16]);
  });

  it("two failures in a row restore to the confirmed value, toasting once (P2)", async () => {
    const error = vi.spyOn(toast, "error");
    const { a, b, savedA, savedB } = twoSaves(14, 16);
    a.reject(failure());
    expect(await savedA).toBe(false);
    expect(shown()).toBe(16);
    b.reject(failure());
    expect(await savedB).toBe(false);
    expect([shown(), confirmed()]).toEqual([13, 13]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(PREFERENCES_FAILED_MESSAGE);
  });

  it("an earlier choice failing after the later one's success: the later stands, no toast (P3)", async () => {
    const error = vi.spyOn(toast, "error");
    const { a, b, savedA, savedB } = twoSaves(14, 16);
    b.resolve(font(16));
    await savedB;
    a.reject(failure());
    await savedA;
    expect([shown(), confirmed()]).toEqual([16, 16]);
    expect(error).not.toHaveBeenCalled();
  });

  it("an overtaken answer, then the later choice failing, restores to the overtaken answer's value (P4)", async () => {
    const { a, b, savedA, savedB } = twoSaves(14, 16);
    a.resolve(font(14));
    expect(await savedA).toBe(false);
    // The server holds 14 now; the later choice is still shown.
    expect([shown(), confirmed()]).toEqual([16, 14]);
    b.reject(failure());
    await savedB;
    expect([shown(), confirmed()]).toEqual([14, 14]);
  });

  it("a later choice failing first, then the earlier one's answer: the page shows what the server holds", async () => {
    const { a, b, savedA, savedB } = twoSaves(14, 16);
    b.reject(failure());
    await savedB;
    expect(shown()).toBe(13);
    a.resolve(font(14));
    await savedA;
    expect([shown(), confirmed()]).toEqual([14, 14]);
  });

  it("a /me re-seed between the choice and its answer keeps the choice shown, then the answer confirms it (P5)", async () => {
    const a = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences").mockReturnValueOnce(a.promise);
    const { result } = renderHook(() => useSavePreference());
    const saved = result.current("editor.fontSize", 18);
    useUserStore.getState().setCurrent({ ...signedInMember(), preferences: font(15) });
    expect([shown(), confirmed()]).toEqual([18, 15]);
    a.resolve(font(18));
    expect(await saved).toBe(true);
    expect([shown(), confirmed()]).toEqual([18, 18]);
  });

  it("a re-seed, then a failure, restores to the re-seeded value (P5b)", async () => {
    const a = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences").mockReturnValueOnce(a.promise);
    const { result } = renderHook(() => useSavePreference());
    const saved = result.current("editor.fontSize", 18);
    useUserStore.getState().reseedPreferences(signedInMember().user.id, font(15));
    a.reject(failure());
    await saved;
    expect([shown(), confirmed()]).toEqual([15, 15]);
  });

  it("a stale /me (read before the save) answered after the save's answer doesn't overwrite it (P6, Ruling 86's item 4)", async () => {
    const readBefore = numberPreferenceRead();
    vi.spyOn(apiClient, "updatePreferences").mockResolvedValue(font(18));
    const { result } = renderHook(() => useSavePreference());
    expect(await result.current("editor.fontSize", 18)).toBe(true);

    useUserStore.getState().reseedPreferences(signedInMember().user.id, { ...font(13), theme: "navy" }, readBefore);
    expect([shown(), confirmed()]).toEqual([18, 18]);
    // The read still confirms the keys no save has answered since it was sent.
    expect(useUserStore.getState().current?.preferences.theme).toBe("navy");

    // A read sent after the save's answer is taken: another tab's change.
    useUserStore.getState().reseedPreferences(signedInMember().user.id, font(13), numberPreferenceRead());
    expect([shown(), confirmed()]).toEqual([13, 13]);
  });

  it("signed out meanwhile: neither the answer nor the failure touches the store or toasts (P7)", async () => {
    const error = vi.spyOn(toast, "error");
    const a = held<UserPreferences>();
    const b = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = renderHook(() => useSavePreference());
    const savedFont = result.current("editor.fontSize", 18);
    const savedTheme = result.current("theme", "light");
    useUserStore.getState().clear();
    a.resolve(font(18));
    b.reject(failure());
    expect(await savedFont).toBe(false);
    expect(await savedTheme).toBe(false);
    expect(useUserStore.getState().current).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("the same person signed in again while a save is in flight: its answer, from before, isn't taken (P7b)", async () => {
    const a = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences").mockReturnValueOnce(a.promise);
    const { result } = renderHook(() => useSavePreference());
    const saved = result.current("editor.fontSize", 18);
    useUserStore.getState().clear();
    useUserStore.getState().setCurrent(signedInMember());
    a.resolve(font(18));
    expect(await saved).toBe(false);
    expect([shown(), confirmed()]).toEqual([13, 13]);
  });

  it("another person's seed meanwhile: the failure neither restores nor toasts (P8)", async () => {
    const error = vi.spyOn(toast, "error");
    const a = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences").mockReturnValueOnce(a.promise);
    const { result } = renderHook(() => useSavePreference());
    const saved = result.current("editor.fontSize", 18);
    const other = signedInMember();
    useUserStore.getState().setCurrent({ ...other, user: { ...other.user, id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }, preferences: font(20) });
    a.reject(failure());
    await saved;
    expect([shown(), confirmed()]).toEqual([20, 20]);
    expect(error).not.toHaveBeenCalled();
  });

  it("the 30 s hang guard aborts the save, restores the key and toasts (P9)", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(toast, "error");
    let signal: AbortSignal | undefined;
    vi.spyOn(apiClient, "updatePreferences").mockImplementation((_request, options) => {
      signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ApiError("request_aborted", "The request was aborted.")));
      });
    });
    const { result } = renderHook(() => useSavePreference());
    const saved = result.current("editor.fontSize", 18);
    expect(shown()).toBe(18);

    await act(async () => {
      vi.advanceTimersByTime(PREFERENCES_WRITE_TIMEOUT_MS - 1);
    });
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(await saved).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(PREFERENCES_WRITE_TIMEOUT_MS).toBe(30_000);
    expect([shown(), confirmed()]).toEqual([13, 13]);
    expect(useUserStore.getState().pendingPreferences).toEqual({});
    expect(error).toHaveBeenCalledWith(PREFERENCES_FAILED_MESSAGE);
  });

  it("a session that ended: restored, no toast (P10)", async () => {
    const error = vi.spyOn(toast, "error");
    vi.spyOn(apiClient, "updatePreferences").mockRejectedValue(new ApiError("unauthenticated", "Sign in again."));
    const { result } = renderHook(() => useSavePreference());
    expect(await result.current("theme", "navy")).toBe(false);
    expect(useUserStore.getState().current?.preferences.theme).toBe("dark");
    expect(error).not.toHaveBeenCalled();
  });

  it("writes nothing to browser storage or cookies (P11)", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookie = document.cookie;
    vi.spyOn(apiClient, "updatePreferences").mockResolvedValue({ ...DEFAULT_USER_PREFERENCES, theme: "navy" });
    const { result } = renderHook(() => useSavePreference());
    await result.current("theme", "navy");
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookie);
  });
});
