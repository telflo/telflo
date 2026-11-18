import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Configuration } from "@telflo/contracts";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorToolbar, RENAMED_MESSAGE, RENAME_FAILED_MESSAGE } from "./EditorToolbar.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

const VERSION = versionFixture({ yamlContent: "receivers: {}\n" });

const initialState = useEditorStore.getState();

/** The toolbar over MINE, loaded in the group organization, with a loader to count revalidations. */
function renderToolbar() {
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  const onSave = vi.fn();
  const loader = vi.fn(() => null);
  const Stub = createRoutesStub([
    { path: "/editor", Component: () => <EditorToolbar onSave={onSave} />, loader, HydrateFallback: () => null },
  ]);
  render(<Stub initialEntries={["/editor"]} />);
  return { onSave, loader, user: userEvent.setup() };
}

/** Opens the rename field from the pencil; the field is named by its fixed label. */
async function openRename(user: ReturnType<typeof userEvent.setup>): Promise<HTMLInputElement> {
  await user.click(await screen.findByRole("button", { name: "Rename configuration" }));
  return screen.getByRole("textbox", { name: "Configuration name" }) as HTMLInputElement;
}

/** A rename that answers with the configuration renamed as asked. */
function acceptRenames() {
  return vi
    .spyOn(apiClient, "updateConfiguration")
    .mockImplementation(async (_organizationId, _configurationId, { name }) => ({
      configuration: { ...MINE, name: name ?? MINE.name } satisfies Configuration,
    }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
});

describe("EditorToolbar", () => {
  it("shows the name as text only, with its classes and no title (ADR 0024)", async () => {
    renderToolbar();

    const name = await screen.findByRole("heading", { level: 1, name: "Production Monitoring" });
    expect(name).toHaveClass("max-w-[28vw]", "truncate", "text-sm", "font-semibold");
    expect(name).not.toHaveAttribute("title");
    expect(name.closest(".h-12")).toHaveClass("bg-card", "border-b");
  });

  it("puts the version picker first in the actions, then a divider, then Undo (D10 decision 10)", async () => {
    renderToolbar();

    const picker = await screen.findByRole("combobox", { name: /^Version:/ });
    const actions = document.querySelector('[data-tour-step="toolbar-actions"]')!;
    const wrapper = picker.closest('[data-tour-step="version-select"]')!;
    expect(wrapper.parentElement).toBe(actions);
    expect(actions.firstElementChild).toBe(wrapper);
    expect(wrapper.nextElementSibling).toHaveClass("w-px", "h-5", "bg-border");
    expect(wrapper.nextElementSibling!.nextElementSibling!.querySelector("button")).toHaveAccessibleName("Undo (Ctrl+Z)");
    expect(picker).toHaveTextContent("v1: Version 1");
  });

  it("labels the pencil, which shows on hover and on keyboard focus", async () => {
    renderToolbar();

    const pencil = await screen.findByRole("button", { name: "Rename configuration" });
    expect(pencil).toHaveClass("opacity-0", "group-hover:opacity-100", "focus-visible:opacity-100");
    expect(pencil).not.toHaveAttribute("title");
  });

  describe("the Unsaved badge and Save", () => {
    it("shows no badge, and disables Save, while clean", async () => {
      const { onSave } = renderToolbar();

      const save = await screen.findByRole("button", { name: "Save" });
      expect(save).toBeDisabled();
      expect(screen.queryByText("Unsaved")).toBeNull();
      fireEvent.click(save);
      expect(onSave).not.toHaveBeenCalled();
    });

    it("shows the badge, and enables Save, once the text differs from the saved text; typing back clears both", async () => {
      const { onSave, user } = renderToolbar();
      const save = await screen.findByRole("button", { name: "Save" });

      act(() => useEditorStore.getState().setText("receivers: {}\nexporters: {}\n"));

      // Awaited: the route's loader mounts the toolbar outside act, so its
      // store subscription (a passive effect) can come after the change on a
      // busy machine; it then re-renders from the store's current state.
      expect(await screen.findByText("Unsaved")).toBeInTheDocument();
      expect(save).toBeEnabled();
      await user.click(save);
      expect(onSave).toHaveBeenCalledTimes(1);

      act(() => useEditorStore.getState().setText(VERSION.yamlContent));
      expect(screen.queryByText("Unsaved")).toBeNull();
      expect(save).toBeDisabled();
    });

    it("disables Save while a save is under way, and keeps the badge", async () => {
      renderToolbar();
      const save = await screen.findByRole("button", { name: "Save" });
      act(() => useEditorStore.getState().setText("changed: true\n"));
      // Enabled once dirty; awaited for the same reason as above.
      await waitFor(() => expect(save).toBeEnabled());

      act(() => useEditorStore.getState().setSaving(true));

      expect(save).toBeDisabled();
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
    });
  });

  describe("renaming (D8 decision 14)", () => {
    it("opens the field from the pencil, with the name, focused, at the name's size", async () => {
      const { user } = renderToolbar();

      const field = await openRename(user);

      expect(field).toHaveValue("Production Monitoring");
      expect(field).toHaveFocus();
      expect(field).toHaveAttribute("maxlength", "200");
      // A fixed label, never the name (ADR 0024: attributes aren't masked in replay).
      expect(field).toHaveAttribute("aria-label", "Configuration name");
      expect(field).toHaveClass("h-7");
      // 9 px a character, from 180 to 420 px: "Production Monitoring" is 21.
      expect(field.style.width).toBe("189px");
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();

      await user.clear(field);
      expect(field.style.width).toBe("180px");
      await user.type(field, "A".repeat(30));
      expect(field.style.width).toBe("270px");
      await user.type(field, "A".repeat(100));
      expect(field.style.width).toBe("420px");
    });

    it("saves the trimmed name on Enter, in the organization it was loaded in, and toasts its message", async () => {
      const updateConfiguration = acceptRenames();
      const success = vi.spyOn(toast, "success");
      const { user } = renderToolbar();
      const field = await openRename(user);

      await user.clear(field);
      await user.type(field, "  Renamed pipeline  {Enter}");

      expect(await screen.findByRole("heading", { level: 1, name: "Renamed pipeline" })).toBeInTheDocument();
      expect(updateConfiguration).toHaveBeenCalledTimes(1);
      expect(updateConfiguration).toHaveBeenCalledWith(GROUP_ID, MINE.id, { name: "Renamed pipeline" });
      expect(useEditorStore.getState().configuration?.name).toBe("Renamed pipeline");
      expect(success).toHaveBeenCalledWith("Configuration updated");
      expect(RENAMED_MESSAGE).toBe("Configuration updated");
      expect(screen.queryByRole("textbox")).toBeNull();
    });

    it("saves on blur", async () => {
      const updateConfiguration = acceptRenames();
      const { user } = renderToolbar();
      const field = await openRename(user);

      await user.clear(field);
      await user.type(field, "Blurred");
      act(() => field.blur());

      expect(await screen.findByRole("heading", { level: 1, name: "Blurred" })).toBeInTheDocument();
      expect(updateConfiguration).toHaveBeenCalledWith(GROUP_ID, MINE.id, { name: "Blurred" });
    });

    it("renames once for Enter and the blur after it", async () => {
      let finish!: () => void;
      const updateConfiguration = vi.spyOn(apiClient, "updateConfiguration").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ configuration: { ...MINE, name: "Once" } });
          }),
      );
      const { user } = renderToolbar();
      const field = await openRename(user);
      await user.clear(field);
      await user.type(field, "Once{Enter}");

      act(() => field.blur());
      await act(async () => finish());

      expect(await screen.findByRole("heading", { level: 1, name: "Once" })).toBeInTheDocument();
      expect(updateConfiguration).toHaveBeenCalledTimes(1);
    });

    it("cancels on Escape, sending nothing and keeping the name", async () => {
      const updateConfiguration = vi.spyOn(apiClient, "updateConfiguration");
      const { user } = renderToolbar();
      const field = await openRename(user);

      await user.clear(field);
      await user.type(field, "Abandoned{Escape}");

      expect(screen.getByRole("heading", { level: 1, name: "Production Monitoring" })).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(updateConfiguration).not.toHaveBeenCalled();

      // Reopening starts from the name, not the abandoned text.
      expect(await openRename(user)).toHaveValue("Production Monitoring");
    });

    it("keeps editing a blank name, and sends nothing", async () => {
      const updateConfiguration = vi.spyOn(apiClient, "updateConfiguration");
      const { user } = renderToolbar();
      const field = await openRename(user);

      await user.clear(field);
      await user.type(field, "   {Enter}");

      expect(screen.getByRole("textbox")).toHaveValue("   ");
      expect(updateConfiguration).not.toHaveBeenCalled();
    });

    it("sends nothing for an unchanged name, spaces around it included, and closes the field", async () => {
      const updateConfiguration = vi.spyOn(apiClient, "updateConfiguration");
      const success = vi.spyOn(toast, "success");
      const { user } = renderToolbar();
      const field = await openRename(user);

      await user.clear(field);
      await user.type(field, "  Production Monitoring {Enter}");

      expect(screen.getByRole("heading", { level: 1, name: "Production Monitoring" })).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(updateConfiguration).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
    });

    it("toasts the refusal's message on a failure, and keeps the field open with what was typed", async () => {
      vi.spyOn(apiClient, "updateConfiguration").mockRejectedValue(
        new ApiError("configuration_not_found", "Configuration not found"),
      );
      const error = vi.spyOn(toast, "error");
      const { user, loader } = renderToolbar();
      const field = await openRename(user);
      const loadsBefore = loader.mock.calls.length;

      await user.clear(field);
      await user.type(field, "Kept as typed{Enter}");

      await waitFor(() => expect(error).toHaveBeenCalledWith("Configuration not found"));
      expect(screen.getByRole("textbox")).toHaveValue("Kept as typed");
      expect(useEditorStore.getState().configuration?.name).toBe("Production Monitoring");
      expect(loader.mock.calls.length).toBe(loadsBefore);
    });

    it.each([
      ["a server error", new ApiError("internal_error", "Something went wrong. Please try again.")],
      ["an invalid request", new ApiError("invalid_request", "The request was not valid.")],
      ["no connection", new ApiError("network_error", "Could not reach the server. Check your connection.")],
    ])('toasts "Failed to update configuration" for %s, and keeps the field', async (_why, failure) => {
      vi.spyOn(apiClient, "updateConfiguration").mockRejectedValue(failure);
      const error = vi.spyOn(toast, "error");
      const { user } = renderToolbar();
      const field = await openRename(user);

      await user.clear(field);
      await user.type(field, "Still here{Enter}");

      await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to update configuration"));
      expect(RENAME_FAILED_MESSAGE).toBe("Failed to update configuration");
      expect(screen.getByRole("textbox")).toHaveValue("Still here");
    });

    it.each([
      ["404 organization_not_found", new ApiError("organization_not_found", "Organization not found")],
      [
        "403 terms_acceptance_required",
        new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue."),
      ],
    ])("on a %s, toasts it, keeps the field and revalidates the layout", async (_why, failure) => {
      vi.spyOn(apiClient, "updateConfiguration").mockRejectedValue(failure);
      const error = vi.spyOn(toast, "error");
      const { user, loader } = renderToolbar();
      const field = await openRename(user);
      const loadsBefore = loader.mock.calls.length;

      await user.clear(field);
      await user.type(field, "Elsewhere{Enter}");

      await waitFor(() => expect(loader.mock.calls.length).toBe(loadsBefore + 1));
      expect(error).toHaveBeenCalledWith(failure.message);
      expect(screen.getByRole("textbox")).toHaveValue("Elsewhere");
    });
  });
});
