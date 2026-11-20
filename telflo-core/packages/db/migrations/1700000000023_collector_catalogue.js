/**
 * The collector catalogue, a configuration's distribution and each
 * version's collector version.
 *
 *   * Two global tables hold the catalogue: collector_distributions (one
 *     row per distribution, exactly one the default) and collector_versions
 *     (one row per distribution and version, exactly one default per
 *     distribution, never a deprecated default). The migration step fills
 *     them from catalog/distributions/*.json after the migrations
 *     (packages/db/src/collector-catalogue/sync.ts); nothing else writes
 *     them. No organization column and no row-level security:
 *     every organization reads the same catalogue. Migration 009's default
 *     privileges gave telflo_platform_runtime select, insert, update and delete;
 *     insert, update and delete are revoked, so the API's role may only read
 *     them, and the tables' owner (the migration step) writes them. A
 *     version is never deleted, only deprecated, so an existing pin still
 *     resolves.
 *   * Then the Contrib distribution and its 0.162.0 row, with the
 *     catalogue's values at this migration (on conflict do nothing): the
 *     foreign keys below need them before the backfill, on a database that
 *     already holds configurations. The sync then finds nothing to change
 *     in either row.
 *   * configurations.collector_distribution: the distribution a
 *     configuration is built for, chosen when it is created and never
 *     changed. Every existing configuration becomes Contrib. The default is
 *     only for that backfill and is dropped, so a write that forgets the
 *     column fails (23502) instead of quietly taking a second default (one
 *     default, the catalogue's). unique (id, collector_distribution) is the
 *     composite target the versions reference (migrations 015 and 016's
 *     pattern).
 *   * configuration_versions.collector_distribution and collector_version: the
 *     version's pin. The distribution is the configuration's own, kept equal
 *     by a composite foreign key to configurations (id,
 *     collector_distribution), which cascades as the configuration's other one
 *     does; the pair is a version of the catalogue, by a composite foreign key
 *     to collector_versions, so a version can't name another distribution's
 *     version or an unknown one. Every existing version, published or not,
 *     becomes 0.162.0. Adding a column with a default fires no row trigger, so
 *     migration 020's guard leaves published versions to the backfill; every
 *     other column of theirs is untouched. Both defaults are dropped
 *     afterwards. The database accepts a deprecated version: whether a save
 *     may pick one is the API's decision.
 *   * Migration 020's refuse_published_configuration_version_change() is
 *     replaced, guarding both new columns too: a published version's
 *     collector version is as immutable as its content. It is replaced
 *     before anything could update a pin.
 *   * A before-update trigger, configurations_collector_distribution_unchanged,
 *     refuses any change to a configuration's distribution, in migration
 *     022's style: every role on a plain UPDATE, the tables' owner
 *     included, P0001, a message naming only the configuration's id, and a
 *     same-value write passes. The versions' composite foreign key would
 *     refuse the change anyway while the configuration has a version, but
 *     the trigger says so for every configuration.
 *   * Row-level security, migration 021's policies and migration 022's
 *     author trigger are unchanged; truncating configurations leaves the
 *     catalogue.
 *
 * down puts back migration 020's function and its comment exactly, then
 * drops the trigger and its function, the four columns and their
 * constraints, and the two tables. The catalogue's rows go with them; the
 * next migration step's up and sync write them again.
 */

/** The platforms a binary ships for, in the catalogue's order. */
const platforms = ["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64", "windows_amd64"];

const releases = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/";

/** 0.162.0's sha256 by binary and platform, from catalog/distributions/otelcol-contrib.json at this migration. */
const sha256 = {
  otelcolContrib: {
    linux_amd64: "fcc063749f730f8c21fe29f2d340ff174f5f1c5885bd3156fb6c985a3036fcc3",
    linux_arm64: "ecf6a917e2b53beb1703b19a84bc4e112a2fcaba549639cf6b0ba58446bfd7d2",
    darwin_amd64: "91a6e7a0f5e1981986c897db4535de5ba8d7fc45d4205809aecb9ebebf68c71c",
    darwin_arm64: "d5e11974d2e4adac3cc001a25137aad52f6e77ec3034ba7735cac7c219a5f97a",
    windows_amd64: "b371829181e89947a1a6570b8b6c38c20d85e2d215b76bf042f89b365b9e5c3d",
  },
  opampSupervisor: {
    linux_amd64: "905e81160405133f242035f96b1d0f0a572778dcf188ce93cb64e2b90b63d8c9",
    linux_arm64: "6b0a4a59673bf00ed2b0bac772f0a697f8f1f045163af46100a299b170835477",
    darwin_amd64: "6486d0e1c304b66214f18f8696e31142027423c3f782a159e825590a7363bc1c",
    darwin_arm64: "7177e0634a257577d1d4a452f4b947d9c55094e860aa77df08ed78bb891f0656",
    windows_amd64: "028a9a23666ce68711308eb43f7345efea80d46553196ff18a4a1c74d9bc9b3e",
  },
};

/** A binary map as the catalogue's file holds it, and so as the sync stores it: platform → { downloadUrl, sha256 }. */
const binaries = (binary, urlOf) =>
  JSON.stringify(
    Object.fromEntries(
      platforms.map((platform) => [platform, { downloadUrl: urlOf(platform), sha256: sha256[binary][platform] }]),
    ),
  );

const otelcolContrib = binaries(
  "otelcolContrib",
  (platform) => `${releases}v0.162.0/otelcol-contrib_0.162.0_${platform}.tar.gz`,
);
const opampSupervisor = binaries(
  "opampSupervisor",
  (platform) =>
    `${releases}cmd%2Fopampsupervisor%2Fv0.162.0/opampsupervisor_0.162.0_${platform}${platform.startsWith("windows_") ? ".exe" : ""}`,
);

/**
 * Migration 020's guard, with `guardedColumns` compared after the label.
 * With none, it is migration 020's function exactly, body and all, which
 * down puts back.
 */
const publishedGuard = (guardedColumns) => `
    create or replace function refuse_published_configuration_version_change() returns trigger
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
         or new.label is distinct from old.label${guardedColumns}
         or new.published_at is distinct from old.published_at
         or new.publication_id is distinct from old.publication_id
         or (new.published_by_user_id is distinct from old.published_by_user_id
             and new.published_by_user_id is not null)
      then
        raise exception 'configuration version % is published and can''t be changed', old.id;
      end if;
      return new;
    end;
    $$;`;

export const up = (pgm) => {
  pgm.sql(`
    create table collector_distributions (
      id           text     primary key,
      label        text     not null,
      description  text,
      icon         text,
      sort_order   integer  not null,
      is_default   boolean  not null,
      constraint ck_collector_distributions_id_format
        check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(id) <= 64),
      constraint ck_collector_distributions_label_present check (btrim(label) <> '')
    );

    comment on table collector_distributions is
      'the collector distributions a configuration can be built for:
       catalog/distributions/<id>.json''s header, written by the
       migration step''s sync and by nothing else. Global: no
       organization column, no row-level security; the API''s role may only
       read it. A distribution is never deleted.';
    comment on column collector_distributions.id is
      'the distribution''s id, its file''s name (otelcol-contrib): lowercase
       words joined by hyphens, at most 64 characters, the opamp-server''s
       format for a snapshot''s collector distribution.';
    comment on column collector_distributions.label is
      'the name pickers show (OpenTelemetry Collector Contrib).';
    comment on column collector_distributions.description is
      'a sentence pickers show under the label, or null.';
    comment on column collector_distributions.icon is
      'which icon the web shows for it (otel), or null for none.';
    comment on column collector_distributions.sort_order is
      'the catalogue''s order, ascending, the id breaking ties.';
    comment on column collector_distributions.is_default is
      'the distribution a new configuration gets when it names none
       (one default, read from the catalogue). Exactly one
       (uq_collector_distributions_one_default).';
    comment on constraint collector_distributions_pkey on collector_distributions is
      'one row per distribution, by its id; what configurations and the
       catalogue''s versions reference.';
    comment on constraint ck_collector_distributions_id_format on collector_distributions is
      'the catalogue validator''s and the opamp-server''s format for a
       distribution id, as a backstop behind the validator.';
    comment on constraint ck_collector_distributions_label_present on collector_distributions is
      'a distribution has a name to show.';

    create unique index uq_collector_distributions_one_default
      on collector_distributions ((true)) where is_default;

    comment on index uq_collector_distributions_one_default is
      'at most one default distribution; the validator requires exactly
       one. The sync clears a default before it sets the next one, since
       this is checked row by row.';

    create table collector_versions (
      distribution             text     not null references collector_distributions(id),
      version                  text     not null,
      label                    text     not null,
      description              text,
      released_at              date     not null,
      is_default               boolean  not null,
      deprecated               boolean  not null,
      deprecated_note          text,
      container_image          text     not null,
      otelcol_contrib_version  text,
      supported_components     jsonb,
      otelcol_contrib          jsonb    not null,
      opamp_supervisor         jsonb    not null,
      primary key (distribution, version),
      constraint ck_collector_versions_version_format check (version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'),
      constraint ck_collector_versions_default_not_deprecated check (not (is_default and deprecated)),
      constraint ck_collector_versions_deprecated_note
        check (not deprecated or coalesce(btrim(deprecated_note), '') <> '')
    );

    comment on table collector_versions is
      'each distribution''s versions, from
       catalog/distributions/<distribution>.json''s versions, written by the
       migration step''s sync and by nothing else. Global: no
       organization column, no row-level security; the API''s role may only
       read it. A version is never deleted, only deprecated, so a pin to it
       still resolves.';
    comment on column collector_versions.distribution is
      'the distribution it is a version of.';
    comment on column collector_versions.version is
      'major.minor.patch (0.162.0), the opamp-server''s format for a
       snapshot''s collector version.';
    comment on column collector_versions.label is
      'what pickers show (v0.162.0).';
    comment on column collector_versions.description is
      'a note pickers show beside the label (Current default.), or null.';
    comment on column collector_versions.released_at is
      'the upstream release''s date (UTC); pickers show newest first by
       version.';
    comment on column collector_versions.is_default is
      'the version a distribution''s new configuration starts at. Exactly one
       per distribution (uq_collector_versions_one_default), never a
       deprecated one.';
    comment on column collector_versions.deprecated is
      'retired: hidden from pickers, refused by a save that changes a pin to
       it, but a pin already on it stays and is shown as deprecated.';
    comment on column collector_versions.deprecated_note is
      'why it was retired, the deprecated pin''s tooltip: required when
       deprecated.';
    comment on column collector_versions.container_image is
      'the image this version runs as (otel/opentelemetry-collector-contrib:0.162.0).';
    comment on column collector_versions.otelcol_contrib_version is
      'the Contrib release a non-Contrib build is based on, or null for
       Contrib itself.';
    comment on column collector_versions.supported_components is
      'the components the distribution supports, by section (receivers,
       processors, exporters, connectors, extensions), which the palette
       filters by; null for the full palette (Contrib).';
    comment on column collector_versions.otelcol_contrib is
      'the collector binary''s downloads, as the catalogue''s file holds
       them: { "<platform>": { "downloadUrl", "sha256" } }; {} for a
       container-only distribution. Only the catalogue''s upstream release
       URLs (the validator''s rule).';
    comment on column collector_versions.opamp_supervisor is
      'the OpAMP supervisor''s downloads, in otelcol_contrib''s shape.';
    comment on constraint collector_versions_pkey on collector_versions is
      'one row per distribution and version: the pair a configuration
       version''s pin references (fk_configuration_versions_collector_version).';
    comment on constraint ck_collector_versions_version_format on collector_versions is
      'the validator''s and the opamp-server''s version format, as a backstop
       behind the validator.';
    comment on constraint ck_collector_versions_default_not_deprecated on collector_versions is
      'the default is offered to new configurations, so it can''t be
       deprecated.';
    comment on constraint ck_collector_versions_deprecated_note on collector_versions is
      'a deprecated version says why: the deprecated pin shows the note.';
    comment on constraint collector_versions_distribution_fkey on collector_versions is
      'a version belongs to a distribution of the catalogue. Distributions
       are never deleted, so nothing cascades.';

    create unique index uq_collector_versions_one_default
      on collector_versions (distribution) where is_default;

    comment on index uq_collector_versions_one_default is
      'at most one default version per distribution; the validator requires
       exactly one. The sync clears a default before it sets the next one,
       since this is checked row by row.';

    revoke insert, update, delete on collector_distributions, collector_versions from telflo_platform_runtime;

    insert into collector_distributions (id, label, description, icon, sort_order, is_default)
    values ('otelcol-contrib', 'OpenTelemetry Collector Contrib',
            'The full upstream component catalog. Pick this unless your collectors run a specific vendor build.',
            'otel', 0, true)
    on conflict do nothing;

    insert into collector_versions
      (distribution, version, label, description, released_at, is_default, deprecated, deprecated_note,
       container_image, otelcol_contrib_version, supported_components, otelcol_contrib, opamp_supervisor)
    values ('otelcol-contrib', '0.162.0', 'v0.162.0', 'Current default.', '2026-09-29', true, false, null,
            'otel/opentelemetry-collector-contrib:0.162.0', null, null,
            '${otelcolContrib}'::jsonb,
            '${opampSupervisor}'::jsonb)
    on conflict do nothing;

    alter table configurations
      add column collector_distribution text not null default 'otelcol-contrib',
      add constraint fk_configurations_collector_distribution
        foreign key (collector_distribution) references collector_distributions (id),
      add constraint uq_configurations_id_collector_distribution unique (id, collector_distribution);
    alter table configurations alter column collector_distribution drop default;

    comment on column configurations.collector_distribution is
      'the distribution the configuration is built for:
       chosen when it is created, the catalogue''s default when none is
       named, and never changed (configurations_collector_distribution_unchanged).
       No default: the API always writes it, so there is no second default
       beside the catalogue''s. Configurations that existed before this
       column are Contrib.';
    comment on constraint fk_configurations_collector_distribution on configurations is
      'a configuration is built for a distribution of the catalogue (23503
       otherwise).';
    comment on constraint uq_configurations_id_collector_distribution on configurations is
      'the composite foreign-key target the configuration''s versions
       reference with their own collector_distribution, so a version''s
       distribution is always its configuration''s. id alone is already
       unique.';

    alter table configuration_versions
      add column collector_distribution text not null default 'otelcol-contrib',
      add column collector_version text not null default '0.162.0',
      add constraint fk_configuration_versions_configuration_distribution
        foreign key (configuration_id, collector_distribution)
        references configurations (id, collector_distribution) on delete cascade,
      add constraint fk_configuration_versions_collector_version
        foreign key (collector_distribution, collector_version)
        references collector_versions (distribution, version);
    alter table configuration_versions
      alter column collector_distribution drop default,
      alter column collector_version drop default;

    comment on column configuration_versions.collector_distribution is
      'the configuration''s distribution, copied onto the version so that
       (collector_distribution, collector_version) can reference the
       catalogue; fk_configuration_versions_configuration_distribution keeps
       it equal to the configuration''s. No default: the API always writes
       it.';
    comment on column configuration_versions.collector_version is
      'the collector version the version is pinned to: a
       version of the configuration''s distribution in the catalogue. A
       configuration''s first version gets the distribution''s default, a
       new version its source''s. A pin to a version deprecated since
       stays. Immutable once published (the trigger
       configuration_versions_published_immutable). No default: the API
       always writes it. Versions that existed before this column are
       0.162.0, published ones included.';
    comment on constraint fk_configuration_versions_configuration_distribution on configuration_versions is
      'a version''s distribution is its configuration''s (migrations 015
       and 016''s composite target). Cascades as
       fk_configuration_versions_configuration does: a hard-deleted
       configuration takes its versions.';
    comment on constraint fk_configuration_versions_collector_version on configuration_versions is
      'a version is pinned to a version of its own distribution in the
       catalogue: another distribution''s version, or an unknown one, is
       refused (23503), even for the owner. A deprecated one is accepted
       here; the API decides whether a save may pick it. Catalogue versions
       are never deleted, so nothing cascades.';

    ${publishedGuard(`
         or new.collector_distribution is distinct from old.collector_distribution
         or new.collector_version is distinct from old.collector_version`)}

    comment on function refuse_published_configuration_version_change() is
      'the immutability of published versions, kept by the database and not
       just the API. On a published version (old.published_at set), refuses
       any change to its content (its collector pin included), its publish
       record or its identity, raising P0001
       with a message naming only the version''s id. created_by_user_id and
       updated_at stay free, and published_by_user_id may become null (the
       users foreign key''s on delete set null), but never another user. A
       same-value write passes. Not SECURITY DEFINER: it reads only the row
       it is given.';

    -- Not SECURITY DEFINER: it reads only the row it is given, as whatever
    -- role runs the update. A fixed search_path all the same, as migration
    -- 022's trigger function has. P0001 (raise_exception), as that one
    -- raises: nothing branches on it, since the API never writes the
    -- column after the insert.
    create function refuse_configuration_distribution_change() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if new.collector_distribution is distinct from old.collector_distribution then
        raise exception 'configuration % keeps its collector distribution', old.id;
      end if;
      return new;
    end;
    $$;

    create trigger configurations_collector_distribution_unchanged
      before update on configurations
      for each row execute function refuse_configuration_distribution_change();

    comment on function refuse_configuration_distribution_change() is
      'a configuration keeps the distribution it was created for, kept by
       the database and not just the API. Refuses any
       change of collector_distribution, raising P0001 with a message naming
       only the configuration''s id. A same-value write passes. Not SECURITY
       DEFINER: it reads only the row it is given.';
    comment on trigger configurations_collector_distribution_unchanged on configurations is
      'before update, for every role on a plain UPDATE, the API''s and the
       tables'' owner alike: triggers have no owner exemption. Only an
       operator can bypass it: the owner with ALTER TABLE … DISABLE TRIGGER, a
       superuser with session_replication_role = replica.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ${publishedGuard("")}

    comment on function refuse_published_configuration_version_change() is
      'the immutability of published versions, kept by the database and not
       just the API. On a published version (old.published_at set), refuses
       any change to its content, its publish record or its
       identity, raising P0001 with a message naming only the version''s id.
       created_by_user_id and updated_at stay free, and published_by_user_id
       may become null (the users foreign key''s on delete set null), but
       never another user. A same-value write passes. Not SECURITY DEFINER:
       it reads only the row it is given.';

    drop trigger configurations_collector_distribution_unchanged on configurations;
    drop function refuse_configuration_distribution_change();

    alter table configuration_versions
      drop constraint fk_configuration_versions_collector_version,
      drop constraint fk_configuration_versions_configuration_distribution,
      drop column collector_version,
      drop column collector_distribution;

    alter table configurations
      drop constraint uq_configurations_id_collector_distribution,
      drop constraint fk_configurations_collector_distribution,
      drop column collector_distribution;

    drop table collector_versions;
    drop table collector_distributions;
  `);
};
