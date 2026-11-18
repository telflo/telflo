import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet, createRoutesStub } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type EmailPreferences, type UserPreferences } from "@telflo/contracts";
import { EmailNotificationsSection } from "./EmailNotificationsSection.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { EMAIL_PREFERENCES_FAILED_MESSAGE } from "~/lib/preferences.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import { signedInMember } from "~/test/configurations.js";

/*
 * Settings › Notifications (D21 decisions 13, 32 and 33): its words; each
 * switch saves its own key under `email`, optimistically; a failure
 * restores it and toasts.
 */

function withEmail(email: Partial<EmailPreferences>): UserPreferences {
  return { ...DEFAULT_USER_PREFERENCES, email: { ...DEFAULT_USER_PREFERENCES.email, ...email } };
}

/** Notifications under the signed-in layout, the store seeded as the layout's effect does. */
async function renderNotifications(email: Partial<EmailPreferences> = {}) {
  const member = { ...signedInMember(), preferences: withEmail(email) };
  useUserStore.getState().setCurrent(member);
  const Stub = createRoutesStub([
    {
      id: "routes/app-layout",
      Component: Outlet,
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser: member }),
      HydrateFallback: () => null,
      children: [{ path: "/settings/notifications", Component: EmailNotificationsSection }],
    },
  ]);
  render(<Stub initialEntries={["/settings/notifications"]} />);
  await screen.findByRole("heading", { name: "Email Notifications" });
  return userEvent.setup();
}

const productUpdates = () => screen.getByRole("switch", { name: "Product updates" });
const productTips = () => screen.getByRole("switch", { name: "Product tips" });
const shown = () => useUserStore.getState().current?.preferences.email;

describe("EmailNotificationsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("shows its words and the person's choices, both on by default", async () => {
    await renderNotifications();
    expect(screen.getByText("Choose which emails you'd like to receive from Telflo")).toBeInTheDocument();
    expect(productUpdates()).toBeChecked();
    expect(productUpdates()).toHaveAccessibleDescription("New features, improvements, and fixes when we release a new version");
    expect(productTips()).toBeChecked();
    expect(productTips()).toHaveAccessibleDescription("Helpful tips and reminders to get the most out of Telflo");
  });

  it("each switch saves its own key", async () => {
    const updatePreferences = vi
      .spyOn(apiClient, "updatePreferences")
      .mockImplementation((request) => Promise.resolve(withEmail({ ...shown(), ...request.email } as EmailPreferences)));
    const success = vi.spyOn(toast, "success");
    const user = await renderNotifications({ productTips: false });

    await user.click(productUpdates());
    expect(productUpdates()).not.toBeChecked();
    await user.click(productTips());
    expect(productTips()).toBeChecked();

    expect(updatePreferences.mock.calls.map(([request]) => request)).toEqual([
      { email: { productUpdates: false } },
      { email: { productTips: true } },
    ]);
    await waitFor(() => expect(useUserStore.getState().pendingPreferences).toEqual({}));
    expect(shown()).toEqual({ productUpdates: false, productTips: true });
    expect(success).not.toHaveBeenCalled();
  });

  it('a failure toasts "Failed to update email preferences"', async () => {
    vi.spyOn(apiClient, "updatePreferences").mockRejectedValue(new ApiError("invalid_request", "The request is invalid."));
    const error = vi.spyOn(toast, "error");
    const user = await renderNotifications();

    await user.click(productTips());
    await waitFor(() => expect(error).toHaveBeenCalledWith(EMAIL_PREFERENCES_FAILED_MESSAGE));
    expect(EMAIL_PREFERENCES_FAILED_MESSAGE).toBe("Failed to update email preferences");
    expect(error).toHaveBeenCalledTimes(1);
    expect(productTips()).toBeChecked();
    expect(productUpdates()).toBeChecked();
    expect(shown()).toEqual(DEFAULT_USER_PREFERENCES.email);
  });

  it("a session that ended restores the key and leaves the toast to the sign-in", async () => {
    vi.spyOn(apiClient, "updatePreferences").mockRejectedValue(new ApiError("unauthenticated", "Sign in again."));
    const error = vi.spyOn(toast, "error");
    const user = await renderNotifications();

    await user.click(productUpdates());
    await waitFor(() => expect(productUpdates()).toBeChecked());
    expect(useUserStore.getState().pendingPreferences).toEqual({});
    expect(error).not.toHaveBeenCalled();
  });
});
