import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from "kysely";
import type { Database } from "@telflo/db";
import { createTestRegexRepository, TestRegexNameTakenError } from "./test-regex-repository.js";

// D15b Ruling 20 (the Task 2 review's nit 2): only a unique violation of
// uq_test_regex_name is the name taken. Against a Kysely whose every query
// fails with the error given, as pg's driver would throw it: no database.

/** pg's error for a unique violation of `constraint`, or another SQLSTATE's. */
function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error(`violates "${constraint}"`), { code, constraint });
}

/** A repository whose every query rejects with `error`. */
function failingWith(error: Error) {
  const connection: DatabaseConnection = {
    executeQuery: () => Promise.reject(error),
    streamQuery: () => {
      throw error;
    },
  };
  class FailingDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve(connection);
    }
  }
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FailingDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return createTestRegexRepository(db);
}

const AT = new Date(Date.UTC(2026, 9, 11, 9, 0, 0));
const NEW_ENTRY = { name: "Email", category: "PII", description: null, regex: "[a-z]+", at: AT };
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";

describe("the repository's name clash", () => {
  it("is a 23505 on uq_test_regex_name, from a create or an update", async () => {
    const repository = failingWith(pgError("23505", "uq_test_regex_name"));
    await expect(repository.create(NEW_ENTRY)).rejects.toBeInstanceOf(TestRegexNameTakenError);
    await expect(repository.update(ID, { name: "Email" }, AT)).rejects.toBeInstanceOf(TestRegexNameTakenError);
  });

  it("lets a unique violation of any other constraint, and another SQLSTATE on the name's, through as it is", async () => {
    for (const error of [pgError("23505", "test_regex_pkey"), pgError("23505", "uq_another_index"), pgError("23514", "uq_test_regex_name")]) {
      const repository = failingWith(error);
      await expect(repository.create(NEW_ENTRY)).rejects.toBe(error);
      await expect(repository.update(ID, { name: "Email" }, AT)).rejects.toBe(error);
    }
  });
});
