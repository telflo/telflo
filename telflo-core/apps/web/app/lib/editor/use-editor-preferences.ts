import { DEFAULT_USER_PREFERENCES, type EditorTabSize } from "@telflo/contracts";
import type { editor } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { monacoThemeFor, type TelfloMonacoTheme } from "~/lib/editor/monaco-themes.js";
import { usePlaygroundVisitor } from "~/lib/playground/context.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useAppTheme } from "~/lib/theme.js";

/**
 * The options every Monaco takes from the person's editor preferences. The
 * tab size isn't one of them: it goes on the model (`applyModelOptions`).
 */
export type EditorPreferenceOptions = {
  fontSize: number;
  lineNumbers: "on" | "off";
  minimap: { enabled: boolean };
};

/**
 * An open editor whose model or models take the tab size: a code editor, or
 * Compare's diff editor. `onDidDispose` lets `attach` let go of it.
 */
export type TabSizeTarget =
  | Pick<editor.IStandaloneCodeEditor, "getModel" | "onDidDispose">
  | Pick<editor.IStandaloneDiffEditor, "getModel" | "onDidDispose">;

function isDiffModel(model: editor.ITextModel | editor.IDiffEditorModel): model is editor.IDiffEditorModel {
  return "original" in model && "modified" in model;
}

/**
 * Sets the tab size on an open editor's model, Compare's two alike: both the
 * width a tab shows and what Tab and a new level insert. Monaco's
 * `detectIndentation` stays at its default, but the width is set here
 * explicitly, so the text's own indentation never decides it and Monaco's
 * '[yaml]' default (2) doesn't win. Existing text keeps its indentation.
 * Nothing before the model exists, or after it's gone.
 */
export function applyModelOptions(target: TabSizeTarget | null, tabSize: EditorTabSize): void {
  const model = target?.getModel() ?? null;
  if (model === null) return;
  const options = { tabSize, indentSize: tabSize };
  if (isDiffModel(model)) {
    model.original.updateOptions(options);
    model.modified.updateOptions(options);
  } else {
    model.updateOptions(options);
  }
}

/** What `useEditorPreferences` gives a Monaco (contracts' `EditorPreferences` is the stored preferences). */
export type MonacoPreferences = {
  /** The Monaco theme for the app's theme. Global in Monaco: every open editor switches together. */
  theme: TelfloMonacoTheme;
  tabSize: EditorTabSize;
  /** For the editor's `options`; a change reaches the open editor through them. */
  options: EditorPreferenceOptions;
  /**
   * Call from the editor's `onMount`: the model takes the tab size now, and
   * again whenever the preference changes while it is open. Once the editor
   * is disposed it is let go, so a later change reaches none of its models
   * (Compare's are released as it closes, while the dialog stays mounted).
   */
  attach: (target: TabSizeTarget) => void;
};

/**
 * The person's editor preferences for a Monaco: the user store's (Settings
 * › Editor's optimistic choice included), or contracts' defaults before the
 * store is seeded; the defaults live only there. Reads no router hook: the
 * editors' tests render without a data router, and the editors mount only
 * on signed-in pages, where the store holds the person. Inside the
 * playground, the visitor's: the defaults, never a signed-in visitor's own.
 */
export function useEditorPreferences(): MonacoPreferences {
  const visitor = usePlaygroundVisitor();
  const stored = useUserStore((state) => state.current?.preferences.editor ?? DEFAULT_USER_PREFERENCES.editor);
  const preferences = visitor?.preferences.editor ?? stored;
  const theme = monacoThemeFor(useAppTheme());
  const { tabSize, fontSize, lineNumbers, minimap } = preferences;

  const options = useMemo<EditorPreferenceOptions>(
    () => ({ fontSize, lineNumbers: lineNumbers ? "on" : "off", minimap: { enabled: minimap } }),
    [fontSize, lineNumbers, minimap],
  );

  const target = useRef<TabSizeTarget | null>(null);
  const currentTabSize = useRef(tabSize);
  useEffect(() => {
    currentTabSize.current = tabSize;
    applyModelOptions(target.current, tabSize);
  }, [tabSize]);
  const attach = useCallback((mounted: TabSizeTarget) => {
    target.current = mounted;
    mounted.onDidDispose(() => {
      // Only this editor: a newer one attached since stays.
      if (target.current === mounted) target.current = null;
    });
    applyModelOptions(mounted, currentTabSize.current);
  }, []);

  return { theme, tabSize, options, attach };
}
