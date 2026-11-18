import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { addApiToken, addMembership, addServiceAccount, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { TEST_RATE_LIMITS } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { buildServer } from "../../../server.js";
import { loadSettings } from "../../../settings.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../../testing/otelcol-validator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";

/*
 * The public surface's `/orgs` for a service account's token (D25 decision
 * 17's route 3; decisions 19, 30 and 53), through the real server as the
 * API's own role: its one organization, `{ id, name, type, role }`, never
 * another organization, and the reply checked against the OpenAPI
 * document. A read route: a read and a write token alike. People's `/orgs`
 * (every membership) is D25 Task 6's.
 *
 * Tokens are built at run time by addApiToken and never printed: `call`
 * runs its canary (a boolean) on every reply before any comparison of it.
 */

const opamp = useFakeOpampServer();

const ROUTE = "/api/public/v1/orgs";

describe("the public /orgs route for a service account (D25 route 3)", () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;

  beforeAll(async () => {
    const settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings,
      db,
      mailer: createInMemoryMailer(),
      rateLimits: TEST_RATE_LIMITS,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** A group organization (named), its admin, and its service account (a contributor unless given) with a read and a write token. */
  const organization = async (role: "admin" | "contributor" = "contributor") => {
    const at = new Date(Date.now() - 60_000);
    const admin = await createUserWithOrganization(ownerDb);
    const name = `Group ${randomUUID().slice(0, 8)}`;
    const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    await ownerDb.updateTable("organizations").set({ name }).where("id", "=", group.id).execute();
    const { user: account } = await addServiceAccount(ownerDb, { organizationId: group.id, createdAt: at });
    if (role === "admin") {
      await ownerDb.updateTable("organization_members").set({ role }).where("user_id", "=", account.id).execute();
    }
    const tokenOf = async (access: "read" | "write") =>
      (await addApiToken(ownerDb, { organizationId: group.id, serviceAccountUserId: account.id, created_at: at, access })).token;
    return { id: group.id, name, adminId: admin.user.id, accountUserId: account.id, read: await tokenOf("read"), write: await tokenOf("write") };
  };

  const call = async (token: string, headers: Record<string, string> = {}) => {
    const response = await server.inject({ method: "GET", url: ROUTE, headers: { authorization: `Bearer ${token}`, ...headers } });
    expect(holdsToken(response.body, token)).toBe(false);
    const body: unknown = response.body === "" ? undefined : response.json();
    expect(validatePublicReply("GET", ROUTE, response.statusCode, body).errors).toEqual([]);
    return response;
  };

  it("answers the token's one organization with the account's role, to a read and a write token; never another organization", async () => {
    const org = await organization();
    const other = await organization("admin");
    for (const token of [org.read, org.write]) {
      const response = await call(token);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ items: [{ id: org.id, name: org.name, type: "group", role: "contributor" }], nextCursor: null });
    }
    expect((await call(other.read)).json()).toEqual({
      items: [{ id: other.id, name: other.name, type: "group", role: "admin" }],
      nextCursor: null,
    });
  });

  it("ignores X-Telflo-Org for a service account's token, another organization's id included", async () => {
    const org = await organization();
    const other = await organization();
    const response = await call(org.read, { "x-telflo-org": other.id });
    expect(response.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toEqual([org.id]);
  });

  it("answers no organization the account isn't in, even were it a member of a second", async () => {
    const org = await organization();
    const other = await organization();
    // Never so in practice (an account's one membership); the list still names only the token's organization.
    await addMembership(ownerDb, { userId: org.accountUserId, organizationId: other.id, role: "contributor" });
    expect((await call(org.read)).json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toEqual([org.id]);
  });

  it("refuses a request without a token 401", async () => {
    const response = await server.inject({ method: "GET", url: ROUTE });
    expect(response.statusCode).toBe(401);
    expect(validatePublicReply("GET", ROUTE, 401, response.json()).errors).toEqual([]);
  });
});
