import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type Collector, type CollectorGroup, type FleetType } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import {
  COLLECTOR_ID,
  collector,
  collectorGroup,
  DEFAULT_GROUP_ID,
  expectNoAttributeHolds,
  expectTextOnlyInsideNoCapture,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  kubernetesAnnotations,
} from "~/test/fleets.js";
import { COLLECTOR_UNINSTALL_WORDS } from "./HelmUninstall.js";
import { COLLECTOR_NOT_FOUND_MESSAGE } from "./CollectorDetailsDialog.js";
import {
  COLLECTOR_DELETE_CONSEQUENCES,
  DELETE_COLLECTOR_FAILED_MESSAGE,
  DeleteCollectorDialog,
} from "./DeleteCollectorDialog.js";

/*
 * "Delete collector record". `DeleteFleetDialog.test.tsx` is the pattern.
 */

const refusal = (code: string, message: string, status: number) => new ApiError(code, message, { status });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const COLLECTOR_GONE = () => refusal("collector_not_found", "Collector not found.", 404);

type Answer = "deleted" | "hang" | Error;

function serveDeletes(...answers: Answer[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const spy = vi.spyOn(apiClient, "deleteCollector").mockImplementation((organizationId, fleetId, collectorId, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    expect(collectorId).toBe(COLLECTOR_ID);
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
 * The dialog open for `row` in GROUP_ID, with a Switch to another organization, a Reopen and a Change groups (the tab's
 * groups replaced by `laterGroups`, as a poll does); a loader counts revalidations.
 */
async function renderDialog(
  row: Collector = collector(),
  fleetType?: FleetType,
  groups?: readonly CollectorGroup[] | null,
  laterGroups?: readonly CollectorGroup[] | null,
) {
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    const [shownGroups, setShownGroups] = useState(groups);
    return (
      <>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <button type="button" onClick={() => laterGroups !== undefined && setShownGroups(laterGroups)}>
          Change groups
        </button>
        <DeleteCollectorDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          collector={row}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          {...(fleetType === undefined ? {} : { fleetType })}
          {...(shownGroups === undefined ? {} : { groups: shownGroups })}
          onDeleted={onDeleted}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  await screen.findByRole("alertdialog", { name: "Delete collector record" });
  return { user, onOpenChange, onDeleted, loader };
}

const deleteButton = () => screen.getByRole("button", { name: /^(Delete|Deleting\.\.\.)$/ });

describe("DeleteCollectorDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has its title and buttons, and the consequences body in place of \"not affected\"", async () => {
    await renderDialog();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(`You are deleting the record of web-01. ${COLLECTOR_DELETE_CONSEQUENCES}`);
    expect(dialog).toHaveTextContent(
      "If the collector keeps polling, it enrolls again as a new collector: in the group it was installed into, unpinned, with no error history, and it is sent that group's published version if it has one. If that group has been deleted, it can't enroll again.",
    );
    // A collector naming no group is refused, so none enrolls into Default.
    expect(dialog).not.toHaveTextContent(/Default/);
    expect(dialog).not.toHaveTextContent(/pod/);
    expect(dialog).not.toHaveTextContent("not affected");
    // No import warning, the consequences alone.
    expect(dialog).not.toHaveTextContent(/import/i);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("on a Kubernetes-supervisor fleet, says deleting the record just forgets the collector and a running pod enrolls again", async () => {
    const name = "canary-pod-7f3a";
    await renderDialog(collector({ name }), "kubernetes-supervisor");
    const dialog = screen.getByRole("alertdialog", { name: "Delete collector record" });
    expect(dialog).toHaveTextContent(`Deleting the record just forgets ${name}: a pod still running enrolls again on its next poll.`);
    expect(dialog).not.toHaveTextContent("You are deleting the record of");
    expect(dialog).not.toHaveTextContent(COLLECTOR_DELETE_CONSEQUENCES);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expectNoAttributeHolds(name);
  });

  it('deletes, says "Deleting..." and stays open until the API answers, then toasts "Deleted record for {name}", closes and reloads', async () => {
    let finish!: () => void;
    vi.spyOn(apiClient, "deleteCollector").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(deleteButton());
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => finish());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith("Deleted record for web-01");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends once on a double click", async () => {
    const deletes = serveDeletes("hang");
    await renderDialog();
    fireEvent.click(deleteButton());
    fireEvent.click(deleteButton());
    expect(deletes.spy).toHaveBeenCalledTimes(1);
  });

  it('counts a 404 collector_not_found as deleted: toasts "Collector not found", closes and reloads', async () => {
    serveDeletes(COLLECTOR_GONE());
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onDeleted } = await renderDialog();

    await user.click(deleteButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(COLLECTOR_NOT_FOUND_MESSAGE);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on a 404 fleet_not_found, toasts the API's words, closes and reloads (the grid then shows Fleet not found)", async () => {
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
    ["a 429, its own words", () => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429), "Too many attempts. Please wait and try again."],
    ["a 400, the fallback", () => refusal("invalid_request", "The request was not valid.", 400), DELETE_COLLECTOR_FAILED_MESSAGE],
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
    ["a 404", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.reject(COLLECTOR_GONE())],
    ["a 503", (finish: { resolve: () => void; reject: (failure: unknown) => void }) => finish.reject(UNAVAILABLE())],
  ])("drops %s answered after the organization changed: no toast, no close, no reload", async (_why, answer) => {
    let settle!: { resolve: () => void; reject: (failure: unknown) => void };
    vi.spyOn(apiClient, "deleteCollector").mockImplementation(
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

  it("opens afresh: no \"Deleting...\" left from an opening a write outlived", async () => {
    serveDeletes(refusal("rate_limited", "Too many attempts. Please wait and try again.", 429));
    const { user } = await renderDialog();
    await user.click(deleteButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(await screen.findByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("holds no collector name in an attribute", async () => {
    const canary = "canary-collector-7f3a";
    await renderDialog(collector({ name: canary }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(canary);
    expectNoAttributeHolds(canary);
  });
});

// How to stop a Kubernetes collector's pods.
describe("DeleteCollectorDialog's helm uninstall line", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const box = () => screen.getByRole("button", { name: "Copy uninstall command" }).closest(".ph-no-capture") as HTMLElement;

  it("names the collector's group's release in its namespace, quoted, in a copy box inside ph-no-capture and outside the description", async () => {
    const gateway = "canary-uninstall-gw-4e2a";
    const namespace = "canary-uninstall-ns-9c1b";
    const groups = [collectorGroup(), gatewaysGroup({ name: gateway, annotations: kubernetesAnnotations({ namespace }) })];
    await renderDialog(collector({ groupId: GATEWAYS_GROUP_ID }), "kubernetes-supervisor", groups);
    const dialog = screen.getByRole("alertdialog", { name: "Delete collector record" });
    expect(dialog).toHaveTextContent(COLLECTOR_UNINSTALL_WORDS);
    expect(COLLECTOR_UNINSTALL_WORDS).toBe("To stop it, uninstall its group's Helm release: this removes all of the group's pods, not just this one.");
    expect(box().querySelector("code")!.textContent).toBe(`helm uninstall '${gateway}' -n '${namespace}'`);
    expect(dialog).not.toHaveAccessibleDescription(new RegExp("helm uninstall"));
    for (const text of [gateway, namespace]) {
      expectNoAttributeHolds(text);
      expect(expectTextOnlyInsideNoCapture(text)).toBe(1);
    }
  });

  it("names the Agent's release telflo-node in the default namespace when its settings were never saved", async () => {
    await renderDialog(collector({ groupId: DEFAULT_GROUP_ID }), "kubernetes-supervisor", [collectorGroup()]);
    expect(box().querySelector("code")!.textContent).toBe("helm uninstall 'telflo-node' -n 'telflo-collectors'");
  });

  it.each([
    ["the groups unread", null],
    ["its group not among them", [collectorGroup()]],
    ["its settings unreadable", [collectorGroup(), gatewaysGroup({ annotations: { telflo: { kubernetes: "x" } } })]],
    ["a gateway with no settings", [collectorGroup(), gatewaysGroup()]],
  ] as const)("says nothing of an uninstall with %s", async (_why, groups) => {
    await renderDialog(collector({ groupId: GATEWAYS_GROUP_ID }), "kubernetes-supervisor", groups);
    expect(screen.queryByRole("button", { name: "Copy uninstall command" })).toBeNull();
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent(COLLECTOR_UNINSTALL_WORDS);
  });

  it("keeps the opening's uninstall line when the tab's groups change under it (a poll)", async () => {
    const opened = [collectorGroup(), gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "edge" }) })];
    const later = [collectorGroup(), gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "moved-namespace" }) })];
    await renderDialog(collector({ groupId: GATEWAYS_GROUP_ID }), "kubernetes-supervisor", opened, later);
    expect(box().querySelector("code")!.textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    fireEvent.click(screen.getByRole("button", { name: "Change groups", hidden: true }));
    expect(box().querySelector("code")!.textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("moved-namespace");
  });

  it("says nothing of Helm on a server fleet", async () => {
    await renderDialog(collector({ groupId: GATEWAYS_GROUP_ID }), "server", [gatewaysGroup({ annotations: kubernetesAnnotations() })]);
    expect(screen.queryByRole("button", { name: "Copy uninstall command" })).toBeNull();
  });
});
