/**
 * Publishing (D11b decisions 4, 9 and 10): a version records its publish,
 * and a published version can't be changed.
 *
 *   * configuration_versions gains three columns, all null on a draft:
 *     published_at, when it was published (from the API's clock, never
 *     now(), as every timestamp on the table); published_by_user_id, the
 *     member who published it, set to null when their account is
 *     hard-deleted; and publication_id, the opamp-server's id for the
 *     snapshot. The platform chooses that id and PUTs to it (decision 10).
 *     It lives in another database (ADR 0026), so it has no foreign key,
 *     only a unique constraint: one snapshot is one version's.
 *   * published_at and publication_id are both set or both null (a check):
 *     a version is published exactly when the opamp-server holds its
 *     snapshot under a recorded id. published_by_user_id is not part of it,
 *     since a deleted account leaves a published version with no publisher.
 *   * A partial index on (configuration_id, organization_id) where
 *     published_at is not null answers "is this configuration published",
 *     which D11b's visibility rule asks of every configuration it lists
 *     (migration 021), from published rows only.
 *   * Published versions are immutable, and the database, not just the
 *     API, keeps them so (decision 4). A before-update trigger refuses any
 *     change to a published version's content (yaml_content, nodes, edges,
 *     pipelines, label), its publish record (published_at, publication_id,
 *     published_by_user_id) or its identity (id, version_number,
 *     configuration_id, organization_id, created_at), with P0001 and a
 *     message naming only the version's id. Two columns stay free: the
 *     users foreign keys' on delete set null must still clear
 *     created_by_user_id, and published_by_user_id, but only to null: no
 *     update may name another publisher. updated_at is free too (the last
 *     save, D10). A write of the same values passes: the trigger compares
 *     with is distinct from. There is no unpublish (decision 7).
 *   * The trigger fires for every role on a plain UPDATE, telflo_platform_runtime
 *     and the tables' owner alike: triggers, unlike row-level security, have
 *     no owner exemption. It is not SECURITY DEFINER: it reads only the row
 *     it is given. Its limits are operator-level, as migration 003's
 *     triggers' are: the owner can ALTER TABLE … DISABLE TRIGGER, and a
 *     superuser can set session_replication_role = replica, which skips it.
 *     The API's role can do neither (ADR 0022: the API refuses to start as
 *     a superuser or the owner). The trigger guards UPDATE only. DELETE
 *     has no trigger guard, so a hard delete of a configuration or an
 *     organization, done by the owner, still cascades over its published
 *     versions. telflo_platform_runtime can't delete a version or a
 *     configuration: migration 022's delete policies refuse it every one
 *     (migration 021's still let it delete a configuration it could see,
 *     which cascaded over its published versions), and migration 021's
 *     insert policy refuses it a version inserted already published. No
 *     code of the API's hard-deletes an organization or an account, whose
 *     deletes would cascade too. TRUNCATE isn't granted to the API's role.
 *   * No policy changes here: the draft rules arrive in migration 021. The
 *     table's row-level security and migration 009's default privileges
 *     already cover the new columns, so nothing is granted.
 *
 * down drops the trigger, its function, the two indexes, the check, the
 * unique constraint and the three columns, leaving the table as migration
 * 018 left it.
 */

export const up = (pgm) => {
  pgm.sql(`
    alter table configuration_versions
      add column published_at          timestamptz,
      add column published_by_user_id  uuid references users(id) on delete set null,
      add column publication_id        uuid,
      add constraint uq_configuration_versions_publication_id unique (publication_id),
      add constraint ck_configuration_versions_published_at_publication_id
        check ((published_at is null) = (publication_id is null));

    comment on column configuration_versions.published_at is
      'when the version was published (D11b decision 10), written by the API
       from its clock, never now(), in the same statement as publication_id;
       null on a draft. Once set, the version is immutable: the trigger
       configuration_versions_published_immutable refuses every change to it,
       this column included. Each version is published at most once, and
       nothing unpublishes one (decision 7).';
    comment on column configuration_versions.published_by_user_id is
      'the member who published the version, or null: on a draft, and once
       the publisher''s account is hard-deleted (normally users are
       soft-deleted). On a published version the trigger lets it become null,
       for that cascade, and refuses any other change.';
    comment on column configuration_versions.publication_id is
      'the opamp-server''s id for the version''s snapshot (decision 10): the
       platform chooses it, a fresh one for each attempt (decision 9), and
       PUTs the snapshot to it. Null on a draft. No foreign key: the snapshot
       lives in the opamp-server''s own database, reached only through its
       API (ADR 0026). Fleets name a publication by it (D16, D17).';

    comment on constraint uq_configuration_versions_publication_id on configuration_versions is
      'one snapshot is one version''s: two versions can''t record the same
       publication. Nulls (drafts) don''t collide.';
    comment on constraint configuration_versions_published_by_user_id_fkey on configuration_versions is
      'the publisher is a user, or the row is refused (23503). On delete set
       null: a hard-deleted account leaves its published versions published,
       with no publisher, which the immutability trigger allows.';
    comment on constraint ck_configuration_versions_published_at_publication_id on configuration_versions is
      'published_at and publication_id are both set or both null (decision
       10): a version is published exactly when the opamp-server holds its
       snapshot under a recorded id. published_by_user_id is left out, since
       a deleted account leaves a published version with no publisher.';

    create index idx_configuration_versions_configuration_id_published
      on configuration_versions (configuration_id, organization_id)
      where published_at is not null;
    create index idx_configuration_versions_published_by_user_id
      on configuration_versions (published_by_user_id);

    comment on index idx_configuration_versions_configuration_id_published is
      'answers "is this configuration published" (D11b decision 1: a
       configuration is published when one of its versions is) from the
       published rows alone. Its columns are the composite foreign key''s, so
       the question names a configuration and its own organization.';
    comment on index idx_configuration_versions_published_by_user_id is
      'a hard-deleted account sets published_by_user_id to null here; without
       an index that would scan the table (as migration 016 indexed
       created_by_user_id).';

    -- Not SECURITY DEFINER: it reads only the row it is given, as whatever
    -- role runs the update. A fixed search_path all the same, as the
    -- definer functions here have, so nothing on a caller's path can stand
    -- in for an operator it uses. P0001 (raise_exception), as migration 001's
    -- append-only trigger raises: nothing branches on the SQLSTATE, since
    -- the API is to answer 409 configuration_version_published before an
    -- update gets here (decision 4).
    create function refuse_published_configuration_version_change() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if old.published_at is null then
        return new;
      end if;
      if new.id is distinct from old.id
         or new.configuration_id is distinct from old.configuration_id
         or new.organization_id is distinct from old.organization_id
         or new.version_number is distinct from old.version_number
         or new.created_at is distinct from old.created_at
         or new.yaml_content is distinct from old.yaml_content
         or new.nodes is distinct from old.nodes
         or new.edges is distinct from old.edges
         or new.pipelines is distinct from old.pipelines
         or new.label is distinct from old.label
         or new.published_at is distinct from old.published_at
         or new.publication_id is distinct from old.publication_id
         or (new.published_by_user_id is distinct from old.published_by_user_id
             and new.published_by_user_id is not null)
      then
        raise exception 'configuration version % is published and can''t be changed', old.id;
      end if;
      return new;
    end;
    $$;

    create trigger configuration_versions_published_immutable
      before update on configuration_versions
      for each row execute function refuse_published_configuration_version_change();

    comment on function refuse_published_configuration_version_change() is
      'the immutability of published versions (D11b decision 4), kept by the
       database and not just the API. On a published version (old.published_at
       set), refuses any change to its content, its publish record or its
       identity, raising P0001 with a message naming only the version''s id.
       created_by_user_id and updated_at stay free, and published_by_user_id
       may become null (the users foreign key''s on delete set null), but
       never another user. A same-value write passes. Not SECURITY DEFINER:
       it reads only the row it is given.';
    comment on trigger configuration_versions_published_immutable on configuration_versions is
      'before update, for every role on a plain UPDATE, the API''s and the
       tables'' owner alike: triggers have no owner exemption. Only an
       operator can bypass it: the owner with ALTER TABLE … DISABLE TRIGGER, a
       superuser with session_replication_role = replica. Update only: a
       hard-deleted configuration or organization still takes its published
       versions with it.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop trigger configuration_versions_published_immutable on configuration_versions;
    drop function refuse_published_configuration_version_change();
    drop index idx_configuration_versions_published_by_user_id;
    drop index idx_configuration_versions_configuration_id_published;

    alter table configuration_versions
      drop constraint ck_configuration_versions_published_at_publication_id,
      drop constraint uq_configuration_versions_publication_id,
      drop column published_at,
      drop column published_by_user_id,
      drop column publication_id;
  `);
};
