import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type Fleet, type UpdateFleetRequest } from "@telflo/contracts";
import { ArchiveFleetDialog, UPDATE_FAILED_MESSAGE, type FleetStatusAction } from "./ArchiveFleetDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { FLEET_ID, fleet } from "~/test/fleets.js";

/*
 * "Archive fleet" and "Unarchive fleet" (D17a decisions 26 and 28, Preflight
 * rulings 4 and 14).
 */

const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);

const ARCHIVE_WORDS =
  "Archive edge-prod? Its collectors will be refused (403) from their next poll (allow about 10 seconds more), and its tokens can't be rotated. You can unarchive it at any time.";
const UNARCHIVE_WORDS = "Unarchive edge-prod? Its collectors can connect again, and its tokens can be rotated.";

/** How a held request is answered: with the fleet, or a failure. */
type Settle = { resolve: (value: Fleet) => void; reject: (failure: unknown) => void };

type Answer = "changed" | "hang" | Error;

function serveUpdates(...answers: Answer[]) {
  const requests: UpdateFleetRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "updateFleet").mockImplementation((organizationId, fleetId, request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    requests.push(request);
    signals.push(options.signal);
    const answer = answers.shift() ?? "changed";
    if (answer === "changed") return Promise.resolve(fleet({ status: request.status ?? "active" }));
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    return Promise.reject(answer);
  });
  return { spy, requests, signals };
}

async function renderDialog(action: FleetStatusAction = "archive") {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  const Stub = createRoutesStub([
    {
      path: "/fleet-management",
      loader,
      HydrateFallback: () => null,
      Component: () => (
        <ArchiveFleetDialog
          open
          onOpenChange={onOpenChange}
          fleet={fleet({ status: action === "archive" ? "active" : "archived" })}
          action={action}
          organizationId={GROUP_ID}
          onChanged={onChanged}
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/fleet-management"]} />);
  const user = userEvent.setup();
  await screen.findByRole("alertdialog");
  return { user, onOpenChange, onChanged, loader };
}

describe("ArchiveFleetDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["archive", "Archive fleet", ARCHIVE_WORDS, "Archive"],
    ["unarchive", "Unarchive fleet", UNARCHIVE_WORDS, "Unarchive"],
  ] as const)("%s: says what the server does, in Preflight ruling 4's words", async (action, title, words, button) => {
    await renderDialog(action);
    const dialog = screen.getByRole("alertdialog", { name: title });
    // The dialog's description (an inline span holds the label, so the text is read whole).
    expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe(words);
    expect(screen.getByRole("button", { name: button })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it.each([
    ["archive", { status: "archived" }],
    ["unarchive", { status: "active" }],
  ] as const)("%s: sends the status alone, then closes and reloads, with no toast", async (action, request) => {
    const updates = serveUpdates();
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = await renderDialog(action);

    await user.click(screen.getByRole("button", { name: action === "archive" ? "Archive" : "Unarchive" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(updates.requests).toEqual([request]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["a 503 fleets_unavailable, its own words", UNAVAILABLE, FLEETS_UNAVAILABLE_MESSAGE],
    ["a 500, the fallback", () => refusal("internal_error", "Something went wrong.", 500), UPDATE_FAILED_MESSAGE],
    ["no connection, the fallback", () => new ApiError("network_error", "Could not reach the server."), UPDATE_FAILED_MESSAGE],
    ["a 404 fleet_not_found, the API's message", () => refusal("fleet_not_found", "Fleet not found", 404), "Fleet not found"],
  ])("on %s, toasts, closes and reloads (the change may have been made, or the fleet is gone)", async (_why, failure, words) => {
    serveUpdates(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(words);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["a 429", () => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429), "Too many attempts. Please wait and try again."],
    ["a 400, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), UPDATE_FAILED_MESSAGE],
  ])("on %s, toasts and stays open for another try", async (_why, failure, words) => {
    serveUpdates(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(words));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    serveUpdates(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged, loader } = await renderDialog();
    const loadsBefore = loader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("can't be closed while the change is under way: Cancel disabled, Escape does nothing", async () => {
    let finish!: () => void;
    vi.spyOn(apiClient, "updateFleet").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(fleet({ status: "archived" }));
        }),
    );
    const { user, onOpenChange, onChanged } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect(screen.getByRole("button", { name: "Archiving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Archive fleet" })).toBeInTheDocument();

    await act(async () => finish());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Cancel without a request", async () => {
    const updates = serveUpdates();
    const { user, onOpenChange } = await renderDialog("unarchive");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updates.spy).not.toHaveBeenCalled();
  });

  it("ends a change that never answers at 30 s: toasts the 503's words, closes and reloads", async () => {
    const updates = serveUpdates("hang");
    const toastError = vi.spyOn(toast, "error");
    const { onOpenChange, onChanged } = await renderDialog("unarchive");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(updates.signals[0]!.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Unarchiving…" })).toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(updates.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["the change", (settle: Settle) => settle.resolve(fleet({ status: "archived" }))],
    ["a 404 fleet_not_found", (settle: Settle) => settle.reject(refusal("fleet_not_found", "Fleet not found", 404))],
    ["a 503", (settle: Settle) => settle.reject(UNAVAILABLE())],
  ])("drops %s answered after the organization changed: no toast, no reload", async (_why, answer) => {
    let finish!: () => void;
    vi.spyOn(apiClient, "updateFleet").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = () => answer({ resolve, reject });
        }),
    );
    const toastError = vi.spyOn(toast, "error");
    const onOpenChange = vi.fn();
    const onChanged = vi.fn();
    const loader = vi.fn(() => null);

    function Page() {
      const [organizationId, setOrganizationId] = useState(GROUP_ID);
      return (
        <>
          <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
            Switch
          </button>
          <ArchiveFleetDialog
            open
            onOpenChange={onOpenChange}
            fleet={fleet()}
            action="archive"
            organizationId={organizationId}
            onChanged={onChanged}
          />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/fleet-management", Component: Page, loader, HydrateFallback: () => null }]);
    render(<Stub initialEntries={["/fleet-management"]} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Archive" }));
    const loads = loader.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));

    await act(async () => finish());

    expect(toastError).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalledTimes(loads);
  });
});
