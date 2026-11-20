import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addServiceAccount,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { EmailMessage, IMailer } from "../../mail/mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { RATE_LIMITS, TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import {
  STARTER_CONFIGURATION_DESCRIPTION,
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
} from "../configurations/starter-configuration.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

/** Every state-changing /api/v1 request carries the CSRF header. */
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };


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

describe("identity routes", () => {
  let settings: AppSettings;
  let server: FastifyInstance;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation, test-only DDL and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;
  let mailer: IMailer & { sent: EmailMessage[] };
  /** Replaced before each test, so work one test queued never runs in another. */
  let runner: CollectingRunner;
  /** The server's clock. Reset to real time before each test; advanced to test expiry. */
  let clock: Date;

  const body = {
    email: "person@example.com",
    password: "a-sufficiently-long-password",
    acceptedTermsVersion: TEST_TERMS_VERSION,
  };

  const register = (payload: Record<string, unknown> = body) =>
    server.inject({ method: "POST", url: "/api/v1/auth/register", payload, headers: csrfHeaders });

  beforeAll(async () => {
    settings = loadSettings(process.env);
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
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
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    mailer.sent.length = 0;
    runner = createCollectingRunner();
    clock = new Date();
  });

  describe("POST /api/v1/auth/register", () => {
    it("accepts a valid registration", async () => {
      const response = await register();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "verification_sent" });
    });

    it("persists the user", async () => {
      await register();
      const rows = await ownerDb.selectFrom("users").selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.email).toBe("person@example.com");
    });

    it("writes an audit row", async () => {
      await register();
      const rows = await ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(rows.map((r) => r.action)).toContain("user.registered");
    });

    it("creates one personal organization with the expected name and one admin membership for the new user", async () => {
      await register({ ...body, email: "Person@Example.com" });
      const user = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
      const organizations = await ownerDb.selectFrom("organizations").selectAll().execute();
      const memberships = await ownerDb.selectFrom("organization_members").selectAll().execute();

      expect(organizations).toHaveLength(1);
      expect(organizations[0]).toMatchObject({
        name: "person@example.com",
        type: "personal",
        owner_user_id: user.id,
      });
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        organization_id: organizations[0]!.id,
        user_id: user.id,
        role: "admin",
      });
    });

    it("writes the three registration audit rows in order, then the starter configuration's, each with organization_id set", async () => {
      await server.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: body,
        headers: { ...csrfHeaders, "user-agent": "routes-test-agent" },
      });
      const user = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
      const organization = await ownerDb.selectFrom("organizations").selectAll().executeTakeFirstOrThrow();
      const membership = await ownerDb.selectFrom("organization_members").selectAll().executeTakeFirstOrThrow();
      const configuration = await ownerDb.selectFrom("configurations").selectAll().executeTakeFirstOrThrow();
      const rows = await ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute();

      expect(rows.map((r) => r.action)).toEqual([
        "user.registered",
        "organization.created",
        "organization_member.added",
        "configuration.created",
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          organization_id: organization.id,
          actor_user_id: user.id,
          actor_email: "person@example.com",
          user_agent: "routes-test-agent",
        });
        expect(row.ip_address).not.toBeNull();
      }
      expect(rows[1]).toMatchObject({
        subject_type: "organization",
        subject_id: organization.id,
        metadata: { type: "personal" },
      });
      expect(rows[2]).toMatchObject({
        subject_type: "organization_member",
        subject_id: membership.id,
        metadata: { role: "admin" },
      });
      expect(rows[3]).toMatchObject({
        subject_type: "configuration",
        subject_id: configuration.id,
        metadata: { name: STARTER_CONFIGURATION_NAME },
      });
    });

    it("gives the personal organization exactly one configuration, the Initial Configuration, created by the new user, built for the catalogue's default distribution at its default version", async () => {
      await register();
      const pin = await catalogueDefaults(ownerDb);
      const user = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
      const organization = await ownerDb.selectFrom("organizations").selectAll().executeTakeFirstOrThrow();
      const configurations = await ownerDb.selectFrom("configurations").selectAll().execute();
      const versions = await ownerDb.selectFrom("configuration_versions").selectAll().execute();

      expect(configurations).toEqual([
        expect.objectContaining({
          organization_id: organization.id,
          name: STARTER_CONFIGURATION_NAME,
          description: STARTER_CONFIGURATION_DESCRIPTION,
          created_by_user_id: user.id,
          // The server's clock, the terms' acceptance time.
          created_at: clock,
          updated_at: clock,
          deleted_at: null,
          collector_distribution: pin.distribution,
        }),
      ]);
      expect(user.terms_accepted_at).toEqual(clock);
      expect(versions).toEqual([
        expect.objectContaining({
          organization_id: organization.id,
          configuration_id: configurations[0]!.id,
          version_number: 1,
          yaml_content: STARTER_CONFIGURATION_YAML,
          created_by_user_id: user.id,
          created_at: clock,
          updated_at: clock,
          collector_distribution: pin.distribution,
          collector_version: pin.version,
        }),
      ]);
    });

    it("returns the error envelope for a short password", async () => {
      const response = await register({ ...body, password: "short" });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
    });

    it("rejects a malformed email", async () => {
      expect((await register({ ...body, email: "nope" })).statusCode).toBe(400);
    });

    it("rejects a request missing acceptedTermsVersion", async () => {
      const { acceptedTermsVersion: _omitted, ...rest } = body;
      expect((await register(rest)).statusCode).toBe(400);
    });

    it("refuses terms other than the current ones with terms_version_not_current, creating nothing and sending nothing", async () => {
      const response = await register({ ...body, acceptedTermsVersion: "2025-01-01" });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "terms_version_not_current",
          message: "These terms are out of date. Reload the page to see the current terms.",
        },
      });
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("audit_events").selectAll().execute()).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    });

    /**
     * The domain is refused, not the account. An address a service account
     * holds and one nobody holds get the same answer, after the terms check
     * and before any lookup or write.
     */
    it("refuses an address at the reserved domain with 422 email_reserved, whether or not a service account holds it, and writes nothing", async () => {
      const { organization } = await createUserWithOrganization(ownerDb);
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: organization.id });
      const usersBefore = await ownerDb.selectFrom("users").selectAll().orderBy("id").execute();
      const auditBefore = await ownerDb.selectFrom("audit_events").selectAll().execute();
      const addresses = [
        serviceAccount.email,
        serviceAccount.email.toUpperCase(),
        "nobody-1a2b3c4d@service-accounts.telflo.invalid",
        "  Someone@Service-Accounts.Telflo.Invalid ",
      ];

      for (const email of addresses) {
        const response = await register({ ...body, email });
        expect(response.statusCode, email).toBe(422);
        expect(response.json()).toEqual({ error: { code: "email_reserved", message: "This address can't be used" } });
      }
      expect(await ownerDb.selectFrom("users").selectAll().orderBy("id").execute()).toEqual(usersBefore);
      expect(await ownerDb.selectFrom("audit_events").selectAll().execute()).toEqual(auditBefore);
      expect(await ownerDb.selectFrom("email_verification_tokens").selectAll().execute()).toEqual([]);
      expect(mailer.sent).toEqual([]);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("refuses an address at the deleted accounts' domain with 422 email_reserved, a deleted person's anonymous address included, and writes nothing", async () => {
      const { user: person } = await createUserWithOrganization(ownerDb);
      const anonymous = `deleted-${"0a".repeat(12)}@deleted-accounts.telflo.invalid`;
      await ownerDb
        .updateTable("users")
        .set({ email: anonymous, password_hash: null, deleted_at: new Date() })
        .where("id", "=", person.id)
        .execute();
      const usersBefore = await ownerDb.selectFrom("users").selectAll().orderBy("id").execute();
      const auditBefore = await ownerDb.selectFrom("audit_events").selectAll().execute();

      for (const email of [anonymous, anonymous.toUpperCase(), "nobody@deleted-accounts.telflo.invalid", "  Someone@Deleted-Accounts.Telflo.Invalid "]) {
        const response = await register({ ...body, email });
        expect(response.statusCode, email).toBe(422);
        expect(response.json()).toEqual({ error: { code: "email_reserved", message: "This address can't be used" } });
      }
      expect(await ownerDb.selectFrom("users").selectAll().orderBy("id").execute()).toEqual(usersBefore);
      expect(await ownerDb.selectFrom("audit_events").selectAll().execute()).toEqual(auditBefore);
      expect(await ownerDb.selectFrom("email_verification_tokens").selectAll().execute()).toEqual([]);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("still registers an address at a subdomain of the reserved domain, which isn't the domain", async () => {
      const response = await register({ ...body, email: "person@sub.service-accounts.telflo.invalid" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "verification_sent" });
    });

    it("a human's existing address still answers verification_sent with the duplicate notice", async () => {
      const { user } = await createUserWithOrganization(ownerDb);

      const response = await register({ ...body, email: user.email });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "verification_sent" });
      expect(mailer.sent.map(({ to, subject }) => ({ to, subject }))).toEqual([
        { to: user.email, subject: "Someone tried to create a Telflo account with your email" },
      ]);
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(1);
    });

    it("responds identically for an already-registered email", async () => {
      const first = await register();
      const second = await register();
      expect(second.statusCode).toBe(first.statusCode);
      expect(second.json()).toEqual(first.json());
    });

    it("creates only one user when the same email registers twice", async () => {
      await register();
      await register();
      const rows = await ownerDb.selectFrom("users").selectAll().execute();
      expect(rows).toHaveLength(1);
    });

    /**
     * The account, its organization and membership, the audit trail and the
     * verification token commit together. Each case makes one insert inside
     * the transaction fail, and checks that nothing persisted and that no
     * verification email went out, since the email is sent only after the
     * commit.
     */
    describe("when an insert inside the account transaction fails", () => {
      async function expectNothingPersistedAndNoEmail(): Promise<void> {
        expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(0);
        expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(0);
        expect(await ownerDb.selectFrom("organization_members").selectAll().execute()).toHaveLength(0);
        expect(await ownerDb.selectFrom("audit_events").selectAll().execute()).toHaveLength(0);
        expect(await ownerDb.selectFrom("email_verification_tokens").selectAll().execute()).toHaveLength(0);
        expect(await ownerDb.selectFrom("configurations").selectAll().execute()).toHaveLength(0);
        expect(await ownerDb.selectFrom("configuration_versions").selectAll().execute()).toHaveLength(0);
        expect(mailer.sent).toHaveLength(0);
      }

      it("persists nothing and sends no email when the organization insert fails", async () => {
        await withFailingInsert(ownerDb, "organizations", `raise exception 'refused by test'`, async () => {
          expect((await register()).statusCode).toBe(500);
        });
        await expectNothingPersistedAndNoEmail();
      });

      it("persists nothing and sends no email when the membership insert fails", async () => {
        await withFailingInsert(ownerDb, "organization_members", `raise exception 'refused by test'`, async () => {
          expect((await register()).statusCode).toBe(500);
        });
        await expectNothingPersistedAndNoEmail();
      });

      it("persists nothing and sends no email when an audit insert fails", async () => {
        await withFailingInsert(ownerDb, "audit_events", `raise exception 'refused by test'`, async () => {
          expect((await register()).statusCode).toBe(500);
        });
        await expectNothingPersistedAndNoEmail();
      });

      it("persists nothing and sends no email when the verification token insert fails", async () => {
        await withFailingInsert(ownerDb, "email_verification_tokens", `raise exception 'refused by test'`, async () => {
          expect((await register()).statusCode).toBe(500);
        });
        await expectNothingPersistedAndNoEmail();
      });

      it.each(["configurations", "configuration_versions"] as const)(
        "persists nothing and sends no email when the starter's %s insert fails",
        async (table) => {
          await withFailingInsert(ownerDb, table, `raise exception 'refused by test'`, async () => {
            expect((await register()).statusCode).toBe(500);
          });
          await expectNothingPersistedAndNoEmail();
        },
      );
    });

    it("creates no organization or configuration when an existing email registers again", async () => {
      await register();
      await register();
      expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("organization_members").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("configurations").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("configuration_versions").selectAll().execute()).toHaveLength(1);
    });

    /**
     * registerUser does `findByEmail` then `users.createAccount` with no
     * transaction spanning the two, so two truly concurrent registrations of
     * the same *brand-new* address (the sequential test above only covers an
     * address that was already registered) can both pass the check and both
     * reach the insert. `uq_users_lower_email` lets only one through; the
     * loser's unique-violation must not surface as a raw 500 — itself a
     * second, subtler enumeration signal (500 vs 200 is observable), on top of
     * a genuine double-submit bug (the client-side guard only protects one
     * browser tab). Both responses must come back identical and exactly one
     * user row must exist, with exactly one organization and one membership:
     * the loser's transaction rolls back its organization too. The in-memory
     * fake used by service.test.ts cannot express a real unique-constraint
     * violation, so this has to run against Postgres.
     */
    it("returns the identical response and creates exactly one user when the same new email registers concurrently", async () => {
      const concurrentBody = {
        email: "concurrent-new@example.com",
        password: "a-sufficiently-long-password",
        acceptedTermsVersion: TEST_TERMS_VERSION,
      };

      const [first, second] = await Promise.all([register(concurrentBody), register(concurrentBody)]);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json()).toEqual({ status: "verification_sent" });
      expect(second.json()).toEqual(first.json());

      const rows = await ownerDb
        .selectFrom("users")
        .selectAll()
        .where("email", "=", "concurrent-new@example.com")
        .execute();
      expect(rows).toHaveLength(1);

      const organizations = await ownerDb.selectFrom("organizations").selectAll().execute();
      expect(organizations).toHaveLength(1);
      expect(organizations[0]?.owner_user_id).toBe(rows[0]!.id);
      const memberships = await ownerDb.selectFrom("organization_members").selectAll().execute();
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.user_id).toBe(rows[0]!.id);
      // The loser's starter configuration rolled back with its account.
      expect(await ownerDb.selectFrom("configurations").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("configuration_versions").selectAll().execute()).toHaveLength(1);
    });
  });

  describe("POST /api/v1/auth/register under the site's registration mode", () => {
    const servers: FastifyInstance[] = [];
    const serverWith = async (site: Partial<AppSettings["site"]>) => {
      const built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: { ...settings, site: { ...settings.site, ...site } },
        db,
        mailer,
        now: () => clock,
        rateLimits: TEST_RATE_LIMITS,
        runAfterResponse: (task) => runner.run(task),
      });
      servers.push(built);
      await built.ready();
      return built;
    };
    afterAll(async () => {
      await Promise.all(servers.map((each) => each.close()));
    });

    const registerOn = (on: FastifyInstance, payload: unknown, headers: Record<string, string> = csrfHeaders) =>
      on.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        headers: { ...headers, "content-type": "application/json" },
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      });
    const nothingWritten = async () => {
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toEqual([]);
      expect(await ownerDb.selectFrom("audit_events").selectAll().execute()).toEqual([]);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    };

    const refusals = {
      "invite-only": "This site is invitation-only. Ask an organization admin for an invitation.",
      closed: "This site isn't accepting new accounts.",
    } as const;

    for (const registration of ["invite-only", "closed"] as const) {
      const refusal = { error: { code: "registration_not_open", message: refusals[registration] } };

      it(`${registration}: a valid registration is refused 403 registration_not_open in fixed words, creating and sending nothing`, async () => {
        const on = await serverWith({ registration });

        const response = await registerOn(on, body);

        expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 403, body: refusal });
        await nothingWritten();
      });

      it(`${registration}: the refusal comes before the body is read: an invalid, a malformed and an oversized body get the same 403, never a 400 or a 413`, async () => {
        const on = await serverWith({ registration });

        for (const payload of [{}, { ...body, password: "short" }, "{not json", { ...body, padding: "x".repeat(2 * 1024 * 1024) }]) {
          const response = await registerOn(on, payload);
          expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 403, body: refusal });
        }
        await nothingWritten();
      });

      it(`${registration}: the global CSRF guard still runs first`, async () => {
        const on = await serverWith({ registration });

        const response = await registerOn(on, body, {});

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "csrf_header_missing" } });
        await nothingWritten();
      });
    }

    it("open: unchanged, a valid registration makes the account and an invalid body is 400", async () => {
      const on = await serverWith({ registration: "open" });

      expect((await registerOn(on, {})).statusCode).toBe(400);
      const response = await registerOn(on, body);
      expect(response.statusCode).toBe(200);
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(1);
    });
  });

  describe("POST /api/v1/auth/register on a site that asks for no Terms", () => {
    let noTerms: FastifyInstance;
    beforeAll(async () => {
      noTerms = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: { ...settings, site: { ...settings.site, terms: { version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" } } },
        db,
        mailer,
        now: () => clock,
        rateLimits: TEST_RATE_LIMITS,
        runAfterResponse: (task) => runner.run(task),
      });
      await noTerms.ready();
    });
    afterAll(async () => {
      await noTerms.close();
    });

    it("registers without a Terms version, records none, and audits user.registered with no acceptedTermsVersion key; a version sent is ignored", async () => {
      const { acceptedTermsVersion: _omitted, ...withoutTerms } = body;
      const cases = [
        { ...withoutTerms, email: "no-terms@example.com" },
        { ...withoutTerms, email: "old-terms@example.com", acceptedTermsVersion: "2020-01-01" },
      ];
      for (const payload of cases) {
        const response = await noTerms.inject({ method: "POST", url: "/api/v1/auth/register", payload, headers: csrfHeaders });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "verification_sent" });
      }

      const users = await ownerDb.selectFrom("users").selectAll().orderBy("email").execute();
      expect(users.map(({ email, accepted_terms_version, terms_accepted_at }) => ({ email, accepted_terms_version, terms_accepted_at }))).toEqual([
        { email: "no-terms@example.com", accepted_terms_version: null, terms_accepted_at: null },
        { email: "old-terms@example.com", accepted_terms_version: null, terms_accepted_at: null },
      ]);
      const registered = await ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "user.registered").execute();
      expect(registered.map((row) => row.metadata)).toEqual([{}, {}]);
    });
  });

  describe("POST /api/v1/auth/verify-email", () => {
    const verify = (token: string) =>
      server.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token }, headers: csrfHeaders });

    const tokenFromLastEmail = (): string =>
      mailer.sent.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;

    it("verifies an account with a valid token", async () => {
      await register();
      const response = await verify(tokenFromLastEmail());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "verified" });
    });

    it("sets email_verified_at on the user", async () => {
      await register();
      await verify(tokenFromLastEmail());
      const user = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
      expect(user.email_verified_at).not.toBeNull();
    });

    /**
     * Clicking the same link twice — back button, bookmark, mail-client
     * prefetch — must not report a false failure. A token that was
     * already consumed is a different state from one that was never
     * issued, and the response must say so.
     */
    it("reports already_verified rather than a false failure on a second click", async () => {
      await register();
      const token = tokenFromLastEmail();

      const first = await verify(token);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ status: "verified" });

      const second = await verify(token);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ status: "already_verified" });
    });

    it("rejects a token that was never issued", async () => {
      const response = await verify("definitely-not-a-real-token");
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_verification_token" } });
    });

    it("rejects an unconsumed but expired token, with its own audit action", async () => {
      await register();
      const token = tokenFromLastEmail();
      await ownerDb
        .updateTable("email_verification_tokens")
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .execute();
      const response = await verify(token);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_verification_token" } });

      // Distinct from user.email_verification_failed (never-issued hash): an
      // ordinary stale link is not the same signal as a scan or mangled URL.
      const rows = await ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(rows.map((r) => r.action)).toContain("user.email_verification_expired");
      expect(rows.map((r) => r.action)).not.toContain("user.email_verification_failed");
    });

    /**
     * Pins the ordering: consumedAt is checked before expiresAt, so a link
     * that was validly used and has since expired still reports
     * already_verified — not the misleading "invalid or expired" a naive
     * expiry-first check would produce.
     */
    it("reports already_verified for a token that is both consumed and expired", async () => {
      await register();
      const token = tokenFromLastEmail();
      await verify(token);
      await ownerDb
        .updateTable("email_verification_tokens")
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .execute();

      const response = await verify(token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "already_verified" });
    });

    it("rejects an empty token at the contract boundary", async () => {
      expect((await verify("")).statusCode).toBe(400);
    });

    it("records a failure in the audit log for an unknown token", async () => {
      await verify("wrong");
      const rows = await ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(rows.map((r) => r.action)).toContain("user.email_verification_failed");
    });

    it("records a distinct audit action for a repeated verification", async () => {
      await register();
      const token = tokenFromLastEmail();
      await verify(token);
      await verify(token);
      const rows = await ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(rows.map((r) => r.action)).toContain("user.email_verification_repeated");
    });
  });

  describe("POST /api/v1/auth/verification-emails", () => {
    const resend = (email: string, headers: Record<string, string> = csrfHeaders, target = server) =>
      target.inject({ method: "POST", url: "/api/v1/auth/verification-emails", headers, payload: { email } });

    const verify = (token: string) =>
      server.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token }, headers: csrfHeaders });

    /** The plaintext tokens in the confirmation emails sent to `email`, oldest first. */
    const tokensSentTo = (email: string): string[] =>
      mailer.sent
        .filter((message) => message.to === email)
        .map((message) => {
          const match = /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text);
          if (!match) throw new Error("no confirmation link in the email");
          return match[1]!;
        });

    const countRows = async (table: "email_verification_tokens" | "audit_events") =>
      Number(
        (await ownerDb.selectFrom(table).select((eb) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow()).count,
      );

    const advanceClockHours = (hours: number) => {
      clock = new Date(clock.getTime() + hours * 60 * 60_000);
    };

    const unverifiedUser = () => createUserWithOrganization(ownerDb, { user: { email_verified_at: null } });

    it("answers an unknown, a verified and an unverified address identically, before any work runs", async () => {
      const verified = await createUserWithOrganization(ownerDb);
      const unverified = await unverifiedUser();
      const addresses = ["nobody@example.com", verified.user.email, unverified.user.email];

      const responses: LightMyRequestResponse[] = [];
      for (const email of addresses) responses.push(await resend(email));

      for (const response of responses) {
        expect(response.statusCode).toBe(202);
        expect(response.body).toBe(responses[0]!.body);
        expect(comparableHeaders(response)).toEqual(comparableHeaders(responses[0]!));
      }
      expect(responses[0]!.json()).toEqual({ status: "accepted" });

      // Every response is in, and nothing that depends on the address has
      // happened: the route did not wait for the work.
      expect(mailer.sent).toEqual([]);
      expect(await countRows("email_verification_tokens")).toBe(0);
      expect(await countRows("audit_events")).toBe(0);

      await runner.settle();
      expect(mailer.sent.map((message) => message.to)).toEqual([unverified.user.email]);
      expect(await countRows("email_verification_tokens")).toBe(1);
    });

    /**
     * A service account's address is an unknown address here. It is
     * verified, so without the human-only lookup it would read
     * `already_verified`; it answers and audits `no_account` instead.
     */
    it("a service account's address answers 202 and sends nothing, audited no_account as an unknown address", async () => {
      const { organization } = await createUserWithOrganization(ownerDb);
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: organization.id });

      const response = await resend(serviceAccount.email);
      const unknown = await resend("nobody@example.com");
      await runner.settle();

      expect(response.statusCode).toBe(202);
      expect(response.body).toBe(unknown.body);
      expect(comparableHeaders(response)).toEqual(comparableHeaders(unknown));
      expect(mailer.sent).toEqual([]);
      expect(await countRows("email_verification_tokens")).toBe(0);
      const rows = await ownerDb
        .selectFrom("audit_events")
        .select(["actor_user_id", "actor_email", "subject_id", "metadata"])
        .where("action", "=", "user.verification_email_resent")
        .execute();
      expect(rows).toEqual([
        { actor_user_id: null, actor_email: null, subject_id: null, metadata: { outcome: "no_account" } },
        { actor_user_id: null, actor_email: null, subject_id: null, metadata: { outcome: "no_account" } },
      ]);
    });

    it("a human's unverified address answers 202 and sends the link, beside it", async () => {
      const unverified = await unverifiedUser();

      expect((await resend(unverified.user.email)).statusCode).toBe(202);
      await runner.settle();

      expect(mailer.sent.map((message) => message.to)).toEqual([unverified.user.email]);
    });

    it("sends a link that verifies the account", async () => {
      await register();
      expect((await resend(body.email)).statusCode).toBe(202);
      await runner.settle();
      const [, resent] = tokensSentTo(body.email);

      const response = await verify(resent!);

      expect(response.json()).toEqual({ status: "verified" });
      const user = await ownerDb.selectFrom("users").selectAll().executeTakeFirstOrThrow();
      expect(user.email_verified_at).not.toBeNull();
    });

    it("leaves the original link working after a resend", async () => {
      await register();
      expect((await resend(body.email)).statusCode).toBe(202);
      await runner.settle();
      const [original] = tokensSentTo(body.email);

      expect((await verify(original!)).json()).toEqual({ status: "verified" });
    });

    it("stops the original link at its own expiry, while the resent one still works", async () => {
      await register();
      advanceClockHours(1);
      expect((await resend(body.email)).statusCode).toBe(202);
      await runner.settle();
      const [original, resent] = tokensSentTo(body.email);
      // The original was issued an hour before the resend: exactly at its
      // expiry now, with an hour left on the resent one.
      advanceClockHours(settings.verificationTokenTtlHours - 1);

      const expired = await verify(original!);
      expect(expired.statusCode).toBe(400);
      expect(expired.json()).toMatchObject({ error: { code: "invalid_verification_token" } });
      expect((await verify(resent!)).json()).toEqual({ status: "verified" });
    });

    it("audits a resend as sent, already_verified or no_account", async () => {
      const verified = await createUserWithOrganization(ownerDb);
      const unverified = await unverifiedUser();
      await resend(unverified.user.email);
      await resend(verified.user.email);
      await resend("nobody@example.com");
      await runner.settle();

      const rows = await ownerDb
        .selectFrom("audit_events")
        .select(["actor_user_id", "actor_email", "subject_id", "metadata"])
        .where("action", "=", "user.verification_email_resent")
        .orderBy("occurred_at")
        .execute();
      expect(rows).toEqual([
        {
          actor_user_id: unverified.user.id,
          actor_email: unverified.user.email,
          subject_id: unverified.user.id,
          metadata: { outcome: "sent" },
        },
        {
          actor_user_id: verified.user.id,
          actor_email: verified.user.email,
          subject_id: verified.user.id,
          metadata: { outcome: "already_verified" },
        },
        { actor_user_id: null, actor_email: null, subject_id: null, metadata: { outcome: "no_account" } },
      ]);
    });

    it("needs the CSRF header", async () => {
      const unverified = await unverifiedUser();

      expect((await resend(unverified.user.email, {})).statusCode).toBe(403);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    /**
     * One budget per address across both email endpoints, so alternating
     * between them buys no extra mail. The production limit is 5.
     */
    it.each([
      ["a reset request", "/api/v1/auth/password-reset-requests"],
      ["a resend", "/api/v1/auth/verification-emails"],
    ])("shares the per-address budget with reset requests: after 3 of those and 2 resends, %s gets 429", async (_label, url) => {
      const limitedServer = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer,
        now: () => clock,
        rateLimits: { ...TEST_RATE_LIMITS, emailPerAddress: RATE_LIMITS.emailPerAddress },
        runAfterResponse: (task) => runner.run(task),
      });
      try {
        await limitedServer.ready();
        const email = (await unverifiedUser()).user.email;
        const requestReset = () =>
          limitedServer.inject({
            method: "POST",
            url: "/api/v1/auth/password-reset-requests",
            headers: csrfHeaders,
            payload: { email },
          });
        expect(RATE_LIMITS.emailPerAddress.max).toBe(5);
        for (let attempt = 0; attempt < 3; attempt += 1) expect((await requestReset()).statusCode).toBe(202);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect((await resend(email, csrfHeaders, limitedServer)).statusCode).toBe(202);
        }

        const refused = await limitedServer.inject({ method: "POST", url, headers: csrfHeaders, payload: { email } });

        expect(refused.statusCode).toBe(429);
        expect(refused.json()).toMatchObject({ error: { code: "rate_limited" } });
        expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      } finally {
        await limitedServer.close();
      }
    });
  });
});
