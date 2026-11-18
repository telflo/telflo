import { act, render, screen, waitFor } from "@testing-library/react";
import type { ConfigurationVersion, ConfigurationVersionResponse } from "@telflo/contracts";
import { useEffect } from "react";
import { createRoutesStub, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_VERSION_FAILED_MESSAGE, useCreateVersion, type CreateVersion } from "./use-create-version.js";
import { useHeldEdit } from "./held-edits.js";
import {
  COLLECTOR_VERSION_UNAVAILABLE_MESSAGE,
  DELETED_MESSAGE,
  OTHER_ORGANIZATION_MESSAGE,
  TOO_LARGE_MESSAGE,
  UNSTORABLE_CHARACTER_MESSAGE,
} from "./use-save-configuration.js";
import { readViewport, writeViewport } from "~/components/editor/builder/canvas-handlers.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, THEIRS, versionFixture, versionSummaryOf } from "~/test/configurations.js";

/*
 * The picker's create (D10 decisions 5 and 11): what it sends, what it does
 * with the answer, and the save's refusals.
 */

const SAVED_YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";
const EDITED_YAML = `${SAVED_YAML}# edited, not saved\n`;
const SOURCE = versionFixture({ yamlContent: SAVED_YAML });
const CREATED = versionFixture({
  id: "0199c000-0000-7000-8000-000000000013",
  versionNumber: 3,
  label: "Add tail sampling",
  yamlContent: EDITED_YAML,
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z",
});

const initialState = useEditorStore.getState();

/** The page's router's navigate, for a navigation of the test's own. */
let navigateInPage: NavigateFunction | null = null;

/** MINE's version 1, loaded in the group organization, then typed into: dirty. */
function loadAndEdit(text = EDITED_YAML) {
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: SOURCE });
  useEditorStore.getState().setText(text);
}

/** The hook at the editor's address (`path`), with a loader to count the layout's revalidations. */
async function renderCreate({ path = `/editor/${MINE.id}/${SOURCE.id}`, before }: { path?: string; before?: string } = {}) {
  const loader = vi.fn(() => null);
  let hook: CreateVersion | undefined;
  function Page() {
    hook = useCreateVersion();
    const navigate = useNavigate();
    useEffect(() => {
      navigateInPage = navigate;
    }, [navigate]);
    return <p data-testid="address">{useLocation().pathname}</p>;
  }
  const Stub = createRoutesStub([
    { path: "/editor/:configurationId/:versionId?", Component: Page, loader, HydrateFallback: () => null },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={before === undefined ? [path] : [before, path]} initialIndex={before === undefined ? 0 : 1} />);
  await waitFor(() => expect(hook).toBeDefined());
  return { create: (label: string) => hook!.createVersion(label), loader };
}

/** A create inside act, as its answer re-renders the router. */
async function createInAct(create: (label: string) => Promise<boolean>, label = ""): Promise<boolean> {
  let created: boolean | undefined;
  await act(async () => {
    created = await create(label);
  });
  return created!;
}

/** A create the API answers with `version`. */
function answering(version: ConfigurationVersion = CREATED) {
  return vi
    .spyOn(apiClient, "createConfigurationVersion")
    .mockResolvedValue({ version } satisfies ConfigurationVersionResponse);
}

/** A create that answers when the test chooses. */
function pendingCreate() {
  let resolve!: (response: ConfigurationVersionResponse) => void;
  let reject!: (error: unknown) => void;
  const createConfigurationVersion = vi.spyOn(apiClient, "createConfigurationVersion").mockImplementation(
    () =>
      new Promise((settle, fail) => {
        resolve = settle;
        reject = fail;
      }),
  );
  return {
    createConfigurationVersion,
    resolve: (response: ConfigurationVersionResponse) => resolve(response),
    reject: (error: unknown) => reject(error),
  };
}

const address = () => screen.getByTestId("address").textContent;

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
  window.localStorage.clear();
  navigateInPage = null;
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useCreateVersion", () => {
  it("sends the editor's text with its unsaved changes and its graph, the open version as the source, to the organization it was loaded in", async () => {
    const createConfigurationVersion = answering();
    loadAndEdit();
    const graph = useEditorStore.getState().graph;
    const { create } = await renderCreate();

    await expect(createInAct(create, "Add tail sampling")).resolves.toBe(true);

    expect(createConfigurationVersion).toHaveBeenCalledTimes(1);
    expect(createConfigurationVersion).toHaveBeenCalledWith(GROUP_ID, MINE.id, {
      sourceVersionId: SOURCE.id,
      label: "Add tail sampling",
      yamlContent: EDITED_YAML,
      ...toStored(graph),
      // No collectorVersion: nothing was picked, so the server takes the source's saved pin (D13a Ruling 37).
    });
  });

  it.each([
    ["trimmed", "  Add tail sampling  ", { label: "Add tail sampling" }],
    ["left out when empty", "", {}],
    ["left out when only spaces (Preflight ruling 16)", "   ", {}],
  ])("sends the name %s", async (_why, typed, sent) => {
    const createConfigurationVersion = answering();
    loadAndEdit();
    const { create } = await renderCreate();

    await createInAct(create, typed);

    const [, , body] = createConfigurationVersion.mock.calls[0]!;
    expect(Object.keys(body)).toEqual(
      "label" in sent
        ? ["sourceVersionId", "label", "yamlContent", "nodes", "edges", "pipelines"]
        : ["sourceVersionId", "yamlContent", "nodes", "edges", "pipelines"],
    );
    expect(body.label).toBe((sent as { label?: string }).label);
  });

  it("writes an edit a field still holds first, and sends it (held-edits; D9b decision 2)", async () => {
    const createConfigurationVersion = answering();
    loadAndEdit();
    const held = `${EDITED_YAML}# held by a field\n`;
    function Field() {
      useHeldEdit(true, () => useEditorStore.getState().setText(held));
      return null;
    }
    render(<Field />);
    const { create } = await renderCreate();

    await createInAct(create);

    expect(createConfigurationVersion.mock.calls[0]![2].yamlContent).toBe(held);
  });

  it("a flush that throws creates nothing and says the create failed", async () => {
    const createConfigurationVersion = answering();
    const error = vi.spyOn(toast, "error");
    loadAndEdit();
    let failures = 0;
    function Throwing() {
      // Once: the page's create meets it; its unmount's flush then writes nothing.
      useHeldEdit(true, () => {
        if (failures++ === 0) throw new Error("the field's flush failed");
      });
      return null;
    }
    const view = render(<Throwing />);
    const { create } = await renderCreate();

    await expect(createInAct(create)).resolves.toBe(false);

    expect(createConfigurationVersion).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(CREATE_VERSION_FAILED_MESSAGE);
    expect(useEditorStore.getState().text).toBe(EDITED_YAML);
    view.unmount();
  });

  it("on success: the source's viewport is the created version's, the store adopts it clean, then its address is pushed", async () => {
    answering();
    loadAndEdit();
    writeViewport(SOURCE.id, { x: 120, y: -40, zoom: 0.8 });
    const listed = useEditorStore.getState().versions;
    const { create } = await renderCreate({ before: "/app" });

    await createInAct(create, "Add tail sampling");

    expect(readViewport(CREATED.id)).toEqual({ x: 120, y: -40, zoom: 0.8 });
    expect(readViewport(SOURCE.id)).toEqual({ x: 120, y: -40, zoom: 0.8 });
    const state = useEditorStore.getState();
    expect(state.version).toEqual(CREATED);
    expect(state.versions).toEqual([versionSummaryOf(CREATED), ...listed]);
    expect(state.text).toBe(EDITED_YAML);
    expect(selectIsDirty(state)).toBe(false);
    expect(state.history).toEqual({ past: [], future: [] });
    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
    // Pushed, not replaced: Back returns to the source's address.
    act(() => void navigateInPage!(-1));
    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${SOURCE.id}`));
  });

  it("copies no viewport when none is remembered for the source", async () => {
    answering();
    loadAndEdit();
    const { create } = await renderCreate();

    await createInAct(create);

    expect(readViewport(CREATED.id)).toBeNull();
  });

  it("keeps the configuration's id as the address spells it: an upper-case address pushes an upper-case address", async () => {
    const createConfigurationVersion = answering();
    loadAndEdit();
    const upper = MINE.id.toUpperCase();
    const { create } = await renderCreate({ path: `/editor/${upper}/${SOURCE.id}` });

    await createInAct(create);

    await waitFor(() => expect(address()).toBe(`/editor/${upper}/${CREATED.id}`));
    // The API is asked with its own id.
    expect(createConfigurationVersion.mock.calls[0]![1]).toBe(MINE.id);
    expect(useEditorStore.getState().version).toEqual(CREATED);
  });

  it("is under way until the answer, and a second create meanwhile sends nothing", async () => {
    const { createConfigurationVersion, resolve } = pendingCreate();
    loadAndEdit();
    const { create } = await renderCreate();
    const isCreating = () => useEditorStore.getState().isCreatingVersion;

    let first!: Promise<boolean>;
    act(() => {
      first = create("one");
    });
    // Set at once, before the request: the store is the only record (D10 Ruling 45).
    expect(isCreating()).toBe(true);
    let second!: boolean;
    await act(async () => {
      second = await create("two");
    });
    expect(second).toBe(false);
    expect(createConfigurationVersion).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ version: CREATED });
      await first;
    });
    expect(isCreating()).toBe(false);
  });

  it("says in the store that a create is under way until it answers, so a save meanwhile does nothing (D10 Ruling 30)", async () => {
    const { reject } = pendingCreate();
    loadAndEdit();
    const { create } = await renderCreate();
    expect(useEditorStore.getState().isCreatingVersion).toBe(false);

    let first!: Promise<boolean>;
    act(() => {
      first = create("refused");
    });
    await waitFor(() => expect(useEditorStore.getState().isCreatingVersion).toBe(true));
    await act(async () => {
      reject(new ApiError("internal_error", "Something went wrong. Please try again."));
      await first;
    });
    expect(useEditorStore.getState().isCreatingVersion).toBe(false);

    const { resolve } = pendingCreate();
    let second!: Promise<boolean>;
    act(() => {
      second = create("created");
    });
    await waitFor(() => expect(useEditorStore.getState().isCreatingVersion).toBe(true));
    await act(async () => {
      resolve({ version: CREATED });
      await second;
    });
    expect(useEditorStore.getState().version).toEqual(CREATED);
    expect(useEditorStore.getState().isCreatingVersion).toBe(false);
  });

  it("reads the store's flag alone: a create under way elsewhere (another hook) makes this one do nothing (D10 Ruling 45)", async () => {
    const createConfigurationVersion = answering();
    loadAndEdit();
    const { create } = await renderCreate();
    useEditorStore.getState().setCreatingVersion(true);

    await expect(createInAct(create, "beside it")).resolves.toBe(false);

    expect(createConfigurationVersion).not.toHaveBeenCalled();
    expect(useEditorStore.getState().isCreatingVersion).toBe(true);
  });

  it("leaves the flag alone when its answer comes after a load: a create begun since on the loaded version keeps it (D10 Ruling 35)", async () => {
    const late = pendingCreate();
    loadAndEdit();
    const { create } = await renderCreate();
    let first!: Promise<boolean>;
    act(() => {
      first = create("late");
    });
    expect(useEditorStore.getState().isCreatingVersion).toBe(true);
    // Another version opened (Back, say): the load clears the flag.
    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000012", versionNumber: 2, yamlContent: "exporters: {}\n" });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
    expect(useEditorStore.getState().isCreatingVersion).toBe(false);
    // A create from the version loaded, under way.
    const current = pendingCreate();
    let second!: Promise<boolean>;
    act(() => {
      second = create("current");
    });
    expect(current.createConfigurationVersion).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().isCreatingVersion).toBe(true);

    // The first's answer comes: it opens nothing, and the second is still under way.
    await act(async () => {
      late.resolve({ version: CREATED });
      await expect(first).resolves.toBe(false);
    });
    expect(useEditorStore.getState().version).toEqual(other);
    expect(useEditorStore.getState().isCreatingVersion).toBe(true);

    const fromOther = versionFixture({ id: "0199c000-0000-7000-8000-000000000014", versionNumber: 4, yamlContent: "exporters: {}\n" });
    await act(async () => {
      current.resolve({ version: fromOther });
      await expect(second).resolves.toBe(true);
    });
    expect(useEditorStore.getState().version).toEqual(fromOther);
    expect(useEditorStore.getState().isCreatingVersion).toBe(false);
  });

  it("does nothing with no configuration open, or while a save is under way", async () => {
    const createConfigurationVersion = answering();
    const { create } = await renderCreate();

    await expect(createInAct(create)).resolves.toBe(false);
    loadAndEdit();
    useEditorStore.getState().setSaving(true);
    await expect(createInAct(create)).resolves.toBe(false);

    expect(createConfigurationVersion).not.toHaveBeenCalled();
  });

  it("does nothing while a publish is under way (D11b): its save first would race the create", async () => {
    const createConfigurationVersion = answering();
    const { create } = await renderCreate();
    loadAndEdit();
    useEditorStore.getState().setPublishing(true);

    await expect(createInAct(create)).resolves.toBe(false);

    expect(createConfigurationVersion).not.toHaveBeenCalled();
    expect(useEditorStore.getState().isCreatingVersion).toBe(false);
  });

  describe("refusals, which keep the editor's text (the save's; D8 decisions 5, 7 and 12)", () => {
    it.each([
      ["text over the contract's limit", "x".repeat(262_145), TOO_LARGE_MESSAGE],
      ["a character that can't be stored", `${SAVED_YAML}# \u0000\n`, UNSTORABLE_CHARACTER_MESSAGE],
    ])("refuses %s before sending, with the save's message", async (_why, text, message) => {
      const createConfigurationVersion = answering();
      const error = vi.spyOn(toast, "error");
      loadAndEdit(text);
      const { create } = await renderCreate();

      await expect(createInAct(create)).resolves.toBe(false);

      expect(createConfigurationVersion).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(message);
      expect(useEditorStore.getState().text).toBe(text);
    });

    it.each([
      ["a deleted configuration", new ApiError("configuration_not_found", "Configuration not found"), DELETED_MESSAGE, 0],
      ["another organization", new ApiError("organization_not_found", "Organization not found"), OTHER_ORGANIZATION_MESSAGE, 1],
      [
        "a version that isn't the configuration's",
        new ApiError("configuration_version_not_found", "Version not found"),
        CREATE_VERSION_FAILED_MESSAGE,
        0,
      ],
      ["a server error", new ApiError("internal_error", "Something went wrong. Please try again."), CREATE_VERSION_FAILED_MESSAGE, 0],
      ["a network failure", new TypeError("Failed to fetch"), CREATE_VERSION_FAILED_MESSAGE, 0],
    ])("%s: toasts its message, revalidating %#", async (_why, failure, message, revalidations) => {
      vi.spyOn(apiClient, "createConfigurationVersion").mockRejectedValue(failure);
      const error = vi.spyOn(toast, "error");
      loadAndEdit();
      const { create, loader } = await renderCreate();
      const loadsBefore = loader.mock.calls.length;

      await expect(createInAct(create)).resolves.toBe(false);

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(message);
      await waitFor(() => expect(loader.mock.calls.length - loadsBefore).toBe(revalidations));
      const state = useEditorStore.getState();
      expect(state.version).toEqual(SOURCE);
      expect(state.text).toBe(EDITED_YAML);
      expect(address()).toBe(`/editor/${MINE.id}/${SOURCE.id}`);
    });

    it("the terms: revalidates the layout, whose dialog opens, with no toast", async () => {
      vi.spyOn(apiClient, "createConfigurationVersion").mockRejectedValue(
        new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
      );
      const error = vi.spyOn(toast, "error");
      loadAndEdit();
      const { create, loader } = await renderCreate();
      const loadsBefore = loader.mock.calls.length;

      await expect(createInAct(create)).resolves.toBe(false);

      expect(error).not.toHaveBeenCalled();
      await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
      expect(useEditorStore.getState().text).toBe(EDITED_YAML);
    });
  });

  describe("an answer for a load no longer open (the save's stillOpen rule)", () => {
    it("a success after another version opened changes, opens and pushes nothing", async () => {
      const { resolve } = pendingCreate();
      loadAndEdit();
      writeViewport(SOURCE.id, { x: 1, y: 2, zoom: 1 });
      const { create } = await renderCreate();
      let created!: Promise<boolean>;
      act(() => {
        created = create("late");
      });
      const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000012", versionNumber: 2, yamlContent: "exporters: {}\n" });
      act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));

      await act(async () => {
        resolve({ version: CREATED });
        await expect(created).resolves.toBe(false);
      });

      expect(useEditorStore.getState().version).toEqual(other);
      expect(readViewport(CREATED.id)).toBeNull();
      expect(address()).toBe(`/editor/${MINE.id}/${SOURCE.id}`);
    });

    it("a refusal after the configuration was left and opened again toasts and revalidates nothing", async () => {
      const { reject } = pendingCreate();
      const error = vi.spyOn(toast, "error");
      loadAndEdit();
      const { create, loader } = await renderCreate();
      const loadsBefore = loader.mock.calls.length;
      let created!: Promise<boolean>;
      act(() => {
        created = create("late");
      });
      // Left, then the same version opened again: another load.
      act(() => {
        useEditorStore.getState().reset();
        useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: SOURCE });
      });

      await act(async () => {
        reject(new ApiError("organization_not_found", "Organization not found"));
        await expect(created).resolves.toBe(false);
      });

      expect(error).not.toHaveBeenCalled();
      expect(loader.mock.calls.length).toBe(loadsBefore);
    });

    it("a success after another configuration opened changes nothing", async () => {
      const { resolve } = pendingCreate();
      loadAndEdit();
      const { create } = await renderCreate();
      let created!: Promise<boolean>;
      act(() => {
        created = create("late");
      });
      const theirs = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", configurationId: THEIRS.id });
      act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: THEIRS, version: theirs }));

      await act(async () => {
        resolve({ version: CREATED });
        await created;
      });

      expect(useEditorStore.getState().configuration).toEqual(THEIRS);
      expect(useEditorStore.getState().version).toEqual(theirs);
    });
  });
});

describe("the collector version a create carries (D13a decision 9; Preflight ruling 16; Ruling 37)", () => {
  it("sends an unsaved pick, as the text is; the source keeps its own", async () => {
    // v2 saved at 0.162.0; the person picks 0.161.0 and types, then creates v3.
    const createConfigurationVersion = answering({ ...CREATED, collectorVersion: "0.161.0" });
    loadAndEdit();
    useEditorStore.getState().setCollectorVersion("0.161.0");
    const { create } = await renderCreate();

    await expect(createInAct(create)).resolves.toBe(true);

    expect(createConfigurationVersion.mock.calls[0]![2]).toMatchObject({
      sourceVersionId: SOURCE.id,
      yamlContent: EDITED_YAML,
      collectorVersion: "0.161.0",
    });
    // The new version is open, at the pin it was created with, clean.
    expect(useEditorStore.getState()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
  });

  it("sends no pin when nothing was picked: the server takes the source's saved one, and the new version opens at it", async () => {
    // A teammate picked 0.161.0 on the source and saved since this tab loaded it at 0.160.0.
    const createConfigurationVersion = answering({ ...CREATED, collectorVersion: "0.161.0" });
    useEditorStore.getState().load({
      organizationId: GROUP_ID,
      configuration: MINE,
      version: { ...SOURCE, collectorVersion: "0.160.0" },
    });
    const { create } = await renderCreate();

    await expect(createInAct(create)).resolves.toBe(true);

    expect(createConfigurationVersion.mock.calls[0]![2]).not.toHaveProperty("collectorVersion");
    expect(useEditorStore.getState()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
  });

  it("a pick back to the saved pin is no pick: none is sent", async () => {
    const createConfigurationVersion = answering();
    loadAndEdit();
    useEditorStore.getState().setCollectorVersion("0.161.0");
    useEditorStore.getState().setCollectorVersion(SOURCE.collectorVersion);
    const { create } = await renderCreate();

    await expect(createInAct(create)).resolves.toBe(true);

    expect(createConfigurationVersion.mock.calls[0]![2]).not.toHaveProperty("collectorVersion");
  });

  it("a 400 collector_version_unknown says the save's message, creates nothing and keeps the pick", async () => {
    vi.spyOn(apiClient, "createConfigurationVersion").mockRejectedValue(
      new ApiError("collector_version_unknown", "That collector version isn't available."),
    );
    const error = vi.spyOn(toast, "error");
    loadAndEdit();
    useEditorStore.getState().setCollectorVersion("0.161.0");
    const { create } = await renderCreate();

    await expect(createInAct(create)).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith(COLLECTOR_VERSION_UNAVAILABLE_MESSAGE);
    expect(useEditorStore.getState()).toMatchObject({ version: SOURCE, collectorVersion: "0.161.0" });
  });
});
