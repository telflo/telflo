import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { RestoreMemberDialog } from "./RestoreMemberDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { ORGANIZATION_ID, REMOVED } from "~/test/members.js";

function renderDialog() {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/org-admin",
      Component: () => (
        <RestoreMemberDialog
          open
          onOpenChange={onOpenChange}
          member={REMOVED}
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

describe("RestoreMemberDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("asks to confirm the restore, with its buttons", async () => {
    renderDialog();
    const dialog = await screen.findByRole("alertdialog", { name: "Restore Member" });

    expect(dialog).toHaveTextContent(
      "You are restoring removed@example.com's access to the organization. They will regain their previous capabilities.",
    );
    expect(screen.getByRole("button", { name: "Go Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore Member" })).toBeEnabled();
  });

  it("restores, says Restoring... with both buttons disabled meanwhile, toasts, closes and reloads the list", async () => {
    let finish!: () => void;
    const restoreMember = vi.spyOn(apiClient, "restoreMember").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Restore Member" }));

    expect(restoreMember).toHaveBeenCalledWith(ORGANIZATION_ID, REMOVED.userId);
    // Still open while the API answers.
    expect(screen.getByRole("button", { name: "Restoring..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go Back" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    finish();

    await waitFor(() => expect(success).toHaveBeenCalledWith("removed@example.com has been restored to the organization"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("toasts the API's refusal, stays open, and reloads the list", async () => {
    vi.spyOn(apiClient, "restoreMember").mockRejectedValue(
      new ApiError("member_not_removed", "Only deleted members can be restored"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Restore Member" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Only deleted members can be restored"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore Member" })).toBeEnabled());
  });

  it("toasts Failed to restore member when restoring fails unexpectedly, without reloading", async () => {
    vi.spyOn(apiClient, "restoreMember").mockRejectedValue(new ApiError("internal_error", "Something went wrong."));
    const error = vi.spyOn(toast, "error");
    const { user, onChanged } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Restore Member" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to restore member"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("on a 403 organization_admin_required, toasts its message, closes and goes to /app", async () => {
    vi.spyOn(apiClient, "restoreMember").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Restore Member" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Go Back without a request", async () => {
    const restoreMember = vi.spyOn(apiClient, "restoreMember");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Go Back" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(restoreMember).not.toHaveBeenCalled();
  });
});
