import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type Fleet, type UpdateFleetRequest } from "@telflo/contracts";
import { RENAME_FAILED_MESSAGE, RenameFleetDialog } from "./RenameFleetDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { FLEET_ID, fleet } from "~/test/fleets.js";

/*
 * "Rename fleet".
 */

const refusal = (code: string, message: string, status: number, options: { details?: unknown } = {}) =>
  new ApiError(code, message, { status, ...options });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const LABEL_TAKEN = () => refusal("fleet_label_taken", "Another of the organization's fleets has this label.", 409);
const GONE = () => refusal("fleet_not_found", "Fleet not found", 404);

/** How a held request is answered: with the fleet, or a failure. */
type Settle = { resolve: (value: Fleet) => void; reject: (failure: unknown) => void };

type Answer = "renamed" | "hang" | Error;

/** The update, answering each call in turn (then "renamed"); every request and signal kept. */
function serveUpdates(...answers: Answer[]) {
  const requests: UpdateFleetRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "updateFleet").mockImplementation((organizationId, fleetId, request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    requests.push(request);
    signals.push(options.signal);
    const answer = answers.shift() ?? "renamed";
    if (answer === "renamed") return Promise.resolve(fleet({ label: request.label ?? "edge-prod" }));
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      });
    }
    return Promise.reject(answer);
  });
  return { spy, requests, signals };
}

/** The dialog open for "edge-prod" in GROUP_ID, on a page that can reopen it; a loader counts revalidations. */
async function renderDialog() {
  const onOpenChange = vi.fn();
  const onRenamed = vi.fn();
  const loader = vi.fn(() => null);

  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <RenameFleetDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          fleet={fleet()}
          organizationId={GROUP_ID}
          onRenamed={onRenamed}
        />
      </>
    );
  }

  const Stub = createRoutesStub([{ path: "/fleet-management", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/fleet-management"]} />);
  const user = userEvent.setup();
  await screen.findByRole("dialog", { name: "Rename fleet" });
  return { user, onOpenChange, onRenamed, loader };
}

const nameField = () => screen.getByLabelText("Name");

async function rename(user: ReturnType<typeof userEvent.setup>, to: string) {
  await user.clear(nameField());
  await user.type(nameField(), to);
  await user.click(screen.getByRole("button", { name: "Save" }));
}

describe("RenameFleetDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens with the fleet\'s label in the Name, "Save" and Cancel, and the helper', async () => {
    await renderDialog();
    expect(nameField()).toHaveValue("edge-prod");
    expect(nameField()).toHaveAttribute("maxLength", "80");
    expect(screen.getByText("Fleet name must be unique within your organization.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("sends the Name trimmed, in the organization, then closes and reloads", async () => {
    const updates = serveUpdates();
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onRenamed } = await renderDialog();

    await rename(user, "  edge-renamed  ");

    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
    expect(updates.requests).toEqual([{ label: "edge-renamed" }]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sends nothing when the trimmed Name is the label, and closes", async () => {
    const updates = serveUpdates();
    const { user, onOpenChange, onRenamed } = await renderDialog();

    await rename(user, " edge-prod ");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updates.spy).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it.each([
    ["a 503 fleets_unavailable", UNAVAILABLE],
    ["a 500", () => refusal("internal_error", "Something went wrong.", 500)],
    ["no connection", () => new ApiError("network_error", "Could not reach the server.")],
    ["a reply that doesn't parse", () => new ApiError("unexpected_response", "The server sent a response that could not be read.")],
  ])("after %s (the rename unknown), sends the label typed back: the fleet may have the other name", async (_why, failure) => {
    const updates = serveUpdates(failure());
    const { user, onRenamed } = await renderDialog();

    await rename(user, "edge-dev");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await rename(user, "edge-prod");

    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
    expect(updates.requests).toEqual([{ label: "edge-dev" }, { label: "edge-prod" }]);
  });

  it("after the hang guard's abort (the rename unknown), sends the label typed back", async () => {
    const updates = serveUpdates("hang");
    const { user, onRenamed } = await renderDialog();
    await user.clear(nameField());
    await user.type(nameField(), "edge-dev");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS));
    vi.useRealTimers();
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);

    await rename(user, "edge-prod");
    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
    expect(updates.requests).toEqual([{ label: "edge-dev" }, { label: "edge-prod" }]);
  });

  // The create, archive and delete reload after an unknown outcome, so a
  // rename's does too, whichever way it closes.
  it.each([
    ["Cancel", async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["the X", async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Close" }))],
  ])("closed by %s after an unknown outcome (a 503), reloads once: the fleet may have the other name", async (_how, closeIt) => {
    const updates = serveUpdates(UNAVAILABLE());
    const { user, onOpenChange, onRenamed } = await renderDialog();
    await rename(user, "edge-dev");
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onRenamed).not.toHaveBeenCalled();

    await closeIt(user);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(updates.requests).toEqual([{ label: "edge-dev" }]);
  });

  it("closed after the hang guard's abort (the rename unknown), reloads once", async () => {
    serveUpdates("hang");
    const { user, onRenamed } = await renderDialog();
    await user.clear(nameField());
    await user.type(nameField(), "edge-dev");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS));
    vi.useRealTimers();
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRenamed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 409", LABEL_TAKEN],
    ["a 429", () => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429)],
  ])("closed after a refusal that leaves nothing unknown (%s), doesn't reload", async (_why, failure) => {
    serveUpdates(failure());
    const { user, onOpenChange, onRenamed } = await renderDialog();
    await rename(user, "edge-dev");
    await screen.findByText(failure().message);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("after a refusal that leaves nothing unknown (a 409), the label typed back still sends nothing", async () => {
    const updates = serveUpdates(LABEL_TAKEN());
    const { user, onOpenChange, onRenamed } = await renderDialog();

    await rename(user, "edge-dev");
    await screen.findByText("Another of the organization's fleets has this label.");
    await rename(user, "edge-prod");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updates.requests).toEqual([{ label: "edge-dev" }]);
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("disables Save for an empty Name, and shows the contract's refusal under the field with nothing sent", async () => {
    const updates = serveUpdates();
    const { user } = await renderDialog();

    await user.clear(nameField());
    await user.type(nameField(), "   ");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(nameField());
    fireEvent.change(nameField(), { target: { value: "edge\u0007bell" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Must not start or end with a space, or hold a control character.")).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(updates.spy).not.toHaveBeenCalled();
  });

  it("shows a taken label under the Name, the dialog open, and clears it on typing", async () => {
    serveUpdates(LABEL_TAKEN());
    const { user, onOpenChange, onRenamed } = await renderDialog();

    await rename(user, "edge-dev");

    expect(await screen.findByText("Another of the organization's fleets has this label.")).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(nameField()).toHaveValue("edge-dev");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    await user.type(nameField(), "2");
    expect(screen.queryByText("Another of the organization's fleets has this label.")).toBeNull();
  });

  it("shows a 400's label problem under the Name, and never the API's own invalid_request words", async () => {
    serveUpdates(
      refusal("invalid_request", "The request was not valid.", 400, {
        details: [{ instancePath: "/label", message: "Must be 1 to 80 characters.", params: { issue: { path: ["label"] } } }],
      }),
    );
    const { user } = await renderDialog();

    await rename(user, "edge-dev");

    expect(await screen.findByText("Must be 1 to 80 characters.")).toBeInTheDocument();
    expect(screen.queryByText("The request was not valid.")).toBeNull();
  });

  it.each([
    ["a 503 fleets_unavailable, its own words", UNAVAILABLE, FLEETS_UNAVAILABLE_MESSAGE],
    ["a 429", () => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429), "Too many attempts. Please wait and try again."],
    ["a 500, the fallback", () => refusal("internal_error", "Something went wrong.", 500), RENAME_FAILED_MESSAGE],
    ["a 400 naming no field, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), RENAME_FAILED_MESSAGE],
  ])("shows %s in the dialog, which stays open for another try", async (_why, failure, words) => {
    const updates = serveUpdates(failure());
    const { user, onOpenChange, onRenamed } = await renderDialog();

    await rename(user, "edge-dev");

    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
    expect(updates.requests).toEqual([{ label: "edge-dev" }, { label: "edge-dev" }]);
  });

  it("on a 404 fleet_not_found, toasts the API's message, closes and reloads", async () => {
    serveUpdates(GONE());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onRenamed } = await renderDialog();

    await rename(user, "edge-dev");

    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Fleet not found");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    serveUpdates(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onRenamed, loader } = await renderDialog();
    const loadsBefore = loader.mock.calls.length;

    await rename(user, "edge-dev");

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRenamed).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended (the session-ended handler has the page)", async () => {
    serveUpdates(refusal("unauthenticated", "You need to sign in.", 401));
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderDialog();

    await rename(user, "edge-dev");

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("can't be closed while the rename is under way: Cancel disabled, no X, Escape and an outside click do nothing", async () => {
    let finish!: () => void;
    vi.spyOn(apiClient, "updateFleet").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(fleet({ label: "edge-dev" }));
        }),
    );
    const { user, onOpenChange, onRenamed } = await renderDialog();

    await rename(user, "edge-dev");

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(nameField()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Rename fleet" })).toBeInTheDocument();

    await act(async () => finish());
    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ends a rename that never answers at 30 s, saying the 503's words in the dialog (it may or may not have been made)", async () => {
    const updates = serveUpdates("hang");
    const { user, onOpenChange, onRenamed } = await renderDialog();
    await user.clear(nameField());
    await user.type(nameField(), "edge-dev");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(updates.signals[0]!.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(updates.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each([
    ["the rename", (settle: Settle) => settle.resolve(fleet({ label: "edge-dev" }))],
    ["a 404 fleet_not_found", (settle: Settle) => settle.reject(GONE())],
    ["a 503", (settle: Settle) => settle.reject(UNAVAILABLE())],
  ])("drops %s answered after the organization changed: no toast, no message, no reload", async (_why, answer) => {
    let finish!: () => void;
    vi.spyOn(apiClient, "updateFleet").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = () => answer({ resolve, reject });
        }),
    );
    const toastError = vi.spyOn(toast, "error");
    const onOpenChange = vi.fn();
    const onRenamed = vi.fn();
    const loader = vi.fn(() => null);

    function Page() {
      const [organizationId, setOrganizationId] = useState(GROUP_ID);
      return (
        <>
          <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
            Switch
          </button>
          <RenameFleetDialog open onOpenChange={onOpenChange} fleet={fleet()} organizationId={organizationId} onRenamed={onRenamed} />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/fleet-management", Component: Page, loader, HydrateFallback: () => null }]);
    render(<Stub initialEntries={["/fleet-management"]} />);
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Rename fleet" });
    const loads = loader.mock.calls.length;
    await rename(user, "edge-dev");
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));

    await act(async () => finish());

    expect(toastError).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalledTimes(loads);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens afresh: a reopened dialog holds the label again, with no earlier refusal", async () => {
    serveUpdates(LABEL_TAKEN());
    const { user } = await renderDialog();
    await rename(user, "edge-dev");
    await screen.findByText("Another of the organization's fleets has this label.");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(await screen.findByLabelText("Name")).toHaveValue("edge-prod");
    expect(screen.queryByText("Another of the organization's fleets has this label.")).toBeNull();
  });
});
