import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet, createRoutesStub } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_PREFERENCES,
  EDITOR_FONT_SIZES,
  EDITOR_TAB_SIZES,
  type EditorPreferences,
  type UserPreferences,
} from "@telflo/contracts";
import { EditorPreferencesSection, FONT_SIZE_ITEMS, TAB_SIZE_ITEMS } from "./EditorPreferencesSection.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { PREFERENCES_FAILED_MESSAGE } from "~/lib/preferences.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import { signedInMember } from "~/test/configurations.js";

/*
 * Settings › Editor: its words; each control saves its own key,
 * optimistically; a failure restores that key alone; an earlier answer never
 * overwrites a later choice.
 */

/** A promise answered by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function withEditor(editor: Partial<EditorPreferences>): UserPreferences {
  return { ...DEFAULT_USER_PREFERENCES, editor: { ...DEFAULT_USER_PREFERENCES.editor, ...editor } };
}

/** Editor under the signed-in layout, the store seeded as the layout's effect does. */
async function renderEditor(editor: Partial<EditorPreferences> = {}) {
  const member = { ...signedInMember(), preferences: withEditor(editor) };
  useUserStore.getState().setCurrent(member);
  const Stub = createRoutesStub([
    {
      id: "routes/app-layout",
      Component: Outlet,
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser: member }),
      HydrateFallback: () => null,
      children: [{ path: "/settings/editor", Component: EditorPreferencesSection }],
    },
  ]);
  render(<Stub initialEntries={["/settings/editor"]} />);
  await screen.findByRole("heading", { name: "Editor Preferences" });
  return userEvent.setup();
}

const tabSize = () => screen.getByRole("combobox", { name: "YAML Indentation" });
const fontSize = () => screen.getByRole("combobox", { name: "Font Size" });
const lineNumbers = () => screen.getByRole("switch", { name: "Show Line Numbers" });
const minimap = () => screen.getByRole("switch", { name: "Show Minimap" });
const shown = () => useUserStore.getState().current?.preferences.editor;

describe("EditorPreferencesSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("shows its words and the person's preferences", async () => {
    await renderEditor({ tabSize: 4, fontSize: 16, lineNumbers: false, minimap: true });
    expect(screen.getByText("Customize the editor experience")).toBeInTheDocument();
    expect(tabSize()).toHaveTextContent("4 spaces");
    expect(tabSize()).toHaveAccessibleDescription("Number of spaces for indentation");
    expect(fontSize()).toHaveTextContent("16px");
    expect(fontSize()).toHaveAccessibleDescription("Text size in the YAML editor");
    expect(lineNumbers()).not.toBeChecked();
    expect(lineNumbers()).toHaveAccessibleDescription("Display line numbers in the editor");
    expect(minimap()).toBeChecked();
    expect(minimap()).toHaveAccessibleDescription("Display a minimap preview on the right side");
  });

  it("each control saves its own key", async () => {
    const updatePreferences = vi
      .spyOn(apiClient, "updatePreferences")
      .mockImplementation((request) => Promise.resolve(withEditor({ ...shown(), ...request.editor } as EditorPreferences)));
    const success = vi.spyOn(toast, "success");
    const user = await renderEditor();

    await user.click(tabSize());
    await user.click(await screen.findByRole("option", { name: "4 spaces" }));
    await user.click(fontSize());
    await user.click(await screen.findByRole("option", { name: "18px" }));
    await user.click(lineNumbers());
    await user.click(minimap());

    expect(updatePreferences.mock.calls.map(([request]) => request)).toEqual([
      { editor: { tabSize: 4 } },
      { editor: { fontSize: 18 } },
      { editor: { lineNumbers: false } },
      { editor: { minimap: true } },
    ]);
    await waitFor(() => expect(useUserStore.getState().pendingPreferences).toEqual({}));
    expect(shown()).toEqual({ tabSize: 4, fontSize: 18, lineNumbers: false, minimap: true });
    expect(tabSize()).toHaveTextContent("4 spaces");
    expect(fontSize()).toHaveTextContent("18px");
    expect(lineNumbers()).not.toBeChecked();
    expect(minimap()).toBeChecked();
    expect(success).not.toHaveBeenCalled();
  });

  it("a failure restores only that key", async () => {
    const fontSave = held<UserPreferences>();
    const minimapSave = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences")
      .mockReturnValueOnce(fontSave.promise)
      .mockReturnValueOnce(minimapSave.promise);
    const error = vi.spyOn(toast, "error");
    const user = await renderEditor();

    await user.click(fontSize());
    await user.click(await screen.findByRole("option", { name: "20px" }));
    await user.click(minimap());
    expect(shown()).toEqual({ ...DEFAULT_USER_PREFERENCES.editor, fontSize: 20, minimap: true });

    fontSave.reject(new ApiError("network_error", "Could not reach the server. Check your connection."));
    await waitFor(() => expect(fontSize()).toHaveTextContent("13px"));
    expect(minimap()).toBeChecked();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(PREFERENCES_FAILED_MESSAGE);

    minimapSave.resolve(withEditor({ minimap: true }));
    await waitFor(() => expect(useUserStore.getState().pendingPreferences).toEqual({}));
    expect(shown()).toEqual({ ...DEFAULT_USER_PREFERENCES.editor, minimap: true });
  });

  it("the Select's values are the numbers", async () => {
    expect(TAB_SIZE_ITEMS).toEqual(EDITOR_TAB_SIZES.map((size) => ({ value: String(size), label: `${size} spaces` })));
    expect(FONT_SIZE_ITEMS).toEqual(EDITOR_FONT_SIZES.map((size) => ({ value: String(size), label: `${size}px` })));
    expect(FONT_SIZE_ITEMS.map((item) => item.label)).toEqual(["12px", "13px", "14px", "15px", "16px", "18px", "20px"]);

    const updatePreferences = vi
      .spyOn(apiClient, "updatePreferences")
      .mockImplementation((request) => Promise.resolve(withEditor({ ...shown(), ...request.editor } as EditorPreferences)));
    const user = await renderEditor({ fontSize: 12 });

    await user.click(tabSize());
    const tabOptions = await screen.findAllByRole("option");
    expect(tabOptions.map((option) => option.textContent)).toEqual(["2 spaces", "4 spaces"]);
    await user.click(tabOptions[1]!);

    // Each font size, chosen in turn, is sent as its number.
    for (const size of EDITOR_FONT_SIZES.filter((each) => each !== 12)) {
      await user.click(fontSize());
      await user.click(await screen.findByRole("option", { name: `${size}px` }));
    }
    expect(updatePreferences.mock.calls.map(([request]) => request)).toEqual([
      { editor: { tabSize: 4 } },
      ...EDITOR_FONT_SIZES.filter((each) => each !== 12).map((size) => ({ editor: { fontSize: size } })),
    ]);
  });

  it("two quick choices of one key: the earlier answer doesn't overwrite the later choice", async () => {
    const first = held<UserPreferences>();
    const second = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const user = await renderEditor();

    await user.click(fontSize());
    await user.click(await screen.findByRole("option", { name: "14px" }));
    await user.click(fontSize());
    await user.click(await screen.findByRole("option", { name: "16px" }));
    expect(fontSize()).toHaveTextContent("16px");

    // The first choice's answer arrives after the second choice: it says 14, and is not taken.
    // The save awaits this same promise and was first to: its answer is handled once this await returns.
    await act(async () => {
      first.resolve(withEditor({ fontSize: 14 }));
      await first.promise;
    });
    expect(shown()?.fontSize).toBe(16);
    expect(fontSize()).toHaveTextContent("16px");

    second.resolve(withEditor({ fontSize: 16 }));
    await waitFor(() => expect(useUserStore.getState().pendingPreferences).toEqual({}));
    expect(shown()?.fontSize).toBe(16);
    expect(useUserStore.getState().confirmedPreferences?.editor.fontSize).toBe(16);
  });
});
