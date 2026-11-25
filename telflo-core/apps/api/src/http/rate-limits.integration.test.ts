import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, ErrorResponseSchema } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import {
  addApiToken,
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../mail/in-memory-mailer.js";
import { hashPassword } from "../modules/identity/password.js";
import { loadSettings, type AppSettings } from "../settings.js";
import { buildServer } from "../server.js";
import { createCollectingRunner } from "./after-response.js";
import { RATE_LIMITED_MESSAGE, RATE_LIMITS, type RateLimits } from "./rate-limits.js";
import { useFakeOpampServer } from "../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../testing/file-store.js";
import { UNCALLED_TESTING } from "../testing/otelcol-testing.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

/**
 * The per-IP and per-email limits, scaled down: the production numbers are
 * 30, 150 and 10, and these tests prove the same behavior with 3, 2 and 3.
 * The per-address email limit keeps its production 5, so "the 6th request"
 * is literally the sixth. The invitation limit keeps its production numbers
 * too; its tests are with the invitation endpoints', and so do the sales
 * inquiries', the validations', the flow lint's, the test files' and runs',
 * the fleet routes' and the public download's (public-download.test.ts),
 * with theirs, and the public logo read's (with the organization routes')
 * and the library's (with the library routes'), and the anonymous
 * validations' (with the anonymous validate's), and the product-admin
 * writes, deletes and feedback (with their routes'), and the open flow
 * read's (with the flows routes'). The token check's keeps its production
 * 30, tested here through the real server.
 * Every server here is fresh, so each test starts with empty buckets.
 */
const SMALL_LIMITS: RateLimits = {
  identityPerIp: { max: 3, windowMs: RATE_LIMITS.identityPerIp.windowMs },
  refreshPerIp: { max: 2, windowMs: RATE_LIMITS.refreshPerIp.windowMs },
  signInPerEmail: { max: 3, windowMs: RATE_LIMITS.signInPerEmail.windowMs },
  emailPerAddress: { max: 5, windowMs: RATE_LIMITS.emailPerAddress.windowMs },
  invitationEmailsPerUser: RATE_LIMITS.invitationEmailsPerUser,
  salesInquiriesPerIp: RATE_LIMITS.salesInquiriesPerIp,
  validationsPerUser: RATE_LIMITS.validationsPerUser,
  flowLintsPerUser: RATE_LIMITS.flowLintsPerUser,
  testFileUploadsPerUser: RATE_LIMITS.testFileUploadsPerUser,
  testRunsPerUser: RATE_LIMITS.testRunsPerUser,
  validationRuleChecksPerUser: RATE_LIMITS.validationRuleChecksPerUser,
  fleetReadsPerUser: RATE_LIMITS.fleetReadsPerUser,
  fleetWritesPerUser: RATE_LIMITS.fleetWritesPerUser,
  fleetBearerRepliesPerUser: RATE_LIMITS.fleetBearerRepliesPerUser,
  quickDeployPerIp: RATE_LIMITS.quickDeployPerIp,
  quickDeployPerLink: RATE_LIMITS.quickDeployPerLink,
  organizationLogosPerIp: RATE_LIMITS.organizationLogosPerIp,
  libraryFileDownloadsPerUser: RATE_LIMITS.libraryFileDownloadsPerUser,
  libraryFileLinksPerUser: RATE_LIMITS.libraryFileLinksPerUser,
  libraryLinksPerIp: RATE_LIMITS.libraryLinksPerIp,
  libraryLinkDownloadsPerLink: RATE_LIMITS.libraryLinkDownloadsPerLink,
  apiTokenFailuresPerIp: RATE_LIMITS.apiTokenFailuresPerIp,
  publicApiPerToken: RATE_LIMITS.publicApiPerToken,
  ottlLintsPerUser: RATE_LIMITS.ottlLintsPerUser,
  anonymousValidationsPerIp: RATE_LIMITS.anonymousValidationsPerIp,
  anonymousValidations: RATE_LIMITS.anonymousValidations,
  productAdminWritesPerUser: RATE_LIMITS.productAdminWritesPerUser,
  productAdminDeletesPerUser: RATE_LIMITS.productAdminDeletesPerUser,
  feedbackPerUser: RATE_LIMITS.feedbackPerUser,
  publishedFlowReadsPerIp: RATE_LIMITS.publishedFlowReadsPerIp,
};

const PASSWORD = "a-sufficiently-long-password";

type IdentityRoute =
  | "register"
  | "verify-email"
  | "sign-in"
  | "password-reset-requests"
  | "password-resets"
  | "verification-emails"
  | "oidc-start"
  | "oidc-callback";

interface From {
  /** The socket peer, as `server.inject` reports it. */
  remoteAddress?: string;
  forwardedFor?: string;
}

describe("rate limits", () => {
  let settings: AppSettings;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;
  let servers: FastifyInstance[] = [];
  let passwordHash: string;

  beforeAll(async () => {
    settings = loadSettings(process.env);
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
  });

  async function serverWith(trustProxyHops = 0): Promise<FastifyInstance> {
    const server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: { ...settings, trustProxyHops },
      db,
      mailer: createInMemoryMailer(),
      rateLimits: SMALL_LIMITS,
      // Queues and never starts: the email endpoints' work is irrelevant to
      // their limits, and nothing queued can outlive the test.
      runAfterResponse: createCollectingRunner().run,
    });
    servers.push(server);
    await server.ready();
    return server;
  }

  const uniqueEmail = () => `person-${Math.random().toString(36).slice(2)}@example.com`;

  function headersFor(from: From, withCsrf = true): Record<string, string> {
    return {
      ...(withCsrf ? { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } : {}),
      ...(from.forwardedFor ? { "x-forwarded-for": from.forwardedFor } : {}),
    };
  }

  function call(
    server: FastifyInstance,
    route: IdentityRoute,
    from: From = {},
    email = uniqueEmail(),
    password = PASSWORD,
  ) {
    const request: { method?: "GET"; url: string; payload?: Record<string, unknown> } = {
      register: { url: "/api/v1/auth/register", payload: { email, password } },
      "verify-email": { url: "/api/v1/auth/verify-email", payload: { token: "not-a-real-token" } },
      "sign-in": { url: "/api/v1/auth/sessions", payload: { email, password } },
      "password-reset-requests": { url: "/api/v1/auth/password-reset-requests", payload: { email } },
      "password-resets": { url: "/api/v1/auth/password-resets", payload: { token: "not-a-real-token", password } },
      "verification-emails": { url: "/api/v1/auth/verification-emails", payload: { email } },
      // The OIDC routes: GET navigations, in the same bucket. No provider is
      // configured here, so the start answers 404 and the callback redirects
      // with oauth_failed; both still count.
      "oidc-start": { method: "GET" as const, url: "/api/v1/auth/oidc/google" },
      "oidc-callback": { method: "GET" as const, url: "/api/v1/auth/oidc/google/callback?code=c&state=s" },
    }[route];
    return server.inject({
      method: request.method ?? "POST",
      url: request.url,
      ...(request.payload ? { payload: request.payload } : {}),
      remoteAddress: from.remoteAddress ?? "10.0.0.2",
      headers: headersFor(from),
    });
  }

  function refresh(server: FastifyInstance, from: From = {}) {
    return server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      remoteAddress: from.remoteAddress ?? "10.0.0.2",
      headers: headersFor(from),
    });
  }

  function expectRateLimited(response: LightMyRequestResponse): void {
    expect(response.statusCode).toBe(429);
    const retryAfter = Number(response.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  }

  function expectNotRateLimited(response: LightMyRequestResponse): void {
    expect(response.statusCode).not.toBe(429);
    // The callback answers its own refusals with the same redirect as a
    // limited one; only the limit sets Retry-After.
    expect(response.headers["retry-after"]).toBeUndefined();
  }

  /**
   * The callback is a navigation: a 429 there is a redirect to sign-in, with
   * the limit's Retry-After.
   */
  function expectCallbackRateLimited(response: LightMyRequestResponse): void {
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `${settings.publicWebUrl}/login?${new URLSearchParams({ error: "oauth_failed", redirectTo: "/app" })}`,
    );
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  }

  describe("the shared per-IP bucket for the identity routes", () => {
    const mixes: IdentityRoute[][] = [
      ["register", "verify-email", "sign-in", "register"],
      ["sign-in", "register", "verify-email", "sign-in"],
      ["verify-email", "sign-in", "register", "verify-email"],
      ["register", "register", "sign-in", "verify-email"],
      // The password-reset and verification-email routes, each alone, then
      // with each other and the sign-in, register and verify-email routes.
      ["password-reset-requests", "password-reset-requests", "password-reset-requests", "password-reset-requests"],
      ["password-resets", "password-resets", "password-resets", "password-resets"],
      ["verification-emails", "verification-emails", "verification-emails", "verification-emails"],
      ["password-reset-requests", "password-resets", "verification-emails", "password-reset-requests"],
      ["sign-in", "password-reset-requests", "register", "password-resets"],
      ["verification-emails", "verify-email", "password-resets", "sign-in"],
      // The OIDC start and callback, GETs, alone, together and with the POSTs.
      ["oidc-start", "oidc-start", "oidc-start", "oidc-start"],
      ["oidc-callback", "oidc-callback", "oidc-callback", "oidc-callback"],
      ["oidc-start", "oidc-callback", "oidc-start", "oidc-callback"],
      ["oidc-callback", "oidc-start", "oidc-callback", "oidc-start"],
      ["sign-in", "oidc-start", "register", "oidc-callback"],
      ["oidc-start", "oidc-callback", "password-resets", "register"],
    ];

    it.each(mixes)(
      "refuses the request after the limit whatever the mix: %s, %s, %s, then %s",
      async (...routes: IdentityRoute[]) => {
        const server = await serverWith();
        const allowed = routes.slice(0, SMALL_LIMITS.identityPerIp.max);
        const over = routes[SMALL_LIMITS.identityPerIp.max]!;

        for (const route of allowed) expectNotRateLimited(await call(server, route));
        const refused = await call(server, over);
        if (over === "oidc-callback") expectCallbackRateLimited(refused);
        else expectRateLimited(refused);
      },
    );

    it("answers a limited callback with a redirect to /login?error=oauth_failed, not the envelope, and clears the flow cookie", async () => {
      const server = await serverWith();
      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max; attempt += 1) {
        expectNotRateLimited(await call(server, "oidc-start"));
      }
      const response = await call(server, "oidc-callback");

      expectCallbackRateLimited(response);
      expect(response.body).toBe("");
      const setCookie = [response.headers["set-cookie"]].flat().join("\n");
      expect(setCookie).toContain("__Secure-telflo_oidc=; Max-Age=0; Path=/api/v1/auth/oidc");
    });

    it("answers a limited start with the envelope", async () => {
      const server = await serverWith();
      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max; attempt += 1) {
        await call(server, "oidc-callback");
      }
      const response = await call(server, "oidc-start");

      expectRateLimited(response);
      expect(response.json()).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
    });

    it("counts a request whose body is invalid, since the limit runs before validation", async () => {
      const server = await serverWith();
      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max; attempt += 1) {
        const response = await server.inject({
          method: "POST",
          url: "/api/v1/auth/sessions",
          remoteAddress: "10.0.0.2",
          headers: headersFor({}),
          payload: { unexpected: true },
        });
        expect(response.statusCode).toBe(400);
      }
      expectRateLimited(await call(server, "register"));
    });

    it("does not count a request the CSRF guard refuses", async () => {
      const server = await serverWith();
      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max + 2; attempt += 1) {
        const response = await server.inject({
          method: "POST",
          url: "/api/v1/auth/register",
          remoteAddress: "10.0.0.2",
          headers: headersFor({}, false),
          payload: { email: uniqueEmail(), password: PASSWORD },
        });
        expect(response.statusCode).toBe(403);
      }
      expectNotRateLimited(await call(server, "register"));
    });

    it("leaves a different client IP, forwarded by the one trusted proxy, its own budget", async () => {
      const server = await serverWith(1);
      const first = { remoteAddress: "10.0.0.2", forwardedFor: "198.51.100.1" };
      const second = { remoteAddress: "10.0.0.2", forwardedFor: "198.51.100.2" };

      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max; attempt += 1) {
        expectNotRateLimited(await call(server, "sign-in", first));
      }
      expectRateLimited(await call(server, "sign-in", first));

      expectNotRateLimited(await call(server, "sign-in", second));
      expectNotRateLimited(await call(server, "register", second));
    });

    it("ignores X-Forwarded-For when no proxy is trusted, so a forged header buys no fresh bucket", async () => {
      const server = await serverWith(0);
      const forged = (index: number) => ({ remoteAddress: "10.0.0.2", forwardedFor: `203.0.113.${index + 1}` });

      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max; attempt += 1) {
        expectNotRateLimited(await call(server, "sign-in", forged(attempt)));
      }
      expectRateLimited(await call(server, "sign-in", forged(99)));
    });
  });

  describe("sign-in per email", () => {
    const WRONG_PASSWORD = "not-the-right-password";
    const MAX = SMALL_LIMITS.signInPerEmail.max;

    /** A verified account whose password is PASSWORD. */
    const verifiedEmail = async () => {
      const account = await createUserWithOrganization(ownerDb, { user: { password_hash: passwordHash } });
      return account.user.email;
    };

    /**
     * One sign-in from its own address, so the shared per-IP bucket never
     * decides the outcome and only the per-email limit is under test.
     */
    let nextHost = 0;
    const signIn = (server: FastifyInstance, email: string, password = PASSWORD) => {
      nextHost += 1;
      return call(server, "sign-in", { remoteAddress: `192.0.2.${nextHost % 250}` }, email, password);
    };

    async function failTimes(server: FastifyInstance, email: string, times: number): Promise<void> {
      for (let attempt = 0; attempt < times; attempt += 1) {
        expect((await signIn(server, email, WRONG_PASSWORD)).statusCode).toBe(401);
      }
    }

    it("never counts a successful sign-in: max + 1 in a row all succeed", async () => {
      const server = await serverWith();
      const email = await verifiedEmail();

      for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
        expect((await signIn(server, email)).statusCode).toBe(200);
      }
    });

    it("refuses the attempt after max failures, even with the right password and from rotating IPs", async () => {
      const server = await serverWith();
      const email = await verifiedEmail();

      await failTimes(server, email, MAX);
      expectRateLimited(await signIn(server, email));
    });

    it("starts the count again after a successful sign-in", async () => {
      const server = await serverWith();
      const email = await verifiedEmail();

      await failTimes(server, email, MAX - 1);
      expect((await signIn(server, email)).statusCode).toBe(200);

      await failTimes(server, email, MAX);
      expectRateLimited(await signIn(server, email));
    });

    it("does not count email_not_verified, whose password was right", async () => {
      const server = await serverWith();
      const account = await createUserWithOrganization(ownerDb, {
        user: { password_hash: passwordHash, email_verified_at: null },
      });

      for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
        const response = await signIn(server, account.user.email);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "email_not_verified" } });
      }
    });

    it("admits at most max concurrent wrong guesses for one address", async () => {
      const server = await serverWith();
      const email = await verifiedEmail();

      const responses = await Promise.all(
        Array.from({ length: MAX + 3 }, () => signIn(server, email, WRONG_PASSWORD)),
      );
      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 401)).toHaveLength(MAX);
      expect(statuses.filter((status) => status === 429)).toHaveLength(3);
    });

    it("refuses a known and an unknown address identically", async () => {
      const server = await serverWith();
      const known = await verifiedEmail();
      const unknown = uniqueEmail();

      await failTimes(server, known, MAX);
      await failTimes(server, unknown, MAX);
      const [knownResponse, unknownResponse] = [await signIn(server, known), await signIn(server, unknown)];

      expectRateLimited(knownResponse);
      expectRateLimited(unknownResponse);
      expect(unknownResponse.body).toBe(knownResponse.body);
      const shape = (response: LightMyRequestResponse) => {
        const { date: _date, "retry-after": retryAfter, ...rest } = response.headers;
        return { ...rest, retryAfter: Math.abs(Number(retryAfter) - Number(knownResponse.headers["retry-after"])) <= 1 };
      };
      expect(shape(unknownResponse)).toEqual(shape(knownResponse));
    });

    it("counts one address however it is capitalized", async () => {
      const server = await serverWith();
      const email = uniqueEmail();

      expectNotRateLimited(await signIn(server, email));
      expectNotRateLimited(await signIn(server, email.toUpperCase()));
      expectNotRateLimited(await signIn(server, `  ${email}`));
      expectRateLimited(await signIn(server, ` ${email.toUpperCase()}`));
    });

    it("leaves other addresses their own budget", async () => {
      const server = await serverWith();
      const email = uniqueEmail();

      await failTimes(server, email, MAX);
      expectRateLimited(await signIn(server, email));
      expectNotRateLimited(await signIn(server, uniqueEmail()));
    });
  });

  describe("the password change shares sign-in's per-email budget", () => {
    const WRONG_PASSWORD = "not-the-right-password";
    const NEW_PASSWORD = "a-brand-new-sufficiently-long-password";
    const MAX = SMALL_LIMITS.signInPerEmail.max;

    /**
     * Each request from its own address, so the shared per-IP bucket (3
     * here) never decides the outcome and only the per-email limit is under
     * test.
     */
    let nextHost = 0;
    const nextAddress = () => {
      nextHost += 1;
      return `198.51.100.${nextHost % 250}`;
    };

    const signIn = (server: FastifyInstance, email: string, password = PASSWORD) =>
      call(server, "sign-in", { remoteAddress: nextAddress() }, email, password);

    /** A verified account, signed in: its email and its access cookie. */
    async function signedInAccount(server: FastifyInstance): Promise<{ userId: string; email: string; access: string }> {
      const account = await createUserWithOrganization(ownerDb, { user: { password_hash: passwordHash } });
      const response = await signIn(server, account.user.email);
      expect(response.statusCode).toBe(200);
      const header = response.headers["set-cookie"];
      const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
      const access = lines.map((line) => line.split(";")[0]!).find((pair) => pair.startsWith("telflo_access="));
      return { userId: account.user.id, email: account.user.email, access: access!.slice("telflo_access=".length) };
    }

    const changePassword = (
      server: FastifyInstance,
      access: string,
      currentPassword: string,
      body: Record<string, unknown> = {},
    ) =>
      server.inject({
        method: "PUT",
        url: "/api/v1/auth/me/password",
        remoteAddress: nextAddress(),
        headers: headersFor({}),
        cookies: { telflo_access: access },
        payload: { currentPassword, newPassword: NEW_PASSWORD, ...body },
      });

    it("wrong current passwords count toward the address's sign-in budget, and at the limit both the form and Settings answer 429", async () => {
      const server = await serverWith();
      const { email, access } = await signedInAccount(server);

      expect((await signIn(server, email, WRONG_PASSWORD)).statusCode).toBe(401);
      for (let attempt = 0; attempt < MAX - 1; attempt += 1) {
        const response = await changePassword(server, access, WRONG_PASSWORD);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "current_password_incorrect" } });
      }

      // The right password, by either door, is refused until the window ends.
      expectRateLimited(await signIn(server, email));
      const settings = await changePassword(server, access, PASSWORD);
      expectRateLimited(settings);
      expect(settings.json()).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
      expect((await signIn(server, email, NEW_PASSWORD)).statusCode).toBe(429);
    });

    it("keys on the session's address, never on an address in the body", async () => {
      const server = await serverWith();
      const signedIn = await signedInAccount(server);
      const bystander = await createUserWithOrganization(ownerDb, { user: { password_hash: passwordHash } });

      // The contract refuses a body naming an address, so a client can't steer the key with one.
      expect((await changePassword(server, signedIn.access, WRONG_PASSWORD, { email: bystander.user.email })).statusCode).toBe(400);
      for (let attempt = 0; attempt < MAX; attempt += 1) {
        expect((await changePassword(server, signedIn.access, WRONG_PASSWORD)).statusCode).toBe(400);
      }
      expectRateLimited(await changePassword(server, signedIn.access, PASSWORD));
      expectRateLimited(await signIn(server, signedIn.email));
      expect((await signIn(server, bystander.user.email)).statusCode).toBe(200);
    });

    it("a success resets the address", async () => {
      const server = await serverWith();
      const { email, access } = await signedInAccount(server);

      for (let attempt = 0; attempt < MAX - 1; attempt += 1) {
        expect((await changePassword(server, access, WRONG_PASSWORD)).statusCode).toBe(400);
      }
      expect((await changePassword(server, access, PASSWORD)).statusCode).toBe(204);

      // A whole budget again: max wrong ones, then the limit.
      for (let attempt = 0; attempt < MAX; attempt += 1) {
        expect((await changePassword(server, access, WRONG_PASSWORD)).statusCode).toBe(400);
      }
      expectRateLimited(await changePassword(server, access, NEW_PASSWORD));
      expectRateLimited(await signIn(server, email, NEW_PASSWORD));
    });

    it("a 409 password_not_set refunds its count", async () => {
      const server = await serverWith();
      const { userId, email, access } = await signedInAccount(server);
      await ownerDb.updateTable("users").set({ password_hash: null }).where("id", "=", userId).execute();

      for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
        const response = await changePassword(server, access, PASSWORD);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: "password_not_set" } });
      }
      await ownerDb.updateTable("users").set({ password_hash: passwordHash }).where("id", "=", userId).execute();
      expect((await signIn(server, email)).statusCode).toBe(200);
    });

    it("spends the shared per-IP bucket", async () => {
      const server = await serverWith();
      const { access } = await signedInAccount(server);
      const from = { remoteAddress: "203.0.113.9" };
      const fromOne = () =>
        server.inject({
          method: "PUT",
          url: "/api/v1/auth/me/password",
          remoteAddress: from.remoteAddress,
          headers: headersFor({}),
          cookies: { telflo_access: access },
          payload: { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD },
        });

      expectNotRateLimited(await call(server, "verify-email", from));
      expectNotRateLimited(await fromOne());
      expectNotRateLimited(await call(server, "register", from));
      expectRateLimited(await fromOne());
    });

    it("the unlink spends the shared per-IP bucket too", async () => {
      const server = await serverWith();
      const { access } = await signedInAccount(server);
      const from = { remoteAddress: "203.0.113.10" };
      // Before anything else (onRequest): an account with no identity there is
      // a 404 that still spends the address's turn.
      const unlinkFromOne = () =>
        server.inject({
          method: "DELETE",
          url: "/api/v1/auth/me/identities/google",
          remoteAddress: from.remoteAddress,
          headers: headersFor({}),
          cookies: { telflo_access: access },
          payload: { currentPassword: WRONG_PASSWORD },
        });

      expectNotRateLimited(await call(server, "verify-email", from));
      expectNotRateLimited(await unlinkFromOne());
      expectNotRateLimited(await call(server, "register", from));
      expectRateLimited(await unlinkFromOne());
    });

    const createToken = (server: FastifyInstance, access: string, body: Record<string, unknown>) =>
      server.inject({
        method: "POST",
        url: "/api/v1/auth/me/api-tokens",
        remoteAddress: nextAddress(),
        headers: headersFor({}),
        cookies: { telflo_access: access },
        payload: { name: `t-${Math.random().toString(36).slice(2)}`, access: "read", expiresInDays: 1, ...body },
      });

    it("a personal token's wrong current passwords count toward the address's sign-in budget too; at the limit the right one is 429", async () => {
      const server = await serverWith();
      const { email, access } = await signedInAccount(server);

      for (let attempt = 0; attempt < MAX; attempt += 1) {
        const response = await createToken(server, access, { currentPassword: WRONG_PASSWORD });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "current_password_incorrect" } });
      }
      expectRateLimited(await createToken(server, access, { currentPassword: PASSWORD }));
      expectRateLimited(await signIn(server, email));
    });

    it("a service account token's wrong current passwords count toward the admin's sign-in budget too", async () => {
      const server = await serverWith();
      const { userId, email, access } = await signedInAccount(server);
      // Signed in to their personal organization, whose owner is its admin.
      const organizationId = (
        await ownerDb.selectFrom("organization_members").select("organization_id").where("user_id", "=", userId).executeTakeFirstOrThrow()
      ).organization_id;
      const account = await addServiceAccount(ownerDb, { organizationId });
      const createServiceToken = (currentPassword: string) =>
        server.inject({
          method: "POST",
          url: `/api/v1/organizations/${organizationId}/service-accounts/${account.user.id}/api-tokens`,
          remoteAddress: nextAddress(),
          headers: headersFor({}),
          cookies: { telflo_access: access },
          payload: { name: `t-${Math.random().toString(36).slice(2)}`, access: "read", expiresInDays: 1, currentPassword },
        });

      for (let attempt = 0; attempt < MAX; attempt += 1) {
        const response = await createServiceToken(WRONG_PASSWORD);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "current_password_incorrect" } });
      }
      expectRateLimited(await createServiceToken(PASSWORD));
      expectRateLimited(await signIn(server, email));
    });

    it("a personal token's create by an account without a password counts nothing", async () => {
      const server = await serverWith();
      const { userId, email, access } = await signedInAccount(server);
      await ownerDb.updateTable("users").set({ password_hash: null }).where("id", "=", userId).execute();

      for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
        expect((await createToken(server, access, {})).statusCode).toBe(201);
      }
      await ownerDb.updateTable("users").set({ password_hash: passwordHash }).where("id", "=", userId).execute();
      expect((await signIn(server, email)).statusCode).toBe(200);
    });
  });

  describe("email requests per address", () => {
    const MAX = SMALL_LIMITS.emailPerAddress.max;

    /**
     * One reset request from its own client IP, so the shared per-IP bucket
     * never decides the outcome and only the per-address limit is under test.
     */
    let nextHost = 0;
    const requestReset = (server: FastifyInstance, payload: Record<string, unknown>) => {
      nextHost += 1;
      return server.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset-requests",
        remoteAddress: `198.18.0.${nextHost % 250}`,
        headers: headersFor({}),
        payload,
      });
    };

    async function admitTimes(server: FastifyInstance, email: string, times: number): Promise<void> {
      for (let attempt = 0; attempt < times; attempt += 1) {
        expect((await requestReset(server, { email })).statusCode).toBe(202);
      }
    }

    it("refuses the 6th request for an address with an account, with Retry-After", async () => {
      const server = await serverWith();
      const account = await createUserWithOrganization(ownerDb, { user: { password_hash: passwordHash } });

      await admitTimes(server, account.user.email, MAX);
      const response = await requestReset(server, { email: account.user.email });
      expectRateLimited(response);
      expect(Number(response.headers["retry-after"])).toBeLessThanOrEqual(
        SMALL_LIMITS.emailPerAddress.windowMs / 1000,
      );
      expect(response.json()).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
    });

    it("refuses the 6th request for an address with no account just the same", async () => {
      const server = await serverWith();
      const known = (await createUserWithOrganization(ownerDb, { user: { password_hash: passwordHash } })).user.email;
      const unknown = uniqueEmail();

      await admitTimes(server, known, MAX);
      await admitTimes(server, unknown, MAX);
      const [knownResponse, unknownResponse] = [
        await requestReset(server, { email: known }),
        await requestReset(server, { email: unknown }),
      ];

      expectRateLimited(knownResponse);
      expectRateLimited(unknownResponse);
      expect(unknownResponse.body).toBe(knownResponse.body);
    });

    it("leaves a different address its own budget", async () => {
      const server = await serverWith();
      const email = uniqueEmail();

      await admitTimes(server, email, MAX);
      expectRateLimited(await requestReset(server, { email }));
      expect((await requestReset(server, { email: uniqueEmail() })).statusCode).toBe(202);
    });

    it("counts one address however it is capitalized", async () => {
      const server = await serverWith();
      const email = uniqueEmail();

      await admitTimes(server, email, MAX - 2);
      await admitTimes(server, email.toUpperCase(), 1);
      await admitTimes(server, `  ${email}`, 1);
      expectRateLimited(await requestReset(server, { email: ` ${email.toUpperCase()}` }));
    });

    it("does not count a body refused by validation", async () => {
      const server = await serverWith();
      const email = uniqueEmail();

      for (let attempt = 0; attempt < MAX + 2; attempt += 1) {
        expect((await requestReset(server, { email, unexpected: true })).statusCode).toBe(400);
      }
      await admitTimes(server, email, MAX);
      expectRateLimited(await requestReset(server, { email }));
    });
  });

  describe("the 429 response", () => {
    it("is the error envelope with code rate_limited, not a generic client error", async () => {
      const server = await serverWith();
      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max; attempt += 1) {
        await call(server, "register");
      }
      const response = await call(server, "register");

      expectRateLimited(response);
      const body: unknown = response.json();
      expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
      expect(body).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
      expect(RATE_LIMITED_MESSAGE).toBe("Too many attempts. Please wait and try again.");
    });

    it("is the same envelope, with Retry-After, from the per-email limit", async () => {
      const server = await serverWith();
      const email = uniqueEmail();
      for (let attempt = 0; attempt < SMALL_LIMITS.signInPerEmail.max; attempt += 1) {
        await call(server, "sign-in", { remoteAddress: `192.0.2.${attempt + 1}` }, email);
      }
      const response = await call(server, "sign-in", { remoteAddress: "192.0.2.100" }, email);

      expectRateLimited(response);
      expect(Number(response.headers["retry-after"])).toBeLessThanOrEqual(
        SMALL_LIMITS.signInPerEmail.windowMs / 1000,
      );
      expect(response.json()).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
    });
  });

  describe("refresh", () => {
    it("is limited separately from sign-in", async () => {
      const server = await serverWith();

      for (let attempt = 0; attempt < SMALL_LIMITS.identityPerIp.max; attempt += 1) {
        await call(server, "sign-in");
      }
      expectRateLimited(await call(server, "sign-in"));

      // The identity bucket is spent; refresh still has its own.
      for (let attempt = 0; attempt < SMALL_LIMITS.refreshPerIp.max; attempt += 1) {
        const response = await refresh(server);
        expect(response.statusCode).toBe(401);
      }
      expectRateLimited(await refresh(server));
    });

    it("does not spend the sign-in budget", async () => {
      const server = await serverWith();

      for (let attempt = 0; attempt < SMALL_LIMITS.refreshPerIp.max; attempt += 1) {
        await refresh(server);
      }
      expectRateLimited(await refresh(server));

      expectNotRateLimited(await call(server, "sign-in"));
    });
  });

  describe("the token check's failures per IP", () => {
    const WHOAMI = "/api/public/v1/whoami";
    const PROXY = "10.0.0.2";

    /** A live token on a service account of a new group organization; it is never printed. */
    async function validToken(): Promise<string> {
      const { user } = await createUserWithOrganization(ownerDb);
      const { organization: group } = await addMembership(ownerDb, { userId: user.id, role: "admin" });
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: group.id });
      return (await addApiToken(ownerDb, { organizationId: group.id, serviceAccountUserId: serviceAccount.id })).token;
    }

    const unknownToken = () => `tf_${randomBytes(32).toString("base64url")}`;

    const whoami = (server: FastifyInstance, forwardedFor: string, token?: string) =>
      server.inject({
        method: "GET",
        url: WHOAMI,
        remoteAddress: PROXY,
        headers: { "x-forwarded-for": forwardedFor, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      });

    it("30 failed tokens from one address in 5 minutes block the 31st request with 429, a valid token's included; another address is unaffected; a request with no header counts nothing", async () => {
      const server = await serverWith(1);
      const valid = await validToken();
      const address = "198.51.100.1";
      // No header: the one 401, counting nothing, however many.
      for (let attempt = 0; attempt < SMALL_LIMITS.apiTokenFailuresPerIp.max * 2; attempt += 1) {
        expect((await whoami(server, address)).statusCode).toBe(401);
      }
      expect((await whoami(server, address, valid)).statusCode).toBe(200);
      for (let attempt = 0; attempt < SMALL_LIMITS.apiTokenFailuresPerIp.max; attempt += 1) {
        const response = await whoami(server, address, unknownToken());
        expect(response.statusCode).toBe(401);
        expectNotRateLimited(response);
      }
      const blocked = await whoami(server, address, valid);
      expectRateLimited(blocked);
      expect(blocked.body.includes(valid.slice(3))).toBe(false);
      expect(blocked.json()).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
      expectRateLimited(await whoami(server, address));
      // Another address, through the same trusted proxy, has its own budget.
      expect((await whoami(server, "198.51.100.2", valid)).statusCode).toBe(200);
    });
  });
});
