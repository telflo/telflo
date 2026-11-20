import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Configuration } from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { DeleteConfigurationDialog } from "./DeleteConfigurationDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { GROUP_ID, THEIRS } from "~/test/configurations.js";

function renderDialog(configuration: Configuration | null = THEIRS) {
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  const loader = vi.fn(() => null);
  const Stub = createRoutesStub([
    {
      path: "/app",
      loader,
      HydrateFallback: () => null,
      Component: () => (
        <DeleteConfigurationDialog
          open
          onOpenChange={onOpenChange}
          configuration={configuration}
          organizationId={GROUP_ID}
          onDeleted={onDeleted}
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/app"]} />);
  return { onOpenChange, onDeleted, loader, user: userEvent.setup() };
}

describe("DeleteConfigurationDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("asks to confirm by name, with Cancel and Delete", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Delete Configuration" });

    expect(dialog).toHaveTextContent('Are you sure you want to delete "Staging Logs"? This action cannot be undone.');
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("says \"this configuration\" when there is none to name", async () => {
    renderDialog(null);

    expect(await screen.findByRole("dialog", { name: "Delete Configuration" })).toHaveTextContent(
      "Are you sure you want to delete this configuration? This action cannot be undone.",
    );
  });

  it("deletes, says Deleting... and stays open until the API answers, then closes and reloads with no toast", async () => {
    let finish!: () => void;
    const deleteConfiguration = vi.spyOn(apiClient, "deleteConfiguration").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(deleteConfiguration).toHaveBeenCalledWith(GROUP_ID, THEIRS.id);
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Escape doesn't close it meanwhile.
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    finish();

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["a server error", new ApiError("internal_error", "Something went wrong. Please try again.")],
    ["no connection", new ApiError("network_error", "Could not reach the server. Check your connection.")],
    ["a drifted response", new ApiError("unexpected_response", "The server returned an unexpected error.")],
  ])("toasts the fallback for %s, and stays open without reloading", async (_why, failure) => {
    vi.spyOn(apiClient, "deleteConfiguration").mockRejectedValue(failure);
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("An error has occurred. Please refresh the page."));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("toasts the API's refusal, and stays open", async () => {
    vi.spyOn(apiClient, "deleteConfiguration").mockRejectedValue(
      new ApiError("organization_access_denied", "You are not an active member of this organization"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("You are not an active member of this organization"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a 409 configuration_in_use (a fleet uses it)",
      new ApiError(
        "configuration_in_use",
        "A collector group or a collector uses a published version of this configuration. Remove it from them first.",
      ),
    ],
    ["a 429 rate_limited (the person's fleet limit)", new ApiError("rate_limited", "Too many attempts. Please wait and try again.")],
    [
      "a 503 fleets_unavailable (the fleet usage unreadable)",
      new ApiError("fleets_unavailable", "Couldn't check whether a fleet uses this configuration, so nothing was deleted."),
    ],
  ])("toasts the API's own message for %s, and stays open without reloading", async (_why, failure) => {
    vi.spyOn(apiClient, "deleteConfiguration").mockRejectedValue(failure);
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted, loader } = renderDialog();
    await screen.findByRole("dialog");
    const loadsBefore = loader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith(failure.message));
    expect(error).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(loader.mock.calls.length).toBe(loadsBefore);
    expect(screen.getByRole("dialog", { name: "Delete Configuration" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("on a 404 configuration_not_found, toasts its message, closes and reloads the list", async () => {
    vi.spyOn(apiClient, "deleteConfiguration").mockRejectedValue(
      new ApiError("configuration_not_found", "Configuration not found"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith("Configuration not found");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on a 404 organization_not_found, closes and revalidates the layout, with no toast", async () => {
    vi.spyOn(apiClient, "deleteConfiguration").mockRejectedValue(
      new ApiError("organization_not_found", "Organization not found"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted, loader } = renderDialog();
    await screen.findByRole("dialog");
    const loadsBefore = loader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("on a 403 terms_acceptance_required, closes and revalidates the layout, whose terms dialog opens, with no toast", async () => {
    vi.spyOn(apiClient, "deleteConfiguration").mockRejectedValue(
      new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted, loader } = renderDialog();
    await screen.findByRole("dialog");
    const loadsBefore = loader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("closes on Cancel without a request", async () => {
    const deleteConfiguration = vi.spyOn(apiClient, "deleteConfiguration");
    const { user, onOpenChange } = renderDialog();

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(deleteConfiguration).not.toHaveBeenCalled();
  });

  it("does nothing when the delete answers after its dialog has unmounted, so a fresh dialog stays open", async () => {
    let finish!: () => void;
    vi.spyOn(apiClient, "deleteConfiguration").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const error = vi.spyOn(toast, "error");
    const onOpenChange = vi.fn();
    const onDeleted = vi.fn();
    const loader = vi.fn(() => null);

    function Page() {
      const [open, setOpen] = useState(true);
      const [mounted, setMounted] = useState(true);
      const [instance, setInstance] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setMounted(false)}>
            Unmount
          </button>
          <button
            type="button"
            onClick={() => {
              setInstance((value) => value + 1);
              setOpen(true);
              setMounted(true);
            }}
          >
            Remount
          </button>
          {mounted && (
            <DeleteConfigurationDialog
              key={instance}
              open={open}
              onOpenChange={(next) => {
                onOpenChange(next);
                setOpen(next);
              }}
              configuration={THEIRS}
              organizationId={GROUP_ID}
              onDeleted={onDeleted}
            />
          )}
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/app", Component: Page, loader, HydrateFallback: () => null }]);
    render(<Stub initialEntries={["/app"]} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Unmount", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Remount" }));
    expect(await screen.findByRole("button", { name: "Delete" })).toBeEnabled();
    const loadsBefore = loader.mock.calls.length;

    await act(async () => finish());

    expect(screen.getByRole("dialog", { name: "Delete Configuration" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(loader.mock.calls.length).toBe(loadsBefore);
  });
});
