import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely, type KyselyPlugin, type Transaction } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import {
  addMembership,
  addServiceAccount,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { ServerDependencies } from "../../dependencies.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings, type OidcProviderSettings } from "../../settings.js";
import {
  startFakeOidcProvider,
  type FakeOidcClaims,
  type FakeOidcProvider,
  type FakeSignInOptions,
} from "../../testing/fake-oidc-provider.js";
import {
  STARTER_CONFIGURATION_DESCRIPTION,
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
} from "../configurations/starter-configuration.js";
import { hashPassword } from "../identity/password.js";
import { readFlowCookie } from "./flow-cookie.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

// D2c Task 3: signing in and creating accounts with a provider, against the
// real database and the fake provider on loopback. Nothing here reaches the
// internet: the provider's redirect back to TELFLO_PUBLIC_WEB_URL is read
// from its Location header and replayed against the server with inject.

const PASSWORD = "a-sufficiently-long-password";
const START_PATH = "/api/v1/auth/oidc/google";
const CALLBACK_PATH = "/api/v1/auth/oidc/google/callback";
/** The flow cookie's name: the test settings' cookies are Secure (M4). */
const FLOW_COOKIE = "__Secure-telflo_oidc";
/**
 * Set on the servers' pool only, so a lock wait is looked for among the
 * servers' own connections and never another's (M8).
 */
const SERVER_APPLICATION_NAME = "telflo-oidc-routes-test-server";

/** A promise, and whether it has settled yet. */
interface Tracked<T> {
  promise: Promise<T>;
  settled: boolean;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { promise, settled: false };
  const settle = () => {
    tracked.settled = true;
  };
  promise.then(settle, settle);
  return tracked;
}

/**
 * A plugin that fails the next select from `table` once armed: an
 * unexpected failure where no test can otherwise make one (M7).
 */
function failNextSelectFrom(table: string): { plugin: KyselyPlugin; arm: () => void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    plugin: {
      transformQuery({ node }) {
        if (armed && node.kind === "SelectQueryNode" && JSON.stringify(node).includes(`"${table}"`)) {
          armed = false;
          throw new Error("injected failure");
        }
        return node;
      },
      transformResult: async ({ result }) => result,
    },
  };
}

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

/** A started sign-in: the provider's authorization URL and the flow cookie the browser now holds. */
interface Started {
  authorizationUrl: URL;
  flowCookie: string;
}

/** The provider's redirect back: the callback's path and query, as the browser would request it. */
interface Authorized {
  callbackPath: string;
  query: URLSearchParams;
}

describe("OIDC sign-in routes", () => {
  let fake: FakeOidcProvider;
  let baseSettings: AppSettings;
  let settings: AppSettings;
  let google: OidcProviderSettings;
  /**
   * The test's own connections, as the tables' owner: setup, inspection, and
   * the transactions that hold locks.
   */
  let ownerDb: Kysely<Database>;
  /** The servers' connections, as the API's own role, named SERVER_APPLICATION_NAME. */
  let serverDb: Kysely<Database>;
  let databases: TestDatabases;
  let server: FastifyInstance;
  let passwordHash: string;
  /** The server's clock. Reset to real time before each test; advanced to expire a flow cookie. */
  let clock: Date;
  const extraServers: FastifyInstance[] = [];

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    baseSettings = loadSettings(process.env);
    google = {
      id: "google",
      name: "Google",
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
    };
    settings = { ...baseSettings, oidcProviders: [google] };
    databases = openTestDatabases({ applicationName: SERVER_APPLICATION_NAME });
    ({ db: serverDb, ownerDb } = databases);
    server = await serverWith(settings);
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await Promise.all([server, ...extraServers].map((each) => each.close()));
    await databases.destroy();
    await fake.close();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    clock = new Date();
  });

  async function serverWith(
    serverSettings: AppSettings,
    overrides: Partial<ServerDependencies> = {},
  ): Promise<FastifyInstance> {
    const built = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: serverSettings,
      db: serverDb,
      mailer: createInMemoryMailer(),
      now: () => clock,
      rateLimits: TEST_RATE_LIMITS,
      ...overrides,
    });
    await built.ready();
    return built;
  }

  async function extraServer(
    serverSettings: AppSettings,
    overrides: Partial<ServerDependencies> = {},
  ): Promise<FastifyInstance> {
    const built = await serverWith(serverSettings, overrides);
    extraServers.push(built);
    return built;
  }

  /** A server whose log lines are kept in `lines`. */
  async function loggedServer(
    overrides: Partial<ServerDependencies> = {},
  ): Promise<{ logged: FastifyInstance; lines: string[] }> {
    const lines: string[] = [];
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    let logged: FastifyInstance;
    try {
      logged = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db: serverDb,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void lines.push(line) },
        ...overrides,
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
    extraServers.push(logged);
    await logged.ready();
    return { logged, lines };
  }

  const web = (path: string) => `${settings.publicWebUrl}${path}`;
  const redirectUri = () => web(CALLBACK_PATH);
  const gmail = () => `person-${randomUUID()}@gmail.com`;

  async function start(redirectTo?: string, target = server, path = START_PATH): Promise<Started> {
    const query = redirectTo === undefined ? "" : `?${new URLSearchParams({ redirectTo }).toString()}`;
    const response = await target.inject({ method: "GET", url: `${path}${query}` });
    expect(response.statusCode).toBe(302);
    const flowCookie = setCookies(response).get(FLOW_COOKIE);
    expect(flowCookie?.value).toBeTruthy();
    return { authorizationUrl: new URL(response.headers.location as string), flowCookie: flowCookie!.value };
  }

  /** The browser at the provider: signs in as `claims` (or is refused) and is sent back. */
  async function authorize(
    started: Started,
    claims: FakeOidcClaims = {},
    options: FakeSignInOptions & { error?: string } = {},
  ): Promise<Authorized> {
    if (options.error) fake.nextAuthorizeError(options.error);
    else fake.nextSignIn(claims, options);
    const response = await fetch(started.authorizationUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    // The provider sends the browser to the registered redirect URI, which
    // is on the web origin; the gateway would route it to this API.
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri());
    return { callbackPath: `${location.pathname}${location.search}`, query: location.searchParams };
  }

  function callback(
    path: string,
    flowCookie: string | undefined,
    target = server,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return target.inject({
      method: "GET",
      url: path,
      headers,
      ...(flowCookie === undefined ? {} : { cookies: { [FLOW_COOKIE]: flowCookie } }),
    });
  }

  /** The whole round trip: start, the provider, the callback. */
  async function signInWithProvider(
    claims: FakeOidcClaims = {},
    options: FakeSignInOptions & { redirectTo?: string; error?: string } = {},
  ): Promise<LightMyRequestResponse> {
    const started = await start(options.redirectTo);
    const authorized = await authorize(started, claims, options);
    return callback(authorized.callbackPath, started.flowCookie);
  }

  function expectFlowCookieCleared(response: LightMyRequestResponse): void {
    expect(setCookies(response).get(FLOW_COOKIE)).toEqual({
      name: FLOW_COOKIE,
      value: "",
      attributes: ["Max-Age=0", "Path=/api/v1/auth/oidc", "HttpOnly", "Secure", "SameSite=Lax"],
    });
  }

  /** Signed in: the session cookie pair, the flow cookie cleared, and a redirect to the web app. */
  function expectSignedIn(response: LightMyRequestResponse, redirectTo = "/app"): { access: string } {
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(web(redirectTo));
    const cookies = setCookies(response);
    expect(cookies.get("telflo_access")?.value).toBeTruthy();
    expect(cookies.get("telflo_refresh")?.value).toBeTruthy();
    expectFlowCookieCleared(response);
    return { access: cookies.get("telflo_access")!.value };
  }

  /** Refused: a redirect to /login with the code and redirectTo, no session cookies, the flow cookie cleared. */
  function expectRefused(response: LightMyRequestResponse, code: string, redirectTo = "/app"): void {
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(web(`/login?${new URLSearchParams({ error: code, redirectTo })}`));
    const cookies = setCookies(response);
    expect(cookies.has("telflo_access")).toBe(false);
    expect(cookies.has("telflo_refresh")).toBe(false);
    // Nor the theme cookie, which only a sign-in sets (D21 decision 23).
    expect(cookies.has("telflo_theme")).toBe(false);
    expectFlowCookieCleared(response);
  }

  async function me(access: string): Promise<{ id: string; email: string }> {
    const response = await server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });
    expect(response.statusCode).toBe(200);
    return (response.json() as { user: { id: string; email: string } }).user;
  }

  async function counts() {
    const count = async (table: "users" | "user_identities" | "sessions") =>
      Number((await ownerDb.selectFrom(table).select(ownerDb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
    return { users: await count("users"), identities: await count("user_identities"), sessions: await count("sessions") };
  }

  async function auditRows(action: string) {
    return ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", action)
      .orderBy("occurred_at")
      .execute();
  }

  async function failureReasons(): Promise<unknown[]> {
    return (await auditRows("user.oidc_sign_in_failed")).map((row) => row.metadata.reason);
  }

  async function identitiesOf(userId: string) {
    return ownerDb.selectFrom("user_identities").selectAll().where("user_id", "=", userId).execute();
  }

  /** Every configuration and version in the database: a sign-in or a link creates none (D8 decision 10). */
  async function configurationCounts() {
    const count = async (table: "configurations" | "configuration_versions") =>
      Number((await ownerDb.selectFrom(table).select(ownerDb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
    return { configurations: await count("configurations"), versions: await count("configuration_versions") };
  }

  function passwordSignIn(email: string, password = PASSWORD) {
    return server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      payload: { email, password },
    });
  }

  /** A verified password account, as registration and confirmation leave one. */
  const verifiedAccount = (email = gmail()) =>
    createUserWithOrganization(ownerDb, { user: { email, password_hash: passwordHash } });

  /**
   * Resolves once `count` of the servers' connections are waiting on a
   * lock: their requests have reached the statements a held transaction
   * blocks. Only the servers' pool is counted (SERVER_APPLICATION_NAME), so
   * no other connection to the database can satisfy it. Resolves early when
   * `unless` turns true: a request that finished without ever waiting.
   */
  async function waitForLockWaits(count = 1, unless: () => boolean = () => false): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (unless()) return;
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock'
          and datname = current_database()
          and application_name = ${SERVER_APPLICATION_NAME}
      `.execute(ownerDb);
      if (rows[0]!.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fewer than ${count} of the servers' connections ever waited on a lock`);
  }

  /**
   * Runs `work` in a transaction on the test's own connection, then holds
   * that transaction, and every lock it took, open until `release()`.
   * `done` settles once it has committed. Callers release in a `finally`,
   * so a failed wait fails the test rather than hanging the file (M8).
   */
  async function hold<Result>(
    work: (transaction: Transaction<Database>) => Promise<Result>,
  ): Promise<{ release: () => void; done: Promise<Result> }> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const isHolding = new Promise<void>((resolve) => (holding = resolve));
    const done = ownerDb.transaction().execute(async (transaction) => {
      const result = await work(transaction);
      holding();
      await released;
      return result;
    });
    // A failure in `work` rejects `done` before it ever holds.
    await Promise.race([isHolding, done]);
    return { release, done };
  }

  /** The user's row, locked `for update` until the holding transaction ends. */
  const lockUser = (transaction: Transaction<Database>, userId: string) =>
    transaction.selectFrom("users").select("id").where("id", "=", userId).forUpdate().execute();

  describe("GET /api/v1/auth/oidc-providers", () => {
    it("lists nothing when no provider is configured", async () => {
      const unconfigured = await extraServer({ ...baseSettings, oidcProviders: [] });
      const response = await unconfigured.inject({ method: "GET", url: "/api/v1/auth/oidc-providers" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ providers: [] });
    });

    it("lists Google, by id and name only, when it is configured", async () => {
      const response = await server.inject({ method: "GET", url: "/api/v1/auth/oidc-providers" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ providers: [{ id: "google", name: "Google" }] });
    });
  });

  describe("the start, GET /api/v1/auth/oidc/:provider", () => {
    it("answers 404 with the envelope when no provider is configured", async () => {
      const unconfigured = await extraServer({ ...baseSettings, oidcProviders: [] });
      const response = await unconfigured.inject({ method: "GET", url: START_PATH });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: "not_found", message: "No such sign-in provider." } });
      expect(setCookies(response).has(FLOW_COOKIE)).toBe(false);
    });

    it("answers 404 for a provider that isn't configured", async () => {
      const response = await server.inject({ method: "GET", url: "/api/v1/auth/oidc/github" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("sets the flow cookie and redirects to the provider with PKCE (S256), state, nonce, the scopes and the redirect URI", async () => {
      const response = await server.inject({ method: "GET", url: `${START_PATH}?redirectTo=%2Fapp%2Fx` });
      expect(response.statusCode).toBe(302);
      expect(response.headers["cache-control"]).toBe("no-store");

      const location = new URL(response.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe(`${fake.issuer}/authorize`);
      const params = location.searchParams;
      expect(params.get("response_type")).toBe("code");
      expect(params.get("client_id")).toBe(fake.clientId);
      expect(params.get("scope")).toBe("openid email profile");
      expect(params.get("redirect_uri")).toBe(redirectUri());
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.has("prompt")).toBe(false);

      const cookie = setCookies(response).get(FLOW_COOKIE)!;
      expect(cookie.attributes).toEqual(["Max-Age=600", "Path=/api/v1/auth/oidc", "HttpOnly", "Secure", "SameSite=Lax"]);
      const flow = await readFlowCookie(cookie.value, settings.accessTokenSecret, clock);
      expect(flow).toMatchObject({ providerId: "google", redirectTo: "/app/x" });
      expect(params.get("state")).toBe(flow!.state);
      expect(params.get("nonce")).toBe(flow!.nonce);
      expect(params.get("code_challenge")).toBe(createHash("sha256").update(flow!.codeVerifier).digest("base64url"));
    });

    it("builds the redirect URI from TELFLO_PUBLIC_WEB_URL, never from the request's host (Ruling 3)", async () => {
      const response = await server.inject({
        method: "GET",
        url: START_PATH,
        headers: { host: "api.internal:8080", "x-forwarded-host": "evil.example" },
      });
      const location = new URL(response.headers.location as string);
      expect(location.searchParams.get("redirect_uri")).toBe(redirectUri());
    });

    it("isn't CSRF guarded: it is a GET navigation", async () => {
      const response = await server.inject({ method: "GET", url: START_PATH });
      expect(response.statusCode).toBe(302);
    });

    it("redirects to /login with oauth_failed and the cleaned redirectTo when discovery fails, setting no flow cookie (M7)", async () => {
      const offline = await extraServer(settings, {
        oidcFetch: () => Promise.reject(new TypeError("fetch failed")),
      });

      const kept = await offline.inject({ method: "GET", url: `${START_PATH}?redirectTo=%2Fapp%2Fsettings` });
      const cleaned = await offline.inject({ method: "GET", url: `${START_PATH}?redirectTo=https%3A%2F%2Fevil.example` });

      for (const [response, redirectTo] of [
        [kept, "/app/settings"],
        [cleaned, "/app"],
      ] as const) {
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(web(`/login?${new URLSearchParams({ error: "oauth_failed", redirectTo })}`));
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body).toBe("");
      }
    });
  });

  describe("the flow cookie's name (M4)", () => {
    it("is __Secure-telflo_oidc when cookies are Secure, and a bare telflo_oidc is not read", async () => {
      const started = await start();
      const authorized = await authorize(started);

      const response = await server.inject({
        method: "GET",
        url: authorized.callbackPath,
        cookies: { telflo_oidc: started.flowCookie },
      });

      expectRefused(response, "oauth_failed");
      expect(await failureReasons()).toEqual(["flow_cookie_invalid"]);
    });

    it("is telflo_oidc when cookies aren't Secure: set, read and cleared by that name", async () => {
      const insecure = await extraServer({ ...settings, isCookieSecure: false });

      const response = await insecure.inject({ method: "GET", url: START_PATH });
      const cookies = setCookies(response);
      expect(cookies.has(FLOW_COOKIE)).toBe(false);
      const cookie = cookies.get("telflo_oidc")!;
      expect(cookie.attributes).toEqual(["Max-Age=600", "Path=/api/v1/auth/oidc", "HttpOnly", "SameSite=Lax"]);
      const authorized = await authorize({
        authorizationUrl: new URL(response.headers.location as string),
        flowCookie: cookie.value,
      });

      const done = await insecure.inject({
        method: "GET",
        url: authorized.callbackPath,
        cookies: { telflo_oidc: cookie.value },
      });

      expect(done.statusCode).toBe(302);
      expect(done.headers.location).toBe(web("/app"));
      expect(setCookies(done).get("telflo_oidc")).toEqual({
        name: "telflo_oidc",
        value: "",
        attributes: ["Max-Age=0", "Path=/api/v1/auth/oidc", "HttpOnly", "SameSite=Lax"],
      });
    });
  });

  describe("decision 4's table, row by row", () => {
    it("row 1: the provider returned an error (the user cancelled): nothing changes, oauth_failed", async () => {
      const response = await signInWithProvider({}, { error: "access_denied", redirectTo: "/app/settings" });

      expectRefused(response, "oauth_failed", "/app/settings");
      expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
      const [row] = await auditRows("user.oidc_sign_in_failed");
      expect(row?.metadata).toEqual({ reason: "provider_error", provider: "google", error: "access_denied" });
    });

    it("row 2: a subject linked to a live user signs that user in", async () => {
      const sub = randomUUID();
      const email = gmail();
      const first = expectSignedIn(await signInWithProvider({ sub, email }));
      const user = await me(first.access);

      const second = expectSignedIn(await signInWithProvider({ sub, email }));
      expect(await me(second.access)).toEqual(user);
      expect(await counts()).toEqual({ users: 1, identities: 1, sessions: 2 });
      // Only the sign-up made a starter configuration; the sign-in made none.
      expect(await configurationCounts()).toEqual({ configurations: 1, versions: 1 });

      const signedIn = await auditRows("user.signed_in");
      expect(signedIn).toHaveLength(2);
      expect(signedIn[1]).toMatchObject({
        actor_user_id: user.id,
        actor_email: email,
        subject_type: "session",
        metadata: { method: "oidc", provider: "google" },
      });
      expect(await auditRows("user.identity_linked")).toHaveLength(1);
    });

    it("a provider's sign-in lands as a password sign-in does (D36-1 decision 56, Q265): the earlier session's organization, else the newest live membership", async () => {
      const sub = randomUUID();
      const email = gmail();
      const first = expectSignedIn(await signInWithProvider({ sub, email }));
      const user = await me(first.access);
      const organizationOf = async (access: string) => {
        const response = await server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });
        expect(response.statusCode).toBe(200);
        return response.json<{ organization: { id: string } }>().organization.id;
      };
      const older = await addMembership(ownerDb, { userId: user.id });
      const newest = await addMembership(ownerDb, { userId: user.id });
      // The first session moves to the older organization, as a switch does.
      await ownerDb
        .updateTable("sessions")
        .set({ active_organization_id: older.organization.id })
        .where("user_id", "=", user.id)
        .execute();

      const second = expectSignedIn(await signInWithProvider({ sub, email }));
      expect(await organizationOf(second.access)).toBe(older.organization.id);

      // Left: passed over for the organization joined most recently.
      await ownerDb
        .updateTable("organization_members")
        .set({ deleted_at: new Date() })
        .where("id", "=", older.membership.id)
        .execute();
      const third = expectSignedIn(await signInWithProvider({ sub, email }));
      expect(await organizationOf(third.access)).toBe(newest.organization.id);
      const signedIn = await auditRows("user.signed_in");
      expect(signedIn.map((row) => row.organization_id)).toEqual(
        expect.arrayContaining([older.organization.id, newest.organization.id]),
      );
    });

    it("row 3: a subject linked to a soft-deleted user is refused with oauth_failed", async () => {
      const sub = randomUUID();
      const email = gmail();
      const { access } = expectSignedIn(await signInWithProvider({ sub, email }));
      const user = await me(access);
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();

      const response = await signInWithProvider({ sub, email });

      expectRefused(response, "oauth_failed");
      expect(await counts()).toEqual({ users: 1, identities: 1, sessions: 1 });
      const [row] = await auditRows("user.oidc_sign_in_failed");
      expect(row).toMatchObject({ actor_user_id: user.id, metadata: { reason: "deleted_user", provider: "google" } });
    });

    describe("row 4: email_verified isn't true, or the provider isn't authoritative for the address", () => {
      it("refuses email_verified: false and creates nothing", async () => {
        const response = await signInWithProvider({ email: gmail(), email_verified: false });

        expectRefused(response, "oauth_email_unverified");
        expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
        expect(await failureReasons()).toEqual(["email_unverified"]);
      });

      it("refuses email_verified as the string \"true\": only the boolean counts", async () => {
        const response = await signInWithProvider({ email: gmail(), email_verified: "true" });

        expectRefused(response, "oauth_email_unverified");
        expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
      });

      it("never links an unverified provider email to an existing verified account", async () => {
        const account = await verifiedAccount();

        const response = await signInWithProvider({ email: account.user.email, email_verified: false });

        expectRefused(response, "oauth_email_unverified");
        expect(await identitiesOf(account.user.id)).toEqual([]);
        expect(await counts()).toEqual({ users: 1, identities: 0, sessions: 0 });
      });

      it("never takes over an unverified account with an unverified provider email", async () => {
        const account = await createUserWithOrganization(ownerDb, {
          user: { email: gmail(), password_hash: passwordHash, email_verified_at: null },
        });

        expectRefused(await signInWithProvider({ email: account.user.email, email_verified: false }), "oauth_email_unverified");
        const after = await ownerDb.selectFrom("users").selectAll().where("id", "=", account.user.id).executeTakeFirstOrThrow();
        expect(after.password_hash).toBe(passwordHash);
        expect(after.email_verified_at).toBeNull();
      });

      it("refuses a non-Gmail address without hd, creating nothing (Ruling 7)", async () => {
        const response = await signInWithProvider({ email: `person-${randomUUID()}@example.com` });

        expectRefused(response, "oauth_email_unverified");
        expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
        expect(await failureReasons()).toEqual(["email_not_authoritative"]);
      });

      it("refuses a non-Gmail address without hd against an existing verified account, linking nothing (Ruling 7)", async () => {
        const account = await verifiedAccount(`person-${randomUUID()}@example.com`);

        const response = await signInWithProvider({ email: account.user.email });

        expectRefused(response, "oauth_email_unverified");
        expect(await identitiesOf(account.user.id)).toEqual([]);
        expect(await counts()).toEqual({ users: 1, identities: 0, sessions: 0 });
        expect(await failureReasons()).toEqual(["email_not_authoritative"]);
      });

      it("refuses a non-Gmail address without hd against an unverified account, taking nothing over (Ruling 7)", async () => {
        const account = await createUserWithOrganization(ownerDb, {
          user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash, email_verified_at: null },
        });

        expectRefused(await signInWithProvider({ email: account.user.email }), "oauth_email_unverified");
        const after = await ownerDb.selectFrom("users").selectAll().where("id", "=", account.user.id).executeTakeFirstOrThrow();
        expect(after.password_hash).toBe(passwordHash);
        expect(after.email_verified_at).toBeNull();
      });

      it("refuses an address that isn't printable ASCII, such as a KELVIN SIGN lowercasing onto another account's (M1)", async () => {
        const local = `kate-${randomUUID()}`;
        const account = await verifiedAccount(`${local}@gmail.com`);

        // U+212A KELVIN SIGN lowercases to "k".
        const response = await signInWithProvider({ email: `\u212A${local.slice(1)}@gmail.com` });

        expectRefused(response, "oauth_email_unverified");
        expect(await identitiesOf(account.user.id)).toEqual([]);
        expect(await counts()).toEqual({ users: 1, identities: 0, sessions: 0 });
        expect(await failureReasons()).toEqual(["email_unverified"]);
      });

      it("accepts a Google Workspace address (hd) and a @googlemail.com address", async () => {
        const workspace = `person-${randomUUID()}@acme.example`;
        expectSignedIn(await signInWithProvider({ email: workspace, hd: "acme.example" }));
        expectSignedIn(await signInWithProvider({ email: `person-${randomUUID()}@googlemail.com` }));
        expect((await counts()).users).toBe(2);
      });
    });

    it("row 5: a live verified user with the email and no identity is linked, then signed in", async () => {
      const account = await verifiedAccount();
      const sub = randomUUID();

      const { access } = expectSignedIn(await signInWithProvider({ sub, email: account.user.email.toUpperCase() }));

      expect(await me(access)).toEqual({ id: account.user.id, email: account.user.email });
      const identities = await identitiesOf(account.user.id);
      expect(identities).toMatchObject([{ provider: "google", provider_subject: sub, email: account.user.email }]);
      expect(await auditRows("user.identity_linked")).toMatchObject([{ actor_user_id: account.user.id }]);
      // A sign-in's link, as D21 decision 44 names it; it sends no email (Q118).
      expect((await auditRows("user.identity_linked"))[0]!.metadata).toEqual({ provider: "google", via: "sign_in" });
      // Linking changes nothing else: the password still works, and no
      // starter configuration is made for an account that already exists.
      expect((await passwordSignIn(account.user.email)).statusCode).toBe(200);
      expect(await auditRows("user.unverified_account_taken_over")).toEqual([]);
      expect(await configurationCounts()).toEqual({ configurations: 0, versions: 0 });
    });

    it("row 6: a live user with the email but a different identity for this provider is refused: identity_conflict (Ruling 8)", async () => {
      const email = gmail();
      const { access } = expectSignedIn(await signInWithProvider({ sub: randomUUID(), email }));
      const user = await me(access);

      const response = await signInWithProvider({ sub: randomUUID(), email });

      expectRefused(response, "oauth_failed");
      expect(await identitiesOf(user.id)).toHaveLength(1);
      expect(await counts()).toEqual({ users: 1, identities: 1, sessions: 1 });
      const [row] = await auditRows("user.oidc_sign_in_failed");
      expect(row).toMatchObject({ actor_user_id: user.id, metadata: { reason: "identity_conflict" } });
    });

    it("row 7: a live unverified user is taken over: the email confirmed, the password and terms cleared, links revoked, then signed in", async () => {
      const account = await createUserWithOrganization(ownerDb, {
        user: { email: gmail(), password_hash: passwordHash, email_verified_at: null },
      });
      const userId = account.user.id;
      // Whoever registered first accepted the terms; that was their consent,
      // not the owner's (Ruling 14).
      expect(account.user.accepted_terms_version).not.toBeNull();
      const future = new Date(Date.now() + 3_600_000);
      await ownerDb
        .insertInto("password_reset_tokens")
        .values({ user_id: userId, token_hash: `reset-${randomUUID()}`, expires_at: future })
        .execute();
      await ownerDb
        .insertInto("email_verification_tokens")
        .values({ user_id: userId, token_hash: `verify-${randomUUID()}`, expires_at: future })
        .execute();
      // An unverified account can't sign in, so it has no sessions; one is
      // made by hand to prove the takeover revokes them anyway.
      await ownerDb
        .insertInto("sessions")
        .values({ user_id: userId, active_organization_id: account.organization.id })
        .execute();
      const sub = randomUUID();

      const { access } = expectSignedIn(await signInWithProvider({ sub, email: account.user.email }));

      expect(await me(access)).toEqual({ id: userId, email: account.user.email });
      const after = await ownerDb.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
      expect(after.password_hash).toBeNull();
      expect(after.email_verified_at).toEqual(clock);
      expect(after.accepted_terms_version).toBeNull();
      expect(after.terms_accepted_at).toBeNull();
      expect(await identitiesOf(userId)).toMatchObject([{ provider: "google", provider_subject: sub }]);
      const unconsumed = async (table: "password_reset_tokens" | "email_verification_tokens") =>
        ownerDb.selectFrom(table).select("id").where("user_id", "=", userId).where("consumed_at", "is", null).execute();
      expect(await unconsumed("password_reset_tokens")).toEqual([]);
      expect(await unconsumed("email_verification_tokens")).toEqual([]);
      const sessions = await ownerDb.selectFrom("sessions").selectAll().where("user_id", "=", userId).orderBy("created_at").execute();
      expect(sessions.map((session) => session.revoked_reason)).toEqual(["account_taken_over", null]);
      expect(await auditRows("user.unverified_account_taken_over")).toMatchObject([
        {
          actor_user_id: userId,
          metadata: { provider: "google", hadPassword: true, hadTerms: true, revokedSessions: 1 },
        },
      ]);

      // A takeover keeps the account, so it gets no starter configuration.
      expect(await configurationCounts()).toEqual({ configurations: 0, versions: 0 });

      // Whoever registered the address first is locked out.
      const old = await passwordSignIn(account.user.email);
      expect(old.statusCode).toBe(401);
      expect(old.json()).toMatchObject({ error: { code: "invalid_credentials" } });
    });

    it("row 8: an email that belongs only to a soft-deleted user is refused with oauth_failed", async () => {
      const account = await verifiedAccount();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", account.user.id).execute();

      const response = await signInWithProvider({ email: account.user.email });

      expectRefused(response, "oauth_failed");
      expect(await counts()).toEqual({ users: 1, identities: 0, sessions: 0 });
      expect(await failureReasons()).toEqual(["deleted_user"]);
    });

    it("row 9: no user has the email: the user, their personal organization, membership and link are created, then signed in", async () => {
      const email = gmail();
      const sub = randomUUID();

      const { access } = expectSignedIn(await signInWithProvider({ sub, email }));

      const user = await ownerDb.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirstOrThrow();
      expect(await me(access)).toEqual({ id: user.id, email });
      expect(user.password_hash).toBeNull();
      expect(user.email_verified_at).toEqual(clock);
      expect(user.accepted_terms_version).toBeNull();
      expect(user.terms_accepted_at).toBeNull();
      const organizations = await ownerDb
        .selectFrom("organizations")
        .innerJoin("organization_members", "organization_members.organization_id", "organizations.id")
        .select(["organizations.name", "organizations.type", "organization_members.role"])
        .where("organization_members.user_id", "=", user.id)
        .execute();
      expect(organizations).toEqual([{ name: email, type: "personal", role: "admin" }]);
      expect(await identitiesOf(user.id)).toMatchObject([{ provider: "google", provider_subject: sub, email }]);

      const trail = await ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("actor_user_id", "=", user.id)
        .orderBy("occurred_at")
        .orderBy("id")
        .execute();
      expect(trail.map((row) => row.action)).toEqual([
        "user.registered",
        "organization.created",
        "organization_member.added",
        "user.identity_linked",
        "configuration.created",
        "user.signed_in",
      ]);
      expect(trail[0]!.metadata).toEqual({ method: "oidc", provider: "google" });
      expect(trail[3]!.metadata).toEqual({ provider: "google", via: "sign_in" });
      expect(trail[5]!.metadata).toEqual({ method: "oidc", provider: "google" });

      // The starter configuration (D8 decision 10): exactly one, in the
      // personal organization, made by the new user at the sign-in's time,
      // at the catalogue's default distribution and version (D13a decision 9).
      const pin = await catalogueDefaults(ownerDb);
      const personal = await ownerDb
        .selectFrom("organizations")
        .selectAll()
        .where("owner_user_id", "=", user.id)
        .executeTakeFirstOrThrow();
      const configurations = await ownerDb.selectFrom("configurations").selectAll().execute();
      expect(configurations).toEqual([
        expect.objectContaining({
          organization_id: personal.id,
          name: STARTER_CONFIGURATION_NAME,
          description: STARTER_CONFIGURATION_DESCRIPTION,
          created_by_user_id: user.id,
          created_at: clock,
          updated_at: clock,
          deleted_at: null,
          collector_distribution: pin.distribution,
        }),
      ]);
      expect(await ownerDb.selectFrom("configuration_versions").selectAll().execute()).toEqual([
        expect.objectContaining({
          organization_id: personal.id,
          configuration_id: configurations[0]!.id,
          version_number: 1,
          collector_distribution: pin.distribution,
          collector_version: pin.version,
          yaml_content: STARTER_CONFIGURATION_YAML,
          created_by_user_id: user.id,
          created_at: clock,
          updated_at: clock,
        }),
      ]);
      // Audited as the account's own rows are: the actor, their email, the
      // personal organization, and the request's address and user agent.
      expect(trail[4]).toMatchObject({
        actor_email: email,
        organization_id: personal.id,
        subject_type: "configuration",
        subject_id: configurations[0]!.id,
        metadata: { name: STARTER_CONFIGURATION_NAME },
        ip_address: trail[0]!.ip_address,
        user_agent: trail[0]!.user_agent,
      });
      expect(trail[4]!.ip_address).not.toBeNull();
      expect(trail[4]!.user_agent).not.toBeNull();
    });

    it("refuses with oauth_failed, and starts no session, when the user has no personal organization", async () => {
      const email = gmail();
      const sub = randomUUID();
      const { access } = expectSignedIn(await signInWithProvider({ sub, email }));
      const user = await me(access);
      // The invariant needs a live membership in a live organization to remain.
      await addMembership(ownerDb, { userId: user.id });
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("owner_user_id", "=", user.id).execute();

      expectRefused(await signInWithProvider({ sub, email }), "oauth_failed");
      expect((await counts()).sessions).toBe(1);
      expect(await failureReasons()).toEqual(["no_personal_organization"]);
    });
  });

  /**
   * D22 decision 24: after the `sub` lookup and the verified email, before
   * the authority rule and the lookup by email. The `hd` claim makes the
   * fake provider authoritative for the address, so only the refusal
   * stands between it and a link, a take-over or a new account.
   */
  describe("the site's registration mode (D36-1 decision 35, Preflight ruling 5)", () => {
    /** The round trip against `target`. */
    async function signInOn(target: FastifyInstance, claims: FakeOidcClaims): Promise<LightMyRequestResponse> {
      const started = await start(undefined, target);
      const authorized = await authorize(started, claims);
      return callback(authorized.callbackPath, started.flowCookie, target);
    }

    for (const registration of ["invite-only", "closed"] as const) {
      it(`${registration}: a sign-in with no account for the email is refused registration_not_open, creating nothing`, async () => {
        const target = await extraServer({ ...settings, site: { ...settings.site, registration } });

        const response = await signInOn(target, { sub: randomUUID(), email: gmail() });

        expectRefused(response, "registration_not_open");
        expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
        expect(await configurationCounts()).toEqual({ configurations: 0, versions: 0 });
        expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toEqual([]);
        expect(await failureReasons()).toEqual(["registration_not_open"]);
        expect(await auditRows("user.registered")).toEqual([]);
      });

      it(`${registration}: a verified account with the email is linked and signed in`, async () => {
        const target = await extraServer({ ...settings, site: { ...settings.site, registration } });
        const account = await verifiedAccount();
        const sub = randomUUID();

        expectSignedIn(await signInOn(target, { sub, email: account.user.email }));

        expect(await identitiesOf(account.user.id)).toMatchObject([{ provider: "google", provider_subject: sub }]);
        expect(await counts()).toMatchObject({ users: 1, identities: 1, sessions: 1 });
      });

      it(`${registration}: an unverified account with the email is taken over and signed in`, async () => {
        const target = await extraServer({ ...settings, site: { ...settings.site, registration } });
        const account = await createUserWithOrganization(ownerDb, {
          user: { email: gmail(), password_hash: passwordHash, email_verified_at: null },
        });

        expectSignedIn(await signInOn(target, { sub: randomUUID(), email: account.user.email }));

        const after = await ownerDb.selectFrom("users").selectAll().where("id", "=", account.user.id).executeTakeFirstOrThrow();
        expect(after.email_verified_at).toEqual(clock);
        expect(await auditRows("user.unverified_account_taken_over")).toHaveLength(1);
      });

      it(`${registration}: an identity already linked signs in`, async () => {
        const account = await verifiedAccount();
        const sub = randomUUID();
        expectSignedIn(await signInWithProvider({ sub, email: account.user.email }));
        const target = await extraServer({ ...settings, site: { ...settings.site, registration } });

        expectSignedIn(await signInOn(target, { sub, email: account.user.email }));
        expect(await failureReasons()).toEqual([]);
      });
    }

    it("open: a sign-in with no account for the email creates it, as row 9", async () => {
      const target = await extraServer({ ...settings, site: { ...settings.site, registration: "open" } });

      expectSignedIn(await signInOn(target, { sub: randomUUID(), email: gmail() }));
      expect(await counts()).toEqual({ users: 1, identities: 1, sessions: 1 });
    });
  });

  describe("an email at the service accounts' domain (D22 decision 24)", () => {
    it("an asserted email at the reserved domain is refused with oauth_email_reserved, audited email_reserved, and links, takes over or creates nothing", async () => {
      const { organization } = await verifiedAccount();
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: organization.id });
      const usersBefore = await ownerDb.selectFrom("users").selectAll().orderBy("id").execute();

      for (const email of [serviceAccount.email, `Nobody-${randomUUID()}@Service-Accounts.Telflo.Invalid`]) {
        const response = await signInWithProvider({ email, hd: "service-accounts.telflo.invalid" });
        expectRefused(response, "oauth_email_reserved");
      }

      expect(await ownerDb.selectFrom("users").selectAll().orderBy("id").execute()).toEqual(usersBefore);
      expect(await counts()).toEqual({ users: 2, identities: 0, sessions: 0 });
      expect(await configurationCounts()).toEqual({ configurations: 0, versions: 0 });
      const failures = await auditRows("user.oidc_sign_in_failed");
      expect(failures.map((row) => row.metadata)).toEqual([
        { reason: "email_reserved", provider: "google" },
        { reason: "email_reserved", provider: "google" },
      ]);
      for (const row of failures) expect(row).toMatchObject({ actor_user_id: null, actor_email: null, subject_id: null });
      expect(await auditRows("user.registered")).toEqual([]);
      expect(await auditRows("user.identity_linked")).toEqual([]);
    });

    /**
     * No `hd`: the provider isn't authoritative for the address, so a check
     * placed after the authority rule would answer oauth_email_unverified
     * (email_not_authoritative). The reserved domain's refusal comes first.
     */
    it("refuses the reserved domain before the authority rule: without hd it is still oauth_email_reserved", async () => {
      const response = await signInWithProvider({ email: `nobody-${randomUUID()}@service-accounts.telflo.invalid` });

      expectRefused(response, "oauth_email_reserved");
      expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
      expect(await configurationCounts()).toEqual({ configurations: 0, versions: 0 });
      expect(await failureReasons()).toEqual(["email_reserved"]);
    });

    it("refuses an asserted email at the deleted accounts' domain with oauth_email_reserved, audited email_reserved, a deleted person's anonymous address included, and links or creates nothing (D29 decision 10, Preflight ruling 6)", async () => {
      const { user: person } = await verifiedAccount();
      const anonymous = `deleted-${"0d".repeat(12)}@deleted-accounts.telflo.invalid`;
      await ownerDb.updateTable("users").set({ email: anonymous, password_hash: null, deleted_at: new Date() }).where("id", "=", person.id).execute();
      const usersBefore = await ownerDb.selectFrom("users").selectAll().orderBy("id").execute();

      for (const email of [anonymous, `Nobody-${randomUUID()}@Deleted-Accounts.Telflo.Invalid`]) {
        const response = await signInWithProvider({ email, hd: "deleted-accounts.telflo.invalid" });
        expectRefused(response, "oauth_email_reserved");
      }

      expect(await ownerDb.selectFrom("users").selectAll().orderBy("id").execute()).toEqual(usersBefore);
      expect(await counts()).toEqual({ users: 1, identities: 0, sessions: 0 });
      expect(await failureReasons()).toEqual(["email_reserved", "email_reserved"]);
      expect(await auditRows("user.registered")).toEqual([]);
      expect(await auditRows("user.identity_linked")).toEqual([]);
    });

    it("a human's verified email links, beside it", async () => {
      const account = await verifiedAccount();

      const { access } = expectSignedIn(await signInWithProvider({ email: account.user.email }));

      expect(await me(access)).toEqual({ id: account.user.id, email: account.user.email });
      expect(await identitiesOf(account.user.id)).toHaveLength(1);
      expect(await failureReasons()).toEqual([]);
    });
  });

  describe("state and the flow cookie: each fails with oauth_failed and writes no user, identity or session", () => {
    async function expectNothingWritten(): Promise<void> {
      expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
    }

    it("no flow cookie", async () => {
      const started = await start();
      const authorized = await authorize(started);

      expectRefused(await callback(authorized.callbackPath, undefined), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["flow_cookie_invalid"]);
    });

    it("a tampered flow cookie", async () => {
      const started = await start();
      const authorized = await authorize(started);
      const [header, payload, signature] = started.flowCookie.split(".");
      const tampered = `${header}.${payload}.${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;

      expectRefused(await callback(authorized.callbackPath, tampered), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["flow_cookie_invalid"]);
    });

    it("a flow cookie from another provider", async () => {
      const acme = { ...google, id: "acme", name: "Acme" };
      const twoProviders = await extraServer({ ...settings, oidcProviders: [google, acme] });
      const started = await start(undefined, twoProviders, "/api/v1/auth/oidc/acme");
      fake.nextSignIn();
      const response = await fetch(started.authorizationUrl, { redirect: "manual" });
      const location = new URL(response.headers.get("location")!);

      // Acme's cookie, and Acme's code and state, delivered to Google's callback.
      const refused = await callback(`${CALLBACK_PATH}${location.search}`, started.flowCookie, twoProviders);

      expectRefused(refused, "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["flow_cookie_invalid"]);
    });

    it("a mismatched state", async () => {
      const started = await start();
      const authorized = await authorize(started);
      const query = new URLSearchParams(authorized.query);
      query.set("state", "a".repeat(43));

      expectRefused(await callback(`${CALLBACK_PATH}?${query}`, started.flowCookie), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["state_mismatch"]);
    });

    it("a missing state", async () => {
      const started = await start();
      const authorized = await authorize(started);
      const query = new URLSearchParams(authorized.query);
      query.delete("state");

      expectRefused(await callback(`${CALLBACK_PATH}?${query}`, started.flowCookie), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["state_mismatch"]);
    });

    it("a replayed callback: the first clears the cookie; resending it fails on the spent code", async () => {
      const started = await start();
      const authorized = await authorize(started);
      const first = await callback(authorized.callbackPath, started.flowCookie);
      expectSignedIn(first);

      // A browser would have dropped the cookie; an attacker replaying the
      // request keeps it, and the provider refuses the code a second time.
      const replay = await callback(authorized.callbackPath, started.flowCookie);

      expectRefused(replay, "oauth_failed");
      expect(await counts()).toEqual({ users: 1, identities: 1, sessions: 1 });
      expect(await failureReasons()).toEqual(["exchange_failed"]);
    });

    it("a wrong nonce", async () => {
      expectRefused(await signInWithProvider({}, { fault: "wrong_nonce" }), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["exchange_failed"]);
    });

    it("a wrong aud", async () => {
      expectRefused(await signInWithProvider({}, { fault: "wrong_audience" }), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["exchange_failed"]);
    });

    it("a token signed by another key (Ruling 2)", async () => {
      expectRefused(await signInWithProvider({}, { fault: "foreign_key" }), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["exchange_failed"]);
    });

    it("an expired flow cookie", async () => {
      const started = await start();
      const authorized = await authorize(started);
      clock = new Date(clock.getTime() + 11 * 60_000);

      expectRefused(await callback(authorized.callbackPath, started.flowCookie), "oauth_failed");
      await expectNothingWritten();
      expect(await failureReasons()).toEqual(["flow_cookie_invalid"]);
    });
  });

  describe("redirectTo", () => {
    it("is kept through the round trip", async () => {
      const redirectTo = "/app/configurations/abc?tab=yaml#top";
      expectSignedIn(await signInWithProvider({}, { redirectTo }), redirectTo);
    });

    it("becomes /app when it points at another site", async () => {
      expectSignedIn(await signInWithProvider({}, { redirectTo: "https://evil.example" }), "/app");
      expectSignedIn(await signInWithProvider({}, { redirectTo: "/\t/evil.example" }), "/app");
    });

    it("is kept on failure", async () => {
      const response = await signInWithProvider({ email_verified: false }, { redirectTo: "/app/settings" });
      expectRefused(response, "oauth_email_unverified", "/app/settings");
    });
  });

  it("the OIDC sign-in sets it: telflo_theme, the stored theme (dark with no row), with the session cookies (D21 decision 23)", async () => {
    const sub = randomUUID();
    const email = gmail();
    const attributes = ["Max-Age=31536000", "Path=/", "HttpOnly", ...(settings.isCookieSecure ? ["Secure"] : []), "SameSite=Lax"];

    const first = await signInWithProvider({ sub, email });
    const user = await me(expectSignedIn(first).access);
    expect(setCookies(first).get("telflo_theme")).toEqual({ name: "telflo_theme", value: "dark", attributes });

    const at = new Date();
    await ownerDb.insertInto("user_settings").values({ user_id: user.id, theme: "light", created_at: at, updated_at: at }).execute();
    const second = await signInWithProvider({ sub, email });
    expectSignedIn(second);
    expect(setCookies(second).get("telflo_theme")).toEqual({ name: "telflo_theme", value: "light", attributes });
  });

  it("signs in by sub, whatever the email: the same user after the provider's email changes, and no relink", async () => {
    const sub = randomUUID();
    const email = gmail();
    const first = expectSignedIn(await signInWithProvider({ sub, email }));
    const user = await me(first.access);

    const second = expectSignedIn(await signInWithProvider({ sub, email: gmail() }));

    expect(await me(second.access)).toEqual(user);
    expect(await identitiesOf(user.id)).toMatchObject([{ provider_subject: sub, email }]);
    expect(await counts()).toEqual({ users: 1, identities: 1, sessions: 2 });
    expect(await auditRows("user.identity_linked")).toHaveLength(1);
  });

  it("builds the callback's URL from TELFLO_PUBLIC_WEB_URL whatever the request's host (Ruling 3)", async () => {
    const started = await start();
    const authorized = await authorize(started);

    const response = await callback(authorized.callbackPath, started.flowCookie, server, {
      host: "api.internal:8080",
      "x-forwarded-host": "evil.example",
    });

    // The provider compares the redirect URI of the exchange with the
    // authorization request's, so any other URL would fail the exchange.
    expectSignedIn(response);
  });

  describe("concurrency: no 500, one user and one identity (Preflight minors)", () => {
    it("a concurrent first sign-in of one new user: both callbacks end signed in or oauth_failed", async () => {
      const claims = { sub: randomUUID(), email: gmail() };
      const flows = [];
      for (let index = 0; index < 3; index += 1) {
        const started = await start();
        flows.push({ started, authorized: await authorize(started, claims) });
      }

      const responses = await Promise.all(
        flows.map(({ started, authorized }) => callback(authorized.callbackPath, started.flowCookie)),
      );

      for (const response of responses) {
        expect(response.statusCode).toBe(302);
        const location = response.headers.location as string;
        expect([web("/app"), web(`/login?${new URLSearchParams({ error: "oauth_failed", redirectTo: "/app" })}`)]).toContain(location);
      }
      expect((await counts()).users).toBe(1);
      expect((await counts()).identities).toBe(1);
      expect(responses.some((response) => response.headers.location === web("/app"))).toBe(true);
    });

    it("a first sign-in that loses the user insert to a concurrent one signs in as the winner", async () => {
      const email = gmail();
      const sub = randomUUID();
      const started = await start();
      const authorized = await authorize(started, { sub, email });

      // The winner: a concurrent sign-in of the same person, holding its
      // uncommitted account until the loser is waiting on the email index.
      const winner = await hold(async (transaction) => {
        const user = await transaction
          .insertInto("users")
          .values({ email, email_verified_at: new Date() })
          .returning("id")
          .executeTakeFirstOrThrow();
        const organization = await transaction
          .insertInto("organizations")
          .values({ name: email, type: "personal", owner_user_id: user.id })
          .returning("id")
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("organization_members")
          .values({ organization_id: organization.id, user_id: user.id, role: "admin" })
          .execute();
        await transaction
          .insertInto("user_identities")
          .values({ user_id: user.id, provider: "google", provider_subject: sub, email })
          .execute();
        return user.id;
      });

      const pending = callback(authorized.callbackPath, started.flowCookie);
      try {
        await waitForLockWaits(1);
      } finally {
        winner.release();
      }
      const winnerId = await winner.done;

      const { access } = expectSignedIn(await pending);
      expect((await me(access)).id).toBe(winnerId);
      expect(await counts()).toMatchObject({ users: 1, identities: 1 });
    });

    it("concurrent links of one sub to an existing verified user: both callbacks end signed in or oauth_failed", async () => {
      const account = await verifiedAccount();
      const claims = { sub: randomUUID(), email: account.user.email };
      const flows = [];
      for (let index = 0; index < 3; index += 1) {
        const started = await start();
        flows.push({ started, authorized: await authorize(started, claims) });
      }

      const responses = await Promise.all(
        flows.map(({ started, authorized }) => callback(authorized.callbackPath, started.flowCookie)),
      );

      for (const response of responses) expect(response.statusCode).toBe(302);
      expect(responses.some((response) => response.headers.location === web("/app"))).toBe(true);
      expect(await identitiesOf(account.user.id)).toHaveLength(1);
      expect(await counts()).toMatchObject({ users: 1, identities: 1 });
    });

    it("a link that loses to a concurrent link of the same sub looks again and signs in", async () => {
      const account = await verifiedAccount();
      const sub = randomUUID();
      const started = await start();
      const authorized = await authorize(started, { sub, email: account.user.email });

      // The winner holds the user's row, as the link path does, with its
      // link uncommitted, until the loser waits on that row.
      const winner = await hold(async (transaction) => {
        await lockUser(transaction, account.user.id);
        await transaction
          .insertInto("user_identities")
          .values({ user_id: account.user.id, provider: "google", provider_subject: sub, email: account.user.email })
          .execute();
      });

      const pending = callback(authorized.callbackPath, started.flowCookie);
      try {
        await waitForLockWaits(1);
      } finally {
        winner.release();
      }
      await winner.done;

      const { access } = expectSignedIn(await pending);
      expect((await me(access)).id).toBe(account.user.id);
      expect(await identitiesOf(account.user.id)).toHaveLength(1);
      expect(await auditRows("user.oidc_sign_in_failed")).toEqual([]);
    });

    it("a linked user soft-deleted while the session starts is refused under the lock, with no session (M5)", async () => {
      const account = await verifiedAccount();
      const sub = randomUUID();
      await ownerDb
        .insertInto("user_identities")
        .values({ user_id: account.user.id, provider: "google", provider_subject: sub, email: account.user.email })
        .execute();
      const started = await start();
      const authorized = await authorize(started, { sub, email: account.user.email });

      // Another connection holds the row and soft-deletes the user. The
      // lookups outside the session's transaction still see the user live;
      // the session start's `for share` reread waits on the row.
      const deleter = await hold(async (transaction) => {
        await lockUser(transaction, account.user.id);
        await transaction.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", account.user.id).execute();
      });
      const pending = callback(authorized.callbackPath, started.flowCookie);
      try {
        await waitForLockWaits(1);
      } finally {
        deleter.release();
      }
      await deleter.done;

      expectRefused(await pending, "oauth_failed");
      expect(await failureReasons()).toEqual(["session_refused"]);
      expect((await counts()).sessions).toBe(0);
      expect(await auditRows("user.signed_in")).toEqual([]);
    });
  });

  describe("takeover races (M6)", () => {
    /** An unverified account holding the pre-registrant's password. */
    const preRegistered = () =>
      createUserWithOrganization(ownerDb, { user: { email: gmail(), password_hash: passwordHash, email_verified_at: null } });

    async function prepareCallback(email: string): Promise<() => Promise<LightMyRequestResponse>> {
      const started = await start();
      const authorized = await authorize(started, { email });
      return () => callback(authorized.callbackPath, started.flowCookie);
    }

    /** What the access token can reach now: 200 while its session lives. */
    async function meStatus(access: string): Promise<number> {
      return (await server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } })).statusCode;
    }

    /**
     * Whatever the order: the pre-registrant holds no live session, their
     * password no longer signs in, and the owner is signed in.
     */
    async function expectNoOldPasswordSessionSurvives(
      userId: string,
      email: string,
      signedIn: LightMyRequestResponse,
      oidc: LightMyRequestResponse,
    ): Promise<void> {
      const { access } = expectSignedIn(oidc);
      expect((await me(access)).id).toBe(userId);
      if (signedIn.statusCode === 200) {
        expect(await meStatus(setCookies(signedIn).get("telflo_access")!.value)).toBe(401);
      }
      const live = await ownerDb
        .selectFrom("sessions")
        .select("id")
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .execute();
      expect(live).toHaveLength(1);
      const after = await ownerDb.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
      expect(after.password_hash).toBeNull();
      expect((await passwordSignIn(email)).statusCode).toBe(401);
    }

    it("an email verification that commits before the takeover's lock: the plain link, and the password kept", async () => {
      const account = await preRegistered();
      const userId = account.user.id;
      const callbackNow = await prepareCallback(account.user.email);
      const verifiedAt = new Date(Date.now() - 60_000);

      // The confirmation holds the row while it verifies the address; the
      // callback has already read the account as unverified.
      const verification = await hold(async (transaction) => {
        await lockUser(transaction, userId);
        await transaction.updateTable("users").set({ email_verified_at: verifiedAt }).where("id", "=", userId).execute();
      });
      const pending = callbackNow();
      try {
        await waitForLockWaits(1);
      } finally {
        verification.release();
      }
      await verification.done;

      const { access } = expectSignedIn(await pending);
      expect((await me(access)).id).toBe(userId);
      const after = await ownerDb.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
      expect(after.password_hash).toBe(passwordHash);
      expect(after.email_verified_at).toEqual(verifiedAt);
      expect(after.accepted_terms_version).not.toBeNull();
      expect(await identitiesOf(userId)).toHaveLength(1);
      expect(await auditRows("user.unverified_account_taken_over")).toEqual([]);
      expect((await passwordSignIn(account.user.email)).statusCode).toBe(200);
    });

    // A password sign-in with the pre-registrant's password, racing the
    // takeover. Today sign-in refuses an unverified account (403
    // email_not_verified) before it reaches the session start, so neither
    // order ever queues it on the row. Behind that guard, the lock order is
    // the second line: the tests below queue the sign-in on the row when it
    // gets that far, so whichever order the locks resolve in is exercised
    // should the first guard ever go.

    it("a password sign-in queued on the user's row before the takeover: its session, if any, is revoked", async () => {
      const account = await preRegistered();
      const userId = account.user.id;
      const callbackNow = await prepareCallback(account.user.email);

      const gate = await hold((transaction) => lockUser(transaction, userId));
      const signIn = track(passwordSignIn(account.user.email));
      let oidc: Promise<LightMyRequestResponse> | undefined;
      try {
        // The sign-in queues first at its session start, or is refused before it.
        await waitForLockWaits(1, () => signIn.settled);
        const queued = signIn.settled ? 0 : 1;
        oidc = callbackNow();
        // Then the takeover queues behind it.
        await waitForLockWaits(queued + 1);
      } finally {
        gate.release();
      }
      await gate.done;
      const [signedIn, oidcResponse] = await Promise.all([signIn.promise, oidc]);

      const [takeover] = await auditRows("user.unverified_account_taken_over");
      if (signedIn.statusCode === 200) {
        // The session committed first; the takeover revoked it.
        const revoked = await ownerDb.selectFrom("sessions").select("revoked_reason").where("user_id", "=", userId).execute();
        expect(revoked.map((row) => row.revoked_reason)).toContain("account_taken_over");
        expect(takeover?.metadata).toMatchObject({ revokedSessions: 1 });
      } else {
        expect(signedIn.statusCode).toBe(403);
        expect(signedIn.json()).toMatchObject({ error: { code: "email_not_verified" } });
        expect(takeover?.metadata).toMatchObject({ revokedSessions: 0 });
      }
      await expectNoOldPasswordSessionSurvives(userId, account.user.email, signedIn, oidcResponse);
    });

    it("a password sign-in queued on the user's row behind the takeover: refused", async () => {
      const account = await preRegistered();
      const userId = account.user.id;
      const callbackNow = await prepareCallback(account.user.email);

      const gate = await hold((transaction) => lockUser(transaction, userId));
      const oidc = callbackNow();
      let signIn: Tracked<LightMyRequestResponse> | undefined;
      try {
        // The takeover queues first.
        await waitForLockWaits(1);
        signIn = track(passwordSignIn(account.user.email));
        // Then the sign-in behind it at its session start, or is refused before it.
        await waitForLockWaits(2, () => signIn!.settled);
      } finally {
        gate.release();
      }
      await gate.done;
      const [signedIn, oidcResponse] = await Promise.all([signIn!.promise, oidc]);

      // Queued, it rereads the hash the takeover deleted (D3 Ruling 15):
      // 401 password_changed. Refused before it, 403.
      expect([401, 403]).toContain(signedIn.statusCode);
      const [failure] = await auditRows("user.sign_in_failed");
      expect(failure?.metadata).toEqual({
        reason: signedIn.statusCode === 401 ? "password_changed" : "email_not_verified",
      });
      await expectNoOldPasswordSessionSurvives(userId, account.user.email, signedIn, oidcResponse);
    });
  });

  it("keeps the code, state, cookie, verifier and client secret out of the logs and the audit trail", async () => {
    const { logged, lines } = await loggedServer();

    const started = await start(undefined, logged);
    const authorized = await authorize(started);
    const flow = (await readFlowCookie(started.flowCookie, settings.accessTokenSecret, clock))!;
    expectSignedIn(await callback(authorized.callbackPath, started.flowCookie, logged));
    // And a failure, whose audit row must not carry them either.
    const replay = await callback(authorized.callbackPath, started.flowCookie, logged);
    expectRefused(replay, "oauth_failed");

    const code = authorized.query.get("code")!;
    const secrets = [code, flow.state, flow.nonce, flow.codeVerifier, started.flowCookie, fake.clientSecret];
    const log = lines.join("\n");
    expect(log).toContain(CALLBACK_PATH);
    const audit = JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().execute());
    for (const secret of secrets) {
      expect(log).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
  });

  it("audits an unexpected failure in the callback and still redirects, with no code or state in the logs (M3, M7)", async () => {
    const failing = failNextSelectFrom("user_identities");
    const { logged, lines } = await loggedServer({ db: serverDb.withPlugin(failing.plugin) });
    const started = await start("/app/settings", logged);
    const authorized = await authorize(started);
    const flow = (await readFlowCookie(started.flowCookie, settings.accessTokenSecret, clock))!;

    failing.arm();
    const response = await callback(authorized.callbackPath, started.flowCookie, logged);

    // Not the 500 envelope: a redirect keeping the flow's own redirectTo.
    expectRefused(response, "oauth_failed", "/app/settings");
    expect(response.body).toBe("");
    expect(await counts()).toEqual({ users: 0, identities: 0, sessions: 0 });
    const [row] = await auditRows("user.oidc_sign_in_failed");
    expect(row?.metadata).toEqual({ reason: "internal_error", provider: "google", error: "Error" });

    const log = lines.join("\n");
    expect(log).toContain("OIDC callback failed");
    expect(log).toContain("injected failure");
    for (const secret of [authorized.query.get("code")!, flow.state, started.flowCookie]) {
      expect(log).not.toContain(secret);
      expect(JSON.stringify(row)).not.toContain(secret);
    }
  });
});
