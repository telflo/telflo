import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { ChangeRoleDialog } from "./ChangeRoleDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { CONTRIBUTOR, ORGANIZATION_ID } from "~/test/members.js";

function renderDialog(member = CONTRIBUTOR) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/org-admin",
      Component: () => (
        <ChangeRoleDialog
          open
          onOpenChange={onOpenChange}
          member={member}
          organizationId={ORGANIZATION_ID}
          onChanged={onChanged}
        />
      ),
    },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/org-admin"]} />);
  return { onOpenChange, onChanged, user: userEvent.setup() };
}

/** Picks a role from the dialog's Select. */
async function chooseRole(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: "Role" }));
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("ChangeRoleDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has its title and fields, with the member's role selected and its help text", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Change Role" });

    expect(dialog).toHaveTextContent("Change the user's role for contributor@example.com");
    expect(screen.getByText("Role")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent("Contributor");
    expect(screen.getByText("Can create and edit configurations.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Role" })).toBeInTheDocument();
  });

  it("offers Admin and Contributor only", async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole("combobox", { name: "Role" }));

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Admin", "Contributor"]);
  });

  it("disables Update Role until a different role is chosen, and shows that role's help text", async () => {
    const { user } = renderDialog();
    const update = await screen.findByRole("button", { name: "Update Role" });
    expect(update).toBeDisabled();

    await chooseRole(user, "Admin");

    expect(update).toBeEnabled();
    expect(screen.getByText("Full access to manage the organization and its members.")).toBeInTheDocument();
    expect(screen.queryByText("Can create and edit configurations.")).not.toBeInTheDocument();

    await chooseRole(user, "Contributor");
    expect(update).toBeDisabled();
  });

  it("changes the role, says Updating... meanwhile, toasts, closes and reloads the list", async () => {
    let finish!: () => void;
    const changeMemberRole = vi.spyOn(apiClient, "changeMemberRole").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = renderDialog();
    await screen.findByRole("dialog", { name: "Change Role" });

    await chooseRole(user, "Admin");
    await user.click(screen.getByRole("button", { name: "Update Role" }));

    expect(changeMemberRole).toHaveBeenCalledWith(ORGANIZATION_ID, CONTRIBUTOR.userId, { role: "admin" });
    expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();
    finish();

    await waitFor(() => expect(success).toHaveBeenCalledWith("contributor@example.com role changed to admin"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("toasts the API's refusal, stays open, and reloads the list", async () => {
    vi.spyOn(apiClient, "changeMemberRole").mockRejectedValue(
      new ApiError("member_not_active", "Only active members can have their role changed"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = renderDialog();
    await screen.findByRole("dialog", { name: "Change Role" });

    await chooseRole(user, "Admin");
    await user.click(screen.getByRole("button", { name: "Update Role" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Only active members can have their role changed"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Update Role" })).toBeEnabled());
  });

  it("toasts Failed to update role when the change fails unexpectedly, without reloading", async () => {
    vi.spyOn(apiClient, "changeMemberRole").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onChanged } = renderDialog();
    await screen.findByRole("dialog", { name: "Change Role" });

    await chooseRole(user, "Admin");
    await user.click(screen.getByRole("button", { name: "Update Role" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to update role"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("on a 403 organization_admin_required, toasts its message, closes and goes to /app", async () => {
    vi.spyOn(apiClient, "changeMemberRole").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = renderDialog();
    await screen.findByRole("dialog", { name: "Change Role" });

    await chooseRole(user, "Admin");
    await user.click(screen.getByRole("button", { name: "Update Role" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
    expect(error).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Cancel without a request", async () => {
    const changeMemberRole = vi.spyOn(apiClient, "changeMemberRole");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(changeMemberRole).not.toHaveBeenCalled();
  });
});
