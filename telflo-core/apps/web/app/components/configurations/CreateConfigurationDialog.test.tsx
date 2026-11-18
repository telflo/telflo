import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow } from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { toast } from "sonner";
import {
  CreateConfigurationDialog,
  DISTRIBUTION_LOCK_NOTE,
  DISTRIBUTION_UNAVAILABLE_NOTE,
} from "./CreateConfigurationDialog.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import {
  ACME,
  CATALOGUE,
  CONTRIB,
  CONTRIB_DESCRIPTION,
  CONTRIB_LABEL,
  RETIRED_VERSION,
} from "~/test/collector-distributions.js";
import { GROUP_ID, MINE, signedInMember } from "~/test/configurations.js";
import { HIDDEN, PII_REDACTION, TAIL_SAMPLING, makeFlow } from "~/test/flows.js";

/** Where the dialog went, for the editor's address. */
function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

/**
 * The dialog on a page that can close and reopen it, with a loader to count
 * revalidations; at the blank path's name step unless `atStart`.
 */
async function renderDialog({ atStart = false } = {}) {
  const onOpenChange = vi.fn();
  const loader = vi.fn(() => null);

  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        {/* The page closing it itself, as another organization does. */}
        <button type="button" onClick={() => setOpen(false)}>
          Page closes
        </button>
        <CreateConfigurationDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          organizationId={GROUP_ID}
        />
      </>
    );
  }

  const Stub = createRoutesStub([
    { path: "/app", Component: Page, loader, HydrateFallback: () => null },
    { path: "/editor/:configurationId", Component: Landed },
  ]);
  render(<Stub initialEntries={["/app"]} />);
  const user = userEvent.setup();
  if (!atStart) await chooseBlank(user);
  return { onOpenChange, loader, user };
}

type User = ReturnType<typeof userEvent.setup>;

/** From the start step, the blank path's name step (D12 Preflight ruling 8). */
async function chooseBlank(user: User) {
  await user.click(await screen.findByRole("button", { name: /Blank configuration/ }));
  await screen.findByLabelText("Configuration Name");
}

/** From the name step, Back to the start step, then Cancel. */
async function closeFromNameStep(user: User) {
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

/** Reopens the dialog from the page, at the start step, and goes to the blank path's name step. */
async function reopenAtBlank(user: User) {
  await user.click(screen.getByRole("button", { name: "Reopen" }));
  await chooseBlank(user);
}

/** Whether the dialog has gone to any editor. */
function landed() {
  return screen.queryByText(/landed on/);
}

/** A create that answers when `finish` is called. */
function pendingCreate() {
  let finish!: () => void;
  const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ configuration: MINE });
      }),
  );
  return { createConfiguration, finish: () => finish() };
}

/** The Distribution dropdown, once the catalogue has been read. */
function distributionField() {
  return screen.findByRole("combobox", { name: "Distribution" });
}

describe("CreateConfigurationDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCollectorCatalogue();
    useUserStore.getState().clear();
    vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });
    vi.spyOn(apiClient, "getFlows").mockResolvedValue({ flows: [TAIL_SAMPLING, PII_REDACTION] });
  });

  it("opens at the start step: New configuration, Blank configuration or Start from a flow, and Cancel", async () => {
    const { user, onOpenChange } = await renderDialog({ atStart: true });
    const dialog = await screen.findByRole("dialog", { name: "New configuration" });

    expect(dialog).toHaveTextContent("Start from scratch, or from a prebuilt flow you can edit.");
    expect(within(dialog).getByRole("button", { name: /Blank configuration/ })).toHaveTextContent(
      "Blank configurationAn empty canvas",
    );
    // The flows are read on opening, and counted once they answer.
    expect(await within(dialog).findByRole("button", { name: /Start from a flow/ })).toHaveTextContent(
      "Start from a flow2 prebuilt configurations",
    );
    expect(screen.queryByLabelText("Configuration Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says Prebuilt configurations, uncounted, until the flows answer, and when there are none", async () => {
    let answer!: (flows: Flow[]) => void;
    vi.spyOn(apiClient, "getFlows").mockImplementation(
      () => new Promise((resolve) => (answer = (flows) => resolve({ flows }))),
    );
    await renderDialog({ atStart: true });
    const start = await screen.findByRole("button", { name: /Start from a flow/ });
    expect(start).toHaveTextContent("Start from a flowPrebuilt configurations");

    await act(async () => answer([]));
    expect(start).toHaveTextContent("Start from a flowPrebuilt configurations");
  });

  it("goes to the name step for a blank configuration, with its copy, and Back to the start step", async () => {
    const { user } = await renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Name Your Configuration" });

    expect(dialog).toHaveTextContent("Give your OpenTelemetry configuration a descriptive name");
    expect(screen.getByLabelText("Configuration Name")).toHaveAttribute("placeholder", "e.g., Production Monitoring");
    expect(screen.getByLabelText("Configuration Name")).toHaveAttribute("maxlength", "200");
    expect(screen.getByLabelText("Configuration Name")).toHaveValue("");
    const description = screen.getByLabelText("Description");
    expect(description.tagName).toBe("TEXTAREA");
    expect(description).toHaveAttribute("placeholder", "e.g., Collects traces and metrics from production k8s cluster");
    expect(description).toHaveAttribute("rows", "3");
    expect(description).toHaveAttribute("maxlength", "500");
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // D13a decision 5: the distribution is picked here, the catalogue's default preselected.
    expect(await distributionField()).toHaveTextContent(/^Otel Contrib$/);
    expect(screen.getByText(DISTRIBUTION_LOCK_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(/set by this flow/)).toBeNull();

    // Back, to the start step (D7 had Cancel: there was no step to go back to).
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("dialog", { name: "New configuration" })).toBeInTheDocument();
  });

  it("disables Create for an empty or spaces-only name, and enables it after one character", async () => {
    const { user } = await renderDialog();
    const create = await screen.findByRole("button", { name: "Create" });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText("Configuration Name"), "   ");
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText("Configuration Name"), "A");
    expect(create).toBeEnabled();

    await user.clear(screen.getByLabelText("Configuration Name"));
    expect(create).toBeDisabled();
  });

  it("creates with the trimmed name and description, captures config_created with no properties, closes and opens the editor (D8 decision 16)", async () => {
    const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    const success = vi.spyOn(toast, "success");
    const { user, onOpenChange } = await renderDialog();
    await distributionField();

    await user.type(await screen.findByLabelText("Configuration Name"), "  Production Monitoring ");
    await user.type(screen.getByLabelText("Description"), " Collects traces ");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    expect(createConfiguration).toHaveBeenCalledWith(GROUP_ID, {
      name: "Production Monitoring",
      description: "Collects traces",
      collectorDistribution: CONTRIB.id,
    });
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent.mock.calls[0]).toEqual(["config_created"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(success).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("submits on Enter in the name", async () => {
    const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
    const { user } = await renderDialog();
    await distributionField();

    await user.type(await screen.findByLabelText("Configuration Name"), "Production Monitoring{Enter}");

    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    expect(createConfiguration).toHaveBeenCalledWith(GROUP_ID, {
      name: "Production Monitoring",
      description: "",
      collectorDistribution: CONTRIB.id,
    });
  });

  it("says Creating… while the create is under way, and creates once for two quick submits", async () => {
    const { createConfiguration, finish } = pendingCreate();
    const { user } = await renderDialog();
    const name = await screen.findByLabelText("Configuration Name");
    await user.type(name, "Once only");

    // Two Enters in one go, before either has re-rendered, then a click.
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.keyDown(name, { key: "Enter" });
    const creating = screen.getByRole("button", { name: "Creating…" });
    expect(creating).toBeDisabled();
    await user.click(creating);
    finish();

    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    expect(createConfiguration).toHaveBeenCalledTimes(1);
  });

  it("resets both fields when reopened", async () => {
    const { user } = await renderDialog();
    await user.type(await screen.findByLabelText("Configuration Name"), "Abandoned");
    await user.type(screen.getByLabelText("Description"), "Half written");

    await closeFromNameStep(user);
    await user.click(screen.getByRole("button", { name: "Reopen" }));

    // At the start step again, then empty fields.
    expect(await screen.findByRole("dialog", { name: "New configuration" })).toBeInTheDocument();
    await chooseBlank(user);
    expect(screen.getByLabelText("Configuration Name")).toHaveValue("");
    expect(screen.getByLabelText("Description")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("doesn't close while the create is under way, and a reopened dialog can't start a second one", async () => {
    const { createConfiguration, finish } = pendingCreate();
    const { user, onOpenChange } = await renderDialog();
    await user.type(await screen.findByLabelText("Configuration Name"), "Once only{Enter}");
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    // Escape, an outside click and the close button all go through the same
    // refusal; Escape stands for them.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Name Your Configuration" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    // Were the page to close and reopen it meanwhile, it still can't create again.
    fireEvent.click(screen.getByRole("button", { name: "Page closes", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await reopenAtBlank(user);
    const name = screen.getByLabelText("Configuration Name");
    await user.type(name, "Twice{Enter}");
    fireEvent.keyDown(name, { key: "Enter" });
    expect(createConfiguration).toHaveBeenCalledTimes(1);

    finish();
    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    expect(createConfiguration).toHaveBeenCalledTimes(1);
  });

  it("toasts the API's refusal and stays open with its fields", async () => {
    vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(
      new ApiError("organization_access_denied", "You are not an active member of this organization"),
    );
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderDialog();

    await user.type(await screen.findByLabelText("Configuration Name"), "Kept");
    await user.type(screen.getByLabelText("Description"), "Also kept");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("You are not an active member of this organization"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(landed()).toBeNull();
    expect(captureEvent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Configuration Name")).toHaveValue("Kept");
    expect(screen.getByLabelText("Description")).toHaveValue("Also kept");
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it.each([
    ["a server error", new ApiError("internal_error", "Something went wrong. Please try again.")],
    ["an invalid request", new ApiError("invalid_request", "The request was not valid.")],
    ["no connection", new ApiError("network_error", "Could not reach the server. Check your connection.")],
  ])("toasts \"Failed to create configuration\" for %s (D7 Preflight ruling 2)", async (_why, failure) => {
    vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(failure);
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderDialog();

    await user.type(await screen.findByLabelText("Configuration Name"), "Team");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to create configuration"));
    expect(error).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("on a 404 organization_not_found, closes and revalidates the layout, with no toast", async () => {
    vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(
      new ApiError("organization_not_found", "Organization not found"),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, loader } = await renderDialog();
    await user.type(await screen.findByLabelText("Configuration Name"), "Team");
    const loadsBefore = loader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(landed()).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("on a 403 terms_acceptance_required, closes and revalidates the layout, whose terms dialog opens, with no toast", async () => {
    vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(
      new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
    );
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, loader } = await renderDialog();
    await user.type(await screen.findByLabelText("Configuration Name"), "Team");
    const loadsBefore = loader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(landed()).toBeNull();
    expect(captureEvent).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does nothing when the create answers after its dialog has unmounted, so a fresh dialog keeps its text", async () => {
    const { finish } = pendingCreate();
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    const error = vi.spyOn(toast, "error");
    const onOpenChange = vi.fn();
    const loader = vi.fn(() => null);

    function Page() {
      const [open, setOpen] = useState(true);
      const [mounted, setMounted] = useState(true);
      const [instance, setInstance] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setMounted(false)}>
            Unmount
          </button>
          <button
            type="button"
            onClick={() => {
              setInstance((value) => value + 1);
              setOpen(true);
              setMounted(true);
            }}
          >
            Remount
          </button>
          {mounted && (
            <CreateConfigurationDialog
              key={instance}
              open={open}
              onOpenChange={(next) => {
                onOpenChange(next);
                setOpen(next);
              }}
              organizationId={GROUP_ID}
            />
          )}
        </>
      );
    }
    const Stub = createRoutesStub([
      { path: "/app", Component: Page, loader, HydrateFallback: () => null },
      { path: "/editor/:configurationId", Component: Landed },
    ]);
    render(<Stub initialEntries={["/app"]} />);
    const user = userEvent.setup();
    await chooseBlank(user);
    await user.type(screen.getByLabelText("Configuration Name"), "First{Enter}");
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Unmount", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Remount" }));
    await chooseBlank(user);
    await user.type(screen.getByLabelText("Configuration Name"), "Second");
    const loadsBefore = loader.mock.calls.length;

    await act(async () => finish());

    expect(screen.getByRole("dialog", { name: "Name Your Configuration" })).toBeInTheDocument();
    expect(screen.getByLabelText("Configuration Name")).toHaveValue("Second");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(landed()).toBeNull();
    expect(captureEvent).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(loader.mock.calls.length).toBe(loadsBefore);
  });

  /*
   * The distribution dropdown (D13a decision 1), with a fixture second
   * distribution. There is no version lookup: the server gives version 1
   * the distribution's default.
   */
  describe("the distribution (D13a decisions 1 and 5)", () => {
    beforeEach(() => {
      vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: [CONTRIB, ACME] });
    });

    it("preselects the catalog's default distribution with its human description", async () => {
      const { user } = await renderDialog();

      const field = await distributionField();
      expect(field).toHaveTextContent(/^Otel Contrib$/);
      // The permanence note is visible, and describes the field, before any choice is made.
      expect(field).toHaveAccessibleDescription(DISTRIBUTION_LOCK_NOTE);
      expect(DISTRIBUTION_LOCK_NOTE).toBe(
        "Which collector build this configuration is for. This is locked once the configuration is created.",
      );

      await user.click(field);
      const contrib = await screen.findByRole("option", { name: new RegExp(CONTRIB_LABEL) });
      expect(contrib).toHaveAttribute("aria-selected", "true");
      expect(contrib).toHaveTextContent(CONTRIB_DESCRIPTION);
      expect(contrib).toHaveTextContent("Default");
      const acme = screen.getByRole("option", { name: /Acme Collector/ });
      expect(acme).toHaveAttribute("aria-selected", "false");
      expect(acme).toHaveTextContent("A smaller component set");
      expect(acme).not.toHaveTextContent("Default");
    });

    it("creates with the picked distribution, and no collector version (the server gives its default)", async () => {
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const { user } = await renderDialog();

      await user.type(await screen.findByLabelText("Configuration Name"), "CH pipeline");
      await user.click(await distributionField());
      await user.click(await screen.findByRole("option", { name: /Acme Collector/ }));
      expect(await distributionField()).toHaveTextContent(/^Acme Collector$/);
      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
      expect(createConfiguration).toHaveBeenCalledWith(GROUP_ID, {
        name: "CH pipeline",
        description: "",
        collectorDistribution: ACME.id,
      });
    });

    it("carries the picked distribution through the Enter-key create", async () => {
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const { user } = await renderDialog();

      await user.click(await distributionField());
      await user.click(await screen.findByRole("option", { name: /Acme Collector/ }));
      await user.type(screen.getByLabelText("Configuration Name"), "CH pipeline{Enter}");

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
      expect(createConfiguration).toHaveBeenCalledWith(GROUP_ID, {
        name: "CH pipeline",
        description: "",
        collectorDistribution: ACME.id,
      });
    });

    it("still creates (with the server's default) when the distribution catalog is unreachable, and says so", async () => {
      vi.spyOn(apiClient, "getCollectorDistributions").mockRejectedValue(
        new ApiError("network_error", "Could not reach the server. Check your connection."),
      );
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const { user } = await renderDialog();

      // No picker to show, and no blocked create.
      expect(await screen.findByText(DISTRIBUTION_UNAVAILABLE_NOTE)).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Distribution" })).toBeNull();
      await user.type(screen.getByLabelText("Configuration Name"), "Plain");
      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
      expect(createConfiguration).toHaveBeenCalledWith(GROUP_ID, { name: "Plain", description: "" });
    });

    it("resets an abandoned pick back to the default when the dialog reopens", async () => {
      const { user } = await renderDialog();

      await user.click(await distributionField());
      await user.click(await screen.findByRole("option", { name: /Acme Collector/ }));
      expect(await distributionField()).toHaveTextContent(/^Acme Collector$/);

      await closeFromNameStep(user);
      await reopenAtBlank(user);

      expect(await distributionField()).toHaveTextContent(/^Otel Contrib$/);
    });

    it("reads the catalogue once for the page, and again on reopening after a failure", async () => {
      const read = vi
        .spyOn(apiClient, "getCollectorDistributions")
        .mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."))
        .mockResolvedValue({ distributions: CATALOGUE });
      const { user } = await renderDialog();
      expect(await screen.findByText(DISTRIBUTION_UNAVAILABLE_NOTE)).toBeInTheDocument();

      await closeFromNameStep(user);
      await reopenAtBlank(user);
      expect(await distributionField()).toHaveTextContent(/^Otel Contrib$/);
      expect(screen.queryByText(DISTRIBUTION_UNAVAILABLE_NOTE)).toBeNull();

      await closeFromNameStep(user);
      await reopenAtBlank(user);
      await distributionField();
      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  /*
   * "Start from a flow" (D12 Preflight ruling 8): the browse step, and the
   * name step for a flow (its pinned distribution a locked fact instead of
   * the picker), on Contrib 0.162.0.
   */
  describe("starting from a flow (D12)", () => {
    /** From the start step to the browse step, its flows listed. */
    async function browse(user: User) {
      await user.click(await screen.findByRole("button", { name: /Start from a flow/ }));
      return screen.findByRole("dialog", { name: "Start from a flow" });
    }

    /** The compact card of the flow named `name`. */
    function card(name: string) {
      return screen.getByRole("heading", { level: 3, name }).closest("[role=button]") as HTMLElement;
    }

    it("lists the flows on the browse step, with its copy, and Back to the start step", async () => {
      const { user } = await renderDialog({ atStart: true });
      const dialog = await browse(user);

      expect(dialog).toHaveTextContent(
        "Prebuilt configurations, each solving one problem. You'll get your own editable copy.",
      );
      expect(await within(dialog).findByRole("heading", { level: 3, name: TAIL_SAMPLING.name })).toBeInTheDocument();
      expect(within(dialog).getByRole("heading", { level: 3, name: PII_REDACTION.name })).toBeInTheDocument();
      // The compact cards: two lines of summary, no "View", pressed when picked.
      expect(card(TAIL_SAMPLING.name)).toHaveAttribute("aria-pressed", "false");
      expect(within(dialog).queryByText("View")).toBeNull();
      expect(within(dialog).getByPlaceholderText("Search flows…")).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Back" }));
      expect(await screen.findByRole("dialog", { name: "New configuration" })).toBeInTheDocument();
    });

    it("shows a spinner while the flows are read, and the empty text when there are none", async () => {
      let answer!: (flows: Flow[]) => void;
      vi.spyOn(apiClient, "getFlows").mockImplementation(
        () => new Promise((resolve) => (answer = (flows) => resolve({ flows }))),
      );
      const { user } = await renderDialog({ atStart: true });
      const dialog = await browse(user);
      expect(within(dialog).getByRole("status", { name: "Loading flows" })).toBeInTheDocument();

      await act(async () => answer([]));
      expect(within(dialog).getByText("No flows are available right now.")).toBeInTheDocument();
      expect(within(dialog).queryByRole("status")).toBeNull();
    });

    it("says no flows are available when the read fails, and reads again on reopening", async () => {
      const read = vi
        .spyOn(apiClient, "getFlows")
        .mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."))
        .mockResolvedValue({ flows: [TAIL_SAMPLING] });
      const error = vi.spyOn(toast, "error");
      const { user } = await renderDialog({ atStart: true });
      let dialog = await browse(user);
      expect(await within(dialog).findByText("No flows are available right now.")).toBeInTheDocument();
      expect(error).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole("button", { name: "Back" }));
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.click(screen.getByRole("button", { name: "Reopen" }));
      dialog = await browse(user);

      expect(await within(dialog).findByRole("heading", { level: 3, name: TAIL_SAMPLING.name })).toBeInTheDocument();
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("never offers or counts a hidden flow, though the API lists it to a product admin (Ruling 42)", async () => {
      // A product admin's read: the API lists the hidden flow too, `published: false`.
      useUserStore.getState().setCurrent({ ...signedInMember(), isProductAdmin: true });
      vi.spyOn(apiClient, "getFlows").mockResolvedValue({ flows: [TAIL_SAMPLING, HIDDEN, PII_REDACTION] });
      const { user } = await renderDialog({ atStart: true });

      expect(await screen.findByRole("button", { name: /Start from a flow/ })).toHaveTextContent(
        "Start from a flow2 prebuilt configurations",
      );
      const dialog = await browse(user);
      await within(dialog).findByRole("heading", { level: 3, name: TAIL_SAMPLING.name });
      expect(within(dialog).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
        TAIL_SAMPLING.name,
        PII_REDACTION.name,
      ]);
      expect(within(dialog).queryByRole("switch")).toBeNull();
      await user.type(within(dialog).getByPlaceholderText("Search flows…"), "draft");
      expect(within(dialog).getByText("No flows match your search or filter.")).toBeInTheDocument();
    });

    it("says no flows are available, uncounted, when every flow the API lists is hidden (Ruling 42)", async () => {
      useUserStore.getState().setCurrent({ ...signedInMember(), isProductAdmin: true });
      vi.spyOn(apiClient, "getFlows").mockResolvedValue({ flows: [HIDDEN] });
      const { user } = await renderDialog({ atStart: true });
      const dialog = await browse(user);

      expect(await within(dialog).findByText("No flows are available right now.")).toBeInTheDocument();
      expect(within(dialog).queryByRole("heading", { level: 3 })).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Back" }));
      expect(await screen.findByRole("button", { name: /Start from a flow/ })).toHaveTextContent(
        "Start from a flowPrebuilt configurations",
      );
    });

    it("shows a flow's pinned distribution as a locked fact instead of the picker, and creates its copy", async () => {
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const captureEvent = vi.spyOn(analytics, "captureEvent");
      const { user, onOpenChange } = await renderDialog({ atStart: true });
      await browse(user);
      await user.click(await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name }));

      const dialog = await screen.findByRole("dialog", { name: "Name Your Configuration" });
      expect(dialog).toHaveTextContent(
        `Based on ${TAIL_SAMPLING.name}. Your copy is independent — editing it won't affect the flow.`,
      );
      expect(screen.getByLabelText("Configuration Name")).toHaveValue(TAIL_SAMPLING.name);
      expect(screen.getByLabelText("Description")).toHaveValue(TAIL_SAMPLING.summary);
      // No choice on the flow path: the flow dictates the distribution, with no lock note.
      expect(screen.queryByRole("combobox", { name: "Distribution" })).toBeNull();
      expect(screen.queryByText(DISTRIBUTION_LOCK_NOTE)).toBeNull();
      expect(screen.getByText(/set by this flow/)).toHaveTextContent("Otel Contrib · collector v0.162.0 — set by this flow");

      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
      expect(createConfiguration).toHaveBeenCalledTimes(1);
      const [organizationId, request] = createConfiguration.mock.calls[0]!;
      expect(organizationId).toBe(GROUP_ID);
      expect(request).toMatchObject({
        name: TAIL_SAMPLING.name,
        description: TAIL_SAMPLING.summary,
        yamlContent: TAIL_SAMPLING.yaml,
        collectorDistribution: "otelcol-contrib",
        collectorVersion: "0.162.0",
        sourceFlowSlug: TAIL_SAMPLING.slug,
      });
      expect(request.nodes!.length).toBeGreaterThan(0);
      // config_created as on the blank path: no properties, so no flow's name or text (ADR 0024).
      expect(captureEvent.mock.calls).toEqual([["config_created"]]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("goes Back from a flow's name step to the start step, and a blank configuration then offers the dropdown, keeping the flow's name and summary", async () => {
      const { user } = await renderDialog({ atStart: true });
      await browse(user);
      await user.click(await screen.findByRole("heading", { level: 3, name: PII_REDACTION.name }));
      await screen.findByText(/set by this flow/);

      await user.click(screen.getByRole("button", { name: "Back" }));
      await chooseBlank(user);

      expect(await distributionField()).toHaveTextContent(/^Otel Contrib$/);
      expect(screen.queryByText(/set by this flow/)).toBeNull();
      expect(screen.getByRole("dialog")).toHaveTextContent("Give your OpenTelemetry configuration a descriptive name");
      // Choosing blank leaves the fields as they are: the flow's prefill stays.
      expect(screen.getByLabelText("Configuration Name")).toHaveValue(PII_REDACTION.name);
      expect(screen.getByLabelText("Description")).toHaveValue(PII_REDACTION.summary);
    });

    it("reopens at the start step, with nothing of the flow left", async () => {
      const { user } = await renderDialog({ atStart: true });
      await browse(user);
      await user.click(await screen.findByRole("heading", { level: 3, name: PII_REDACTION.name }));
      await screen.findByText(/set by this flow/);

      await closeFromNameStep(user);
      await user.click(screen.getByRole("button", { name: "Reopen" }));
      expect(await screen.findByRole("dialog", { name: "New configuration" })).toBeInTheDocument();
      await chooseBlank(user);

      expect(screen.getByLabelText("Configuration Name")).toHaveValue("");
      expect(screen.getByLabelText("Description")).toHaveValue("");
    });

    it("moves a copy of a flow on a pin the catalogue no longer offers to the default, and says so (D12 decision 16)", async () => {
      vi.spyOn(apiClient, "getFlows").mockResolvedValue({
        flows: [makeFlow({ collectorVersion: RETIRED_VERSION })],
      });
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const { user } = await renderDialog({ atStart: true });
      await browse(user);
      await user.click(await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name }));

      expect(await screen.findByText(/set by this flow/)).toHaveTextContent(
        "Otel Contrib · collector v0.162.0 — set by this flow",
      );
      expect(screen.getByText("This flow was built for collector v0.155.0, which is no longer offered; your copy will use v0.162.0.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
      expect(createConfiguration.mock.calls[0]![1]).toMatchObject({ collectorVersion: "0.162.0" });
    });

    it("sends the flow's pin with the catalogue unread, and toasts the API's refusal of it", async () => {
      vi.spyOn(apiClient, "getCollectorDistributions").mockRejectedValue(
        new ApiError("network_error", "Could not reach the server. Check your connection."),
      );
      vi.spyOn(apiClient, "getFlows").mockResolvedValue({
        flows: [makeFlow({ collectorVersion: RETIRED_VERSION })],
      });
      const createConfiguration = vi
        .spyOn(apiClient, "createConfiguration")
        .mockRejectedValue(new ApiError("collector_version_unknown", "That collector version isn't available."));
      const error = vi.spyOn(toast, "error");
      const { user, onOpenChange } = await renderDialog({ atStart: true });
      await browse(user);
      await user.click(await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name }));

      // The mark and label from the id, with the catalogue unread.
      expect(await screen.findByText(/set by this flow/)).toHaveTextContent(
        "Otel Contrib · collector v0.155.0 — set by this flow",
      );
      expect(screen.queryByText(/This flow was built for/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(error).toHaveBeenCalledWith("That collector version isn't available."));
      expect(createConfiguration.mock.calls[0]![1]).toMatchObject({ collectorVersion: RETIRED_VERSION });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    });

    it("refuses a flow D9a's parser can't read, saying it could not be loaded, and creates nothing", async () => {
      vi.spyOn(apiClient, "getFlows").mockResolvedValue({ flows: [makeFlow({ yaml: "receivers:\n  - [unclosed" })] });
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration");
      const captureEvent = vi.spyOn(analytics, "captureEvent");
      const error = vi.spyOn(toast, "error");
      const { user } = await renderDialog({ atStart: true });
      await browse(user);
      await user.click(await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name }));
      await user.click(await screen.findByRole("button", { name: "Create" }));

      await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/^This flow could not be loaded: \S/)));
      expect(createConfiguration).not.toHaveBeenCalled();
      expect(captureEvent).not.toHaveBeenCalled();
      expect(landed()).toBeNull();
    });

    it("on a 403 terms_acceptance_required from a flow's copy, closes and revalidates the layout, with no toast", async () => {
      vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(
        new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
      );
      const error = vi.spyOn(toast, "error");
      const { user, onOpenChange, loader } = await renderDialog({ atStart: true });
      await browse(user);
      await user.click(await screen.findByRole("heading", { level: 3, name: TAIL_SAMPLING.name }));
      const loadsBefore = loader.mock.calls.length;
      await user.click(await screen.findByRole("button", { name: "Create" }));

      await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(error).not.toHaveBeenCalled();
    });
  });
});
