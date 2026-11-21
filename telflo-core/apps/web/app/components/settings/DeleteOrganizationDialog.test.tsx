import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { DeleteOrganizationDialog } from "./DeleteOrganizationDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";

const GROUP = { id: "00000000-0000-4000-8000-000000000003", name: "Beta Team" };

function renderDialog() {
  const onOpenChange = vi.fn();
  const Stub = createRoutesStub([
    {
      path: "/settings/organization",
      Component: () => <DeleteOrganizationDialog open onOpenChange={onOpenChange} organization={GROUP} />,
    },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/settings/organization"]} />);
  return { onOpenChange, user: userEvent.setup() };
}

describe("DeleteOrganizationDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has its copy", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Delete Organization" });

    expect(dialog).toHaveTextContent(
      "This permanently removes Beta Team for every member. Type the organization's name to confirm.",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Organization" })).toBeInTheDocument();
  });

  it("stays disabled until the exact name is typed: case-sensitive and untrimmed", async () => {
    const { user } = renderDialog();
    const input = await screen.findByRole("textbox", { name: "Organization name" });
    const confirm = screen.getByRole("button", { name: "Delete Organization" });
    expect(confirm).toBeDisabled();

    await user.type(input, "Beta Tea");
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, "beta team");
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Beta Team ");
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Beta Team");
    expect(confirm).toBeEnabled();
  });

  it("deletes, says Deleting... meanwhile, toasts, and goes to /app", async () => {
    let finish!: () => void;
    const deleteOrganization = vi.spyOn(apiClient, "deleteOrganization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange } = renderDialog();

    await user.type(await screen.findByRole("textbox", { name: "Organization name" }), "Beta Team");
    await user.click(screen.getByRole("button", { name: "Delete Organization" }));

    expect(deleteOrganization).toHaveBeenCalledWith(GROUP.id);
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    finish();

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(success).toHaveBeenCalledWith("Beta Team has been deleted");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("toasts the API's refusal and stays", async () => {
    vi.spyOn(apiClient, "deleteOrganization").mockRejectedValue(
      new ApiError("personal_organization_protected", "A personal organization can't be deleted"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = renderDialog();

    await user.type(await screen.findByRole("textbox", { name: "Organization name" }), "Beta Team");
    await user.click(screen.getByRole("button", { name: "Delete Organization" }));

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("A personal organization can't be deleted"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText("landed on /app")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Organization" })).toBeEnabled());
  });

  it.each([
    { code: "organization_not_found", message: "Organization not found", why: "deleted or switched away from in another tab" },
    { code: "organization_admin_required", message: "Only an admin of this organization can do that", why: "demoted" },
  ])(
    "when refused with $code ($why), closes, toasts the API's message and goes to /app",
    async ({ code, message }) => {
      vi.spyOn(apiClient, "deleteOrganization").mockRejectedValue(new ApiError(code, message));
      const error = vi.spyOn(toast, "error");
      const success = vi.spyOn(toast, "success");
      const { user, onOpenChange } = renderDialog();

      await user.type(await screen.findByRole("textbox", { name: "Organization name" }), "Beta Team");
      await user.click(screen.getByRole("button", { name: "Delete Organization" }));

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(error).toHaveBeenCalledWith(message);
      expect(success).not.toHaveBeenCalled();
    },
  );

  it("toasts the fallback when deleting fails unexpectedly", async () => {
    vi.spyOn(apiClient, "deleteOrganization").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    const error = vi.spyOn(toast, "error");
    const { user } = renderDialog();

    await user.type(await screen.findByRole("textbox", { name: "Organization name" }), "Beta Team");
    await user.click(screen.getByRole("button", { name: "Delete Organization" }));

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Failed to delete organization"));
  });

  it("clears what was typed when canceled", async () => {
    const { user, onOpenChange } = renderDialog();
    const input = await screen.findByRole("textbox", { name: "Organization name" });

    await user.type(input, "Beta Team");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(input).toHaveValue("");
  });
});
