import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { FLEETS_UNAVAILABLE_MESSAGE, type Collector, type CollectorGroup, type FleetType, type UpdateCollectorRequest } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import {
  CLUSTER_GROUP_ID,
  collector,
  collectorGroup,
  expectNoAttributeHolds,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  kubernetesGroups,
  manyCollectors,
} from "~/test/fleets.js";
import { BulkMoveDialog, MOVE_COLLECTOR_FAILED_MESSAGE, MOVE_UNKNOWN_WORDS } from "./BulkMoveDialog.js";
import { GROUPS_UNREADABLE_WORDS } from "./EditCollectorDialog.js";

/*
 * "Move collectors": the selected collectors moved one at a time through
 * `runPacedWrites` (its own tests pin the loop:
 * `lib/paced-writes.test.ts`).
 */

const refusal = (code: string, message: string, status: number, options: { retryAfterSeconds?: number } = {}) =>
  new ApiError(code, message, { status, ...options });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const COLLECTOR_GONE = () => refusal("collector_not_found", "Collector not found.", 404);
const RATE_LIMITED = (seconds: number) => refusal("rate_limited", "Too many attempts. Please wait and try again.", 429, { retryAfterSeconds: seconds });
const GROUP_GONE = () => refusal("collector_group_not_found", "Collector group not found.", 404);

/** "hold" leaves the answer to the test; "hang" answers only the hang guard's abort. */
type Answer = "moved" | "hold" | "hang" | Error;

interface Sent {
  collectorId: string;
  request: UpdateCollectorRequest;
  resolve: () => void;
  reject: (failure: unknown) => void;
}

/** The moves, answered in turn by `answers` (then "moved"), each recorded. */
function serveMoves(...answers: Answer[]) {
  const sent: Sent[] = [];
  const spy = vi.spyOn(apiClient, "updateCollector").mockImplementation((organizationId, fleetId, collectorId, request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    const answer = answers.shift() ?? "moved";
    return new Promise<Collector>((resolve, reject) => {
      const each: Sent = { collectorId, request, resolve: () => resolve(collector({ id: collectorId })), reject };
      sent.push(each);
      if (answer === "moved") each.resolve();
      else if (answer === "hang") {
        options.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
      } else if (answer instanceof Error) reject(answer);
    });
  });
  return { spy, sent, ids: () => sent.map((each) => each.collectorId) };
}

const ROWS = (count = 3) => manyCollectors(count);
const GROUPS = (): CollectorGroup[] => [collectorGroup(), gatewaysGroup()];

/** The dialog open for `rows` in GROUP_ID; Switch changes the organization and closes it (as the tab does); a loader counts revalidations. */
async function renderMove(
  rows: Collector[] = ROWS(),
  groups: CollectorGroup[] | null = GROUPS(),
  { closeOnSwitch = true, fleetType }: { closeOnSwitch?: boolean; fleetType?: FleetType } = {},
) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
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
        <BulkMoveDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          collectors={rows}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          groups={groups}
          {...(fleetType === undefined ? {} : { fleetType })}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  const { unmount } = render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  await screen.findByRole("dialog", { name: "Move collectors" });
  return { user, onOpenChange, onChanged, loader, unmount };
}

type User = ReturnType<typeof userEvent.setup>;

async function chooseGateways(user: User) {
  await user.click(screen.getByRole("combobox", { name: "Group" }));
  await user.click(await screen.findByRole("option", { name: "gateways" }));
}

const status = () => screen.getByRole("status");
/** The footer's Close: after a run, the dialog's only Close (no X). */
const closeButton = () => screen.getByRole("button", { name: "Close" });
/** The results' rows: each collector not moved, with its words. */
const resultRows = () => within(screen.getByRole("dialog")).queryAllByRole("listitem").map((each) => each.textContent);

/** Lets the answers settle and the timers run, as far as `milliseconds` (fake timers). */
async function advance(milliseconds = 0) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BulkMoveDialog", () => {
  it("opens with the count, a Group Select of ids, and Move disabled until a group is chosen", async () => {
    const moves = serveMoves();
    const { user } = await renderMove();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Move the 3 selected collectors to another of the fleet's groups, one at a time.");
    expect(screen.getByRole("button", { name: "Move 3" })).toBeDisabled();

    await chooseGateways(user);
    expect(screen.getByRole("button", { name: "Move 3" })).toBeEnabled();
    expect(moves.spy).not.toHaveBeenCalled();
  });

  it("moves each collector to the group chosen, one request at a time, saying where it is, then \"Moved {k}\"", async () => {
    const moves = serveMoves("hold", "hold", "hold");
    const { user, onChanged } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));

    expect(await screen.findByText("Moving 1 of 3…")).toBeInTheDocument();
    expect(moves.ids()).toEqual([ROWS()[0]!.id]);
    expect(moves.sent[0]!.request).toEqual({ groupId: GATEWAYS_GROUP_ID });

    await act(async () => moves.sent[0]!.resolve());
    expect(await screen.findByText("Moving 2 of 3…")).toBeInTheDocument();
    expect(moves.ids()).toEqual([ROWS()[0]!.id, ROWS()[1]!.id]);

    await act(async () => moves.sent[1]!.resolve());
    await screen.findByText("Moving 3 of 3…");
    await act(async () => moves.sent[2]!.resolve());

    expect(await screen.findByText("Moved 3")).toBeInTheDocument();
    expect(resultRows()).toEqual([]);
    expect(moves.sent.map((each) => each.request)).toEqual(Array(3).fill({ groupId: GATEWAYS_GROUP_ID }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("on a Kubernetes-supervisor fleet, names the Agent and the Cluster by role, listed Agent, Cluster, then the gateways, and moves by id", async () => {
    const moves = serveMoves();
    const { user } = await renderMove(ROWS(1), kubernetesGroups(), { fleetType: "kubernetes-supervisor" });
    await user.click(screen.getByRole("combobox", { name: "Group" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Agent", "Cluster", "alpha", "gateways"]);
    await user.click(screen.getByRole("option", { name: "Cluster" }));
    expect(screen.getByRole("combobox", { name: "Group" })).toHaveTextContent(/^Cluster$/);
    await user.click(screen.getByRole("button", { name: "Move 1" }));
    expect(await screen.findByText("Moved 1")).toBeInTheDocument();
    expect(moves.sent.map((each) => each.request)).toEqual([{ groupId: CLUSTER_GROUP_ID }]);
  });

  it("on a server fleet, lists the groups by name in the API's order, a group named cluster as any other", async () => {
    serveMoves();
    const { user } = await renderMove(ROWS(1), kubernetesGroups());
    await user.click(screen.getByRole("combobox", { name: "Group" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Default", "alpha", "cluster", "gateways"]);
  });

  it("waits out a 429's Retry-After in the middle, saying so, then tries that collector again (fake timers)", async () => {
    const moves = serveMoves("moved", RATE_LIMITED(5), "moved", "moved");
    const { user } = await renderMove();
    await chooseGateways(user);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Move 3" }));
    await advance();
    expect(status()).toHaveTextContent("Moving 2 of 3… (waiting 5 seconds: too many requests)");
    expect(moves.ids()).toEqual([ROWS()[0]!.id, ROWS()[1]!.id]);

    await advance(4_999);
    expect(moves.spy).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(moves.ids()).toEqual([ROWS()[0]!.id, ROWS()[1]!.id, ROWS()[1]!.id, ROWS()[2]!.id]);
    expect(screen.getByText("Moved 3")).toBeInTheDocument();
    expect(resultRows()).toEqual([]);
  });

  it('says "1 second" for a Retry-After of one', async () => {
    serveMoves(RATE_LIMITED(1));
    const { user } = await renderMove();
    await chooseGateways(user);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Move 3" }));
    await advance();
    expect(status()).toHaveTextContent("Moving 1 of 3… (waiting 1 second: too many requests)");
  });

  it('stops after the request in flight on Stop ("Stopping…"), the rest "Not attempted"', async () => {
    const moves = serveMoves("hold");
    const { user } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moving 1 of 3…");

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(screen.queryByText(/^Moved/)).toBeNull();

    await act(async () => moves.sent[0]!.resolve());
    expect(await screen.findByText("Moved 1")).toBeInTheDocument();
    expect(resultRows()).toEqual(["collector-002Not attempted", "collector-003Not attempted"]);
    expect(moves.spy).toHaveBeenCalledTimes(1);
  });

  it("ends a 429's wait at once on Stop (fake timers)", async () => {
    const moves = serveMoves(RATE_LIMITED(30));
    const { user } = await renderMove();
    await chooseGateways(user);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Move 3" }));
    await advance();
    expect(status()).toHaveTextContent("(waiting 30 seconds: too many requests)");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await advance();
    expect(screen.getByText("Moved 0")).toBeInTheDocument();
    expect(resultRows()).toEqual(["collector-001Not attempted", "collector-002Not attempted", "collector-003Not attempted"]);
    expect(moves.spy).toHaveBeenCalledTimes(1);
  });

  it("words each result, and an unknown outcome stops the run: Already deleted, the refusal's message, May or may not have moved, Not attempted", async () => {
    const moves = serveMoves("moved", COLLECTOR_GONE(), refusal("invalid_request", "The request was not valid.", 400), UNAVAILABLE());
    const { user } = await renderMove(ROWS(5));
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 5" }));

    expect(await screen.findByText("Moved 1")).toBeInTheDocument();
    expect(resultRows()).toEqual([
      "collector-002Already deleted",
      `collector-003${MOVE_COLLECTOR_FAILED_MESSAGE}`,
      `collector-004${MOVE_UNKNOWN_WORDS}`,
      "collector-005Not attempted",
    ]);
    expect(MOVE_UNKNOWN_WORDS).toBe("May or may not have moved");
    expect(moves.spy).toHaveBeenCalledTimes(4);
  });

  it("ends a move that never answers at 30 s as an unknown outcome, which stops the run (fake timers)", async () => {
    const moves = serveMoves("hang");
    const { user } = await renderMove();
    await chooseGateways(user);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Move 3" }));
    await advance(FLEET_WRITE_TIMEOUT_MS - 1);
    expect(status()).toHaveTextContent("Moving 1 of 3…");
    await advance(1);
    expect(screen.getByText("Moved 0")).toBeInTheDocument();
    expect(resultRows()).toEqual([`collector-001${MOVE_UNKNOWN_WORDS}`, "collector-002Not attempted", "collector-003Not attempted"]);
    expect(moves.spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the target group gone", GROUP_GONE, "Collector group not found."],
    ["the fleet gone", () => refusal("fleet_not_found", "Fleet not found.", 404), "Fleet not found."],
    ["the session ended", () => refusal("unauthenticated", "You need to sign in.", 401), MOVE_COLLECTOR_FAILED_MESSAGE],
  ])("stops on %s, the refusal's words for that collector, the rest not attempted", async (_why, failure, words) => {
    const moves = serveMoves("moved", failure());
    const { user } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));

    expect(await screen.findByText("Moved 1")).toBeInTheDocument();
    expect(resultRows()).toEqual([`collector-002${words}`, "collector-003Not attempted"]);
    expect(moves.spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, stops, closes, reloads the grid and revalidates the layout", async (_why, failure) => {
    const moves = serveMoves("moved", failure());
    const { user, onOpenChange, onChanged, loader } = await renderMove();
    const loads = loader.mock.calls.length;
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(moves.spy).toHaveBeenCalledTimes(2);
  });

  it("can't be closed while it runs: no Cancel, no X, Escape and outside clicks do nothing", async () => {
    const moves = serveMoves("hold");
    const { user, onOpenChange } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moving 1 of 3…");

    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => moves.sent[0]!.resolve());
    await screen.findByText("Moved 3");
  });

  it("reloads the grid and the fleet when closed after a run, by its one Close (no X)", async () => {
    serveMoves();
    const { user, onOpenChange, onChanged } = await renderMove();
    await chooseGateways(user);
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moved 3");
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);

    await user.click(closeButton());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reloads on Escape after a run too", async () => {
    serveMoves();
    const { user, onChanged } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moved 3");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("closes on Cancel before a run with no request and no reload", async () => {
    const moves = serveMoves();
    const { user, onOpenChange, onChanged } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(moves.spy).not.toHaveBeenCalled();
  });

  it("starts once on a double click", async () => {
    const moves = serveMoves("hold");
    const { user } = await renderMove();
    await chooseGateways(user);
    const move = screen.getByRole("button", { name: "Move 3" });
    // Both clicks before React renders again.
    act(() => {
      fireEvent.click(move);
      fireEvent.click(move);
    });
    await screen.findByText("Moving 1 of 3…");
    expect(moves.spy).toHaveBeenCalledTimes(1);
  });

  it("stops when closed by an organization switch, and drops what comes after", async () => {
    const moves = serveMoves("hold");
    const { user, onChanged } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moving 1 of 3…");

    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => moves.sent[0]!.resolve());

    expect(moves.spy).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("stops when unmounted mid-run: the request in flight finishes, no other is sent", async () => {
    const moves = serveMoves("hold");
    const { user, unmount } = await renderMove();
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moving 1 of 3…");

    // Still open: only the unmount stops it.
    unmount();
    await act(async () => moves.sent[0]!.resolve());
    await act(async () => {});
    expect(moves.spy).toHaveBeenCalledTimes(1);
  });

  it("stops when another organization becomes active while it is open, and drops its results", async () => {
    const moves = serveMoves("hold", refusal("organization_not_found", "Organization not found", 404));
    const { user, onOpenChange, onChanged, loader } = await renderMove(ROWS(), GROUPS(), { closeOnSwitch: false });
    await chooseGateways(user);
    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moving 1 of 3…");
    const loads = loader.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await act(async () => moves.sent[0]!.resolve());

    expect(moves.spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^Moved/)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(loader.mock.calls.length).toBe(loads);
  });

  it("says the groups couldn't be read, with Move disabled, when the tab holds none", async () => {
    await renderMove(ROWS(), null);
    expect(screen.getByText(GROUPS_UNREADABLE_WORDS)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Group" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move 3" })).toBeDisabled();
  });

  it("holds no collector or group name in an attribute: the Select open and chosen, the run, the results", async () => {
    const names = ["canary-collector-1c4e", "canary-collector-2d5f", "canary-collector-3e60"];
    const groupName = "canary-group-77ab";
    const rows = ROWS().map((row, index) => ({ ...row, name: names[index]! }));
    const moves = serveMoves("hold", COLLECTOR_GONE(), UNAVAILABLE());
    const { user } = await renderMove(rows, [collectorGroup(), gatewaysGroup({ name: groupName })]);
    const canaries = [...names, groupName];

    await user.click(screen.getByRole("combobox", { name: "Group" }));
    await screen.findByRole("option", { name: groupName });
    for (const text of canaries) expectNoAttributeHolds(text);
    await user.click(screen.getByRole("option", { name: groupName }));
    expect(screen.getByRole("combobox", { name: "Group" })).toHaveTextContent(groupName);
    for (const text of canaries) expectNoAttributeHolds(text);

    await user.click(screen.getByRole("button", { name: "Move 3" }));
    await screen.findByText("Moving 1 of 3…");
    for (const text of canaries) expectNoAttributeHolds(text);
    await act(async () => moves.sent[0]!.resolve());

    expect(await screen.findByText("Moved 1")).toBeInTheDocument();
    expect(resultRows()).toEqual([`${names[1]}Already deleted`, `${names[2]}${MOVE_UNKNOWN_WORDS}`]);
    for (const text of canaries) expectNoAttributeHolds(text);
  });
});
