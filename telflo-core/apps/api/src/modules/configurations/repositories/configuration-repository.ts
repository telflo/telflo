import { sql, type RawBuilder, type Selectable, type Transaction } from "kysely";
import type { ConfigurationsListFilter } from "@telflo/contracts";
import type { ConfigurationsTable, Database } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope, type ScopedUpdateable } from "../../../tenancy/organization-scope.js";

/*
 * The configurations of the context's organization, through the organization
 * scope. Row-level security on configurations (migration 1700000000015)
 * stands behind it: the transaction must carry a database context naming the
 * same organization, or the policies show and admit nothing.
 *
 * Every method ignores a deleted configuration: the policies don't hide one,
 * so the repository does.
 *
 * Every method sees only what its viewer may: their own drafts and every
 * published configuration, by the rule the policies apply (migration
 * 1700000000021), so the list, `find` and every write agree with row-level
 * security. Another member's draft is as absent as a configuration that
 * doesn't exist. "Published" is the policies' own helper,
 * `configuration_is_published`, so the two can't drift apart.
 *
 * Every timestamp comes from the caller, as `at`, never from SQL `now()`:
 * the API's clock holds whole milliseconds, so a timestamp written here
 * reads back equal to the JavaScript Date the list's cursor carries.
 */

/** Who created a configuration: their account's email, whether or not the account is soft-deleted. */
export interface ConfigurationCreator {
  userId: string;
  email: string;
}

/**
 * Whom a repository reads and writes for: the organization it is scoped to,
 * and the viewer whose drafts it shows. An `AuthContext` is one.
 */
export type ConfigurationViewerContext = Pick<AuthContext, "organizationId" | "userId">;

/** A live configuration, as the list and the API's responses show it. */
export interface Configuration {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  /** Null once the creator's account is hard-deleted. */
  createdBy: ConfigurationCreator | null;
  /** True when at least one of its versions is published; else it is a draft. */
  published: boolean;
  /** The catalog distribution it is built for, chosen when it was created and never changed. */
  collectorDistribution: string;
}

/**
 * A live configuration as `lockForUpdate` returns it: its own columns only,
 * what a change's checks and diff need. No creator's email: that would need
 * the join a lock must not take.
 */
export interface LockedConfiguration {
  id: string;
  name: string;
  description: string;
  /** Null once the creator's account is hard-deleted. */
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Its distribution: what a version's pin must be a version of. */
  collectorDistribution: string;
}

/** Where a page continues: strictly after this row in the list's order. */
export interface ConfigurationPagePosition {
  updatedAt: Date;
  id: string;
}

export interface ListConfigurationsInput {
  /** At most this many items. The caller bounds it (1 to 100). */
  limit: number;
  /** The last item of the previous page; the page holds the rows strictly after it. */
  after?: ConfigurationPagePosition;
  /** Matched, ignoring case, as a substring of the name or the description. `%`, `_` and `\` match themselves. */
  search?: string;
  /**
   * Every configuration the viewer can see (`all`, the default), only the
   * ones they created (`mine`), or only the published ones (`published`).
   */
  filter?: ConfigurationsListFilter;
}

export interface ConfigurationPage {
  items: Configuration[];
  /** True when at least one more row follows the last item. */
  hasMore: boolean;
}

export interface CreateConfigurationInput {
  /** Trimmed and within its limits already: the contract does it, and the table refuses anything else. */
  name: string;
  description: string;
  createdByUserId: string;
  /**
   * The distribution it is built for, a distribution of the catalog
   * (23503 otherwise): the catalog's default, read in the same
   * transaction. Never changed afterwards.
   */
  collectorDistribution: string;
  /**
   * The flow it was made from, its slug's format checked by the contract;
   * no foreign key (a flow may be deleted). Left out, the insert names no
   * such column and it stays null. Never read back.
   */
  sourceFlowSlug?: string | undefined;
  /** The API's clock: both `created_at` and `updated_at`. */
  at: Date;
}

/** What a change sets; a field left out stays as it is. */
export interface ConfigurationChanges {
  name?: string;
  description?: string;
}

/*
 * "Undefined when there is none" below includes a configuration the viewer
 * can't see (another member's draft), and a write changes none: to its
 * viewer it doesn't exist.
 */
export interface IConfigurationRepository {
  /**
   * A page of the live configurations the viewer can see, `updated_at`
   * descending then `id` descending, with each creator's email.
   */
  listPage(input: ListConfigurationsInput): Promise<ConfigurationPage>;
  /** The live configuration, with its creator's email; undefined when there is none or it is deleted. */
  find(id: string): Promise<Configuration | undefined>;
  /**
   * The live configuration, locked `for update` until the transaction ends;
   * undefined when there is none or it is deleted. Only the configuration's
   * row is locked. The caller has already locked the organization (decision
   * 9). Under row-level security a locking read applies the update policy,
   * so the context must name this organization and the viewer.
   */
  lockForUpdate(id: string): Promise<LockedConfiguration | undefined>;
  /** A new configuration, created and updated `at`. */
  create(input: CreateConfigurationInput): Promise<Configuration>;
  /**
   * Sets the given fields and `updated_at` to `at` on a live configuration,
   * and returns it as it now is; undefined when there is none or it is
   * deleted. It writes even when the values are the ones already there:
   * whether anything changed is the caller's decision.
   */
  update(id: string, changes: ConfigurationChanges, at: Date): Promise<Configuration | undefined>;
  /**
   * Sets only `updated_at` to `at` on a live configuration: a save of its
   * YAML moves it to the top of the list. False when there is none or it
   * is deleted.
   */
  touch(id: string, at: Date): Promise<boolean>;
  /** Deletes a live configuration softly, `at`. False when there is none or it is already deleted. */
  markDeleted(id: string, at: Date): Promise<boolean>;
}

/**
 * `text` with `\`, `%` and `_` escaped, so that inside a `like` or `ilike`
 * pattern with `escape '\'` each matches only itself.
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * A configuration row as a read or write returns it, joined to its creator's
 * email (null when the creator is gone), with whether it is published.
 */
type RowWithCreator = Pick<
  Selectable<ConfigurationsTable>,
  "id" | "name" | "description" | "created_at" | "updated_at" | "created_by_user_id" | "collector_distribution"
> & { creator_email: string | null; published: boolean };

function toConfiguration(row: RowWithCreator): Configuration {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy:
      row.created_by_user_id !== null && row.creator_email !== null
        ? { userId: row.created_by_user_id, email: row.creator_email }
        : null,
    published: row.published,
    collectorDistribution: row.collector_distribution,
  };
}

/**
 * Whether `table`'s row, a configurations row, is published: the policies'
 * helper (migration 1700000000021), which answers for the context's
 * organization only.
 */
export function isPublished(table: "configurations" | "written"): RawBuilder<boolean> {
  return sql<boolean>`configuration_is_published(${sql.ref(`${table}.id`)}, ${sql.ref(`${table}.organization_id`)})`;
}

/**
 * Whether the viewer can see `table`'s row: they created it, or it is
 * published. The select policy's rule, so a read here never finds what
 * row-level security would hide, nor misses what it would show.
 */
export function visibleTo(userId: string, table: "configurations" | "written" = "configurations"): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(`${table}.created_by_user_id`)} = ${userId} or ${isPublished(table)})`;
}

function toLockedConfiguration(row: Selectable<ConfigurationsTable>): LockedConfiguration {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    collectorDistribution: row.collector_distribution,
  };
}

/**
 * What `create` and `update` read back from their written row (the common
 * table expression `written`) and its creator. Whether it is published is
 * read in the same statement, which sees the versions as they were before
 * it: neither write changes a version.
 */
const writtenWithCreator = [
  "written.id",
  "written.name",
  "written.description",
  "written.created_at",
  "written.updated_at",
  "written.created_by_user_id",
  "written.collector_distribution",
  "users.email as creator_email",
  isPublished("written").as("published"),
] as const;

/**
 * Bound to a transaction that carries the database context and to the
 * context it acts for: the organization it is scoped to and the viewer
 * whose drafts it shows. The database context must name the same two.
 */
export function createConfigurationRepository(
  transaction: Transaction<Database>,
  context: ConfigurationViewerContext,
): IConfigurationRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /**
   * The live configurations the viewer can see, with their creator's email
   * and whether they are published. A left join: a hard-deleted creator
   * leaves `created_by_user_id` null, and a published row still lists.
   * `users.deleted_at` isn't filtered: a soft-deleted creator keeps their
   * email here.
   */
  const live = () =>
    scope
      .selectFrom("configurations")
      .leftJoin("users", "users.id", "configurations.created_by_user_id")
      .select([
        "configurations.id",
        "configurations.name",
        "configurations.description",
        "configurations.created_at",
        "configurations.updated_at",
        "configurations.created_by_user_id",
        "configurations.collector_distribution",
        "users.email as creator_email",
        isPublished("configurations").as("published"),
      ])
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  /**
   * Sets `values` on the live configuration and returns it with its
   * creator's email, in one statement: the update is a common table
   * expression, joined to `users` by a plain read that locks nothing there.
   */
  const updateLive = async (
    id: string,
    values: ScopedUpdateable<"configurations">,
  ): Promise<Configuration | undefined> => {
    const row = await transaction
      .with("written", () =>
        scope
          .updateTable("configurations", values)
          .where("id", "=", id)
          .where("deleted_at", "is", null)
          .where(visibleTo(viewer))
          .returningAll(),
      )
      .selectFrom("written")
      .leftJoin("users", "users.id", "written.created_by_user_id")
      .select(writtenWithCreator)
      .executeTakeFirst();
    return row ? toConfiguration(row) : undefined;
  };

  return {
    async listPage({ limit, after, search, filter = "all" }: ListConfigurationsInput): Promise<ConfigurationPage> {
      let query = live();
      if (after !== undefined) {
        // A row comparison: strictly after the pair, so rows sharing its
        // updated_at but with a lower id still follow. The list's partial
        // index serves it.
        query = query.where(({ eb, refTuple, tuple }) =>
          eb(refTuple("configurations.updated_at", "configurations.id"), "<", tuple(after.updatedAt, after.id)),
        );
      }
      if (search !== undefined && search !== "") {
        const pattern = `%${escapeLikePattern(search)}%`;
        // The template's '\\' reaches SQL as '\', the one-character escape.
        query = query.where(
          sql<boolean>`(configurations.name ilike ${pattern} escape '\\' or configurations.description ilike ${pattern} escape '\\')`,
        );
      }
      if (filter === "mine") {
        query = query.where("configurations.created_by_user_id", "=", viewer);
      } else if (filter === "published") {
        query = query.where(isPublished("configurations"));
      }
      const rows = await query
        .orderBy("configurations.updated_at", "desc")
        .orderBy("configurations.id", "desc")
        .limit(limit + 1)
        .execute();
      return { items: rows.slice(0, limit).map(toConfiguration), hasMore: rows.length > limit };
    },

    async find(id: string): Promise<Configuration | undefined> {
      const row = await live().where("configurations.id", "=", id).executeTakeFirst();
      return row ? toConfiguration(row) : undefined;
    },

    // No join: `for update` over the list's left join to users is refused
    // ("FOR UPDATE cannot be applied to the nullable side of an outer
    // join"), and over an inner join it would lock the creator's account
    // too, holding up their sign-in and adding a configuration -> user lock.
    // Under row-level security a locking read applies the update policy, so
    // the context must name this organization, as the scope's filter does.
    async lockForUpdate(id: string): Promise<LockedConfiguration | undefined> {
      const row = await scope
        .selectFrom("configurations")
        .selectAll()
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .where(visibleTo(viewer))
        .forUpdate()
        .executeTakeFirst();
      return row ? toLockedConfiguration(row) : undefined;
    },

    async create({
      name,
      description,
      createdByUserId,
      collectorDistribution,
      sourceFlowSlug,
      at,
    }: CreateConfigurationInput): Promise<Configuration> {
      const row = await transaction
        .with("written", () =>
          scope
            .insertInto("configurations", {
              name,
              description,
              created_by_user_id: createdByUserId,
              collector_distribution: collectorDistribution,
              ...(sourceFlowSlug !== undefined && { source_flow_slug: sourceFlowSlug }),
              created_at: at,
              updated_at: at,
            })
            .returningAll(),
        )
        .selectFrom("written")
        .leftJoin("users", "users.id", "written.created_by_user_id")
        .select(writtenWithCreator)
        .executeTakeFirstOrThrow();
      return toConfiguration(row);
    },

    async update(id: string, changes: ConfigurationChanges, at: Date): Promise<Configuration | undefined> {
      // Named one by one, so nothing else a caller's object carries is written.
      return updateLive(id, {
        ...(changes.name !== undefined && { name: changes.name }),
        ...(changes.description !== undefined && { description: changes.description }),
        updated_at: at,
      });
    },

    async touch(id: string, at: Date): Promise<boolean> {
      const result = await scope
        .updateTable("configurations", { updated_at: at })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .where(visibleTo(viewer))
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async markDeleted(id: string, at: Date): Promise<boolean> {
      const result = await scope
        .updateTable("configurations", { deleted_at: at, updated_at: at })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .where(visibleTo(viewer))
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },
  };
}
