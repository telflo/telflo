import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import {
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "./mail/in-memory-mailer.js";
import { hashPassword } from "./modules/identity/password.js";
import { loadSettings } from "./settings.js";
import { buildServer } from "./server.js";
import { TEST_RATE_LIMITS } from "./http/rate-limits.js";
import { useFakeOpampServer } from "./testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "./testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "./testing/file-store.js";
import { UNCALLED_TESTING } from "./testing/otelcol-testing.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const PASSWORD = "a-sufficiently-long-password";

/**
 * A Postgres error's DETAIL names the values of the row that failed: "Key
 * (token_hash)=(…) already exists", "Failing row contains (…)". The error
 * handler logs the error in full, so the server's logger drops `detail` and
 * `where` from every logged error, whatever the table, and keeps the code
 * and the constraint, which name no values.
 *
 * Postgres leaves the detail out on its own for a table whose row-level
 * security applies to the role (organization_invitations,
 * organization_members), so a table without it shows the rule's teeth:
 * refresh_tokens, whose hash a sign-in writes.
 */
describe("database errors in the log", () => {
  let databases: TestDatabases;
  let server: FastifyInstance;
  let lines: string[] = [];
  let passwordHash: string;

  beforeAll(async () => {
    databases = openTestDatabases();
    const previousLevel = process.env.LOG_LEVEL;
    // Every line, request lines included, as the token-never-logged tests do.
    process.env.LOG_LEVEL = "trace";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: loadSettings(process.env),
        db: databases.db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void lines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    lines = [];
  });

  const signIn = (email: string) =>
    server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      payload: { email, password: PASSWORD },
    });

  it("drops a unique violation's detail, which names a refresh token's hash, and keeps its code", async () => {
    const { user } = await createUserWithOrganization(databases.ownerDb, { user: { password_hash: passwordHash } });
    expect((await signIn(user.email)).statusCode).toBe(200);
    const { token_hash: takenHash } = await databases.ownerDb
      .selectFrom("refresh_tokens")
      .select("token_hash")
      .executeTakeFirstOrThrow();
    lines = [];

    // The next sign-in's refresh token is given the first one's hash.
    await withFailingInsert(
      databases.ownerDb,
      "refresh_tokens",
      `new.token_hash := '${takenHash}'; return new`,
      async () => {
        expect((await signIn(user.email)).statusCode).toBe(500);
      },
    );

    const logged = lines.flatMap((line) => {
      const entry = JSON.parse(line) as { err?: Record<string, unknown> };
      return entry.err ? [entry.err] : [];
    });
    expect(logged).toEqual([expect.objectContaining({ code: "23505", constraint: "uq_refresh_tokens_token_hash" })]);
    expect(logged[0]).not.toHaveProperty("detail");
    expect(logged[0]).not.toHaveProperty("where");
    expect(lines.join("")).not.toContain(takenHash);
  });
});
