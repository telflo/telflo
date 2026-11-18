import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { FleetActionDialogs, useFleetActionDialogs } from "./FleetActionDialogs.js";
import type { FleetRowAction } from "./FleetRowActions.js";
import * as apiClient from "~/lib/api-client.js";
import { GROUP_ID, PERSONAL_ID } from "~/test/configurations.js";
import { FLEET_ID, fleet, fleetDetail } from "~/test/fleets.js";

/*
 * The rename, archive and delete dialogs as the list and the fleet's page
 * hold them (`useFleetActionDialogs`): an organization switch closes the one
 * open, and each opening after is a new session, whatever the write the
 * switch interrupted is still doing.
 */

const OTHER_ID = "5f607182-93a4-45b6-8c7d-8e9fa0b1c2d3";

/** The dialogs under a page that can open them for edge-prod or edge-dev, and switch the organization. */
function renderDialogs(action: FleetRowAction) {
  const onChanged = vi.fn();
  const onDeleted = vi.fn();
  const onDeleteUnknown = vi.fn();

  function Page() {
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    const dialogs = useFleetActionDialogs(organizationId);
    return (
      <>
        <button type="button" onClick={() => dialogs.openFor(action, fleetDetail())}>
          Open for the first
        </button>
        <button type="button" onClick={() => dialogs.openFor(action, fleetDetail({ id: OTHER_ID, label: "edge-dev" }))}>
          Open for the second
        </button>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <FleetActionDialogs
          target={dialogs.target}
          open={dialogs.open}
          onOpenChange={dialogs.setOpen}
          organizationId={organizationId}
          onChanged={onChanged}
          onDeleted={onDeleted}
          onDeleteUnknown={onDeleteUnknown}
        />
      </>
    );
  }

  const Stub = createRoutesStub([{ path: "/fleet-management", Component: Page, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/fleet-management"]} />);
  return { user: userEvent.setup(), onChanged, onDeleted, onDeleteUnknown };
}

/** The first call hangs until `finish`; every later one answers at once. Each call's organization and fleet kept. */
function serveFirstHanging<Answer>(method: "updateFleet" | "deleteFleet", answer: Answer) {
  const calls: Array<[string, string]> = [];
  let finish!: () => void;
  vi.spyOn(apiClient, method).mockImplementation(((organizationId: string, fleetId: string) => {
    calls.push([organizationId, fleetId]);
    if (calls.length === 1) {
      return new Promise((resolve) => {
        finish = () => resolve(answer);
      });
    }
    return Promise.resolve(answer);
  }) as never);
  return { calls, finish: () => finish() };
}

describe("FleetActionDialogs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["archive", "Archive fleet", "Archive", "Archiving…", "updateFleet"],
    ["delete", "Delete fleet", "Delete fleet", "Deleting...", "deleteFleet"],
  ] as const)(
    "%s: a write under way when the organization switches leaves nothing behind: the next opening, for another fleet, is usable",
    async (action, title, button, working, method) => {
      const served = serveFirstHanging(method, method === "updateFleet" ? fleet({ status: "archived" }) : undefined);
      const success = vi.spyOn(toast, "success");
      const error = vi.spyOn(toast, "error");
      const { user, onChanged, onDeleted, onDeleteUnknown } = renderDialogs(action);

      await user.click(screen.getByRole("button", { name: "Open for the first" }));
      await user.click(within(await screen.findByRole("alertdialog", { name: title })).getByRole("button", { name: button }));
      expect(screen.getByRole("button", { name: working })).toBeDisabled();

      // The switch closes the dialog mid-write.
      fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

      await user.click(screen.getByRole("button", { name: "Open for the second" }));
      const dialog = await screen.findByRole("alertdialog", { name: title });
      expect(dialog).toHaveTextContent("edge-dev");
      expect(within(dialog).getByRole("button", { name: button })).toBeEnabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();

      // The interrupted write's answer comes, and changes nothing.
      await act(async () => served.finish());
      expect(within(dialog).getByRole("button", { name: button })).toBeEnabled();
      expect(onChanged).not.toHaveBeenCalled();
      expect(onDeleted).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();

      // And the new one writes, in the new organization, for its fleet.
      await user.click(within(dialog).getByRole("button", { name: button }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(served.calls).toEqual([
        [GROUP_ID, FLEET_ID],
        [PERSONAL_ID, OTHER_ID],
      ]);
      expect(action === "archive" ? onChanged : onDeleted).toHaveBeenCalledTimes(1);
      expect(onDeleteUnknown).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("rename: a rename under way when the organization switches leaves nothing behind: the next opening holds the other fleet's label, Save usable", async () => {
    const served = serveFirstHanging("updateFleet", fleet({ label: "edge-renamed" }));
    const { user, onChanged } = renderDialogs("rename");

    await user.click(screen.getByRole("button", { name: "Open for the first" }));
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "edge-renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Open for the second" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("edge-dev");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await act(async () => served.finish());
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
