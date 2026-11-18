import { z } from "zod";

/**
 * A person's preferences (D21 decisions 17 and 19): the one place for their
 * shape and their defaults. The API stores the theme in `user_settings.theme`
 * and only the editor and email keys ever saved in `user_settings.preferences`
 * (migration 034); it reads both through `readStoredPreferences`, which fills
 * in every default. The web never derives a default itself.
 */

export const THEMES = ["light", "dark", "navy"] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

/** The editor's tab sizes (D21 decision 31). */
export const EDITOR_TAB_SIZES = [2, 4] as const;
export type EditorTabSize = (typeof EDITOR_TAB_SIZES)[number];

export const EDITOR_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20] as const;
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];

/** One of `values`, a number. */
function oneOf<const Values extends readonly number[]>(values: Values, message: string) {
  const allowed: ReadonlySet<unknown> = new Set(values);
  return z.custom<Values[number]>((value) => allowed.has(value), { message });
}

const EditorTabSizeSchema = oneOf(EDITOR_TAB_SIZES, "The tab size is 2 or 4.");
const EditorFontSizeSchema = oneOf(EDITOR_FONT_SIZES, "The font size is 12, 13, 14, 15, 16, 18 or 20.");

export const EditorPreferencesSchema = z
  .object({
    tabSize: EditorTabSizeSchema,
    fontSize: EditorFontSizeSchema,
    lineNumbers: z.boolean(),
    minimap: z.boolean(),
  })
  .strict();

export type EditorPreferences = z.infer<typeof EditorPreferencesSchema>;

/** The Notifications page's two switches (D21 decision 13, Q120). */
export const EmailPreferencesSchema = z
  .object({
    productUpdates: z.boolean(),
    productTips: z.boolean(),
  })
  .strict();

export type EmailPreferences = z.infer<typeof EmailPreferencesSchema>;

/** `GET` and `PATCH /api/v1/auth/me/preferences`'s answer: every key, defaults filled in. */
export const UserPreferencesSchema = z
  .object({
    theme: ThemeSchema,
    editor: EditorPreferencesSchema,
    email: EmailPreferencesSchema,
  })
  .strict();

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/** The defaults, frozen at every level. */
export type DefaultUserPreferences = {
  readonly theme: Theme;
  readonly editor: Readonly<EditorPreferences>;
  readonly email: Readonly<EmailPreferences>;
};

/**
 * The defaults (D8's `editor-store.ts:89-94` among them): Dark; a tab size
 * of 2, a font size of 13, line numbers on, the minimap off; both emails on.
 */
export const DEFAULT_USER_PREFERENCES: DefaultUserPreferences = Object.freeze({
  theme: "dark",
  editor: Object.freeze({ tabSize: 2, fontSize: 13, lineNumbers: true, minimap: false }),
  email: Object.freeze({ productUpdates: true, productTips: true }),
});

/** True when at least one key carries a value. */
function hasSomeKey(value: object): boolean {
  return Object.values(value).some((field) => field !== undefined);
}

/**
 * `PATCH /api/v1/auth/me/preferences`: a strict deep partial. At least one
 * key, and a group that is present has at least one key; an unknown key or
 * value is the validator's `400 invalid_request`. The API merges each group
 * present onto the stored one, so the keys it leaves out keep their values.
 */
export const UpdateUserPreferencesRequestSchema = z
  .object({
    theme: ThemeSchema.optional(),
    editor: EditorPreferencesSchema.partial()
      .strict()
      .refine(hasSomeKey, "Give at least one editor preference.")
      .optional(),
    email: EmailPreferencesSchema.partial()
      .strict()
      .refine(hasSomeKey, "Give at least one email preference.")
      .optional(),
  })
  .strict()
  .refine(hasSomeKey, "Give at least one preference.");

export type UpdateUserPreferencesRequest = z.infer<typeof UpdateUserPreferencesRequestSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A group's own key, or its default when the group or the key isn't valid. */
function readKey<Value>(group: unknown, key: string, schema: z.ZodType<Value>, fallback: Value): Value {
  if (!isPlainObject(group) || !Object.hasOwn(group, key)) return fallback;
  const parsed = schema.safeParse(group[key]);
  return parsed.success ? parsed.data : fallback;
}

/**
 * A stored row read as `UserPreferences` (D21 decision 19): the `theme`
 * column and the `preferences` jsonb, or `undefined` and `undefined` when the
 * person has no row. Each of the seven keys is read on its own: a missing or
 * invalid key, a group that isn't an object, or a value that isn't one gets
 * that key's default, and unknown keys are ignored. It never throws for any
 * JSON value, so a stored value never makes a read fail.
 */
export function readStoredPreferences(theme: unknown, stored: unknown): UserPreferences {
  const defaults = DEFAULT_USER_PREFERENCES;
  const parsedTheme = ThemeSchema.safeParse(theme);
  const editor = isPlainObject(stored) && Object.hasOwn(stored, "editor") ? stored.editor : undefined;
  const email = isPlainObject(stored) && Object.hasOwn(stored, "email") ? stored.email : undefined;
  const shape = EditorPreferencesSchema.shape;
  const emailShape = EmailPreferencesSchema.shape;
  return {
    theme: parsedTheme.success ? parsedTheme.data : defaults.theme,
    editor: {
      tabSize: readKey(editor, "tabSize", shape.tabSize, defaults.editor.tabSize),
      fontSize: readKey(editor, "fontSize", shape.fontSize, defaults.editor.fontSize),
      lineNumbers: readKey(editor, "lineNumbers", shape.lineNumbers, defaults.editor.lineNumbers),
      minimap: readKey(editor, "minimap", shape.minimap, defaults.editor.minimap),
    },
    email: {
      productUpdates: readKey(email, "productUpdates", emailShape.productUpdates, defaults.email.productUpdates),
      productTips: readKey(email, "productTips", emailShape.productTips, defaults.email.productTips),
    },
  };
}

/**
 * The cookie that carries the theme to the seven auth screens before first
 * paint (D21 decision 23): HttpOnly, one word.
 */
export const THEME_COOKIE_NAME = "telflo_theme";

/** The cookie's theme: one of the three words, else Dark (absent or unknown). */
export function themeFromCookie(value: string | undefined): Theme {
  const parsed = ThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_USER_PREFERENCES.theme;
}
