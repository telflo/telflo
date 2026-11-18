/**
 * The site's settings a product admin changes (D36-1 decision 51; Q252,
 * Ruling 359): who may create an organization.
 *
 *   * site_settings: one row (migration 028's otelcol_testing_state
 *     pattern: a boolean key, always true, and a check), inserted here with
 *     the column's default. organization_creation is `product_admins` (the
 *     default, in every registration mode, Q259: only a live product admin
 *     may create a group organization) or `everyone` (anyone signed in may,
 *     as before D36-1). A system resource: no organization, no row-level
 *     security. The API's role reads it (SELECT: an organization's
 *     create and the signed-in user's `/me` read it) and changes it only
 *     through the definer below: INSERT, UPDATE and DELETE, which migration
 *     009's default privileges would give it, are revoked.
 *   * product_admin_set_organization_creation(p_value): migration 041's
 *     pattern for a product admin's write. SECURITY DEFINER, owned by the
 *     migration role (the tables' owner), search_path pg_catalog, platform
 *     with schema-qualified tables, EXECUTE revoked from public and granted
 *     to telflo_platform_runtime only; it begins with `perform
 *     platform.assert_product_admin()`, so it refuses with the gate's 42501
 *     in any context but a live product admin's. The API calls it only from
 *     modules/product-admin/repositories/system-repository.ts (a test scans
 *     the source), which writes the audit row in the same transaction, as
 *     for the grant and the revoke. In order:
 *       - 22023 unless p_value is `everyone` or `product_admins`;
 *       - the row locked (for update), then the caller re-read under a row
 *         lock (for share) taken after it (Rulings 257 and 258): forbidden
 *         when the caller is no longer a live product admin (a removal
 *         committed while this waited wins);
 *       - unchanged when the row already holds p_value;
 *       - otherwise the row set to p_value: changed.
 *     It answers the outcome and the value the row held before.
 *     The switch applies to creations only: organizations that already
 *     exist keep their admins, who keep inviting (decision 51).
 *
 * down drops the function and the table: migration 043's catalogue exactly.
 */

const signature = "product_admin_set_organization_creation(text)";

export const up = (pgm) => {
  pgm.sql(`
    create table site_settings (
      id                     boolean  primary key default true,
      organization_creation  text     not null default 'product_admins',
      constraint ck_site_settings_singleton check (id),
      constraint ck_site_settings_organization_creation check (organization_creation in ('everyone', 'product_admins'))
    );

    insert into site_settings default values;

    revoke insert, update, delete on site_settings from telflo_platform_runtime;

    comment on table site_settings is
      'the site''s settings a product admin changes (D36-1 decision 51): one
       row. Global: no organization owns it and no row-level security. The
       API''s role reads it and changes it only through
       product_admin_set_organization_creation.';
    comment on column site_settings.id is
      'always true: the table holds one row (ck_site_settings_singleton).';
    comment on column site_settings.organization_creation is
      'who may create a group organization: product_admins, live product
       admins only (the default, Q259), or everyone signed in. Organizations
       that already exist are untouched either way.';
    comment on constraint site_settings_pkey on site_settings is
      'the row''s key, always true.';
    comment on constraint ck_site_settings_singleton on site_settings is
      'one row only: its key is true.';
    comment on constraint ck_site_settings_organization_creation on site_settings is
      'everyone or product_admins.';

    create function product_admin_set_organization_creation(p_value text)
    returns table (outcome text, previous text)
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      me uuid;
      current_value text;
    begin
      perform platform.assert_product_admin();
      if p_value is null or p_value not in ('everyone', 'product_admins') then
        raise exception 'the setting takes everyone or product_admins' using errcode = 'invalid_parameter_value';
      end if;
      me := current_setting('telflo.user_id')::uuid;
      select s.organization_creation into current_value from platform.site_settings s for update;
      -- The caller after the row's lock (Rulings 257 and 258): a removal committed meanwhile wins.
      perform 1 from platform.users u where u.id = me for share;
      if not exists (select 1 from platform.users u
                      where u.id = me and u.deleted_at is null and u.kind = 'human' and u.is_product_admin) then
        return query select 'forbidden'::text, null::text;
        return;
      end if;
      if current_value = p_value then
        return query select 'unchanged'::text, current_value;
        return;
      end if;
      update platform.site_settings set organization_creation = p_value;
      return query select 'changed'::text, current_value;
    end;
    $$;

    comment on function ${signature} is
      'sets who may create an organization (D36-1 decision 51): 22023 unless
       p_value is everyone or product_admins; the row locked (for update),
       then the caller (for share); forbidden when the caller is no longer a
       live product admin, unchanged when the row already holds p_value,
       otherwise changed. Answers the outcome and the value held before.
       The API writes the audit row. Only a product admin''s context
       (assert_product_admin).';

    revoke execute on function ${signature} from public;
    grant execute on function ${signature} to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function ${signature};
    drop table site_settings;
  `);
};
