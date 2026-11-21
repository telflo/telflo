import type { Monaco } from "@monaco-editor/react";
import { describe, expect, it } from "vitest";
import { defineTelfloThemes, monacoThemeFor } from "./monaco-themes.js";

/** The themes `defineTelfloThemes` defines, by name. */
function definedThemes(): Record<string, unknown> {
  const defined: Record<string, unknown> = {};
  defineTelfloThemes({ editor: { defineTheme: (name: string, data: unknown) => (defined[name] = data) } } as unknown as Monaco);
  return defined;
}

describe("Monaco's themes", () => {
  it("defines telflo-dark and telflo-navy with their pinned values, and nothing for Light", () => {
    // Pinned value for value.
    // Light uses Monaco's built-in `vs`: no telflo-light is defined.
    expect(definedThemes()).toMatchInlineSnapshot(`
      {
        "telflo-dark": {
          "base": "vs-dark",
          "colors": {
            "editor.background": "#14181d",
            "editor.foreground": "#e9ebee",
            "editor.lineHighlightBackground": "#1d232a",
            "editor.selectionBackground": "#2364d240",
            "editorCursor.foreground": "#e9ebee",
            "editorIndentGuide.activeBackground1": "#3a424c",
            "editorIndentGuide.background1": "#262c34",
            "editorLineNumber.activeForeground": "#98a1ac",
            "editorLineNumber.foreground": "#525c68",
            "editorWidget.background": "#1b2027",
            "editorWidget.border": "#262c34",
            "minimap.background": "#14181d",
            "scrollbarSlider.background": "#2a303880",
            "scrollbarSlider.hoverBackground": "#2a3038",
          },
          "inherit": true,
          "rules": [
            {
              "foreground": "8fb5f4",
              "token": "type",
            },
            {
              "foreground": "9ec7a8",
              "token": "string.yaml",
            },
            {
              "foreground": "d6a03f",
              "token": "number",
            },
            {
              "foreground": "a685ea",
              "token": "keyword",
            },
            {
              "foreground": "6a7280",
              "token": "comment",
            },
          ],
        },
        "telflo-navy": {
          "base": "vs-dark",
          "colors": {
            "editor.background": "#0f1a2e",
            "editor.foreground": "#e5eaf2",
            "editor.lineHighlightBackground": "#16233a",
            "editor.selectionBackground": "#2364d240",
            "editorCursor.foreground": "#e5eaf2",
            "editorIndentGuide.activeBackground1": "#35486a",
            "editorIndentGuide.background1": "#23324c",
            "editorLineNumber.activeForeground": "#8b98ae",
            "editorLineNumber.foreground": "#4a5a76",
            "editorWidget.background": "#16233a",
            "editorWidget.border": "#23324c",
            "minimap.background": "#0f1a2e",
            "scrollbarSlider.background": "#23324c80",
            "scrollbarSlider.hoverBackground": "#23324c",
          },
          "inherit": true,
          "rules": [
            {
              "foreground": "8fb5f4",
              "token": "type",
            },
            {
              "foreground": "9ec7a8",
              "token": "string.yaml",
            },
            {
              "foreground": "d6a03f",
              "token": "number",
            },
            {
              "foreground": "a685ea",
              "token": "keyword",
            },
            {
              "foreground": "6b7b93",
              "token": "comment",
            },
          ],
        },
      }
    `);
  });

  it("maps each app theme to its Monaco theme, Light to Monaco's own vs", () => {
    expect(monacoThemeFor("dark")).toBe("telflo-dark");
    expect(monacoThemeFor("navy")).toBe("telflo-navy");
    expect(monacoThemeFor("light")).toBe("vs");
  });
});
