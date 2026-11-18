/**
 * Organization logos (D23-2 decisions 12 and 27; Preflight ruling 13).
 *
 *   * organizations.logo_id: the logo's id, a new one per upload, so a
 *     replaced logo is a new file at a new address and a cached page never
 *     shows the old picture under the new one's name. The bytes are the
 *     file store's (`organizations/<organizationId>/logos/<logoId>`, ADR
 *     0012), never a column. Null: no logo, the initials.
 *   * organizations.logo_content_type: the type the API read from the
 *     file's first bytes at upload (never its name or the browser's type),
 *     served with the bytes.
 *   * ck_organizations_logo: both null or both set, and the type one of
 *     PNG, JPEG and WebP (D23-2 decision 1: SVG refused).
 *
 * No index: the public read looks the row up by its primary key and
 * compares logo_id. `organizations` has no row-level security and
 * telflo_platform_runtime already holds select, insert, update and delete on it
 * (migration 009): no grant, policy or definer changes. Every existing row
 * has no logo.
 *
 * down drops the constraint and the two columns.
 */

export const up = (pgm) => {
  pgm.sql(`
    alter table organizations
      add column logo_id uuid null,
      add column logo_content_type text null,
      add constraint ck_organizations_logo check (
        (logo_id is null) = (logo_content_type is null)
        and (logo_content_type is null or logo_content_type in ('image/png', 'image/jpeg', 'image/webp'))
      );

    comment on column organizations.logo_id is
      'the organization''s logo''s id (D23-2): a new one per upload; its bytes
       are the file store''s, organizations/<id>/logos/<logo_id>. Null: no
       logo.';

    comment on column organizations.logo_content_type is
      'the logo''s type, read from its first bytes at upload (D23-2):
       image/png, image/jpeg or image/webp. Null exactly when logo_id is.';

    comment on constraint ck_organizations_logo on organizations is
      'a logo has both its id and its type, or neither; the type is PNG, JPEG
       or WebP (D23-2: SVG refused).';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter table organizations
      drop constraint ck_organizations_logo,
      drop column logo_content_type,
      drop column logo_id;
  `);
};
