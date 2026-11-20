import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigationType } from "react-router";
import { toast } from "sonner";
import { FlowsAdminPage, PIN_NO_LONGER_OFFERED } from "./FlowsAdminPage.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { RETIRED_VERSION, seedCatalogue } from "~/test/collector-distributions.js";
import { HIDDEN, PII_REDACTION, TAIL_SAMPLING, makeFlow } from "~/test/flows.js";

/*
 * Product admin's flows page: the table, the empty state, create, edit (only
 * the changed fields sent), the visibility switch, delete with its
 * confirmation, the toasts, the retired-pin mark, and the way out when the
 * flag is cleared mid-visit.
 */

/** A flow ClickStack wrote, pinned where the catalogue no longer offers. */
const RETIRED = makeFlow({
  id: "0199b000-0000-7000-8000-000000000004",
  slug: "otel-to-clickstack",
  name: "OTel to ClickStack",
  authorName: "ClickStack",
  collectorVersion: RETIRED_VERSION,
  sortOrder: 90,
});

/** A community flow: removable, never editable. */
const COMMUNITY = makeFlow({
  id: "0199b000-0000-7000-8000-000000000005",
  slug: "community-flow",
  name: "Community Flow",
  source: "community",
  sortOrder: 300,
});

const FLOWS = [TAIL_SAMPLING, PII_REDACTION, RETIRED, HIDDEN, COMMUNITY];

const FORBIDDEN = new ApiError("product_admin_required", "Only product admins can do that.", { status: 403 });
/** The API's answer for a flow deleted since the list was read (another admin's doing). */
const NOT_FOUND = new ApiError("flow_not_found", "Flow not found", { status: 404 });

function Landed() {
  return (
    <p>
      landed on {useLocation().pathname} by {useNavigationType()}
    </p>
  );
}

function renderPage() {
  const Stub = createRoutesStub([
    { path: "/product-admin/flows", Component: FlowsAdminPage },
    { path: "/app", Component: Landed },
  ]);
  render(<Stub initialEntries={["/product-admin/flows"]} />);
  return { user: userEvent.setup() };
}

/** Serves `lists` in turn to the page's reads of the flows, the last one again after. */
function serveFlows(...lists: Flow[][]) {
  const getFlows = vi.spyOn(apiClient, "getFlows");
  for (const list of lists) getFlows.mockResolvedValueOnce({ flows: list });
  getFlows.mockResolvedValue({ flows: lists.at(-1) ?? [] });
  return getFlows;
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("cell", { name }).closest("tr")!;
}

describe("FlowsAdminPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCollectorCatalogue();
    seedCatalogue();
  });

  it("shows the header, intro and table, every flow a product admin may see, hidden ones included", async () => {
    serveFlows(FLOWS);
    renderPage();

    expect(await screen.findByRole("cell", { name: TAIL_SAMPLING.name })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Flows" })).toBeInTheDocument();
    expect(
      screen.getByText(/Prebuilt configurations offered to every user, published as/).textContent,
    ).toBe(
      "Prebuilt configurations offered to every user, published as Built by Telflo unless a flow names another author. Anything marked visible appears in every user's flow gallery (and, where public flows are on, to visitors who aren't signed in). Switch it off to pull a flow from the gallery without deleting it.",
    );
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Slug",
      "Source",
      "Visible",
      "Signals",
      "Collector",
      "Order",
      "",
    ]);
    const row = within(rowOf(TAIL_SAMPLING.name));
    expect(row.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      TAIL_SAMPLING.name,
      TAIL_SAMPLING.slug,
      "Built by Telflo",
      `Hide ${TAIL_SAMPLING.name} from the gallery`,
      "traces, metrics",
      "0.162.0",
      "30",
      "",
    ]);
    expect(screen.getByRole("cell", { name: HIDDEN.name })).toBeInTheDocument();
    expect(within(rowOf(RETIRED.name)).getByText("Built by ClickStack")).toBeInTheDocument();
    expect(within(rowOf(COMMUNITY.name)).getByText("Community")).toBeInTheDocument();
  });

  it("offers Edit on telflo's flows only, and Remove from catalog on a community flow", async () => {
    serveFlows(FLOWS);
    renderPage();
    await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

    expect(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(rowOf(COMMUNITY.name)).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(rowOf(COMMUNITY.name)).getByRole("button", { name: "Remove from catalog" })).toBeInTheDocument();
  });

  it("shows the switch on for a visible flow and off for a hidden one", async () => {
    serveFlows(FLOWS);
    renderPage();

    expect(
      await screen.findByRole("switch", { name: `Hide ${TAIL_SAMPLING.name} from the gallery` }),
    ).toBeChecked();
    expect(screen.getByRole("switch", { name: `Show ${HIDDEN.name} on the gallery` })).not.toBeChecked();
  });

  it("shows the empty state, whose New flow opens the dialog", async () => {
    serveFlows([]);
    const { user } = renderPage();

    expect(await screen.findByText("No flows yet. The gallery is empty until you add one.")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "New flow" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    expect(await screen.findByRole("dialog", { name: "New flow" })).toBeInTheDocument();
  });

  it("toasts nothing when the read finds the session over (401 unauthenticated): the session-ended handler, or Logout, has the page", async () => {
    vi.spyOn(apiClient, "getFlows").mockRejectedValue(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    const error = vi.spyOn(toast, "error");
    renderPage();

    expect(await screen.findByText("No flows yet. The gallery is empty until you add one.")).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  it("toasts a fixed message when the flows can't be read", async () => {
    vi.spyOn(apiClient, "getFlows").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
    const error = vi.spyOn(toast, "error");
    renderPage();

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to load flows"));
  });

  describe("the retired-pin mark", () => {
    it("marks a flow whose pin the catalogue no longer offers, and no other", async () => {
      serveFlows(FLOWS);
      renderPage();
      await screen.findByRole("cell", { name: RETIRED.name });

      const collector = within(rowOf(RETIRED.name)).getAllByRole("cell")[5]!;
      expect(collector).toHaveTextContent(`${RETIRED_VERSION}${PIN_NO_LONGER_OFFERED}`);
      expect(PIN_NO_LONGER_OFFERED).toBe("No longer offered");
      expect(screen.getAllByText(PIN_NO_LONGER_OFFERED)).toHaveLength(1);
    });

    it("marks nothing while the catalogue can't say", async () => {
      resetCollectorCatalogue();
      vi.spyOn(apiClient, "getCollectorDistributions").mockRejectedValue(new ApiError("network_error", "Down."));
      serveFlows(FLOWS);
      renderPage();
      await screen.findByRole("cell", { name: RETIRED.name });

      expect(within(rowOf(RETIRED.name)).getAllByRole("cell")[5]!).toHaveTextContent(new RegExp(`^${RETIRED_VERSION}$`));
      expect(screen.queryByText(PIN_NO_LONGER_OFFERED)).toBeNull();
    });
  });

  describe("creating a flow", () => {
    it("creates it with the dialog's fields, toasts Flow created, and reads the flows again", async () => {
      const created = makeFlow({ id: "0199b000-0000-7000-8000-000000000009", slug: "pii-gateway", name: "PII Gateway" });
      const getFlows = serveFlows([TAIL_SAMPLING], [TAIL_SAMPLING, created]);
      const createFlow = vi.spyOn(apiClient, "createFlow").mockResolvedValue({ flow: created });
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(screen.getByRole("button", { name: "New flow" }));
      await user.type(screen.getByLabelText("Name"), "PII Gateway");
      await user.type(screen.getByLabelText("Summary"), "Strips emails.");
      await user.click(screen.getByLabelText("Configuration YAML"));
      await user.paste(PII_REDACTION.yaml);
      await user.click(screen.getByRole("button", { name: "Create flow" }));

      expect(await screen.findByRole("cell", { name: "PII Gateway" })).toBeInTheDocument();
      expect(createFlow).toHaveBeenCalledWith({
        slug: "pii-gateway",
        name: "PII Gateway",
        summary: "Strips emails.",
        description: "Strips emails.",
        signals: ["logs"],
        tags: [],
        yaml: PII_REDACTION.yaml,
        collectorDistribution: "otelcol-contrib",
        collectorVersion: "0.162.0",
        sourceUrl: null,
        authorName: null,
        sortOrder: 0,
      });
      expect(success).toHaveBeenCalledWith("Flow created");
      expect(getFlows).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("editing a flow", () => {
    it("sends only the fields that changed, and toasts Flow updated", async () => {
      serveFlows([TAIL_SAMPLING]);
      const updateFlow = vi
        .spyOn(apiClient, "updateFlow")
        .mockResolvedValue({ flow: { ...TAIL_SAMPLING, name: "Keep Errors" } });
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" }));
      const name = await screen.findByLabelText("Name");
      await user.clear(name);
      await user.type(name, "Keep Errors");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(success).toHaveBeenCalledWith("Flow updated"));
      expect(updateFlow).toHaveBeenCalledWith(TAIL_SAMPLING.id, { name: "Keep Errors" });
    });

    it("keeps a retired pin on an edit that doesn't change it: the pin isn't sent", async () => {
      serveFlows([RETIRED]);
      const updateFlow = vi.spyOn(apiClient, "updateFlow").mockResolvedValue({ flow: RETIRED });
      const { user } = renderPage();
      await screen.findByRole("cell", { name: RETIRED.name });

      await user.click(within(rowOf(RETIRED.name)).getByRole("button", { name: "Edit" }));
      expect(await screen.findByRole("combobox", { name: "Collector version" })).toHaveTextContent(
        `${RETIRED_VERSION} · no longer offered`,
      );
      await user.type(screen.getByLabelText("Summary"), " Now faster.");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateFlow).toHaveBeenCalled());
      expect(updateFlow).toHaveBeenCalledWith(RETIRED.id, { summary: `${RETIRED.summary} Now faster.` });
    });

    it("sends the distribution and the version when the admin re-pins", async () => {
      serveFlows([RETIRED]);
      const updateFlow = vi.spyOn(apiClient, "updateFlow").mockResolvedValue({ flow: RETIRED });
      const { user } = renderPage();
      await screen.findByRole("cell", { name: RETIRED.name });

      await user.click(within(rowOf(RETIRED.name)).getByRole("button", { name: "Edit" }));
      await user.click(await screen.findByRole("combobox", { name: "Collector version" }));
      await user.click(await screen.findByRole("option", { name: "0.162.0" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateFlow).toHaveBeenCalled());
      expect(updateFlow).toHaveBeenCalledWith(RETIRED.id, {
        collectorDistribution: "otelcol-contrib",
        collectorVersion: "0.162.0",
      });
    });
  });

  describe("the visibility switch", () => {
    it("hides a visible flow with a PATCH of published alone, toasting that it is hidden", async () => {
      const getFlows = serveFlows([TAIL_SAMPLING], [{ ...TAIL_SAMPLING, published: false }]);
      const updateFlow = vi
        .spyOn(apiClient, "updateFlow")
        .mockResolvedValue({ flow: { ...TAIL_SAMPLING, published: false } });
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();

      await user.click(await screen.findByRole("switch", { name: `Hide ${TAIL_SAMPLING.name} from the gallery` }));

      expect(
        await screen.findByRole("switch", { name: `Show ${TAIL_SAMPLING.name} on the gallery` }),
      ).not.toBeChecked();
      expect(updateFlow).toHaveBeenCalledWith(TAIL_SAMPLING.id, { published: false });
      expect(success).toHaveBeenCalledWith("Flow hidden");
      expect(getFlows).toHaveBeenCalledTimes(2);
    });

    it("shows a hidden flow, toasting Flow is now visible", async () => {
      serveFlows([HIDDEN], [{ ...HIDDEN, published: true }]);
      const updateFlow = vi.spyOn(apiClient, "updateFlow").mockResolvedValue({ flow: { ...HIDDEN, published: true } });
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();

      await user.click(await screen.findByRole("switch", { name: `Show ${HIDDEN.name} on the gallery` }));

      await waitFor(() => expect(success).toHaveBeenCalledWith("Flow is now visible"));
      expect(updateFlow).toHaveBeenCalledWith(HIDDEN.id, { published: true });
    });

    it("toasts a fixed failure when the change fails", async () => {
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "updateFlow").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();

      await user.click(await screen.findByRole("switch", { name: `Hide ${TAIL_SAMPLING.name} from the gallery` }));

      await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to update the flow"));
    });
  });

  describe("deleting a flow", () => {
    it("asks first, by the flow's name, and Cancel deletes nothing", async () => {
      serveFlows([TAIL_SAMPLING]);
      const deleteFlow = vi.spyOn(apiClient, "deleteFlow").mockResolvedValue(undefined);
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" }));
      const confirm = await screen.findByRole("alertdialog", { name: `Delete “${TAIL_SAMPLING.name}”?` });
      expect(confirm).toHaveTextContent(
        "It disappears from the gallery and its public page starts returning 404. Configurations users already created from it are unaffected — they own their copy.",
      );
      await user.click(within(confirm).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(deleteFlow).not.toHaveBeenCalled();
    });

    it("deletes on Delete, toasts Flow deleted, and reads the flows again", async () => {
      const getFlows = serveFlows([TAIL_SAMPLING, PII_REDACTION], [PII_REDACTION]);
      const deleteFlow = vi.spyOn(apiClient, "deleteFlow").mockResolvedValue(undefined);
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(screen.queryByRole("cell", { name: TAIL_SAMPLING.name })).toBeNull());
      expect(deleteFlow).toHaveBeenCalledWith(TAIL_SAMPLING.id);
      expect(success).toHaveBeenCalledWith("Flow deleted");
      expect(getFlows).toHaveBeenCalledTimes(2);
    });

    it("toasts a fixed failure when the delete fails", async () => {
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "deleteFlow").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to delete flow"));
    });
  });

  describe("a flow deleted since the list was read (404 flow_not_found)", () => {
    it("a delete counts as done: Flow deleted, the flows read again, and its row gone", async () => {
      const getFlows = serveFlows([TAIL_SAMPLING, PII_REDACTION], [PII_REDACTION]);
      vi.spyOn(apiClient, "deleteFlow").mockRejectedValue(NOT_FOUND);
      const success = vi.spyOn(toast, "success");
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(screen.queryByRole("cell", { name: TAIL_SAMPLING.name })).toBeNull());
      expect(success).toHaveBeenCalledWith("Flow deleted");
      expect(error).not.toHaveBeenCalled();
      expect(getFlows).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("cell", { name: PII_REDACTION.name })).toBeInTheDocument();
    });

    it("the visibility switch shows the API's message and reads the flows again: its row goes", async () => {
      const getFlows = serveFlows([TAIL_SAMPLING, PII_REDACTION], [PII_REDACTION]);
      vi.spyOn(apiClient, "updateFlow").mockRejectedValue(NOT_FOUND);
      const success = vi.spyOn(toast, "success");
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();

      await user.click(await screen.findByRole("switch", { name: `Hide ${TAIL_SAMPLING.name} from the gallery` }));

      await waitFor(() => expect(screen.queryByRole("cell", { name: TAIL_SAMPLING.name })).toBeNull());
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("Flow not found");
      expect(success).not.toHaveBeenCalled();
      expect(getFlows).toHaveBeenCalledTimes(2);
    });

    it("an edit shows the API's message in the dialog and reads the flows again: its row goes behind it", async () => {
      const getFlows = serveFlows([TAIL_SAMPLING, PII_REDACTION], [PII_REDACTION]);
      vi.spyOn(apiClient, "updateFlow").mockRejectedValue(NOT_FOUND);
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" }));
      await user.type(await screen.findByLabelText("Summary"), " Now faster.");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      const dialog = screen.getByRole("dialog", { name: "Edit flow" });
      expect(await within(dialog).findByText("Flow not found")).toBeInTheDocument();
      expect(getFlows).toHaveBeenCalledTimes(2);
      // Behind the modal dialog, hidden from the accessibility tree: looked for there too.
      await waitFor(() => expect(screen.queryByRole("cell", { name: TAIL_SAMPLING.name, hidden: true })).toBeNull());
      expect(screen.getByRole("cell", { name: PII_REDACTION.name, hidden: true })).toBeInTheDocument();
      expect(success).not.toHaveBeenCalled();
    });
  });

  describe("a cleared flag (403 product_admin_required) goes to /app, replacing the page", () => {
    it("from the visibility switch", async () => {
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "updateFlow").mockRejectedValue(FORBIDDEN);
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();

      await user.click(await screen.findByRole("switch", { name: `Hide ${TAIL_SAMPLING.name} from the gallery` }));

      expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
      expect(error).not.toHaveBeenCalled();
    });

    it("from a delete", async () => {
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "deleteFlow").mockRejectedValue(FORBIDDEN);
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

      expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    });

    it("from a save", async () => {
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "updateFlow").mockRejectedValue(FORBIDDEN);
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" }));
      await user.type(await screen.findByLabelText("Tags"), ", more");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    });

    it("from the security check", async () => {
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "lintFlow").mockRejectedValue(FORBIDDEN);
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" }));
      await user.click(await screen.findByRole("button", { name: "Run security check" }));

      expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    });
  });

  describe("the focus as the dialog or the confirmation closes (no Radix trigger, so not the body)", () => {
    it("goes back to New flow and to the row's Edit: Cancel, Escape", async () => {
      serveFlows([TAIL_SAMPLING]);
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });
      const newFlow = () => screen.getByRole("button", { name: "New flow" });
      const edit = () => within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" });

      await user.click(newFlow());
      await user.click(within(await screen.findByRole("dialog", { name: "New flow" })).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(newFlow()));

      await user.click(edit());
      await screen.findByRole("dialog", { name: "Edit flow" });
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(edit()));
    });

    it("goes back to the row's Edit after a save", async () => {
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "updateFlow").mockResolvedValue({ flow: { ...TAIL_SAMPLING, name: "Keep Errors" } });
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });

      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" }));
      const name = await screen.findByLabelText("Name");
      await user.clear(name);
      await user.type(name, "Keep Errors");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" })));
    });

    it("goes back to the row's Delete on Cancel, and to New flow once the row has gone with the delete", async () => {
      serveFlows([TAIL_SAMPLING, PII_REDACTION], [PII_REDACTION]);
      vi.spyOn(apiClient, "deleteFlow").mockResolvedValue(undefined);
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });
      const remover = () => within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" });

      await user.click(remover());
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(remover()));

      await user.click(remover());
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("cell", { name: TAIL_SAMPLING.name })).toBeNull());
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "New flow" })));
    });

    it("goes to New flow when the row goes with a delete answered after the confirmation has closed: back to its Delete first", async () => {
      serveFlows([TAIL_SAMPLING, PII_REDACTION], [PII_REDACTION]);
      let answer!: () => void;
      vi.spyOn(apiClient, "deleteFlow").mockImplementation(
        () => new Promise<undefined>((resolve) => (answer = () => resolve(undefined))),
      );
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });
      const remover = within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" });

      await user.click(remover);
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      // Closed at the click, the delete still unanswered: the focus back on the row's Delete.
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(remover));
      expect(answer).toBeDefined();

      answer();

      await waitFor(() => expect(screen.queryByRole("cell", { name: TAIL_SAMPLING.name })).toBeNull());
      expect(remover.isConnected).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "New flow" })));
    });

    it("leaves the focus on the row's Delete when the late delete fails, and where the person has put it since when the row goes", async () => {
      serveFlows([TAIL_SAMPLING, PII_REDACTION], [PII_REDACTION]);
      const answers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
      vi.spyOn(apiClient, "deleteFlow").mockImplementation(
        () => new Promise<undefined>((resolve, reject) => answers.push({ resolve: () => resolve(undefined), reject })),
      );
      const toastError = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });
      const remover = within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" });

      await user.click(remover);
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(document.activeElement).toBe(remover));
      answers[0]!.reject(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete flow"));
      // A render later, still on the row's Delete.
      await act(async () => undefined);
      expect(document.activeElement).toBe(remover);

      await user.click(remover);
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(document.activeElement).toBe(remover));
      const other = within(rowOf(PII_REDACTION.name)).getByRole("button", { name: "Edit" });
      act(() => other.focus());
      answers[1]!.resolve();
      await waitFor(() => expect(screen.queryByRole("cell", { name: TAIL_SAMPLING.name })).toBeNull());
      await act(async () => undefined);
      expect(document.activeElement).toBe(other);
    });
  });

  describe("privacy", () => {
    it("puts no flow's text in any attribute, with the table and the edit dialog shown", async () => {
      serveFlows(FLOWS);
      const { user } = renderPage();
      await screen.findByRole("cell", { name: TAIL_SAMPLING.name });
      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" }));
      await screen.findByRole("dialog", { name: "Edit flow" });

      const words = [
        ...FLOWS.flatMap((flow) => [flow.name, flow.summary]),
        "TRACES_BACKEND_ENDPOINT",
        "keep-all-errors",
      ];
      for (const element of document.body.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          // An input's value, which React mirrors into the attribute, is
          // masked by replay (maskAllInputs) and autocapture alike.
          if (element.tagName === "INPUT" && attribute.name === "value") continue;
          for (const word of words) expect(`${attribute.name}=${attribute.value}`).not.toContain(word);
        }
      }
    });

    it("sends no analytics event for a create, an edit, a switch or a delete", async () => {
      const captureEvent = vi.spyOn(analytics, "captureEvent");
      serveFlows([TAIL_SAMPLING]);
      vi.spyOn(apiClient, "updateFlow").mockResolvedValue({ flow: TAIL_SAMPLING });
      vi.spyOn(apiClient, "deleteFlow").mockResolvedValue(undefined);
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();

      await user.click(await screen.findByRole("switch", { name: `Hide ${TAIL_SAMPLING.name} from the gallery` }));
      await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Edit" }));
      await user.type(await screen.findByLabelText("Tags"), ", more");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
      await user.click(within(rowOf(TAIL_SAMPLING.name)).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(success).toHaveBeenCalledTimes(3));

      expect(captureEvent).not.toHaveBeenCalled();
    });
  });
});
