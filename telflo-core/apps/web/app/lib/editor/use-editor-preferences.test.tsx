import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES, type EditorPreferences, type Theme } from "@telflo/contracts";
import { applyModelOptions, useEditorPreferences, type TabSizeTarget } from "./use-editor-preferences.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { signedInMember } from "~/test/configurations.js";

/** A Monaco model that keeps the options set on it, as Monaco's does. */
function fakeModel() {
  const options: Record<string, unknown> = { tabSize: 2, indentSize: 2, insertSpaces: true };
  return { options, updateOptions: (next: Record<string, unknown>) => void Object.assign(options, next) };
}

/** A code editor holding `model`; `dispose()` fires its `onDidDispose` listeners, as Monaco's dispose does. */
function codeEditor(model: ReturnType<typeof fakeModel> | null): TabSizeTarget & { dispose: () => void } {
  const listeners: (() => void)[] = [];
  return {
    getModel: () => model,
    onDidDispose: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    dispose: () => listeners.forEach((listener) => listener()),
  } as unknown as TabSizeTarget & { dispose: () => void };
}

/** The user store holding the member with `theme` and `editor` (Settings' choices). */
function choose(theme: Theme, editor: Partial<EditorPreferences> = {}) {
  const member = signedInMember();
  useUserStore.getState().setCurrent({
    ...member,
    preferences: { ...member.preferences, theme, editor: { ...DEFAULT_USER_PREFERENCES.editor, ...editor } },
  });
}

describe("applyModelOptions", () => {
  it("sets the tab size and the indent size on an open editor's model, and nothing else", () => {
    const model = fakeModel();
    applyModelOptions(codeEditor(model), 4);
    expect(model.options).toEqual({ tabSize: 4, indentSize: 4, insertSpaces: true });
  });

  it("sets both of Compare's models", () => {
    const original = fakeModel();
    const modified = fakeModel();
    applyModelOptions({ getModel: () => ({ original, modified }) } as unknown as TabSizeTarget, 4);
    expect(original.options).toMatchObject({ tabSize: 4, indentSize: 4 });
    expect(modified.options).toMatchObject({ tabSize: 4, indentSize: 4 });
  });

  it("does nothing without an editor or a model", () => {
    expect(() => applyModelOptions(null, 4)).not.toThrow();
    expect(() => applyModelOptions(codeEditor(null), 4)).not.toThrow();
  });
});

describe("useEditorPreferences", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  it("is contracts' defaults and Dark's theme before the user store is seeded", () => {
    const { result } = renderHook(() => useEditorPreferences());
    expect(result.current.theme).toBe("telflo-dark");
    expect(result.current.tabSize).toBe(DEFAULT_USER_PREFERENCES.editor.tabSize);
    expect(result.current.options).toEqual({ fontSize: 13, lineNumbers: "on", minimap: { enabled: false } });
  });

  it("takes the theme and all four preferences from the store", () => {
    choose("navy", { tabSize: 4, fontSize: 20, lineNumbers: false, minimap: true });
    const { result } = renderHook(() => useEditorPreferences());
    expect(result.current.theme).toBe("telflo-navy");
    expect(result.current.tabSize).toBe(4);
    expect(result.current.options).toEqual({ fontSize: 20, lineNumbers: "off", minimap: { enabled: true } });
  });

  it("sets the tab size on the attached model at once, and again when the preference changes", () => {
    choose("light", { tabSize: 4 });
    const model = fakeModel();
    const { result } = renderHook(() => useEditorPreferences());

    act(() => result.current.attach(codeEditor(model)));
    expect(model.options).toMatchObject({ tabSize: 4, indentSize: 4 });

    act(() => choose("light", { tabSize: 2 }));
    expect(model.options).toMatchObject({ tabSize: 2, indentSize: 2 });

    // The options keep their identity while only the tab size changes, so the editor isn't re-optioned for nothing.
    const options = result.current.options;
    act(() => choose("light", { tabSize: 4 }));
    expect(result.current.options).toBe(options);
    expect(model.options).toMatchObject({ tabSize: 4, indentSize: 4 });
  });

  it("lets go of a disposed editor: a later change reaches none of its models", () => {
    choose("light", { tabSize: 4 });
    const model = fakeModel();
    const editor = codeEditor(model);
    const { result } = renderHook(() => useEditorPreferences());
    act(() => result.current.attach(editor));
    expect(model.options).toMatchObject({ tabSize: 4, indentSize: 4 });

    editor.dispose();
    act(() => choose("light", { tabSize: 2 }));
    expect(model.options).toMatchObject({ tabSize: 4, indentSize: 4 });
  });

  it("an older editor's dispose keeps the newer one attached", () => {
    choose("light", { tabSize: 4 });
    const older = codeEditor(fakeModel());
    const newerModel = fakeModel();
    const newer = codeEditor(newerModel);
    const { result } = renderHook(() => useEditorPreferences());
    act(() => result.current.attach(older));
    act(() => result.current.attach(newer));

    older.dispose();
    act(() => choose("light", { tabSize: 2 }));
    expect(newerModel.options).toMatchObject({ tabSize: 2, indentSize: 2 });
  });
});
