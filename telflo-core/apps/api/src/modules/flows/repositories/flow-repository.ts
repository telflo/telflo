import type { Kysely, Selectable, Transaction, Updateable } from "kysely";
import type { FlowSignal, FlowSource } from "@telflo/contracts";
import type { Database, FlowsTable } from "@telflo/db";

/*
 * The flows (D12 decision 2; migration 1700000000026): one row per flow, no
 * history, a published switch.
 *
 * A global repository (ADR 0008; the resource registry's `kind: "global"`):
 * every organization, and every signed-out visitor, reads the same flows, so
 * there is no organization scope and no row-level security. The API's role
 * may read and write every row (migration 1700000000009's default
 * privileges); whether a caller may write is the service's question, and
 * `requireProductAdmin`'s (decision 3).
 *
 * Every list is in the gallery's order: `sort_order`, then the name, then
 * the slug, which is unique, so two flows of one order and name still have
 * one order.
 *
 * Every timestamp comes from the caller, as `at`, never from SQL `now()`, as
 * the configurations' do: the API's clock holds whole milliseconds.
 */

/** A flow, as the API's responses show it: the row's columns in camelCase, the YAML as `yaml`. */
export interface Flow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  source: FlowSource;
  authorName: string | null;
  authorUrl: string | null;
  signals: FlowSignal[];
  tags: string[];
  yaml: string;
  collectorDistribution: string;
  collectorVersion: string;
  sourceUrl: string | null;
  published: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A published flow's card (D12 decision 10): what a signed-out read may see. Never the YAML. */
export interface FlowCard {
  slug: string;
  name: string;
  summary: string;
  signals: FlowSignal[];
  tags: string[];
  authorName: string | null;
  updatedAt: Date;
}

/** The fields a write sets, by their API names. */
export interface FlowFields {
  slug: string;
  name: string;
  summary: string;
  description: string;
  signals: FlowSignal[];
  tags: string[];
  yaml: string;
  collectorDistribution: string;
  collectorVersion: string;
  sourceUrl: string | null;
  authorName: string | null;
  sortOrder: number;
  published: boolean;
}

/** A new flow: every field, its source and author link, and the API's clock for both timestamps. */
export interface NewFlow extends FlowFields {
  source: FlowSource;
  authorUrl: string | null;
  at: Date;
}

/** What a change sets; a field left out stays as it is. */
export type FlowChanges = Partial<FlowFields>;

/** Which flows a read may see: the published ones, and the hidden ones too for a product admin. */
export interface FlowVisibility {
  includeHidden: boolean;
}

export interface IFlowRepository {
  /** Every published flow's card, in the gallery's order. */
  listPublishedCards(): Promise<FlowCard[]>;
  /** Every flow `visibility` admits, in full, in the gallery's order. */
  list(visibility: FlowVisibility): Promise<Flow[]>;
  /** The flow with this slug, when `visibility` admits it. */
  findBySlug(slug: string, visibility: FlowVisibility): Promise<Flow | undefined>;
  /**
   * The flow with this id (a canonical UUID), locked `for update` until the
   * transaction ends, so two changes of one flow have exactly one order.
   */
  lockForUpdate(id: string): Promise<Flow | undefined>;
  /** Inserts it. A slug another flow has throws `FlowSlugTakenError`; the transaction is then aborted. */
  create(flow: NewFlow): Promise<Flow>;
  /**
   * Sets `changes` and `updated_at` to `at`. Undefined when no flow has the
   * id. A slug another flow has throws `FlowSlugTakenError`.
   */
  update(id: string, changes: FlowChanges, at: Date): Promise<Flow | undefined>;
  /** Deletes it for good (D12 decision 2), and returns it as it was; undefined when no flow has the id. */
  remove(id: string): Promise<Flow | undefined>;
}

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/** The flows' unique slug (migration 1700000000026). */
const SLUG_UNIQUE_CONSTRAINT = "uq_flows_slug";

/**
 * Thrown by `create` and `update` when another flow has the slug. Found by
 * the constraint's name, not just the SQLSTATE, as the organizations' name
 * clash is: a violation of any other unique index is a bug, and must surface
 * as one.
 */
export class FlowSlugTakenError extends Error {
  constructor() {
    super("another flow has that slug");
    this.name = "FlowSlugTakenError";
  }
}

function isSlugViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === SLUG_UNIQUE_CONSTRAINT
  );
}

async function withSlugClashAsError<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isSlugViolation(error)) throw new FlowSlugTakenError();
    throw error;
  }
}

/** The columns a card reads: never `yaml_content`. */
const CARD_COLUMNS = ["slug", "name", "summary", "signals", "tags", "author_name", "updated_at"] as const;

function toFlow(row: Selectable<FlowsTable>): Flow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    description: row.description,
    source: row.source,
    authorName: row.author_name,
    authorUrl: row.author_url,
    // Only the API writes these, and only signals its contract allows.
    signals: row.signals as FlowSignal[],
    tags: row.tags,
    yaml: row.yaml_content,
    collectorDistribution: row.collector_distribution,
    collectorVersion: row.collector_version,
    sourceUrl: row.source_url,
    published: row.published,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The columns `changes` sets, by the table's names. */
function toColumns(changes: FlowChanges): Updateable<FlowsTable> {
  const columns: Updateable<FlowsTable> = {};
  if (changes.slug !== undefined) columns.slug = changes.slug;
  if (changes.name !== undefined) columns.name = changes.name;
  if (changes.summary !== undefined) columns.summary = changes.summary;
  if (changes.description !== undefined) columns.description = changes.description;
  if (changes.signals !== undefined) columns.signals = changes.signals;
  if (changes.tags !== undefined) columns.tags = changes.tags;
  if (changes.yaml !== undefined) columns.yaml_content = changes.yaml;
  if (changes.collectorDistribution !== undefined) columns.collector_distribution = changes.collectorDistribution;
  if (changes.collectorVersion !== undefined) columns.collector_version = changes.collectorVersion;
  if (changes.sourceUrl !== undefined) columns.source_url = changes.sourceUrl;
  if (changes.authorName !== undefined) columns.author_name = changes.authorName;
  if (changes.sortOrder !== undefined) columns.sort_order = changes.sortOrder;
  if (changes.published !== undefined) columns.published = changes.published;
  return columns;
}

export function createFlowRepository(db: Kysely<Database> | Transaction<Database>): IFlowRepository {
  const ordered = () =>
    db.selectFrom("flows").orderBy("sort_order", "asc").orderBy("name", "asc").orderBy("slug", "asc");

  return {
    async listPublishedCards(): Promise<FlowCard[]> {
      const rows = await ordered().select(CARD_COLUMNS).where("published", "=", true).execute();
      return rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        summary: row.summary,
        signals: row.signals as FlowSignal[],
        tags: row.tags,
        authorName: row.author_name,
        updatedAt: row.updated_at,
      }));
    },

    async list(visibility: FlowVisibility): Promise<Flow[]> {
      let query = ordered().selectAll();
      if (!visibility.includeHidden) query = query.where("published", "=", true);
      return (await query.execute()).map(toFlow);
    },

    async findBySlug(slug: string, visibility: FlowVisibility): Promise<Flow | undefined> {
      let query = db.selectFrom("flows").selectAll().where("slug", "=", slug);
      if (!visibility.includeHidden) query = query.where("published", "=", true);
      const row = await query.executeTakeFirst();
      return row === undefined ? undefined : toFlow(row);
    },

    async lockForUpdate(id: string): Promise<Flow | undefined> {
      const row = await db.selectFrom("flows").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      return row === undefined ? undefined : toFlow(row);
    },

    async create(flow: NewFlow): Promise<Flow> {
      const row = await withSlugClashAsError(() =>
        db
          .insertInto("flows")
          .values({
            slug: flow.slug,
            name: flow.name,
            summary: flow.summary,
            description: flow.description,
            source: flow.source,
            author_name: flow.authorName,
            author_url: flow.authorUrl,
            signals: flow.signals,
            tags: flow.tags,
            yaml_content: flow.yaml,
            collector_distribution: flow.collectorDistribution,
            collector_version: flow.collectorVersion,
            source_url: flow.sourceUrl,
            published: flow.published,
            sort_order: flow.sortOrder,
            created_at: flow.at,
            updated_at: flow.at,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      return toFlow(row);
    },

    async update(id: string, changes: FlowChanges, at: Date): Promise<Flow | undefined> {
      const row = await withSlugClashAsError(() =>
        db
          .updateTable("flows")
          .set({ ...toColumns(changes), updated_at: at })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst(),
      );
      return row === undefined ? undefined : toFlow(row);
    },

    async remove(id: string): Promise<Flow | undefined> {
      const row = await db.deleteFrom("flows").where("id", "=", id).returningAll().executeTakeFirst();
      return row === undefined ? undefined : toFlow(row);
    },
  };
}
