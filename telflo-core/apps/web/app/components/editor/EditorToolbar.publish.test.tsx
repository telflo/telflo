import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VARIABLE_REFERENCE_TOO_LONG_MESSAGE, type ConfigurationVersion, type ConfigurationVersionSummaryResponse } from "@telflo/contracts";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE_TITLE, DUPLICATE_TITLE, EditorToolbar, REDO_TITLE, UNDO_TITLE } from "./EditorToolbar.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import {
  DELETED_MESSAGE,
  OTHER_ORGANIZATION_MESSAGE,
  SAVED_MESSAGE,
  SAVE_FAILED_MESSAGE,
} from "~/lib/editor/use-save-configuration.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, selectIsVersionPublished, summaryOf, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, answerFor, versionFixture } from "~/test/configurations.js";

/*
 * The toolbar's Publish: the button and its tooltips, the dialog's words, the
 * save first, the updatedAt sent, the answers' toasts, the reload a changed
 * version brings, one publish at a time, and the lock the answer brings.
 */

const STARTER = corpusText("starter.yaml");
const LABEL = "Tail sampling zq7c";
const VERSION = versionFixture({ versionNumber: 4, label: LABEL, yamlContent: STARTER });
const PUBLISHED_SUMMARY = { ...summaryOf(VERSION), ...PUBLISHED_FIELDS };
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

function open(version: ConfigurationVersion = VERSION) {
  store().load({ organizationId: GROUP_ID, configuration: MINE, version });
}

/** The layout's loader, counting its revalidations. */
let loader = vi.fn(() => null);

async function renderToolbar(version: ConfigurationVersion = VERSION) {
  open(version);
  loader = vi.fn(() => null);
  const Stub = createRoutesStub([
    {
      path: "/editor",
      Component: () => <EditorToolbar onSave={() => {}} />,
      loader,
      HydrateFallback: () => null,
    },
  ]);
  render(<Stub initialEntries={["/editor"]} />);
  await screen.findByRole("button", { name: "Save" });
  return userEvent.setup();
}

/** The updatedAt the publish sends for a version as the tab loaded it. */
const EXPECTED = { expectedUpdatedAt: VERSION.updatedAt };

const publishButton = () => screen.getByRole("button", { name: "Publish" });
const dialog = () => screen.getByRole("dialog", { name: "Publish Configuration" });

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(publishButton());
  return screen.findByRole("dialog", { name: "Publish Configuration" });
}

/** A publish that answers when the test chooses. */
function pendingPublish() {
  let resolve!: (response: ConfigurationVersionSummaryResponse) => void;
  let reject!: (error: unknown) => void;
  const spy = vi.spyOn(apiClient, "publishConfigurationVersion").mockImplementation(
    () =>
      new Promise((settle, fail) => {
        resolve = settle;
        reject = fail;
      }),
  );
  return { spy, resolve: (r: ConfigurationVersionSummaryResponse) => resolve(r), reject: (e: unknown) => reject(e) };
}

function publishAnswers() {
  return vi.spyOn(apiClient, "publishConfigurationVersion").mockResolvedValue({ version: PUBLISHED_SUMMARY });
}

function saveAnswers() {
  return vi
    .spyOn(apiClient, "saveConfigurationVersion")
    .mockImplementation(async (_organizationId, _configurationId, _versionId, { yamlContent }) => ({
      version: { ...VERSION, yamlContent, updatedAt: "2026-10-04T11:00:00.000Z" },
    }));
}

describe("the Publish button", () => {
  it("follows Save, with the rocket and the tooltip, enabled for a saved version", async () => {
    await renderToolbar();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.nextElementSibling).toBe(publishButton());
    expect(publishButton().querySelector("svg.lucide-rocket")).not.toBeNull();
    expect(publishButton()).toHaveAttribute("title", "Publish this version so fleets can deploy it.");
    expect(publishButton()).toHaveAccessibleDescription("Publish this version so fleets can deploy it.");
    expect(publishButton()).toBeEnabled();
  });

  it("is disabled, 'Already published', on a published version", async () => {
    await renderToolbar(versionFixture({ ...VERSION, ...PUBLISHED_FIELDS }));
    expect(publishButton()).toBeDisabled();
    expect(publishButton()).toHaveAttribute("title", "Already published");
  });

  it("is disabled only while the editor's text is empty, with its tooltip", async () => {
    await renderToolbar(versionFixture({ ...VERSION, yamlContent: "" }));
    expect(publishButton()).toBeDisabled();
    expect(publishButton()).toHaveAttribute("title", "An empty version can't be published.");
    // Saved empty, with text typed over it: it publishes, saving first.
    act(() => store().setText("receivers: {}\n"));
    expect(publishButton()).toBeEnabled();
    expect(publishButton()).toHaveAttribute("title", "Publish this version so fleets can deploy it.");
    act(() => store().setText(""));
    expect(publishButton()).toBeDisabled();
    expect(publishButton()).toHaveAttribute("title", "An empty version can't be published.");
  });

  it("is disabled while a saved version's text is emptied on screen", async () => {
    await renderToolbar();
    act(() => store().setText(""));
    expect(publishButton()).toBeDisabled();
    expect(publishButton()).toHaveAttribute("title", "An empty version can't be published.");
  });

  it("is disabled while a save, a create or a publish is under way", async () => {
    await renderToolbar();
    for (const flag of ["isSaving", "isCreatingVersion", "isPublishing"] as const) {
      act(() => useEditorStore.setState({ [flag]: true }));
      expect(publishButton()).toBeDisabled();
      act(() => useEditorStore.setState({ [flag]: false }));
      expect(publishButton()).toBeEnabled();
    }
  });
});

describe("the lock in the toolbar", () => {
  it("disables Save, Publish, Undo, Redo, Duplicate and Delete on a version published under it, with history and a selection", async () => {
    await renderToolbar();
    const batch = store().graph.nodes.find((n) => n.data.componentSubType === "batch")!;
    act(() => {
      store().setComponentValues(batch.id, [{ path: ["timeout"], value: "5s" }]);
      store().addPipeline("traces/two");
      store().undo();
      store().selectNode(batch.id);
    });
    for (const name of [UNDO_TITLE, REDO_TITLE, DUPLICATE_TITLE, DELETE_TITLE, "Save", "Publish"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }

    act(() => store().replaceVersionSummary(PUBLISHED_SUMMARY));

    for (const name of [UNDO_TITLE, REDO_TITLE, DUPLICATE_TITLE, DELETE_TITLE, "Save", "Publish"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    // The configuration can still be renamed.
    expect(screen.getByRole("button", { name: "Rename configuration" })).toBeEnabled();
  });
});

describe("the dialog", () => {
  it("says what it publishes, by number, with Cancel and Publish; Cancel publishes nothing", async () => {
    const publish = publishAnswers();
    const user = await renderToolbar();
    const shown = await openDialog(user);

    expect(within(shown).getByRole("heading", { name: "Publish Configuration" })).toBeInTheDocument();
    expect(shown).toHaveAccessibleDescription(
      "This will publish version 4, making it available to your organization members and fleet management.",
    );
    expect(within(shown).queryByText("Your unsaved changes will be saved first.")).toBeNull();
    expect(within(shown).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(shown).getByRole("button", { name: "Publish" })).toBeEnabled();

    await user.click(within(shown).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(publish).not.toHaveBeenCalled();
  });

  it("says unsaved changes will be saved first, when there are some", async () => {
    const user = await renderToolbar();
    act(() => store().setText(`${STARTER}# edited\n`));
    const shown = await openDialog(user);
    expect(within(shown).getByText("Your unsaved changes will be saved first.")).toBeInTheDocument();
  });

  it("names neither the configuration nor the version's label, in text or attribute", async () => {
    const user = await renderToolbar();
    const shown = await openDialog(user);
    expect(shown).not.toHaveTextContent(MINE.name);
    expect(shown).not.toHaveTextContent(LABEL);
    for (const element of [shown, ...shown.querySelectorAll("*")]) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain(MINE.name);
        expect(attribute.value).not.toContain(LABEL);
      }
    }
  });
});

describe("publishing", () => {
  it("publishes a saved version without saving, then locks the editor and toasts, keeping its text, history and canvas", async () => {
    const save = saveAnswers();
    const publish = publishAnswers();
    const user = await renderToolbar();
    const { text, history, canvasKey, loadCount } = store();

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, EXPECTED);
    expect(save).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Configuration published successfully");
    expect(selectIsVersionPublished(store())).toBe(true);
    expect(store().versions).toEqual([PUBLISHED_SUMMARY]);
    expect(store()).toMatchObject({ text, history, canvasKey, loadCount, isPublishing: false });
    expect(publishButton()).toBeDisabled();
    expect(publishButton()).toHaveAttribute("title", "Already published");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("with unsaved changes, saves them first, then publishes what was saved", async () => {
    const order: string[] = [];
    const save = saveAnswers().mockImplementation(async (_o, _c, _v, { yamlContent }) => {
      order.push("save");
      return { version: { ...VERSION, yamlContent } };
    });
    const publish = vi.spyOn(apiClient, "publishConfigurationVersion").mockImplementation(async () => {
      order.push("publish");
      return { version: PUBLISHED_SUMMARY };
    });
    const user = await renderToolbar();
    const edited = `${STARTER}# edited\n`;
    act(() => store().setText(edited));

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Configuration published successfully"));
    expect(order).toEqual(["save", "publish"]);
    expect(save.mock.calls[0]![3].yamlContent).toBe(edited);
    expect(publish).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith(SAVED_MESSAGE);
    expect(store().savedText).toBe(edited);
    expect(selectIsDirty(store())).toBe(false);
    expect(selectIsVersionPublished(store())).toBe(true);
  });

  it("publishes nothing when the save first fails: the save's own error says why", async () => {
    vi.spyOn(apiClient, "saveConfigurationVersion").mockRejectedValue(new ApiError("internal_error", "Something went wrong"));
    const publish = publishAnswers();
    const user = await renderToolbar();
    act(() => store().setText(`${STARTER}# edited\n`));

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(SAVE_FAILED_MESSAGE));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(publish).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
    expect(selectIsVersionPublished(store())).toBe(false);
    expect(selectIsDirty(store())).toBe(true);
  });

  it("publishes nothing when the save first left the text empty, and says an empty version can't be published (the hook's own check)", async () => {
    saveAnswers();
    const publish = publishAnswers();
    const user = await renderToolbar();
    const shown = await openDialog(user);
    // Emptied once the dialog is open, past the button's own rule.
    act(() => store().setText(""));

    await user.click(within(shown).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("An empty version can't be published."));
    expect(publish).not.toHaveBeenCalled();
    expect(store().savedText).toBe("");
  });

  it("a version saved empty with text typed over it saves first, then publishes with the save's updatedAt", async () => {
    const save = saveAnswers();
    const publish = publishAnswers();
    const user = await renderToolbar(versionFixture({ ...VERSION, yamlContent: "" }));
    act(() => store().setText(STARTER));

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Configuration published successfully"));
    expect(save.mock.calls[0]![3].yamlContent).toBe(STARTER);
    expect(publish).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, { expectedUpdatedAt: "2026-10-04T11:00:00.000Z" });
  });

  it("after a save first, sends the save's answer's updatedAt, not the one loaded", async () => {
    saveAnswers();
    const publish = publishAnswers();
    const user = await renderToolbar();
    act(() => store().setText(`${STARTER}# edited\n`));

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, { expectedUpdatedAt: "2026-10-04T11:00:00.000Z" });
    expect(VERSION.updatedAt).not.toBe("2026-10-04T11:00:00.000Z");
  });

  it("keeps saying unsaved changes will be saved first while the publish runs, after the save first has landed", async () => {
    saveAnswers();
    const pending = pendingPublish();
    const user = await renderToolbar();
    act(() => store().setText(`${STARTER}# edited\n`));
    const shown = await openDialog(user);

    await user.click(within(shown).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(pending.spy).toHaveBeenCalledOnce());
    expect(selectIsDirty(store())).toBe(false);
    expect(within(dialog()).getByText("Your unsaved changes will be saved first.")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Publishing…" })).toBeDisabled();

    await act(async () => pending.resolve({ version: PUBLISHED_SUMMARY }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("publishes once however often Publish is pressed: 'Publishing…', both buttons disabled, Escape ignored meanwhile", async () => {
    const pending = pendingPublish();
    const user = await renderToolbar();
    const shown = await openDialog(user);
    const confirm = within(shown).getByRole("button", { name: "Publish" });

    await user.click(confirm);
    await user.click(confirm);
    await user.keyboard("{Escape}");

    expect(pending.spy).toHaveBeenCalledOnce();
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Publishing…" })).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(store().isPublishing).toBe(true);
    // The toolbar's own Publish, behind the modal dialog, is disabled meanwhile too.
    expect(screen.getByRole("button", { name: "Publish", hidden: true })).toBeDisabled();

    await act(async () => pending.resolve({ version: PUBLISHED_SUMMARY }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pending.spy).toHaveBeenCalledOnce();
    expect(store().isPublishing).toBe(false);
  });
});

describe("a publish's refusals, each toasted by its code", () => {
  it.each([
    ["configuration_version_empty", 409, "An empty version can't be published."],
    ["publishing_unavailable", 503, "Publishing is unavailable right now. Try again."],
    ["configuration_not_found", 404, DELETED_MESSAGE],
    ["configuration_version_not_found", 404, "An error occurred while publishing."],
    ["internal_error", 500, "An error occurred while publishing."],
    ["network_error", 0, "An error occurred while publishing."],
  ])("%s (%i) toasts '%s', and the version stays a draft", async (code, _status, message) => {
    vi.spyOn(apiClient, "publishConfigurationVersion").mockRejectedValue(new ApiError(code, `server words ${code}`));
    const read = vi.spyOn(apiClient, "getConfigurationVersion");
    const user = await renderToolbar();

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(selectIsVersionPublished(store())).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store().isPublishing).toBe(false);
    expect(publishButton()).toBeEnabled();
  });

  // A text referencing an organization variable name over 128 characters is refused with 400 invalid_request
  // naming `yaml`; the toast says why, in the contracts' fixed words.
  it("a reference to a name over 128 characters (400 naming yaml) toasts the contracts' words, and the version stays a draft", async () => {
    const detail = {
      keyword: "custom",
      instancePath: "/yaml",
      schemaPath: "#/yaml/custom",
      params: { issue: { code: "custom", path: ["yaml"], message: "m" } },
      message: "m",
    };
    vi.spyOn(apiClient, "publishConfigurationVersion").mockRejectedValue(
      new ApiError("invalid_request", "The server's words.", { status: 400, details: [detail] }),
    );
    const user = await renderToolbar();

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(VARIABLE_REFERENCE_TOO_LONG_MESSAGE));
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(selectIsVersionPublished(store())).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store().isPublishing).toBe(false);
    expect(publishButton()).toBeEnabled();
  });

  it("another organization toasts the save's message for it and revalidates the layout", async () => {
    vi.spyOn(apiClient, "publishConfigurationVersion").mockRejectedValue(
      new ApiError("organization_not_found", "Organization not found"),
    );
    const user = await renderToolbar();
    const loadsBefore = loader.mock.calls.length;

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(OTHER_ORGANIZATION_MESSAGE));
    expect(toast.error).toHaveBeenCalledOnce();
    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(selectIsVersionPublished(store())).toBe(false);
  });

  it("the terms toast nothing: the layout revalidates, and its terms dialog opens, as for a save", async () => {
    vi.spyOn(apiClient, "publishConfigurationVersion").mockRejectedValue(
      new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
    );
    const user = await renderToolbar();
    const loadsBefore = loader.mock.calls.length;

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(selectIsVersionPublished(store())).toBe(false);
  });

  it("changed since the tab loaded it (a teammate's newer save): toasts, publishes nothing, and opens the version again with the newer text", async () => {
    const NEWER = { ...VERSION, yamlContent: `${STARTER}# a teammate's save\n`, updatedAt: "2026-10-04T12:30:00.000Z" };
    const publish = vi
      .spyOn(apiClient, "publishConfigurationVersion")
      .mockRejectedValue(new ApiError("configuration_version_changed", "server words"));
    const read = vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(answerFor(MINE, NEWER));
    const user = await renderToolbar();
    const { loadCount } = store();

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(store().text).toBe(NEWER.yamlContent));
    expect(publish).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, EXPECTED);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith("This version changed while it was being published. Try again.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id);
    expect(store()).toMatchObject({ savedText: NEWER.yamlContent, version: NEWER, loadCount: loadCount + 1, isPublishing: false });
    expect(selectIsDirty(store())).toBe(false);
    expect(selectIsVersionPublished(store())).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(publishButton()).toBeEnabled();

    // Publish again sends the reloaded version's updatedAt.
    publish.mockResolvedValue({ version: { ...summaryOf(NEWER), ...PUBLISHED_FIELDS } });
    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Configuration published successfully"));
    expect(publish).toHaveBeenLastCalledWith(GROUP_ID, MINE.id, VERSION.id, { expectedUpdatedAt: NEWER.updatedAt });
  });

  it("changed: the reload never goes over text typed while it was asked for", async () => {
    vi.spyOn(apiClient, "publishConfigurationVersion").mockRejectedValue(
      new ApiError("configuration_version_changed", "server words"),
    );
    let answerRead!: () => void;
    vi.spyOn(apiClient, "getConfigurationVersion").mockImplementation(
      () =>
        new Promise((resolve) => {
          answerRead = () => resolve(answerFor(MINE, { ...VERSION, yamlContent: "newer: text\n" }));
        }),
    );
    const user = await renderToolbar();
    const { loadCount } = store();

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(answerRead).toBeDefined());
    const typed = `${STARTER}# typed\n`;
    act(() => store().setText(typed));
    await act(async () => answerRead());

    expect(store().text).toBe(typed);
    expect(store().loadCount).toBe(loadCount);
    await waitFor(() => expect(store().isPublishing).toBe(false));
  });

  it("already published: 'Version {N} is already published.', and the version read again locks the clean editor on what was published", async () => {
    vi.spyOn(apiClient, "publishConfigurationVersion").mockRejectedValue(
      new ApiError("configuration_version_published", "Version 4 is already published."),
    );
    // A teammate's edit, saved and published: not the text this tab loaded.
    const TEAMMATE_TEXT = `${STARTER}# a teammate's publish\n`;
    const teammatePublished = { ...VERSION, ...PUBLISHED_FIELDS, yamlContent: TEAMMATE_TEXT, updatedAt: "2026-10-04T11:30:00.000Z" };
    const read = vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue({
      configuration: { ...MINE, published: true },
      version: teammatePublished,
      versions: [PUBLISHED_SUMMARY],
    });
    const user = await renderToolbar();
    const { loadCount, canvasKey } = store();

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Version 4 is already published."));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id);
    await waitFor(() => expect(selectIsVersionPublished(store())).toBe(true));
    // The whole version is taken: the clean editor shows what was published, still clean, with no reload.
    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, savedText: TEAMMATE_TEXT, version: teammatePublished, loadCount, canvasKey });
    expect(selectIsDirty(store())).toBe(false);
    expect(publishButton()).toHaveAttribute("title", "Already published");
  });
});

describe("a collector version pick and Publish", () => {
  it("an unsaved pick alone saves first, the pin with it, then publishes with the save's updatedAt", async () => {
    const save = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockImplementation(async (_organizationId, _configurationId, _versionId, { yamlContent, collectorVersion }) => ({
        version: { ...VERSION, yamlContent, collectorVersion: collectorVersion!, updatedAt: "2026-10-05T11:00:00.000Z" },
      }));
    const publish = vi
      .spyOn(apiClient, "publishConfigurationVersion")
      .mockResolvedValue({ version: { ...PUBLISHED_SUMMARY, collectorVersion: "0.161.0" } });
    const user = await renderToolbar();
    act(() => store().setCollectorVersion("0.161.0"));
    expect(selectIsDirty(store())).toBe(true);

    const shown = await openDialog(user);
    expect(within(shown).getByText("Your unsaved changes will be saved first.")).toBeInTheDocument();
    await user.click(within(shown).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![3]).toMatchObject({ yamlContent: STARTER, collectorVersion: "0.161.0" });
    expect(publish).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, { expectedUpdatedAt: "2026-10-05T11:00:00.000Z" });
    await waitFor(() => expect(selectIsVersionPublished(store())).toBe(true));
    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a pick alone whose save first is refused because a teammate published other text and 0.160.0: publishes nothing, and the re-read shows the teammate's text with the pick, dirty by the pin alone", async () => {
    const teammateText = `${STARTER}# a teammate's publish\n`;
    const save = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockRejectedValue(new ApiError("configuration_version_published", "This version is published and can't be changed."));
    const publish = publishAnswers();
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(
      answerFor({ ...MINE, published: true }, {
        ...VERSION,
        ...PUBLISHED_FIELDS,
        yamlContent: teammateText,
        collectorVersion: "0.160.0",
        updatedAt: "2026-10-04T11:30:00.000Z",
      }),
    );
    const user = await renderToolbar();
    act(() => store().setCollectorVersion("0.161.0"));

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(selectIsVersionPublished(store())).toBe(true));
    expect(save.mock.calls[0]![3]).toMatchObject({ yamlContent: STARTER, collectorVersion: "0.161.0" });
    expect(publish).not.toHaveBeenCalled();
    expect(store()).toMatchObject({
      text: teammateText,
      savedText: teammateText,
      collectorVersion: "0.161.0",
      savedCollectorVersion: "0.160.0",
    });
    expect(selectIsDirty(store())).toBe(true);
    expect(selectIsDirty({ ...store(), collectorVersion: "0.160.0" })).toBe(false);
  });

  it("a pick made while a clean tab's publish is under way, refused as already published: the re-read shows the teammate's text with the pick", async () => {
    const teammateText = `${STARTER}# a teammate's publish\n`;
    const { spy: publish, reject } = pendingPublish();
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(
      answerFor({ ...MINE, published: true }, {
        ...VERSION,
        ...PUBLISHED_FIELDS,
        yamlContent: teammateText,
        collectorVersion: "0.160.0",
        updatedAt: "2026-10-04T11:30:00.000Z",
      }),
    );
    const user = await renderToolbar();

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    act(() => store().setCollectorVersion("0.161.0"));
    await act(async () => reject(new ApiError("configuration_version_published", "Version 4 is already published.")));

    await waitFor(() => expect(selectIsVersionPublished(store())).toBe(true));
    expect(store()).toMatchObject({ text: teammateText, collectorVersion: "0.161.0", savedCollectorVersion: "0.160.0" });
    expect(selectIsDirty(store())).toBe(true);
  });

  it("unsaved text with an untouched picker: the save first sends no pin, and the editor then shows the pin the server kept (a teammate's), published", async () => {
    const save = vi
      .spyOn(apiClient, "saveConfigurationVersion")
      .mockImplementation(async (_organizationId, _configurationId, _versionId, { yamlContent }) => ({
        // A teammate picked 0.161.0 and saved since this tab loaded the version.
        version: { ...VERSION, yamlContent, collectorVersion: "0.161.0", updatedAt: "2026-10-05T11:00:00.000Z" },
      }));
    const publish = vi
      .spyOn(apiClient, "publishConfigurationVersion")
      .mockResolvedValue({ version: { ...PUBLISHED_SUMMARY, collectorVersion: "0.161.0" } });
    const user = await renderToolbar();
    const typed = `${STARTER}# typed\n`;
    act(() => store().setText(typed));

    await user.click(within(await openDialog(user)).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![3]).toMatchObject({ yamlContent: typed });
    expect(save.mock.calls[0]![3]).not.toHaveProperty("collectorVersion");
    await waitFor(() => expect(selectIsVersionPublished(store())).toBe(true));
    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(store())).toBe(false);
  });
});
