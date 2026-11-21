import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectorGroup, Configuration, FleetDetail } from "@telflo/contracts";
import { toast } from "sonner";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, signedInMember, THEIRS } from "~/test/configurations.js";
import {
  clusterGroup,
  collectorGroup,
  configurationVersionListItem,
  CONFIGURATION_ID,
  EMPTY_SUMMARY,
  fleetDetail,
  gatewaysGroup,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  serveNoVariables,
} from "~/test/fleets.js";
import { SetupChecklist } from "./SetupChecklist.js";

/*
 * The setup checklist: its three steps and actions, the assign step done,
 * the waiting indicator, the reopened card with "Hide setup guide", the
 * checklist's own groups read and its Assign through the group dialog (the
 * step is required, no "skip").
 */

const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };

let groups: CollectorGroup[];

function serve() {
  serveNoVariables();
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async () => ({ groups }));
  vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [CHECKOUT], nextCursor: null });
  vi.spyOn(apiClient, "getConfigurationVersions").mockResolvedValue({ versions: [configurationVersionListItem()] });
  const updateCollectorGroup = vi.spyOn(apiClient, "updateCollectorGroup").mockImplementation(async (_o, _f, groupId) => {
    groups = groups.map((group) =>
      group.id === groupId ? { ...group, assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() } : group,
    );
    return groups.find((group) => group.id === groupId)!;
  });
  return { getCollectorGroups, updateCollectorGroup };
}

const onInstall = vi.fn();
const onDismiss = vi.fn();
const onGroupsChanged = vi.fn();
const onFleetChanged = vi.fn();
const onGroupsTab = vi.fn();

function renderChecklist({
  fleet = fleetDetail(),
  installStarted = false,
  reopened = false,
  fallback = () => null,
}: { fleet?: FleetDetail; installStarted?: boolean; reopened?: boolean; fallback?: () => HTMLElement | null } = {}) {
  function Harness() {
    const [changed, setChanged] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setChanged((value) => value + 1)}>
          assigned elsewhere
        </button>
        <SetupChecklist
          fleet={fleet}
          installStarted={installStarted}
          onInstall={onInstall}
          onGroupsTab={onGroupsTab}
          onDismiss={reopened ? onDismiss : undefined}
          groupsChanged={changed}
          onGroupsChanged={onGroupsChanged}
          onFleetChanged={onFleetChanged}
          fallback={fallback}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Harness }]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

const withCollectors = () => fleetDetail({ summary: { ...EMPTY_SUMMARY, collectors: 3 } });
const step = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

beforeEach(() => {
  vi.restoreAllMocks();
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  for (const each of [onInstall, onDismiss, onGroupsChanged, onFleetChanged, onGroupsTab]) each.mockClear();
  groups = [collectorGroup(), gatewaysGroup({ assignedPublishedVersionId: null, assignedVersion: null })];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SetupChecklist", () => {
  it("shows the three steps with their actions when nothing is done, auto-shown with its hint", async () => {
    serve();
    const user = renderChecklist();
    const card = screen.getByRole("region", { name: "Fleet setup" });
    expect(within(card).getByRole("heading", { name: "Set up this fleet" })).toBeInTheDocument();
    expect(within(card).getByText("Disappears once your first collector connects")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Hide setup guide" })).toBeNull();
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual([
      "Assign a published version",
      "Install a collector",
      "First collector connects",
    ]);
    expect(step("Assign a published version")).toHaveTextContent(
      "Give the Default group a published version: its collector version picks what to install, and its collectors run it.",
    );
    expect(step("Assign a published version")).not.toHaveTextContent(/skip|import/i);
    expect(step("Install a collector")).toHaveTextContent("Generate a copy-paste install command and run it on a host.");
    expect(step("First collector connects")).toHaveTextContent(
      "Once installed, the collector authenticates with the fleet token and appears in the Collectors tab, usually within a minute.",
    );
    expect(screen.queryByText("Listening for the first check-in…")).toBeNull();

    const install = within(card).getByRole("button", { name: "Install" });
    await user.click(install);
    expect(onInstall).toHaveBeenCalledWith(install);
    // Assign once the Default group is read.
    expect(await within(card).findByRole("button", { name: "Assign" })).toBeInTheDocument();
  });

  it("marks the assign step done, with no Assign, once the Default group has a published version", async () => {
    groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }), gatewaysGroup()];
    serve();
    renderChecklist();
    await waitFor(() => expect(step("Assign a published version")).toHaveTextContent("Done:"));
    expect(screen.queryByRole("button", { name: "Assign" })).toBeNull();
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
  });

  // Every Install here opens the Default group, which an install refuses without one.
  it("leaves the assign step to do, with Assign, while only another group has a published version", async () => {
    groups = [collectorGroup(), gatewaysGroup()];
    serve();
    renderChecklist();
    expect(await screen.findByRole("button", { name: "Assign" })).toBeInTheDocument();
    expect(step("Assign a published version")).not.toHaveTextContent("Done:");
  });

  it("doesn't count a deleted configuration's version as assigned", async () => {
    groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID })];
    serve();
    renderChecklist();
    expect(await screen.findByRole("button", { name: "Assign" })).toBeInTheDocument();
    expect(step("Assign a published version")).not.toHaveTextContent("Done:");
  });

  it("marks Install done and shows the live waiting indicator once installing started", async () => {
    serve();
    renderChecklist({ installStarted: true });
    expect(screen.getByText("Listening for the first check-in…")).toBeInTheDocument();
    expect(step("First collector connects")).toHaveTextContent(
      "Waiting for the collector to connect. This page checks automatically every 15 seconds.",
    );
    expect(step("Install a collector")).toHaveTextContent("Done:");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    await screen.findByRole("button", { name: "Assign" });
  });

  it("reopened after setup: Install and First collector connects done from the collectors alone, with Hide setup guide and no hint", async () => {
    serve();
    const user = renderChecklist({ fleet: withCollectors(), reopened: true });
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.queryByText("Listening for the first check-in…")).toBeNull();
    expect(step("First collector connects")).toHaveTextContent("Done:");
    expect(screen.queryByText("Disappears once your first collector connects")).toBeNull();
    const hide = screen.getByRole("button", { name: "Hide setup guide" });
    expect(hide).not.toHaveAttribute("title");
    await user.click(hide);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await screen.findByRole("button", { name: "Assign" });
  });
});

describe("SetupChecklist's groups read failing", () => {
  it('shows "Failed to load groups" under the assign step with Try again, which reads them again', async () => {
    const { getCollectorGroups } = serve();
    getCollectorGroups.mockRejectedValueOnce(new ApiError("fleets_unavailable", "Fleets are unavailable.", { status: 503 }));
    const error = vi.spyOn(toast, "error");
    const user = renderChecklist();
    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    expect(step("Assign a published version")).toHaveTextContent("Failed to load groups");
    expect(step("Assign a published version")).not.toHaveTextContent("Done:");
    expect(screen.queryByRole("button", { name: "Assign" })).toBeNull();
    await user.click(tryAgain);
    expect(await screen.findByRole("button", { name: "Assign" })).toBeInTheDocument();
    expect(step("Assign a published version")).not.toHaveTextContent("Failed to load groups");
    expect(getCollectorGroups).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("says nothing when a read fails over groups shown: the Groups tab's own read toasts it, never twice", async () => {
    const { getCollectorGroups } = serve();
    const error = vi.spyOn(toast, "error");
    const user = renderChecklist();
    await screen.findByRole("button", { name: "Assign" });
    getCollectorGroups.mockRejectedValueOnce(new ApiError("fleets_unavailable", "Fleets are unavailable.", { status: 503 }));
    await user.click(screen.getByRole("button", { name: "assigned elsewhere" }));
    await waitFor(() => expect(getCollectorGroups).toHaveBeenCalledTimes(2));
    // The failure taken in (its promise settled, a task later), the rows stay, and nothing toasts or shows it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole("button", { name: "Assign" })).toBeEnabled();
    expect(error).not.toHaveBeenCalled();
    expect(screen.queryByText("Failed to load groups")).toBeNull();
  });
});

describe("SetupChecklist's Assign", () => {
  it("opens the group dialog for the Default group, and its save reloads the checklist's groups, the Groups tab's and the fleet; the focus goes to Install", async () => {
    const { getCollectorGroups, updateCollectorGroup } = serve();
    const user = renderChecklist();
    await user.click(await screen.findByRole("button", { name: "Assign" }));
    const dialog = await screen.findByRole("dialog", { name: "Assign a published version to Default" });

    await user.click(within(dialog).getByRole("combobox", { name: "Configuration" }));
    await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v4"));
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateCollectorGroup).toHaveBeenCalledWith(GROUP_ID, groups[0]!.fleetId, groups[0]!.id, expect.objectContaining({ assignedVersionId: expect.any(String) }), expect.anything());
    await waitFor(() => expect(step("Assign a published version")).toHaveTextContent("Done:"));
    expect(getCollectorGroups).toHaveBeenCalledTimes(2);
    expect(onGroupsChanged).toHaveBeenCalledTimes(1);
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    // Assign is gone with its step done: the focus goes to the next step's Install.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Install" })));
  });

  it("returns the focus to Assign when the group dialog closes with nothing saved", async () => {
    serve();
    const user = renderChecklist();
    const assign = await screen.findByRole("button", { name: "Assign" });
    await user.click(assign);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(assign));
  });

  it("reads its groups again when the route's groupsChanged moves (the install dialog's Assign), not on its first render", async () => {
    const { getCollectorGroups } = serve();
    const user = renderChecklist();
    await screen.findByRole("button", { name: "Assign" });
    expect(getCollectorGroups).toHaveBeenCalledTimes(1);
    groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() })];
    await user.click(screen.getByRole("button", { name: "assigned elsewhere" }));
    await waitFor(() => expect(step("Assign a published version")).toHaveTextContent("Done:"));
    expect(getCollectorGroups).toHaveBeenCalledTimes(2);
  });
});

// A Kubernetes-supervisor fleet's checklist.
describe("SetupChecklist on a Kubernetes-supervisor fleet", () => {
  const kubernetesFleet = (collectors = 0) => fleetDetail({ type: "kubernetes-supervisor", summary: { ...EMPTY_SUMMARY, collectors } });

  it("shows the Helm install's three steps in their words; Assign chooses the Groups tab (no dialog), Install asks the route", async () => {
    groups = [collectorGroup(), clusterGroup(), gatewaysGroup({ assignedPublishedVersionId: null, assignedVersion: null })];
    serve();
    const user = renderChecklist({ fleet: kubernetesFleet() });
    const card = screen.getByRole("region", { name: "Fleet setup" });
    expect(within(card).getByRole("heading", { name: "Set up this fleet" })).toBeInTheDocument();
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual([
      "Assign published versions to your groups",
      "Install a group with Helm",
      "First collector connects",
    ]);
    expect(step("Assign published versions to your groups")).toHaveTextContent("Give the Agent, the Cluster or a gateway pool a published version on the Groups tab.");
    expect(step("Install a group with Helm")).toHaveTextContent("Download a group's values.yaml and run its helm upgrade --install against your cluster.");
    expect(step("First collector connects")).toHaveTextContent(
      "Once the Helm release is installed, each pod's supervisor authenticates with the fleet token and appears in the Collectors tab.",
    );
    await user.click(within(card).getByRole("button", { name: "Assign" }));
    expect(onGroupsTab).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    const install = within(card).getByRole("button", { name: "Install" });
    await user.click(install);
    expect(onInstall).toHaveBeenCalledWith(install);
  });

  it("marks Assign done once any group has a published version (a gateway's counts), a deleted configuration's not", async () => {
    groups = [collectorGroup(), gatewaysGroup({ assignedVersion: null })];
    const { getCollectorGroups } = serve();
    renderChecklist({ fleet: kubernetesFleet() });
    await waitFor(() => expect(getCollectorGroups).toHaveBeenCalled());
    expect(step("Assign published versions to your groups")).not.toHaveTextContent("Done:");
    expect(within(step("Assign published versions to your groups")).getByRole("button", { name: "Assign" })).toBeInTheDocument();

    groups = [collectorGroup(), gatewaysGroup()];
    await userEvent.setup().click(screen.getByRole("button", { name: "assigned elsewhere" }));
    await waitFor(() => expect(step("Assign published versions to your groups")).toHaveTextContent("Done:"));
  });

  it("marks Install done once installing started, with the pods' waiting words; a connected fleet's steps done", async () => {
    groups = [collectorGroup(), gatewaysGroup()];
    serve();
    renderChecklist({ fleet: kubernetesFleet(), installStarted: true });
    expect(step("Install a group with Helm")).toHaveTextContent("Done:");
    expect(step("First collector connects")).toHaveTextContent("Waiting for the first pod to check in. This page checks automatically every 15 seconds.");
    expect(screen.getByText("Listening for the first check-in…")).toBeInTheDocument();
  });

  it("reopened after setup: Install and First collector connects done from the collectors alone", async () => {
    serve();
    renderChecklist({ fleet: kubernetesFleet(3), reopened: true });
    expect(step("Install a group with Helm")).toHaveTextContent("Done:");
    expect(step("First collector connects")).toHaveTextContent("Done:");
    expect(screen.getByRole("button", { name: "Hide setup guide" })).toBeInTheDocument();
  });
});
