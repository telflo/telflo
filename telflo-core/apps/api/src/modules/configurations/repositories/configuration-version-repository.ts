import { sql, type Selectable, type Transaction } from "kysely";
import type { ConfigurationVersionsTable, Database } from "@telflo/db";
import { createOrganizationScope, type ScopedInsertable } from "../../../tenancy/organization-scope.js";
import { visibleTo, type ConfigurationCreator, type ConfigurationViewerContext } from "./configuration-repository.js";

/*
 * The versions of the context's organization's configurations: each holds a
 * configuration's YAML. Through the organization scope, with row-level
 * security on configuration_versions (migration 1700000000016) behind it: the
 * transaction must carry a database context naming the same organization, or
 * the policies show and admit nothing.
 *
 * A version has no deletion of its own, so it is reachable only through a
 * live configuration: every read and the save join `configurations` on
 * `(configuration_id, organization_id)`, the composite foreign key's
 * columns, and skip a deleted one. The policies don't hide a deleted
 * configuration's versions; the repository does.
 *
 * Every read and write also needs the configuration to be one the viewer
 * can see: theirs, or published. Within a visible configuration every
 * version is visible, drafts included. The rule is the configuration
 * repository's (`visibleTo`), which the policies apply too (migration
 * 1700000000021), so another member's draft's versions are as absent as an
 * unknown configuration's.
 *
 * Every version carries its creator's email, by the rule a configuration's
 * creator follows (configuration-repository.ts): a left join to `users`, with
 * no `users.deleted_at` filter, so a soft-deleted creator keeps their email
 * and a hard-deleted one leaves `createdBy` null. A version's publisher
 * follows the same rule. A write returns its row through a common table
 * expression, `written`, joined to `users` by a plain read that locks nothing
 * there.
 *
 * Every version carries whether the catalog has deprecated its collector
 * version since, and the catalog's note: an inner join to the global
 * `collector_versions` (no organization, no row-level security; the API's
 * role reads it), which the pin's foreign key guarantees a row for.
 *
 * Every timestamp comes from the caller, as `at`, never from SQL `now()`, as
 * the configurations' do. The YAML is private: nothing here logs it, nor
 * the graph, whose nodes carry copies of it. Labels are the user's text:
 * nothing here logs them either.
 */

/**
 * A version as the picker lists it: no content. Each field is also a
 * `ConfigurationVersion`'s.
 */
export interface ConfigurationVersionSummary {
  id: string;
  /** From 1, the highest of the configuration's plus one when created. */
  versionNumber: number;
  /** 1 to 80 characters, or null for an unnamed version, shown as "Version N". */
  label: string | null;
  /** Null when the creator's account is hard-deleted, or the version was made with no creator. */
  createdBy: ConfigurationCreator | null;
  createdAt: Date;
  /** The last save; a rename doesn't move it. */
  updatedAt: Date;
  /**
   * When it was published, from the API's clock; null on a draft. A published
   * version can't be changed.
   */
  publishedAt: Date | null;
  /**
   * Who published it, by `createdBy`'s rule: null on a draft, and once the
   * publisher's account is hard-deleted; a soft-deleted one keeps their
   * email.
   */
  publishedBy: ConfigurationCreator | null;
  /** The configuration's distribution. */
  collectorDistribution: string;
  /**
   * The collector version it is pinned to, a version of
   * `collectorDistribution` in the catalog, possibly deprecated since.
   */
  collectorVersion: string;
  /** Whether the catalog has deprecated `collectorVersion` since it was pinned. */
  collectorVersionDeprecated: boolean;
  /** The catalog's note on why, the deprecated pin's tooltip; null unless deprecated. */
  collectorVersionDeprecatedNote: string | null;
}

/** A version as the editor opens and saves it: its summary, its configuration and its content. */
export interface ConfigurationVersion extends ConfigurationVersionSummary {
  configurationId: string;
  /** Exactly as it was sent: nothing trims or normalizes it. */
  yamlContent: string;
  /**
   * The builder's layout, `[]` until a save writes it. Anything JSON at this
   * layer: the contract shapes it, and the editor reads what it can. jsonb
   * doesn't keep key order, so compare it as JSON.
   */
  nodes: unknown[];
  edges: unknown[];
  pipelines: unknown[];
}

/** A version's three graph columns, written together. */
export interface StoredGraph {
  nodes: unknown[];
  edges: unknown[];
  pipelines: unknown[];
}

/** A version's content: the text and the graph, written together. */
export interface SaveConfigurationVersionInput extends StoredGraph {
  yamlContent: string;
}

/**
 * What a save writes: the content, and the collector version when given, a
 * version of the configuration's distribution in the catalog (23503
 * otherwise); left out, the stored one stays. The service decides it: the one
 * stored, or a change it has checked the catalog offers.
 */
export interface SavedConfigurationVersion extends SaveConfigurationVersionInput {
  collectorVersion?: string | undefined;
}

/** Postgres's SQLSTATE for a check constraint's violation. */
const CHECK_VIOLATION = "23514";

/**
 * The graph columns' checks (migration 1700000000017): each an array, and at
 * most 4 MiB as `jsonb::text`, the backstop behind the contract's 1 MiB of
 * JSON.
 */
const STORED_GRAPH_CHECKS: ReadonlySet<string> = new Set(
  ["nodes", "edges", "pipelines"].flatMap((column) => [
    `ck_configuration_versions_${column}_array`,
    `ck_configuration_versions_${column}_size`,
  ]),
);

/**
 * True only for a violation of one of the six graph checks, which a save
 * within the contract can still hit (`1e300` is 6 bytes of JSON and 301 of
 * `jsonb::text`): the save answers it 400, never 500. Checked by name, as
 * the unique violations elsewhere are: any other check's violation is a bug.
 * The error's detail holds the failing row, content and all, so the caller
 * neither logs it nor passes it on.
 */
export function isStoredGraphCheckViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === CHECK_VIOLATION &&
    "constraint" in error &&
    typeof error.constraint === "string" &&
    STORED_GRAPH_CHECKS.has(error.constraint)
  );
}

export interface CreateConfigurationVersionInput {
  /**
   * A configuration of the context's organization the viewer can see.
   * Another organization's is refused (23503) by the composite foreign key,
   * another member's draft (42501) by row-level security (migration 021).
   */
  configurationId: string;
  versionNumber: number;
  /**
   * The version's name: the starter's "Initial version". Left out, or null,
   * the version is unnamed.
   */
  label?: string | null;
  /** Within its limit already: the contract does it, and the table refuses anything else. */
  yamlContent: string;
  /**
   * The builder's graph, written only when given: a configuration created
   * from a flow. Left out, the insert names no graph column and the
   * table's `[]` stands. A column the table's checks refuse fails with
   * 23514 (`isStoredGraphCheckViolation`).
   */
  graph?: StoredGraph | undefined;
  createdByUserId: string;
  /**
   * Its pin: the configuration's distribution and a version of it in the
   * catalog (23503 otherwise). A configuration's first version gets the
   * distribution's default, or the version its create named.
   */
  collectorDistribution: string;
  collectorVersion: string;
  /** The API's clock: both `created_at` and `updated_at`. */
  at: Date;
}

/** What `createNext` writes: the next number is the repository's to take. */
export interface CreateNextConfigurationVersionInput extends SaveConfigurationVersionInput {
  /** A configuration of the context's organization, which the caller holds `for update`. */
  configurationId: string;
  /** Trimmed, 1 to 80 characters, or null for none: the contract does it, and the table refuses anything else. */
  label: string | null;
  createdByUserId: string;
  /**
   * Its pin: the configuration's distribution and its source version's
   * collector version.
   */
  collectorDistribution: string;
  collectorVersion: string;
  /** The API's clock: both `created_at` and `updated_at`. */
  at: Date;
}

/** What a publish's record writes. */
export interface RecordPublishInput {
  /** The snapshot's `publishedAt`: the same clock read, so the two are equal to the millisecond. */
  publishedAt: Date;
  /** The id the snapshot was put under in the opamp-server. */
  publicationId: string;
  /** The caller, who published it. */
  publishedByUserId: string;
  /** The YAML the snapshot holds: the record writes only if the version still holds exactly this. */
  yamlContent: string;
  /** The label the snapshot holds (null for none): the record writes only if the version still has it. */
  label: string | null;
  /**
   * The collector version the snapshot holds: the record writes only if
   * the version is still pinned to it. The distribution needs no guard: a
   * configuration's is fixed (the database refuses a change), and its
   * versions share it.
   */
  collectorVersion: string;
}

/**
 * What the public API's configurations answer of their versions, read for many
 * configurations at once.
 */
export interface ConfigurationVersionFacts {
  /** The latest version: the highest number. */
  latestVersionId: string;
  latestVersionNumber: number;
  /** The latest version's collector version. */
  collectorVersion: string;
  /** The HIGHEST published number (the platform can publish several), or null when none is published. */
  publishedVersionNumber: number | null;
}

export interface IConfigurationVersionRepository {
  /**
   * The version the editor opens: the live configuration's version with the
   * highest number. Undefined when the configuration is deleted, isn't the
   * context's organization's, or has no version.
   */
  findOpened(configurationId: string): Promise<ConfigurationVersion | undefined>;
  /** That version, only if it belongs to that live configuration; undefined otherwise. */
  find(configurationId: string, versionId: string): Promise<ConfigurationVersion | undefined>;
  /**
   * That version's summary, without its content, only if it belongs to that
   * live configuration; undefined otherwise. For a check under the
   * configuration's lock that needs no YAML or graph (a create's source, a
   * rename's old label): those can be megabytes.
   */
  findSummary(configurationId: string, versionId: string): Promise<ConfigurationVersionSummary | undefined>;
  /**
   * The id of the live configuration's version numbered `versionNumber` (the
   * public API addresses versions by number); undefined when there is none,
   * or the configuration is deleted, isn't the context's organization's, or
   * isn't one the viewer can see.
   */
  findIdByNumber(configurationId: string, versionNumber: number): Promise<string | undefined>;
  /**
   * For each live configuration of `configurationIds` the viewer can see,
   * its latest version's id, number and collector version and its highest
   * published number, in one statement: no read per configuration. A
   * configuration it can't see, or a deleted one, is absent from the map.
   * No content is read.
   */
  listFacts(configurationIds: readonly string[]): Promise<Map<string, ConfigurationVersionFacts>>;
  /**
   * Every version of the live configuration, highest number first, without
   * content: no YAML or layout column is read. Only the published ones
   * when `publishedOnly`. Empty when the configuration is deleted or isn't
   * the context's organization's.
   */
  listSummaries(configurationId: string, options?: { publishedOnly?: boolean }): Promise<ConfigurationVersionSummary[]>;
  /**
   * A new version, created and updated `at`, its graph the one given, else
   * the table's `[]` (it is laid out on open). It doesn't check that the
   * configuration is live: the caller has just created it, or holds its
   * lock.
   */
  create(input: CreateConfigurationVersionInput): Promise<ConfigurationVersion>;
  /**
   * The live configuration's next version: numbered the highest of its
   * versions plus one, with the content and label given, created and updated
   * `at`. Undefined, writing nothing, when the configuration is deleted or
   * isn't the context's organization's. A read of the highest number, then the
   * insert: the caller holds the configuration `for update`, so no other
   * create comes between them, and the unique constraint is the backstop. A
   * graph column the table's checks refuse fails with 23514
   * (`isStoredGraphCheckViolation`).
   */
  createNext(input: CreateNextConfigurationVersionInput): Promise<ConfigurationVersion | undefined>;
  /**
   * Sets only the label of that version of a live configuration (not
   * `updated_at`), and returns its summary; undefined when there is none, it
   * belongs to another configuration, or the configuration is deleted. The
   * caller holds the configuration's lock.
   */
  rename(configurationId: string, versionId: string, label: string): Promise<ConfigurationVersionSummary | undefined>;
  /**
   * Sets the YAML, the graph, the collector version and `updated_at` to
   * `at` on that version of a live configuration, and returns the version
   * as it now is; undefined when there is none, it belongs to another
   * configuration, or the configuration is deleted. It writes even when
   * nothing changes. The caller holds the configuration's lock, and
   * passes an `at` past the version's `updated_at` (as the service's
   * saveVersion does). A graph column the table's checks refuse fails
   * with 23514 (`isStoredGraphCheckViolation`).
   */
  save(
    configurationId: string,
    versionId: string,
    input: SavedConfigurationVersion,
    at: Date,
  ): Promise<ConfigurationVersion | undefined>;
  /**
   * Records a publish on that version of a live configuration the viewer can
   * see, in one statement, and returns its summary as it now is. It writes
   * only a draft (`published_at is null`) whose YAML is still exactly
   * `input.yamlContent`, whose label is still `input.label` and whose
   * collector version is still `input.collectorVersion`, what the snapshot
   * holds; otherwise it writes nothing and answers undefined, and the caller
   * re-reads to say why. Neither `updated_at` moves: the version's is its last
   * save, and the configuration's is the caller's to touch. The caller holds
   * the configuration's lock.
   *
   * The only code that writes the three publish columns (a source scan,
   * publish-columns-source.test.ts, keeps it so).
   */
  recordPublish(
    configurationId: string,
    versionId: string,
    input: RecordPublishInput,
  ): Promise<ConfigurationVersionSummary | undefined>;
  /**
   * Whether a version of the context's organization records `publicationId`:
   * asked before the snapshot of a publish whose record failed is removed,
   * since a record whose commit's answer was lost may have committed. Any
   * configuration, live or deleted, and past the viewer's filter: row-level
   * security can't hide a recorded one anyway, since its configuration is
   * then published.
   */
  isPublicationRecorded(publicationId: string): Promise<boolean>;
}

/** A version's summary columns, joined to its creator's and its publisher's emails (null when either is gone). */
type SummaryRow = Pick<
  Selectable<ConfigurationVersionsTable>,
  | "id"
  | "version_number"
  | "label"
  | "created_by_user_id"
  | "created_at"
  | "updated_at"
  | "published_at"
  | "published_by_user_id"
  | "collector_distribution"
  | "collector_version"
> & {
  creator_email: string | null;
  publisher_email: string | null;
  collector_version_deprecated: boolean;
  collector_version_deprecated_note: string | null;
};

/** A whole version, joined to its creator's email. */
type VersionRow = SummaryRow &
  Pick<Selectable<ConfigurationVersionsTable>, "configuration_id" | "yaml_content" | "nodes" | "edges" | "pipelines">;

function toConfigurationVersionSummary(row: SummaryRow): ConfigurationVersionSummary {
  return {
    id: row.id,
    versionNumber: row.version_number,
    label: row.label,
    // The configuration's rule (configuration-repository.ts): null when the id or the email is.
    createdBy:
      row.created_by_user_id !== null && row.creator_email !== null
        ? { userId: row.created_by_user_id, email: row.creator_email }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    // The creator's rule again: null when the id or the email is.
    publishedBy:
      row.published_by_user_id !== null && row.publisher_email !== null
        ? { userId: row.published_by_user_id, email: row.publisher_email }
        : null,
    collectorDistribution: row.collector_distribution,
    collectorVersion: row.collector_version,
    collectorVersionDeprecated: row.collector_version_deprecated,
    // The note is the deprecation's: a version the catalog offers has none to show.
    collectorVersionDeprecatedNote: row.collector_version_deprecated ? row.collector_version_deprecated_note : null,
  };
}

function toConfigurationVersion(row: VersionRow): ConfigurationVersion {
  return {
    ...toConfigurationVersionSummary(row),
    configurationId: row.configuration_id,
    yamlContent: row.yaml_content,
    nodes: row.nodes,
    edges: row.edges,
    pipelines: row.pipelines,
  };
}

/** A summary's columns of a version: the table's own, qualified, since reads join `configurations`. */
const summaryColumns = [
  "configuration_versions.id",
  "configuration_versions.version_number",
  "configuration_versions.label",
  "configuration_versions.created_by_user_id",
  "configuration_versions.created_at",
  "configuration_versions.updated_at",
  "configuration_versions.published_at",
  "configuration_versions.published_by_user_id",
  "configuration_versions.collector_distribution",
  "configuration_versions.collector_version",
] as const;

/**
 * What a read joins: the creator's and the publisher's emails (by the same
 * rule for both), and whether the catalog deprecated the pin (`pins`).
 */
const emails = [
  "creators.email as creator_email",
  "publishers.email as publisher_email",
  "pins.deprecated as collector_version_deprecated",
  "pins.deprecated_note as collector_version_deprecated_note",
] as const;

/** What every method reads back of a whole version: the summary's columns and the content. */
const versionColumns = [
  ...summaryColumns,
  "configuration_versions.configuration_id",
  "configuration_versions.yaml_content",
  "configuration_versions.nodes",
  "configuration_versions.edges",
  "configuration_versions.pipelines",
] as const;

/**
 * A rename's summary columns from its written row (the common table
 * expression `written`), its creator and its publisher.
 */
const writtenSummaryWithCreator = [
  "written.id",
  "written.version_number",
  "written.label",
  "written.created_by_user_id",
  "written.created_at",
  "written.updated_at",
  "written.published_at",
  "written.published_by_user_id",
  "written.collector_distribution",
  "written.collector_version",
  ...emails,
] as const;

/** What a write reads back from its written row, its creator and its publisher. */
const writtenWithCreator = [
  ...writtenSummaryWithCreator,
  "written.configuration_id",
  "written.yaml_content",
  "written.nodes",
  "written.edges",
  "written.pipelines",
] as const;

/**
 * Bound to a transaction that carries the database context and to the
 * context it acts for: the organization it is scoped to and the viewer
 * whose drafts it shows. The database context must name the same two.
 */
export function createConfigurationVersionRepository(
  transaction: Transaction<Database>,
  context: ConfigurationViewerContext,
): IConfigurationVersionRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /**
   * The graph's columns as written: JSON text, since node-postgres would send
   * an array as a Postgres array literal, which jsonb refuses (22P02).
   */
  const graphColumns = ({ nodes, edges, pipelines }: StoredGraph) => ({
    nodes: JSON.stringify(nodes),
    edges: JSON.stringify(edges),
    pipelines: JSON.stringify(pipelines),
  });

  /** The columns a save sets. */
  const savedColumns = (input: SavedConfigurationVersion, at: Date) => ({
    yaml_content: input.yamlContent,
    ...graphColumns(input),
    ...(input.collectorVersion !== undefined && { collector_version: input.collectorVersion }),
    updated_at: at,
  });

  /**
   * The context's organization's versions of the live configurations the
   * viewer can see, each with its creator's and its publisher's emails. The
   * join is on both columns of the composite foreign key, so the
   * configuration it finds is the version's own, in the same organization
   * the scope filters the version to. The joins to `users` are left joins
   * with no `deleted_at` filter.
   */
  const ofLiveConfigurations = () =>
    scope
      .selectFrom("configuration_versions")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "configuration_versions.configuration_id")
          .onRef("configurations.organization_id", "=", "configuration_versions.organization_id"),
      )
      .leftJoin("users as creators", "creators.id", "configuration_versions.created_by_user_id")
      .leftJoin("users as publishers", "publishers.id", "configuration_versions.published_by_user_id")
      .innerJoin("collector_versions as pins", (join) =>
        join
          .onRef("pins.distribution", "=", "configuration_versions.collector_distribution")
          .onRef("pins.version", "=", "configuration_versions.collector_version"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  /**
   * The context's organization's versions of the live configurations the
   * viewer can see, as `ofLiveConfigurations` without its joins to `users`
   * and the catalog: for reads that need none of their columns.
   */
  const ofLiveConfigurationsOnly = () =>
    scope
      .selectFrom("configuration_versions")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "configuration_versions.configuration_id")
          .onRef("configurations.organization_id", "=", "configuration_versions.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  /**
   * Inserts the version through the scope and returns it with its creator's
   * email, in one statement: the insert is a common table expression, joined
   * to `users` by a plain read. The insert's own foreign-key checks take
   * `key share` on the configuration and the creator, as every insert does.
   */
  const insert = async (values: ScopedInsertable<"configuration_versions">): Promise<ConfigurationVersion> => {
    const row = await transaction
      .with("written", () => scope.insertInto("configuration_versions", values).returningAll())
      .selectFrom("written")
      .leftJoin("users as creators", "creators.id", "written.created_by_user_id")
      .leftJoin("users as publishers", "publishers.id", "written.published_by_user_id")
      .innerJoin("collector_versions as pins", (join) =>
        join
          .onRef("pins.distribution", "=", "written.collector_distribution")
          .onRef("pins.version", "=", "written.collector_version"),
      )
      .select(writtenWithCreator)
      .executeTakeFirstOrThrow();
    return toConfigurationVersion(row);
  };

  // An update joined to its configuration (`update … from`), so a deleted
  // configuration's version is not written. The joined row isn't locked:
  // the caller already holds the configuration `for update`.
  // Neither key column of the configuration's or the users' foreign keys
  // changes, so no check of theirs runs and nothing on `users` or
  // `configurations` is locked by one; the creator's email is a plain read
  // of the written row's. A changed collector version runs its foreign
  // key's check, which takes `key share` on that catalog row: only the
  // migration step writes the catalog.
  async function save(
    configurationId: string,
    versionId: string,
    input: SavedConfigurationVersion,
    at: Date,
  ): Promise<ConfigurationVersion | undefined> {
    const row = await transaction
      .with("written", () =>
        scope
          .updateTable("configuration_versions", savedColumns(input, at))
          .from("configurations")
          .whereRef("configurations.id", "=", "configuration_versions.configuration_id")
          .whereRef("configurations.organization_id", "=", "configuration_versions.organization_id")
          .where("configurations.deleted_at", "is", null)
          .where(visibleTo(viewer))
          .where("configuration_versions.id", "=", versionId)
          .where("configuration_versions.configuration_id", "=", configurationId)
          .returning(versionColumns),
      )
      .selectFrom("written")
      .leftJoin("users as creators", "creators.id", "written.created_by_user_id")
      .leftJoin("users as publishers", "publishers.id", "written.published_by_user_id")
      .innerJoin("collector_versions as pins", (join) =>
        join
          .onRef("pins.distribution", "=", "written.collector_distribution")
          .onRef("pins.version", "=", "written.collector_version"),
      )
      .select(writtenWithCreator)
      .executeTakeFirst();
    return row ? toConfigurationVersion(row) : undefined;
  }

  return {
    async findOpened(configurationId: string): Promise<ConfigurationVersion | undefined> {
      const row = await ofLiveConfigurations()
        .select([...versionColumns, ...emails])
        .where("configuration_versions.configuration_id", "=", configurationId)
        .orderBy("configuration_versions.version_number", "desc")
        .limit(1)
        .executeTakeFirst();
      return row ? toConfigurationVersion(row) : undefined;
    },

    async find(configurationId: string, versionId: string): Promise<ConfigurationVersion | undefined> {
      const row = await ofLiveConfigurations()
        .select([...versionColumns, ...emails])
        .where("configuration_versions.id", "=", versionId)
        .where("configuration_versions.configuration_id", "=", configurationId)
        .executeTakeFirst();
      return row ? toConfigurationVersion(row) : undefined;
    },

    async findSummary(configurationId: string, versionId: string): Promise<ConfigurationVersionSummary | undefined> {
      const row = await ofLiveConfigurations()
        .select([...summaryColumns, ...emails])
        .where("configuration_versions.id", "=", versionId)
        .where("configuration_versions.configuration_id", "=", configurationId)
        .executeTakeFirst();
      return row ? toConfigurationVersionSummary(row) : undefined;
    },

    async findIdByNumber(configurationId: string, versionNumber: number): Promise<string | undefined> {
      const row = await ofLiveConfigurationsOnly()
        .select("configuration_versions.id")
        .where("configuration_versions.configuration_id", "=", configurationId)
        .where("configuration_versions.version_number", "=", versionNumber)
        .executeTakeFirst();
      return row?.id;
    },

    // One statement for the whole page: each configuration's highest
    // version (`distinct on`, by number descending), with the highest
    // published number over the same configuration's rows (a window, so
    // computed before the `distinct on` keeps one row each).
    async listFacts(configurationIds: readonly string[]): Promise<Map<string, ConfigurationVersionFacts>> {
      const facts = new Map<string, ConfigurationVersionFacts>();
      if (configurationIds.length === 0) return facts;
      const rows = await ofLiveConfigurationsOnly()
        .distinctOn("configuration_versions.configuration_id")
        .select([
          "configuration_versions.configuration_id",
          "configuration_versions.id",
          "configuration_versions.version_number",
          "configuration_versions.collector_version",
          sql<number | null>`max(configuration_versions.version_number) filter (where configuration_versions.published_at is not null) over (partition by configuration_versions.configuration_id)`.as(
            "published_version_number",
          ),
        ])
        .where("configuration_versions.configuration_id", "in", [...configurationIds])
        .orderBy("configuration_versions.configuration_id")
        .orderBy("configuration_versions.version_number", "desc")
        .execute();
      for (const row of rows) {
        facts.set(row.configuration_id, {
          latestVersionId: row.id,
          latestVersionNumber: row.version_number,
          collectorVersion: row.collector_version,
          publishedVersionNumber: row.published_version_number,
        });
      }
      return facts;
    },

    async listSummaries(
      configurationId: string,
      { publishedOnly = false }: { publishedOnly?: boolean } = {},
    ): Promise<ConfigurationVersionSummary[]> {
      const rows = await ofLiveConfigurations()
        .select([...summaryColumns, ...emails])
        .where("configuration_versions.configuration_id", "=", configurationId)
        .$if(publishedOnly, (query) => query.where("configuration_versions.published_at", "is not", null))
        .orderBy("configuration_versions.version_number", "desc")
        .execute();
      return rows.map(toConfigurationVersionSummary);
    },

    async create({
      configurationId,
      versionNumber,
      label,
      yamlContent,
      graph,
      createdByUserId,
      collectorDistribution,
      collectorVersion,
      at,
    }: CreateConfigurationVersionInput): Promise<ConfigurationVersion> {
      return insert({
        configuration_id: configurationId,
        version_number: versionNumber,
        label: label ?? null,
        yaml_content: yamlContent,
        ...(graph !== undefined && graphColumns(graph)),
        created_by_user_id: createdByUserId,
        collector_distribution: collectorDistribution,
        collector_version: collectorVersion,
        created_at: at,
        updated_at: at,
      });
    },

    // `scope.insertInto` takes plain values only, so the number is read first,
    // through the scope and only for a live configuration (no row otherwise,
    // where a bare aggregate would answer 0), then inserted. The caller's lock
    // on the configuration keeps another create from coming between the two.
    async createNext({
      configurationId,
      label,
      yamlContent,
      nodes,
      edges,
      pipelines,
      createdByUserId,
      collectorDistribution,
      collectorVersion,
      at,
    }: CreateNextConfigurationVersionInput): Promise<ConfigurationVersion | undefined> {
      const highest = await scope
        .selectFrom("configurations")
        .leftJoin("configuration_versions", (join) =>
          join
            .onRef("configuration_versions.configuration_id", "=", "configurations.id")
            .onRef("configuration_versions.organization_id", "=", "configurations.organization_id"),
        )
        .select(sql<number>`coalesce(max(configuration_versions.version_number), 0)::integer`.as("highest"))
        .where("configurations.id", "=", configurationId)
        .where("configurations.deleted_at", "is", null)
        .where(visibleTo(viewer))
        .groupBy("configurations.id")
        .executeTakeFirst();
      if (highest === undefined) return undefined;
      return insert({
        configuration_id: configurationId,
        version_number: highest.highest + 1,
        label,
        yaml_content: yamlContent,
        ...graphColumns({ nodes, edges, pipelines }),
        created_by_user_id: createdByUserId,
        collector_distribution: collectorDistribution,
        collector_version: collectorVersion,
        created_at: at,
        updated_at: at,
      });
    },

    // As `save`: joined to its live configuration, setting only the label,
    // so no key column changes and no foreign-key check locks anything.
    async rename(
      configurationId: string,
      versionId: string,
      label: string,
    ): Promise<ConfigurationVersionSummary | undefined> {
      const row = await transaction
        .with("written", () =>
          scope
            .updateTable("configuration_versions", { label })
            .from("configurations")
            .whereRef("configurations.id", "=", "configuration_versions.configuration_id")
            .whereRef("configurations.organization_id", "=", "configuration_versions.organization_id")
            .where("configurations.deleted_at", "is", null)
            .where(visibleTo(viewer))
            .where("configuration_versions.id", "=", versionId)
            .where("configuration_versions.configuration_id", "=", configurationId)
            .returning(summaryColumns),
        )
        .selectFrom("written")
        .leftJoin("users as creators", "creators.id", "written.created_by_user_id")
        .leftJoin("users as publishers", "publishers.id", "written.published_by_user_id")
        .innerJoin("collector_versions as pins", (join) =>
          join
            .onRef("pins.distribution", "=", "written.collector_distribution")
            .onRef("pins.version", "=", "written.collector_version"),
        )
        .select(writtenSummaryWithCreator)
        .executeTakeFirst();
      return row ? toConfigurationVersionSummary(row) : undefined;
    },

    save,

    // As `save`: joined to its live configuration, setting only the three
    // publish columns. `published_by_user_id`'s foreign key takes `key
    // share` on the caller's account, which only a key change or a delete
    // of it waits for. The guards make the statement the whole check: a
    // concurrent publish that recorded first leaves `published_at` set, and
    // a save or a rename since the snapshot was taken leaves other text,
    // another label or another collector version; either way no row is
    // written. The label's guard is `is not distinct from`, so an unnamed
    // version (null) matches only null.
    //
    // Its row lock: setting `publication_id`, which has a unique constraint,
    // makes this update take FOR UPDATE on the version's row, not the FOR NO
    // KEY UPDATE a save or a rename takes (Postgres counts a column in a
    // unique index as part of a key). FOR UPDATE conflicts with KEY SHARE,
    // which a foreign key's check takes on the row it references. Nothing
    // references configuration_versions today, and every writer of it holds
    // the configuration's lock first (the lock order), so nothing waits on
    // it. A future foreign key to configuration_versions whose writes don't
    // take the configuration's lock first would wait on a record in
    // progress, for as long as the record's transaction runs. (Fleets don't
    // add one: they live in the opamp-server and name a published version by
    // its publication id.)
    async recordPublish(
      configurationId: string,
      versionId: string,
      { publishedAt, publicationId, publishedByUserId, yamlContent, label, collectorVersion }: RecordPublishInput,
    ): Promise<ConfigurationVersionSummary | undefined> {
      const row = await transaction
        .with("written", () =>
          scope
            .updateTable("configuration_versions", {
              published_at: publishedAt,
              publication_id: publicationId,
              published_by_user_id: publishedByUserId,
            })
            .from("configurations")
            .whereRef("configurations.id", "=", "configuration_versions.configuration_id")
            .whereRef("configurations.organization_id", "=", "configuration_versions.organization_id")
            .where("configurations.deleted_at", "is", null)
            .where(visibleTo(viewer))
            .where("configuration_versions.id", "=", versionId)
            .where("configuration_versions.configuration_id", "=", configurationId)
            .where("configuration_versions.published_at", "is", null)
            .where("configuration_versions.yaml_content", "=", yamlContent)
            .where("configuration_versions.label", "is not distinct from", label)
            .where("configuration_versions.collector_version", "=", collectorVersion)
            .returning(summaryColumns),
        )
        .selectFrom("written")
        .leftJoin("users as creators", "creators.id", "written.created_by_user_id")
        .leftJoin("users as publishers", "publishers.id", "written.published_by_user_id")
        .innerJoin("collector_versions as pins", (join) =>
          join
            .onRef("pins.distribution", "=", "written.collector_distribution")
            .onRef("pins.version", "=", "written.collector_version"),
        )
        .select(writtenSummaryWithCreator)
        .executeTakeFirst();
      return row ? toConfigurationVersionSummary(row) : undefined;
    },

    async isPublicationRecorded(publicationId: string): Promise<boolean> {
      const row = await scope
        .selectFrom("configuration_versions")
        .select("configuration_versions.id")
        .where("configuration_versions.publication_id", "=", publicationId)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
