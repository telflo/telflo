import type { Monaco } from "@monaco-editor/react";
import type { Theme } from "@telflo/contracts";
import type { editor } from "monaco-editor";

/*
 * The Dark and Navy Monaco themes, and the mapping from the app's theme:
 * Dark → telflo-dark, Navy → telflo-navy (D21 decisions 2 and 27). Light →
 * Monaco's own light theme, `vs`, unchanged: the owner's Q128 (2026-10-23,
 * during the walkthrough) amends Q124 for Light, so no dark-surfaced
 * telflo-light (#262d38) is defined here.
 * Monaco's theme is global, so every open editor switches together. Type
 * imports only: nothing here loads Monaco.
 */

/** Monaco's built-in light theme (Q128). */
export const MONACO_LIGHT_THEME = "vs";
export const TELFLO_DARK_THEME = "telflo-dark";
export const TELFLO_NAVY_THEME = "telflo-navy";

export type TelfloMonacoTheme = typeof MONACO_LIGHT_THEME | typeof TELFLO_DARK_THEME | typeof TELFLO_NAVY_THEME;

// Carbon-matched editor themes (values mirror the app.css token layer).
const telfloDark: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "type", foreground: "8fb5f4" },
    { token: "string.yaml", foreground: "9ec7a8" },
    { token: "number", foreground: "d6a03f" },
    { token: "keyword", foreground: "a685ea" },
    { token: "comment", foreground: "6a7280" },
  ],
  colors: {
    "editor.background": "#14181d",
    "editor.foreground": "#e9ebee",
    "editor.lineHighlightBackground": "#1d232a",
    "editorLineNumber.foreground": "#525c68",
    "editorLineNumber.activeForeground": "#98a1ac",
    "editorIndentGuide.background1": "#262c34",
    "editorIndentGuide.activeBackground1": "#3a424c",
    "editor.selectionBackground": "#2364d240",
    "editorCursor.foreground": "#e9ebee",
    "editorWidget.background": "#1b2027",
    "editorWidget.border": "#262c34",
    "scrollbarSlider.background": "#2a303880",
    "scrollbarSlider.hoverBackground": "#2a3038",
    "minimap.background": "#14181d",
  },
};

// Navy gets a deeper blue-cast code surface to match the navy shell.
const telfloNavy: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "type", foreground: "8fb5f4" },
    { token: "string.yaml", foreground: "9ec7a8" },
    { token: "number", foreground: "d6a03f" },
    { token: "keyword", foreground: "a685ea" },
    { token: "comment", foreground: "6b7b93" },
  ],
  colors: {
    "editor.background": "#0f1a2e",
    "editor.foreground": "#e5eaf2",
    "editor.lineHighlightBackground": "#16233a",
    "editorLineNumber.foreground": "#4a5a76",
    "editorLineNumber.activeForeground": "#8b98ae",
    "editorIndentGuide.background1": "#23324c",
    "editorIndentGuide.activeBackground1": "#35486a",
    "editor.selectionBackground": "#2364d240",
    "editorCursor.foreground": "#e5eaf2",
    "editorWidget.background": "#16233a",
    "editorWidget.border": "#23324c",
    "scrollbarSlider.background": "#23324c80",
    "scrollbarSlider.hoverBackground": "#23324c",
    "minimap.background": "#0f1a2e",
  },
};

/** The Monaco theme for the app's theme (Light → `vs`, Q128). */
export function monacoThemeFor(theme: Theme): TelfloMonacoTheme {
  switch (theme) {
    case "dark":
      return TELFLO_DARK_THEME;
    case "navy":
      return TELFLO_NAVY_THEME;
    case "light":
      return MONACO_LIGHT_THEME;
  }
}

/** Defines the editor's two telflo themes on Monaco, before the editor mounts (Light's `vs` is built in). */
export function defineTelfloThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(TELFLO_DARK_THEME, telfloDark);
  monaco.editor.defineTheme(TELFLO_NAVY_THEME, telfloNavy);
}
