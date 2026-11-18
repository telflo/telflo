/**
 * Configurations and their versions are never hard-deleted by the API's
 * role, and a configuration keeps its author (D11b Ruling 29, after the
 * final review's first finding).
 *
 *   * Nothing in the platform hard-deletes a configuration or a version:
 *     deleting a configuration sets deleted_at (D7), and only its author or
 *     an admin may, which the API decides (D11b decision 2); a version goes
 *     only with its configuration. Yet migration 021's delete policies let
 *     telflo_platform_runtime delete any configuration the context's user can
 *     see, and any draft version of one. A configuration's delete cascades
 *     over its versions, published ones included, past the versions' own
 *     delete policy (referential actions bypass row-level security) and
 *     past migration 020's immutability trigger (which guards updates
 *     only): so a teammate, neither author nor admin, could remove a
 *     published configuration and its every published version with raw SQL
 *     as the API's role. Both delete policies become using (false): the
 *     API's role deletes no row of either table, its own drafts included.
 *     The policies stay (rather than being dropped) so that the table's
 *     row-level security still names every command.
 *   * What still removes them is a hard delete of what they belong to: an
 *     organization's cascades over its configurations, and an account's
 *     sets created_by_user_id (and the versions' creator and publisher) to
 *     null, as referential actions, which row-level security doesn't apply
 *     to. Both are the tables' owner's to do: no code of the API's
 *     hard-deletes an organization or an account. (The API's role holds
 *     DELETE on organizations and users, which have no row-level security,
 *     so this migration doesn't close that path for raw SQL as it.)
 *   * The author/admin rule reads configurations.created_by_user_id, and the
 *     update policy lets any member who sees a published configuration
 *     change its columns, so a teammate could make themselves its author
 *     (update … set created_by_user_id = self) and then delete it through
 *     the API. A before-update trigger, configurations_author_unchanged,
 *     refuses any change of created_by_user_id but to null (the users
 *     foreign key's on delete set null), with P0001 and a message naming
 *     only the configuration's id. A write of the same value passes (it
 *     compares with is distinct from). Like migration 020's trigger it fires
 *     for every role on a plain UPDATE, the tables' owner included, and is
 *     not SECURITY DEFINER: it reads only the row it is given. Its limits
 *     are operator-level (ALTER TABLE … DISABLE TRIGGER,
 *     session_replication_role = replica), which the API's role can do
 *     neither of (ADR 0022). Transferring a departing member's
 *     configurations, when it is built, will change this rule in a migration
 *     of its own.
 *   * The trigger fires before row-level security's update check, so an
 *     author handing their own draft to another member is now refused by
 *     the trigger (P0001) before the update policy's check would refuse it
 *     (42501).
 *   * No table's grants change. The trigger function keeps the default
 *     EXECUTE for PUBLIC, as migration 020's does: a trigger function can
 *     only be called as a trigger, and firing one checks no EXECUTE.
 *
 * down puts back migration 021's two delete policies and their comments
 * exactly, then drops the trigger and its function.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;
const contextUser = `nullif(current_setting('telflo.user_id', true), '')::uuid`;

/** Migration 021's: a configurations row the context may see (its own columns, unqualified). */
const configurationVisible = `organization_id = ${contextOrganization}
        and (created_by_user_id = ${contextUser}
             or configuration_is_published(id, organization_id))`;

/** Migration 021's: a child row of `table` whose configuration the context may see. */
const childVisible = (table) => `organization_id = ${contextOrganization}
        and exists (select 1 from configurations c
                     where c.id = ${table}.configuration_id
                       and c.organization_id = ${table}.organization_id)`;

export const up = (pgm) => {
  pgm.sql(`
    alter policy configurations_delete on configurations
      using (false);

    alter policy configuration_versions_delete on configuration_versions
      using (false);

    comment on policy configurations_delete on configurations is
      'the API''s role deletes no configuration (D11b Ruling 29): deleting
       one sets deleted_at, and only its author or an admin may, which the
       API decides. A hard delete would cascade over its versions, published
       ones included, past their own policy and the immutability trigger.
       An organization''s hard delete still takes its configurations, as the
       tables'' owner.';
    comment on policy configuration_versions_delete on configuration_versions is
      'the API''s role deletes no version (D11b Ruling 29): a version goes
       only with its configuration, which the API never hard-deletes either.
       Never a published one, whose content a delete and an insert under the
       same id would otherwise replace (Ruling 17), nor a draft.';

    -- Not SECURITY DEFINER: it reads only the row it is given, as whatever
    -- role runs the update. A fixed search_path all the same, as migration
    -- 020's trigger function has. P0001 (raise_exception), as that one
    -- raises: nothing branches on it, since the API never writes the
    -- column.
    create function refuse_configuration_author_change() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if new.created_by_user_id is distinct from old.created_by_user_id
         and new.created_by_user_id is not null
      then
        raise exception 'configuration % keeps its author', old.id;
      end if;
      return new;
    end;
    $$;

    create trigger configurations_author_unchanged
      before update on configurations
      for each row execute function refuse_configuration_author_change();

    comment on function refuse_configuration_author_change() is
      'a configuration keeps its author (D11b Ruling 29), kept by the
       database and not just the API: the author/admin delete rule (D11b
       decision 2) reads created_by_user_id, which a member who can update
       a published configuration could otherwise set to themselves. Refuses
       any change of created_by_user_id but to null (the users foreign
       key''s on delete set null), raising P0001 with a message naming only
       the configuration''s id. A same-value write passes. Not SECURITY
       DEFINER: it reads only the row it is given.';
    comment on trigger configurations_author_unchanged on configurations is
      'before update, for every role on a plain UPDATE, the API''s and the
       tables'' owner alike: triggers have no owner exemption. It fires
       before row-level security''s update check. Only an operator can
       bypass it: the owner with ALTER TABLE … DISABLE TRIGGER, a superuser
       with session_replication_role = replica. Transferring a departing
       member''s configurations, if it is ever added, will change it.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop trigger configurations_author_unchanged on configurations;
    drop function refuse_configuration_author_change();

    alter policy configurations_delete on configurations
      using (${configurationVisible});

    alter policy configuration_versions_delete on configuration_versions
      using (${childVisible("configuration_versions")}
        and published_at is null);

    comment on policy configurations_delete on configurations is
      'nothing deletes a configuration (deleting sets deleted_at, and only
       its author or an admin may, which the API decides), but a policy keeps
       a future delete to the configurations the context''s user can see.';
    comment on policy configuration_versions_delete on configuration_versions is
      'nothing deletes a version on its own (it goes with its
       configuration), but a policy keeps a future delete to the drafts of
       configurations the context''s user can see. Never a published one
       (D11b Ruling 17): the immutability trigger guards updates only, and a
       delete followed by an insert under the same id would otherwise
       replace a published version''s content.';
  `);
};
