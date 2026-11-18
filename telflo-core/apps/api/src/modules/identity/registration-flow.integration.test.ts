import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createMailer } from "../../mail/create-mailer.js";
import { loadSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

/** Every state-changing /api/v1 request carries the CSRF header (D2a decision 6). */
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/**
 * The test's own Mailpit, whose messages it deletes: never a default, which
 * would be a developer's own (Ruling 40). CI sets it (.github/workflows/ci.yml);
 * a local run exports it with the rest of the test's settings.
 */
const MAILPIT_API = mailpitApiUrl();

function mailpitApiUrl(): string {
  const url = process.env.TELFLO_MAILPIT_API_URL;
  if (!url) {
    throw new Error("TELFLO_MAILPIT_API_URL must point at the test's own Mailpit; it never defaults to a developer's");
  }
  return url;
}

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

async function clearMailpit(): Promise<void> {
  await fetch(`${MAILPIT_API}/api/v1/messages`, { method: "DELETE" });
}

async function listMailpitMessages(): Promise<MailpitMessage[]> {
  const response = await fetch(`${MAILPIT_API}/api/v1/messages`);
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

async function readMailpitText(id: string): Promise<string> {
  const response = await fetch(`${MAILPIT_API}/api/v1/message/${id}`);
  const body = (await response.json()) as { Text: string };
  return body.Text;
}

/** Mailpit accepts over SMTP and indexes asynchronously; poll briefly. */
async function waitForMessages(count: number): Promise<MailpitMessage[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const messages = await listMailpitMessages();
    if (messages.length >= count) return messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Mailpit never received ${count} message(s)`);
}

describe("registration flow, end to end through Mailpit", () => {
  let server: FastifyInstance;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;

  beforeAll(async () => {
    const settings = loadSettings(process.env);
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    server = buildServer({
      settings,
      db,
      mailer: createMailer(settings.mail),
      rateLimits: TEST_RATE_LIMITS,
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    await clearMailpit();
  });

  it("registers, delivers a real email, and verifies from the link inside it", async () => {
    const email = `flow-${Date.now()}@example.com`;

    const registerResponse = await server.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: csrfHeaders,
      payload: { email, password: "a-sufficiently-long-password", acceptedTermsVersion: TEST_TERMS_VERSION },
    });
    expect(registerResponse.statusCode).toBe(200);

    const [message] = await waitForMessages(1);
    expect(message!.To[0]?.Address).toBe(email);
    expect(message!.Subject).toContain("Confirm your Telflo email address");

    const text = await readMailpitText(message!.ID);
    const token = text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token, "the delivered email must contain a verification token").toBeDefined();

    const verifyResponse = await server.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      headers: csrfHeaders,
      payload: { token },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toEqual({ status: "verified" });

    const user = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
    expect(user.email).toBe(email);
    expect(user.email_verified_at).not.toBeNull();

    const organization = await ownerDb.selectFrom("organizations").selectAll().executeTakeFirstOrThrow();
    expect(organization).toMatchObject({
      name: email,
      type: "personal",
      owner_user_id: user.id,
    });
    const membership = await ownerDb.selectFrom("organization_members").selectAll().executeTakeFirstOrThrow();
    expect(membership).toMatchObject({ organization_id: organization.id, user_id: user.id, role: "admin" });

    const actions = (await ownerDb.selectFrom("audit_events").select("action").execute()).map((r) => r.action);
    expect(actions).toContain("user.registered");
    expect(actions).toContain("organization.created");
    expect(actions).toContain("organization_member.added");
    expect(actions).toContain("user.email_verified");
  });

  it("sends the duplicate notice, not a second verification link, on re-registration", async () => {
    const email = `dup-${Date.now()}@example.com`;
    const payload = {
      email,
      password: "a-sufficiently-long-password",
      acceptedTermsVersion: TEST_TERMS_VERSION,
    };

    await server.inject({ method: "POST", url: "/api/v1/auth/register", payload, headers: csrfHeaders });
    await waitForMessages(1);
    await server.inject({ method: "POST", url: "/api/v1/auth/register", payload, headers: csrfHeaders });

    const messages = await waitForMessages(2);
    expect(messages).toHaveLength(2);

    // Mailpit lists newest first.
    const notice = await readMailpitText(messages[0]!.ID);
    expect(notice).toContain("already exists");
    expect(notice).not.toContain("token=");

    const users = await ownerDb.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(1);
  });
});
