import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { CancelInvitationDialog } from "./CancelInvitationDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { INVITED_CONTRIBUTOR, ORGANIZATION_ID } from "~/test/members.js";

function renderDialog() {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/org-admin",
      Component: () => (
        <CancelInvitationDialog
          open
          onOpenChange={onOpenChange}
          invitation={INVITED_CONTRIBUTOR}
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

describe("CancelInvitationDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("asks to confirm the cancellation, with its buttons", async () => {
    renderDialog();
    const dialog = await screen.findByRole("alertdialog", { name: "Cancel Invitation" });

    expect(dialog).toHaveTextContent(
      "You are permanently cancelling the invitation for invited@example.com. This action cannot be undone.",
    );
    expect(screen.getByRole("button", { name: "Go Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel Invitation" })).toBeEnabled();
  });

  it("cancels, says Cancelling... with both buttons disabled meanwhile, toasts, closes and reloads the list", async () => {
    let finish!: () => void;
    const cancelInvitation = vi.spyOn(apiClient, "cancelInvitation").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Cancel Invitation" }));

    expect(cancelInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, INVITED_CONTRIBUTOR.id);
    // Still open while the API answers.
    expect(screen.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go Back" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    finish();

    await waitFor(() => expect(success).toHaveBeenCalledWith("Invitation cancelled for invited@example.com"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("toasts the API's refusal, stays open, and reloads the list", async () => {
    vi.spyOn(apiClient, "cancelInvitation").mockRejectedValue(
      new ApiError("invitation_not_found", "No pending invitation found for this user"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Cancel Invitation" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("No pending invitation found for this user"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel Invitation" })).toBeEnabled());
  });

  it("toasts Failed to cancel invitation when canceling fails unexpectedly, without reloading", async () => {
    vi.spyOn(apiClient, "cancelInvitation").mockRejectedValue(new ApiError("internal_error", "Something went wrong."));
    const error = vi.spyOn(toast, "error");
    const { user, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Cancel Invitation" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to cancel invitation"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("on a 403 organization_admin_required, toasts its message, closes and goes to /app", async () => {
    vi.spyOn(apiClient, "cancelInvitation").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Cancel Invitation" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Go Back without a request", async () => {
    const cancelInvitation = vi.spyOn(apiClient, "cancelInvitation");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Go Back" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(cancelInvitation).not.toHaveBeenCalled();
  });
});
