import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConfigurationVersionResponse } from "@telflo/contracts";
import { useState } from "react";
import { createRoutesStub, useLocation } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateVersionDialog } from "./CreateVersionDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { CREATE_VERSION_FAILED_MESSAGE, useCreateVersion } from "~/lib/editor/use-create-version.js";
import { DELETED_MESSAGE, OTHER_ORGANIZATION_MESSAGE, TOO_LARGE_MESSAGE } from "~/lib/editor/use-save-configuration.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

/*
 * The "Copy Version" dialog, with D10 decision 11's text and states,
 * driving the picker's create (`useCreateVersion`) as the picker wires it.
 */

const SAVED_YAML = "receivers:\n  otlp:\n";
const EDITED_YAML = `${SAVED_YAML}# edited\n`;
const SOURCE = versionFixture({ yamlContent: SAVED_YAML });
const CREATED = versionFixture({
  id: "0199c000-0000-7000-8000-000000000013",
  versionNumber: 3,
  yamlContent: EDITED_YAML,
});

const initialState = useEditorStore.getState();

/** The dialog, open, on the editor's address, wired to the create as the picker wires it. */
function renderDialog() {
  const loader = vi.fn(() => null);
  function Page() {
    const { createVersion } = useCreateVersion();
    const isCreating = useEditorStore((state) => state.isCreatingVersion);
    const isSaving = useEditorStore((state) => state.isSaving);
    const [open, setOpen] = useState(true);
    return (
      <>
        <p data-testid="address">{useLocation().pathname}</p>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <CreateVersionDialog
          open={open}
          onOpenChange={setOpen}
          onCreate={createVersion}
          creating={isCreating}
          saving={isSaving}
        />
      </>
    );
  }
  const Stub = createRoutesStub([
    { path: "/editor/:configurationId/:versionId?", Component: Page, loader, HydrateFallback: () => null },
  ]);
  render(<Stub initialEntries={[`/editor/${MINE.id}/${SOURCE.id}`]} />);
  return { loader, user: userEvent.setup() };
}

const dialog = () => screen.findByRole("dialog", { name: "Copy Version" });
const field = () => screen.getByRole("textbox", { name: "Version name (optional)" });
const address = () => screen.getByTestId("address").textContent;

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

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: SOURCE });
  useEditorStore.getState().setText(EDITED_YAML);
});

describe("CreateVersionDialog", () => {
  it("says its title, D10's body, and offers an optional name, focused, at most 80 characters", async () => {
    renderDialog();
    const open = await dialog();

    expect(open).toHaveTextContent(
      "Creates a new version from this one, including any unsaved changes. This version stays as it was last saved.",
    );
    expect(open).toHaveAccessibleDescription(
      "Creates a new version from this one, including any unsaved changes. This version stays as it was last saved.",
    );
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue("");
    expect(field()).toHaveAttribute("placeholder", "e.g. Add tail sampling");
    expect(field()).toHaveAttribute("maxLength", "80");
    expect(within(open).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(open).getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("81 characters can't be typed", async () => {
    const { user } = renderDialog();
    await dialog();

    await user.type(field(), "a".repeat(81));

    expect(field()).toHaveValue("a".repeat(80));
  });

  it("Continue creates with the name, then closes and opens the created version at its address", async () => {
    const createConfigurationVersion = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockResolvedValue({ version: { ...CREATED, label: "Add tail sampling" } });
    const { user } = renderDialog();
    const open = await dialog();

    await user.type(field(), "  Add tail sampling ");
    await user.click(within(open).getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createConfigurationVersion).toHaveBeenCalledTimes(1);
    expect(createConfigurationVersion.mock.calls[0]![2]).toMatchObject({
      sourceVersionId: SOURCE.id,
      label: "Add tail sampling",
      yamlContent: EDITED_YAML,
    });
    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${CREATED.id}`));
    expect(useEditorStore.getState().version?.id).toBe(CREATED.id);
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
  });

  it("Enter creates, without a name", async () => {
    const createConfigurationVersion = vi.spyOn(apiClient, "createConfigurationVersion").mockResolvedValue({ version: CREATED });
    const { user } = renderDialog();
    await dialog();

    await user.type(field(), "{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createConfigurationVersion).toHaveBeenCalledTimes(1);
    expect(createConfigurationVersion.mock.calls[0]![2]).not.toHaveProperty("label");
  });

  it('reads "Creating…" with both buttons disabled while the create is under way, and nothing dismisses it', async () => {
    const { createConfigurationVersion, resolve } = pendingCreate();
    const { user } = renderDialog();
    const open = await dialog();

    await user.click(within(open).getByRole("button", { name: "Continue" }));

    const creating = await within(open).findByRole("button", { name: "Creating…" });
    expect(creating).toBeDisabled();
    expect(within(open).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.type(field(), "{Enter}");
    expect(screen.getByRole("dialog", { name: "Copy Version" })).toBeInTheDocument();
    expect(createConfigurationVersion).toHaveBeenCalledTimes(1);

    await act(async () => resolve({ version: CREATED }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("disables Continue while a save is under way, and Enter creates nothing then (D10 Ruling 30)", async () => {
    const createConfigurationVersion = vi
      .spyOn(apiClient, "createConfigurationVersion")
      .mockResolvedValue({ version: CREATED });
    act(() => useEditorStore.getState().setSaving(true));
    const { user } = renderDialog();
    const open = await dialog();

    expect(within(open).getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(within(open).getByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.type(field(), "While saving{Enter}");
    expect(createConfigurationVersion).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Copy Version" })).toBeInTheDocument();

    act(() => useEditorStore.getState().setSaving(false));
    expect(within(open).getByRole("button", { name: "Continue" })).toBeEnabled();
    await user.click(within(open).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createConfigurationVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a server error", new ApiError("internal_error", "Something went wrong. Please try again."), CREATE_VERSION_FAILED_MESSAGE],
    ["a deleted configuration", new ApiError("configuration_not_found", "Configuration not found"), DELETED_MESSAGE],
    ["another organization", new ApiError("organization_not_found", "Organization not found"), OTHER_ORGANIZATION_MESSAGE],
  ])("on %s: toasts its message, keeps the dialog open with the name typed and focused, and the editor its text", async (_why, failure, message) => {
    vi.spyOn(apiClient, "createConfigurationVersion").mockRejectedValue(failure);
    const error = vi.spyOn(toast, "error");
    const { user } = renderDialog();
    const open = await dialog();

    await user.type(field(), "Add tail sampling");
    await user.click(within(open).getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith(message));
    expect(screen.getByRole("dialog", { name: "Copy Version" })).toBeInTheDocument();
    expect(field()).toHaveValue("Add tail sampling");
    expect(within(open).getByRole("button", { name: "Continue" })).toBeEnabled();
    // Back in the field, from Continue, which was disabled meanwhile (D10 Ruling 44).
    await waitFor(() => expect(field()).toHaveFocus());
    expect(useEditorStore.getState().version).toEqual(SOURCE);
    expect(useEditorStore.getState().text).toBe(EDITED_YAML);
    expect(address()).toBe(`/editor/${MINE.id}/${SOURCE.id}`);
  });

  it("the terms: no toast, the dialog open with the name typed", async () => {
    vi.spyOn(apiClient, "createConfigurationVersion").mockRejectedValue(
      new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
    );
    const error = vi.spyOn(toast, "error");
    const { user, loader } = renderDialog();
    const open = await dialog();
    const loadsBefore = loader.mock.calls.length;

    await user.type(field(), "Add tail sampling");
    await user.click(within(open).getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
    expect(error).not.toHaveBeenCalled();
    expect(field()).toHaveValue("Add tail sampling");
  });

  it("text too large is refused before sending, with the save's message, the dialog open", async () => {
    const createConfigurationVersion = vi.spyOn(apiClient, "createConfigurationVersion");
    const error = vi.spyOn(toast, "error");
    useEditorStore.getState().setText("x".repeat(262_145));
    const { user } = renderDialog();
    const open = await dialog();

    await user.click(within(open).getByRole("button", { name: "Continue" }));

    expect(error).toHaveBeenCalledWith(TOO_LARGE_MESSAGE);
    expect(createConfigurationVersion).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Copy Version" })).toBeInTheDocument();
  });

  it("Cancel closes it, sending nothing; reopened, the field is empty again", async () => {
    const createConfigurationVersion = vi.spyOn(apiClient, "createConfigurationVersion");
    const { user } = renderDialog();
    const open = await dialog();
    await user.type(field(), "Abandoned");

    await user.click(within(open).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await dialog();

    expect(field()).toHaveValue("");
    expect(createConfigurationVersion).not.toHaveBeenCalled();
  });
});
