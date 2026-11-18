import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envelope, routedFetch } from "../tests/fake-fetch.js";
import {
  anonymousClient,
  clientFor,
  ENVIRONMENT_TOKEN_MALFORMED_MESSAGE,
  NOT_LOGGED_IN_MESSAGE,
  OTHER_SERVER_MESSAGE,
  PERSON_ORGANIZATION_NEEDED_MESSAGE,
  requireClient,
  requireLogin,
  resolveLogin,
  SERVICE_ACCOUNT_ORGANIZATION_MESSAGE,
} from "./context.js";
import { saveCredentials, type Credentials } from "./credentials.js";
import { ExitError } from "./output.js";
import { NO_SERVER_MESSAGE } from "./server.js";

/*
 * Which login a command runs with, and the origin rule (D27 decisions 12
 * and 15): a token goes only to the origin it was entered for. Tokens are
 * made at run time and checked with boolean canaries only.
 */

const STORED_SERVER = "https://stored.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const OTHER_ORGANIZATION = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";

let root: string;
let env: NodeJS.ProcessEnv;
let storedToken: string;
let environmentToken: string;

function store(overrides: Partial<Credentials> = {}): void {
  saveCredentials(
    { version: 1, server: STORED_SERVER, token: storedToken, kind: "person", tokenName: "laptop", organizationId: ORGANIZATION, ...overrides },
    env,
  );
}

function refusalOf(action: () => unknown): ExitError {
  try {
    action();
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("nothing was refused");
}

async function asyncRefusalOf(promise: Promise<unknown>): Promise<ExitError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("nothing was refused");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "telflo-context-"));
  env = { TELFLO_CLI_CONFIG_DIR: join(root, "config") };
  storedToken = `tf_${randomBytes(32).toString("base64url")}`;
  environmentToken = `tf_${randomBytes(32).toString("base64url")}`;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveLogin (decisions 12 and 15)", () => {
  it("answers null with no file and no TELFLO_TOKEN; requireLogin exits 3", () => {
    expect(resolveLogin(env)).toBeNull();
    const error = refusalOf(() => requireLogin(env));
    expect(error.message).toBe(NOT_LOGGED_IN_MESSAGE);
    expect(error.exitCode).toBe(3);
  });

  it("reads the file: its token for its server and its organization", () => {
    store();
    const login = requireLogin(env);
    expect(login.source).toBe("file");
    expect(login.server).toBe(STORED_SERVER);
    expect(login.token === storedToken).toBe(true);
    expect(login.organizationId).toBe(ORGANIZATION);
    expect(login.kind).toBe("person");
  });

  it("lets TELFLO_ORG override a person's organization for one shell, canonicalized", () => {
    store();
    expect(requireLogin({ ...env, TELFLO_ORG: OTHER_ORGANIZATION.toUpperCase() }).organizationId).toBe(OTHER_ORGANIZATION);
    expect(refusalOf(() => requireLogin({ ...env, TELFLO_ORG: "not-an-id" })).exitCode).toBe(2);
  });

  it("refuses TELFLO_ORG for a service account's token", () => {
    store({ kind: "service_account" });
    expect(requireLogin(env).organizationId).toBe(ORGANIZATION);
    expect(refusalOf(() => requireLogin({ ...env, TELFLO_ORG: OTHER_ORGANIZATION })).message).toBe(SERVICE_ACCOUNT_ORGANIZATION_MESSAGE);
  });

  it("refuses TELFLO_SERVER naming another origin than the stored token's (the origin rule)", () => {
    store();
    const error = refusalOf(() => requireLogin({ ...env, TELFLO_SERVER: "https://other.example" }));
    expect(error.message.includes(storedToken)).toBe(false);
    expect(error.message).toBe(OTHER_SERVER_MESSAGE(STORED_SERVER, "https://other.example"));
    expect(error.exitCode).toBe(3);
    expect(requireLogin({ ...env, TELFLO_SERVER: "https://STORED.example/" }).server).toBe(STORED_SERVER);
  });

  it("takes TELFLO_TOKEN over the file, with TELFLO_SERVER only: never the stored server, and no default", () => {
    store();
    const noServer = refusalOf(() => requireLogin({ ...env, TELFLO_TOKEN: environmentToken }));
    expect(noServer.message).toBe(NO_SERVER_MESSAGE);
    expect(noServer.exitCode).toBe(2);
    expect(noServer.message.includes(environmentToken)).toBe(false);
    const fromEnvironment = requireLogin({ ...env, TELFLO_TOKEN: environmentToken, TELFLO_SERVER: "https://env.example" });
    expect(fromEnvironment.source).toBe("environment");
    expect(fromEnvironment.server).toBe("https://env.example");
    expect(fromEnvironment.token === environmentToken).toBe(true);
    expect(fromEnvironment.kind).toBeUndefined();
    expect(fromEnvironment.organizationId).toBeUndefined();
    const withServer = requireLogin({ ...env, TELFLO_TOKEN: environmentToken, TELFLO_SERVER: "http://localhost:50080", TELFLO_ORG: ORGANIZATION });
    expect(withServer.server).toBe("http://localhost:50080");
    expect(withServer.organizationId).toBe(ORGANIZATION);
  });

  it("trims TELFLO_TOKEN as login trims its input", () => {
    const login = requireLogin({ ...env, TELFLO_SERVER: "https://env.example", TELFLO_TOKEN: `  ${environmentToken}\n` });
    expect(login.token === environmentToken).toBe(true);
    expect(resolveLogin({ ...env, TELFLO_TOKEN: " \n" })).toBeNull();
  });

  it("refuses a malformed TELFLO_TOKEN without echoing it", () => {
    const malformed = `tf_${randomBytes(8).toString("hex")}`;
    const error = refusalOf(() => requireLogin({ ...env, TELFLO_TOKEN: malformed }));
    expect(error.message.includes(malformed)).toBe(false);
    expect(error.message).toBe(ENVIRONMENT_TOKEN_MALFORMED_MESSAGE);
    expect(error.exitCode).toBe(2);
  });

  it("refuses a plain-http TELFLO_SERVER with TELFLO_TOKEN (the HTTPS rule)", () => {
    expect(refusalOf(() => requireLogin({ ...env, TELFLO_TOKEN: environmentToken, TELFLO_SERVER: "http://telflo.example" })).exitCode).toBe(2);
  });
});

describe("clientFor: the token to its server, X-Telflo-Org for a person (decision 15)", () => {
  const routes = (kind: "person" | "service_account") =>
    routedFetch({
      "GET /whoami": { json: { kind, tokenName: "t", access: "write", organizationId: kind === "person" ? null : ORGANIZATION } },
      "GET /fleets": { json: { items: [], nextCursor: null } },
    });

  it("sends the file's person's organization, and none on routes that take none", async () => {
    store();
    const fake = routes("person");
    const client = clientFor(requireLogin(env), { fetch: fake.fetch });
    await client.request("GET", "/fleets");
    await client.request("GET", "/whoami", { organization: false });
    expect(fake.calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([ORGANIZATION, null]);
    expect(fake.calls.every((call) => call.url.origin === STORED_SERVER)).toBe(true);
    expect(fake.calls.every((call) => call.headers.get("authorization") === `Bearer ${storedToken}`)).toBe(true);
  });

  it("sends no X-Telflo-Org for a service account's token", async () => {
    store({ kind: "service_account" });
    const fake = routes("service_account");
    await clientFor(requireLogin(env), { fetch: fake.fetch }).request("GET", "/fleets");
    expect(fake.calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([null]);
  });

  it("asks /whoami once for TELFLO_TOKEN's kind: a person's sends TELFLO_ORG", async () => {
    const fake = routes("person");
    const client = clientFor(requireLogin({ ...env, TELFLO_SERVER: "https://env.example", TELFLO_TOKEN: environmentToken, TELFLO_ORG: ORGANIZATION }), { fetch: fake.fetch });
    await client.request("GET", "/fleets");
    await client.request("GET", "/fleets");
    expect(fake.calls.map((call) => `${call.url.pathname} ${call.headers.get("x-telflo-org")}`)).toEqual([
      "/api/public/v1/whoami null",
      `/api/public/v1/fleets ${ORGANIZATION}`,
      `/api/public/v1/fleets ${ORGANIZATION}`,
    ]);
  });

  it("refuses a person's TELFLO_TOKEN without TELFLO_ORG where a route needs one", async () => {
    const fake = routes("person");
    const client = clientFor(requireLogin({ ...env, TELFLO_SERVER: "https://env.example", TELFLO_TOKEN: environmentToken }), { fetch: fake.fetch });
    expect((await asyncRefusalOf(client.request("GET", "/fleets"))).message).toBe(PERSON_ORGANIZATION_NEEDED_MESSAGE);
    expect(fake.calls.some((call) => call.url.pathname.endsWith("/fleets"))).toBe(false);
  });

  it("sends nothing for a service account's TELFLO_TOKEN, and refuses TELFLO_ORG with it", async () => {
    const fake = routes("service_account");
    await clientFor(requireLogin({ ...env, TELFLO_SERVER: "https://env.example", TELFLO_TOKEN: environmentToken }), { fetch: fake.fetch }).request("GET", "/fleets");
    expect(fake.calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([null, null]);
    const withOrg = clientFor(requireLogin({ ...env, TELFLO_SERVER: "https://env.example", TELFLO_TOKEN: environmentToken, TELFLO_ORG: ORGANIZATION }), { fetch: fake.fetch });
    expect((await asyncRefusalOf(withOrg.request("GET", "/fleets"))).message).toBe(SERVICE_ACCOUNT_ORGANIZATION_MESSAGE);
  });

  it("lets /whoami's own refusal through when TELFLO_TOKEN's kind can't be learnt", async () => {
    const fake = routedFetch({ "GET /whoami": { status: 401, json: envelope("invalid_api_token", "Missing or invalid API token") } });
    const client = clientFor(requireLogin({ ...env, TELFLO_SERVER: "https://env.example", TELFLO_TOKEN: environmentToken }), { fetch: fake.fetch });
    await expect(client.request("GET", "/fleets")).rejects.toMatchObject({ status: 401 });
  });

  it("requireClient builds the logged-in client", () => {
    store();
    expect(requireClient(env).server).toBe(STORED_SERVER);
    expect(requireClient(env).authenticated).toBe(true);
  });
});

describe("anonymousClient (the open routes)", () => {
  it("has no token, and goes to TELFLO_SERVER (none is exit 2: no default server)", async () => {
    store();
    const fake = routedFetch({ "POST /validate/anonymous": { json: { valid: true } } });
    const client = anonymousClient({ ...env, TELFLO_SERVER: "http://127.0.0.1:9" }, { fetch: fake.fetch });
    await client.request("POST", "/validate/anonymous", { body: { yaml: "x" }, organization: false });
    expect(fake.calls[0]?.headers.has("authorization")).toBe(false);
    expect(fake.calls[0]?.url.origin).toBe("http://127.0.0.1:9");
    expect(refusalOf(() => anonymousClient({})).message).toBe(NO_SERVER_MESSAGE);
    expect(refusalOf(() => anonymousClient({ TELFLO_SERVER: "" })).exitCode).toBe(2);
  });
});
