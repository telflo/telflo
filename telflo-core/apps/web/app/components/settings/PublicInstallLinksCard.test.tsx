import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { DEFAULT_USER_PREFERENCES, type ActiveOrganization, type OrganizationSettings } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import {
  LINKS_TURNED_OFF_MESSAGE,
  LINKS_TURNED_ON_MESSAGE,
  ONLY_AN_ADMIN_WORDS,
  PUBLIC_INSTALL_LINKS_DESCRIPTION,
  PublicInstallLinksCard,
  SETTINGS_CHANGE_FAILED_MESSAGE,
  SETTINGS_LOAD_FAILED_MESSAGE,
} from "./PublicInstallLinksCard.js";

/*
 * Settings → Organization's "Public install links": read for any member,
 * changed by an admin only, not optimistically.
 */

const ADMIN: ActiveOrganization = { id: "00000000-0000-4000-8000-000000000003", name: "Beta Team", type: "group", logoId: null, role: "admin" };
const CONTRIBUTOR: ActiveOrganization = { id: "00000000-0000-4000-8000-000000000004", name: "alpha", type: "group", logoId: null, role: "contributor" };

function seed(active: ActiveOrganization) {
  useUserStore.getState().setCurrent({
    user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
    organization: active,
    organizations: [ADMIN, CONTRIBUTOR],
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: DEFAULT_USER_PREFERENCES,
  });
}

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

const loader = vi.fn(() => null);

function renderCard() {
  // Keyed by the current organization, as the route renders it.
  function Page() {
    const id = useCurrentUser()?.organization.id ?? "";
    return <PublicInstallLinksCard key={id} />;
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

const toggle = () => screen.getByRole("switch", { name: "Public install links" });

beforeEach(() => {
  vi.restoreAllMocks();
  loader.mockClear();
});

describe("PublicInstallLinksCard", () => {
  it("shows an admin the switch, on by default, named and described by the card's words; turning it off sends the PATCH and toasts", async () => {
    seed(ADMIN);
    const get = vi.spyOn(apiClient, "getOrganizationSettings").mockResolvedValue({ publicInstallLinks: true });
    const saved = held<OrganizationSettings>();
    const patch = vi.spyOn(apiClient, "updateOrganizationSettings").mockImplementation(() => saved.promise);
    const success = vi.spyOn(toast, "success");
    const user = renderCard();
    expect(await screen.findByRole("status")).toHaveTextContent("Loading…");
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(get).toHaveBeenCalledWith(ADMIN.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(toggle()).toBeEnabled();
    expect(toggle()).toHaveAccessibleDescription(PUBLIC_INSTALL_LINKS_DESCRIPTION);
    expect(PUBLIC_INSTALL_LINKS_DESCRIPTION).toBe(
      "Quick Deploy links let anyone holding the link download an installer for a fleet without signing in; a Helm values link also carries the fleet's default token. Turn them off to allow only signed-in downloads.",
    );
    expect(screen.queryByText(ONLY_AN_ADMIN_WORDS)).toBeNull();

    await user.click(toggle());
    expect(patch).toHaveBeenCalledWith(ADMIN.id, { publicInstallLinks: false }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // Not optimistic: still on, disabled, until the API answers.
    expect(toggle()).toBeChecked();
    expect(toggle()).toBeDisabled();
    await user.click(toggle());
    expect(patch).toHaveBeenCalledTimes(1);
    await act(async () => saved.resolve({ publicInstallLinks: false }));
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toBeEnabled();
    expect(success).toHaveBeenCalledWith(LINKS_TURNED_OFF_MESSAGE);

    patch.mockResolvedValue({ publicInstallLinks: true });
    await user.click(toggle());
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(success).toHaveBeenLastCalledWith(LINKS_TURNED_ON_MESSAGE);
  });

  it("shows a contributor the switch disabled with Only an admin can change this., its description too; nothing sent", async () => {
    seed(CONTRIBUTOR);
    vi.spyOn(apiClient, "getOrganizationSettings").mockResolvedValue({ publicInstallLinks: false });
    const patch = vi.spyOn(apiClient, "updateOrganizationSettings");
    const user = renderCard();
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(toggle()).toBeDisabled();
    expect(screen.getByText(ONLY_AN_ADMIN_WORDS)).toBeInTheDocument();
    expect(toggle()).toHaveAccessibleDescription(`${PUBLIC_INSTALL_LINKS_DESCRIPTION} ${ONLY_AN_ADMIN_WORDS}`);
    await user.click(toggle());
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps the value on a refused change, toasting the API's words; an admin's role gone revalidates the layout", async () => {
    seed(ADMIN);
    vi.spyOn(apiClient, "getOrganizationSettings").mockResolvedValue({ publicInstallLinks: true });
    const words = "Only an admin can change this organization.";
    vi.spyOn(apiClient, "updateOrganizationSettings").mockRejectedValueOnce(new ApiError("organization_admin_required", words, { status: 403 }));
    const error = vi.spyOn(toast, "error");
    const user = renderCard();
    await waitFor(() => expect(toggle()).toBeChecked());
    const loads = loader.mock.calls.length;
    await user.click(toggle());
    await waitFor(() => expect(error).toHaveBeenCalledWith(words));
    expect(toggle()).toBeChecked();
    await waitFor(() => expect(loader.mock.calls.length).toBeGreaterThan(loads));

    vi.mocked(apiClient.updateOrganizationSettings).mockRejectedValueOnce(new Error("network"));
    await user.click(toggle());
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(SETTINGS_CHANGE_FAILED_MESSAGE));
    expect(toggle()).toBeChecked();
  });

  it('shows a failed read with "Try again", which reads again', async () => {
    seed(ADMIN);
    const get = vi.spyOn(apiClient, "getOrganizationSettings").mockRejectedValueOnce(new Error("network")).mockResolvedValue({ publicInstallLinks: true });
    const user = renderCard();
    expect(await screen.findByText(SETTINGS_LOAD_FAILED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("drops an earlier organization's answer once another is current, reading the new one's", async () => {
    seed(ADMIN);
    const first = held<OrganizationSettings>();
    const get = vi
      .spyOn(apiClient, "getOrganizationSettings")
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ publicInstallLinks: false });
    renderCard();
    await waitFor(() => expect(get).toHaveBeenCalledWith(ADMIN.id, expect.anything()));
    act(() => seed(CONTRIBUTOR));
    await waitFor(() => expect(get).toHaveBeenCalledWith(CONTRIBUTOR.id, expect.anything()));
    await waitFor(() => expect(toggle()).not.toBeChecked());
    await act(async () => first.resolve({ publicInstallLinks: true }));
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toBeDisabled();
  });
});
