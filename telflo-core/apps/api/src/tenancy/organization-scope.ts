import {
  sql,
  type DeleteQueryBuilder,
  type DeleteResult,
  type Insertable,
  type InsertQueryBuilder,
  type InsertResult,
  type SelectQueryBuilder,
  type Transaction,
  type Updateable,
  type UpdateQueryBuilder,
  type UpdateResult,
} from "kysely";
import type { Database } from "@telflo/db";
import type { AuthContext } from "../database/context.js";

/*
 * The organization scope (D5 decision 5; spec §3.7 item 2): the only way an
 * organization-scoped repository reaches its tables. Every select, update and
 * delete it builds is filtered to the context's organization, every insert
 * has the organization set, and no update can change it, so a repository
 * method has no way to name another organization or move a row into one. Row-level security (decision 3) is the backstop
 * behind it, on the tables that have it.
 */

/**
 * Each organization-owned table and the column naming its organization. A
 * table outside this map can't be passed to the scope (a compile error).
 * The tenant row is its own organization, so `organizations` is scoped by
 * `id`. A table added here also goes in the resource registry
 * (resource-registry.ts), whose suite checks it.
 */
export const organizationScopingColumns = {
  api_tokens: "organization_id",
  configuration_version_selections: "organization_id",
  configuration_versions: "organization_id",
  configurations: "organization_id",
  organization_invitations: "organization_id",
  organization_members: "organization_id",
  organizations: "id",
  quick_deploy_links: "organization_id",
  service_accounts: "organization_id",
  test_definition_inputs: "organization_id",
  test_definitions: "organization_id",
  test_input_files: "organization_id",
  test_runs: "organization_id",
  test_suites: "organization_id",
  validation_pipelines: "organization_id",
  validation_rules: "organization_id",
} as const satisfies { readonly [Table in keyof Database]?: keyof Database[Table] & string };

export type OrganizationScopedTable = keyof typeof organizationScopingColumns;

export type ScopingColumn<Table extends OrganizationScopedTable> = (typeof organizationScopingColumns)[Table];

/**
 * A row to insert through the scope. The scoping column may be left out,
 * and whatever it names is replaced with the context's organization.
 */
export type ScopedInsertable<Table extends OrganizationScopedTable> = Omit<
  Insertable<Database[Table]>,
  ScopingColumn<Table>
> & { [Column in ScopingColumn<Table>]?: string };

/**
 * The values of a scoped update. The scoping column is left out, so an
 * update can't move a row into another organization.
 */
export type ScopedUpdateable<Table extends OrganizationScopedTable> = Omit<
  Updateable<Database[Table]>,
  ScopingColumn<Table>
>;

/**
 * What the scope needs from the context: the organization it acts in. An
 * `AuthContext` is one. Creating an organization scopes its first
 * membership to the new organization, before any request acts in it.
 */
export type OrganizationScopeContext = Pick<AuthContext, "organizationId">;

/** Kysely's builder with nothing selected yet. */
type NoSelection = Record<never, never>;

export interface OrganizationScope {
  /** The organization every query is filtered to. */
  readonly organizationId: string;
  selectFrom<Table extends OrganizationScopedTable>(table: Table): SelectQueryBuilder<Database, Table, NoSelection>;
  /**
   * The update with its values already set and the filter added; the caller
   * adds further `where`s and `returning`. The values can't name the
   * scoping column.
   */
  updateTable<Table extends OrganizationScopedTable>(
    table: Table,
    values: ScopedUpdateable<Table>,
  ): UpdateQueryBuilder<Database, Table, Table, UpdateResult>;
  deleteFrom<Table extends OrganizationScopedTable>(table: Table): DeleteQueryBuilder<Database, Table, DeleteResult>;
  insertInto<Table extends OrganizationScopedTable>(
    table: Table,
    values: ScopedInsertable<Table> | readonly ScopedInsertable<Table>[],
  ): InsertQueryBuilder<Database, Table, InsertResult>;
}

/**
 * Builds the scope over a transaction that already carries the database
 * context (context.ts), so row-level security sees the same organization the
 * filters name.
 *
 * The filter is qualified with the table's name, so a repository can join
 * another table with a column of the same name (`id`) without making it
 * ambiguous. A builder's `where` calls are joined with `and`, so a repository
 * can narrow the filter but never widen it.
 */
export function createOrganizationScope(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): OrganizationScope {
  const { organizationId } = context;
  // The types already refuse another table; this refuses one cast past them.
  const scopingColumnOf = (table: OrganizationScopedTable): string => {
    if (!Object.hasOwn(organizationScopingColumns, table)) {
      throw new Error(`${table} is not an organization-scoped table`);
    }
    return organizationScopingColumns[table];
  };
  const scopingColumn = (table: OrganizationScopedTable) => sql.ref(`${table}.${scopingColumnOf(table)}`);

  return Object.freeze({
    organizationId,

    selectFrom<Table extends OrganizationScopedTable>(table: Table) {
      return transaction
        .selectFrom(table as OrganizationScopedTable)
        .where(scopingColumn(table), "=", organizationId) as unknown as SelectQueryBuilder<
        Database,
        Table,
        NoSelection
      >;
    },

    updateTable<Table extends OrganizationScopedTable>(table: Table, values: ScopedUpdateable<Table>) {
      // The types already leave the scoping column out; this refuses one cast past them.
      if (Object.hasOwn(values, scopingColumnOf(table))) {
        throw new Error(`a scoped update can't set ${table}.${scopingColumnOf(table)}`);
      }
      return transaction
        .updateTable(table as OrganizationScopedTable)
        .set(values as never)
        .where(scopingColumn(table), "=", organizationId) as unknown as UpdateQueryBuilder<
        Database,
        Table,
        Table,
        UpdateResult
      >;
    },

    deleteFrom<Table extends OrganizationScopedTable>(table: Table) {
      return transaction
        .deleteFrom(table as OrganizationScopedTable)
        .where(scopingColumn(table), "=", organizationId) as unknown as DeleteQueryBuilder<
        Database,
        Table,
        DeleteResult
      >;
    },

    insertInto<Table extends OrganizationScopedTable>(
      table: Table,
      values: ScopedInsertable<Table> | readonly ScopedInsertable<Table>[],
    ) {
      const rows = (Array.isArray(values) ? values : [values]) as readonly ScopedInsertable<Table>[];
      const scoped = rows.map((row) => ({ ...row, [scopingColumnOf(table)]: organizationId }));
      return transaction
        .insertInto(table as OrganizationScopedTable)
        .values(scoped as never) as unknown as InsertQueryBuilder<Database, Table, InsertResult>;
    },
  });
}
