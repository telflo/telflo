import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OIDC_LINK_RESULT_CODES } from "@telflo/contracts";
import SettingsAccountRoute from "./settings/account.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { LINK_RESULT_WORDS, SIGN_IN_METHODS_LOAD_FAILED_MESSAGE } from "~/lib/account.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import {
  ACCOUNT_EMAIL,
  IDENTITY_EMAIL,
  LINKED_GOOGLE,
  OTHER_SESSION_IP,
  SESSION_IP,
  renderUnderLayout,
  sessions,
  signInMethods,
  where,
} from "~/test/account.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";

/*
 * Settings › Account (D21 decisions 34, 38 and 45; D25 decision 50's API
 * tokens card last): the cards in order, the
 * Sign-in methods card hidden with no provider and no identity, the link's
 * `?link=<code>` toasted and removed with replace, and the personal data
 * only as text.
 */

function serve(methods = signInMethods()) {
  vi.spyOn(apiClient, "getSignInMethods").mockResolvedValue(methods);
  vi.spyOn(apiClient, "listSessions").mockResolvedValue({ items: sessions(), total: 2 });
  vi.spyOn(apiClient, "getPersonalApiTokens").mockResolvedValue({ items: [] });
}

/** The cards' titles, in the page's order. */
function cardTitles(): string[] {
  return screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent ?? "");
}

describe("Settings › Account", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("shows the cards in order: Account, Change Password, Sign-in methods, Sessions, API tokens", async () => {
    serve();
    renderUnderLayout(SettingsAccountRoute);
    await screen.findByRole("heading", { name: "Sign-in methods" });
    await screen.findByRole("list", { name: "Sessions" });
    expect(cardTitles()).toEqual(["Account", "Change Password", "Sign-in methods", "Sessions", "API tokens"]);
  });

  it("an account with no password gets Set a Password in Change Password's place", async () => {
    serve(signInMethods({ hasPassword: false, identities: [LINKED_GOOGLE] }));
    renderUnderLayout(SettingsAccountRoute);
    await screen.findByRole("heading", { name: "Sign-in methods" });
    expect(cardTitles()).toEqual(["Account", "Set a Password", "Sign-in methods", "Sessions", "API tokens"]);
  });

  it("hidden with no provider and no identity", async () => {
    serve(signInMethods({ providers: [], identities: [] }));
    renderUnderLayout(SettingsAccountRoute);
    await screen.findByRole("heading", { name: "Change Password" });
    expect(screen.queryByRole("heading", { name: "Sign-in methods" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Link / })).not.toBeInTheDocument();
    expect(cardTitles()).toEqual(["Account", "Change Password", "Sessions", "API tokens"]);
  });

  it("a failed read of the sign-in methods says so, and Try again reads again", async () => {
    vi.spyOn(apiClient, "getSignInMethods")
      .mockRejectedValueOnce(new ApiError("internal_error", "Something went wrong.", { status: 500 }))
      .mockResolvedValueOnce(signInMethods());
    vi.spyOn(apiClient, "listSessions").mockResolvedValue({ items: sessions(), total: 2 });
    vi.spyOn(apiClient, "getPersonalApiTokens").mockResolvedValue({ items: [] });
    const user = renderUnderLayout(SettingsAccountRoute);

    const failed = await screen.findByText(SIGN_IN_METHODS_LOAD_FAILED_MESSAGE);
    await user.click(within(failed.parentElement!).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Sign-in methods" })).toBeInTheDocument();
  });

  it("each ?link= code shows its words and is removed with replace", async () => {
    serve();
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");

    for (const code of OIDC_LINK_RESULT_CODES) {
      success.mockClear();
      error.mockClear();
      renderUnderLayout(SettingsAccountRoute, `/settings/account?link=${code}&tab=x`);
      await waitFor(() => expect(where()).toBe("/settings/account?tab=x REPLACE"));
      const words = LINK_RESULT_WORDS[code];
      if (code === "linked") {
        expect(success).toHaveBeenCalledTimes(1);
        expect(success).toHaveBeenCalledWith(words);
        expect(error).not.toHaveBeenCalled();
      } else {
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(words);
        expect(success).not.toHaveBeenCalled();
      }
      cleanup();
    }
    expect(LINK_RESULT_WORDS).toEqual({
      linked: "Google sign-in linked.",
      identity_in_use: "That Google account is already linked to another Telflo account.",
      identity_exists: "Your account already has a Google sign-in.",
      email_unverified: "Google didn't confirm that account's email address.",
      link_failed: "Linking Google didn't work. Try again.",
    });
  });

  it("an unknown ?link= code is removed and shows nothing", async () => {
    serve();
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    renderUnderLayout(SettingsAccountRoute, "/settings/account?link=something_else");
    await waitFor(() => expect(where()).toBe("/settings/account REPLACE"));
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("no email, identity email, IP or browser in an attribute, a URL or a toast", async () => {
    serve(signInMethods({ identities: [LINKED_GOOGLE] }));
    const toasts = [vi.spyOn(toast, "success"), vi.spyOn(toast, "error")];
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderUnderLayout(SettingsAccountRoute, "/settings/account?link=linked");
    await screen.findByRole("list", { name: "Sessions" });
    await screen.findByRole("heading", { name: "Sign-in methods" });

    // Shown as text...
    for (const text of [ACCOUNT_EMAIL, `Linked as ${IDENTITY_EMAIL}`, `IP address ${SESSION_IP}`, `IP address ${OTHER_SESSION_IP}`, "Firefox on macOS", "Chrome on Windows"]) {
      expect(document.body).toHaveTextContent(text);
    }
    // ...and nowhere else: no attribute, no URL, no toast, no storage.
    for (const canary of [ACCOUNT_EMAIL, IDENTITY_EMAIL, SESSION_IP, OTHER_SESSION_IP, "Firefox", "Chrome", "macOS", "Windows"]) {
      expectNoAttributeHolds(canary);
      expect(where()).not.toContain(canary);
      expect(window.location.href).not.toContain(canary);
      for (const spy of toasts) expect(JSON.stringify(spy.mock.calls)).not.toContain(canary);
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(document.title).not.toContain(ACCOUNT_EMAIL);
  });
});
