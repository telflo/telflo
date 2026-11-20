import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  readStoredPreferences,
  type Theme,
  type UpdateUserPreferencesRequest,
  type UserPreferences,
} from "@telflo/contracts";

/**
 * A person's own settings, in `user_settings` (migration 034). The row is
 * lazy: no row reads as the defaults, and the first save inserts it. It
 * belongs to the user, not to an organization, and has no row-level
 * security, so it is read and written outside any organization's context.
 *
 * Every read goes through `readStoredPreferences`, which fills in each
 * missing or invalid key with its default: a stored value never makes a read
 * fail.
 */
export interface IUserSettingsRepository {
  /** The person's whole preferences, defaults filled in: one primary-key read. */
  find(userId: string): Promise<UserPreferences>;
  /** The person's theme alone (Dark with no row): the `telflo_theme` cookie's value. */
  findTheme(userId: string): Promise<Theme>;
  /**
   * Merges a partial change onto the stored row in one statement, inserting
   * the row on the first save, and answers the whole preferences after it.
   */
  merge(userId: string, patch: UpdateUserPreferencesRequest, at: Date): Promise<UserPreferences>;
}

/** A group as JSON text for a `::jsonb` cast, or null when the change doesn't carry it. */
function jsonOrNull(value: object | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function createUserSettingsRepository(db: Kysely<Database> | Transaction<Database>): IUserSettingsRepository {
  return {
    async find(userId) {
      const row = await db
        .selectFrom("user_settings")
        .select(["theme", "preferences"])
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return readStoredPreferences(row?.theme, row?.preferences);
    },

    async findTheme(userId) {
      const row = await db.selectFrom("user_settings").select("theme").where("user_id", "=", userId).executeTakeFirst();
      return readStoredPreferences(row?.theme, undefined).theme;
    },

    /**
     * One upsert. On the first save it inserts the groups the change carries;
     * afterwards each group present is merged with `||` onto the stored group
     * (a stored group that isn't an object is replaced), and the theme column
     * is set only when given. The row lock of `on conflict do update`
     * serializes concurrent changes, so each lands its own keys: the last
     * write wins per key, with no read-modify-write here.
     *
     * The groups travel as JSON text cast `::jsonb` at every use: a
     * JavaScript array or object handed to the driver would not arrive as
     * jsonb.
     */
    async merge(userId, patch, at) {
      const theme = patch.theme ?? null;
      const editor = jsonOrNull(patch.editor);
      const email = jsonOrNull(patch.email);
      const groups = JSON.stringify({
        ...(patch.editor === undefined ? {} : { editor: patch.editor }),
        ...(patch.email === undefined ? {} : { email: patch.email }),
      });
      const { rows } = await sql<{ theme: string; preferences: unknown }>`
        insert into user_settings as s (user_id, theme, preferences, created_at, updated_at)
        values (${userId}, coalesce(${theme}::text, 'dark'), ${groups}::jsonb, ${at}, ${at})
        on conflict (user_id) do update set
          theme       = coalesce(${theme}::text, s.theme),
          preferences = s.preferences
            || case when ${editor}::jsonb is null then '{}'::jsonb else jsonb_build_object('editor',
                 case when jsonb_typeof(s.preferences->'editor') = 'object' then s.preferences->'editor' else '{}'::jsonb end
                 || ${editor}::jsonb) end
            || case when ${email}::jsonb is null then '{}'::jsonb else jsonb_build_object('email',
                 case when jsonb_typeof(s.preferences->'email') = 'object' then s.preferences->'email' else '{}'::jsonb end
                 || ${email}::jsonb) end,
          updated_at  = ${at}
        returning theme, preferences
      `.execute(db);
      const row = rows[0]!;
      return readStoredPreferences(row.theme, row.preferences);
    },
  };
}
