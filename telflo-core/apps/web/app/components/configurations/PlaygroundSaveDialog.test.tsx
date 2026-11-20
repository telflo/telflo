import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet, createRoutesStub, useLocation, useRevalidator } from "react-router";
import type { CurrentUserResponse } from "@telflo/contracts";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { parse } from "~/lib/graph/parse.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import {
  STAGED_EDIT_KEY,
  STAGED_EDIT_MAX_AGE_MS,
  stagePlaygroundEdit,
  readStagedEdit,
  type StagedContent,
} from "~/lib/playground/staged-edit.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import { CATALOGUE, RETIRED_VERSION } from "~/test/collector-distributions.js";
import { GROUP_ID, MINE, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import {
  PLAYGROUND_DISCARD_TITLE,
  PLAYGROUND_SAVE_FAILED_MESSAGE,
  PLAYGROUND_SAVE_TITLE,
  PlaygroundSaveDialog,
} from "./PlaygroundSaveDialog.js";

/*
 * The playground's handoff: on the signed-in configurations page, a staged
 * edit opens "Save your playground configuration?" once the terms are
 * accepted; nothing is sent before Save; Save creates with the four content
 * fields and the pin, removes the staged edit and opens the editor; Discard
 * asks once and removes it; a refusal keeps it and says why (a pin no longer
 * offered moves to the default, terms revalidate, anything else the
 * configurations' words); an expired or malformed staged edit is ignored and
 * removed. The staged text is the test's own; it is compared as a boolean,
 * never printed.
 */

const TEXT = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;

function content(overrides: Partial<StagedContent> = {}): StagedContent {
  const parsed = parse(TEXT);
  if (!parsed.ok) throw new Error("the test's text doesn't parse");
  return {
    name: "Gateway from the playground",
    yamlContent: TEXT,
    ...toStored(parsed.graph),
    collectorDistribution: "otelcol-contrib",
    collectorVersion: "0.161.0",
    ...overrides,
  };
}

function stage(overrides: Partial<StagedContent> = {}, now = Date.now()) {
  expect(stagePlaygroundEdit(content(overrides), now)).toBe("staged");
}

function isStaged(): boolean {
  return window.localStorage.getItem(STAGED_EDIT_KEY) !== null;
}

function Landed() {
  return <p data-testid="landed">{useLocation().pathname}</p>;
}

/** The layout's loader data: the member, the terms accepted unless `layout.termsRequired`. */
const layout = { termsRequired: false };

function Layout() {
  const { revalidate } = useRevalidator();
  return (
    <>
      <button type="button" onClick={() => void revalidate()}>
        Revalidate
      </button>
      <Outlet />
    </>
  );
}

/** `/app`'s dialog, in the personal organization until "Switch organization" (as the page's organization changes on a switch). */
function AppPage() {
  const [organizationId, setOrganizationId] = useState(PERSONAL_ID);
  return (
    <>
      <button type="button" onClick={() => setOrganizationId(GROUP_ID)}>
        Switch organization
      </button>
      <PlaygroundSaveDialog organizationId={organizationId} />
    </>
  );
}

/** Switches the page's organization while a modal dialog hides the rest of the page. */
function switchOrganization() {
  fireEvent.click(screen.getByRole("button", { name: "Switch organization", hidden: true }));
}

function renderDialog() {
  const loader = vi.fn(
    (): AppLayoutData => ({ status: "signed_in", currentUser: signedInMember(PERSONAL_ID, layout.termsRequired) as CurrentUserResponse }),
  );
  const Stub = createRoutesStub([
    {
      id: "routes/app-layout",
      Component: Layout,
      loader,
      HydrateFallback: () => null,
      children: [
        { path: "/app", Component: AppPage },
        { path: "/editor/:configurationId", Component: Landed },
      ],
    },
  ]);
  render(<Stub initialEntries={["/app"]} />);
  return { loader, user: userEvent.setup() };
}

function saveDialog() {
  return screen.findByRole("dialog", { name: PLAYGROUND_SAVE_TITLE });
}

let create: MockInstance<typeof apiClient.createConfiguration>;

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetCollectorCatalogue();
  useUserStore.getState().clear();
  layout.termsRequired = false;
  vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });
  create = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlaygroundSaveDialog", () => {
  it("opens with the staged name and its pin, and sends nothing before Save", async () => {
    stage();
    renderDialog();
    const dialog = await saveDialog();
    expect(within(dialog).getByLabelText("Configuration name")).toHaveValue("Gateway from the playground");
    expect(within(dialog).getByText("pinned to collector v0.161.0")).toBeInTheDocument();
    // The name field is inside ph-no-capture; the text is shown nowhere.
    expect(within(dialog).getByLabelText("Configuration name").closest(".ph-no-capture")).not.toBeNull();
    expect(document.body.textContent?.includes("otlp")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
    expect(isStaged()).toBe(true);
  });

  it("Save creates the configuration with the four content fields and the pin, removes the staged edit, and opens the editor", async () => {
    const captureEvent = vi.spyOn(analytics, "captureEvent");
    stage();
    const { user } = renderDialog();
    const dialog = await saveDialog();
    const field = within(dialog).getByLabelText("Configuration name");
    await user.clear(field);
    await user.type(field, "  My gateway  ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("landed")).toHaveTextContent(`/editor/${MINE.id}`);
    expect(create).toHaveBeenCalledTimes(1);
    const [organizationId, request] = create.mock.calls[0]!;
    expect(organizationId).toBe(PERSONAL_ID);
    const staged = content();
    expect(Object.keys(request).sort()).toEqual(
      ["collectorDistribution", "collectorVersion", "description", "edges", "name", "nodes", "pipelines", "yamlContent"].sort(),
    );
    expect(request).toMatchObject({ name: "My gateway", description: "", collectorDistribution: "otelcol-contrib", collectorVersion: "0.161.0" });
    expect(request.yamlContent === TEXT).toBe(true);
    expect(JSON.stringify([request.nodes, request.edges, request.pipelines]) === JSON.stringify([staged.nodes, staged.edges, staged.pipelines])).toBe(true);
    expect(isStaged()).toBe(false);
    expect(captureEvent.mock.calls).toEqual([["config_created"]]);
  });

  it("Save needs a name: disabled while the trimmed name is empty", async () => {
    stage();
    const { user } = renderDialog();
    const dialog = await saveDialog();
    await user.clear(within(dialog).getByLabelText("Configuration name"));
    await user.type(within(dialog).getByLabelText("Configuration name"), "   ");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(create).not.toHaveBeenCalled();
  });

  it("Discard asks once; Cancel there goes back; Discard removes it and creates nothing", async () => {
    stage();
    const { user } = renderDialog();
    await user.click(within(await saveDialog()).getByRole("button", { name: "Discard" }));
    const confirm = await screen.findByRole("alertdialog", { name: PLAYGROUND_DISCARD_TITLE });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(await saveDialog()).toBeInTheDocument();
    expect(isStaged()).toBe(true);

    await user.click(within(await saveDialog()).getByRole("button", { name: "Discard" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: PLAYGROUND_DISCARD_TITLE })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(isStaged()).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("Escape closes it and keeps the staged edit", async () => {
    stage();
    const { user } = renderDialog();
    await saveDialog();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(isStaged()).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("a refusal keeps the staged edit and says the configurations' words; one they don't cover says the fallback", async () => {
    create
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many requests. Try again shortly.", { status: 429 }))
      .mockRejectedValueOnce(new ApiError("invalid_request", "The request was not valid.", { status: 400 }));
    stage();
    const { user } = renderDialog();
    const dialog = await saveDialog();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Too many requests. Try again shortly.");
    expect(isStaged()).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(PLAYGROUND_SAVE_FAILED_MESSAGE));
    expect(isStaged()).toBe(true);
    expect(screen.queryByTestId("landed")).toBeNull();
  });

  it("a pin the API no longer offers: the staged edit kept, the default offered, and Save again uses it", async () => {
    create.mockRejectedValueOnce(new ApiError("collector_version_unknown", "That collector version isn't available.", { status: 400 }));
    stage();
    const { user } = renderDialog();
    const dialog = await saveDialog();
    // The catalog (read once the dialog opens) offers 0.161.0: the staged pin is sent.
    await waitFor(() => expect(apiClient.getCollectorDistributions).toHaveBeenCalled());
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "Your playground configuration was built for collector v0.161.0, which is no longer offered; it will use v0.162.0.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("pinned to collector v0.162.0")).toBeInTheDocument();
    expect(isStaged()).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("landed")).toHaveTextContent(`/editor/${MINE.id}`);
    expect(create.mock.calls.map(([, request]) => request.collectorVersion)).toEqual(["0.161.0", "0.162.0"]);
  });

  it("a staged pin the catalog no longer offers moves to its default before Save, as a flow's copy does", async () => {
    stage({ collectorVersion: RETIRED_VERSION });
    const { user } = renderDialog();
    const dialog = await saveDialog();
    expect(await within(dialog).findByText("pinned to collector v0.162.0")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `Your playground configuration was built for collector v${RETIRED_VERSION}, which is no longer offered; it will use v0.162.0.`,
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findByTestId("landed");
    expect(create.mock.calls[0]![1].collectorVersion).toBe("0.162.0");
  });

  it("opens only once the terms are accepted; a terms refusal keeps it, revalidates, and it opens again after acceptance", async () => {
    stage();
    layout.termsRequired = true;
    const { user, loader } = renderDialog();
    await waitFor(() => expect(loader).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Accepted (the layout's terms dialog, elsewhere): the dialog opens.
    layout.termsRequired = false;
    await user.click(screen.getByRole("button", { name: "Revalidate" }));
    const dialog = await saveDialog();

    // The API says the terms changed since: closed, kept, the layout revalidated.
    const loads = loader.mock.calls.length;
    create.mockImplementationOnce(async () => {
      layout.termsRequired = true;
      throw new ApiError("terms_acceptance_required", "Accept the current terms to continue.", { status: 403 });
    });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(loader.mock.calls.length).toBeGreaterThan(loads));
    expect(isStaged()).toBe(true);

    layout.termsRequired = false;
    await user.click(screen.getByRole("button", { name: "Revalidate" }));
    await user.click(within(await saveDialog()).getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("landed")).toHaveTextContent(`/editor/${MINE.id}`);
    expect(create).toHaveBeenCalledTimes(2);
  });

  describe("a staged edit becomes at most one configuration, and only the snapshot's is removed", () => {
    it("another tab saved or discarded it since the opening: Save closes and sends nothing", async () => {
      stage();
      const { user } = renderDialog();
      const dialog = await saveDialog();
      act(() => window.localStorage.removeItem(STAGED_EDIT_KEY));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(create).not.toHaveBeenCalled();
      expect(screen.queryByTestId("landed")).toBeNull();
    });

    it("another tab staged a newer edit since the opening: Save closes and sends nothing; the newer edit stays", async () => {
      stage();
      const { user } = renderDialog();
      const dialog = await saveDialog();
      act(() => stage({ name: "Staged later", collectorVersion: "0.160.0" }, Date.now() + 1));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(create).not.toHaveBeenCalled();
      expect(readStagedEdit()?.edit.name).toBe("Staged later");
    });

    it("another tab staged a newer edit, then Discard: the newer edit stays", async () => {
      stage();
      const { user } = renderDialog();
      await saveDialog();
      act(() => stage({ name: "Staged later", collectorVersion: "0.160.0" }, Date.now() + 1));
      await user.click(within(await saveDialog()).getByRole("button", { name: "Discard" }));
      await user.click(within(await screen.findByRole("alertdialog", { name: PLAYGROUND_DISCARD_TITLE })).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(readStagedEdit()?.edit.name).toBe("Staged later");
      expect(create).not.toHaveBeenCalled();
    });

    it("a create that answers after the organization changed: the edit is removed, and no second dialog opens", async () => {
      let answer!: (value: { configuration: typeof MINE }) => void;
      create.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never);
      stage();
      const { user } = renderDialog();
      await user.click(within(await saveDialog()).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

      switchOrganization();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(async () => answer({ configuration: MINE }));
      expect(isStaged()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByTestId("landed")).toBeNull();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("a create refused after the organization changed: the kept edit is offered again there", async () => {
      let refuse!: (error: unknown) => void;
      create.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)) as never);
      stage();
      const { user } = renderDialog();
      await user.click(within(await saveDialog()).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      switchOrganization();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(async () => refuse(new ApiError("organization_not_found", "Organization not found", { status: 404 })));
      expect(isStaged()).toBe(true);
      expect(await saveDialog()).toBeInTheDocument();
    });
  });

  it("ignores and removes a staged edit older than 7 days", async () => {
    stage({}, Date.now() - STAGED_EDIT_MAX_AGE_MS - 60_000);
    expect(isStaged()).toBe(true);
    const { loader } = renderDialog();
    await waitFor(() => expect(loader).toHaveBeenCalled());
    await waitFor(() => expect(isStaged()).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores and removes a malformed one", async () => {
    window.localStorage.setItem(STAGED_EDIT_KEY, "{not json");
    const { loader } = renderDialog();
    await waitFor(() => expect(loader).toHaveBeenCalled());
    await waitFor(() => expect(isStaged()).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing and reads nothing without a staged edit", async () => {
    const { loader } = renderDialog();
    await waitFor(() => expect(loader).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiClient.getCollectorDistributions).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
