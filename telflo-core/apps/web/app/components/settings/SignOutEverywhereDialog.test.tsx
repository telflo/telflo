import { renderHook, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Analytics from "~/lib/analytics.js";
import { SessionsCard } from "./SessionsCard.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { SIGN_OUT_EVERYWHERE_FAILED_MESSAGE, SIGNED_OUT_EVERYWHERE_MESSAGE } from "~/lib/account.js";
import * as orgVariables from "~/lib/org-variables.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { rememberTheme, useRememberedTheme } from "~/lib/theme.js";
import * as variableGroupDisplay from "~/lib/variable-group-display.js";
import { ACCOUNT_EMAIL, held, renderUnderLayout, sessions, where } from "~/test/account.js";

/*
 * "Sign out everywhere" (D21 decision 40, Preflight ruling 38): decision
 * 40's confirm, the existing DELETE, then Logout's clean-up (the handler
 * suspended until the requests in flight settle, every store cleared,
 * PostHog reset; the remembered theme kept), its toast and /login.
 */

// PostHog's reset, watched at the analytics module's boundary.
const analytics = vi.hoisted(() => ({ signedOutLocally: vi.fn() }));
vi.mock("~/lib/analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Analytics>()),
  signedOutLocally: analytics.signedOutLocally,
}));

async function openConfirm() {
  // A staged playground edit in this browser (D31-1 decision 36): signing out removes it (Q211).
  window.localStorage.setItem("telflo-playground-staged-edit", JSON.stringify({ version: 1 }));
  vi.spyOn(apiClient, "listSessions").mockResolvedValue({ items: sessions(), total: 2 });
  const user = renderUnderLayout(SessionsCard);
  await screen.findByRole("list", { name: "Sessions" });
  await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign out everywhere?" });
  return { user, dialog };
}

describe("SignOutEverywhereDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    analytics.signedOutLocally.mockReset();
    useUserStore.getState().clear();
  });

  it("confirms with decision 40's words, and Cancel does nothing", async () => {
    const deleteAllSessions = vi.spyOn(apiClient, "deleteAllSessions");
    const { user, dialog } = await openConfirm();
    expect(within(dialog).getByText("This signs you out of Telflo in every browser, this one included.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteAllSessions).not.toHaveBeenCalled();
    expect(useUserStore.getState().current?.user.email).toBe(ACCOUNT_EMAIL);
  });

  it("Sign out everywhere confirms, signs out, clears like Logout and goes to /login", async () => {
    const answer = held<undefined>();
    const deleteAllSessions = vi.spyOn(apiClient, "deleteAllSessions").mockReturnValue(answer.promise);
    const release = vi.fn();
    const suspend = vi.spyOn(apiClient, "suspendSessionEndedHandler").mockReturnValue(release);
    const editorReset = vi.spyOn(useEditorStore.getState(), "reset");
    const testingReset = vi.spyOn(useTestingStore.getState(), "reset");
    const suitesReset = vi.spyOn(useTestSuitesStore.getState(), "reset");
    const pipelinesReset = vi.spyOn(useValidationPipelinesStore.getState(), "reset");
    const forgetVariables = vi.spyOn(orgVariables, "forgetOrgVariableNames");
    const forgetGroups = vi.spyOn(variableGroupDisplay, "forgetVariableGroupNames");
    const success = vi.spyOn(toast, "success");
    act(() => rememberTheme("navy"));
    const { user, dialog } = await openConfirm();

    await user.click(within(dialog).getByRole("button", { name: "Sign out everywhere" }));
    expect(deleteAllSessions).toHaveBeenCalledTimes(1);
    // The handler is suspended before the request goes, and nothing is cleared yet.
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend.mock.invocationCallOrder[0]!).toBeLessThan(deleteAllSessions.mock.invocationCallOrder[0]!);
    expect(useUserStore.getState().current).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Sign out everywhere" })).toBeDisabled();

    answer.resolve(undefined);
    expect(await screen.findByText("landed on /login")).toBeInTheDocument();
    expect(useUserStore.getState().current).toBeNull();
    for (const reset of [editorReset, testingReset, suitesReset, pipelinesReset, forgetVariables, forgetGroups]) {
      expect(reset).toHaveBeenCalledTimes(1);
    }
    expect(analytics.signedOutLocally).toHaveBeenCalledTimes(1);
    // The staged playground edit went with the session (Q211, Ruling 317).
    expect(window.localStorage.getItem("telflo-playground-staged-edit") !== null).toBe(false);
    expect(success).toHaveBeenCalledWith(SIGNED_OUT_EVERYWHERE_MESSAGE);
    expect(SIGNED_OUT_EVERYWHERE_MESSAGE).toBe("Signed out everywhere");
    expect(where()).toBe("/login PUSH");
    // Released once the requests in flight at the sign-out have settled.
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    // The remembered theme stays for the auth screens.
    expect(renderHook(() => useRememberedTheme()).result.current).toBe("navy");
  });

  it("a failure leaves the session and the stores, releases the handler at once, and toasts fixed words", async () => {
    vi.spyOn(apiClient, "deleteAllSessions").mockRejectedValue(new ApiError("internal_error", "Something went wrong.", { status: 500 }));
    const release = vi.fn();
    vi.spyOn(apiClient, "suspendSessionEndedHandler").mockReturnValue(release);
    const error = vi.spyOn(toast, "error");
    const { user, dialog } = await openConfirm();

    await user.click(within(dialog).getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(SIGN_OUT_EVERYWHERE_FAILED_MESSAGE));
    expect(release).toHaveBeenCalledTimes(1);
    expect(useUserStore.getState().current?.user.email).toBe(ACCOUNT_EMAIL);
    expect(analytics.signedOutLocally).not.toHaveBeenCalled();
    // Still signed in: the staged edit stays.
    expect(window.localStorage.getItem("telflo-playground-staged-edit") !== null).toBe(true);
    expect(screen.queryByText("landed on /login")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sign out everywhere" })).toBeEnabled();
  });
});
