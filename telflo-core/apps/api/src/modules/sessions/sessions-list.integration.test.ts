import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { hashPassword } from "../identity/password.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

/*
 * GET /api/v1/auth/sessions and DELETE /api/v1/auth/sessions/{sessionId}
 * (D21 decision 40, Preflight rulings 13-15 and 17): the caller's live
 * sessions with families, never the raw user agent; signing out one other
 * session; the current one refused; another user's, an unknown, an idle and
 * an ended session refused alike; the audit row; the static `current`
 * route kept apart.
 */

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const SESSIONS_URL = "/api/v1/auth/sessions";
const UNKNOWN_ID = "0190a5b0-0000-7000-8000-000000000000";
const DAY = 24 * 60 * 60 * 1000;
/** Playwright's Desktop Firefox, with a canary that must never leave the API. */
const FIREFOX_ON_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0 ua-canary-41d7";
const SAFARI_ON_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15 ua-canary-9c2e";

function setCookieLines(response: LightMyRequestResponse): string[] {
  const header = response.headers["set-cookie"];
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}

function cookieValue(response: LightMyRequestResponse, name: string): string {
  for (const line of setCookieLines(response)) {
    const pair = line.split(";")[0]!.trim();
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  throw new Error(`the response set no ${name} cookie`);
}

describe("the sessions list and signing out one session", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** Every line the server logged, LOG_LEVEL info. */
  const lines: string[] = [];

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      server = buildServer({
        settings,
        db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void lines.push(line) },
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    lines.length = 0;
    clock = new Date();
  });

  const person = () =>
    createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash },
    });

  /** Signs in from `userAgent`: the session's id, its access and its refresh. */
  const signedIn = async (email: string, userAgent = FIREFOX_ON_WINDOWS) => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: { ...csrfHeaders, "user-agent": userAgent },
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const access = cookieValue(response, "telflo_access");
    // The session's id is the access token's `sid` claim, read without verifying it.
    const { sid } = JSON.parse(Buffer.from(access.split(".")[1]!, "base64url").toString("utf8")) as { sid: string };
    return { id: sid, access, refresh: cookieValue(response, "telflo_refresh") };
  };

  const list = (access?: string) =>
    server.inject({
      method: "GET",
      url: SESSIONS_URL,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const signOut = (access: string | undefined, sessionId: string) =>
    server.inject({
      method: "DELETE",
      url: `${SESSIONS_URL}/${sessionId}`,
      headers: { ...csrfHeaders, "user-agent": "sessions-list-test" },
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const me = (access: string) => server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

  const sessionRow = (id: string) =>
    ownerDb
      .selectFrom("sessions")
      .select(["revoked_at", "revoked_reason"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  const revokedAudits = () =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "user.session_revoked").execute();

  it("lists the caller's sessions with families, never the raw user agent", async () => {
    const account = await person();
    const first = await signedIn(account.user.email, FIREFOX_ON_WINDOWS);
    const second = await signedIn(account.user.email, SAFARI_ON_MAC);
    const stranger = await person();
    await signedIn(stranger.user.email);

    const response = await list(first.access);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Array<Record<string, unknown>>; total: number }>();
    expect(body.total).toBe(2);
    // The current one first, whatever its activity.
    expect(body.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(body.items[0]).toEqual({
      id: first.id,
      isCurrent: true,
      signedInAt: expect.any(String),
      lastActiveAt: expect.any(String),
      ipAddress: "127.0.0.1",
      browser: "firefox",
      os: "windows",
    });
    expect(body.items[1]).toMatchObject({ id: second.id, isCurrent: false, browser: "safari", os: "macos" });
    const rows = await ownerDb.selectFrom("sessions").select(["id", "created_at", "last_refreshed_at"]).execute();
    const firstRow = rows.find((row) => row.id === first.id)!;
    expect(body.items[0]!.signedInAt).toBe(firstRow.created_at.toISOString());
    expect(body.items[0]!.lastActiveAt).toBe(firstRow.last_refreshed_at.toISOString());

    // The second browser sees itself as current.
    const fromSecond = (await list(second.access)).json<{ items: Array<{ id: string; isCurrent: boolean }> }>();
    expect(fromSecond.items.map(({ id, isCurrent }) => ({ id, isCurrent }))).toEqual([
      { id: second.id, isCurrent: true },
      { id: first.id, isCurrent: false },
    ]);

    // The raw strings leave the API in no reply and no log line.
    expect(lines.some((line) => line.includes(SESSIONS_URL))).toBe(true);
    for (const canary of ["ua-canary-41d7", "ua-canary-9c2e", "Gecko/20100101"]) {
      expect(response.body).not.toContain(canary);
      for (const line of lines) expect(line).not.toContain(canary);
    }
  });

  it("names a session server.inject started, with no browser, as other on other", async () => {
    const account = await person();
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    const listed = await list(cookieValue(response, "telflo_access"));
    expect(listed.json()).toMatchObject({ items: [{ browser: "other", os: "other" }], total: 1 });
  });

  it("signs out another of the caller's sessions with signed_out_elsewhere, and its next request is refused unauthenticated", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);
    const other = await signedIn(account.user.email);

    const response = await signOut(current.access, other.id);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    // Nothing changes for this browser's cookies.
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await sessionRow(other.id)).toEqual({ revoked_at: clock, revoked_reason: "signed_out_elsewhere" });
    const refused = await me(other.access);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: { code: "unauthenticated" } });
    const refresh = await server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: csrfHeaders,
      cookies: { telflo_refresh: other.refresh },
    });
    expect(refresh.statusCode).toBe(401);
    // This one is untouched, and the list now holds it alone.
    expect((await me(current.access)).statusCode).toBe(200);
    expect((await list(current.access)).json()).toMatchObject({ items: [{ id: current.id }], total: 1 });
  });

  it("refuses the current session with 409 cannot_revoke_current_session, its id in capitals too (Ruling 85)", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);

    // Postgres matches the id in capitals to the same row: the check compares the canonical id.
    for (const id of [current.id, current.id.toUpperCase()]) {
      const response = await signOut(current.access, id);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: { code: "cannot_revoke_current_session", message: "Use Log out to sign out of this browser." },
      });
    }
    expect(await sessionRow(current.id)).toEqual({ revoked_at: null, revoked_reason: null });
    expect((await me(current.access)).statusCode).toBe(200);
    expect(await revokedAudits()).toEqual([]);
  });

  it("signs out another of the caller's sessions named by its id in capitals: canonicalized, not refused (Ruling 85)", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);
    const other = await signedIn(account.user.email);

    const response = await signOut(current.access, other.id.toUpperCase());

    expect(response.statusCode).toBe(204);
    expect(await sessionRow(other.id)).toEqual({ revoked_at: clock, revoked_reason: "signed_out_elsewhere" });
    expect((await me(current.access)).statusCode).toBe(200);
    // The audit row names the session as Postgres prints it.
    expect((await revokedAudits()).map((row) => row.subject_id)).toEqual([other.id]);
  });

  it("answers 404 session_not_found alike for another user's, an unknown and an ended session, and changes nothing", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);
    const ended = await signedIn(account.user.email);
    expect((await signOut(current.access, ended.id)).statusCode).toBe(204);
    const endedBefore = await sessionRow(ended.id);
    const stranger = await person();
    const strangers = await signedIn(stranger.user.email);

    const responses = [
      await signOut(current.access, strangers.id),
      await signOut(current.access, UNKNOWN_ID),
      await signOut(current.access, ended.id),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: "session_not_found", message: "Session not found" } });
    }
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    expect(await sessionRow(strangers.id)).toEqual({ revoked_at: null, revoked_reason: null });
    expect((await me(strangers.access)).statusCode).toBe(200);
    expect(await sessionRow(ended.id)).toEqual(endedBefore);
    // Only the one real sign-out was audited.
    expect((await revokedAudits()).map((row) => row.subject_id)).toEqual([ended.id]);
  });

  it("neither lists nor signs out a session idle past the refresh lifetime", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);
    const idle = await signedIn(account.user.email);
    // Its last refresh is older than the refresh token's lifetime: it can never refresh again.
    await ownerDb
      .updateTable("sessions")
      .set({ last_refreshed_at: new Date(clock.getTime() - (settings.refreshTokenTtlDays + 1) * DAY) })
      .where("id", "=", idle.id)
      .execute();

    expect((await list(current.access)).json()).toMatchObject({ items: [{ id: current.id }], total: 1 });
    const response = await signOut(current.access, idle.id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "session_not_found" } });
    expect(await sessionRow(idle.id)).toEqual({ revoked_at: null, revoked_reason: null });
  });

  it("audits user.session_revoked with the session's id", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);
    const other = await signedIn(account.user.email);

    expect((await signOut(current.access, other.id)).statusCode).toBe(204);

    const audits = await revokedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: account.user.id,
      actor_email: account.user.email,
      organization_id: account.organization.id,
      subject_type: "session",
      subject_id: other.id,
      metadata: {},
      ip_address: "127.0.0.1",
      user_agent: "sessions-list-test",
    });
  });

  it("doesn't match logout's /auth/sessions/current", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);

    const response = await server.inject({
      method: "DELETE",
      url: `${SESSIONS_URL}/current`,
      headers: csrfHeaders,
      cookies: { telflo_access: current.access },
    });

    // Logout's answer: the cookies cleared and the session revoked as a logout, not a 409 or a 400.
    expect(response.statusCode).toBe(204);
    expect(setCookieLines(response).some((line) => line.startsWith("telflo_access=;"))).toBe(true);
    expect(await sessionRow(current.id)).toMatchObject({ revoked_reason: "logout" });
    expect(await revokedAudits()).toEqual([]);
  });

  it("a non-uuid id answers 400", async () => {
    const account = await person();
    const current = await signedIn(account.user.email);

    for (const id of ["not-a-uuid", "12345", `${current.id}x`]) {
      const response = await signOut(current.access, id);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(response.body).not.toContain(id);
    }
    expect(await sessionRow(current.id)).toEqual({ revoked_at: null, revoked_reason: null });
  });

  it("needs a session and not the current terms", async () => {
    expect((await list()).statusCode).toBe(401);
    expect((await signOut(undefined, UNKNOWN_ID)).statusCode).toBe(401);

    const account = await createUserWithOrganization(ownerDb, {
      user: { password_hash: passwordHash, accepted_terms_version: null, terms_accepted_at: null },
    });
    const current = await signedIn(account.user.email);
    const other = await signedIn(account.user.email);
    expect((await list(current.access)).statusCode).toBe(200);
    expect((await signOut(current.access, other.id)).statusCode).toBe(204);
  });
});
