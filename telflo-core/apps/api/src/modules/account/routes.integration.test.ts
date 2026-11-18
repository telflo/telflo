import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, DEFAULT_USER_PREFERENCES } from "@telflo/contracts";
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
 * GET and PATCH /api/v1/auth/me/preferences (D21 decisions 19, 20 and 23):
 * the whole preferences, defaults filled in; the merge; the validator's
 * refusals; no audit row; a session needed, the current terms not; the
 * caller's own row only; and the theme cookie a PATCH with a theme sets.
 */

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const PREFERENCES_URL = "/api/v1/auth/me/preferences";

function setCookieLines(response: LightMyRequestResponse): string[] {
  const header = response.headers["set-cookie"];
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}

/** The reply's `telflo_theme` Set-Cookie split into its value and attributes, if any. */
function themeCookie(response: LightMyRequestResponse): { value: string; attributes: string[] } | undefined {
  for (const line of setCookieLines(response)) {
    const [pair, ...attributes] = line.split(";").map((part) => part.trim());
    if (pair!.startsWith("telflo_theme=")) return { value: pair!.slice("telflo_theme=".length), attributes };
  }
  return undefined;
}

function cookieValue(response: LightMyRequestResponse, name: string): string {
  for (const line of setCookieLines(response)) {
    const pair = line.split(";")[0]!.trim();
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  throw new Error(`the response set no ${name} cookie`);
}

describe("the preferences routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = buildServer({
      settings,
      db,
      mailer: createInMemoryMailer(),
      now: () => clock,
      rateLimits: TEST_RATE_LIMITS,
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
    });
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
    clock = new Date("2026-10-22T09:00:00.000Z");
  });

  const person = (user: Record<string, unknown> = {}) =>
    createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash, ...user },
    });

  /** Signs in and answers the access cookie. */
  const signedIn = async (email: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const getPreferences = (access?: string) =>
    server.inject({
      method: "GET",
      url: PREFERENCES_URL,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const patchPreferences = (access: string | undefined, payload: unknown) =>
    server.inject({
      method: "PATCH",
      url: PREFERENCES_URL,
      headers: csrfHeaders,
      payload: payload as Record<string, unknown>,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const storedRow = (userId: string) =>
    ownerDb.selectFrom("user_settings").selectAll().where("user_id", "=", userId).executeTakeFirst();

  const auditRows = () => ownerDb.selectFrom("audit_events").select(["action", "actor_user_id"]).execute();

  it("GET answers the defaults with no row", async () => {
    const account = await person();
    const access = await signedIn(account.user.email);

    const response = await getPreferences(access);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEFAULT_USER_PREFERENCES);
    expect(await storedRow(account.user.id)).toBeUndefined();
  });

  it("PATCH answers the whole preferences after each single-key change", async () => {
    const account = await person();
    const access = await signedIn(account.user.email);
    const changes = [
      [{ theme: "light" }, { theme: "light" }],
      [{ editor: { tabSize: 4 } }, { editor: { tabSize: 4 } }],
      [{ editor: { fontSize: 20 } }, { editor: { fontSize: 20 } }],
      [{ editor: { lineNumbers: false } }, { editor: { lineNumbers: false } }],
      [{ editor: { minimap: true } }, { editor: { minimap: true } }],
      [{ email: { productUpdates: false } }, { email: { productUpdates: false } }],
      [{ email: { productTips: false } }, { email: { productTips: false } }],
    ] as const;
    let expected: Record<string, unknown> = structuredClone(DEFAULT_USER_PREFERENCES);

    for (const [change, effect] of changes) {
      expected = {
        ...expected,
        ...("theme" in effect ? effect : {}),
        editor: { ...(expected.editor as object), ...("editor" in effect ? effect.editor : {}) },
        email: { ...(expected.email as object), ...("email" in effect ? effect.email : {}) },
      };
      const response = await patchPreferences(access, change);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      expect((await getPreferences(access)).json()).toEqual(expected);
    }
    expect(expected).toEqual({
      theme: "light",
      editor: { tabSize: 4, fontSize: 20, lineNumbers: false, minimap: true },
      email: { productUpdates: false, productTips: false },
    });
    expect(await storedRow(account.user.id)).toMatchObject({ created_at: clock, updated_at: clock });
  });

  it("PATCH refuses an empty body, an empty group, an unknown key and an unknown value with 400 invalid_request", async () => {
    const account = await person();
    const access = await signedIn(account.user.email);

    for (const body of [
      {},
      { editor: {} },
      { email: {} },
      { colour: "blue" },
      { editor: { wordWrap: true } },
      { email: { marketing: false } },
      { theme: "system" },
      { editor: { tabSize: 3 } },
      { editor: { fontSize: 17 } },
      { editor: { minimap: "yes" } },
      { email: { productTips: null } },
    ]) {
      const response = await patchPreferences(access, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(themeCookie(response)).toBeUndefined();
    }
    expect(await storedRow(account.user.id)).toBeUndefined();
  });

  it("writes no audit row", async () => {
    const account = await person();
    const access = await signedIn(account.user.email);
    const before = await auditRows();

    expect((await getPreferences(access)).statusCode).toBe(200);
    expect((await patchPreferences(access, { theme: "navy", editor: { fontSize: 14 } })).statusCode).toBe(200);
    expect((await patchPreferences(access, { email: { productTips: false } })).statusCode).toBe(200);

    expect(await auditRows()).toEqual(before);
  });

  it("needs a session and not the current terms", async () => {
    expect((await getPreferences()).statusCode).toBe(401);
    expect((await getPreferences()).json()).toMatchObject({ error: { code: "unauthenticated" } });
    const refused = await patchPreferences(undefined, { theme: "light" });
    expect(refused.statusCode).toBe(401);
    expect(themeCookie(refused)).toBeUndefined();
    expect(await ownerDb.selectFrom("user_settings").selectAll().execute()).toEqual([]);

    // No terms accepted: the shell's dialog blocks it, but the account's own routes answer.
    const account = await person({ accepted_terms_version: null, terms_accepted_at: null });
    const access = await signedIn(account.user.email);
    expect((await getPreferences(access)).statusCode).toBe(200);
    const patched = await patchPreferences(access, { theme: "light" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ theme: "light" });
  });

  it("/me carries the preferences, the defaults with no row", async () => {
    const account = await person();
    const access = await signedIn(account.user.email);
    const me = () => server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

    expect((await me()).json()).toMatchObject({ preferences: DEFAULT_USER_PREFERENCES });

    await patchPreferences(access, { theme: "navy", editor: { minimap: true } });

    expect((await me()).json()).toMatchObject({
      preferences: { ...DEFAULT_USER_PREFERENCES, theme: "navy", editor: { ...DEFAULT_USER_PREFERENCES.editor, minimap: true } },
    });
  });

  it("a PATCH changes only the caller's row", async () => {
    // The other person saved first, so their row is the older one.
    const other = await person();
    const otherAccess = await signedIn(other.user.email);
    expect((await patchPreferences(otherAccess, { theme: "light", editor: { tabSize: 4 } })).statusCode).toBe(200);
    const otherRow = await storedRow(other.user.id);
    const caller = await person();
    const callerAccess = await signedIn(caller.user.email);
    clock = new Date("2026-10-22T09:05:00.000Z");

    const response = await patchPreferences(callerAccess, { theme: "navy", email: { productUpdates: false } });

    expect(response.statusCode).toBe(200);
    const callerPreferences = {
      ...DEFAULT_USER_PREFERENCES,
      theme: "navy",
      email: { ...DEFAULT_USER_PREFERENCES.email, productUpdates: false },
    };
    expect(response.json()).toEqual(callerPreferences);
    expect(await storedRow(caller.user.id)).toMatchObject({
      theme: "navy",
      preferences: { email: { productUpdates: false } },
    });
    expect(await storedRow(other.user.id)).toEqual(otherRow);
    expect((await getPreferences(callerAccess)).json()).toEqual(callerPreferences);
    expect((await getPreferences(otherAccess)).json()).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      theme: "light",
      editor: { ...DEFAULT_USER_PREFERENCES.editor, tabSize: 4 },
    });
  });

  describe("the theme cookie (D21 decision 23)", () => {
    it("a PATCH with theme sets it, and one without theme doesn't", async () => {
      const account = await person();
      const access = await signedIn(account.user.email);

      const withTheme = await patchPreferences(access, { theme: "light", editor: { fontSize: 15 } });

      expect(withTheme.statusCode).toBe(200);
      expect(themeCookie(withTheme)).toEqual({
        value: "light",
        attributes: ["Max-Age=31536000", "Path=/", "HttpOnly", ...(settings.isCookieSecure ? ["Secure"] : []), "SameSite=Lax"],
      });
      // Only the theme cookie: the session's are untouched.
      expect(setCookieLines(withTheme)).toHaveLength(1);

      const withoutTheme = await patchPreferences(access, { editor: { fontSize: 16 }, email: { productTips: false } });

      expect(withoutTheme.statusCode).toBe(200);
      expect(setCookieLines(withoutTheme)).toEqual([]);

      const navy = await patchPreferences(access, { theme: "navy" });
      expect(themeCookie(navy)?.value).toBe("navy");
      expect(setCookieLines(await getPreferences(access))).toEqual([]);
    });

    it("is Secure as the session cookies", async () => {
      for (const isCookieSecure of [true, false]) {
        const variant = buildServer({
          settings: { ...settings, isCookieSecure },
          db,
          mailer: createInMemoryMailer(),
          now: () => clock,
          rateLimits: TEST_RATE_LIMITS,
          opampServer: opamp.client,
          otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
          fileStore: UNCALLED_FILE_STORE,
          testing: UNCALLED_TESTING,
        });
        try {
          await variant.ready();
          const account = await person();
          const signIn = await variant.inject({
            method: "POST",
            url: "/api/v1/auth/sessions",
            headers: csrfHeaders,
            payload: { email: account.user.email, password: PASSWORD },
          });
          const response = await variant.inject({
            method: "PATCH",
            url: PREFERENCES_URL,
            headers: csrfHeaders,
            payload: { theme: "light" },
            cookies: { telflo_access: cookieValue(signIn, "telflo_access") },
          });
          expect(themeCookie(response)?.attributes.includes("Secure")).toBe(isCookieSecure);
        } finally {
          await variant.close();
        }
      }
    });
  });
});
