import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { DeleteMemberDialog } from "./DeleteMemberDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { CONTRIBUTOR, ORGANIZATION_ID } from "~/test/members.js";

function renderDialog() {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/org-admin",
      Component: () => (
        <DeleteMemberDialog
          open
          onOpenChange={onOpenChange}
          member={CONTRIBUTOR}
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

describe("DeleteMemberDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("asks to confirm the removal, with its buttons", async () => {
    renderDialog();
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Member" });

    expect(dialog).toHaveTextContent(
      "You are removing contributor@example.com from the organization. They will lose access immediately.",
    );
    expect(screen.getByRole("button", { name: "Go Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete Member" })).toBeEnabled();
  });

  it("removes, says Removing... with both buttons disabled meanwhile, toasts, closes and reloads the list", async () => {
    let finish!: () => void;
    const removeMember = vi.spyOn(apiClient, "removeMember").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete Member" }));

    expect(removeMember).toHaveBeenCalledWith(ORGANIZATION_ID, CONTRIBUTOR.userId);
    // Still open while the API answers.
    expect(screen.getByRole("button", { name: "Removing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go Back" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    finish();

    await waitFor(() => expect(success).toHaveBeenCalledWith("contributor@example.com has been removed from the organization"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("toasts the API's refusal, stays open, and reloads the list", async () => {
    vi.spyOn(apiClient, "removeMember").mockRejectedValue(
      new ApiError("personal_organization_protected", "The owner of a personal organization can't be removed or have their role changed"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete Member" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("The owner of a personal organization can't be removed or have their role changed"),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Member" })).toBeEnabled());
  });

  it("toasts Failed to remove member when removing fails unexpectedly, without reloading", async () => {
    vi.spyOn(apiClient, "removeMember").mockRejectedValue(new ApiError("internal_error", "Something went wrong."));
    const error = vi.spyOn(toast, "error");
    const { user, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete Member" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to remove member"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("on a 403 organization_admin_required, toasts its message, closes and goes to /app", async () => {
    vi.spyOn(apiClient, "removeMember").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete Member" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Go Back without a request", async () => {
    const removeMember = vi.spyOn(apiClient, "removeMember");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Go Back" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(removeMember).not.toHaveBeenCalled();
  });
});
