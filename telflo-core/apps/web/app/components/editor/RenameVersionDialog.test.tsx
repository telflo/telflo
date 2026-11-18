import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConfigurationVersionSummary, ConfigurationVersionSummaryResponse } from "@telflo/contracts";
import { useState } from "react";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RENAME_VERSION_FAILED_MESSAGE, RenameVersionDialog, VERSION_RENAMED_MESSAGE } from "./RenameVersionDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { selectIsDirty, selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, THEIRS, answerFor, versionFixture, versionSummaryOf } from "~/test/configurations.js";

/*
 * The "Rename Version" dialog, with D10 decision 12's changes: an
 * unchanged name sends nothing, and a failure keeps the dialog open.
 */

const VERSION_1 = versionFixture({ yamlContent: "receivers: {}\n", label: "Initial version" });
const VERSION_2 = versionFixture({ id: "0199c000-0000-7000-8000-000000000012", versionNumber: 2, label: null });
const LISTED = [versionSummaryOf(VERSION_2), versionSummaryOf(VERSION_1)];

const initialState = useEditorStore.getState();

/** The dialog open for `version`, with a loader to count the layout's revalidations. */
function renderDialog(version: ConfigurationVersionSummary = versionSummaryOf(VERSION_1)) {
  const loader = vi.fn(() => null);
  const onOpenChange = vi.fn();
  function Page() {
    const [target, setTarget] = useState<ConfigurationVersionSummary | null>(version);
    return (
      <RenameVersionDialog
        version={target}
        onOpenChange={(open) => {
          onOpenChange(open);
          if (!open) setTarget(null);
        }}
      />
    );
  }
  const Stub = createRoutesStub([{ path: "/editor", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/editor"]} />);
  return { loader, onOpenChange, user: userEvent.setup() };
}

const dialog = () => screen.findByRole("dialog", { name: "Rename Version" });
const field = () => screen.getByRole("textbox", { name: "Version name" });
const saveButton = () => within(screen.getByRole("dialog")).getByRole("button", { name: /^Sav/ });

/** A rename that answers with the summary renamed as asked. */
function acceptRenames() {
  return vi
    .spyOn(apiClient, "renameConfigurationVersion")
    .mockImplementation(async (_organizationId, _configurationId, versionId, { label }) => ({
      version: { ...LISTED.find((summary) => summary.id === versionId)!, label },
    }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION_1, versions: LISTED });
});

describe("RenameVersionDialog", () => {
  it("is prefilled with the version's label, focused, at most 80 characters, with its placeholder", async () => {
    renderDialog();
    await dialog();

    expect(field()).toHaveValue("Initial version");
    expect(field()).toHaveFocus();
    expect(field()).toHaveAttribute("maxLength", "80");
    expect(field()).toHaveAttribute("placeholder", "e.g. Add tail sampling");
    expect(saveButton()).toHaveTextContent("Save");
    expect(saveButton()).toBeEnabled();
  });

  it('is prefilled with "Version N" for an unnamed version', async () => {
    renderDialog(versionSummaryOf(VERSION_2));
    await dialog();

    expect(field()).toHaveValue("Version 2");
  });

  it("81 characters can't be typed", async () => {
    const { user } = renderDialog();
    await dialog();

    await user.clear(field());
    await user.type(field(), "a".repeat(81));

    expect(field()).toHaveValue("a".repeat(80));
  });

  it("a blank name disables Save, spaces included", async () => {
    const renameConfigurationVersion = acceptRenames();
    const { user } = renderDialog();
    await dialog();

    await user.clear(field());
    expect(saveButton()).toBeDisabled();
    await user.type(field(), "   {Enter}");
    expect(saveButton()).toBeDisabled();

    expect(renameConfigurationVersion).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Rename Version" })).toBeInTheDocument();
  });

  it.each([
    ["the label", versionSummaryOf(VERSION_1), "  Initial version "],
    ['"Version N" for an unnamed version', versionSummaryOf(VERSION_2), "Version 2"],
  ])("an unchanged name (%s, trimmed) closes it and sends nothing", async (_why, version, typed) => {
    const renameConfigurationVersion = acceptRenames();
    const success = vi.spyOn(toast, "success");
    const { user } = renderDialog(version);
    await dialog();

    await user.clear(field());
    await user.type(field(), typed);
    await user.click(saveButton());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(renameConfigurationVersion).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(useEditorStore.getState().versions).toEqual(LISTED);
  });

  it("renames with the trimmed name, in the organization it was loaded in; toasts its message, closes, and the store shows the label", async () => {
    const renameConfigurationVersion = acceptRenames();
    const success = vi.spyOn(toast, "success");
    const { user } = renderDialog();
    await dialog();

    await user.clear(field());
    await user.type(field(), "  Baseline {Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(renameConfigurationVersion).toHaveBeenCalledTimes(1);
    expect(renameConfigurationVersion).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_1.id, { label: "Baseline" });
    expect(success).toHaveBeenCalledWith(VERSION_RENAMED_MESSAGE);
    expect(VERSION_RENAMED_MESSAGE).toBe("Version renamed");
    const state = useEditorStore.getState();
    expect(state.version?.label).toBe("Baseline");
    expect(state.versions.find((summary) => summary.id === VERSION_1.id)?.label).toBe("Baseline");
  });

  it('reads "Saving…" with everything disabled while the rename is under way, and renames once', async () => {
    let finish!: (response: ConfigurationVersionSummaryResponse) => void;
    const renameConfigurationVersion = vi
      .spyOn(apiClient, "renameConfigurationVersion")
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { user } = renderDialog();
    const open = await dialog();

    await user.clear(field());
    await user.type(field(), "Baseline{Enter}");

    const saving = await within(open).findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    expect(within(open).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(field()).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Rename Version" })).toBeInTheDocument();
    expect(renameConfigurationVersion).toHaveBeenCalledTimes(1);

    await act(async () => finish({ version: { ...versionSummaryOf(VERSION_1), label: "Baseline" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([
    ["a server error", new ApiError("internal_error", "Something went wrong. Please try again."), RENAME_VERSION_FAILED_MESSAGE],
    ["a network failure", new TypeError("Failed to fetch"), RENAME_VERSION_FAILED_MESSAGE],
    ["a version not found", new ApiError("configuration_version_not_found", "Version not found"), "Version not found"],
    ["a deleted configuration", new ApiError("configuration_not_found", "Configuration not found"), "Configuration not found"],
  ])("on %s: toasts the message, keeps the dialog open with the name typed and focused, and revalidates nothing", async (_why, failure, message) => {
    vi.spyOn(apiClient, "renameConfigurationVersion").mockRejectedValue(failure);
    const error = vi.spyOn(toast, "error");
    const { user, loader } = renderDialog();
    await dialog();
    const loadsBefore = loader.mock.calls.length;

    await user.clear(field());
    await user.type(field(), "Baseline");
    await user.click(saveButton());

    await waitFor(() => expect(error).toHaveBeenCalledWith(message));
    expect(RENAME_VERSION_FAILED_MESSAGE).toBe("Failed to rename version. Please try again.");
    expect(screen.getByRole("dialog", { name: "Rename Version" })).toBeInTheDocument();
    expect(field()).toHaveValue("Baseline");
    expect(field()).toBeEnabled();
    expect(saveButton()).toBeEnabled();
    // Back in the field, from Save, which was disabled meanwhile (D10 Ruling 44).
    await waitFor(() => expect(field()).toHaveFocus());
    expect(loader.mock.calls.length).toBe(loadsBefore);
    expect(useEditorStore.getState().version?.label).toBe("Initial version");
  });

  it.each([
    ["organization_not_found", new ApiError("organization_not_found", "Organization not found")],
    ["terms_acceptance_required", new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.")],
  ])("a %s refusal toasts its message and revalidates the layout, as the configuration's rename does (Preflight ruling 15)", async (_code, failure) => {
    vi.spyOn(apiClient, "renameConfigurationVersion").mockRejectedValue(failure);
    const error = vi.spyOn(toast, "error");
    const { user, loader } = renderDialog();
    await dialog();
    const loadsBefore = loader.mock.calls.length;

    await user.clear(field());
    await user.type(field(), "Baseline{Enter}");

    await waitFor(() => expect(error).toHaveBeenCalledWith(failure.message));
    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(field()).toHaveValue("Baseline");
  });

  it.each([
    ["the open version", VERSION_1],
    ["another row of the picker", VERSION_2],
  ])("a version published meanwhile (%s): toasts the refusal, closes, and reads the version again, so its row shows the lock (Ruling 31)", async (_which, target) => {
    vi.spyOn(apiClient, "renameConfigurationVersion").mockRejectedValue(
      new ApiError("configuration_version_published", "This version is published and can't be changed."),
    );
    const published = { ...target, ...PUBLISHED_FIELDS };
    const read = vi
      .spyOn(apiClient, "getConfigurationVersion")
      .mockResolvedValue(answerFor({ ...MINE, published: true }, published, [versionSummaryOf(published)]));
    const error = vi.spyOn(toast, "error");
    const { user, onOpenChange, loader } = renderDialog(versionSummaryOf(target));
    await dialog();
    const loadsBefore = loader.mock.calls.length;

    await user.clear(field());
    await user.type(field(), "Baseline{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("This version is published and can't be changed.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(read).toHaveBeenCalledWith(GROUP_ID, MINE.id, target.id));
    await waitFor(() =>
      expect(useEditorStore.getState().versions.find((row) => row.id === target.id)?.publishedAt).toBe(
        PUBLISHED_FIELDS.publishedAt,
      ),
    );
    // The open version locks only when it is the one published; the label is never the one typed.
    expect(selectIsVersionPublished(useEditorStore.getState())).toBe(target.id === VERSION_1.id);
    expect(useEditorStore.getState().versions.find((row) => row.id === target.id)?.label).toBe(target.label);
    expect(loader.mock.calls.length).toBe(loadsBefore);
  });

  it("the open version published meanwhile, with content this clean tab never loaded: the editor locks on what was published, clean (Ruling 35)", async () => {
    vi.spyOn(apiClient, "renameConfigurationVersion").mockRejectedValue(
      new ApiError("configuration_version_published", "This version is published and can't be changed."),
    );
    const teammateText = "receivers: {}\nexporters: {}\n";
    const published = { ...VERSION_1, ...PUBLISHED_FIELDS, yamlContent: teammateText, updatedAt: "2026-10-04T11:30:00.000Z" };
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(
      answerFor({ ...MINE, published: true }, published, [versionSummaryOf(published)]),
    );
    vi.spyOn(toast, "error");
    const { loadCount } = useEditorStore.getState();
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
    const { user } = renderDialog(versionSummaryOf(VERSION_1));
    await dialog();

    await user.clear(field());
    await user.type(field(), "Baseline{Enter}");

    await waitFor(() => expect(selectIsVersionPublished(useEditorStore.getState())).toBe(true));
    const state = useEditorStore.getState();
    expect(state).toMatchObject({ text: teammateText, savedText: teammateText, version: published, loadCount });
    expect(selectIsDirty(state)).toBe(false);
  });

  it("the open version published meanwhile, a tab that only picked: the editor locks on the published text with its pick on screen, dirty by the pin alone (Ruling 41)", async () => {
    vi.spyOn(apiClient, "renameConfigurationVersion").mockRejectedValue(
      new ApiError("configuration_version_published", "This version is published and can't be changed."),
    );
    const teammateText = "receivers: {}\nexporters: {}\n";
    const published = {
      ...VERSION_1,
      ...PUBLISHED_FIELDS,
      yamlContent: teammateText,
      collectorVersion: "0.160.0",
      updatedAt: "2026-10-04T11:30:00.000Z",
    };
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(
      answerFor({ ...MINE, published: true }, published, [versionSummaryOf(published)]),
    );
    vi.spyOn(toast, "error");
    useEditorStore.getState().setCollectorVersion("0.161.0");
    const { user } = renderDialog(versionSummaryOf(VERSION_1));
    await dialog();

    await user.clear(field());
    await user.type(field(), "Baseline{Enter}");

    await waitFor(() => expect(selectIsVersionPublished(useEditorStore.getState())).toBe(true));
    const state = useEditorStore.getState();
    expect(state).toMatchObject({
      text: teammateText,
      savedText: teammateText,
      collectorVersion: "0.161.0",
      savedCollectorVersion: "0.160.0",
    });
    expect(selectIsDirty(state)).toBe(true);
    expect(selectIsDirty({ ...state, collectorVersion: "0.160.0" })).toBe(false);
  });

  it("an answer after another configuration opened changes and toasts nothing", async () => {
    let finish!: (response: ConfigurationVersionSummaryResponse) => void;
    vi.spyOn(apiClient, "renameConfigurationVersion").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const success = vi.spyOn(toast, "success");
    const { user } = renderDialog();
    await dialog();
    await user.clear(field());
    await user.type(field(), "Baseline{Enter}");
    const theirs = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", configurationId: THEIRS.id });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: THEIRS, version: theirs }));

    await act(async () => finish({ version: { ...versionSummaryOf(VERSION_1), label: "Baseline" } }));

    expect(success).not.toHaveBeenCalled();
    expect(useEditorStore.getState().version).toEqual(theirs);
  });

  it("Cancel closes it, sending nothing", async () => {
    const renameConfigurationVersion = acceptRenames();
    const { user, onOpenChange } = renderDialog();
    const open = await dialog();
    await user.type(field(), " more");

    await user.click(within(open).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(renameConfigurationVersion).not.toHaveBeenCalled();
  });
});
