/**
 * A person's own settings (D21 decisions 3, 4 and 18).
 *
 *   * user_settings: one row per user, holding the theme (light, dark or
 *     navy) and a jsonb of the editor and email preferences (decision 3:
 *     a theme column and a preferences jsonb that
 *     the API's schema validates, not typed and checked columns). The row
 *     is lazy (decision 4): no row means the defaults, the first save
 *     inserts it, and there is no backfill and no change to registration.
 *     Timestamps have no default: the API writes both from its clock, as
 *     configurations' (migration 015). The jsonb check has
 *     quick_deploy_links.choices' form (migration 032), a bound the API's
 *     schema never comes near.
 *   * It belongs to the user, not to an organization: no organization_id
 *     and no row-level security, as users, sessions and user_identities.
 *     A user's delete cascades to it.
 *   * sessions.revoked_reason's comment gains signed_out_elsewhere: one
 *     session signed out from Settings › Account (decision 40). The column
 *     is text with no check on its values; the comment lists them, as
 *     migrations 008 and 010 did.
 *
 * No grant: migration 009's default privileges give telflo_platform_runtime
 * select, insert, update and delete on the new table.
 *
 * down drops the table and restores migration 010's comment on
 * sessions.revoked_reason.
 */

export const up = (pgm) => {
  pgm.sql(`
    create table user_settings (
      user_id      uuid        primary key references users(id) on delete cascade,
      theme        text        not null default 'dark',
      preferences  jsonb       not null default '{}'::jsonb,
      created_at   timestamptz not null,
      updated_at   timestamptz not null,
      constraint ck_user_settings_theme check (theme in ('light', 'dark', 'navy')),
      constraint ck_user_settings_preferences
        check (jsonb_typeof(preferences) = 'object' and octet_length(preferences::text) <= 4096)
    );

    comment on table user_settings is
      'a person''s own settings (D21): the theme and the editor and email
       preferences. Lazy: no row means the defaults, and the first save
       inserts it. Belongs to the user, not to an organization: no row-level
       security, as users, sessions and user_identities.';
    comment on column user_settings.user_id is
      'the user whose settings these are, one row each. Cascades: a user''s
       delete takes the row with it.';
    comment on column user_settings.theme is
      'light, dark or navy; dark when there is no row.';
    comment on column user_settings.preferences is
      'only the editor and email keys ever saved; read through the API''s
       schema, which fills in defaults and reads a bad key as its default
       (D21 decision 19).';
    comment on column user_settings.created_at is
      'when the row was first saved, by the API''s clock.';
    comment on column user_settings.updated_at is
      'when the row was last saved, by the API''s clock.';
    comment on constraint user_settings_pkey on user_settings is
      'one row per user, by the user''s id.';
    comment on constraint user_settings_user_id_fkey on user_settings is
      'the row''s user (23503 otherwise); on delete cascade.';
    comment on constraint ck_user_settings_theme on user_settings is
      'one of the three themes: light, dark or navy.';
    comment on constraint ck_user_settings_preferences on user_settings is
      'a JSON object of at most 4 KiB (as jsonb prints it), a bound the
       API''s schema never comes near.';

    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused,
       password_reset, account_taken_over (a federated sign-in took over an
       unverified account, ADR 0021), organization_access_lost (the
       session''s organization went away and the user had no other, D5
       decision 9) or signed_out_elsewhere (one session signed out from
       Settings › Account, D21 decision 40). Text rather than an enum until
       a third consumer needs to branch on it.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table user_settings;

    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused,
       password_reset, account_taken_over (a federated sign-in took over an
       unverified account, ADR 0021) or organization_access_lost (the
       session''s organization went away and the user had no other, D5
       decision 9). Text rather than an enum until a third consumer needs to
       branch on it.';
  `);
};
