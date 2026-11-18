import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type CollectorGroup, type FleetType } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { expectNoAttributeHolds, expectTextOnlyInsideNoCapture, FLEET_ID, gatewaysGroup, GATEWAYS_GROUP_ID, kubernetesAnnotations } from "~/test/fleets.js";
import {
  confirmsGroupName,
  DELETE_GROUP_FAILED_MESSAGE,
  DeleteGroupDialog,
  GROUP_DELETE_CONFIRM_AFTER,
  GROUP_DELETE_CONFIRM_BEFORE,
  GROUP_DELETE_CONSEQUENCES,
  GROUP_DELETE_HELM,
  groupDeleteConfirmLabel,
} from "./DeleteGroupDialog.js";
import { GROUP_NOT_FOUND_MESSAGE } from "./GroupDialog.js";

/*
 * A group's delete (D17b-2 decisions 14 and 25; Preflight ruling 4; D17d-1
 * decisions 3 and 25, Preflight ruling 30: the typed name, both fleet types).
 * Deleting after confirming, then reloading the list, is tested in
 * `GroupsTab.test.tsx`; D17b-1's `DeleteCollectorDialog.test.tsx` is the
 * pattern here. Every flow but the typed name's own types the name first
 * (`renderDialog`).
 */

const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const GROUP_GONE = () => refusal("collector_group_not_found", "Collector group not found.", 404);
const RATE_LIMITED_WORDS = "Too many attempts. Please wait and try again.";

type Answer = "deleted" | "hang" | Error;

function serveDeletes(...answers: Answer[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "deleteCollectorGroup").mockImplementation((organizationId, fleetId, groupId, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    expect(groupId).toBe(GATEWAYS_GROUP_ID);
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

/**
 * The dialog open for `group` in GROUP_ID (on a `fleetType` fleet), with a Switch to another organization, a Reopen
 * and a Change group (the row replaced by `laterGroup`, as a poll does); a loader counts revalidations. The group's
 * name is typed to confirm unless `confirm` is false.
 */
async function renderDialog(
  group: CollectorGroup = gatewaysGroup(),
  { confirm = true, fleetType, laterGroup }: { confirm?: boolean; fleetType?: FleetType; laterGroup?: CollectorGroup } = {},
) {
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    const [shownGroup, setShownGroup] = useState(group);
    return (
      <>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <button type="button" onClick={() => laterGroup !== undefined && setShownGroup(laterGroup)}>
          Change group
        </button>
        <DeleteGroupDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          group={shownGroup}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          onDeleted={onDeleted}
          fleetType={fleetType}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  // An accessible name collapses white space: a name with two spaces in a row is found by one.
  await screen.findByRole("alertdialog", { name: `Delete ${group.name}`.replace(/\s+/g, " ") });
  if (confirm) await user.type(confirmField(group.name), group.name);
  return { user, onOpenChange, onDeleted, loader };
}

/** The typed-name input, found by its label: "Type {name} to confirm" (Ruling 70), white space collapsed as the query collapses the label's. */
const confirmField = (name = "gateways") => screen.getByLabelText(groupDeleteConfirmLabel(name).replace(/\s+/g, " "));
const deleteButton = () => screen.getByRole("button", { name: /^(Delete|Deleting\.\.\.)$/ });

describe("DeleteGroupDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has its title form and buttons, and D17d-1 decision 25's body on a server fleet, without the Helm release's words", async () => {
    await renderDialog(gatewaysGroup(), { confirm: false });
    const dialog = screen.getByRole("alertdialog", { name: "Delete gateways" });
    expect(GROUP_DELETE_CONSEQUENCES).toBe(
      "This deletes the group and its collectors' records. A collector installed into it that is still running keeps the configuration it has, but the fleet refuses its connections from then on: uninstall it, or reinstall it into another group. A collector moved into it from another group rejoins the group it was installed into.",
    );
    expect([GROUP_DELETE_CONFIRM_BEFORE, GROUP_DELETE_CONFIRM_AFTER]).toEqual(["Type", "to confirm"]);
    expect(groupDeleteConfirmLabel("gateways")).toBe("Type gateways to confirm");
    expect(dialog).toHaveTextContent(GROUP_DELETE_CONSEQUENCES);
    expect(dialog).not.toHaveTextContent(/Helm|Default group|deploy group|no longer receive updates/i);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("adds the Helm release's uninstall on a Kubernetes fleet", async () => {
    await renderDialog(gatewaysGroup(), { confirm: false, fleetType: "kubernetes-supervisor" });
    expect(GROUP_DELETE_HELM).toBe("Uninstall the group's Helm release in your cluster.");
    expect(screen.getByRole("alertdialog", { name: "Delete gateways" })).toHaveTextContent(`${GROUP_DELETE_CONSEQUENCES} ${GROUP_DELETE_HELM}`);
  });

  // D17d-2 decision 25; Preflight ruling 31.
  it("follows GROUP_DELETE_HELM with the gateway's quoted helm uninstall in a copy box inside ph-no-capture, outside the description", async () => {
    const namespace = "canary-delete-ns-5f0c";
    await renderDialog(gatewaysGroup({ annotations: kubernetesAnnotations({ namespace }) }), { confirm: false, fleetType: "kubernetes-supervisor" });
    const dialog = screen.getByRole("alertdialog", { name: "Delete gateways" });
    const copy = screen.getByRole("button", { name: "Copy uninstall command" });
    expect(copy.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe(`helm uninstall 'gateways' -n '${namespace}'`);
    expect(dialog).toHaveAccessibleDescription(`${GROUP_DELETE_CONSEQUENCES} ${GROUP_DELETE_HELM}`);
    expectNoAttributeHolds(namespace);
    expect(expectTextOnlyInsideNoCapture(namespace)).toBe(1);
  });

  it("keeps the opening's uninstall when the row changes under it (a poll: D17c-1 Ruling 66)", async () => {
    await renderDialog(gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "edge" }) }), {
      confirm: false,
      fleetType: "kubernetes-supervisor",
      laterGroup: gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "moved-namespace" }) }),
    });
    const code = () => screen.getByRole("button", { name: "Copy uninstall command" }).closest(".ph-no-capture")!.querySelector("code")!;
    expect(code().textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    fireEvent.click(screen.getByRole("button", { name: "Change group", hidden: true }));
    expect(code().textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("moved-namespace");
  });

  it.each([
    ["a gateway whose settings can't be read", "kubernetes-supervisor", gatewaysGroup({ annotations: { telflo: { kubernetes: "x" } } })],
    ["a gateway with no settings saved", "kubernetes-supervisor", gatewaysGroup()],
    // Ruling 49: where the Helm facts refuse the group; a gateway named telflo-node would otherwise name the Agent's release.
    ["a gateway whose stored role is the Agent's", "kubernetes-supervisor", gatewaysGroup({ annotations: kubernetesAnnotations({ role: "node", replicas: undefined }) })],
    ["a gateway named telflo-node", "kubernetes-supervisor", gatewaysGroup({ name: "telflo-node", annotations: kubernetesAnnotations() })],
    ["a server fleet's group", "server", gatewaysGroup({ annotations: kubernetesAnnotations() })],
  ] as const)("shows no uninstall for %s", async (_why, fleetType, group) => {
    await renderDialog(group, { confirm: false, fleetType });
    expect(screen.queryByRole("button", { name: "Copy uninstall command" })).toBeNull();
  });

  it("keeps Delete disabled until the typed text is the name exactly: case and inner spaces count, ASCII white space at the ends doesn't", async () => {
    const deletes = serveDeletes();
    const { user, onDeleted } = await renderDialog(gatewaysGroup({ name: "edge gateways" }), { confirm: false });
    const field = confirmField("edge gateways");
    expect(field).toHaveValue("");
    for (const typed of ["edge", "Edge gateways", "edge  gateways", "edge gateways!"]) {
      await user.clear(field);
      await user.type(field, typed);
      expect(deleteButton()).toBeDisabled();
    }
    await user.clear(field);
    await user.type(field, "  edge gateways ");
    expect(deleteButton()).toBeEnabled();
    await user.click(deleteButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(deletes.spy).toHaveBeenCalledTimes(1);
  });

  it("strips only ASCII white space (tab, line feed, carriage return, space), never a U+FEFF a name may hold at its ends", () => {
    expect(confirmsGroupName("\t\n\r gateways \r\n\t", "gateways")).toBe(true);
    expect(confirmsGroupName("gateways", "gateways")).toBe(true);
    // trim() would strip U+FEFF and U+00A0: a name ending in one must be typed with it.
    expect(confirmsGroupName("gateways", "gateways\uFEFF")).toBe(false);
    expect(confirmsGroupName("gateways\uFEFF", "gateways\uFEFF")).toBe(true);
    expect(confirmsGroupName("gateways\uFEFF", "gateways")).toBe(false);
    expect(confirmsGroupName("gateways\u00A0", "gateways")).toBe(false);
    expect(confirmsGroupName("GATEWAYS", "gateways")).toBe(false);
    expect(confirmsGroupName("", "gateways")).toBe(false);
  });

  it("checks the typed name again when Delete is pressed: a field changed under it sends nothing", async () => {
    const deletes = serveDeletes();
    await renderDialog();
    expect(deleteButton()).toBeEnabled();
    // The field's text changed without an input event (the state still says it matches): the handler reads the field.
    (confirmField() as HTMLInputElement).value = "gateway";
    fireEvent.click(deleteButton());
    expect(deletes.spy).not.toHaveBeenCalled();
  });

  it("shows the name bold in the label, white space kept, as text only, inside ph-no-capture with the input (Ruling 70, the owner's Q50)", async () => {
    const name = "edge  gateways-canary-7d2a";
    await renderDialog(gatewaysGroup({ name }), { confirm: false });
    const field = confirmField(name);
    const label = document.querySelector(`label[for="${field.id}"]`)!;
    expect(label).toHaveTextContent(groupDeleteConfirmLabel(name), { normalizeWhitespace: false });
    const bold = label.querySelector("span")!;
    expect(bold.textContent).toBe(name);
    expect(bold).toHaveClass("font-bold", "whitespace-pre-wrap");
    // Only the name is bold: the label's own words are normal weight (the Label component's font-medium overridden).
    expect(label).toHaveClass("font-normal");
    expect(label).not.toHaveClass("font-medium");
    expect(label.closest(".ph-no-capture")).toBe(field.closest(".ph-no-capture"));
    // The label's text holds the name only inside ph-no-capture, and no attribute anywhere holds it: not a placeholder,
    // not an aria-label, not a title, not a data-* (the title's "Delete {name}" is visible text in the masked shell).
    expect(expectTextOnlyInsideNoCapture(name, label)).toBe(1);
    expect(field).not.toHaveAttribute("placeholder");
    expect(field).not.toHaveAttribute("aria-label");
    expectNoAttributeHolds(name);
  });

  it("puts the typed text in an uncontrolled input inside ph-no-capture: no attribute ever holds it", async () => {
    const canary = "canary-typed-4b1e";
    await renderDialog(gatewaysGroup({ name: canary }), { confirm: false });
    const field = confirmField(canary);
    expect(field.closest(".ph-no-capture")).not.toBeNull();
    expect(document.querySelector(`label[for="${field.id}"]`)?.closest(".ph-no-capture")).not.toBeNull();
    expect(field).not.toHaveAttribute("value");
    expect(field).not.toHaveAttribute("placeholder");
    await userEvent.setup().type(field, `${canary}-x`);
    expect(field).toHaveValue(`${canary}-x`);
    expect(field).not.toHaveAttribute("value");
    expectNoAttributeHolds(`${canary}-x`);
    expectNoAttributeHolds(canary);
  });

  it('deletes, says "Deleting..." and stays open until the API answers, then toasts "Group deleted", closes and reloads', async () => {
    let finish!: () => void;
    const spy = vi.spyOn(apiClient, "deleteCollectorGroup").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(deleteButton());
    expect(spy).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { signal: expect.any(AbortSignal) });
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => finish());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith("Group deleted");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends once on a double click", async () => {
    const deletes = serveDeletes("hang");
    await renderDialog();
    fireEvent.click(deleteButton());
    fireEvent.click(deleteButton());
    expect(deletes.spy).toHaveBeenCalledTimes(1);
  });

  it('counts a 404 collector_group_not_found as deleted: toasts "Group not found", closes and reloads', async () => {
    serveDeletes(GROUP_GONE());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(deleteButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(GROUP_NOT_FOUND_MESSAGE);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on a 404 fleet_not_found, toasts the API's words, closes and reloads (the page then shows Fleet not found)", async () => {
    serveDeletes(refusal("fleet_not_found", "Fleet not found.", 404));
    const toastError = vi.spyOn(toast, "error");
    const { user, onDeleted } = await renderDialog();

    await user.click(deleteButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Fleet not found.");
  });

  it.each([
    ["a 503 fleets_unavailable", UNAVAILABLE],
    ["a 500", () => refusal("internal_error", "Something went wrong.", 500)],
    ["no connection", () => new ApiError("network_error", "Could not reach the server.")],
    ["a reply that doesn't parse", () => new ApiError("unexpected_response", "The server sent a response that could not be read.")],
  ])("on an unknown outcome (%s), toasts the 503's words, closes and reloads", async (_why, failure) => {
    serveDeletes(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(deleteButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ends a delete that never answers at 30 s: toasts the 503's words, closes and reloads", async () => {
    const deletes = serveDeletes("hang");
    const toastError = vi.spyOn(toast, "error");
    const { onDeleted } = await renderDialog();

    vi.useFakeTimers();
    fireEvent.click(deleteButton());
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(deletes.signals[0]!.aborted).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(deletes.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
  });

  it.each([
    ["a 429, its own words", () => refusal("rate_limited", RATE_LIMITED_WORDS, 429), RATE_LIMITED_WORDS],
    [
      "a 409 collector_group_is_default, its own words",
      () => refusal("collector_group_is_default", "The Default group can't be renamed or deleted.", 409),
      "The Default group can't be renamed or deleted.",
    ],
    ["a 400, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), DELETE_GROUP_FAILED_MESSAGE],
  ])("on %s, toasts and stays open for another try", async (_why, failure, words) => {
    serveDeletes(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(deleteButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(words));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    serveDeletes(failure());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted, loader } = await renderDialog();
    const loads = loader.mock.calls.length;

    await user.click(deleteButton());

    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    serveDeletes(refusal("unauthenticated", "You need to sign in.", 401));
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderDialog();

    await user.click(deleteButton());

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    expect(toastError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("can't be closed while deleting: Cancel disabled, Escape does nothing", async () => {
    serveDeletes("hang");
    const { user, onOpenChange } = await renderDialog();

    await user.click(deleteButton());

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("closes on Cancel without a request", async () => {
    const deletes = serveDeletes();
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(deletes.spy).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it.each([
    ["the delete", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.resolve()],
    ["a 404", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.reject(GROUP_GONE())],
    ["a 503", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.reject(UNAVAILABLE())],
  ])("drops %s answered after the organization changed: no toast, no close, no reload", async (_why, answer) => {
    let settle!: { resolve: () => void; reject: (failure: unknown) => void };
    vi.spyOn(apiClient, "deleteCollectorGroup").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve: () => resolve(undefined), reject };
        }),
    );
    const toastError = vi.spyOn(toast, "error");
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(deleteButton());
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await act(async () => answer(settle));

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("opens afresh after a refused delete and a Cancel: the typed name gone, Delete disabled until it is typed again", async () => {
    serveDeletes(refusal("rate_limited", RATE_LIMITED_WORDS, 429));
    const { user } = await renderDialog();
    await user.click(deleteButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(await screen.findByRole("button", { name: "Delete" })).toBeDisabled();
    expect(confirmField()).toHaveValue("");
    await user.type(confirmField(), "gateways");
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("holds no group name in an attribute (decision 34)", async () => {
    const canary = "canary-group-7f3a";
    await renderDialog(gatewaysGroup({ name: canary }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(`Delete ${canary}`);
    expectNoAttributeHolds(canary);
  });
});
