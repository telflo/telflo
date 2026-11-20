import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routedFetch, type FakeFetch } from "../../tests/fake-fetch.js";
import { runCli } from "../../tests/run-cli.js";
import { deleteCredentials, loadCredentials, saveCredentials, type TokenKind } from "../credentials.js";
import { ORG_USE_NOT_ONE_OF_THEM_MESSAGE, ORG_USE_SERVICE_ACCOUNT_MESSAGE, ORG_USE_WITH_ENVIRONMENT_TOKEN_MESSAGE } from "./org.js";

/* telflo org list and telflo org use. */

const SERVER = "https://telflo.example";
const PERSONAL = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const GROUP = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";

const organizations = [
  { id: PERSONAL, name: "ada@example.com", type: "personal", role: "admin" },
  { id: GROUP, name: "Acme", type: "group", role: "contributor" },
];

let token: string;
let fake: FakeFetch;

function store(kind: TokenKind = "person"): void {
  saveCredentials({ version: 1, server: SERVER, token, kind, tokenName: "laptop", organizationId: PERSONAL });
}

/** runCli, then the token canary (a boolean) before anything compares what it wrote. */
async function cli(args: readonly string[]): ReturnType<typeof runCli> {
  const result = await runCli(args);
  expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
  return result;
}

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  fake = routedFetch({ "GET /orgs": { json: { items: organizations, nextCursor: null } } });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("telflo org list", () => {
  it("lists /orgs with the current one marked, sending no X-Telflo-Org", async () => {
    store();
    const result = await cli(["org", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")[2]?.startsWith("*")).toBe(true);
    expect(result.stdout.split("\n")[3]?.startsWith(" ")).toBe(true);
    expect(result.stdout.includes("Acme")).toBe(true);
    expect(fake.calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([null]);
    expect(result.stdout.includes(token)).toBe(false);
  });

  it("marks TELFLO_ORG's as current, and prints JSON with --json", async () => {
    store();
    vi.stubEnv("TELFLO_ORG", GROUP);
    const result = await cli(["--json", "org", "list"]);
    expect(JSON.parse(result.stdout)).toEqual({ items: organizations, current: GROUP });
  });

  it("marks a service account's own organization for TELFLO_TOKEN, never TELFLO_ORG", async () => {
    fake = routedFetch({
      "GET /whoami": { json: { kind: "service_account", tokenName: "robot", access: "read", organizationId: GROUP } },
      "GET /orgs": { json: { items: [organizations[1]], nextCursor: null } },
    });
    vi.stubGlobal("fetch", fake.fetch);
    vi.stubEnv("TELFLO_TOKEN", token);
    vi.stubEnv("TELFLO_SERVER", SERVER);
    vi.stubEnv("TELFLO_ORG", PERSONAL);
    const result = await cli(["--json", "org", "list"]);
    expect(JSON.parse(result.stdout)).toEqual({ items: [organizations[1]], current: GROUP });
    expect(fake.calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([null, null]);
  });

  it("strips control characters from the names it prints", async () => {
    fake = routedFetch({ "GET /orgs": { json: { items: [{ ...organizations[1], name: "Ac\u001b]0;x\u0007me\u009b" }], nextCursor: null } } });
    vi.stubGlobal("fetch", fake.fetch);
    store();
    const list = await cli(["org", "list"]);
    expect(list.stdout.includes("Ac]0;xme")).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(list.stdout)).toBe(false);
    expect((await cli(["org", "use", GROUP])).stdout).toBe(`Now using Ac]0;xme (${GROUP}).\n`);
  });

  it("exits 3 when not logged in", async () => {
    expect((await cli(["org", "list"])).code).toBe(3);
  });
});

describe("telflo org use", () => {
  it("stores the organization, canonicalized and checked against /orgs", async () => {
    store();
    const result = await cli(["org", "use", GROUP.toUpperCase()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Now using Acme (${GROUP}).\n`);
    const stored = loadCredentials();
    expect(stored?.organizationId).toBe(GROUP);
    expect(stored === null ? false : stored.token === token).toBe(true);
  });

  it("refuses a malformed id before any request", async () => {
    store();
    const result = await cli(["org", "use", "acme"]);
    expect(result.code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an organization the token can't act in", async () => {
    store();
    const result = await cli(["org", "use", "2d9a0cbe-3f4a-4b52-8c6d-7e8f9a0b1c2d"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`error: ${ORG_USE_NOT_ONE_OF_THEM_MESSAGE}\n`);
    expect(loadCredentials()?.organizationId).toBe(PERSONAL);
  });

  it("refuses a service account's token, and TELFLO_TOKEN", async () => {
    store("service_account");
    expect((await cli(["org", "use", GROUP])).stderr).toBe(`error: ${ORG_USE_SERVICE_ACCOUNT_MESSAGE}\n`);
    vi.stubEnv("TELFLO_TOKEN", token);
    // TELFLO_TOKEN pairs with TELFLO_SERVER only (there is no default server).
    vi.stubEnv("TELFLO_SERVER", SERVER);
    const environment = await cli(["org", "use", GROUP]);
    expect(environment.code).toBe(2);
    expect(environment.stderr).toBe(`error: ${ORG_USE_WITH_ENVIRONMENT_TOKEN_MESSAGE}\n`);
    expect(fake.calls).toHaveLength(0);
  });

  it("prints JSON with --json", async () => {
    store();
    expect(JSON.parse((await cli(["--json", "org", "use", GROUP])).stdout)).toEqual({ organizationId: GROUP, organizationName: "Acme" });
  });
});
