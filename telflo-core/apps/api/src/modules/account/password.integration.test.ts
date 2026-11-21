import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { EmailMessage, IMailer } from "../../mail/mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { hashPassword } from "../identity/password.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

/*
 * PUT /api/v1/auth/me/password: the change, its refusals, every session
 * kept, the reset links consumed, the audit rows' content, the email after
 * the response, and the races on Postgres with a locker (a separate
 * connection holds the user's row `for update` until the requests under test
 * are blocked on it). Limits are rate-limits.integration.test.ts's.
 */

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
/** Canaries: neither may appear in an audit row or a log line. */
const PASSWORD = "canary-current-5d1e9b-password";
const NEW_PASSWORD = "canary-new-7f3a9c-password";
const WRONG_PASSWORD = "canary-wrong-2c8e4f-password";
const CANARIES = [PASSWORD, NEW_PASSWORD, WRONG_PASSWORD];
const PASSWORD_URL = "/api/v1/auth/me/password";

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

/** A mailer whose every send fails, as an unreachable relay's would. */
function createFailingMailer(): IMailer & { attempted: EmailMessage[] } {
  const attempted: EmailMessage[] = [];
  return {
    attempted,
    async send(message) {
      attempted.push(message);
      throw new Error("the relay refused the message");
    },
  };
}

describe("PUT /api/v1/auth/me/password", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let mailer: ReturnType<typeof createInMemoryMailer>;
  let runner: CollectingRunner;
  /** Every line the server logged, LOG_LEVEL info (the canary test builds its own at trace). */
  let lines: string[];
  let passwordHash: string;
  let clock: Date;
  const extraServers: FastifyInstance[] = [];

  function serverWith(overrides: {
    mailer: IMailer;
    runner: CollectingRunner;
    lines: string[];
    level?: "info" | "trace";
  }): FastifyInstance {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = overrides.level ?? "info";
    try {
      return buildServer({
        settings,
        db,
        mailer: overrides.mailer,
        now: () => clock,
        rateLimits: TEST_RATE_LIMITS,
        runAfterResponse: overrides.runner.run,
        logStream: { write: (line) => void overrides.lines.push(line) },
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  }

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    mailer = createInMemoryMailer();
    runner = createCollectingRunner();
    lines = [];
    server = serverWith({ mailer, runner, lines });
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await Promise.all(extraServers.map((extra) => extra.close()));
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    // Nothing queued by an earlier test runs in this one.
    await runner.settle().catch(() => undefined);
    mailer.sent.length = 0;
    lines.length = 0;
    clock = new Date();
  });

  const person = (user: Record<string, unknown> = {}) =>
    createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash, ...user },
    });

  const signIn = (email: string, password = PASSWORD, target = server) =>
    target.inject({ method: "POST", url: "/api/v1/auth/sessions", headers: csrfHeaders, payload: { email, password } });

  /** Signs in and answers the access cookie. */
  const signedIn = async (email: string, target = server) => {
    const response = await signIn(email, PASSWORD, target);
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const changePassword = (
    access: string | undefined,
    payload: Record<string, unknown> = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    target = server,
  ) =>
    target.inject({
      method: "PUT",
      url: PASSWORD_URL,
      headers: { ...csrfHeaders, "user-agent": "password-change-test" },
      payload,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const me = (access: string) => server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

  const storedHash = async (userId: string) =>
    (await ownerDb.selectFrom("users").select("password_hash").where("id", "=", userId).executeTakeFirstOrThrow())
      .password_hash;

  const auditRows = (action?: string) => {
    let query = ownerDb.selectFrom("audit_events").selectAll();
    if (action !== undefined) query = query.where("action", "=", action);
    return query.orderBy("occurred_at").execute();
  };

  /**
   * Waits until `count` other connections are blocked on a lock in a
   * statement naming `users`: the requests under test have verified their
   * passwords and queued on the locker's row lock.
   */
  async function waitForBlocked(count: number, lockerPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await sql<{ blocked: number }>`
        select count(*)::int as blocked
        from pg_stat_activity
        where datname = current_database()
          and pid <> ${lockerPid}
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%users%'
      `.execute(ownerDb);
      if ((rows[0]?.blocked ?? 0) >= count) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} requests to block on users`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Holds the user's row `for update` on its own connection while `run` does its work. */
  async function withLockedUser(
    userId: string,
    run: (locker: { pid: number; query: (text: string, values?: unknown[]) => Promise<unknown> }) => Promise<void>,
  ) {
    const locker = await pool.connect();
    let isInTransaction = false;
    try {
      await locker.query("begin");
      isInTransaction = true;
      await locker.query("select id from users where id = $1 for update", [userId]);
      const pid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await run({
        pid,
        query: async (text, values) => {
          const result = await locker.query(text, values);
          if (/^\s*(commit|rollback)\s*$/i.test(text)) isInTransaction = false;
          return result;
        },
      });
    } finally {
      if (isInTransaction) await locker.query("rollback");
      locker.release();
    }
  }

  describe("the change", () => {
    it("changes the password: the old one no longer signs in, the new one does, and 204", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);

      const response = await changePassword(access);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect((await signIn(account.user.email, PASSWORD)).statusCode).toBe(401);
      expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it("leaves the email's confirmation as it was", async () => {
      const verifiedAt = new Date("2026-01-02T03:04:05.000Z");
      const account = await person({ email_verified_at: verifiedAt });
      const access = await signedIn(account.user.email);

      expect((await changePassword(access)).statusCode).toBe(204);

      const row = await ownerDb
        .selectFrom("users")
        .select(["email_verified_at", "updated_at"])
        .where("id", "=", account.user.id)
        .executeTakeFirstOrThrow();
      expect(row.email_verified_at).toEqual(verifiedAt);
      expect(row.updated_at).toEqual(clock);
    });

    it("refuses a wrong current password with 400 current_password_incorrect, audits user.reauthentication_failed {purpose: password_change} and changes nothing", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);
      const before = await storedHash(account.user.id);

      const response = await changePassword(access, { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: { code: "current_password_incorrect", message: "The current password is incorrect." },
      });
      expect(await storedHash(account.user.id)).toBe(before);
      expect(await auditRows("user.password_changed")).toEqual([]);
      const failures = await auditRows("user.reauthentication_failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        actor_user_id: account.user.id,
        organization_id: account.organization.id,
        subject_type: "user",
        subject_id: account.user.id,
        metadata: { purpose: "password_change" },
        user_agent: "password-change-test",
      });
      expect(failures[0]!.ip_address).not.toBeNull();
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("refuses a password-less account with 409 password_not_set", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);
      // A Google-only account: no password to verify.
      await ownerDb.updateTable("users").set({ password_hash: null }).where("id", "=", account.user.id).execute();

      const response = await changePassword(access);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: { code: "password_not_set", message: "Your account has no password yet. Set one from the emailed link." },
      });
      expect(await storedHash(account.user.id)).toBeNull();
      expect(await auditRows("user.reauthentication_failed")).toEqual([]);
      expect(await auditRows("user.password_changed")).toEqual([]);
    });

    it("refuses a new password under 12 or over 128 characters with 400", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);
      const before = await storedHash(account.user.id);

      for (const newPassword of ["x".repeat(11), "y".repeat(129)]) {
        const response = await changePassword(access, { currentPassword: PASSWORD, newPassword });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
        // Zod's details name the bound, never the value.
        expect(response.body).not.toContain(newPassword);
        expect(response.body).not.toContain(PASSWORD);
      }
      // 12 and 128 are taken.
      expect((await changePassword(access, { currentPassword: PASSWORD, newPassword: "z".repeat(12) })).statusCode).toBe(204);
      expect(
        (await changePassword(access, { currentPassword: "z".repeat(12), newPassword: "w".repeat(128) })).statusCode,
      ).toBe(204);
      expect(await storedHash(account.user.id)).not.toBe(before);
    });

    it("refuses a body with anything else in it, or a missing current password, with 400", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);

      for (const payload of [
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, email: "someone-else@example.com" },
        { newPassword: NEW_PASSWORD },
        { currentPassword: "", newPassword: NEW_PASSWORD },
      ]) {
        const response = await changePassword(access, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
      }
      expect((await signIn(account.user.email, PASSWORD)).statusCode).toBe(200);
    });

    it("keeps every session, this one included", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);
      const other = await signedIn(account.user.email);

      const response = await changePassword(access);

      expect(response.statusCode).toBe(204);
      // No cookie set or cleared.
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect((await me(access)).statusCode).toBe(200);
      expect((await me(other)).statusCode).toBe(200);
      const sessions = await ownerDb.selectFrom("sessions").select("revoked_at").where("user_id", "=", account.user.id).execute();
      expect(sessions).toEqual([{ revoked_at: null }, { revoked_at: null }]);
    });

    it("consumes every outstanding reset link: one requested before the change no longer resets", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);
      const requested = await server.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset-requests",
        headers: csrfHeaders,
        payload: { email: account.user.email },
      });
      expect(requested.statusCode).toBe(202);
      await runner.settle();
      const match = /\/reset-password#token=([A-Za-z0-9_-]+)/.exec(mailer.sent[0]?.text ?? "");
      expect(match).not.toBeNull();

      expect((await changePassword(access)).statusCode).toBe(204);

      const reset = await server.inject({
        method: "POST",
        url: "/api/v1/auth/password-resets",
        headers: csrfHeaders,
        payload: { token: match![1], password: "a-reset-sufficiently-long-password" },
      });
      expect(reset.statusCode).toBe(400);
      expect(reset.json()).toMatchObject({ error: { code: "invalid_reset_token" } });
      expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
      const tokens = await ownerDb.selectFrom("password_reset_tokens").select("consumed_at").execute();
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.consumed_at).toEqual(clock);
    });

    it("audits user.password_changed with ids only: a canary password appears in no audit row and no log line", async () => {
      // Logged at trace, the lowest level: a body logged at debug or trace
      // would be in these lines too.
      const tracedLines: string[] = [];
      const traced = serverWith({ mailer, runner, lines: tracedLines, level: "trace" });
      extraServers.push(traced);
      await traced.ready();
      expect(traced.log.level).toBe("trace");
      const account = await person();
      const access = await signedIn(account.user.email, traced);

      expect(
        (await changePassword(access, { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD }, traced)).statusCode,
      ).toBe(400);
      expect((await changePassword(access, undefined, traced)).statusCode).toBe(204);
      await runner.settle();

      const changed = await auditRows("user.password_changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        actor_user_id: account.user.id,
        actor_email: account.user.email,
        organization_id: account.organization.id,
        subject_type: "user",
        subject_id: account.user.id,
        metadata: {},
        user_agent: "password-change-test",
      });

      const everyRow = JSON.stringify(await auditRows());
      // The log is live: the requests were logged, so their absence below means something.
      expect(tracedLines.some((line) => line.includes(PASSWORD_URL))).toBe(true);
      for (const canary of CANARIES) {
        expect(everyRow).not.toContain(canary);
        for (const line of tracedLines) expect(line).not.toContain(canary);
      }
    });

    it('sends "Your Telflo password was changed" after the response, and a failed send leaves the change standing', async () => {
      const account = await person();
      const access = await signedIn(account.user.email);

      expect((await changePassword(access)).statusCode).toBe(204);
      // Nothing is sent before the response.
      expect(mailer.sent).toEqual([]);
      await runner.settle();
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]).toMatchObject({ to: account.user.email, subject: "Your Telflo password was changed" });
      expect(mailer.sent[0]!.text).toContain(`${settings.publicWebUrl}/forgot-password`);

      // A relay that refuses: the runner's task fails, and nothing is undone.
      const failing = createFailingMailer();
      const failingRunner = createCollectingRunner();
      const failingServer = serverWith({ mailer: failing, runner: failingRunner, lines: [] });
      extraServers.push(failingServer);
      await failingServer.ready();
      const other = await person();
      const otherAccess = await signedIn(other.user.email, failingServer);

      expect((await changePassword(otherAccess, undefined, failingServer)).statusCode).toBe(204);
      await expect(failingRunner.settle()).rejects.toThrow("the relay refused the message");
      expect(failing.attempted).toHaveLength(1);
      expect((await signIn(other.user.email, NEW_PASSWORD, failingServer)).statusCode).toBe(200);
      expect(await auditRows("user.password_changed")).toHaveLength(2);
    });

    it("needs a session and not the current terms", async () => {
      expect((await changePassword(undefined)).statusCode).toBe(401);
      expect((await changePassword("not-a-token")).json()).toMatchObject({ error: { code: "unauthenticated" } });

      const account = await person({ accepted_terms_version: null, terms_accepted_at: null });
      const access = await signedIn(account.user.email);
      expect((await changePassword(access)).statusCode).toBe(204);
    });
  });

  describe("races", () => {
    it("refuses a sign-in that verified the old password when a change commits before its session starts", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);

      await withLockedUser(account.user.id, async (locker) => {
        // The change verifies and queues on the lock first; the sign-in
        // verifies the old password and queues behind it at its recheck.
        const change = changePassword(access);
        change.catch(() => undefined);
        await waitForBlocked(1, locker.pid);
        const pendingSignIn = signIn(account.user.email, PASSWORD);
        pendingSignIn.catch(() => undefined);
        await waitForBlocked(2, locker.pid);
        await locker.query("commit");

        expect((await change).statusCode).toBe(204);
        const refused = await pendingSignIn;
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({ error: { code: "invalid_credentials" } });
        expect(refused.headers["set-cookie"]).toBeUndefined();
      });

      const sessions = await ownerDb.selectFrom("sessions").select("id").where("user_id", "=", account.user.id).execute();
      expect(sessions).toHaveLength(1);
      expect(await auditRows("user.sign_in_failed")).toEqual([
        expect.objectContaining({ actor_user_id: account.user.id, metadata: { reason: "password_changed" } }),
      ]);
      expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it("a reset completed between the change's verify and its lock refuses the change, and the reset's password stands", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);
      const resetPassword = "canary-reset-91b0aa-password";
      const resetHash = await hashPassword(resetPassword);

      await withLockedUser(account.user.id, async (locker) => {
        const change = changePassword(access);
        change.catch(() => undefined);
        await waitForBlocked(1, locker.pid);
        // The reset's writes, committed while the change waits for the row.
        await locker.query("update users set password_hash = $1, updated_at = now() where id = $2", [
          resetHash,
          account.user.id,
        ]);
        await locker.query("commit");

        const refused = await change;
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: { code: "current_password_incorrect" } });
      });

      expect(await storedHash(account.user.id)).toBe(resetHash);
      expect((await signIn(account.user.email, resetPassword)).statusCode).toBe(200);
      expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(401);
      expect((await signIn(account.user.email, PASSWORD)).statusCode).toBe(401);
      expect(await auditRows("user.password_changed")).toEqual([]);
      expect(await auditRows("user.reauthentication_failed")).toEqual([
        expect.objectContaining({ actor_user_id: account.user.id, metadata: { purpose: "password_change" } }),
      ]);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("two changes with the same current password at once: exactly one succeeds, the other answers current_password_incorrect", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);
      const newPasswords = ["canary-first-a1b2c3-password", "canary-second-d4e5f6-password"];

      let responses: LightMyRequestResponse[] = [];
      await withLockedUser(account.user.id, async (locker) => {
        // Both verify the same current password before either can lock.
        const both = Promise.all(
          newPasswords.map((newPassword) => changePassword(access, { currentPassword: PASSWORD, newPassword })),
        );
        both.catch(() => undefined);
        await waitForBlocked(2, locker.pid);
        await locker.query("commit");
        responses = await both;
      });

      const statuses = responses.map((response) => response.statusCode).sort();
      expect(statuses).toEqual([204, 400]);
      const loser = responses.find((response) => response.statusCode === 400)!;
      expect(loser.json()).toMatchObject({ error: { code: "current_password_incorrect" } });
      const winner = newPasswords[responses.findIndex((response) => response.statusCode === 204)]!;
      const other = newPasswords.find((candidate) => candidate !== winner)!;
      expect((await signIn(account.user.email, winner)).statusCode).toBe(200);
      expect((await signIn(account.user.email, other)).statusCode).toBe(401);
      expect(await auditRows("user.password_changed")).toHaveLength(1);
      expect(await auditRows("user.reauthentication_failed")).toHaveLength(1);
      await runner.settle();
      expect(mailer.sent).toHaveLength(1);
    });
  });
});
