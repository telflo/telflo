import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ProductAdminSettings } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import {
  ORGANIZATION_CREATION_CHANGE_FAILED_MESSAGE,
  ORGANIZATION_CREATION_DESCRIPTION,
  ORGANIZATION_CREATION_LOAD_FAILED_MESSAGE,
  ORGANIZATION_CREATION_OPEN_TOAST,
  ORGANIZATION_CREATION_RESTRICTED_TOAST,
  OrganizationCreationSetting,
} from "./OrganizationCreationSetting.js";

/*
 * The product admins' switch, "Only product admins can create organizations"
 * (on by default): read from the API, changed through the PATCH, not
 * optimistically, with fixed-word toasts.
 */

/** A promise answered by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function renderSetting() {
  const Stub = createRoutesStub([
    { path: "/product-admin/product-admins", Component: OrganizationCreationSetting },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/product-admin/product-admins"]} />);
  return userEvent.setup();
}

const toggle = () => screen.getByRole("switch", { name: "Only product admins can create organizations" });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OrganizationCreationSetting", () => {
  it("reads the switch off when the API says everyone, named and described by its words; turning it on sends the PATCH, not optimistically, and toasts; off again too", async () => {
    vi.spyOn(apiClient, "getProductAdminSettings").mockResolvedValue({ organizationCreation: "everyone" });
    const saved = held<ProductAdminSettings>();
    const patch = vi.spyOn(apiClient, "updateProductAdminSettings").mockImplementation(() => saved.promise);
    const success = vi.spyOn(toast, "success");
    const user = renderSetting();
    expect(await screen.findByRole("status")).toHaveTextContent("Loading…");
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(toggle()).toHaveAccessibleDescription(ORGANIZATION_CREATION_DESCRIPTION);
    expect(ORGANIZATION_CREATION_DESCRIPTION).toContain(
      "Invite-only means someone already on the site has to invite you. With this off, anyone with an account can create an organization and invite people into it. Turn it on to keep that to product admins.",
    );

    await user.click(toggle());
    expect(patch).toHaveBeenCalledWith({ organizationCreation: "product-admins" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toBeDisabled();
    await act(async () => saved.resolve({ organizationCreation: "product-admins" }));
    expect(toggle()).toBeChecked();
    expect(toggle()).toBeEnabled();
    expect(success).toHaveBeenCalledWith(ORGANIZATION_CREATION_RESTRICTED_TOAST);

    patch.mockResolvedValue({ organizationCreation: "everyone" });
    await user.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(patch).toHaveBeenLastCalledWith({ organizationCreation: "everyone" }, expect.anything());
    expect(success).toHaveBeenLastCalledWith(ORGANIZATION_CREATION_OPEN_TOAST);
  });

  it("keeps the value on a failed change, toasting the API's words or its own", async () => {
    vi.spyOn(apiClient, "getProductAdminSettings").mockResolvedValue({ organizationCreation: "product-admins" });
    const patch = vi
      .spyOn(apiClient, "updateProductAdminSettings")
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many requests. Try again later.", { status: 429 }))
      .mockRejectedValueOnce(new Error(""));
    const error = vi.spyOn(toast, "error");
    const user = renderSetting();
    await waitFor(() => expect(toggle()).toBeChecked());
    await user.click(toggle());
    await waitFor(() => expect(error).toHaveBeenCalledWith("Too many requests. Try again later."));
    expect(toggle()).toBeChecked();
    await user.click(toggle());
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(ORGANIZATION_CREATION_CHANGE_FAILED_MESSAGE));
    expect(toggle()).toBeChecked();
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("goes to /app on product_admin_required, as the other product-admin pages", async () => {
    vi.spyOn(apiClient, "getProductAdminSettings").mockResolvedValue({ organizationCreation: "everyone" });
    vi.spyOn(apiClient, "updateProductAdminSettings").mockRejectedValue(
      new ApiError("product_admin_required", "Only a product admin can do that.", { status: 403 }),
    );
    const user = renderSetting();
    await waitFor(() => expect(toggle()).not.toBeChecked());
    await user.click(toggle());
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
  });

  it('shows a failed read with "Try again", which reads again', async () => {
    const get = vi
      .spyOn(apiClient, "getProductAdminSettings")
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ organizationCreation: "everyone" });
    const user = renderSetting();
    expect(await screen.findByText(ORGANIZATION_CREATION_LOAD_FAILED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(get).toHaveBeenCalledTimes(2);
  });
});
