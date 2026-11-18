import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConfigurationVersion, ConfigurationVersionResponse } from "@telflo/contracts";
import { createRoutesStub, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublishedVersionBanner } from "./PublishedVersionBanner.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { CREATE_VERSION_FAILED_MESSAGE } from "~/lib/editor/use-create-version.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import { selectIsDirty, selectIsVersionPublished, summaryOf, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, versionFixture, versionSummaryOf } from "~/test/configurations.js";

/*
 * The banner over a published version (D11b decision 4) and its one button,
 * D10's create from the open version (unnamed, no dialog), which opens the
 * new version; a stale tab's unsaved text goes with it (Preflight ruling 12).
 */

const YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";
const LABEL = "Tail sampling zq7c";
const PUBLISHED = versionFixture({ versionNumber: 3, label: LABEL, yamlContent: YAML, ...PUBLISHED_FIELDS });
const CREATED = versionFixture({
  id: "0199c000-0000-7000-8000-000000000014",
  versionNumber: 4,
  yamlContent: YAML,
});
const MESSAGE = "Version 3 is published and can't be changed.";
const BUTTON = "Create a new version from it";
const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderBanner(version: ConfigurationVersion = PUBLISHED) {
  store().load({ organizationId: GROUP_ID, configuration: MINE, version, versions: [versionSummaryOf(version)] });
  const Stub = createRoutesStub([
    {
      path: "/editor/:configurationId/:versionId?",
      Component: () => (
        <>
          <button type="button">Before</button>
          <PublishedVersionBanner />
          <p data-testid="address">{useLocation().pathname}</p>
        </>
      ),
      loader: () => null,
      HydrateFallback: () => null,
    },
  ]);
  render(<Stub initialEntries={[`/editor/${MINE.id}/${version.id}`]} />);
  return userEvent.setup();
}

const address = () => screen.getByTestId("address").textContent;

describe("PublishedVersionBanner", () => {
  it("says the version is published, by number, with one button", async () => {
    renderBanner();
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Before", BUTTON]);
    expect(screen.getByRole("button", { name: BUTTON })).toBeEnabled();
  });

  it("isn't there on a draft, and comes when the version is published under it", async () => {
    renderBanner(versionFixture({ ...PUBLISHED, publishedAt: null, publishedBy: null }));
    await screen.findByText("Before");
    expect(screen.queryByText(MESSAGE)).toBeNull();
    act(() => store().replaceVersionSummary({ ...summaryOf(PUBLISHED) }));
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
  });

  it("names neither the configuration nor the label, in text or attribute (ADR 0024)", async () => {
    renderBanner();
    const banner = (await screen.findByText(MESSAGE)).parentElement!;
    expect(banner).not.toHaveTextContent(LABEL);
    expect(banner).not.toHaveTextContent(MINE.name);
    for (const element of [banner, ...banner.querySelectorAll("*")]) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain(LABEL);
        expect(attribute.value).not.toContain(MINE.name);
      }
    }
  });

  it("creates an unnamed version from the open one with no dialog, and opens it", async () => {
    const create = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockResolvedValue({ version: CREATED } satisfies ConfigurationVersionResponse);
    const user = renderBanner();
    const graph = toStored(store().graph);

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(GROUP_ID, MINE.id, {
      sourceVersionId: PUBLISHED.id,
      yamlContent: YAML,
      ...graph,
      // No collectorVersion: nothing was picked, so the new version takes the published one's (D13a Ruling 37).
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store().version).toEqual(CREATED);
    expect(selectIsVersionPublished(store())).toBe(false);
    expect(store().versions[0]).toEqual(versionSummaryOf(CREATED));
    // The new version is a draft: the banner goes.
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it("is reachable by keyboard: Tab focuses it, Enter creates", async () => {
    const create = vi.spyOn(apiClient, "createConfigurationVersion").mockResolvedValue({ version: CREATED });
    const user = renderBanner();
    const button = await screen.findByRole("button", { name: BUTTON });
    act(() => screen.getByRole("button", { name: "Before" }).focus());

    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
  });

  it("carries a stale tab's unsaved text into the new version (Preflight ruling 12)", async () => {
    const typed = `${YAML}# typed before the teammate published\n`;
    const create = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockResolvedValue({ version: { ...CREATED, yamlContent: typed } });
    const draft = versionFixture({ ...PUBLISHED, publishedAt: null, publishedBy: null });
    const user = renderBanner(draft);
    act(() => {
      store().setText(typed);
      store().replaceVersionSummary({ ...summaryOf(draft), ...PUBLISHED_FIELDS });
    });
    expect(selectIsDirty(store())).toBe(true);

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
    expect(create.mock.calls[0]![2].yamlContent).toBe(typed);
    expect(store().text).toBe(typed);
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a failed create says D10's message and stays on the published version", async () => {
    vi.spyOn(apiClient, "createConfigurationVersion").mockRejectedValue(new ApiError("internal_error", "Something went wrong"));
    const user = renderBanner();

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CREATE_VERSION_FAILED_MESSAGE));
    expect(address()).toBe(`/editor/${MINE.id}/${PUBLISHED.id}`);
    expect(store().version).toEqual(PUBLISHED);
    expect(screen.getByRole("button", { name: BUTTON })).toBeEnabled();
  });

  it("is disabled while a create, a save or a publish is under way, and creates once", async () => {
    let finish!: (response: ConfigurationVersionResponse) => void;
    const create = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const user = renderBanner();
    const button = await screen.findByRole("button", { name: BUTTON });

    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(create).toHaveBeenCalledOnce();
    await act(async () => finish({ version: CREATED }));

    for (const flag of ["isSaving", "isPublishing"] as const) {
      act(() => {
        store().load({ organizationId: GROUP_ID, configuration: MINE, version: PUBLISHED });
        useEditorStore.setState({ [flag]: true });
      });
      expect(screen.getByRole("button", { name: BUTTON })).toBeDisabled();
    }
  });
});

describe("the collector version the banner's create carries (D13a decision 9; Preflight ruling 16; Rulings 30 and 37)", () => {
  /** The draft this tab loaded at 0.162.0, before a teammate published it. */
  const DRAFT = versionFixture({ ...PUBLISHED, publishedAt: null, publishedBy: null, collectorVersion: "0.162.0" });
  const TEAMMATE_PUBLISHED = { ...PUBLISHED, collectorVersion: "0.160.0", updatedAt: "2026-10-04T11:30:00.000Z" };

  it("carries the published pin into the new version (its picker is read-only): none is sent, so the server takes the source's", async () => {
    const create = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockResolvedValue({ version: { ...CREATED, collectorVersion: "0.160.0" } } satisfies ConfigurationVersionResponse);
    const user = renderBanner({ ...PUBLISHED, collectorVersion: "0.160.0" });
    // The pin can't be picked on a published version.
    store().setCollectorVersion("0.161.0");
    expect(store().collectorVersion).toBe("0.160.0");

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
    expect(create.mock.calls[0]![2]).not.toHaveProperty("collectorVersion");
    expect(store()).toMatchObject({ collectorVersion: "0.160.0", savedCollectorVersion: "0.160.0" });
  });

  it("a stale tab's typed text, no pick: after the re-read it shows the teammate's published pin, and the create carries it with the text (B2)", async () => {
    const create = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockResolvedValue({ version: { ...CREATED, collectorVersion: "0.160.0" } } satisfies ConfigurationVersionResponse);
    const user = renderBanner(DRAFT);
    const typed = `# typed before the teammate published\n${YAML}`;
    act(() => {
      store().setText(typed);
      store().replaceVersion(TEAMMATE_PUBLISHED);
    });
    expect(store()).toMatchObject({ text: typed, collectorVersion: "0.160.0", savedCollectorVersion: "0.160.0" });

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
    expect(create.mock.calls[0]![2]).toMatchObject({ sourceVersionId: PUBLISHED.id, yamlContent: typed });
    expect(create.mock.calls[0]![2]).not.toHaveProperty("collectorVersion");
    expect(store().collectorVersion).toBe("0.160.0");
  });

  it("a stale tab that only picked: after the re-read it shows the teammate's published text with its pick, and the create carries both (Rulings 30 and 41)", async () => {
    const teammateText = `${YAML}# Ben's published change\n`;
    const create = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockResolvedValue({
        version: { ...CREATED, yamlContent: teammateText, collectorVersion: "0.161.0" },
      } satisfies ConfigurationVersionResponse);
    const user = renderBanner(DRAFT);
    act(() => {
      store().setCollectorVersion("0.161.0");
      store().replaceVersion({ ...TEAMMATE_PUBLISHED, yamlContent: teammateText });
    });
    expect(store()).toMatchObject({ text: teammateText, collectorVersion: "0.161.0", savedCollectorVersion: "0.160.0" });

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
    expect(create.mock.calls[0]![2]).toMatchObject({
      sourceVersionId: PUBLISHED.id,
      yamlContent: teammateText,
      collectorVersion: "0.161.0",
    });
    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
  });
});
