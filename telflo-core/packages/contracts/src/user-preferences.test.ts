import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_PREFERENCES,
  EDITOR_FONT_SIZES,
  EDITOR_TAB_SIZES,
  readStoredPreferences,
  THEME_COOKIE_NAME,
  themeFromCookie,
  THEMES,
  UpdateUserPreferencesRequestSchema,
  UserPreferencesSchema,
  type UserPreferences,
} from "./user-preferences.js";

// A person's preferences (D21 decisions 17 and 19): one strict shape, its
// defaults, the PATCH's strict deep partial, and the read that never fails.

/** A fresh, mutable copy of the defaults. */
function defaults(): UserPreferences {
  return structuredClone({
    theme: DEFAULT_USER_PREFERENCES.theme,
    editor: { ...DEFAULT_USER_PREFERENCES.editor },
    email: { ...DEFAULT_USER_PREFERENCES.email },
  });
}

describe("UserPreferencesSchema", () => {
  it("the defaults pass the schema", () => {
    expect(UserPreferencesSchema.parse(DEFAULT_USER_PREFERENCES)).toEqual({
      theme: "dark",
      editor: { tabSize: 2, fontSize: 13, lineNumbers: true, minimap: false },
      email: { productUpdates: true, productTips: true },
    });
    expect(Object.isFrozen(DEFAULT_USER_PREFERENCES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_USER_PREFERENCES.editor)).toBe(true);
    expect(Object.isFrozen(DEFAULT_USER_PREFERENCES.email)).toBe(true);
  });

  it("the schema refuses a font size of 17 or 19, a tab size of 3, an unknown theme and any unknown key at each level", () => {
    const refused: Array<[string, (value: UserPreferences & Record<string, unknown>) => void]> = [
      ["a font size of 17", (value) => Object.assign(value.editor, { fontSize: 17 })],
      ["a font size of 19", (value) => Object.assign(value.editor, { fontSize: 19 })],
      ["a font size as text", (value) => Object.assign(value.editor, { fontSize: "13" })],
      ["a tab size of 3", (value) => Object.assign(value.editor, { tabSize: 3 })],
      ["an unknown theme", (value) => Object.assign(value, { theme: "system" })],
      ["a theme in capitals", (value) => Object.assign(value, { theme: "Dark" })],
      ["an unknown top-level key", (value) => Object.assign(value, { autoSave: true })],
      ["an unknown editor key", (value) => Object.assign(value.editor, { wordWrap: true })],
      ["an unknown email key", (value) => Object.assign(value.email, { security: true })],
      ["a missing key", (value) => Reflect.deleteProperty(value.email, "productTips")],
      ["a switch as text", (value) => Object.assign(value.editor, { minimap: "true" })],
    ];
    for (const [label, change] of refused) {
      const value = defaults() as UserPreferences & Record<string, unknown>;
      change(value);
      expect(UserPreferencesSchema.safeParse(value).success, label).toBe(false);
    }
  });

  it("takes every listed theme, tab size and font size", () => {
    expect(THEMES).toEqual(["light", "dark", "navy"]);
    expect(EDITOR_TAB_SIZES).toEqual([2, 4]);
    expect(EDITOR_FONT_SIZES).toEqual([12, 13, 14, 15, 16, 18, 20]);
    for (const theme of THEMES) {
      expect(UserPreferencesSchema.safeParse({ ...defaults(), theme }).success, theme).toBe(true);
    }
    for (const tabSize of EDITOR_TAB_SIZES) {
      const value = defaults();
      value.editor.tabSize = tabSize;
      expect(UserPreferencesSchema.safeParse(value).success, String(tabSize)).toBe(true);
    }
    for (const fontSize of EDITOR_FONT_SIZES) {
      const value = defaults();
      value.editor.fontSize = fontSize;
      expect(UserPreferencesSchema.safeParse(value).success, String(fontSize)).toBe(true);
    }
  });
});

describe("UpdateUserPreferencesRequestSchema", () => {
  it("the PATCH schema refuses an empty body, an empty group and an unknown key, and accepts each single key", () => {
    const refused: Array<[string, unknown]> = [
      ["an empty body", {}],
      ["an empty editor group", { editor: {} }],
      ["an empty email group", { email: {} }],
      ["an empty group beside a theme", { theme: "light", editor: {} }],
      ["an unknown top-level key", { autoSave: true }],
      ["an unknown editor key", { editor: { wordWrap: true } }],
      ["an unknown email key", { email: { security: false } }],
      ["an unknown value", { editor: { fontSize: 17 } }],
      ["an unknown theme", { theme: "system" }],
      ["a null theme", { theme: null }],
      ["a null group", { editor: null }],
      ["not an object", "dark"],
    ];
    for (const [label, body] of refused) {
      expect(UpdateUserPreferencesRequestSchema.safeParse(body).success, label).toBe(false);
    }

    const accepted: unknown[] = [
      { theme: "light" },
      { theme: "dark" },
      { theme: "navy" },
      { editor: { tabSize: 4 } },
      { editor: { fontSize: 20 } },
      { editor: { lineNumbers: false } },
      { editor: { minimap: true } },
      { email: { productUpdates: false } },
      { email: { productTips: false } },
    ];
    for (const body of accepted) {
      const parsed = UpdateUserPreferencesRequestSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(body)).toBe(true);
      expect(parsed.data).toEqual(body);
    }
  });

  it("accepts several keys and groups together", () => {
    const body = { theme: "navy", editor: { tabSize: 4, minimap: true }, email: { productTips: false } };
    expect(UpdateUserPreferencesRequestSchema.parse(body)).toEqual(body);
  });
});

describe("readStoredPreferences", () => {
  it("readStoredPreferences fills each missing or invalid key with its default and keeps every valid one", () => {
    const saved = {
      editor: { tabSize: 4, fontSize: 18, lineNumbers: false, minimap: true },
      email: { productUpdates: false, productTips: false },
    };
    // Every valid key is kept.
    expect(readStoredPreferences("navy", saved)).toEqual({ theme: "navy", ...saved });

    // Each key on its own: an invalid value gets that key's default, and the
    // six others keep their stored values.
    const invalid: Array<["editor" | "email", string, unknown]> = [
      ["editor", "tabSize", 3],
      ["editor", "fontSize", 17],
      ["editor", "lineNumbers", "false"],
      ["editor", "minimap", 1],
      ["email", "productUpdates", null],
      ["email", "productTips", "no"],
    ];
    for (const [group, key, value] of invalid) {
      const stored = structuredClone(saved) as Record<string, Record<string, unknown>>;
      stored[group]![key] = value;
      const expected = { theme: "light", ...structuredClone(saved) } as Record<string, unknown> & {
        editor: Record<string, unknown>;
        email: Record<string, unknown>;
      };
      expected[group][key] = (DEFAULT_USER_PREFERENCES[group] as Record<string, unknown>)[key];
      expect(readStoredPreferences("light", stored), `${group}.${key} invalid`).toEqual(expected);

      // The same key missing.
      const without = structuredClone(saved) as Record<string, Record<string, unknown>>;
      Reflect.deleteProperty(without[group]!, key);
      expect(readStoredPreferences("light", without), `${group}.${key} missing`).toEqual(expected);
    }

    // A group that isn't an object gets its whole default; the other group is kept.
    for (const notAnObject of [null, "x", 4, true, [], [{ tabSize: 4 }]]) {
      expect(readStoredPreferences("dark", { ...saved, editor: notAnObject }), JSON.stringify(notAnObject)).toEqual({
        theme: "dark",
        editor: DEFAULT_USER_PREFERENCES.editor,
        email: saved.email,
      });
      expect(readStoredPreferences("dark", { ...saved, email: notAnObject }), JSON.stringify(notAnObject)).toEqual({
        theme: "dark",
        editor: saved.editor,
        email: DEFAULT_USER_PREFERENCES.email,
      });
    }

    // A null jsonb, no row at all, or a stored value that isn't an object: every default.
    for (const stored of [null, undefined, "{}", 7, [], [saved]]) {
      expect(readStoredPreferences(undefined, stored), JSON.stringify(stored)).toEqual(DEFAULT_USER_PREFERENCES);
    }

    // An unknown theme is Dark; unknown keys are ignored, at both levels.
    for (const theme of ["system", "Dark", "", null, 1, undefined]) {
      expect(readStoredPreferences(theme, saved).theme, String(theme)).toBe("dark");
    }
    expect(
      readStoredPreferences("light", {
        autoSave: true,
        ai: { enabled: true },
        editor: { ...saved.editor, wordWrap: "on" },
        email: { ...saved.email, security: true },
      }),
    ).toEqual({ theme: "light", ...saved });
  });

  it("never throws, and returns a value the schema accepts and the caller may change", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.editor = Object.create({ tabSize: 4 });
    for (const stored of [hostile, { editor: { __proto__: { fontSize: 20 } } }, Symbol("x"), () => 1]) {
      const read = readStoredPreferences("navy", stored);
      expect(UserPreferencesSchema.safeParse(read).success).toBe(true);
      expect(read.editor).toEqual(DEFAULT_USER_PREFERENCES.editor);
    }
    const read = readStoredPreferences(undefined, undefined);
    expect(Object.isFrozen(read) || Object.isFrozen(read.editor) || Object.isFrozen(read.email)).toBe(false);
  });
});

describe("the theme cookie", () => {
  it("themeFromCookie reads the three words and gives dark for anything else", () => {
    expect(THEME_COOKIE_NAME).toBe("telflo_theme");
    expect(themeFromCookie("light")).toBe("light");
    expect(themeFromCookie("dark")).toBe("dark");
    expect(themeFromCookie("navy")).toBe("navy");
    const oversized = "navy".repeat(1_024);
    for (const value of [undefined, "", "Light", "Navy", "NAVY", " navy", "navy ", "system", "light,dark", "%6Cight", oversized]) {
      expect(themeFromCookie(value), String(value).slice(0, 16)).toBe("dark");
    }
  });
});
