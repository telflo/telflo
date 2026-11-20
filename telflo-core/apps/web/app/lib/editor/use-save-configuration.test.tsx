import { act, render, waitFor } from "@testing-library/react";
import type { ConfigurationVersion, ConfigurationVersionResponse } from "@telflo/contracts";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLECTOR_VERSION_UNAVAILABLE_MESSAGE,
  DELETED_MESSAGE,
  OTHER_ORGANIZATION_MESSAGE,
  SAVED_MESSAGE,
  SAVE_FAILED_MESSAGE,
  TOO_LARGE_MESSAGE,
  UNSTORABLE_CHARACTER_MESSAGE,
  useSaveConfiguration,
  type SaveResult,
} from "./use-save-configuration.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import { selectIsDirty, selectIsVersionPublished, summaryOf, useEditorStore } from "~/lib/stores/editor-store.js";
import { RETIRED_NOTE, RETIRED_VERSION } from "~/test/collector-distributions.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, THEIRS, answerFor, versionFixture } from "~/test/configurations.js";

const SAVED_YAML = "receivers:\n  otlp:\n";
const EDITED_YAML = "receivers:\r\n  otlp:   \n\n";

/**
 * The loaded version's graph, hand-written in the shapes a version stores: a
 * pipeline's group, a component in it, an edge and the pipeline.
 */
const GRAPH = {
  nodes: [
    {
      id: "group_0",
      type: "pipelineGroup",
      position: { x: 50, y: 30 },
      style: { width: 980, height: 240 },
      data: { label: "traces", pipelineId: "pipeline_0", signalType: "traces", color: "#f97316" },
    },
    {
      id: "node_0",
      type: "receiver",
      parentId: "group_0",
      position: { x: 50, y: 70 },
      data: {
        label: "OTLP",
        componentType: "receiver",
        componentSubType: "otlp",
        config: { protocols: { grpc: {} } },
        sharedConfigId: "receiver-otlp",
      },
    },
  ],
  edges: [{ id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep" }],
  pipelines: [{ id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316" }],
};

const VERSION = versionFixture({ yamlContent: SAVED_YAML, ...GRAPH });

const initialState = useEditorStore.getState();

/** What a save that sent the text and saved it answers. */
const SAVED: SaveResult = { saved: true };
/** Not saved, and nothing said: the caller may say it. */
const NOT_SAVED: SaveResult = { saved: false, toasted: false };
/** Not saved, and the save toasted why. */
const REFUSED: SaveResult = { saved: false, toasted: true };
/** Not tried: a save or the picker's create was under way. */
const BUSY: SaveResult = { saved: false, busy: true };

/** MINE loaded in the group organization (as `version`), then edited to `text`. */
function loadAndEdit(text = EDITED_YAML, version: ConfigurationVersion = VERSION) {
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version });
  useEditorStore.getState().setText(text);
}

/** The version the API answers a save of `yamlContent` with. */
function savedVersion(yamlContent: string): ConfigurationVersionResponse {
  return { version: { ...VERSION, yamlContent, updatedAt: "2026-09-28T12:00:00.000Z" } };
}

/** A save that answers when the test chooses. */
function pendingSave() {
  let resolve!: (response: ConfigurationVersionResponse) => void;
  let reject!: (error: unknown) => void;
  const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion").mockImplementation(
    () =>
      new Promise((settle, fail) => {
        resolve = settle;
        reject = fail;
      }),
  );
  return {
    saveConfigurationVersion,
    resolve: (response: ConfigurationVersionResponse) => resolve(response),
    reject: (error: unknown) => reject(error),
  };
}

/** The hook on a route, with a loader to count the layout's revalidations. */
async function renderSave() {
  const loader = vi.fn(() => null);
  let save: (() => Promise<SaveResult>) | undefined;
  function Page() {
    save = useSaveConfiguration();
    return null;
  }
  const Stub = createRoutesStub([{ path: "/editor", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/editor"]} />);
  await waitFor(() => expect(save).toBeDefined());
  return { save: () => save!(), loader };
}

/** A save whose revalidation re-renders the router, inside act. */
async function saveInAct(save: () => Promise<SaveResult>): Promise<SaveResult> {
  let saved: SaveResult | undefined;
  await act(async () => {
    saved = await save();
  });
  return saved!;
}

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
});

describe("useSaveConfiguration", () => {
  it("does nothing with no configuration loaded", async () => {
    const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion");
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(NOT_SAVED);
    expect(saveConfigurationVersion).not.toHaveBeenCalled();
  });

  it("does nothing while the editor is clean, typed back to the saved text included", async () => {
    const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion");
    const success = vi.spyOn(toast, "success");
    loadAndEdit(SAVED_YAML);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(NOT_SAVED);
    expect(saveConfigurationVersion).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("sends the text exactly as it is, with the canvas's graph as stored, to the organization it was loaded in, marks it saved and toasts the saved message", async () => {
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockResolvedValue(savedVersion(EDITED_YAML));
    const success = vi.spyOn(toast, "success");
    loadAndEdit();
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);

    expect(saveConfigurationVersion).toHaveBeenCalledTimes(1);
    // The graph on the canvas, as the columns store it: the text's, with the
    // stored layout where it matched (the traces group).
    const sent = toStored(useEditorStore.getState().graph);
    expect(saveConfigurationVersion).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, {
      yamlContent: EDITED_YAML,
      ...sent,
      // No collectorVersion: the picker is untouched, so the server keeps the stored pin.
    });
    expect(sent.pipelines.map((p) => p.name)).toEqual(["traces", "metrics", "logs"]);
    expect(sent.nodes.find((n) => n.data.label === "traces")).toMatchObject({
      position: { x: 50, y: 30 },
      style: { width: 980, height: 240 },
    });
    const state = useEditorStore.getState();
    expect(selectIsDirty(state)).toBe(false);
    expect(state.savedText).toBe(EDITED_YAML);
    expect(state.version?.updatedAt).toBe("2026-09-28T12:00:00.000Z");
    expect(state.isSaving).toBe(false);
    expect(success).toHaveBeenCalledWith(SAVED_MESSAGE);
    expect(SAVED_MESSAGE).toBe("Saved configuration");
  });

  it("sends the graph as the canvas has it, a move included, and a move alone makes a save", async () => {
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockResolvedValue(savedVersion(SAVED_YAML));
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    act(() =>
      useEditorStore.getState().applyNodeChanges([{ id: "group_0", type: "position", position: { x: 200, y: 400 } }]),
    );
    expect(selectIsDirty(useEditorStore.getState())).toBe(true);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);

    const [, , , body] = saveConfigurationVersion.mock.calls[0]!;
    expect(body.yamlContent).toBe(SAVED_YAML);
    expect(body.nodes.find((n) => n.id === "group_0")?.position).toEqual({ x: 200, y: 400 });
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
  });

  it("marks saved the layout that was sent, so a move during the save leaves the editor dirty", async () => {
    const { resolve } = pendingSave();
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    act(() =>
      useEditorStore.getState().applyNodeChanges([{ id: "group_0", type: "position", position: { x: 200, y: 400 } }]),
    );
    const { save } = await renderSave();

    const saving = save();
    act(() =>
      useEditorStore.getState().applyNodeChanges([{ id: "group_1", type: "position", position: { x: 900, y: 900 } }]),
    );
    resolve(savedVersion(SAVED_YAML));
    await expect(saving).resolves.toEqual(SAVED);

    expect(selectIsDirty(useEditorStore.getState())).toBe(true);
  });

  it("saves a text whose values the graph's columns can't hold, with those configs left out", async () => {
    const withNul = 'receivers:\n  otlp:\n    note: "a\\0b"\n';
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockResolvedValue(savedVersion(`${withNul}# edited\n`));
    loadAndEdit(`${withNul}# edited\n`, { ...VERSION, yamlContent: withNul, nodes: [], edges: [], pipelines: [] });
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);

    const [, , , body] = saveConfigurationVersion.mock.calls[0]!;
    expect(body.yamlContent).toBe(`${withNul}# edited\n`);
    expect(body.nodes.find((n) => n.data.componentSubType === "otlp")?.data.config).toBeNull();
  });

  it("sends the canvas's graph at the next save, never the graph the save answered with", async () => {
    const answered = { ...GRAPH, nodes: [GRAPH.nodes[0]!] };
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockResolvedValue({ version: { ...savedVersion(EDITED_YAML).version, ...answered } });
    loadAndEdit();
    const { save } = await renderSave();
    await expect(save()).resolves.toEqual(SAVED);
    useEditorStore.getState().setText("again\n");

    await expect(save()).resolves.toEqual(SAVED);

    expect(saveConfigurationVersion).toHaveBeenLastCalledWith(GROUP_ID, MINE.id, VERSION.id, {
      yamlContent: "again\n",
      ...toStored(useEditorStore.getState().graph),
    });
  });

  it("marks saved the text that was sent, so typing during the save leaves the editor dirty", async () => {
    const { resolve } = pendingSave();
    loadAndEdit("sent: 1\n");
    const { save } = await renderSave();

    const saving = save();
    expect(useEditorStore.getState().isSaving).toBe(true);
    act(() => useEditorStore.getState().setText("sent: 1\ntyped: 2\n"));
    resolve(savedVersion("sent: 1\n"));
    await expect(saving).resolves.toEqual(SAVED);

    const state = useEditorStore.getState();
    expect(state.savedText).toBe("sent: 1\n");
    expect(state.text).toBe("sent: 1\ntyped: 2\n");
    expect(selectIsDirty(state)).toBe(true);
    expect(state.isSaving).toBe(false);
  });

  it("does nothing while the picker's create is under way, answering busy and saying nothing, and saves once it isn't", async () => {
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockResolvedValue(savedVersion(EDITED_YAML));
    const error = vi.spyOn(toast, "error");
    loadAndEdit();
    useEditorStore.getState().setCreatingVersion(true);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(BUSY);
    expect(error).not.toHaveBeenCalled();
    expect(saveConfigurationVersion).not.toHaveBeenCalled();
    expect(useEditorStore.getState().isSaving).toBe(false);
    expect(selectIsDirty(useEditorStore.getState())).toBe(true);

    useEditorStore.getState().setCreatingVersion(false);
    await expect(save()).resolves.toEqual(SAVED);
    expect(saveConfigurationVersion).toHaveBeenCalledTimes(1);
  });

  it("sends once for two quick saves", async () => {
    const { saveConfigurationVersion, resolve } = pendingSave();
    loadAndEdit();
    const { save } = await renderSave();

    const first = save();
    const second = save();
    resolve(savedVersion(EDITED_YAML));

    await expect(first).resolves.toEqual(SAVED);
    // The second didn't try: the first was under way.
    await expect(second).resolves.toEqual(BUSY);
    expect(saveConfigurationVersion).toHaveBeenCalledTimes(1);
  });

  it("refuses text over 262,144 characters without a request, and sends 262,144", async () => {
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockImplementation(async (_organizationId, _configurationId, _versionId, { yamlContent }) => savedVersion(yamlContent));
    const error = vi.spyOn(toast, "error");
    loadAndEdit("a".repeat(262_145));
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(REFUSED);
    expect(saveConfigurationVersion).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("This configuration is too large to save (the limit is 256 KiB).");
    expect(TOO_LARGE_MESSAGE).toBe("This configuration is too large to save (the limit is 256 KiB).");
    expect(useEditorStore.getState().text).toHaveLength(262_145);
    expect(useEditorStore.getState().isSaving).toBe(false);

    act(() => useEditorStore.getState().setText("a".repeat(262_144)));
    await expect(save()).resolves.toEqual(SAVED);
    expect(saveConfigurationVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["U+0000", "receivers:\u0000\n"],
    ["a lone high surrogate", "receivers: {}\n# \ud83d\n"],
    ["a lone low surrogate", "receivers: {}\n# \ude80\n"],
  ])("refuses text holding %s without a request, which the API would refuse", async (_label, text) => {
    const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion");
    const error = vi.spyOn(toast, "error");
    loadAndEdit(text);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(REFUSED);

    expect(saveConfigurationVersion).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "This configuration contains a character that can't be saved. Remove it and try again.",
    );
    expect(UNSTORABLE_CHARACTER_MESSAGE).toBe(error.mock.calls[0]![0]);
    const state = useEditorStore.getState();
    expect(state.text).toBe(text);
    expect(selectIsDirty(state)).toBe(true);
    expect(state.isSaving).toBe(false);
  });

  it("sends well-formed surrogate pairs and U+FFFD", async () => {
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockImplementation(async (_organizationId, _configurationId, _versionId, { yamlContent }) => savedVersion(yamlContent));
    loadAndEdit("# 🚀 𝕏 \ufffd\n");
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);
    expect(saveConfigurationVersion).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, {
      yamlContent: "# 🚀 𝕏 \ufffd\n",
      ...toStored(useEditorStore.getState().graph),
    });
  });

  describe("a refusal keeps the text, and the editor dirty", () => {
    function expectTextKept() {
      const state = useEditorStore.getState();
      expect(state.text).toBe(EDITED_YAML);
      expect(state.savedText).toBe(SAVED_YAML);
      expect(selectIsDirty(state)).toBe(true);
      expect(state.isSaving).toBe(false);
      expect(state.organizationId).toBe(GROUP_ID);
    }

    it.each([
      [
        "the configuration was deleted (404 configuration_not_found)",
        new ApiError("configuration_not_found", "Configuration not found"),
        "This configuration was deleted. Copy your changes before leaving.",
      ],
      ["a server error", new ApiError("internal_error", "Something went wrong. Please try again."), SAVE_FAILED_MESSAGE],
      ["an invalid request", new ApiError("invalid_request", "The request was not valid."), SAVE_FAILED_MESSAGE],
      ["a body too large", new ApiError("payload_too_large", "The request body is too large."), SAVE_FAILED_MESSAGE],
      ["no connection", new ApiError("network_error", "Could not reach the server. Check your connection."), SAVE_FAILED_MESSAGE],
      ["a failure that isn't the API's", new Error("boom"), SAVE_FAILED_MESSAGE],
    ])("toasts its message for %s, and doesn't revalidate", async (_why, failure, message) => {
      vi.spyOn(apiClient, "saveConfigurationVersion").mockRejectedValue(failure);
      const error = vi.spyOn(toast, "error");
      loadAndEdit();
      const { save, loader } = await renderSave();
      const loadsBefore = loader.mock.calls.length;

      // It toasted why, so the Unsaved Changes dialog adds nothing.
      await expect(save()).resolves.toEqual(REFUSED);

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(message);
      expectTextKept();
      expect(loader.mock.calls.length).toBe(loadsBefore);
      expect(DELETED_MESSAGE).toBe("This configuration was deleted. Copy your changes before leaving.");
      expect(SAVE_FAILED_MESSAGE).toBe("Failed to save configuration. Please try again.");
    });

    it("says the configuration belongs to another organization, and revalidates the layout, on a 404 organization_not_found", async () => {
      vi.spyOn(apiClient, "saveConfigurationVersion").mockRejectedValue(
        new ApiError("organization_not_found", "Organization not found"),
      );
      const error = vi.spyOn(toast, "error");
      loadAndEdit();
      const { save, loader } = await renderSave();
      const loadsBefore = loader.mock.calls.length;

      expect(await saveInAct(save)).toEqual(REFUSED);

      expect(error).toHaveBeenCalledWith(
        "This configuration belongs to another organization than the one you're working in. Copy your changes, or switch back to it in another tab.",
      );
      expect(OTHER_ORGANIZATION_MESSAGE).toBe(error.mock.calls[0]![0]);
      await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
      expectTextKept();
    });

    it("revalidates the layout, whose terms dialog opens, with no toast, on a 403 terms_acceptance_required", async () => {
      vi.spyOn(apiClient, "saveConfigurationVersion").mockRejectedValue(
        new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
      );
      const error = vi.spyOn(toast, "error");
      loadAndEdit();
      const { save, loader } = await renderSave();
      const loadsBefore = loader.mock.calls.length;

      // Nothing said: the terms dialog opens, and the Unsaved Changes dialog
      // says the save failed.
      expect(await saveInAct(save)).toEqual(NOT_SAVED);

      await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
      expect(error).not.toHaveBeenCalled();
      expectTextKept();
    });
  });

  it.each([
    ["saved", (settle: ReturnType<typeof pendingSave>) => settle.resolve(savedVersion(EDITED_YAML))],
    ["refused", (settle: ReturnType<typeof pendingSave>) => settle.reject(new ApiError("configuration_not_found", "Configuration not found"))],
  ])("changes and toasts nothing when it is %s after another configuration was opened", async (_how, answer) => {
    const pending = pendingSave();
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    loadAndEdit();
    const { save } = await renderSave();
    const other: ConfigurationVersion = { ...VERSION, id: "0199c000-0000-7000-8000-000000000002", configurationId: THEIRS.id };

    const saving = save();
    act(() => {
      useEditorStore.getState().reset();
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: THEIRS, version: other });
      useEditorStore.getState().setText("theirs, edited\n");
    });
    answer(pending);
    await expect(saving).resolves.toEqual(NOT_SAVED);

    const state = useEditorStore.getState();
    expect(state.configuration).toEqual(THEIRS);
    expect(state.version).toEqual(other);
    expect(state.savedText).toBe(SAVED_YAML);
    expect(state.text).toBe("theirs, edited\n");
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["saved", (settle: ReturnType<typeof pendingSave>) => settle.resolve(savedVersion(EDITED_YAML))],
    ["refused", (settle: ReturnType<typeof pendingSave>) => settle.reject(new ApiError("internal_error", "Something went wrong."))],
  ])(
    "changes and toasts nothing when it is %s after the editor was left and the same configuration opened again",
    async (_how, answer) => {
      const first = pendingSave();
      const success = vi.spyOn(toast, "success");
      const error = vi.spyOn(toast, "error");
      loadAndEdit();
      const { save } = await renderSave();

      const late = save();
      // Leaving resets the store; opening the configuration again loads the
      // same version in the same organization, and a new save starts.
      act(() => {
        useEditorStore.getState().reset();
        useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
        useEditorStore.getState().setText("typed after reopening\n");
      });
      const second = pendingSave();
      const current = save();
      expect(second.saveConfigurationVersion).toHaveBeenCalledTimes(1);
      answer(first);
      await expect(late).resolves.toEqual(NOT_SAVED);

      let state = useEditorStore.getState();
      expect(state.savedText).toBe(SAVED_YAML);
      expect(state.version).toEqual(VERSION);
      expect(state.text).toBe("typed after reopening\n");
      expect(selectIsDirty(state)).toBe(true);
      // The save under way now is still under way.
      expect(state.isSaving).toBe(true);
      expect(success).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();

      second.resolve(savedVersion("typed after reopening\n"));
      await expect(current).resolves.toEqual(SAVED);
      state = useEditorStore.getState();
      expect(state.savedText).toBe("typed after reopening\n");
      expect(state.isSaving).toBe(false);
    },
  );
});

describe("a published version", () => {
  const STALE = "Version 1 is published and can't be changed.";

  it("a stale tab's save refused as published says so, reads the version again, and locks keeping the unsaved text, dirty against what was published", async () => {
    vi.spyOn(apiClient, "saveConfigurationVersion").mockRejectedValue(
      new ApiError("configuration_version_published", "This version is published and can't be changed."),
    );
    const read = vi
      .spyOn(apiClient, "getConfigurationVersion")
      .mockResolvedValue(answerFor(MINE, { ...VERSION, ...PUBLISHED_FIELDS, yamlContent: "teammate's text\n" }));
    const error = vi.spyOn(toast, "error");
    loadAndEdit();
    const { history, graph, canvasKey } = useEditorStore.getState();
    const { save } = await renderSave();

    await expect(saveInAct(save)).resolves.toEqual(REFUSED);

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(STALE);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id);
    const state = useEditorStore.getState();
    expect(selectIsVersionPublished(state)).toBe(true);
    expect(state.versions).toEqual([{ ...summaryOf(VERSION), ...PUBLISHED_FIELDS }]);
    // The unsaved text stays on screen, still unsaved, with its canvas and
    // history; the saved text is now what the teammate published.
    expect(state.text).toBe(EDITED_YAML);
    expect(state.savedText).toBe("teammate's text\n");
    expect(selectIsDirty(state)).toBe(true);
    expect(state).toMatchObject({ history, graph, canvasKey, isSaving: false });
  });

  it("a failed re-read leaves the editor as it was, the refusal said", async () => {
    vi.spyOn(apiClient, "saveConfigurationVersion").mockRejectedValue(
      new ApiError("configuration_version_published", "This version is published and can't be changed."),
    );
    vi.spyOn(apiClient, "getConfigurationVersion").mockRejectedValue(new ApiError("internal_error", "Something went wrong"));
    const error = vi.spyOn(toast, "error");
    loadAndEdit();
    const { save } = await renderSave();

    await expect(saveInAct(save)).resolves.toEqual(REFUSED);

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(STALE);
    expect(selectIsVersionPublished(useEditorStore.getState())).toBe(false);
    expect(useEditorStore.getState().text).toBe(EDITED_YAML);
  });

  it("then sends nothing: a save of the locked version's unsaved text says it is published", async () => {
    const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion");
    const error = vi.spyOn(toast, "error");
    loadAndEdit();
    act(() => useEditorStore.getState().replaceVersionSummary({ ...summaryOf(VERSION), ...PUBLISHED_FIELDS }));
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(REFUSED);

    expect(saveConfigurationVersion).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(STALE);
  });

  it("a clean published version sends nothing, and says it is published (Cmd/Ctrl+S on it)", async () => {
    const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion");
    const error = vi.spyOn(toast, "error");
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: { ...VERSION, ...PUBLISHED_FIELDS } });
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(REFUSED);
    expect(saveConfigurationVersion).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(STALE);
  });

  it("is busy while a publish is under way: the publish's own save first is the only one", async () => {
    const saveConfigurationVersion = vi.spyOn(apiClient, "saveConfigurationVersion");
    loadAndEdit();
    useEditorStore.getState().setPublishing(true);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(BUSY);
    expect(saveConfigurationVersion).not.toHaveBeenCalled();
  });
});

describe("the collector version in a save: the pin follows whoever last picked it", () => {
  /** A save that answers with what it stored: the text, and the pin sent or else the one `stored` (the server keeps it). */
  function storing(stored: Pick<ConfigurationVersion, "collectorVersion" | "collectorVersionDeprecated" | "collectorVersionDeprecatedNote"> = VERSION) {
    return vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockImplementation(async (_organizationId, _configurationId, _versionId, { yamlContent, collectorVersion }) => ({
        version: {
          ...VERSION,
          yamlContent,
          ...(collectorVersion === undefined
            ? {
                collectorVersion: stored.collectorVersion,
                collectorVersionDeprecated: stored.collectorVersionDeprecated,
                collectorVersionDeprecatedNote: stored.collectorVersionDeprecatedNote,
              }
            : { collectorVersion, collectorVersionDeprecated: false, collectorVersionDeprecatedNote: null }),
          updatedAt: "2026-10-05T12:00:00.000Z",
        },
      }));
  }

  /** Ana's version 1, as her tab loaded it: pinned to a release the catalogue has deprecated since. */
  const ANAS_VERSION = versionFixture({
    yamlContent: SAVED_YAML,
    ...GRAPH,
    collectorVersion: RETIRED_VERSION,
    collectorVersionDeprecated: true,
    collectorVersionDeprecatedNote: RETIRED_NOTE,
  });

  it("a pick alone marks the editor dirty, and Save sends it with the saved text, then marks it saved", async () => {
    const saveConfigurationVersion = storing();
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().setCollectorVersion("0.161.0");
    expect(selectIsDirty(useEditorStore.getState())).toBe(true);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);

    const [, , , body] = saveConfigurationVersion.mock.calls[0]!;
    expect(body).toMatchObject({ yamlContent: SAVED_YAML, collectorVersion: "0.161.0" });
    expect(useEditorStore.getState()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
  });

  it("Ana's stale, untouched tab (a deprecated pin) saves text after Ben picked and saved 0.162.0: no pin is sent, and her picker then shows Ben's, clean", async () => {
    // Ben's pick, which the server holds now; Ana's tab never saw it.
    const saveConfigurationVersion = storing({
      collectorVersion: "0.162.0",
      collectorVersionDeprecated: false,
      collectorVersionDeprecatedNote: null,
    });
    loadAndEdit(EDITED_YAML, ANAS_VERSION);
    expect(useEditorStore.getState().collectorVersion).toBe(RETIRED_VERSION);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);

    const [, , , body] = saveConfigurationVersion.mock.calls[0]!;
    expect(body).not.toHaveProperty("collectorVersion");
    expect(body.yamlContent).toBe(EDITED_YAML);
    expect(useEditorStore.getState()).toMatchObject({
      collectorVersion: "0.162.0",
      savedCollectorVersion: "0.162.0",
      version: { collectorVersion: "0.162.0", collectorVersionDeprecated: false },
    });
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
  });

  it("keeps a deprecated pin on a text save: none is sent, and the server keeps it", async () => {
    const saveConfigurationVersion = storing(ANAS_VERSION);
    loadAndEdit(EDITED_YAML, ANAS_VERSION);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);

    expect(saveConfigurationVersion.mock.calls[0]![3]).not.toHaveProperty("collectorVersion");
    expect(useEditorStore.getState()).toMatchObject({ collectorVersion: RETIRED_VERSION, savedCollectorVersion: RETIRED_VERSION });
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
  });

  it("a pick back to the saved pin before Save is no pick: none is sent", async () => {
    const saveConfigurationVersion = storing();
    loadAndEdit();
    useEditorStore.getState().setCollectorVersion("0.161.0");
    useEditorStore.getState().setCollectorVersion(VERSION.collectorVersion);
    const { save } = await renderSave();

    await expect(save()).resolves.toEqual(SAVED);

    expect(saveConfigurationVersion.mock.calls[0]![3]).not.toHaveProperty("collectorVersion");
  });

  it("marks saved the pin that was sent, so a pick during the save leaves the editor dirty", async () => {
    const { resolve, saveConfigurationVersion } = pendingSave();
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().setCollectorVersion("0.161.0");
    const { save } = await renderSave();

    const saving = save();
    act(() => useEditorStore.getState().setCollectorVersion("0.160.0"));
    resolve({ version: { ...VERSION, collectorVersion: "0.161.0", updatedAt: "2026-10-05T12:00:00.000Z" } });

    await expect(saving).resolves.toEqual(SAVED);
    expect(saveConfigurationVersion.mock.calls[0]![3].collectorVersion).toBe("0.161.0");
    expect(useEditorStore.getState()).toMatchObject({ collectorVersion: "0.160.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(useEditorStore.getState())).toBe(true);
  });

  it("a pick during the save that picks the old saved pin back stays on screen, unsaved: it counts as a pick", async () => {
    const { resolve, saveConfigurationVersion } = pendingSave();
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().setCollectorVersion("0.161.0");
    const { save } = await renderSave();

    const saving = save();
    act(() => useEditorStore.getState().setCollectorVersion(VERSION.collectorVersion));
    resolve({ version: { ...VERSION, collectorVersion: "0.161.0", updatedAt: "2026-10-05T12:00:00.000Z" } });

    await expect(saving).resolves.toEqual(SAVED);
    expect(saveConfigurationVersion.mock.calls[0]![3].collectorVersion).toBe("0.161.0");
    expect(useEditorStore.getState()).toMatchObject({
      collectorVersion: VERSION.collectorVersion,
      savedCollectorVersion: "0.161.0",
    });
    expect(selectIsDirty(useEditorStore.getState())).toBe(true);
  });

  it("a pick during a text save that sent no pin stays on screen, unsaved, over the pin the server kept", async () => {
    const { resolve, saveConfigurationVersion } = pendingSave();
    loadAndEdit();
    const { save } = await renderSave();

    const saving = save();
    act(() => useEditorStore.getState().setCollectorVersion("0.160.0"));
    // A teammate's pin, kept by the server.
    resolve({ version: { ...VERSION, yamlContent: EDITED_YAML, collectorVersion: "0.161.0", updatedAt: "2026-10-05T12:00:00.000Z" } });

    await expect(saving).resolves.toEqual(SAVED);
    expect(saveConfigurationVersion.mock.calls[0]![3]).not.toHaveProperty("collectorVersion");
    expect(useEditorStore.getState()).toMatchObject({ collectorVersion: "0.160.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(useEditorStore.getState())).toBe(true);
  });

  it("a stale tab's typed text, no pick, refused because a teammate published 0.160.0: the re-read shows the published pin, the text kept", async () => {
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockRejectedValue(new ApiError("configuration_version_published", "This version is published and can't be changed."));
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(
      answerFor(MINE, { ...VERSION, ...PUBLISHED_FIELDS, collectorVersion: "0.160.0", updatedAt: "2026-10-04T11:30:00.000Z" }),
    );
    loadAndEdit();
    const { save } = await renderSave();

    await expect(saveInAct(save)).resolves.toEqual(REFUSED);

    expect(saveConfigurationVersion.mock.calls[0]![3]).not.toHaveProperty("collectorVersion");
    const state = useEditorStore.getState();
    expect(selectIsVersionPublished(state)).toBe(true);
    expect(state).toMatchObject({ text: EDITED_YAML, collectorVersion: "0.160.0", savedCollectorVersion: "0.160.0" });
    expect(selectIsDirty(state)).toBe(true);
  });

  it("a stale tab that only picked, refused because a teammate published other text and 0.160.0: the re-read shows the teammate's text with the pick, dirty by the pin alone", async () => {
    const teammateText = `${SAVED_YAML}# Ben's published change\n`;
    const saveConfigurationVersion = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockRejectedValue(new ApiError("configuration_version_published", "This version is published and can't be changed."));
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(
      answerFor(MINE, {
        ...VERSION,
        ...PUBLISHED_FIELDS,
        yamlContent: teammateText,
        collectorVersion: "0.160.0",
        updatedAt: "2026-10-04T11:30:00.000Z",
      }),
    );
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().setCollectorVersion("0.161.0");
    const { save } = await renderSave();

    await expect(saveInAct(save)).resolves.toEqual(REFUSED);

    expect(saveConfigurationVersion.mock.calls[0]![3]).toMatchObject({ yamlContent: SAVED_YAML, collectorVersion: "0.161.0" });
    const state = useEditorStore.getState();
    expect(selectIsVersionPublished(state)).toBe(true);
    expect(state).toMatchObject({
      text: teammateText,
      savedText: teammateText,
      collectorVersion: "0.161.0",
      savedCollectorVersion: "0.160.0",
    });
    expect(selectIsDirty(state)).toBe(true);
    expect(selectIsDirty({ ...state, collectorVersion: "0.160.0" })).toBe(false);
  });

  it("a 400 collector_version_unknown (a pick retired since the page read the catalogue) says so, and keeps the pick unsaved", async () => {
    vi.spyOn(apiClient, "saveConfigurationVersion").mockRejectedValue(
      new ApiError("collector_version_unknown", "That collector version isn't available."),
    );
    const error = vi.spyOn(toast, "error");
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().setCollectorVersion("0.161.0");
    const { save } = await renderSave();

    await expect(saveInAct(save)).resolves.toEqual(REFUSED);

    expect(error).toHaveBeenCalledWith(COLLECTOR_VERSION_UNAVAILABLE_MESSAGE);
    expect(COLLECTOR_VERSION_UNAVAILABLE_MESSAGE).toBe("That collector version isn't available.");
    expect(useEditorStore.getState()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.162.0" });
    expect(selectIsDirty(useEditorStore.getState())).toBe(true);
  });
});
