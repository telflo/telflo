import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import type { CollectorGroup } from "@telflo/contracts";
import { COPY_FAILED_MESSAGE } from "~/lib/hooks/use-copied-text.js";
import { collectorGroup, CONFIGURATION_ID, DEFAULT_GROUP_ID, expectNoAttributeHolds, gatewaysGroup, GATEWAYS_GROUP_ID, publishedVersion, VERSION_ID } from "~/test/fleets.js";
import { DELETED_VERSION_WORDS } from "./CollectorDetailsDialog.js";
import { COPIED_GROUP_ID_MESSAGE, GroupDetailsDialog } from "./GroupDetailsDialog.js";
import { NOTHING_ASSIGNED_MEANING } from "./GroupsTable.js";

/*
 * A group's details (D17b-2 decision 23): the dialog shows the row's
 * values and the collector group id, and the copy button copies it.
 * Its "no collector group record yet" case is a Kubernetes placeholder row's
 * (D17d's): a server fleet's group always has its id.
 */

function renderDetails(group: CollectorGroup) {
  const Stub = createRoutesStub([{ path: "/", Component: () => <GroupDetailsDialog open onOpenChange={vi.fn()} group={group} /> }]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

describe("GroupDetailsDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the group's name as its title, \"Group details\", and the rows Name, Published version, Variable group (D20) and Collector Group ID", async () => {
    renderDetails(gatewaysGroup());
    const dialog = await screen.findByRole("dialog", { name: "gateways" });
    expect(within(dialog).getByText("Group details")).toBeInTheDocument();
    expect(within(dialog).getByText("Name")).toBeInTheDocument();
    expect(within(dialog).getByText("Published version")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "checkout-otel @v4" })).toHaveAttribute("href", `/editor/${CONFIGURATION_ID}/${VERSION_ID}`);
    // D17c-1 Preflight ruling 32: in a dialog, the whole name, no tooltip.
    expect(within(dialog).getByText("checkout-otel")).not.toHaveClass("truncate");
    expect(within(dialog).getByRole("link")).not.toHaveAttribute("data-state");
    expect(within(dialog).getByText("Collector Group ID")).toBeInTheDocument();
    expect(within(dialog).getByText(GATEWAYS_GROUP_ID)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/deploy group/i);
    // D20 default 25: the group's variable group, none here.
    expect(within(dialog).getByText("Variable group")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Organization values" })).toBeInTheDocument();
    // No title on the id.
    expect(within(dialog).getByText(GATEWAYS_GROUP_ID)).not.toHaveAttribute("title");
  });

  it("says Nothing assigned with its meaning as text, and a deleted configuration's version", async () => {
    renderDetails(collectorGroup());
    const dialog = await screen.findByRole("dialog", { name: "Default" });
    expect(within(dialog).getByText("Nothing assigned")).toBeInTheDocument();
    expect(within(dialog).getByText(NOTHING_ASSIGNED_MEANING)).toBeInTheDocument();
    expect(within(dialog).getByText(DEFAULT_GROUP_ID)).toBeInTheDocument();
  });

  it("says a deleted configuration's version for an assignment the platform no longer holds", async () => {
    renderDetails(gatewaysGroup({ assignedVersion: null }));
    const dialog = await screen.findByRole("dialog", { name: "gateways" });
    expect(within(dialog).getByText(DELETED_VERSION_WORDS)).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it('copies the collector group id with "Copy collector group id", toasting that it was copied', async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const user = renderDetails(gatewaysGroup());
    await user.click(await screen.findByRole("button", { name: "Copy collector group id" }));
    expect(await navigator.clipboard.readText()).toBe(GATEWAYS_GROUP_ID);
    expect(toastSuccess).toHaveBeenCalledWith(COPIED_GROUP_ID_MESSAGE);
    expect(COPIED_GROUP_ID_MESSAGE).toBe("Copied collector group id");
  });

  it("toasts a copy the browser refuses, never the id", async () => {
    const toastError = vi.spyOn(toast, "error");
    const user = renderDetails(gatewaysGroup());
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(await screen.findByRole("button", { name: "Copy collector group id" }));
    expect(toastError).toHaveBeenCalledWith(COPY_FAILED_MESSAGE);
  });

  it("holds no group or configuration name or version label in an attribute (decision 34)", async () => {
    const name = "canary-group-c41e";
    const configurationName = "canary-configuration-9a0d";
    const label = "canary-label-2b77";
    renderDetails(gatewaysGroup({ name, assignedVersion: publishedVersion({ configurationName, versionLabel: label }) }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(name);
    expect(dialog).toHaveTextContent(configurationName);
    for (const canary of [name, configurationName, label]) expectNoAttributeHolds(canary);
  });
});
