import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { FLEETS_UNAVAILABLE_MESSAGE, type Collector, type CollectorGroup, type FleetType } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import {
  clusterGroup,
  CLUSTER_GROUP_ID,
  collectorGroup,
  DEFAULT_GROUP_ID,
  expectNoAttributeHolds,
  expectTextOnlyInsideNoCapture,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  kubernetesAnnotations,
  manyCollectors,
  SECOND_GATEWAY_GROUP_ID,
} from "~/test/fleets.js";
import { BULK_UNINSTALL_WORDS } from "./HelmUninstall.js";
import { BULK_DELETE_CONSEQUENCES, BulkDeleteDialog, DELETE_UNKNOWN_WORDS, deletingWords } from "./BulkDeleteDialog.js";
import { COLLECTOR_DELETE_CONSEQUENCES, DELETE_COLLECTOR_FAILED_MESSAGE } from "./DeleteCollectorDialog.js";

/*
 * "Delete collectors": the count and the consequence lines (no import
 * warning), then the selected collectors deleted one at a time through
 * `runPacedWrites` (its own tests pin the loop).
 */

const refusal = (code: string, message: string, status: number, options: { retryAfterSeconds?: number } = {}) =>
  new ApiError(code, message, { status, ...options });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const COLLECTOR_GONE = () => refusal("collector_not_found", "Collector not found.", 404);
const RATE_LIMITED = (seconds: number) => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429, { retryAfterSeconds: seconds });

type Answer = "deleted" | "hold" | "hang" | Error;

interface Sent {
  collectorId: string;
  resolve: () => void;
}

function serveDeletes(...answers: Answer[]) {
  const sent: Sent[] = [];
  const spy = vi.spyOn(apiClient, "deleteCollector").mockImplementation((organizationId, fleetId, collectorId, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    const answer = answers.shift() ?? "deleted";
    return new Promise<undefined>((resolve, reject) => {
      const each: Sent = { collectorId, resolve: () => resolve(undefined) };
      sent.push(each);
      if (answer === "deleted") each.resolve();
      else if (answer === "hang") {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      } else if (answer instanceof Error) reject(answer);
    });
  });
  return { spy, sent, ids: () => sent.map((each) => each.collectorId) };
}

const ROWS = (count = 3) => manyCollectors(count);


/**
 * The dialog open for `rows` in GROUP_ID; Switch changes the organization and closes it (as the tab does); Change groups
 * replaces the tab's groups with `laterGroups` (a poll); a loader counts revalidations.
 */
async function renderDelete(
  rows: Collector[] = ROWS(),
  {
    closeOnSwitch = true,
    fleetType,
    groups,
    laterGroups,
  }: { closeOnSwitch?: boolean; fleetType?: FleetType; groups?: readonly CollectorGroup[] | null; laterGroups?: readonly CollectorGroup[] | null } = {},
) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    const [shownGroups, setShownGroups] = useState(groups);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOrganizationId(PERSONAL_ID);
            if (closeOnSwitch) setOpen(false);
          }}
        >
          Switch
        </button>
        <button type="button" onClick={() => laterGroups !== undefined && setShownGroups(laterGroups)}>
          Change groups
        </button>
        <BulkDeleteDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          collectors={rows}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          {...(fleetType === undefined ? {} : { fleetType })}
          {...(shownGroups === undefined ? {} : { groups: shownGroups })}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  await screen.findByRole("alertdialog", { name: "Delete collectors" });
  return { user, onOpenChange, onChanged, loader };
}

const status = () => screen.getByRole("status");
const resultRows = () => within(screen.getByRole("alertdialog")).queryAllByRole("listitem").map((each) => each.textContent);

async function advance(milliseconds = 0) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BulkDeleteDialog", () => {
  it("says the count and the consequence lines, and no import warning", async () => {
    const deletes = serveDeletes();
    await renderDelete();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(`You are deleting the records of 3 collectors. ${BULK_DELETE_CONSEQUENCES}`);
    // The consequence words, for any of several: "a collector", where the single dialog's name the one.
    expect(BULK_DELETE_CONSEQUENCES).toBe(COLLECTOR_DELETE_CONSEQUENCES.replace("If the collector keeps polling", "If a collector keeps polling"));
    // A collector naming no group is refused, so none enrolls into Default.
    expect(BULK_DELETE_CONSEQUENCES).toBe(
      "If a collector keeps polling, it enrolls again as a new collector: in the group it was installed into, unpinned, with no error history, and it is sent that group's published version if it has one. If that group has been deleted, it can't enroll again.",
    );
    expect(dialog).not.toHaveTextContent(/Default|pod/);
    expect(dialog).not.toHaveTextContent(/import/i);
    expect(screen.getByRole("button", { name: "Delete 3" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(deletes.spy).not.toHaveBeenCalled();
    expect(deletingWords(1)).toBe("You are deleting the record of 1 collector.");
  });

  it("on a Kubernetes-supervisor fleet, says deleting a record just forgets it and a running pod enrolls again", async () => {
    const deletes = serveDeletes();
    await renderDelete(ROWS(), { fleetType: "kubernetes-supervisor" });
    const dialog = screen.getByRole("alertdialog", { name: "Delete collectors" });
    expect(dialog).toHaveTextContent(
      "You are deleting the records of 3 collectors. Deleting a record just forgets it: a pod still running enrolls again on its next poll.",
    );
    expect(dialog).not.toHaveTextContent(BULK_DELETE_CONSEQUENCES);
    expect(screen.getByRole("button", { name: "Delete 3" })).toBeEnabled();
    expect(deletes.spy).not.toHaveBeenCalled();
  });

  it("is bounded to the window and scrolls, as the other bulk dialogs: a long results list stays reachable", async () => {
    serveDeletes();
    await renderDelete();
    expect(screen.getByRole("alertdialog")).toHaveClass("max-h-[90vh]", "overflow-y-auto");
  });

  it('deletes several, one request at a time, saying where it is, a collector_not_found counted as deleted, then "Deleted {k}"', async () => {
    const deletes = serveDeletes("hold", COLLECTOR_GONE(), "hold");
    const { user, onChanged } = await renderDelete();
    await user.click(screen.getByRole("button", { name: "Delete 3" }));

    expect(await screen.findByText("Deleting 1 of 3…")).toBeInTheDocument();
    expect(deletes.ids()).toEqual([ROWS()[0]!.id]);
    await act(async () => deletes.sent[0]!.resolve());
    expect(await screen.findByText("Deleting 3 of 3…")).toBeInTheDocument();
    expect(deletes.ids()).toEqual(ROWS().map((row) => row.id));
    await act(async () => deletes.sent[2]!.resolve());

    expect(await screen.findByText("Deleted 3")).toBeInTheDocument();
    expect(resultRows()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("stops on an unknown outcome: May or may not have been deleted, the rest Not attempted; a refusal goes on with its words", async () => {
    const deletes = serveDeletes(refusal("invalid_request", "The request was not valid.", 400), "deleted", UNAVAILABLE());
    const { user } = await renderDelete(ROWS(4));
    await user.click(screen.getByRole("button", { name: "Delete 4" }));

    expect(await screen.findByText("Deleted 1")).toBeInTheDocument();
    expect(resultRows()).toEqual([
      `collector-001${DELETE_COLLECTOR_FAILED_MESSAGE}`,
      `collector-003${DELETE_UNKNOWN_WORDS}`,
      "collector-004Not attempted",
    ]);
    expect(DELETE_UNKNOWN_WORDS).toBe("May or may not have been deleted");
    expect(deletes.spy).toHaveBeenCalledTimes(3);
  });

  it("ends a delete that never answers at 30 s as an unknown outcome (fake timers)", async () => {
    const deletes = serveDeletes("hang");
    await renderDelete();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Delete 3" }));
    await advance(FLEET_WRITE_TIMEOUT_MS - 1);
    expect(status()).toHaveTextContent("Deleting 1 of 3…");
    await advance(1);
    expect(screen.getByText("Deleted 0")).toBeInTheDocument();
    expect(resultRows()).toEqual([`collector-001${DELETE_UNKNOWN_WORDS}`, "collector-002Not attempted", "collector-003Not attempted"]);
    expect(deletes.spy).toHaveBeenCalledTimes(1);
  });

  it("waits out a 429's Retry-After, then deletes that collector again (fake timers)", async () => {
    const deletes = serveDeletes(RATE_LIMITED(2));
    await renderDelete();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Delete 3" }));
    await advance();
    expect(status()).toHaveTextContent("Deleting 1 of 3… (waiting 2 seconds: too many requests)");
    await advance(1_999);
    expect(deletes.spy).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(deletes.ids()).toEqual([ROWS()[0]!.id, ...ROWS().map((row) => row.id)]);
    expect(screen.getByText("Deleted 3")).toBeInTheDocument();
  });

  it("stops after the request in flight on Stop, the rest Not attempted", async () => {
    const deletes = serveDeletes("hold");
    const { user } = await renderDelete();
    await user.click(screen.getByRole("button", { name: "Delete 3" }));
    await screen.findByText("Deleting 1 of 3…");

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    await act(async () => deletes.sent[0]!.resolve());

    expect(await screen.findByText("Deleted 1")).toBeInTheDocument();
    expect(resultRows()).toEqual(["collector-002Not attempted", "collector-003Not attempted"]);
    expect(deletes.spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, stops, closes, reloads the grid and revalidates the layout", async (_why, failure) => {
    const deletes = serveDeletes(failure());
    const { user, onOpenChange, onChanged, loader } = await renderDelete();
    const loads = loader.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Delete 3" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(deletes.spy).toHaveBeenCalledTimes(1);
  });

  it("can't be closed while it runs: no Cancel, Escape does nothing; closed after, it reloads the grid and the fleet", async () => {
    const deletes = serveDeletes("hold");
    const { user, onOpenChange, onChanged } = await renderDelete();
    await user.click(screen.getByRole("button", { name: "Delete 3" }));
    await screen.findByText("Deleting 1 of 3…");

    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await act(async () => deletes.sent[0]!.resolve());
    await screen.findByText("Deleted 3");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("closes on Cancel with no request and no reload", async () => {
    const deletes = serveDeletes();
    const { user, onOpenChange, onChanged } = await renderDelete();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(deletes.spy).not.toHaveBeenCalled();
  });

  it("starts once on a double click", async () => {
    const deletes = serveDeletes("hold");
    await renderDelete();
    const remove = screen.getByRole("button", { name: "Delete 3" });
    // Both clicks before React renders again.
    act(() => {
      fireEvent.click(remove);
      fireEvent.click(remove);
    });
    await screen.findByText("Deleting 1 of 3…");
    expect(deletes.spy).toHaveBeenCalledTimes(1);
  });

  it("stops when closed by an organization switch, and drops what comes after", async () => {
    const deletes = serveDeletes("hold");
    const { user, onChanged } = await renderDelete();
    await user.click(screen.getByRole("button", { name: "Delete 3" }));
    await screen.findByText("Deleting 1 of 3…");

    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await act(async () => deletes.sent[0]!.resolve());

    expect(deletes.spy).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("stops when another organization becomes active while it is open, and drops its results", async () => {
    const deletes = serveDeletes("hold");
    const { user, onOpenChange, onChanged } = await renderDelete(ROWS(), { closeOnSwitch: false });
    await user.click(screen.getByRole("button", { name: "Delete 3" }));
    await screen.findByText("Deleting 1 of 3…");

    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await act(async () => deletes.sent[0]!.resolve());

    expect(deletes.spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^Deleted/)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("holds no collector name in an attribute: the confirmation, the run, the results", async () => {
    const names = ["canary-collector-4f71", "canary-collector-5a82", "canary-collector-6b93"];
    const rows = ROWS().map((row, index) => ({ ...row, name: names[index]! }));
    const deletes = serveDeletes("hold", refusal("invalid_request", "The request was not valid.", 400), UNAVAILABLE());
    const { user } = await renderDelete(rows);
    for (const text of names) expectNoAttributeHolds(text);

    await user.click(screen.getByRole("button", { name: "Delete 3" }));
    await screen.findByText("Deleting 1 of 3…");
    for (const text of names) expectNoAttributeHolds(text);
    await act(async () => deletes.sent[0]!.resolve());

    expect(await screen.findByText("Deleted 1")).toBeInTheDocument();
    expect(resultRows()).toHaveLength(2);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(names[2]!);
    for (const text of names) expectNoAttributeHolds(text);
  });
});

// The selected pods' groups' releases.
describe("BulkDeleteDialog's helm uninstall lines", () => {
  it("lists one quoted helm uninstall per distinct group among the selected, in the fleet's order, in one copy box; those it can't name left out", async () => {
    const groups = [
      collectorGroup(),
      gatewaysGroup({ id: SECOND_GATEWAY_GROUP_ID, name: "alpha", annotations: kubernetesAnnotations({ namespace: "edge" }) }),
      clusterGroup({ annotations: kubernetesAnnotations({ role: "cluster", namespace: "monitoring", replicas: undefined }) }),
      gatewaysGroup({ annotations: { telflo: { kubernetes: 1 } } }),
    ];
    const [a, b, c, d, e] = manyCollectors(5);
    const rows = [
      { ...a!, groupId: SECOND_GATEWAY_GROUP_ID },
      { ...b!, groupId: CLUSTER_GROUP_ID },
      { ...c!, groupId: DEFAULT_GROUP_ID },
      { ...d!, groupId: SECOND_GATEWAY_GROUP_ID },
      { ...e!, groupId: GATEWAYS_GROUP_ID },
    ];
    await renderDelete(rows, { fleetType: "kubernetes-supervisor", groups });
    const dialog = screen.getByRole("alertdialog", { name: "Delete collectors" });
    expect(dialog).toHaveTextContent(BULK_UNINSTALL_WORDS);
    expect(BULK_UNINSTALL_WORDS).toBe("To stop them, uninstall their groups' Helm releases: this removes all of each group's pods.");
    const box = within(dialog).getByRole("button", { name: "Copy uninstall commands" }).closest(".ph-no-capture") as HTMLElement;
    expect(box.querySelector("code")!.textContent).toBe(
      ["helm uninstall 'telflo-node' -n 'telflo-collectors'", "helm uninstall 'telflo-cluster' -n 'monitoring'", "helm uninstall 'alpha' -n 'edge'"].join("\n"),
    );
    expect(within(dialog).getAllByRole("button", { name: /^Copy uninstall/ })).toHaveLength(1);
    for (const text of ["alpha", "edge", "monitoring"]) expectNoAttributeHolds(text);
    expect(expectTextOnlyInsideNoCapture("monitoring")).toBe(1);
  });

  it("keeps the opening's uninstall lines when the tab's groups change under it (a poll)", async () => {
    const opened = [collectorGroup(), gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "edge" }) })];
    const later = [collectorGroup(), gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "moved-namespace" }) })];
    const rows = ROWS(2).map((row) => ({ ...row, groupId: GATEWAYS_GROUP_ID }));
    await renderDelete(rows, { fleetType: "kubernetes-supervisor", groups: opened, laterGroups: later });
    const code = () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Copy uninstall commands" }).closest(".ph-no-capture")!.querySelector("code")!;
    expect(code().textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    fireEvent.click(screen.getByRole("button", { name: "Change groups", hidden: true }));
    expect(code().textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("moved-namespace");
  });

  it.each([
    ["the groups unread", "kubernetes-supervisor", null],
    ["a server fleet", "server", [collectorGroup(), gatewaysGroup({ annotations: kubernetesAnnotations() })]],
  ] as const)("says nothing of an uninstall with %s", async (_why, fleetType, groups) => {
    const rows = ROWS(2).map((row) => ({ ...row, groupId: GATEWAYS_GROUP_ID }));
    await renderDelete(rows, { fleetType, groups });
    expect(screen.queryByRole("button", { name: "Copy uninstall commands" })).toBeNull();
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent(BULK_UNINSTALL_WORDS);
  });
});
