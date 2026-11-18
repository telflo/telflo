/*
 * The CLI's integration harness (D27 decision 33, Preflight rulings 4 and
 * 22): the real API (`buildServer`) on the agent's test database, served on
 * `127.0.0.1:<free port>`, for the CLI's client to call through the real
 * `fetch`. Its opamp-server is the file's fake; the validator, the tester
 * and the file store are UNCALLED unless the file passes its own fakes
 * (`overrides`), as the api's own integration tests do. Every log line at
 * info and above is kept, so a test can show that none holds a token.
 *
 * Test support only: never built or packed. Tokens are made at run time by
 * the db's own helpers and never printed (boolean canaries only).
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { ApiTokenAccess, OrganizationRole } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { addApiToken, addMembership, addPersonalApiToken, addServiceAccount, createUserWithOrganization } from "@telflo/db/testing";
import type { ServerDependencies } from "../../api/src/dependencies.js";
import { TEST_RATE_LIMITS } from "../../api/src/http/rate-limits.js";
import { createInMemoryMailer } from "../../api/src/mail/in-memory-mailer.js";
import { buildServer } from "../../api/src/server.js";
import { loadSettings } from "../../api/src/settings.js";
import { UNCALLED_FILE_STORE } from "../../api/src/testing/file-store.js";
import { useFakeOpampServer, type FakeOpampServerForFile } from "../../api/src/testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../api/src/testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../api/src/testing/otelcol-validator.js";

export { fakeStdin, runCli, type CliRun, type FakeStdin } from "./run-cli.js";

export interface Harness {
  /** The server's origin, `http://127.0.0.1:<port>` (loopback: the CLI's HTTPS rule allows it). */
  origin: string;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  ownerDb: Kysely<Database>;
  /** The file's fake opamp-server. */
  opamp: FakeOpampServerForFile;
  /** The server's log lines (info and above) since the file began; a test may empty it. */
  logLines: string[];
}

/**
 * The real API for one test file, started before its tests and closed
 * after. `overrides` is called in `beforeAll`, after the file's own fakes
 * have started: e.g. `() => ({ otelcolValidator: validator.client })`.
 */
export function useApiServer(overrides: () => Partial<ServerDependencies> = () => ({})): Harness {
  const opamp = useFakeOpampServer();
  const harness = { opamp, logLines: [] as string[] } as unknown as Harness;
  let server: FastifyInstance | undefined;
  let db: Kysely<Database> | undefined;
  beforeAll(async () => {
    const settings = loadSettings(process.env);
    harness.ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void harness.logLines.push(line) },
        ...overrides(),
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.listen({ host: "127.0.0.1", port: 0 });
    harness.origin = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await server?.close();
    await db?.destroy();
    await harness.ownerDb?.destroy();
  });
  return harness;
}

export interface PersonWithToken {
  userId: string;
  /** The person's personal organization (`/orgs` lists it first). */
  organizationId: string;
  token: string;
  tokenName: string;
}

/** A person with a personal organization and a personal token (write by default). */
export async function personWithToken(ownerDb: Kysely<Database>, access: ApiTokenAccess = "write"): Promise<PersonWithToken> {
  const { user, organization } = await createUserWithOrganization(ownerDb);
  const { personalApiToken, token } = await addPersonalApiToken(ownerDb, { userId: user.id, access });
  return { userId: user.id, organizationId: organization.id, token, tokenName: personalApiToken.name };
}

/** A group organization the person is a member of (admin by default). */
export async function addGroupOrganization(
  ownerDb: Kysely<Database>,
  userId: string,
  role: OrganizationRole = "admin",
): Promise<{ organizationId: string; name: string }> {
  const { organization } = await addMembership(ownerDb, { userId, role });
  return { organizationId: organization.id, name: organization.name };
}

export interface ServiceAccountWithToken {
  organizationId: string;
  token: string;
  tokenName: string;
}

/** A group organization with a service account and its token (write by default), made a minute ago. */
export async function serviceAccountWithToken(
  ownerDb: Kysely<Database>,
  access: ApiTokenAccess = "write",
): Promise<ServiceAccountWithToken> {
  const admin = await createUserWithOrganization(ownerDb);
  const { organization } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
  const createdAt = new Date(Date.now() - 60_000);
  const { user } = await addServiceAccount(ownerDb, { organizationId: organization.id, createdAt });
  const { apiToken, token } = await addApiToken(ownerDb, {
    organizationId: organization.id,
    serviceAccountUserId: user.id,
    access,
    created_at: createdAt,
  });
  return { organizationId: organization.id, token, tokenName: apiToken.name };
}
