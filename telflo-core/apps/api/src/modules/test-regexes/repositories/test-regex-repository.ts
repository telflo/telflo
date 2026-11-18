import type { Kysely, Selectable, Transaction } from "kysely";
import type { Database, TestRegexTable } from "@telflo/db";

/*
 * The regex library (D15b decisions 7 and 8; Preflight rulings 1 and 3;
 * migration 1700000000031): named regex patterns the validation-rule picker
 * offers.
 *
 * A global repository (ADR 0008; the resource registry's `kind: "global"`),
 * as test templates': every organization picks from the same entries, so
 * there is no organization scope and no row-level security. Whether a
 * caller may write is the service's question (product admins only,
 * requireProductAdmin on the routes). An entry is deleted for good (nothing
 * references one: a rule copies the regex, never the id).
 *
 * Every timestamp comes from the caller, as `at`, never from SQL `now()`, as
 * flows' and templates' do.
 */

/** An entry. Its name, category, description and regex are configuration text (ADR 0024). */
export interface TestRegex {
  id: string;
  name: string;
  category: string;
  /** Null for none. */
  description: string | null;
  regex: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A new entry, as the contract parsed it. */
export interface NewTestRegex {
  name: string;
  category: string;
  description: string | null;
  regex: string;
  at: Date;
}

/** A change to an entry: the fields given. */
export interface TestRegexChanges {
  name?: string;
  category?: string;
  description?: string | null;
  regex?: string;
}

export interface ITestRegexRepository {
  /** Every entry, by category, then name, then id, under the database's collation (as flows' order by name). */
  list(): Promise<TestRegex[]>;
  /** The entry with this id (a canonical UUID); undefined when there is none. */
  find(id: string): Promise<TestRegex | undefined>;
  /** The entry with exactly this name (uq_test_regex_name is case-sensitive); undefined when there is none. */
  findByName(name: string): Promise<TestRegex | undefined>;
  /** Inserts it. A name another entry has throws `TestRegexNameTakenError`; the transaction is then aborted. */
  create(input: NewTestRegex): Promise<TestRegex>;
  /** The entry, locked `for update` until the transaction ends; undefined when there is none. */
  lock(id: string): Promise<TestRegex | undefined>;
  /**
   * Sets `changes` and `updated_at` to `at`; undefined when no entry has the
   * id. A name another entry has throws `TestRegexNameTakenError`.
   */
  update(id: string, changes: TestRegexChanges, at: Date): Promise<TestRegex | undefined>;
  /** Deletes it for good; false when no entry has the id. */
  remove(id: string): Promise<boolean>;
}

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/** The entries' unique name (migration 1700000000031). */
const NAME_UNIQUE_CONSTRAINT = "uq_test_regex_name";

/**
 * Thrown by `create` and `update` when another entry has the name. Found by
 * the constraint's name, not just the SQLSTATE, as the flows' slug clash is:
 * a violation of any other unique index is a bug, and must surface as one.
 * The database's error, whose detail quotes the name, goes no further.
 */
export class TestRegexNameTakenError extends Error {
  constructor() {
    super("another entry has that name");
    this.name = "TestRegexNameTakenError";
  }
}

function isNameViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === NAME_UNIQUE_CONSTRAINT
  );
}

async function withNameClashAsError<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isNameViolation(error)) throw new TestRegexNameTakenError();
    throw error;
  }
}

function toTestRegex(row: Selectable<TestRegexTable>): TestRegex {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    regex: row.regex,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTestRegexRepository(db: Kysely<Database> | Transaction<Database>): ITestRegexRepository {
  return {
    async list() {
      const rows = await db
        .selectFrom("test_regex")
        .selectAll()
        .orderBy("category", "asc")
        .orderBy("name", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toTestRegex);
    },

    async find(id) {
      const row = await db.selectFrom("test_regex").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? toTestRegex(row) : undefined;
    },

    async findByName(name) {
      const row = await db.selectFrom("test_regex").selectAll().where("name", "=", name).executeTakeFirst();
      return row ? toTestRegex(row) : undefined;
    },

    async create(input) {
      const row = await withNameClashAsError(() =>
        db
          .insertInto("test_regex")
          .values({
            name: input.name,
            category: input.category,
            description: input.description,
            regex: input.regex,
            created_at: input.at,
            updated_at: input.at,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      return toTestRegex(row);
    },

    async lock(id) {
      const row = await db.selectFrom("test_regex").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      return row ? toTestRegex(row) : undefined;
    },

    async update(id, changes, at) {
      const row = await withNameClashAsError(() =>
        db
          .updateTable("test_regex")
          .set({
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...(changes.category === undefined ? {} : { category: changes.category }),
            ...(changes.description === undefined ? {} : { description: changes.description }),
            ...(changes.regex === undefined ? {} : { regex: changes.regex }),
            updated_at: at,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst(),
      );
      return row ? toTestRegex(row) : undefined;
    },

    async remove(id) {
      const row = await db.deleteFrom("test_regex").where("id", "=", id).returning("id").executeTakeFirst();
      return row !== undefined;
    },
  };
}
