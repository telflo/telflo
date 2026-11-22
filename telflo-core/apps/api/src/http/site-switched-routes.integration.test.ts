import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, type SiteSettings } from "@telflo/contracts";
import { openTestDatabases, type TestDatabases } from "@telflo/db/testing";
import type { IMailer } from "../mail/mailer.js";
import { TEST_RATE_LIMITS } from "./rate-limits.js";
import { loadSettings, type AppSettings } from "../settings.js";
import { buildServer } from "../server.js";
import { useFakeOpampServer } from "../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../testing/file-store.js";
import { UNCALLED_TESTING } from "../testing/otelcol-testing.js";

/*
 * The routes behind TELFLO_USER_FEEDBACK, TELFLO_LEARNING and
 * TELFLO_USER_ADMIN: with a switch off, the open source's default, every one
 * of its routes answers exactly as a path nothing serves (404 not_found,
 * not-found-when.ts), before the session, the limits and the body are read;
 * with it on, the same request reaches the route (its own answer, never the
 * switch's). Their behavior when on is each module's own test's.
 */

const opamp = useFakeOpampServer();

const ID = "00000000-0000-4000-8000-0000000000aa";

/** No route here reaches the mailer: a switched-off route answers first, and a switched-on one wants a session. */
const UNCALLED_MAILER: IMailer = {
  async send() {
    throw new Error("the mailer was called");
  },
};

const SWITCHED: ReadonlyArray<readonly [keyof Pick<SiteSettings, "userFeedback" | "learning" | "userAdmin">, string, string]> = [
  ["userFeedback", "POST", "/api/v1/feedback"],
  ["userFeedback", "GET", "/api/v1/product-admin/feedback"],
  ["userFeedback", "GET", "/api/v1/product-admin/feedback/pending-count"],
  ["userFeedback", "POST", `/api/v1/product-admin/feedback/${ID}/acknowledge`],
  ["userFeedback", "POST", `/api/v1/product-admin/feedback/${ID}/dismiss`],
  ["learning", "GET", "/api/v1/library-files"],
  ["learning", "POST", "/api/v1/library-files"],
  ["learning", "PATCH", `/api/v1/library-files/${ID}`],
  ["learning", "DELETE", `/api/v1/library-files/${ID}`],
  ["learning", "GET", `/api/v1/library-files/${ID}/file`],
  ["learning", "POST", `/api/v1/library-files/${ID}/link`],
  ["learning", "GET", "/api/v1/library-links/tll_not-a-link"],
  ["userAdmin", "GET", "/api/v1/product-admin/users"],
  ["userAdmin", "DELETE", `/api/v1/product-admin/users/${ID}`],
];

/** The switch's answer: an unknown path's 404 not_found, its fixed message naming the method. */
function isSwitchedOff(response: LightMyRequestResponse, method: string): boolean {
  if (response.statusCode !== 404) return false;
  try {
    const body = response.json() as { error?: { code?: string; message?: string } };
    return body.error?.code === "not_found" && (body.error.message ?? "").startsWith(`No route for ${method} /api/v1/`);
  } catch {
    // The library link's own 404 is plain text ("Not found."), never the switch's.
    return false;
  }
}

describe("the site's switched routes", () => {
  let settings: AppSettings;
  let databases: TestDatabases;
  let servers: FastifyInstance[] = [];

  const serverWith = async (site: Partial<SiteSettings>): Promise<FastifyInstance> => {
    const server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: { ...settings, site: { ...settings.site, ...site } },
      db: databases.db,
      mailer: UNCALLED_MAILER,
      rateLimits: TEST_RATE_LIMITS,
    });
    servers.push(server);
    await server.ready();
    return server;
  };

  const call = (server: FastifyInstance, method: string, url: string) =>
    server.inject({
      method: method as "GET",
      url,
      remoteAddress: "198.51.100.9",
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });

  beforeAll(() => {
    settings = loadSettings(process.env);
    databases = openTestDatabases();
  });

  afterAll(async () => {
    await databases.destroy();
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
  });

  it("are all off on the open source's defaults", () => {
    const defaults = loadSettings({ ...process.env, TELFLO_USER_FEEDBACK: "", TELFLO_LEARNING: "", TELFLO_USER_ADMIN: "" }).site;
    expect({ userFeedback: defaults.userFeedback, learning: defaults.learning, userAdmin: defaults.userAdmin }).toEqual({
      userFeedback: false,
      learning: false,
      userAdmin: false,
    });
  });

  it.each(SWITCHED)("%s off: %s %s answers as a path nothing serves", async (key, method, url) => {
    const server = await serverWith({ [key]: false });

    expect(isSwitchedOff(await call(server, method, url), method)).toBe(true);
  });

  it.each(SWITCHED)("%s on: %s %s reaches its route", async (key, method, url) => {
    const server = await serverWith({ [key]: true });

    expect(isSwitchedOff(await call(server, method, url), method)).toBe(false);
  });

  it("turns off only its own routes: the feedback off leaves the library and Users on", async () => {
    const server = await serverWith({ userFeedback: false, learning: true, userAdmin: true });

    expect(isSwitchedOff(await call(server, "POST", "/api/v1/feedback"), "POST")).toBe(true);
    expect(isSwitchedOff(await call(server, "GET", "/api/v1/library-files"), "GET")).toBe(false);
    expect(isSwitchedOff(await call(server, "GET", "/api/v1/product-admin/users"), "GET")).toBe(false);
  });
});
