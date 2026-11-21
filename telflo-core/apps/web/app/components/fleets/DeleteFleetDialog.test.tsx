import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE } from "@telflo/contracts";
import { DELETE_FLEET_FAILED_MESSAGE, DeleteFleetDialog, FLEET_DELETE_TIMEOUT_MS } from "./DeleteFleetDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { FLEET_ID, fleet } from "~/test/fleets.js";

/*
 * "Delete fleet". `DeleteConfigurationDialog.test.tsx` is the pattern.
 */

const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);

type Answer = "deleted" | "hang" | Error;

function serveDeletes(...answers: Answer[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "deleteFleet").mockImplementation((organizationId, fleetId, options = {}) => {
    expect(fleetId).toBe(FLEET_ID);
    void organizationId;
    signals.push(options.signal);
    const answer = answers.shift() ?? "deleted";
    if (answer === "deleted") return Promise.resolve(undefined);
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    return Promise.reject(answer);
  });
  return { spy, signals };
}

async function renderDialog() {
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  const onReload = vi.fn();
  const loader = vi.fn(() => null);
  const Stub = createRoutesStub([
    {
      path: "/fleet-management",
      loader,
      HydrateFallback: () => null,
      Component: () => (
        <DeleteFleetDialog
          open
          onOpenChange={onOpenChange}
          fleet={fleet()}
          organizationId={GROUP_ID}
          onDeleted={onDeleted}
          onReload={onReload}
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/fleet-management"]} />);
  const user = userEvent.setup();
  await screen.findByRole("alertdialog", { name: "Delete fleet" });
  return { user, onOpenChange, onDeleted, onReload, loader };
}

describe("DeleteFleetDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says what the platform deletes", async () => {
    await renderDialog();
    const dialog = screen.getByRole("alertdialog", { name: "Delete fleet" });
    expect(dialog).toHaveTextContent("You are permanently deleting edge-prod. This action cannot be undone.");
    expect(dialog).toHaveTextContent("The following will be removed:");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "The fleet and its groups",
      "All its collectors and their error history",
      "All its tokens: collectors using them are refused (401) from their next poll (allow about 10 seconds more)",
    ]);
    expect(dialog).toHaveTextContent(
      "Published versions are not deleted: they stay with their configurations, under Configurations.",
    );
    expect(screen.getByRole("button", { name: "Delete fleet" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it('deletes in the organization, says "Deleting..." and stays open until the API answers, then toasts "Deleted fleet {label}" and closes', async () => {
    let finish!: () => void;
    const deleteFleet = vi.spyOn(apiClient, "deleteFleet").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange, onDeleted, onReload } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Delete fleet" }));

    expect(deleteFleet).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Unclosable while it works: Escape and an outside click do nothing (an AlertDialog has no X).
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Delete fleet" })).toBeInTheDocument();

    await act(async () => finish());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(success).toHaveBeenCalledWith("Deleted fleet edge-prod");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("counts a 404 fleet_not_found as deleted: toasts the API's message, closes, onDeleted", async () => {
    serveDeletes(refusal("fleet_not_found", "Fleet not found", 404));
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange, onDeleted, onReload } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Delete fleet" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith("Fleet not found");
    expect(success).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onReload).not.toHaveBeenCalled();
  });

  it.each([
    ["a 503 fleets_unavailable (the API's 25 s, or a repeat while it runs), its own words", UNAVAILABLE, FLEETS_UNAVAILABLE_MESSAGE],
    ["a 500, the fallback", () => refusal("internal_error", "Something went wrong.", 500), DELETE_FLEET_FAILED_MESSAGE],
    ["no connection, the fallback", () => new ApiError("network_error", "Could not reach the server."), DELETE_FLEET_FAILED_MESSAGE],
  ])("on %s, toasts, closes and reloads", async (_why, failure, words) => {
    serveDeletes(failure());
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted, onReload } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Delete fleet" }));

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(words);
    expect(error).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("on a 429, toasts and stays open", async () => {
    const deletes = serveDeletes(refusal("rate_limited", "Too many attempts. Please wait and try again.", 429));
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted, onReload } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Delete fleet" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Too many attempts. Please wait and try again."));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete fleet" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Delete fleet" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(deletes.spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    serveDeletes(failure());
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted, onReload, loader } = await renderDialog();
    const loadsBefore = loader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Delete fleet" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    serveDeletes(refusal("unauthenticated", "You need to sign in.", 401));
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Delete fleet" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete fleet" })).toBeEnabled());
    expect(error).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on Cancel without a request", async () => {
    const deletes = serveDeletes();
    const { user, onOpenChange } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(deletes.spy).not.toHaveBeenCalled();
  });

  it("ends a delete that never answers at 35 s (above the API's 25 s): toasts the 503's words, closes and reloads", async () => {
    const deletes = serveDeletes("hang");
    const error = vi.spyOn(toast, "error");
    const { onOpenChange, onDeleted, onReload } = await renderDialog();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Delete fleet" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_DELETE_TIMEOUT_MS - 1));
    expect(FLEET_DELETE_TIMEOUT_MS).toBe(35_000);
    expect(deletes.signals[0]!.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(deletes.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("does nothing when the delete answers after the organization changed", async () => {
    let finish!: () => void;
    vi.spyOn(apiClient, "deleteFleet").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const success = vi.spyOn(toast, "success");
    const onDeleted = vi.fn();
    const onReload = vi.fn();

    function Page() {
      const [organizationId, setOrganizationId] = useState(GROUP_ID);
      return (
        <>
          <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
            Switch
          </button>
          <DeleteFleetDialog
            open
            onOpenChange={() => {}}
            fleet={fleet()}
            organizationId={organizationId}
            onDeleted={onDeleted}
            onReload={onReload}
          />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/fleet-management", Component: Page, HydrateFallback: () => null }]);
    render(<Stub initialEntries={["/fleet-management"]} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Delete fleet" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));

    await act(async () => finish());

    expect(success).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });
});
