import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { createUserWithOrganization, openTestDatabases, type TestDatabases } from "@telflo/db/testing";
import { prepareTestDatabase, THROWAWAY_DATABASE_DROP_TIMEOUT } from "@telflo/db/test-database";
import { createCollectingRunner } from "../../http/after-response.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** Creating, migrating and dropping a database waits for checkpoints. */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

/*
 * One default, read from the catalogue's tables: a configuration created
 * through the API, its version 1, and the sign-up starter take whatever the
 * tables call the default, never a constant. So the default moves here, to
 * another version, and every writer follows it. On a throwaway database the
 * test prepares itself (migrated and synced, as telflo_platform_test is), since
 * telflo_platform_test's catalogue must stay the committed one.
 */
describe("the catalogue's default, as new configurations and the sign-up starter take it", () => {
  let databases: TestDatabases;
  let throwawayName: string;
  let ownerDb: Kysely<Database>;
  let db: Kysely<Database>;
  let server: FastifyInstance;
  /** The version the default moves to: not the committed catalogue's default. */
  let movedTo: { distribution: string; version: string };

  beforeAll(async () => {
    databases = openTestDatabases();
    throwawayName = `telflo_catalogue_defaults_${randomUUID().replaceAll("-", "")}_test`;
    const ownerUrl = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerUrl.pathname = `/${throwawayName}`;
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = `/${throwawayName}`;
    await prepareTestDatabase(ownerUrl.toString(), applicationUrl.toString());
    ownerDb = createDb(createPool(ownerUrl.toString()));
    db = createDb(createPool(applicationUrl.toString()));

    // Moved as the sync moves one: the old default cleared first.
    movedTo = await ownerDb.transaction().execute(async (transaction) => {
      const target = await transaction
        .selectFrom("collector_versions")
        .innerJoin("collector_distributions", "collector_distributions.id", "collector_versions.distribution")
        .select(["collector_versions.distribution", "collector_versions.version"])
        .where("collector_distributions.is_default", "=", true)
        .where("collector_versions.is_default", "=", false)
        .where("collector_versions.deprecated", "=", false)
        .orderBy("collector_versions.version", "asc")
        .executeTakeFirstOrThrow();
      await sql`
        update collector_versions set is_default = false where distribution = ${target.distribution} and is_default
      `.execute(transaction);
      await sql`
        update collector_versions set is_default = true
         where distribution = ${target.distribution} and version = ${target.version}
      `.execute(transaction);
      return target;
    });

    server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: loadSettings(process.env),
      db,
      mailer: createInMemoryMailer(),
      now: () => new Date(),
      rateLimits: TEST_RATE_LIMITS,
      runAfterResponse: (task) => createCollectingRunner().run(task),
    });
    await server.ready();
  }, THROWAWAY_DATABASE_TIMEOUT);

  afterAll(async () => {
    await server?.close();
    await db?.destroy();
    await ownerDb?.destroy();
    await sql`drop database if exists ${sql.id(throwawayName)}`.execute(databases.ownerDb);
    await databases.destroy();
  }, THROWAWAY_DATABASE_DROP_TIMEOUT);

  it("moved the default away from the committed one, so what follows can't be a constant", async () => {
    const committed = await databases.ownerDb
      .selectFrom("collector_versions")
      .select("version")
      .where("distribution", "=", movedTo.distribution)
      .where("is_default", "=", true)
      .executeTakeFirstOrThrow();
    expect(movedTo.version).not.toBe(committed.version);
  });

  it("gives a configuration created through the API, and its version 1, the default as the tables now hold it", async () => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `defaults-${randomUUID()}@example.com`, password_hash: await hashPassword(PASSWORD) },
    });
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const access = signIn.cookies.find((cookie) => cookie.name === "telflo_access")!.value;

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/organizations/${account.organization.id}/configurations`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name: "Gateway" },
    });
    expect(response.statusCode).toBe(201);
    const { configuration } = response.json<{ configuration: { id: string } }>();

    expect(
      await ownerDb
        .selectFrom("configurations")
        .select("collector_distribution")
        .where("id", "=", configuration.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ collector_distribution: movedTo.distribution });
    expect(
      await ownerDb
        .selectFrom("configuration_versions")
        .select(["version_number", "collector_distribution", "collector_version"])
        .where("configuration_id", "=", configuration.id)
        .execute(),
    ).toEqual([
      { version_number: 1, collector_distribution: movedTo.distribution, collector_version: movedTo.version },
    ]);
  });

  it("gives the sign-up starter the default as the tables now hold it (createAccount, which every sign-up path goes through)", async () => {
    const email = `starter-${randomUUID()}@example.com`;
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD, acceptedTermsVersion: TEST_TERMS_VERSION },
    });
    expect(response.statusCode).toBeLessThan(300);

    const starter = await ownerDb
      .selectFrom("configuration_versions")
      .innerJoin("configurations", "configurations.id", "configuration_versions.configuration_id")
      .innerJoin("users", "users.id", "configurations.created_by_user_id")
      .select([
        "configurations.collector_distribution as configurationDistribution",
        "configuration_versions.collector_distribution",
        "configuration_versions.collector_version",
      ])
      .where("users.email", "=", email)
      .execute();
    expect(starter).toEqual([
      {
        configurationDistribution: movedTo.distribution,
        collector_distribution: movedTo.distribution,
        collector_version: movedTo.version,
      },
    ]);
  });

  it("shows the sign-up starter's pin in its version and its summary, as the tables now hold the default", async () => {
    const email = `starter-read-${randomUUID()}@example.com`;
    const registered = await server.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD, acceptedTermsVersion: TEST_TERMS_VERSION },
    });
    expect(registered.statusCode).toBeLessThan(300);
    // Verified as the link in the email would, so the account can sign in.
    await ownerDb.updateTable("users").set({ email_verified_at: new Date() }).where("email", "=", email).execute();
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const access = signIn.cookies.find((cookie) => cookie.name === "telflo_access")!.value;
    // Signing in lands in the personal organization, where the starter is.
    const organization = await ownerDb
      .selectFrom("organizations")
      .innerJoin("users", "users.id", "organizations.owner_user_id")
      .select("organizations.id")
      .where("users.email", "=", email)
      .executeTakeFirstOrThrow();
    const path = `/api/v1/organizations/${organization.id}/configurations`;
    const list = await server.inject({ method: "GET", url: path, cookies: { telflo_access: access } });
    const [starter] = list.json<{ items: Array<{ id: string; collectorDistribution: string }> }>().items;
    expect(starter!.collectorDistribution).toBe(movedTo.distribution);

    const response = await server.inject({ method: "GET", url: `${path}/${starter!.id}`, cookies: { telflo_access: access } });

    expect(response.statusCode).toBe(200);
    const pinned = {
      collectorVersion: movedTo.version,
      collectorVersionDeprecated: false,
      collectorVersionDeprecatedNote: null,
    };
    const body = response.json<{ configuration: { collectorDistribution: string }; version: object; versions: object[] }>();
    expect(body.configuration.collectorDistribution).toBe(movedTo.distribution);
    expect(body.version).toMatchObject(pinned);
    expect(body.versions).toEqual([expect.objectContaining(pinned)]);
  });
});
