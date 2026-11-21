import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { addServiceAccount, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { hashPassword } from "../identity/password.js";
import { hashToken } from "../identity/tokens.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const OLD_PASSWORD = "the-old-password-that-was-forgotten";
const NEW_PASSWORD = "a-brand-new-sufficiently-long-password";
const WRONG_PASSWORD = "not-the-right-password-at-all";
const RESET_LINK_MESSAGE = "That reset link is invalid or has expired. Request a new one.";

/** One `Set-Cookie` header, split into its name, value and attributes. */
interface SetCookie {
  name: string;
  value: string;
  attributes: string[];
}

function setCookies(response: LightMyRequestResponse): Map<string, SetCookie> {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookies = new Map<string, SetCookie>();
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";").map((part) => part.trim());
    const separator = pair!.indexOf("=");
    const name = pair!.slice(0, separator);
    cookies.set(name, { name, value: pair!.slice(separator + 1), attributes });
  }
  return cookies;
}

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const cookie = setCookies(response).get(name);
  if (!cookie) throw new Error(`the response set no ${name} cookie`);
  return cookie.value;
}

function expectCleared(response: LightMyRequestResponse): void {
  const cookies = setCookies(response);
  expect(cookies.get("telflo_access")).toEqual({
    name: "telflo_access",
    value: "",
    attributes: ["Max-Age=0", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"],
  });
  expect(cookies.get("telflo_refresh")).toEqual({
    name: "telflo_refresh",
    value: "",
    attributes: ["Max-Age=0", "Path=/api/v1/auth/refresh", "HttpOnly", "Secure", "SameSite=Lax"],
  });
}

/**
 * A response's headers without the per-IP limit's `x-ratelimit-*`, which
 * count down from one request to the next whatever the address, and `date`,
 * which can tick between them: what is left must not differ by address.
 */
function comparableHeaders(response: LightMyRequestResponse): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.headers).filter(([name]) => !name.startsWith("x-ratelimit-") && name !== "date"),
  );
}

function expectInvalidResetToken(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: { code: "invalid_reset_token", message: RESET_LINK_MESSAGE } });
}

describe("password reset routes", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let mailer: ReturnType<typeof createInMemoryMailer>;
  /** Replaced before each test, so work one test queued never runs in another. */
  let runner: CollectingRunner;
  let oldPasswordHash: string;
  /** The server's clock. Reset to real time before each test; advanced to test expiry. */
  let clock: Date;

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    mailer = createInMemoryMailer();
    server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings,
      db,
      mailer,
      now: () => clock,
      rateLimits: TEST_RATE_LIMITS,
      runAfterResponse: (task) => runner.run(task),
    });
    await server.ready();
    oldPasswordHash = await hashPassword(OLD_PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    mailer.sent.length = 0;
    runner = createCollectingRunner();
    clock = new Date();
  });

  const advanceClockMinutes = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  const user = (options: { isVerified?: boolean } = {}) =>
    createUserWithOrganization(ownerDb, {
      user: {
        password_hash: oldPasswordHash,
        ...(options.isVerified === false ? { email_verified_at: null } : {}),
      },
    });

  const requestReset = (email: string, headers: Record<string, string> = csrfHeaders) =>
    server.inject({ method: "POST", url: "/api/v1/auth/password-reset-requests", headers, payload: { email } });

  const completeReset = (
    token: string,
    password = NEW_PASSWORD,
    headers: Record<string, string> = csrfHeaders,
    target = server,
  ) => target.inject({ method: "POST", url: "/api/v1/auth/password-resets", headers, payload: { token, password } });

  const signIn = (email: string, password: string, target = server) =>
    target.inject({ method: "POST", url: "/api/v1/auth/sessions", headers: csrfHeaders, payload: { email, password } });

  const me = (access: string) =>
    server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

  /** The plaintext tokens in the reset emails sent to `email`, oldest first. */
  const tokensSentTo = (email: string): string[] =>
    mailer.sent
      .filter((message) => message.to === email)
      .map((message) => {
        const match = /\/reset-password#token=([A-Za-z0-9_-]+)/.exec(message.text);
        if (!match) throw new Error("no reset link in the email");
        return match[1]!;
      });

  /** Requests a reset for `email`, runs the work, and returns the emailed token. */
  const resetTokenFor = async (email: string): Promise<string> => {
    expect((await requestReset(email)).statusCode).toBe(202);
    await runner.settle();
    const tokens = tokensSentTo(email);
    return tokens[tokens.length - 1]!;
  };

  const countRows = async (table: "password_reset_tokens" | "audit_events") =>
    Number(
      (await ownerDb.selectFrom(table).select((eb) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow()).count,
    );

  const auditRows = (action: string) =>
    ownerDb
      .selectFrom("audit_events")
      .select(["actor_user_id", "actor_email", "subject_id", "metadata"])
      .where("action", "=", action)
      .orderBy("occurred_at")
      .execute();

  describe("POST /api/v1/auth/password-reset-requests", () => {
    it("answers an unknown, an unverified and a verified address identically, before any work runs", async () => {
      const unverified = await user({ isVerified: false });
      const verified = await user();
      const addresses = ["nobody@example.com", unverified.user.email, verified.user.email];

      const responses: LightMyRequestResponse[] = [];
      for (const email of addresses) responses.push(await requestReset(email));

      for (const response of responses) {
        expect(response.statusCode).toBe(202);
        expect(response.body).toBe(responses[0]!.body);
        expect(comparableHeaders(response)).toEqual(comparableHeaders(responses[0]!));
      }
      expect(responses[0]!.json()).toEqual({ status: "accepted" });

      // Every response is in, and nothing that depends on the address has
      // happened: the route did not wait for the work.
      expect(mailer.sent).toEqual([]);
      expect(await countRows("password_reset_tokens")).toBe(0);
      expect(await countRows("audit_events")).toBe(0);

      await runner.settle();
      expect(mailer.sent.map((message) => message.to).sort()).toEqual(
        [unverified.user.email, verified.user.email].sort(),
      );
      expect(await countRows("password_reset_tokens")).toBe(2);
    });

    it("needs the CSRF header", async () => {
      const account = await user();
      const response = await requestReset(account.user.email, {});

      expect(response.statusCode).toBe(403);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("audits a request for an account as sent and one for no account as no_account", async () => {
      const account = await user();
      await requestReset(account.user.email);
      await requestReset("nobody@example.com");
      await runner.settle();

      expect(await auditRows("user.password_reset_requested")).toEqual([
        {
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          subject_id: account.user.id,
          metadata: { outcome: "sent" },
        },
        { actor_user_id: null, actor_email: null, subject_id: null, metadata: { outcome: "no_account" } },
      ]);
    });
  });

  /**
   * A service account's address is an unknown address to the reset request
   * (and so to the settings' Set a Password, which shares it).
   * Without the human-only lookup it would be mailed a link to set a
   * password on an account that must never hold one.
   */
  describe("a service account's address", () => {
    it("a service account's address answers 202 and sends nothing, audited no_account", async () => {
      const { organization } = await user();
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: organization.id });

      const response = await requestReset(serviceAccount.email);
      const unknown = await requestReset("nobody@example.com");
      await runner.settle();

      expect(response.statusCode).toBe(202);
      expect(response.body).toBe(unknown.body);
      expect(comparableHeaders(response)).toEqual(comparableHeaders(unknown));
      expect(mailer.sent).toEqual([]);
      expect(await countRows("password_reset_tokens")).toBe(0);
      expect(await auditRows("user.password_reset_requested")).toEqual([
        { actor_user_id: null, actor_email: null, subject_id: null, metadata: { outcome: "no_account" } },
        { actor_user_id: null, actor_email: null, subject_id: null, metadata: { outcome: "no_account" } },
      ]);
    });

    it("a human's address answers 202 and sends the link, beside it", async () => {
      const account = await user();

      expect((await requestReset(account.user.email)).statusCode).toBe(202);
      await runner.settle();

      expect(mailer.sent.map((message) => message.to)).toEqual([account.user.email]);
      expect(await countRows("password_reset_tokens")).toBe(1);
    });
  });

  describe("POST /api/v1/auth/password-resets", () => {
    it("sets the password from the emailed link: the new one signs in and the old one no longer does", async () => {
      const account = await user();
      const token = await resetTokenFor(account.user.email);

      const response = await completeReset(token);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
      const old = await signIn(account.user.email, OLD_PASSWORD);
      expect(old.statusCode).toBe(401);
      expect(old.json()).toMatchObject({ error: { code: "invalid_credentials" } });
    });

    it("revokes every session with password_reset and clears this browser's session cookies", async () => {
      const account = await user();
      const first = cookieValue(await signIn(account.user.email, OLD_PASSWORD), "telflo_access");
      const second = cookieValue(await signIn(account.user.email, OLD_PASSWORD), "telflo_access");
      expect((await me(first)).statusCode).toBe(200);
      expect((await me(second)).statusCode).toBe(200);
      const token = await resetTokenFor(account.user.email);

      const response = await completeReset(token);

      expect(response.statusCode).toBe(204);
      expectCleared(response);
      for (const access of [first, second]) {
        const refused = await me(access);
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({ error: { code: "unauthenticated" } });
      }
      const sessions = await ownerDb.selectFrom("sessions").select(["revoked_at", "revoked_reason"]).execute();
      expect(sessions).toHaveLength(2);
      for (const session of sessions) {
        expect(session.revoked_at).not.toBeNull();
        expect(session.revoked_reason).toBe("password_reset");
      }
    });

    it("a completed reset doesn't touch the theme cookie: only the session's are cleared", async () => {
      const account = await user();
      cookieValue(await signIn(account.user.email, OLD_PASSWORD), "telflo_access");
      const token = await resetTokenFor(account.user.email);

      const response = await completeReset(token);

      expect(response.statusCode).toBe(204);
      expect([...setCookies(response).keys()]).toEqual(["telflo_access", "telflo_refresh"]);
    });

    it("lets an unverified user who completes a reset sign in", async () => {
      const account = await user({ isVerified: false });
      const before = await signIn(account.user.email, OLD_PASSWORD);
      expect(before.json()).toMatchObject({ error: { code: "email_not_verified" } });
      const token = await resetTokenFor(account.user.email);

      expect((await completeReset(token)).statusCode).toBe(204);

      expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it("refuses a second use of the link", async () => {
      const account = await user();
      const token = await resetTokenFor(account.user.email);
      expect((await completeReset(token)).statusCode).toBe(204);

      expectInvalidResetToken(await completeReset(token, "yet-another-long-password"));
      expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it("refuses a link superseded by a later request, and accepts the later one", async () => {
      const account = await user();
      const earlier = await resetTokenFor(account.user.email);
      const later = await resetTokenFor(account.user.email);
      expect(later).not.toBe(earlier);

      expectInvalidResetToken(await completeReset(earlier));
      expect((await signIn(account.user.email, OLD_PASSWORD)).statusCode).toBe(200);
      expect((await completeReset(later)).statusCode).toBe(204);
    });

    it("refuses a link at 60 minutes on the injected clock", async () => {
      const account = await user();
      const token = await resetTokenFor(account.user.email);
      advanceClockMinutes(60);

      expectInvalidResetToken(await completeReset(token));
      expect((await signIn(account.user.email, OLD_PASSWORD)).statusCode).toBe(200);
    });

    it("refuses an unknown token", async () => {
      expectInvalidResetToken(await completeReset("never-issued"));
    });

    it("needs the CSRF header", async () => {
      const account = await user();
      const token = await resetTokenFor(account.user.email);

      expect((await completeReset(token, NEW_PASSWORD, {})).statusCode).toBe(403);
      expect((await signIn(account.user.email, OLD_PASSWORD)).statusCode).toBe(200);
    });

    it("clears the sign-in lockout the old password earned", async () => {
      const lockedServer = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer,
        now: () => clock,
        rateLimits: { ...TEST_RATE_LIMITS, signInPerEmail: { max: 2, windowMs: 15 * 60_000 } },
        runAfterResponse: (task) => runner.run(task),
      });
      try {
        await lockedServer.ready();
        const account = await user();
        const bystander = await user();
        for (const email of [account.user.email, bystander.user.email]) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            expect((await signIn(email, WRONG_PASSWORD, lockedServer)).statusCode).toBe(401);
          }
        }
        // Without a reset, the lockout stands.
        expect((await signIn(bystander.user.email, OLD_PASSWORD, lockedServer)).statusCode).toBe(429);

        const request = await lockedServer.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset-requests",
          headers: csrfHeaders,
          payload: { email: account.user.email },
        });
        expect(request.statusCode).toBe(202);
        await runner.settle();
        const [token] = tokensSentTo(account.user.email);
        expect((await completeReset(token!, NEW_PASSWORD, csrfHeaders, lockedServer)).statusCode).toBe(204);

        expect((await signIn(account.user.email, NEW_PASSWORD, lockedServer)).statusCode).toBe(200);
      } finally {
        await lockedServer.close();
      }
    });

    it("audits a completed reset with its counts, and a failed one with its reason", async () => {
      const account = await user({ isVerified: false });
      const token = await resetTokenFor(account.user.email);

      await completeReset(token);
      await completeReset(token);
      await completeReset("never-issued");

      expect(await auditRows("user.password_reset")).toEqual([
        {
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          subject_id: account.user.id,
          metadata: { revokedSessions: 0, emailConfirmed: true },
        },
      ]);
      expect(await auditRows("user.password_reset_failed")).toEqual([
        {
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          subject_id: account.user.id,
          metadata: { reason: "used" },
        },
        { actor_user_id: null, actor_email: null, subject_id: null, metadata: { reason: "unknown_token" } },
      ]);
    });

    describe("concurrency", () => {
      /**
       * Resolves once `count` backends other than `lockerPid` are waiting on a
       * lock while running a statement against users or password_reset_tokens;
       * throws after five seconds rather than hanging the suite.
       */
      const waitForBlockedBackends = async (lockerPid: number, count: number): Promise<void> => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const { rows } = await sql<{ blocked: number }>`
            select count(*)::int as blocked
            from pg_stat_activity
            where datname = current_database()
              and pid <> ${lockerPid}
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and (query ilike '%users%' or query ilike '%password_reset_tokens%')
          `.execute(ownerDb);
          if ((rows[0]?.blocked ?? 0) >= count) return;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} blocked backends`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      /**
       * Swaps in a runner that only queues, so a test can start each reset
       * request's after-response work itself, when it chooses.
       */
      const queueAfterResponseWork = (): Array<() => Promise<void>> => {
        const tasks: Array<() => Promise<void>> = [];
        runner = {
          run: (task) => {
            tasks.push(task);
          },
          settle: async () => undefined,
        };
        return tasks;
      };

      /** Holds `user`'s row `for update` on its own connection until `release`. */
      const lockUserRow = async (userId: string) => {
        const locker = await pool.connect();
        await locker.query("begin");
        let held = true;
        await locker.query("select id from users where id = $1 for update", [userId]);
        const pid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
        return {
          pid,
          release: async () => {
            if (held) {
              held = false;
              await locker.query("rollback");
            }
          },
          close: async () => {
            try {
              if (held) {
                held = false;
                await locker.query("rollback");
              }
            } finally {
              locker.release();
            }
          },
        };
      };

      const liveTokenHashes = async (userId: string) =>
        (
          await ownerDb
            .selectFrom("password_reset_tokens")
            .select("token_hash")
            .where("user_id", "=", userId)
            .where("consumed_at", "is", null)
            .execute()
        ).map((row) => row.token_hash);

      it("lets exactly one of two completions with one token succeed", async () => {
        // A separate connection holds the token's row lock until both
        // completions are blocked at the database, so they really race.
        // The first to lock the user's row waits on the token's; the
        // other waits on the user's row behind it.
        const account = await user();
        const token = await resetTokenFor(account.user.email);

        const locker = await pool.connect();
        let lockerInTransaction = false;
        try {
          await locker.query("begin");
          lockerInTransaction = true;
          await locker.query("select id from password_reset_tokens where token_hash = $1 for update", [
            hashToken(token),
          ]);
          const lockerPid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

          const first = completeReset(token, NEW_PASSWORD);
          const second = completeReset(token, "the-second-racing-password");
          first.catch(() => undefined);
          second.catch(() => undefined);
          await waitForBlockedBackends(lockerPid, 2);

          await locker.query("rollback");
          lockerInTransaction = false;

          const responses = await Promise.all([first, second]);
          const statuses = responses.map((response) => response.statusCode).sort();
          expect(statuses).toEqual([204, 400]);
          expectInvalidResetToken(responses.find((response) => response.statusCode === 400)!);
          expect(await auditRows("user.password_reset")).toHaveLength(1);
        } finally {
          if (lockerInTransaction) await locker.query("rollback");
          locker.release();
        }
      });

      it("leaves one live link, the second request's, after two concurrent requests for one user", async () => {
        // The locker holds the user's row, as a reset request's transaction
        // does, until the first request's work is blocked on it and then the
        // second's. Each reads the clock before it blocks, a second apart, so
        // the rows say which request wrote them.
        const account = await user();
        const tasks = queueAfterResponseWork();
        expect((await requestReset(account.user.email)).statusCode).toBe(202);
        expect((await requestReset(account.user.email)).statusCode).toBe(202);
        expect(tasks).toHaveLength(2);

        const locker = await pool.connect();
        let lockerInTransaction = false;
        try {
          await locker.query("begin");
          lockerInTransaction = true;
          await locker.query("select id from users where id = $1 for update", [account.user.id]);
          const lockerPid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

          const firstAt = clock;
          const first = tasks[0]!();
          first.catch(() => undefined);
          await waitForBlockedBackends(lockerPid, 1);
          const secondAt = new Date(firstAt.getTime() + 1000);
          clock = secondAt;
          const second = tasks[1]!();
          second.catch(() => undefined);
          await waitForBlockedBackends(lockerPid, 2);

          await locker.query("rollback");
          lockerInTransaction = false;
          await Promise.all([first, second]);

          const rows = await ownerDb
            .selectFrom("password_reset_tokens")
            .select(["expires_at", "consumed_at"])
            .where("user_id", "=", account.user.id)
            .orderBy("expires_at")
            .execute();
          expect(rows).toEqual([
            { expires_at: new Date(firstAt.getTime() + 60 * 60_000), consumed_at: secondAt },
            { expires_at: new Date(secondAt.getTime() + 60 * 60_000), consumed_at: null },
          ]);
          // Both emails went out; only the second's link, the live row's, works.
          const live = await ownerDb
            .selectFrom("password_reset_tokens")
            .select("token_hash")
            .where("consumed_at", "is", null)
            .executeTakeFirstOrThrow();
          const sent = tokensSentTo(account.user.email);
          expect(sent).toHaveLength(2);
          const superseded = sent.find((token) => hashToken(token) !== live.token_hash)!;
          const current = sent.find((token) => hashToken(token) === live.token_hash)!;
          expectInvalidResetToken(await completeReset(superseded));
          expect((await completeReset(current)).statusCode).toBe(204);
        } finally {
          if (lockerInTransaction) await locker.query("rollback");
          locker.release();
        }
      });

      describe("a reset request and a completion for one user at once", () => {
        // Both lock the user's row before any token row, so whichever reaches
        // it second waits for the first to commit. In the other order a
        // completion would consume its token and then wait for the user's
        // row, while a request held the user's row and waited to consume that
        // token: Postgres would break the deadlock (40P01) by failing one.
        // A locker holds the user's row until both are blocked, the first to
        // block first in line.

        it("when the request reaches the user's row first, the request supersedes the link and the completion is refused", async () => {
          // The order that deadlocked: the completion would hold its token
          // while the request, holding the user's row, went to consume it.
          const account = await user();
          const token = await resetTokenFor(account.user.email);
          const tasks = queueAfterResponseWork();
          expect((await requestReset(account.user.email)).statusCode).toBe(202);
          expect(tasks).toHaveLength(1);

          const locker = await lockUserRow(account.user.id);
          try {
            const request = tasks[0]!();
            request.catch(() => undefined);
            await waitForBlockedBackends(locker.pid, 1);
            const completion = completeReset(token);
            completion.catch(() => undefined);
            await waitForBlockedBackends(locker.pid, 2);

            await locker.release();
            const [requestResult, completionResult] = await Promise.allSettled([request, completion]);

            expect(requestResult).toEqual({ status: "fulfilled", value: undefined });
            expect(completionResult.status).toBe("fulfilled");
            const response = (completionResult as PromiseFulfilledResult<LightMyRequestResponse>).value;
            expectInvalidResetToken(response);

            // The password is unchanged, and the one live link is the one the
            // request just emailed; it works.
            expect((await signIn(account.user.email, OLD_PASSWORD)).statusCode).toBe(200);
            const sent = tokensSentTo(account.user.email);
            expect(sent).toHaveLength(2);
            expect(await liveTokenHashes(account.user.id)).toEqual([hashToken(sent[1]!)]);
            expect((await completeReset(sent[1]!)).statusCode).toBe(204);
            expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
          } finally {
            await locker.close();
          }
        });

        it("when the completion reaches the user's row first, the password changes and the request's new link is the one live", async () => {
          const account = await user();
          const token = await resetTokenFor(account.user.email);
          const tasks = queueAfterResponseWork();
          expect((await requestReset(account.user.email)).statusCode).toBe(202);
          expect(tasks).toHaveLength(1);

          const locker = await lockUserRow(account.user.id);
          try {
            const completion = completeReset(token);
            completion.catch(() => undefined);
            await waitForBlockedBackends(locker.pid, 1);
            const request = tasks[0]!();
            request.catch(() => undefined);
            await waitForBlockedBackends(locker.pid, 2);

            await locker.release();
            const [completionResult, requestResult] = await Promise.allSettled([completion, request]);

            expect(requestResult).toEqual({ status: "fulfilled", value: undefined });
            expect(completionResult.status).toBe("fulfilled");
            expect((completionResult as PromiseFulfilledResult<LightMyRequestResponse>).value.statusCode).toBe(204);

            expect((await signIn(account.user.email, NEW_PASSWORD)).statusCode).toBe(200);
            expect((await signIn(account.user.email, OLD_PASSWORD)).statusCode).toBe(401);
            const sent = tokensSentTo(account.user.email);
            expect(sent).toHaveLength(2);
            expect(await liveTokenHashes(account.user.id)).toEqual([hashToken(sent[1]!)]);
            expectInvalidResetToken(await completeReset(token));
          } finally {
            await locker.close();
          }
        });
      });
    });
  });
});
