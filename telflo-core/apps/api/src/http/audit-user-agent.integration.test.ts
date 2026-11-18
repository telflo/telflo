import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { addApiToken, addMembership, addServiceAccount, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createInMemoryMailer } from "../mail/in-memory-mailer.js";
import { hashPassword } from "../modules/identity/password.js";
import { buildServer } from "../server.js";
import { loadSettings } from "../settings.js";
import { useFakeOpampServer } from "../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../testing/file-store.js";
import { UNCALLED_TESTING } from "../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../testing/otelcol-validator.js";
import { TEST_RATE_LIMITS } from "./rate-limits.js";

/*
 * D25 Ruling 186 on the real server: a tf_ token sent in User-Agent never
 * reaches an audit row or a session row. The security review's probe (a
 * public fleet create with "ci-runner <its own write token>") and a
 * sign-in. Tokens are built at run time; every check of a stored value is a
 * boolean canary.
 */

const opamp = useFakeOpampServer();
const PASSWORD = "a-sufficiently-long-password";

describe("a credential in User-Agent is never stored (D25 Ruling 186)", () => {
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

  const storedUserAgents = async () => [
    ...(await ownerDb.selectFrom("audit_events").select("user_agent").execute()).map((row) => row.user_agent),
    ...(await ownerDb.selectFrom("sessions").select("user_agent").execute()).map((row) => row.user_agent),
  ];

  it("the review's probe: POST /api/public/v1/fleets with User-Agent \"ci-runner <write token>\" stores [redacted] in fleet.created's row", async () => {
    const admin = await createUserWithOrganization(ownerDb);
    const { organization } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const at = new Date(Date.now() - 60_000);
    const { user } = await addServiceAccount(ownerDb, { organizationId: organization.id, createdAt: at });
    const { token } = await addApiToken(ownerDb, { organizationId: organization.id, serviceAccountUserId: user.id, created_at: at, access: "write" });
    const response = await server.inject({
      method: "POST",
      url: "/api/public/v1/fleets",
      headers: { authorization: `Bearer ${token}`, "user-agent": `ci-runner ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ label: "edge", type: "server" }),
    });
    expect(response.body.includes(token.slice(3))).toBe(false);
    expect(response.statusCode).toBe(201);
    const created = await ownerDb.selectFrom("audit_events").select("user_agent").where("action", "=", "fleet.created").execute();
    expect(created.length).toBe(1);
    expect(created[0]!.user_agent === "[redacted]").toBe(true);
    expect((await storedUserAgents()).some((value) => value?.includes(token.slice(3)) === true)).toBe(false);
  });

  it("a sign-in with a token in User-Agent stores [redacted] in its session and its audit rows; an ordinary one as sent", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const account = await createUserWithOrganization(ownerDb, { user: { password_hash: passwordHash } });
    const token = `tf_${randomBytes(32).toString("base64url")}`;
    const signIn = (userAgent: string) =>
      server.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, "user-agent": userAgent },
        payload: { email: account.user.email, password: PASSWORD },
      });
    expect((await signIn(`deploy-bot ${token}`)).statusCode).toBe(200);
    const stored = await storedUserAgents();
    expect(stored.some((value) => value?.includes(token.slice(3)) === true)).toBe(false);
    const sessions = await ownerDb.selectFrom("sessions").select("user_agent").execute();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.user_agent === "[redacted]").toBe(true);
    // An ordinary browser's, as before.
    const browser = "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0";
    expect((await signIn(browser)).statusCode).toBe(200);
    expect((await ownerDb.selectFrom("sessions").select("user_agent").execute()).some((row) => row.user_agent === browser)).toBe(true);
  });
});
