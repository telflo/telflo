import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow } from "@telflo/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { toast } from "sonner";
import { USE_FLOW_FAILED_MESSAGE, UseFlowDialog } from "./UseFlowDialog.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { CATALOGUE, RETIRED_VERSION } from "~/test/collector-distributions.js";
import { MINE, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { TAIL_SAMPLING, makeFlow } from "~/test/flows.js";

/*
 * "Use this flow": it instantiates the flow on its own distribution (the
 * create sends the flow's distribution and pin, and the editor opens) and
 * quotes the flow's own pin. There are no ClickStack cases and no "Select an
 * organization first" (there is always an active organization). The
 * deprecated pin and the create behaviors are covered too.
 */

function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

function renderDialog(flow: Flow = TAIL_SAMPLING) {
  useUserStore.getState().setCurrent(signedInMember());
  const onOpenChange = vi.fn();
  const loader = vi.fn(() => null);

  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <UseFlowDialog
          flow={flow}
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
        />
      </>
    );
  }

  const Stub = createRoutesStub([
    { path: "/app/flows/:slug", Component: Page, loader, HydrateFallback: () => null },
    { path: "/editor/:configurationId", Component: Landed },
  ]);
  render(<Stub initialEntries={[`/app/flows/${flow.slug}`]} />);
  return { onOpenChange, loader, user: userEvent.setup() };
}

function createButton() {
  return screen.findByRole("button", { name: "Create configuration" });
}

describe("UseFlowDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCollectorCatalogue();
    useUserStore.getState().clear();
    vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });
  });

  it("instantiates the flow on its own distribution and pin, and opens the editor", async () => {
    const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    const { user } = renderDialog();

    await user.click(await createButton());

    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    expect(createConfiguration).toHaveBeenCalledTimes(1);
    const [organizationId, request] = createConfiguration.mock.calls[0]!;
    expect(organizationId).toBe(PERSONAL_ID);
    expect(request).toMatchObject({
      name: TAIL_SAMPLING.name,
      description: TAIL_SAMPLING.summary,
      yamlContent: TAIL_SAMPLING.yaml,
      collectorDistribution: "otelcol-contrib",
      collectorVersion: "0.162.0",
      sourceFlowSlug: TAIL_SAMPLING.slug,
    });
    // config_created, with no properties: no flow's name or text in an event.
    expect(captureEvent.mock.calls).toEqual([["config_created"]]);
  });

  it("quotes the flow's own pin", async () => {
    renderDialog(makeFlow({ collectorVersion: "0.161.0" }));

    expect(await screen.findByText("pinned to collector v0.161.0")).toBeInTheDocument();
    expect(screen.queryByText(/This flow was built for/)).toBeNull();
  });

  it("shows its copy, prefilled with the flow's name and summary", async () => {
    renderDialog();

    const dialog = await screen.findByRole("dialog", { name: "Use this flow" });
    expect(dialog).toHaveTextContent(
      `Creates your own configuration from ${TAIL_SAMPLING.name}. Edit it freely — it won't change when the flow is updated.`,
    );
    expect(screen.getByLabelText("Configuration name")).toHaveValue(TAIL_SAMPLING.name);
    expect(screen.getByLabelText("Configuration name")).toHaveAttribute("maxlength", "200");
    expect(screen.getByLabelText("Description")).toHaveValue(TAIL_SAMPLING.summary);
    expect(screen.getByLabelText("Description")).toHaveAttribute("maxlength", "500");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  describe("a pin the catalog no longer offers", () => {
    it("quotes the default the copy will use, says why, and creates on it", async () => {
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const { user } = renderDialog(makeFlow({ collectorVersion: RETIRED_VERSION }));

      expect(await screen.findByText("pinned to collector v0.162.0")).toBeInTheDocument();
      expect(
        screen.getByText("This flow was built for collector v0.155.0, which is no longer offered; your copy will use v0.162.0."),
      ).toBeInTheDocument();
      await user.click(await createButton());

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
      expect(createConfiguration.mock.calls[0]![1]).toMatchObject({ collectorVersion: "0.162.0" });
    });

    it("sends the flow's pin while the catalog is unread, and toasts the API's refusal", async () => {
      vi.spyOn(apiClient, "getCollectorDistributions").mockRejectedValue(
        new ApiError("network_error", "Could not reach the server. Check your connection."),
      );
      const createConfiguration = vi
        .spyOn(apiClient, "createConfiguration")
        .mockRejectedValue(new ApiError("collector_version_unknown", "That collector version isn't available."));
      const error = vi.spyOn(toast, "error");
      const { user, onOpenChange } = renderDialog(makeFlow({ collectorVersion: RETIRED_VERSION }));

      expect(await screen.findByText("pinned to collector v0.155.0")).toBeInTheDocument();
      await user.click(await createButton());

      await waitFor(() => expect(error).toHaveBeenCalledWith("That collector version isn't available."));
      expect(createConfiguration.mock.calls[0]![1]).toMatchObject({ collectorVersion: RETIRED_VERSION });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(await createButton()).toBeEnabled();
    });
  });

  it("trims the name and description, and disables Create for a name of spaces", async () => {
    const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
    const { user } = renderDialog();
    const name = await screen.findByLabelText("Configuration name");

    await user.clear(name);
    await user.type(name, "   ");
    expect(await createButton()).toBeDisabled();

    await user.type(name, " Mine ");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "  Kept short  {Enter}");
    await user.type(name, "{Enter}");

    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    expect(createConfiguration.mock.calls[0]![1]).toMatchObject({ name: "Mine", description: "Kept short" });
  });

  it("creates once for two quick submits, says Creating…, and doesn't close meanwhile", async () => {
    let finish!: () => void;
    const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ configuration: MINE }))),
    );
    const { user, onOpenChange } = renderDialog();
    const name = await screen.findByLabelText("Configuration name");

    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Use this flow" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    finish();
    expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    expect(createConfiguration).toHaveBeenCalledTimes(1);
  });

  it("closes on Cancel, and reopens with the flow's name again", async () => {
    const { user, onOpenChange } = renderDialog();
    await user.type(await screen.findByLabelText("Configuration name"), " abandoned");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(await screen.findByLabelText("Configuration name")).toHaveValue(TAIL_SAMPLING.name);
  });

  it("refuses a flow the parser can't read with its fixed words, and creates nothing", async () => {
    const createConfiguration = vi.spyOn(apiClient, "createConfiguration");
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    const error = vi.spyOn(toast, "error");
    const { user } = renderDialog(makeFlow({ yaml: "receivers:\n  - [unclosed" }));

    await user.click(await createButton());

    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/^This flow could not be loaded: \S/)));
    expect(createConfiguration).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalled();
    expect(await createButton()).toBeEnabled();
  });

  it("toasts the API's refusal, and Failed to use this flow for anything else", async () => {
    const error = vi.spyOn(toast, "error");
    vi.spyOn(apiClient, "createConfiguration")
      .mockRejectedValueOnce(new ApiError("organization_access_denied", "You are not an active member of this organization"))
      .mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const { user, onOpenChange } = renderDialog();

    await user.click(await createButton());
    await waitFor(() => expect(error).toHaveBeenLastCalledWith("You are not an active member of this organization"));
    await user.click(await createButton());
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(USE_FLOW_FAILED_MESSAGE));
    expect(USE_FLOW_FAILED_MESSAGE).toBe("Failed to use this flow");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it.each([
    ["a 404 organization_not_found", new ApiError("organization_not_found", "Organization not found")],
    ["a 403 terms_acceptance_required", new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.")],
  ])("on %s, closes and revalidates the layout, with no toast", async (_why, refusal) => {
    vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(refusal);
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, loader } = renderDialog();
    const button = await createButton();
    const loadsBefore = loader.mock.calls.length;

    await user.click(button);

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(error).not.toHaveBeenCalled();
  });

  it("does nothing when the create answers after the organization changed", async () => {
    let finish!: () => void;
    vi.spyOn(apiClient, "createConfiguration").mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ configuration: MINE }))),
    );
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    const { user } = renderDialog();
    await user.click(await createButton());
    expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();

    // Another organization, seen meanwhile (a switch in another tab).
    useUserStore.getState().setCurrent(signedInMember("00000000-0000-4000-8000-000000000003"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Creating…" })).toBeInTheDocument());
    finish();

    expect(await createButton()).toBeEnabled();
    expect(screen.queryByText(/landed on/)).toBeNull();
    expect(captureEvent).not.toHaveBeenCalled();
  });
});
