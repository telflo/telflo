import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { sql, type Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import {
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import { createCollectingRunner } from "../http/after-response.js";
import { TEST_RATE_LIMITS } from "../http/rate-limits.js";
import { createMailer } from "../mail/create-mailer.js";
import type { IMailer } from "../mail/mailer.js";
import { hashToken } from "../modules/identity/tokens.js";
import { buildServer } from "../server.js";
import { loadSettings, type AppSettings } from "../settings.js";
import { UNCALLED_FILE_STORE } from "../testing/file-store.js";
import { useFakeOpampServer } from "../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../testing/otelcol-validator.js";
import {
  BOOTSTRAP_MESSAGES,
  bootstrapFirstProductAdmin,
  printResetLink,
  REFUSING_MAILER,
  RESET_LINK_MESSAGES,
  type BootstrapDependencies,
  type BootstrapInput,
} from "./bootstrap.js";

/*
 * `telflo-admin bootstrap`'s paths (D36-1 decisions 37 and 54, Preflight
 * ruling 3, Q266) against the test database as the API's role and the
 * test's own Mailpit: the first admin made, with its group organization,
 * and its set-password link printed once as stdout's last line, never
 * mailed (the Mailpit stays empty and the commands' refusing mailer is
 * never called), and on no other line, log or audit row; refused (exit 1,
 * nothing changed) when a product admin exists or the address is taken;
 * the account kept and exit 1 when the link can't be made. Tokens and
 * links are checked with boolean canaries only; nothing here prints one.
 * `telflo-admin reset-link` (Q258) is tested here too: the same link, for
 * a live person. The first admin's first sign-in lands in the
 * bootstrap's organization (Q265).
 */

const opamp = useFakeOpampServer();

const MAILPIT_API = (() => {
  const url = process.env.TELFLO_MAILPIT_API_URL;
  if (!url) throw new Error("TELFLO_MAILPIT_API_URL must point at the test's own Mailpit; it never defaults to a developer's");
  return url;
})();

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
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

/** A line that looks like a link or carries a token. */
const isLinkShaped = (text: string) => /token=|reset-password|https?:\/\//i.test(text);

/** A line as an assertion may show it: a link-shaped one hidden, so a failing comparison never prints a link. */
const hide = (line: string) => (isLinkShaped(line) ? "<a link-shaped line>" : line);

/**
 * Audit metadata as an assertion may show it: every string value that looks
 * like a link hidden (`hide`), so a failing comparison of audit rows never
 * prints one, even if a link ever reached a row.
 */
const hideMetadata = (metadata: unknown): unknown =>
  JSON.parse(JSON.stringify(metadata ?? null, (_key, value: unknown) => (typeof value === "string" ? hide(value) : value)));

/** A run's exit code and lines, link-shaped lines hidden (`hide`): what a `toEqual` compares. */
const shown = (result: { code: number; out: string[]; err: string[] }) => ({
  code: result.code,
  out: result.out.map(hide),
  err: result.err.map(hide),
});

/**
 * Runs `work` with every console method and the process's own stdout and
 * stderr captured, nothing forwarded (so a leak is never printed): what the
 * command or anything it calls wrote outside its two line sinks.
 */
async function capturingStrayOutput<Result>(work: () => Promise<Result>): Promise<{ result: Result; stray: string }> {
  const chunks: string[] = [];
  const record = (...args: unknown[]) => {
    chunks.push(args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)))).join(" "));
  };
  const spies = [
    ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(record),
    ),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (record(String(chunk)), true)),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (record(String(chunk)), true)),
  ];
  try {
    return { result: await work(), stray: chunks.join("\n") };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const EMAIL = "first-admin@example.com";
const ORGANIZATION = "Acme Operations";

describe("telflo-admin bootstrap", () => {
  let settings: AppSettings;
  let databases: TestDatabases;
  /** The API's own role, as the command runs. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures and reading rows back. */
  let ownerDb: Kysely<Database>;
  /** The API's own, for the server the link is completed through: the commands never use it. */
  let mailer: IMailer;
  let clock: Date;
  /** The commands' refusing mailer, watched: a call would be an email the command tried to send. */
  let mailAttempts: MockInstance<IMailer["send"]>;
  const PASSWORD = "a-sufficiently-long-first-password";
  const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

  beforeAll(() => {
    settings = loadSettings(process.env);
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    mailer = createMailer(settings.mail);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    await clearMailpit();
    clock = new Date();
    mailAttempts = vi.spyOn(REFUSING_MAILER, "send");
    return () => mailAttempts.mockRestore();
  });

  /** Runs the command; answers its exit code and every line it printed. */
  const run = async (
    overrides: Partial<BootstrapDependencies> = {},
    input: BootstrapInput = { email: EMAIL, organization: ORGANIZATION },
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await bootstrapFirstProductAdmin(input, {
      db,
      settings,
      opampServer: opamp.client,
      now: () => clock,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...overrides,
    });
    return { code, out, err };
  };

  /**
   * No email: the commands' mailer never asked to send one, and the Mailpit (the API's relay) holds none.
   * Counted, never compared as calls: a failing call matcher would print the message, link and all.
   */
  const expectNoMail = async () => {
    expect(mailAttempts.mock.calls.length).toBe(0);
    expect((await listMailpitMessages()).length).toBe(0);
  };

  const flagHolders = async () =>
    (await ownerDb.selectFrom("users").select("id").where("is_product_admin", "=", true).execute()).map((row) => row.id);
  const everything = async () => ({
    users: await ownerDb.selectFrom("users").selectAll().orderBy("id").execute(),
    organizations: await ownerDb.selectFrom("organizations").selectAll().orderBy("id").execute(),
    members: await ownerDb.selectFrom("organization_members").selectAll().orderBy("id").execute(),
    audits: (await ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute()).map((row) => ({
      ...row,
      metadata: hideMetadata(row.metadata),
    })),
    resets: await ownerDb.selectFrom("password_reset_tokens").selectAll().orderBy("id").execute(),
  });

  it("makes the first product admin: the account (no password, unconfirmed, no Terms), the flag, the group organization with it as admin, the audit trail, and the set-password link printed once as stdout's last line, never mailed; the link sets the password, confirms the email, signs in (landing in the bootstrap's organization, Q265) and works once", async () => {
    const { result, stray } = await capturingStrayOutput(() => run());

    expect(result.code).toBe(0);
    expect(result.err.map(hide)).toEqual([]);
    expect(result.out.slice(0, -1).map(hide)).toEqual([
      BOOTSTRAP_MESSAGES.created(EMAIL),
      BOOTSTRAP_MESSAGES.organizationCreated,
      BOOTSTRAP_MESSAGES.linkFollows,
    ]);
    expect(BOOTSTRAP_MESSAGES.linkFollows).toBe("Open this link within 60 minutes to set the password (it works once):");
    expect(result.out.filter(isLinkShaped).length).toBe(1);
    const link = result.out.at(-1)!;
    const prefix = `${settings.publicWebUrl}/reset-password#token=`;
    expect(link.startsWith(prefix)).toBe(true);
    const token = link.slice(prefix.length);
    expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    // Nowhere else: not stderr, not a stray console or process write.
    expect(isLinkShaped(stray) || stray.includes(token)).toBe(false);
    expect([...result.out, ...result.err].some((line) => line.includes(ORGANIZATION))).toBe(false);

    // Never mailed (Q266).
    await expectNoMail();

    const user = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      email: EMAIL,
      kind: "human",
      password_hash: null,
      email_verified_at: null,
      accepted_terms_version: null,
      terms_accepted_at: null,
      is_product_admin: true,
      deleted_at: null,
    });
    const organizations = await ownerDb.selectFrom("organizations").selectAll().orderBy("created_at").orderBy("id").execute();
    expect(organizations.map(({ type, name, owner_user_id }) => ({ type, name, owner: owner_user_id }))).toEqual([
      { type: "personal", name: EMAIL, owner: user.id },
      { type: "group", name: ORGANIZATION, owner: null },
    ]);
    const members = await ownerDb.selectFrom("organization_members").selectAll().execute();
    expect(members.map(({ organization_id, user_id, role }) => ({ organization_id, user_id, role })).sort((a, b) => a.organization_id.localeCompare(b.organization_id))).toEqual(
      organizations
        .map((organization) => ({ organization_id: organization.id, user_id: user.id, role: "admin" }))
        .sort((a, b) => a.organization_id.localeCompare(b.organization_id)),
    );

    const audits = await ownerDb.selectFrom("audit_events").selectAll().orderBy("occurred_at").orderBy("id").execute();
    const [personal, group] = [organizations.find((o) => o.type === "personal")!, organizations.find((o) => o.type === "group")!];
    expect(
      audits.map(({ action, organization_id, metadata }) => ({ action, organization_id, metadata: hideMetadata(metadata) })),
    ).toEqual(
      expect.arrayContaining([
        { action: "user.registered", organization_id: personal.id, metadata: { via: "bootstrap" } },
        { action: "organization.created", organization_id: personal.id, metadata: { type: "personal" } },
        { action: "organization_member.added", organization_id: personal.id, metadata: { role: "admin" } },
        { action: "product_admin.bootstrapped", organization_id: null, metadata: {} },
        { action: "organization.created", organization_id: group.id, metadata: { type: "group", name: ORGANIZATION } },
        { action: "organization_member.added", organization_id: group.id, metadata: { role: "admin" } },
        // Handed back, not mailed; no `via` (reset-link's alone carries the command's name).
        { action: "user.password_reset_requested", organization_id: null, metadata: { outcome: "returned" } },
      ]),
    );
    expect(audits.filter((row) => row.action === "user.password_reset_requested")).toHaveLength(1);
    expect(audits.every((row) => row.actor_user_id === user.id)).toBe(true);
    expect(JSON.stringify(audits).includes(token)).toBe(false);

    // The password reset's token: stored as its hash only, 60 minutes from the command's clock.
    const resets = await ownerDb.selectFrom("password_reset_tokens").selectAll().execute();
    expect(resets.length).toBe(1);
    expect(resets[0]!.token_hash === hashToken(token)).toBe(true);
    expect(JSON.stringify(resets).includes(token)).toBe(false);
    expect(resets[0]!.expires_at.getTime() - clock.getTime()).toBe(60 * 60_000);

    // Both organizations registered in the opamp-server before the command ended: a create again changes nothing.
    for (const organization of organizations) {
      expect((await opamp.client.createOrganization({ id: organization.id, name: organization.name })).kind).toBe("unchanged");
    }

    // Through the API's own routes, their log captured: the password set,
    // the email confirmed, a sign-in that lands in the bootstrap's
    // organization (Q265: no earlier session, so the newest membership),
    // and the link refused a second time.
    const logLines: string[] = [];
    const { server, runner } = serverLogging(logLines);
    try {
      await server.ready();
      const complete = () =>
        server.inject({
          method: "POST",
          url: "/api/v1/auth/password-resets",
          headers: csrfHeaders,
          payload: { token, password: PASSWORD },
        });
      expect((await complete()).statusCode).toBe(204);
      const after = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
      expect(after.password_hash !== null && after.email_verified_at !== null && after.is_product_admin).toBe(true);
      const signIn = await server.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: csrfHeaders,
        payload: { email: EMAIL, password: PASSWORD },
      });
      expect(signIn.statusCode).toBe(200);
      const access = signIn.cookies.find((cookie) => cookie.name === "telflo_access");
      const me = await server.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        cookies: { telflo_access: access?.value ?? "" },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ organization: { id: string; type: string } }>().organization).toMatchObject({ id: group.id, type: "group" });
      const again = await complete();
      expect(again.statusCode).toBe(400);
      expect(again.json()).toMatchObject({ error: { code: "invalid_reset_token" } });
      await runner.settle();
    } finally {
      await server.close();
    }
    expect(logLines.length > 0).toBe(true);
    expect(logLines.some((line) => line.includes(token))).toBe(false);
  });

  it("refuses with exit 1 when a product admin exists, changing nothing, printing no link and sending nothing, whoever holds the flag (a deleted admin included)", async () => {
    for (const deleted of [false, true]) {
      await truncateAll(ownerDb);
      const admin = await createUserWithOrganization(ownerDb, { user: { is_product_admin: true } });
      if (deleted) await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", admin.user.id).execute();
      const before = await everything();

      expect(shown(await run())).toEqual({ code: 1, out: [], err: [BOOTSTRAP_MESSAGES.productAdminExists] });
      expect(await everything()).toEqual(before);
    }
    // Before the address's check: a taken address with an admin is still "a product admin exists".
    await createUserWithOrganization(ownerDb, { user: { email: EMAIL } });
    expect((await run()).err.map(hide)).toEqual([BOOTSTRAP_MESSAGES.productAdminExists]);
    await expectNoMail();
  });

  it("refuses a second run with exit 1: the first admin stays the only one", async () => {
    expect((await run()).code).toBe(0);
    const before = await everything();

    expect(shown(await run({}, { email: "second-admin@example.com", organization: "Beta" }))).toEqual({
      code: 1,
      out: [],
      err: [BOOTSTRAP_MESSAGES.productAdminExists],
    });
    expect(await everything()).toEqual(before);
    expect(await flagHolders()).toHaveLength(1);
  });

  it("refuses with exit 1 when an account, live or deleted, has the address, changing nothing", async () => {
    for (const deleted of [false, true]) {
      await truncateAll(ownerDb);
      const taken = await createUserWithOrganization(ownerDb, { user: { email: EMAIL } });
      if (deleted) await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", taken.user.id).execute();
      const before = await everything();

      expect(shown(await run())).toEqual({ code: 1, out: [], err: [BOOTSTRAP_MESSAGES.emailTaken] });
      expect(await everything()).toEqual(before);
    }
    await expectNoMail();
  });

  it("keeps the account and answers exit 1 when the link can't be made after the commit, printing no link: reset-link makes one later", async () => {
    let result!: Awaited<ReturnType<typeof run>>;
    await withFailingInsert(ownerDb, "password_reset_tokens", "raise exception 'reset token insert refused'", async () => {
      result = await run();
    });

    expect(shown(result)).toEqual({
      code: 1,
      out: [BOOTSTRAP_MESSAGES.created(EMAIL), BOOTSTRAP_MESSAGES.organizationCreated],
      err: [BOOTSTRAP_MESSAGES.linkFailed(EMAIL)],
    });
    expect(BOOTSTRAP_MESSAGES.linkFailed(EMAIL)).toBe(
      `The link to set the password wasn't made. Make one with: telflo-admin reset-link --email ${EMAIL}`,
    );
    expect([...result.out, ...result.err].some((line) => line.includes("refused") || isLinkShaped(line))).toBe(false);
    expect(await flagHolders()).toHaveLength(1);
    expect(await ownerDb.selectFrom("password_reset_tokens").select("id").execute()).toEqual([]);
    await expectNoMail();
  });

  it("keeps the account and still prints the link when the organization's name is taken: exit 1, the organization made later", async () => {
    await createUserWithOrganization(ownerDb, { organization: { type: "group", name: ORGANIZATION.toUpperCase() } });

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.out.slice(0, -1).map(hide)).toEqual([BOOTSTRAP_MESSAGES.created(EMAIL), BOOTSTRAP_MESSAGES.linkFollows]);
    expect(isLinkShaped(result.out.at(-1)!)).toBe(true);
    expect(result.err.map(hide)).toEqual([BOOTSTRAP_MESSAGES.organizationNameTaken]);
    expect(await flagHolders()).toHaveLength(1);
    await expectNoMail();
  });

  it("says once, in fixed words, when the opamp-server missed a registration; the rest is done", async () => {
    opamp.fake.nextFault("error_500", "createOrganization");

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.err.map(hide)).toEqual([BOOTSTRAP_MESSAGES.opampServerMissed]);
    expect(await flagHolders()).toHaveLength(1);
  });

  it("two bootstraps for different addresses started together leave exactly one product admin: one succeeds, the other is refused 'admin exists' and leaves no account behind (Ruling 353)", async () => {
    // Both are held at the function's advisory lock until both wait there, then let go together, so
    // each passes its first check and they race for the account's transaction, where the lock decides.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedYet!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedYet = resolve;
    });
    const holder = ownerDb.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtext('telflo.bootstrap_first_product_admin'))`.execute(transaction);
      lockedYet();
      await released;
    });
    await locked;
    const emails = ["racer-one@example.com", "racer-two@example.com"];
    let settled = 0;
    const runs = emails.map((email) =>
      run({}, { email, organization: `Org of ${email}` }).finally(() => {
        settled += 1;
      }),
    );
    // Until both wait at the lock, or (were the lock missing) both have ended without ever waiting.
    let waiting = 0;
    for (let attempt = 0; attempt < 500 && waiting < 2 && settled < 2; attempt += 1) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::integer as waiting from pg_stat_activity
         where wait_event_type = 'Lock' and wait_event = 'advisory' and datname = current_database()
      `.execute(ownerDb);
      waiting = rows[0]!.waiting;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await holder;
    const results = await Promise.all(runs);

    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const winner = results.findIndex((result) => result.code === 0);
    const loser = 1 - winner;
    expect(shown(results[loser]!)).toEqual({ code: 1, out: [], err: [BOOTSTRAP_MESSAGES.productAdminExists] });
    expect(results[winner]!.err.map(hide)).toEqual([]);

    const users = await ownerDb.selectFrom("users").select(["id", "email", "is_product_admin"]).execute();
    expect(users.map(({ email, is_product_admin }) => ({ email, is_product_admin }))).toEqual([
      { email: emails[winner], is_product_admin: true },
    ]);
    // No orphan of the loser's: no organization, membership or audit row of a user that doesn't exist.
    const organizations = await ownerDb.selectFrom("organizations").select(["type", "owner_user_id"]).execute();
    expect(organizations.map((organization) => organization.type).sort()).toEqual(["group", "personal"]);
    expect(organizations.find((organization) => organization.type === "personal")!.owner_user_id).toBe(users[0]!.id);
    const members = await ownerDb.selectFrom("organization_members").select("user_id").execute();
    expect(members.every((member) => member.user_id === users[0]!.id)).toBe(true);
    const actors = await ownerDb.selectFrom("audit_events").select("actor_user_id").execute();
    expect(actors.every((row) => row.actor_user_id === users[0]!.id)).toBe(true);
    expect(await ownerDb.selectFrom("audit_events").select("id").where("action", "=", "product_admin.bootstrapped").execute()).toHaveLength(1);
    // The winner's link printed, last; no email to either.
    expect(isLinkShaped(results[winner]!.out.at(-1)!) && results[loser]!.out.length === 0).toBe(true);
    await expectNoMail();
    // Both had passed the first check and waited at the lock: the race was in the account's transaction.
    expect(waiting).toBe(2);
  });

  it("works whatever the registration mode (it doesn't read it), and with the product admins' switch at a fresh install's default, on (Q259): the first admin creates the organization", async () => {
    for (const registration of ["open", "invite-only", "closed"] as const) {
      await truncateAll(ownerDb);
      await sql`update site_settings set organization_creation = default`.execute(ownerDb);
      await clearMailpit();
      const result = await run({ settings: { ...settings, site: { ...settings.site, registration } } as AppSettings });
      expect({ registration, code: result.code, out: result.out.includes(BOOTSTRAP_MESSAGES.organizationCreated) }).toEqual({
        registration,
        code: 0,
        out: true,
      });
      expect(await ownerDb.selectFrom("organizations").select("name").where("type", "=", "group").execute()).toEqual([{ name: ORGANIZATION }]);
    }
  });

  /** The API's server with its log, every line, in `lines` (as logged-errors.integration.test.ts reads it). */
  const serverLogging = (lines: string[]) => {
    const runner = createCollectingRunner();
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    try {
      const server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer,
        now: () => new Date(),
        rateLimits: TEST_RATE_LIMITS,
        runAfterResponse: (task) => runner.run(task),
        logStream: { write: (line) => void lines.push(line) },
      });
      return { server, runner };
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
  };

  describe("reset-link (D36-1 decision 54, Q258)", () => {
    const PERSON = "person@example.com";

    /** Runs `telflo-admin reset-link`; answers its exit code and every line it printed. */
    const resetLink = async (email: string, overrides: Partial<BootstrapDependencies> = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await printResetLink(
        { email },
        {
          db,
          settings,
          opampServer: opamp.client,
          now: () => clock,
          out: (line) => out.push(line),
          err: (line) => err.push(line),
          ...overrides,
        },
      );
      return { code, out, err };
    };

    const tokenOf = (link: string) => link.slice(`${settings.publicWebUrl}/reset-password#token=`.length);

    it("prints a fresh link once, as stdout's last line after the fixed line, sending nothing; the earlier link stops working; the link is on no other line, log or audit row; it sets the password and works once", async () => {
      // The bootstrap's printed link first: the one reset-link replaces.
      const first = await run();
      expect(first.code).toBe(0);
      const earlier = tokenOf(first.out.at(-1)!);

      const { result, stray } = await capturingStrayOutput(() => resetLink(EMAIL));

      expect(result.code).toBe(0);
      expect(result.err.map(hide)).toEqual([]);
      expect(result.out.length).toBe(2);
      expect(hide(result.out[0]!)).toBe(BOOTSTRAP_MESSAGES.linkFollows);
      const link = result.out[1]!;
      expect(link.startsWith(`${settings.publicWebUrl}/reset-password#token=`)).toBe(true);
      const token = tokenOf(link);
      expect(/^[A-Za-z0-9_-]{43}$/.test(token) && token !== earlier).toBe(true);
      expect(isLinkShaped(stray) || stray.includes(token)).toBe(false);
      await expectNoMail();

      // Audited as bootstrap's request, with the command named; never the link.
      const audits = await ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "user.password_reset_requested")
        .execute();
      expect(audits).toHaveLength(2);
      expect(audits.map((row) => hideMetadata(row.metadata))).toEqual(
        expect.arrayContaining([{ outcome: "returned" }, { outcome: "returned", via: "admin_command" }]),
      );
      const everyAudit = await ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(JSON.stringify(everyAudit).includes(token) || JSON.stringify(everyAudit).includes(earlier)).toBe(false);
      // The new token hashed and live, the bootstrap's consumed.
      const resets = await ownerDb.selectFrom("password_reset_tokens").selectAll().execute();
      expect(resets.length).toBe(2);
      expect(resets.some((row) => row.token_hash === hashToken(token) && row.consumed_at === null)).toBe(true);
      expect(resets.some((row) => row.token_hash === hashToken(earlier) && row.consumed_at !== null)).toBe(true);

      const logLines: string[] = [];
      const { server, runner } = serverLogging(logLines);
      try {
        await server.ready();
        const complete = (presented: string) =>
          server.inject({
            method: "POST",
            url: "/api/v1/auth/password-resets",
            headers: csrfHeaders,
            payload: { token: presented, password: PASSWORD },
          });
        // The earlier link no longer works; the new one sets the password and confirms the email, once.
        expect((await complete(earlier)).statusCode).toBe(400);
        expect((await complete(token)).statusCode).toBe(204);
        const after = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
        expect(after.password_hash !== null && after.email_verified_at !== null).toBe(true);
        const signIn = await server.inject({
          method: "POST",
          url: "/api/v1/auth/sessions",
          headers: csrfHeaders,
          payload: { email: EMAIL, password: PASSWORD },
        });
        expect(signIn.statusCode).toBe(200);
        expect((await complete(token)).statusCode).toBe(400);
        await runner.settle();
      } finally {
        await server.close();
      }
      expect(logLines.length > 0).toBe(true);
      expect(logLines.some((line) => line.includes(token) || line.includes(earlier))).toBe(false);
    });

    it("works for a person's account with a password, in every registration mode, sending nothing", async () => {
      await createUserWithOrganization(ownerDb, { user: { email: PERSON } });
      for (const registration of ["open", "invite-only", "closed"] as const) {
        const { result, stray } = await capturingStrayOutput(() =>
          resetLink(PERSON, {
            settings: { ...settings, site: { ...settings.site, registration } } as AppSettings,
          }),
        );
        expect({ registration, code: result.code, err: result.err.map(hide), lines: result.out.length }).toEqual({
          registration,
          code: 0,
          err: [],
          lines: 2,
        });
        expect(isLinkShaped(result.out.at(-1)!) && !isLinkShaped(stray)).toBe(true);
      }
      await expectNoMail();
      // Only the newest link is live.
      const live = await ownerDb.selectFrom("password_reset_tokens").select("id").where("consumed_at", "is", null).execute();
      expect(live.length).toBe(1);
    });

    it("refuses an address with no live person's account, a deleted or a service account's included: exit 1 in fixed words, nothing printed or written, no email", async () => {
      const deleted = await createUserWithOrganization(ownerDb, { user: { email: "deleted@example.com" } });
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", deleted.user.id).execute();
      const owner = await createUserWithOrganization(ownerDb, { user: { email: PERSON } });
      const service = await addServiceAccount(ownerDb, { organizationId: owner.organization.id });
      const before = await everything();

      for (const [label, email] of [
        ["unknown", "nobody@example.com"],
        ["deleted", "deleted@example.com"],
        ["service account", service.user.email],
      ] as const) {
        const { result, stray } = await capturingStrayOutput(() => resetLink(email));
        expect({ label, ...shown(result) }).toEqual({ label, code: 1, out: [], err: [RESET_LINK_MESSAGES.noAccount] });
        expect(result.err.some((line) => line.includes(email)) || isLinkShaped(stray)).toBe(false);
      }
      expect(await everything()).toEqual(before);
      await expectNoMail();
    });
  });
});
