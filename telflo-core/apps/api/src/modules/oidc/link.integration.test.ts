import { hkdfSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { SignJWT } from "jose";
import { sql, type Kysely, type KyselyPlugin, type Transaction } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import { createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import type { ServerDependencies } from "../../dependencies.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings, type OidcProviderSettings } from "../../settings.js";
import { startFakeOidcProvider, type FakeOidcClaims, type FakeOidcProvider } from "../../testing/fake-oidc-provider.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { createFlowCookie, readFlowCookie, type VerifiedOidcFlow } from "./flow-cookie.js";

/*
 * The sign-in methods, linking Google by `sub` from Settings and unlinking it,
 * against the real database and the fake provider on loopback. Nothing here
 * reaches the internet: the provider's redirect back to TELFLO_PUBLIC_WEB_URL
 * is read from its Location header and replayed against the server with
 * inject. The emails go through a collecting runner, so a test sees what was
 * queued only after `settle()`.
 */

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
/** Canaries: neither may appear in an audit row or a log line. */
const PASSWORD = "canary-current-6a2d8e-password";
const WRONG_PASSWORD = "canary-wrong-4b9f1c-password";
const LINK_START_URL = "/api/v1/auth/me/identity-link-requests";
const SIGN_IN_METHODS_URL = "/api/v1/auth/me/sign-in-methods";
const UNLINK_URL = "/api/v1/auth/me/identities/google";
const CALLBACK_PATH = "/api/v1/auth/oidc/google/callback";
/** The flow cookie's name: the test settings' cookies are Secure. */
const FLOW_COOKIE = "__Secure-telflo_oidc";
/** Set on the servers' pool only, so a lock wait is looked for among the servers' own connections. */
const SERVER_APPLICATION_NAME = "telflo-oidc-link-test-server";

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

/** The access token's session id (`sid`): which session a browser holds. */
function sessionIdOf(access: string): string {
  const payload = JSON.parse(Buffer.from(access.split(".")[1]!, "base64url").toString("utf8")) as { sid: string };
  return payload.sid;
}

/** A plugin that fails the next insert into `table` once armed: an audit write that fails. */
function failNextInsertInto(table: string): { plugin: KyselyPlugin; arm: () => void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    plugin: {
      transformQuery({ node }) {
        if (armed && node.kind === "InsertQueryNode" && JSON.stringify(node).includes(`"${table}"`)) {
          armed = false;
          throw new Error("injected failure");
        }
        return node;
      },
      transformResult: async ({ result }) => result,
    },
  };
}

/** A started link: the provider's authorization URL and the flow cookie the browser now holds. */
interface Started {
  authorizationUrl: URL;
  flowCookie: string;
}

/** A signed-in browser: its account, access cookie and session. */
interface Browser {
  userId: string;
  email: string;
  access: string;
  sessionId: string;
}

describe("linking and unlinking a provider from Settings", () => {
  let fake: FakeOidcProvider;
  let baseSettings: AppSettings;
  let settings: AppSettings;
  let google: OidcProviderSettings;
  /** The test's own connections, as the tables' owner. */
  let ownerDb: Kysely<Database>;
  /** The servers' connections, as the API's own role. */
  let serverDb: Kysely<Database>;
  let databases: TestDatabases;
  let server: FastifyInstance;
  let mailer: ReturnType<typeof createInMemoryMailer>;
  let runner: CollectingRunner;
  let passwordHash: string;
  let clock: Date;
  const extraServers: FastifyInstance[] = [];

  function build(serverSettings: AppSettings, overrides: Partial<ServerDependencies> = {}): FastifyInstance {
    return buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: serverSettings,
      db: serverDb,
      mailer,
      now: () => clock,
      rateLimits: TEST_RATE_LIMITS,
      runAfterResponse: runner.run,
      ...overrides,
    });
  }

  async function extraServer(
    serverSettings: AppSettings = settings,
    overrides: Partial<ServerDependencies> = {},
  ): Promise<FastifyInstance> {
    const built = build(serverSettings, overrides);
    extraServers.push(built);
    await built.ready();
    return built;
  }

  /** A server whose log lines are kept in `lines`, at info. */
  async function loggedServer(
    overrides: Partial<ServerDependencies> = {},
  ): Promise<{ logged: FastifyInstance; lines: string[] }> {
    const lines: string[] = [];
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      const logged = build(settings, { logStream: { write: (line) => void lines.push(line) }, ...overrides });
      extraServers.push(logged);
      await logged.ready();
      return { logged, lines };
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  }

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    baseSettings = loadSettings(process.env);
    google = { id: "google", name: "Google", issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret };
    settings = { ...baseSettings, oidcProviders: [google] };
    databases = openTestDatabases({ applicationName: SERVER_APPLICATION_NAME });
    ({ db: serverDb, ownerDb } = databases);
    mailer = createInMemoryMailer();
    runner = createCollectingRunner();
    server = build(settings);
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await Promise.all([server, ...extraServers].map((each) => each.close()));
    await databases.destroy();
    await fake.close();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    // Nothing queued by an earlier test runs in this one.
    await runner.settle().catch(() => undefined);
    mailer.sent.length = 0;
    clock = new Date();
  });

  const web = (path: string) => `${settings.publicWebUrl}${path}`;
  const linkResult = (code: string) => web(`/settings/account?link=${code}`);
  const uniqueEmail = () => `person-${randomUUID()}@example.com`;
  const gmail = () => `person-${randomUUID()}@gmail.com`;

  /** A verified password account, signed in. */
  async function signedIn(target = server, email = uniqueEmail()): Promise<Browser> {
    const account = await createUserWithOrganization(ownerDb, { user: { email, password_hash: passwordHash } });
    return signInAgain(account.user.id, email, target);
  }

  /** Another browser signed in to the same account. */
  async function signInAgain(userId: string, email: string, target = server): Promise<Browser> {
    const response = await target.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const access = setCookies(response).get("telflo_access")!.value;
    return { userId, email, access, sessionId: sessionIdOf(access) };
  }

  function startLink(
    browser: Pick<Browser, "access">,
    payload: Record<string, unknown> = { provider: "google", currentPassword: PASSWORD },
    target = server,
  ): Promise<LightMyRequestResponse> {
    return target.inject({
      method: "POST",
      url: LINK_START_URL,
      headers: { ...csrfHeaders, "user-agent": "link-test-agent" },
      cookies: { telflo_access: browser.access },
      payload,
    });
  }

  async function started(browser: Pick<Browser, "access">, payload?: Record<string, unknown>): Promise<Started> {
    const response = await startLink(browser, payload);
    expect(response.statusCode).toBe(201);
    return {
      authorizationUrl: new URL((response.json() as { authorizationUrl: string }).authorizationUrl),
      flowCookie: setCookies(response).get(FLOW_COOKIE)!.value,
    };
  }

  /** The browser at the provider: signs in as `claims` (or is refused) and is sent back. */
  async function authorize(
    authorizationUrl: URL,
    claims: FakeOidcClaims = {},
    options: { error?: string } = {},
  ): Promise<string> {
    if (options.error) fake.nextAuthorizeError(options.error);
    else fake.nextSignIn(claims);
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(web(CALLBACK_PATH));
    return `${location.pathname}${location.search}`;
  }

  function callback(path: string, flowCookie: string | undefined, target = server, remoteAddress?: string) {
    return target.inject({
      method: "GET",
      url: path,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      ...(flowCookie === undefined ? {} : { cookies: { [FLOW_COOKIE]: flowCookie } }),
    });
  }

  /** The whole round trip: the start, the provider, the callback. */
  async function linkWithProvider(
    browser: Pick<Browser, "access">,
    claims: FakeOidcClaims = {},
    options: { error?: string } = {},
  ): Promise<LightMyRequestResponse> {
    const flow = await started(browser);
    return callback(await authorize(flow.authorizationUrl, claims, options), flow.flowCookie);
  }

  /** A Google sign-in's round trip, as the sign-in page starts it. */
  async function signInWithGoogle(claims: FakeOidcClaims): Promise<LightMyRequestResponse> {
    const start = await server.inject({ method: "GET", url: "/api/v1/auth/oidc/google" });
    expect(start.statusCode).toBe(302);
    const path = await authorize(new URL(start.headers.location as string), claims);
    return callback(path, setCookies(start).get(FLOW_COOKIE)!.value);
  }

  /**
   * A link's end: a redirect to the Account page with the code, the flow
   * cookie cleared, and no session or theme cookie.
   */
  function expectLinkEnded(response: LightMyRequestResponse, code: string): void {
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(linkResult(code));
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookies = setCookies(response);
    expect([...cookies.keys()]).toEqual([FLOW_COOKIE]);
    expect(cookies.get(FLOW_COOKIE)?.value).toBe("");
  }

  const me = (access: string) => server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

  const auditRows = (action: string) =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "=", action).orderBy("occurred_at").execute();

  const identitiesOf = (userId: string) =>
    ownerDb.selectFrom("user_identities").selectAll().where("user_id", "=", userId).execute();

  const identityCount = async () =>
    Number((await ownerDb.selectFrom("user_identities").select(ownerDb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);

  const sentTo = async (email: string) => {
    await runner.settle();
    return mailer.sent.filter((message) => message.to === email);
  };

  function unlink(
    browser: Pick<Browser, "access">,
    payload: Record<string, unknown> = { currentPassword: PASSWORD },
    target = server,
    url = UNLINK_URL,
  ): Promise<LightMyRequestResponse> {
    return target.inject({
      method: "DELETE",
      url,
      headers: { ...csrfHeaders, "user-agent": "unlink-test-agent" },
      cookies: { telflo_access: browser.access },
      payload,
    });
  }

  /** Links `sub` to the browser's account through Settings, and checks it took. */
  async function linked(browser: Browser, sub: string = randomUUID(), email = gmail()): Promise<string> {
    expectLinkEnded(await linkWithProvider(browser, { sub, email }), "linked");
    return sub;
  }

  describe("GET /api/v1/auth/me/sign-in-methods", () => {
    it("lists the password state, the identity and the configured providers", async () => {
      const browser = await signedIn();
      await linked(browser, "listed-sub", "listed@gmail.com");
      const [row] = await identitiesOf(browser.userId);

      const response = await server.inject({ method: "GET", url: SIGN_IN_METHODS_URL, cookies: { telflo_access: browser.access } });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        hasPassword: true,
        identities: [
          { provider: "google", email: "listed@gmail.com", linkedAt: row!.linked_at.toISOString(), relinksByEmail: true },
        ],
        providers: [{ id: "google", name: "Google" }],
      });
    });

    it("an empty list of providers with no identity", async () => {
      const unconfigured = await extraServer({ ...baseSettings, oidcProviders: [] });
      const browser = await signedIn(unconfigured);
      await ownerDb.updateTable("users").set({ password_hash: null }).where("id", "=", browser.userId).execute();

      const response = await unconfigured.inject({
        method: "GET",
        url: SIGN_IN_METHODS_URL,
        cookies: { telflo_access: browser.access },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hasPassword: false, identities: [], providers: [] });
    });

    it("lists, and unlinks, an identity whose provider is no longer configured, named by its id in the email", async () => {
      const browser = await signedIn();
      await ownerDb
        .insertInto("user_identities")
        .values({ user_id: browser.userId, provider: "okta", provider_subject: "okta-sub", email: "old@okta.example" })
        .execute();

      const listed = await server.inject({ method: "GET", url: SIGN_IN_METHODS_URL, cookies: { telflo_access: browser.access } });
      // No sign-in with it is offered, so none links it again.
      expect(listed.json()).toMatchObject({
        identities: [{ provider: "okta", email: "old@okta.example", relinksByEmail: false }],
      });

      expect((await unlink(browser, undefined, server, "/api/v1/auth/me/identities/okta")).statusCode).toBe(204);
      expect(await identitiesOf(browser.userId)).toEqual([]);
      const sent = await sentTo(browser.email);
      expect(sent).toMatchObject([{ subject: "okta sign-in was removed from your Telflo account" }]);
      expect(sent[0]!.text).toContain("You can still sign in with your password.");
      expect(`${sent[0]!.text}${sent[0]!.html}`).not.toContain("links it again");
    });

    it("a Google at an issuer that isn't Google's has no email-authority rule: relinksByEmail false, and no re-link sentence in the email", async () => {
      // Discovery isn't reached: listing and unlinking never ask the provider.
      const elsewhere = await extraServer({ ...settings, oidcProviders: [{ ...google, issuer: "https://idp.telflo.example" }] });
      const browser = await signedIn(elsewhere, gmail());
      await ownerDb
        .insertInto("user_identities")
        .values({ user_id: browser.userId, provider: "google", provider_subject: "elsewhere-sub", email: browser.email })
        .execute();

      const listed = await elsewhere.inject({
        method: "GET",
        url: SIGN_IN_METHODS_URL,
        cookies: { telflo_access: browser.access },
      });
      expect(listed.json()).toMatchObject({
        identities: [{ provider: "google", relinksByEmail: false }],
        providers: [{ id: "google", name: "Google" }],
      });

      expect((await unlink(browser, undefined, elsewhere)).statusCode).toBe(204);
      const sent = await sentTo(browser.email);
      expect(sent).toMatchObject([{ subject: "Google sign-in was removed from your Telflo account" }]);
      expect(sent[0]!.text).toContain("You can still sign in with your password.");
      expect(`${sent[0]!.text}${sent[0]!.html}`).not.toContain("links it again");
    });

    it("needs a session and not the current terms", async () => {
      expect((await server.inject({ method: "GET", url: SIGN_IN_METHODS_URL })).statusCode).toBe(401);
      const browser = await signedIn();
      await ownerDb.updateTable("users").set({ accepted_terms_version: null, terms_accepted_at: null }).where("id", "=", browser.userId).execute();
      expect((await server.inject({ method: "GET", url: SIGN_IN_METHODS_URL, cookies: { telflo_access: browser.access } })).statusCode).toBe(200);
    });
  });

  describe("POST /api/v1/auth/me/identity-link-requests", () => {
    it("refuses an unknown provider (404), an existing identity (409), and a wrong or missing current password (400, audited identity_link)", async () => {
      const browser = await signedIn();

      const unknown = await startLink(browser, { provider: "okta", currentPassword: PASSWORD });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({ error: { code: "not_found", message: "No such sign-in provider." } });

      for (const payload of [{ provider: "google", currentPassword: WRONG_PASSWORD }, { provider: "google" }]) {
        const refused = await startLink(browser, payload);
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toEqual({
          error: { code: "current_password_incorrect", message: "The current password is incorrect." },
        });
        expect(setCookies(refused).has(FLOW_COOKIE)).toBe(false);
      }
      const failures = await auditRows("user.reauthentication_failed");
      expect(failures).toHaveLength(2);
      for (const row of failures) {
        expect(row).toMatchObject({
          actor_user_id: browser.userId,
          subject_id: browser.userId,
          metadata: { purpose: "identity_link" },
          user_agent: "link-test-agent",
        });
      }

      await linked(browser);
      const existing = await startLink(browser);
      expect(existing.statusCode).toBe(409);
      expect(existing.json()).toEqual({
        error: { code: "identity_already_linked", message: "Your account already has a sign-in with this provider." },
      });
      // The 409 comes before the password: a wrong one there writes no row.
      expect((await startLink(browser, { provider: "google", currentPassword: WRONG_PASSWORD })).statusCode).toBe(409);
      expect(await auditRows("user.reauthentication_failed")).toHaveLength(2);
    });

    it("a password-less account starts without one", async () => {
      const browser = await signedIn();
      await ownerDb.updateTable("users").set({ password_hash: null }).where("id", "=", browser.userId).execute();

      // No current password, or any: it is ignored, and nothing is audited.
      expect((await startLink(browser, { provider: "google" })).statusCode).toBe(201);
      expect((await startLink(browser, { provider: "google", currentPassword: WRONG_PASSWORD })).statusCode).toBe(201);
      expect(await auditRows("user.reauthentication_failed")).toEqual([]);
    });

    it("sets the flow cookie with intent link, no-store, and answers the provider's URL", async () => {
      const browser = await signedIn();

      const response = await startLink(browser);

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { authorizationUrl } = response.json() as { authorizationUrl: string };
      const url = new URL(authorizationUrl);
      expect(`${url.origin}${url.pathname}`).toBe(`${fake.issuer}/authorize`);
      expect(url.searchParams.get("redirect_uri")).toBe(web(CALLBACK_PATH));
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");

      const cookie = setCookies(response).get(FLOW_COOKIE)!;
      expect(cookie.attributes).toEqual(["Max-Age=600", "Path=/api/v1/auth/oidc", "HttpOnly", "Secure", "SameSite=Lax"]);
      const flow = await readFlowCookie(cookie.value, settings.accessTokenSecret, clock);
      expect(flow).toMatchObject({
        providerId: "google",
        redirectTo: "/settings/account",
        intent: "link",
        userId: browser.userId,
        sessionId: browser.sessionId,
      });
      expect(url.searchParams.get("state")).toBe(flow!.state);
      // Only the flow cookie: no session or theme cookie.
      expect([...setCookies(response).keys()]).toEqual([FLOW_COOKIE]);
    });

    it("answers 503 provider_unavailable when discovery fails, logged at warn, with no flow cookie", async () => {
      const lines: string[] = [];
      const previousLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "info";
      let offline: FastifyInstance;
      try {
        offline = build(settings, {
          oidcFetch: () => Promise.reject(new TypeError("fetch failed")),
          logStream: { write: (line) => void lines.push(line) },
        });
      } finally {
        process.env.LOG_LEVEL = previousLevel;
      }
      extraServers.push(offline);
      await offline.ready();
      const browser = await signedIn(offline);

      const response = await startLink(browser, undefined, offline);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: "provider_unavailable",
          message: "That sign-in provider isn't available right now. Try again later.",
        },
      });
      expect(setCookies(response).has(FLOW_COOKIE)).toBe(false);
      const warning = lines.map((line) => JSON.parse(line) as { level: number; msg: string }).find((line) => line.msg === "OIDC provider discovery failed");
      expect(warning?.level).toBe(40);
      expect(lines.join("\n")).not.toContain(PASSWORD);
    });

    it("needs a session and the CSRF header", async () => {
      const anonymous = await server.inject({
        method: "POST",
        url: LINK_START_URL,
        headers: csrfHeaders,
        payload: { provider: "google", currentPassword: PASSWORD },
      });
      expect(anonymous.statusCode).toBe(401);
      const browser = await signedIn();
      const forged = await server.inject({
        method: "POST",
        url: LINK_START_URL,
        cookies: { telflo_access: browser.access },
        payload: { provider: "google", currentPassword: PASSWORD },
      });
      expect(forged.statusCode).toBe(403);
    });
  });

  describe("the budget the password checks share", () => {
    const MAX = 3;
    const SMALL: RateLimits = {
      ...TEST_RATE_LIMITS,
      signInPerEmail: { max: MAX, windowMs: RATE_LIMITS.signInPerEmail.windowMs },
    };

    it("counts a wrong password toward the sign-in budget", async () => {
      const limited = await extraServer(settings, { rateLimits: SMALL });
      const browser = await signedIn(limited);
      await ownerDb
        .insertInto("user_identities")
        .values({ user_id: browser.userId, provider: "okta", provider_subject: "okta-sub", email: "old@okta.example" })
        .execute();

      // One wrong at the link's start, the rest at the unlink: one budget.
      expect((await startLink(browser, { provider: "google", currentPassword: WRONG_PASSWORD }, limited)).statusCode).toBe(400);
      for (let attempt = 1; attempt < MAX; attempt += 1) {
        const response = await unlink(browser, { currentPassword: WRONG_PASSWORD }, limited, "/api/v1/auth/me/identities/okta");
        expect(response.statusCode).toBe(400);
      }

      // The right password, by any door, is refused until the window ends.
      expect((await startLink(browser, undefined, limited)).statusCode).toBe(429);
      expect((await unlink(browser, undefined, limited, "/api/v1/auth/me/identities/okta")).statusCode).toBe(429);
      const signIn = await limited.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: csrfHeaders,
        payload: { email: browser.email, password: PASSWORD },
      });
      expect(signIn.statusCode).toBe(429);
    });

    it("refunds a refusal that isn't a wrong password, and a verified one resets the address", async () => {
      const limited = await extraServer(settings, { rateLimits: SMALL });
      const browser = await signedIn(limited);

      // 404s and an unknown provider take nothing.
      for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
        expect((await unlink(browser, undefined, limited)).statusCode).toBe(404);
        expect((await startLink(browser, { provider: "okta", currentPassword: WRONG_PASSWORD }, limited)).statusCode).toBe(404);
      }
      for (let attempt = 1; attempt < MAX; attempt += 1) {
        expect((await startLink(browser, { provider: "google", currentPassword: WRONG_PASSWORD }, limited)).statusCode).toBe(400);
      }
      expect((await startLink(browser, undefined, limited)).statusCode).toBe(201);
      // A whole budget again.
      for (let attempt = 0; attempt < MAX; attempt += 1) {
        expect((await startLink(browser, { provider: "google", currentPassword: WRONG_PASSWORD }, limited)).statusCode).toBe(400);
      }
      expect((await startLink(browser, undefined, limited)).statusCode).toBe(429);
    });

    it("refunds a password-less account's start: MAX + 1 starts, each 201", async () => {
      const limited = await extraServer(settings, { rateLimits: SMALL });
      const browser = await signedIn(limited);
      await ownerDb.updateTable("users").set({ password_hash: null }).where("id", "=", browser.userId).execute();

      for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
        expect((await startLink(browser, { provider: "google" }, limited)).statusCode).toBe(201);
      }
    });
  });

  describe("the callback's link branch", () => {
    it("links a Google account whose email differs from the account's, audits via settings, emails the account's address, sets no session or theme cookie and redirects to ?link=linked", async () => {
      const browser = await signedIn();
      const sessionsBefore = await ownerDb.selectFrom("sessions").select("id").execute();
      const googleEmail = gmail();

      const response = await linkWithProvider(browser, { sub: "linked-sub", email: googleEmail.toUpperCase() });

      expectLinkEnded(response, "linked");
      expect(await identitiesOf(browser.userId)).toMatchObject([
        { provider: "google", provider_subject: "linked-sub", email: googleEmail },
      ]);
      // No session was started.
      expect(await ownerDb.selectFrom("sessions").select("id").execute()).toEqual(sessionsBefore);
      const [organization] = await ownerDb
        .selectFrom("sessions")
        .select("active_organization_id")
        .where("id", "=", browser.sessionId)
        .execute();
      expect(await auditRows("user.identity_linked")).toMatchObject([
        {
          actor_user_id: browser.userId,
          actor_email: browser.email,
          organization_id: organization!.active_organization_id,
          subject_type: "user",
          subject_id: browser.userId,
          metadata: { provider: "google", via: "settings" },
        },
      ]);
      expect(JSON.stringify(await auditRows("user.identity_linked"))).not.toContain(googleEmail);

      // Nothing before the runner settles; then one email, to the account's own address.
      expect(mailer.sent).toEqual([]);
      const sent = await sentTo(browser.email);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toBe("Google sign-in was linked to your Telflo account");
      expect(sent[0]!.text).toContain(`${settings.publicWebUrl}/settings/account`);
      expect(sent[0]!.text).not.toContain(googleEmail);
      expect(mailer.sent).toHaveLength(1);
      // The browser that linked is still signed in.
      expect((await me(browser.access)).statusCode).toBe(200);
    });

    it("identity_in_use when the sub is another account's", async () => {
      const other = await signedIn();
      await linked(other, "taken-sub");
      const browser = await signedIn();

      expectLinkEnded(await linkWithProvider(browser, { sub: "taken-sub" }), "identity_in_use");

      expect(await identitiesOf(browser.userId)).toEqual([]);
      expect(await identitiesOf(other.userId)).toMatchObject([{ provider_subject: "taken-sub" }]);
      expect(await auditRows("user.identity_link_failed")).toMatchObject([
        { actor_user_id: browser.userId, actor_email: browser.email, metadata: { provider: "google", reason: "identity_in_use" } },
      ]);
      expect(await sentTo(browser.email)).toEqual([]);
    });

    it("identity_exists when the account already has a Google identity", async () => {
      const browser = await signedIn();
      const flow = await started(browser);
      // Linked meanwhile, by another way, to another Google account.
      await ownerDb
        .insertInto("user_identities")
        .values({ user_id: browser.userId, provider: "google", provider_subject: "first-sub", email: "first@gmail.com" })
        .execute();

      expectLinkEnded(await callback(await authorize(flow.authorizationUrl, { sub: "second-sub" }), flow.flowCookie), "identity_exists");

      expect(await identitiesOf(browser.userId)).toMatchObject([{ provider_subject: "first-sub" }]);
      expect((await auditRows("user.identity_link_failed")).map((row) => row.metadata)).toEqual([
        { provider: "google", reason: "identity_exists" },
      ]);
      expect(await sentTo(browser.email)).toEqual([]);
    });

    it.each([
      ["email_verified false", { email_verified: false }],
      ['email_verified the string "true"', { email_verified: "true" }],
      ["an email that doesn't parse", { email: "not-an-email" }],
      ["an email with a KELVIN SIGN", { email: "\u212Aate@gmail.com" }],
    ])("email_unverified when email_verified isn't the boolean true or the email doesn't parse: %s", async (_label, claims: FakeOidcClaims) => {
      const browser = await signedIn();

      expectLinkEnded(await linkWithProvider(browser, claims), "email_unverified");

      expect(await identityCount()).toBe(0);
      expect((await auditRows("user.identity_link_failed")).map((row) => row.metadata)).toEqual([
        { provider: "google", reason: "email_unverified" },
      ]);
      expect(await sentTo(browser.email)).toEqual([]);
    });

    it("links whatever address the provider gives: no authority rule, even another account's", async () => {
      const bystander = await signedIn();
      const browser = await signedIn();

      expectLinkEnded(await linkWithProvider(browser, { sub: "work-sub", email: bystander.email }), "linked");

      expect(await identitiesOf(browser.userId)).toMatchObject([{ provider_subject: "work-sub", email: bystander.email }]);
      expect(await identitiesOf(bystander.userId)).toEqual([]);
    });

    it("link_failed when the flow's session was revoked mid-flow", async () => {
      const browser = await signedIn();
      const other = await signInAgain(browser.userId, browser.email);
      const flow = await started(browser);
      // Sign out the linking browser from the other one.
      const revoked = await server.inject({
        method: "DELETE",
        url: `/api/v1/auth/sessions/${browser.sessionId}`,
        headers: csrfHeaders,
        cookies: { telflo_access: other.access },
      });
      expect(revoked.statusCode).toBe(204);

      expectLinkEnded(await callback(await authorize(flow.authorizationUrl), flow.flowCookie), "link_failed");

      expect(await identityCount()).toBe(0);
      expect(await auditRows("user.identity_link_failed")).toMatchObject([
        {
          actor_user_id: browser.userId,
          actor_email: browser.email,
          organization_id: null,
          metadata: { provider: "google", reason: "session_ended" },
        },
      ]);
      expect(await sentTo(browser.email)).toEqual([]);
    });

    it("a flow cookie naming another user's session links nothing", async () => {
      const stranger = await signedIn();
      const browser = await signedIn();
      const flow = await started(browser);
      // The same flow (state, nonce, verifier), naming the stranger's live
      // session for this browser's account: only the server's key could
      // sign one, so the test signs it with the test settings' secret.
      const read = (await readFlowCookie(flow.flowCookie, settings.accessTokenSecret, clock))!;
      const forged = await signedFlowCookie({ ...read, intent: "link", userId: browser.userId, sessionId: stranger.sessionId });

      expectLinkEnded(await callback(await authorize(flow.authorizationUrl, { sub: "isolated-sub" }), forged), "link_failed");

      expect(await identityCount()).toBe(0);
      expect(await auditRows("user.identity_linked")).toEqual([]);
      expect((await auditRows("user.identity_link_failed")).map((row) => [row.actor_user_id, row.metadata])).toEqual([
        [browser.userId, { provider: "google", reason: "session_ended" }],
      ]);
      expect(await sentTo(browser.email)).toEqual([]);
      expect(await sentTo(stranger.email)).toEqual([]);
    });

    it("link_failed for a state mismatch, a provider error and a failed exchange, audited identity_link_failed", async () => {
      const browser = await signedIn();

      // A provider error: the person cancelled at Google.
      expectLinkEnded(await linkWithProvider(browser, {}, { error: "access_denied" }), "link_failed");

      // A state mismatch: the provider's redirect answers another flow.
      const first = await started(browser);
      const second = await started(browser);
      expectLinkEnded(await callback(await authorize(first.authorizationUrl), second.flowCookie), "link_failed");

      // A failed exchange: the code replayed after it was spent.
      const flow = await started(browser);
      const path = await authorize(flow.authorizationUrl);
      expectLinkEnded(await callback(path, flow.flowCookie), "linked");
      await ownerDb.deleteFrom("user_identities").execute();
      expectLinkEnded(await callback(path, flow.flowCookie), "link_failed");

      expect(await identityCount()).toBe(0);
      expect(await auditRows("user.oidc_sign_in_failed")).toEqual([]);
      const failures = await auditRows("user.identity_link_failed");
      expect(failures.map((row) => row.metadata)).toEqual([
        { provider: "google", reason: "provider_error", error: "access_denied" },
        { provider: "google", reason: "state_mismatch" },
        { provider: "google", reason: "exchange_failed", error: expect.any(String) },
      ]);
      for (const row of failures) {
        expect(row).toMatchObject({ actor_user_id: browser.userId, actor_email: browser.email, organization_id: null });
      }
    });

    it("a second callback of the same link (a double submit) answers linked and writes nothing", async () => {
      const browser = await signedIn();
      const first = await started(browser);
      const second = await started(browser);
      const firstPath = await authorize(first.authorizationUrl, { sub: "double-sub" });
      const secondPath = await authorize(second.authorizationUrl, { sub: "double-sub" });

      expectLinkEnded(await callback(firstPath, first.flowCookie), "linked");
      expectLinkEnded(await callback(secondPath, second.flowCookie), "linked");

      expect(await identitiesOf(browser.userId)).toHaveLength(1);
      expect(await auditRows("user.identity_linked")).toHaveLength(1);
      expect(await auditRows("user.identity_link_failed")).toEqual([]);
      expect(await sentTo(browser.email)).toHaveLength(1);
    });

    it("a later Google sign-in by the new sub lands in the account", async () => {
      const browser = await signedIn();
      await linked(browser, "later-sub", gmail());

      // Whatever the email now: the sub decides.
      const response = await signInWithGoogle({ sub: "later-sub", email: gmail() });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(web("/app"));
      const access = setCookies(response).get("telflo_access")!.value;
      expect((await me(access)).json()).toMatchObject({ user: { id: browser.userId, email: browser.email } });
      expect(Number((await ownerDb.selectFrom("users").select(ownerDb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n)).toBe(1);
    });

    it("keeps the code, state, cookie, verifier and passwords out of the logs and the audit trail", async () => {
      const { logged, lines } = await loggedServer();
      const browser = await signedIn(logged);
      await startLink(browser, { provider: "google", currentPassword: WRONG_PASSWORD }, logged);
      const response = await startLink(browser, undefined, logged);
      const flowCookie = setCookies(response).get(FLOW_COOKIE)!.value;
      const authorizationUrl = new URL((response.json() as { authorizationUrl: string }).authorizationUrl);
      const path = await authorize(authorizationUrl);
      expectLinkEnded(await callback(path, flowCookie, logged), "linked");
      expect((await unlink(browser, undefined, logged)).statusCode).toBe(204);

      const flow = (await readFlowCookie(flowCookie, settings.accessTokenSecret, clock))!;
      const code = new URLSearchParams(path.split("?")[1]).get("code")!;
      const log = lines.join("\n");
      const audit = JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().execute());
      expect(log).toContain(CALLBACK_PATH);
      for (const secret of [PASSWORD, WRONG_PASSWORD, code, flow.state, flow.nonce, flow.codeVerifier, flowCookie]) {
        expect(log).not.toContain(secret);
        expect(audit).not.toContain(secret);
      }
    });
  });

  describe("the callback's error handler", () => {
    it("the error handler sends a link's failure to /settings/account?link=link_failed and a sign-in's to /login", async () => {
      // A 429 from the per-IP bucket, before the route has read the cookie.
      const limited = await extraServer(settings, {
        rateLimits: { ...TEST_RATE_LIMITS, identityPerIp: { max: 1, windowMs: RATE_LIMITS.identityPerIp.windowMs } },
      });
      // Signed in from another address, so the link's start spends the one request 198.51.100.7 has.
      const browser = await signedIn(limited);
      const response = await limited.inject({
        method: "POST",
        url: LINK_START_URL,
        remoteAddress: "198.51.100.7",
        headers: csrfHeaders,
        cookies: { telflo_access: browser.access },
        payload: { provider: "google", currentPassword: PASSWORD },
      });
      expect(response.statusCode).toBe(201);
      const linkCookie = setCookies(response).get(FLOW_COOKIE)!.value;
      const signInCookie = (await createFlowCookie({ providerId: "google", redirectTo: "/app" }, settings.accessTokenSecret, clock)).value;

      const link = await callback(`${CALLBACK_PATH}?code=c&state=s`, linkCookie, limited, "198.51.100.7");
      const signIn = await callback(`${CALLBACK_PATH}?code=c&state=s`, signInCookie, limited, "198.51.100.7");

      expectLinkEnded(link, "link_failed");
      expect(Number(link.headers["retry-after"])).toBeGreaterThan(0);
      expect(signIn.statusCode).toBe(302);
      expect(signIn.headers.location).toBe(web(`/login?${new URLSearchParams({ error: "oauth_failed", redirectTo: "/app" })}`));
      expect(setCookies(signIn).get(FLOW_COOKIE)?.value).toBe("");
      // The handler writes no audit row.
      expect(await auditRows("user.identity_link_failed")).toEqual([]);

      // And an unexpected failure past the service: its own audit write.
      const failing = failNextInsertInto("audit_events");
      const { logged, lines } = await loggedServer({ db: serverDb.withPlugin(failing.plugin) });
      const other = await signedIn(logged);
      const first = await started(other);
      const second = await started(other);
      const path = await authorize(first.authorizationUrl);
      failing.arm();
      const failed = await callback(path, second.flowCookie, logged);

      expectLinkEnded(failed, "link_failed");
      expect(lines.join("\n")).toContain("OIDC callback failed");
      expect(await auditRows("user.identity_link_failed")).toEqual([]);
    });
  });

  describe("DELETE /api/v1/auth/me/identities/:provider", () => {
    it("unlinks with the current password, keeps the sessions, audits and emails", async () => {
      const browser = await signedIn();
      const other = await signInAgain(browser.userId, browser.email);
      await linked(browser, "unlinked-sub");
      await runner.settle();
      mailer.sent.length = 0;

      const response = await unlink(browser);

      expect(response.statusCode).toBe(204);
      expect(await identitiesOf(browser.userId)).toEqual([]);
      // Both browsers stay signed in.
      expect((await me(browser.access)).statusCode).toBe(200);
      expect((await me(other.access)).statusCode).toBe(200);
      const [organization] = await ownerDb
        .selectFrom("sessions")
        .select("active_organization_id")
        .where("id", "=", browser.sessionId)
        .execute();
      expect(await auditRows("user.identity_unlinked")).toMatchObject([
        {
          actor_user_id: browser.userId,
          actor_email: browser.email,
          organization_id: organization!.active_organization_id,
          subject_type: "user",
          subject_id: browser.userId,
          metadata: { provider: "google" },
          user_agent: "unlink-test-agent",
        },
      ]);
      expect(mailer.sent).toEqual([]);
      const sent = await sentTo(browser.email);
      expect(sent.map((message) => message.subject)).toEqual(["Google sign-in was removed from your Telflo account"]);
      // Google re-links by email: the email says so.
      expect(sent[0]!.text).toContain(
        "If your Telflo address is this Google account's address, signing in with Google links it again.",
      );
    });

    it("404 identity_not_linked; 409 unlink_requires_password; 400 current_password_incorrect (audited identity_unlink)", async () => {
      const browser = await signedIn();

      const notLinked = await unlink(browser);
      expect(notLinked.statusCode).toBe(404);
      expect(notLinked.json()).toEqual({
        error: { code: "identity_not_linked", message: "Your account has no sign-in with this provider." },
      });

      await linked(browser, "kept-sub");
      const wrong = await unlink(browser, { currentPassword: WRONG_PASSWORD });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json()).toEqual({ error: { code: "current_password_incorrect", message: "The current password is incorrect." } });
      expect(await auditRows("user.reauthentication_failed")).toMatchObject([
        { actor_user_id: browser.userId, metadata: { purpose: "identity_unlink" } },
      ]);

      await ownerDb.updateTable("users").set({ password_hash: null }).where("id", "=", browser.userId).execute();
      const passwordless = await unlink(browser);
      expect(passwordless.statusCode).toBe(409);
      expect(passwordless.json()).toEqual({
        error: { code: "unlink_requires_password", message: "Set a password before removing this sign-in." },
      });

      expect(await identitiesOf(browser.userId)).toMatchObject([{ provider_subject: "kept-sub" }]);
      expect(await auditRows("user.identity_unlinked")).toEqual([]);
      await runner.settle();
      expect(mailer.sent.filter((message) => message.subject.includes("removed"))).toEqual([]);
    });

    it("refuses a body without the current password, and a provider id the pattern refuses, with 400", async () => {
      const browser = await signedIn();
      await linked(browser);
      expect((await unlink(browser, {})).statusCode).toBe(400);
      expect((await unlink(browser, undefined, server, "/api/v1/auth/me/identities/Google")).statusCode).toBe(400);
      expect(await identitiesOf(browser.userId)).toHaveLength(1);
    });

    it("a later Google sign-in by that sub with another address no longer reaches the account", async () => {
      const browser = await signedIn();
      await linked(browser, "removed-sub");
      expect((await unlink(browser)).statusCode).toBe(204);

      const response = await signInWithGoogle({ sub: "removed-sub", email: gmail() });

      // A new account for that Google account, never this one.
      const access = setCookies(response).get("telflo_access")!.value;
      const user = ((await me(access)).json() as { user: { id: string } }).user;
      expect(user.id).not.toBe(browser.userId);
      expect(await identitiesOf(browser.userId)).toEqual([]);
    });

    it("a later Google sign-in with the account's own address links it again, by sign_in, and sends no email", async () => {
      // The documented behaviour: the account's address is this Google
      // account's, which Google is authoritative for.
      const browser = await signedIn(server, gmail());
      await linked(browser, "own-address-sub");
      expect((await unlink(browser)).statusCode).toBe(204);
      await runner.settle();
      mailer.sent.length = 0;

      const response = await signInWithGoogle({ sub: "own-address-sub", email: browser.email });

      expect(response.statusCode).toBe(302);
      const access = setCookies(response).get("telflo_access")!.value;
      expect((await me(access)).json()).toMatchObject({ user: { id: browser.userId, email: browser.email } });
      expect(await identitiesOf(browser.userId)).toMatchObject([{ provider: "google", provider_subject: "own-address-sub" }]);
      expect(await auditRows("user.identity_linked")).toMatchObject([
        { metadata: { provider: "google", via: "settings" } },
        { actor_user_id: browser.userId, metadata: { provider: "google", via: "sign_in" } },
      ]);
      expect(Number((await ownerDb.selectFrom("users").select(ownerDb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n)).toBe(1);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("refuses with current_password_incorrect when the password changed between the verify and the lock, and unlinks nothing", async () => {
      const browser = await signedIn();
      await linked(browser, "raced-sub");
      const changedHash = await hashPassword("a-password-set-meanwhile");

      // Hold the user's row; the unlink verifies the password, then queues on it.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding!: () => void;
      const isHolding = new Promise<void>((resolve) => (holding = resolve));
      const locker = ownerDb.transaction().execute(async (transaction: Transaction<Database>) => {
        await transaction.selectFrom("users").select("id").where("id", "=", browser.userId).forUpdate().execute();
        holding();
        await released;
        await transaction.updateTable("users").set({ password_hash: changedHash }).where("id", "=", browser.userId).execute();
      });
      await isHolding;
      const pending = unlink(browser);
      try {
        await waitForLockWait();
      } finally {
        release();
      }
      await locker;
      const response = await pending;

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "current_password_incorrect" } });
      expect(await identitiesOf(browser.userId)).toMatchObject([{ provider_subject: "raced-sub" }]);
      expect(await auditRows("user.identity_unlinked")).toEqual([]);
      expect(await auditRows("user.reauthentication_failed")).toMatchObject([{ metadata: { purpose: "identity_unlink" } }]);
    });
  });

  describe("a sign-in's link: no path of a sign-in sends an email", () => {
    it("a sign-in's link records via sign_in and sends no email", async () => {
      const email = gmail();
      const account = await createUserWithOrganization(ownerDb, { user: { email, password_hash: passwordHash } });

      const response = await signInWithGoogle({ sub: "sign-in-sub", email });

      expect(response.statusCode).toBe(302);
      expect(await identitiesOf(account.user.id)).toMatchObject([{ provider_subject: "sign-in-sub" }]);
      expect(await auditRows("user.identity_linked")).toMatchObject([
        { actor_user_id: account.user.id, metadata: { provider: "google", via: "sign_in" } },
      ]);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("a sign-in that takes over an unverified account links it and sends no email", async () => {
      const email = gmail();
      const account = await createUserWithOrganization(ownerDb, {
        user: { email, password_hash: passwordHash, email_verified_at: null },
      });

      const response = await signInWithGoogle({ sub: "take-over-sub", email });

      expect(response.statusCode).toBe(302);
      expect(await identitiesOf(account.user.id)).toMatchObject([{ provider_subject: "take-over-sub" }]);
      expect(await auditRows("user.unverified_account_taken_over")).toMatchObject([{ actor_user_id: account.user.id }]);
      expect(await auditRows("user.identity_linked")).toMatchObject([
        { actor_user_id: account.user.id, metadata: { provider: "google", via: "sign_in" } },
      ]);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });

    it("a sign-in that creates an account links it and sends no email", async () => {
      const email = gmail();

      const response = await signInWithGoogle({ sub: "new-account-sub", email });

      expect(response.statusCode).toBe(302);
      const created = await ownerDb.selectFrom("users").select("id").where("email", "=", email).executeTakeFirstOrThrow();
      expect(await identitiesOf(created.id)).toMatchObject([{ provider_subject: "new-account-sub" }]);
      expect(await auditRows("user.identity_linked")).toMatchObject([
        { actor_user_id: created.id, metadata: { provider: "google", via: "sign_in" } },
      ]);
      await runner.settle();
      expect(mailer.sent).toEqual([]);
    });
  });

  /** Resolves once one of the servers' connections waits on a lock. */
  async function waitForLockWait(): Promise<void> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock'
          and datname = current_database()
          and application_name = ${SERVER_APPLICATION_NAME}
      `.execute(ownerDb);
      if (rows[0]!.n >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the servers' connections never waited on a lock");
  }

  /** A flow cookie signed as the server signs one (HKDF of the secret, its audience and type). */
  async function signedFlowCookie(flow: VerifiedOidcFlow): Promise<string> {
    const key = new Uint8Array(hkdfSync("sha256", settings.accessTokenSecret, new Uint8Array(0), "telflo-oidc-flow", 32));
    const at = Math.floor(clock.getTime() / 1000);
    return new SignJWT({
      provider: flow.providerId,
      redirect_to: flow.redirectTo,
      state: flow.state,
      nonce: flow.nonce,
      code_verifier: flow.codeVerifier,
      ...(flow.intent === "link" ? { intent: "link", user_id: flow.userId, session_id: flow.sessionId } : {}),
    })
      .setProtectedHeader({ alg: "HS256", typ: "telflo-oidc-flow+jwt" })
      .setIssuer("telflo")
      .setAudience("telflo-oidc-flow")
      .setIssuedAt(at)
      .setExpirationTime(at + 600)
      .sign(key);
  }
});
