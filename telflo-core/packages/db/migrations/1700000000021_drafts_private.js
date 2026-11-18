/**
 * Drafts are private (D11b decision 1; Preflight rulings 1, 2, 3 and 15):
 * a member sees their own drafts and every published configuration, and
 * row-level security, not just the API, keeps it so.
 *
 *   * A configuration is visible to the context's user when it is the
 *     context's organization's and either they created it
 *     (created_by_user_id) or it is published: at least one of its versions
 *     has published_at set (migration 020). Within a visible configuration
 *     every version is visible, and so is every selection naming it. A
 *     configuration whose author's account is gone (created_by_user_id
 *     null) and that was never published is visible to no one, admins
 *     included (decision 1).
 *   * "Is it published" is a SECURITY DEFINER helper,
 *     configuration_is_published(configuration_id, organization_id), as ADR
 *     0022 allows. A configurations policy that looked into
 *     configuration_versions directly, beside a versions policy that looks
 *     into configurations, would recurse ("infinite recursion detected in
 *     policy for relation configurations", Preflight ruling 1). The helper
 *     runs as the tables' owner, who is exempt from row-level security
 *     because neither table is FORCEd (migrations 015 and 016): it reads
 *     configuration_versions past its policy, and so never comes back to
 *     configurations'. FORCE ROW LEVEL SECURITY on either table would bring
 *     the recursion back, so that is a change to make only with this
 *     helper's.
 *   * The helper carries the backstop itself, as ADR 0022's definer
 *     functions do: it answers false for any organization but the
 *     context's, so it can't be asked about another organization; it
 *     answers one boolean, never a row; a fixed search_path (pg_catalog,
 *     then platform), and the one table it reads is named with its schema, so
 *     no temporary table on a caller's path can stand in for it; EXECUTE is
 *     taken from PUBLIC and given to telflo_platform_runtime only. It is STABLE
 *     (it reads, and answers alike within a statement).
 *   * configurations: select, update and delete see only visible rows;
 *     update's check keeps a row visible (nothing the API writes makes its
 *     own row invisible); insert admits only a row in the context's
 *     organization created by the context's user. An insert's returning is
 *     held to the select policy as well, which a new configuration (no
 *     version yet, so a draft) passes only for its creator: so sign-up sets
 *     the full context before the starter configuration's insert (Preflight
 *     ruling 2).
 *   * configuration_versions and configuration_version_selections: every
 *     operation needs the row's configuration to be visible, through an
 *     exists over configurations, whose own select policy applies inside it.
 *     So raw SQL as the API's role can't read another member's draft's
 *     versions, nor add a version to it (42501, Preflight ruling 15), nor
 *     read or record a selection of it. The exists names the composite
 *     foreign key's columns, qualified with the policy's own table, so it
 *     finds the row's own configuration in the row's own organization.
 *   * Published versions (D11b Ruling 17): migration 020's trigger guards
 *     updates only, so the versions' delete policy admits only drafts, and
 *     their insert policy only rows with all three publish columns null. A
 *     published version can't be deleted and inserted again with new
 *     content under its id and publication id, and a version is published
 *     only by the update that records the publish. A check,
 *     ck_configuration_versions_publisher_only_when_published, keeps a
 *     publisher off a draft, for every role.
 *   * Selections get the same rule as versions (a selection names a version
 *     of its configuration, so it would otherwise tell a member which of
 *     another member's drafts exist and which version they opened). The
 *     policies still don't limit a selection to its person: the repository
 *     filters by user_id, as before.
 *   * Deleted rows: as before, the policies don't hide a soft-deleted
 *     configuration; the repository does.
 *
 * Migration 009's default privileges already cover the tables; only the
 * helper's EXECUTE is granted here.
 *
 * down puts back every policy as migrations 015, 016 and 018 made it, with
 * their comments, then drops the check and the helper.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;
const contextUser = `nullif(current_setting('telflo.user_id', true), '')::uuid`;

/** A configurations row the context may see (its own columns, unqualified). */
const configurationVisible = `organization_id = ${contextOrganization}
        and (created_by_user_id = ${contextUser}
             or configuration_is_published(id, organization_id))`;

/** A child row of `table` whose configuration the context may see. */
const childVisible = (table) => `organization_id = ${contextOrganization}
        and exists (select 1 from configurations c
                     where c.id = ${table}.configuration_id
                       and c.organization_id = ${table}.organization_id)`;

export const up = (pgm) => {
  pgm.sql(`
    create function configuration_is_published(p_configuration_id uuid, p_organization_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
      select coalesce(p_organization_id = ${contextOrganization}, false)
         and exists (select 1 from platform.configuration_versions v
                      where v.configuration_id = p_configuration_id
                        and v.organization_id = p_organization_id
                        and v.published_at is not null)
    $$;

    revoke execute on function configuration_is_published(uuid, uuid) from public;
    grant execute on function configuration_is_published(uuid, uuid) to telflo_platform_runtime;

    comment on function configuration_is_published(uuid, uuid) is
      'whether the configuration has a published version (D11b decision 1:
       a configuration is published when one of its versions is), for the
       configurations policies. SECURITY DEFINER so those policies need not
       look into configuration_versions, whose own policies look into
       configurations: that pair recursed (D11b Preflight ruling 1). It reads
       configuration_versions as the tables'' owner, past row-level security,
       which holds only while neither table is FORCEd. It carries the
       backstop itself (ADR 0022): false for any organization but the one in
       the database context, one boolean out, a fixed search_path and a
       schema-qualified table, EXECUTE for telflo_platform_runtime only.';

    alter table configuration_versions
      add constraint ck_configuration_versions_publisher_only_when_published
        check (published_at is not null or published_by_user_id is null);

    comment on constraint ck_configuration_versions_publisher_only_when_published on configuration_versions is
      'a draft has no publisher (D11b Ruling 17): published_by_user_id is
       set only on a published version, by the update that records the
       publish. A published version may have none, once its publisher''s
       account is hard-deleted.';

    alter policy configurations_select on configurations
      using (${configurationVisible});

    alter policy configurations_insert on configurations
      with check (organization_id = ${contextOrganization}
                  and created_by_user_id = ${contextUser});

    alter policy configurations_update on configurations
      using (${configurationVisible})
      with check (${configurationVisible});

    alter policy configurations_delete on configurations
      using (${configurationVisible});

    comment on policy configurations_select on configurations is
      'the API''s role sees the context''s organization''s configurations that
       the context''s user created or that are published (D11b decision 1),
       deleted ones included: the repository hides those. Another member''s
       draft, and a never-published configuration with no author, are
       invisible. A backstop behind the repository''s same filter.';
    comment on policy configurations_insert on configurations is
      'the API''s role creates configurations only in the context''s
       organization and only as the context''s user (42501 otherwise): a new
       configuration is a draft, which only its creator sees, and an
       insert''s returning is held to the select policy too.';
    comment on policy configurations_update on configurations is
      'the API''s role changes only configurations the context''s user can
       see (the select policy''s rule), and can''t move one into another
       organization or out of their sight. A locking read (the repository''s
       for update) is held to it as well, so another member''s draft can''t
       be locked either.';
    comment on policy configurations_delete on configurations is
      'nothing deletes a configuration (deleting sets deleted_at, and only
       its author or an admin may, which the API decides), but a policy keeps
       a future delete to the configurations the context''s user can see.';

    alter policy configuration_versions_select on configuration_versions
      using (${childVisible("configuration_versions")});

    alter policy configuration_versions_insert on configuration_versions
      with check (${childVisible("configuration_versions")}
        and published_at is null
        and publication_id is null
        and published_by_user_id is null);

    alter policy configuration_versions_update on configuration_versions
      using (${childVisible("configuration_versions")})
      with check (${childVisible("configuration_versions")});

    alter policy configuration_versions_delete on configuration_versions
      using (${childVisible("configuration_versions")}
        and published_at is null);

    comment on policy configuration_versions_select on configuration_versions is
      'the API''s role sees the versions of the configurations the context''s
       user can see (configurations_select applies inside the exists), every
       version of a visible configuration, a deleted configuration''s
       included: the repository hides those.';
    comment on policy configuration_versions_insert on configuration_versions is
      'the API''s role creates versions only of configurations the context''s
       user can see, in the context''s organization (42501 otherwise, before
       the foreign key is checked): no version can be added to another
       member''s draft. And only drafts: all three publish columns null, so
       a version is published only by the update that records its publish
       (D11b Ruling 17), never inserted already published.';
    comment on policy configuration_versions_update on configuration_versions is
      'the API''s role saves only versions of configurations the context''s
       user can see, and can''t move one into another organization or
       configuration out of their sight. A published version is immutable
       besides (migration 020''s trigger).';
    comment on policy configuration_versions_delete on configuration_versions is
      'nothing deletes a version on its own (it goes with its
       configuration), but a policy keeps a future delete to the drafts of
       configurations the context''s user can see. Never a published one
       (D11b Ruling 17): the immutability trigger guards updates only, and a
       delete followed by an insert under the same id would otherwise
       replace a published version''s content.';

    alter policy configuration_version_selections_select on configuration_version_selections
      using (${childVisible("configuration_version_selections")});

    alter policy configuration_version_selections_insert on configuration_version_selections
      with check (${childVisible("configuration_version_selections")});

    alter policy configuration_version_selections_update on configuration_version_selections
      using (${childVisible("configuration_version_selections")})
      with check (${childVisible("configuration_version_selections")});

    alter policy configuration_version_selections_delete on configuration_version_selections
      using (${childVisible("configuration_version_selections")});

    comment on policy configuration_version_selections_select on configuration_version_selections is
      'the API''s role sees the selections of the configurations the
       context''s user can see (configurations_select applies inside the
       exists), a deleted configuration''s included: the repository hides
       those, and other people''s.';
    comment on policy configuration_version_selections_insert on configuration_version_selections is
      'the API''s role records selections only of configurations the
       context''s user can see, in the context''s organization (42501
       otherwise, before the foreign keys are checked).';
    comment on policy configuration_version_selections_update on configuration_version_selections is
      'the API''s role replaces only selections of configurations the
       context''s user can see, and can''t move one into another organization
       or out of their sight.';
    comment on policy configuration_version_selections_delete on configuration_version_selections is
      'nothing deletes a selection on its own (it goes with its
       configuration, version or person), but a policy keeps a future delete
       to the selections of configurations the context''s user can see.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter policy configurations_select on configurations
      using (organization_id = ${contextOrganization});
    alter policy configurations_insert on configurations
      with check (organization_id = ${contextOrganization});
    alter policy configurations_update on configurations
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});
    alter policy configurations_delete on configurations
      using (organization_id = ${contextOrganization});

    comment on policy configurations_select on configurations is
      'the API''s role sees only the context''s organization''s
       configurations, deleted ones included: the repository hides those. A
       backstop behind the organization scope.';
    comment on policy configurations_insert on configurations is
      'the API''s role creates configurations only in the context''s
       organization (42501 otherwise).';
    comment on policy configurations_update on configurations is
      'the API''s role changes only the context''s organization''s
       configurations, and can''t move one into another organization. A
       locking read (the repository''s for update) is held to it as well.';
    comment on policy configurations_delete on configurations is
      'nothing deletes a configuration (deleting sets deleted_at), but a
       policy keeps a future delete inside the organization.';

    alter policy configuration_versions_select on configuration_versions
      using (organization_id = ${contextOrganization});
    alter policy configuration_versions_insert on configuration_versions
      with check (organization_id = ${contextOrganization});
    alter policy configuration_versions_update on configuration_versions
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});
    alter policy configuration_versions_delete on configuration_versions
      using (organization_id = ${contextOrganization});

    comment on policy configuration_versions_select on configuration_versions is
      'the API''s role sees only the context''s organization''s versions, a
       deleted configuration''s included: the repository hides those. A
       backstop behind the organization scope.';
    comment on policy configuration_versions_insert on configuration_versions is
      'the API''s role creates versions only in the context''s organization
       (42501 otherwise, before the foreign key is checked).';
    comment on policy configuration_versions_update on configuration_versions is
      'the API''s role saves only the context''s organization''s versions, and
       can''t move one into another organization.';
    comment on policy configuration_versions_delete on configuration_versions is
      'nothing deletes a version on its own in D8 (it goes with its
       configuration), but a policy keeps a future delete inside the
       organization.';

    alter policy configuration_version_selections_select on configuration_version_selections
      using (organization_id = ${contextOrganization});
    alter policy configuration_version_selections_insert on configuration_version_selections
      with check (organization_id = ${contextOrganization});
    alter policy configuration_version_selections_update on configuration_version_selections
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});
    alter policy configuration_version_selections_delete on configuration_version_selections
      using (organization_id = ${contextOrganization});

    comment on policy configuration_version_selections_select on configuration_version_selections is
      'the API''s role sees only the context''s organization''s selections, a
       deleted configuration''s included: the repository hides those, and
       other people''s. A backstop behind the organization scope.';
    comment on policy configuration_version_selections_insert on configuration_version_selections is
      'the API''s role records selections only in the context''s organization
       (42501 otherwise, before the foreign keys are checked).';
    comment on policy configuration_version_selections_update on configuration_version_selections is
      'the API''s role replaces only the context''s organization''s
       selections, and can''t move one into another organization.';
    comment on policy configuration_version_selections_delete on configuration_version_selections is
      'nothing deletes a selection on its own in D10 (it goes with its
       configuration, version or person), but a policy keeps a future delete
       inside the organization.';

    alter table configuration_versions
      drop constraint ck_configuration_versions_publisher_only_when_published;

    drop function configuration_is_published(uuid, uuid);
  `);
};
