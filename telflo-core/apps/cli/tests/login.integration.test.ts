import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { truncateAll } from "@telflo/db/testing";
import type { RecordedCall } from "./fake-fetch.js";
import { ApiClient } from "../src/api.js";
import { clientFor, requireLogin } from "../src/context.js";
import { deleteCredentials, loadCredentials } from "../src/credentials.js";
import { addGroupOrganization, personWithToken, runCli, serviceAccountWithToken, useApiServer } from "./harness.js";

/*
 * login, whoami, org list and org use against the real API in process: a
 * personal token and a service account's, made by the db's helpers at run
 * time. Tokens are checked with boolean canaries only: what the CLI wrote,
 * and every line the API logged.
 */

const api = useApiServer();

let tokens: string[];

function holdsAnyToken(...texts: string[]): boolean {
  return texts.some((text) => tokens.some((token) => text.includes(token)));
}

/** runCli, then the token canary (a boolean) before anything compares what it wrote. */
async function cli(args: readonly string[], options?: Parameters<typeof runCli>[1]): ReturnType<typeof runCli> {
  const result = await runCli(args, options);
  expect(holdsAnyToken(result.stdout, result.stderr)).toBe(false);
  return result;
}

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  deleteCredentials();
  tokens = [];
  api.logLines.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Nothing the API logged holds a token.
  expect(holdsAnyToken(...api.logLines)).toBe(false);
});

describe("telflo login from stdin", () => {
  it("logs in with a personal token, its one organization taken", async () => {
    const person = await personWithToken(api.ownerDb);
    tokens.push(person.token);
    const login = await cli(["login", "--server", api.origin], { input: `${person.token}\n` });
    expect(login.code).toBe(0);
    expect(login.stdout.startsWith(`Logged in to ${api.origin} as ${person.tokenName} (`)).toBe(true);
    expect(holdsAnyToken(login.stdout, login.stderr)).toBe(false);
    const stored = loadCredentials();
    expect(stored?.kind).toBe("person");
    expect(stored?.organizationId).toBe(person.organizationId);
    expect(stored?.server).toBe(api.origin);
    expect(stored === null ? false : stored.token === person.token).toBe(true);

    const whoami = await cli(["--json", "whoami"]);
    expect(whoami.code).toBe(0);
    expect(JSON.parse(whoami.stdout)).toMatchObject({
      server: api.origin,
      kind: "person",
      tokenName: person.tokenName,
      access: "write",
      organizationId: person.organizationId,
    });
    expect(holdsAnyToken(whoami.stdout, whoami.stderr)).toBe(false);
  });

  it("needs --org for a person in several organizations, and takes it", async () => {
    const person = await personWithToken(api.ownerDb, "read");
    tokens.push(person.token);
    const group = await addGroupOrganization(api.ownerDb, person.userId);
    const without = await cli(["login", "--server", api.origin], { input: person.token });
    expect(without.code).toBe(2);
    expect(without.stderr.includes("--org")).toBe(true);
    expect(loadCredentials()).toBeNull();

    const login = await cli(["login", "--server", api.origin, "--org", group.organizationId], { input: person.token });
    expect(login.code).toBe(0);
    expect(login.stdout.endsWith(`(${group.name}).\n`)).toBe(true);
    expect(loadCredentials()?.organizationId).toBe(group.organizationId);
  });

  it("logs in with a service account's token in its own organization", async () => {
    const account = await serviceAccountWithToken(api.ownerDb);
    tokens.push(account.token);
    const login = await cli(["login", "--server", api.origin], { input: account.token });
    expect(login.code).toBe(0);
    expect(loadCredentials()?.kind).toBe("service_account");
    expect(loadCredentials()?.organizationId).toBe(account.organizationId);

    const whoami = await cli(["whoami"]);
    expect(whoami.code).toBe(0);
    expect(whoami.stdout.includes(`Token:        ${account.tokenName} (service account token)`)).toBe(true);
    expect(whoami.stdout.includes(account.organizationId)).toBe(true);
    expect(holdsAnyToken(login.stdout, login.stderr, whoami.stdout, whoami.stderr)).toBe(false);
  });

  it("ends at a 401 for a token the API doesn't know: exit 3, nothing stored", async () => {
    const unknown = `tf_${randomBytes(32).toString("base64url")}`;
    tokens.push(unknown);
    const login = await cli(["login", "--server", api.origin], { input: unknown });
    expect(login.code).toBe(3);
    expect(login.stderr).toBe("error: Missing or invalid API token. Run telflo login.\n");
    expect(loadCredentials()).toBeNull();
    expect(holdsAnyToken(login.stdout, login.stderr)).toBe(false);
  });

  it("exits 3 from whoami once the token is revoked, and after logout", async () => {
    const person = await personWithToken(api.ownerDb);
    tokens.push(person.token);
    expect((await cli(["login", "--server", api.origin], { input: person.token })).code).toBe(0);
    await api.ownerDb.updateTable("personal_api_tokens").set({ revoked_at: new Date() }).where("user_id", "=", person.userId).execute();
    expect((await cli(["whoami"])).code).toBe(3);
    expect((await cli(["logout"])).code).toBe(0);
    const after = await cli(["whoami"]);
    expect(after.code).toBe(3);
    expect(after.stderr.includes("Not logged in")).toBe(true);
  });
});

describe("telflo org list and org use", () => {
  it("lists the person's organizations and switches the stored one", async () => {
    const person = await personWithToken(api.ownerDb);
    tokens.push(person.token);
    const group = await addGroupOrganization(api.ownerDb, person.userId, "contributor");
    expect((await cli(["login", "--server", api.origin, "--org", person.organizationId], { input: person.token })).code).toBe(0);

    const list = await cli(["--json", "org", "list"]);
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.stdout) as { items: Array<{ id: string; role: string }>; current: string };
    expect(listed.items.map((item) => item.id)).toEqual([person.organizationId, group.organizationId]);
    expect(listed.current).toBe(person.organizationId);

    const use = await cli(["org", "use", group.organizationId.toUpperCase()]);
    expect(use.code).toBe(0);
    expect(loadCredentials()?.organizationId).toBe(group.organizationId);
    expect(JSON.parse((await cli(["--json", "whoami"])).stdout)).toMatchObject({ organizationId: group.organizationId, organizationName: group.name });

    const other = await cli(["org", "use", "2d9a0cbe-3f4a-4b52-8c6d-7e8f9a0b1c2d"]);
    expect(other.code).toBe(2);
    expect(holdsAnyToken(list.stdout, use.stdout, other.stderr)).toBe(false);
  });
});

describe("X-Telflo-Org, for a person's token only", () => {
  /** The real fetch, recording each request's X-Telflo-Org. */
  function recordingFetch(calls: Array<Pick<RecordedCall, "url" | "headers">>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return fetch(input, init);
    }) as typeof fetch;
  }

  it("is sent on an organization's route for a person, and the API answers it", async () => {
    const person = await personWithToken(api.ownerDb);
    tokens.push(person.token);
    expect((await cli(["login", "--server", api.origin], { input: person.token })).code).toBe(0);
    const calls: Array<Pick<RecordedCall, "url" | "headers">> = [];
    const client = clientFor(requireLogin(), { fetch: recordingFetch(calls) });
    const page = await client.request<{ items: unknown[] }>("GET", "/configurations");
    expect(page.items).toEqual([]);
    await client.request("GET", "/whoami", { organization: false });
    expect(calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([person.organizationId, null]);
  });

  it("is never sent for a service account's token", async () => {
    const account = await serviceAccountWithToken(api.ownerDb);
    tokens.push(account.token);
    expect((await cli(["login", "--server", api.origin], { input: account.token })).code).toBe(0);
    const calls: Array<Pick<RecordedCall, "url" | "headers">> = [];
    const client = clientFor(requireLogin(), { fetch: recordingFetch(calls) });
    await client.request("GET", "/configurations");
    await client.request("GET", "/orgs", { organization: false });
    expect(calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([null, null]);
  });

  it("is learnt for TELFLO_TOKEN from /whoami: a person's sends TELFLO_ORG, and the API refuses without it", async () => {
    const person = await personWithToken(api.ownerDb);
    tokens.push(person.token);
    vi.stubEnv("TELFLO_TOKEN", person.token);
    vi.stubEnv("TELFLO_SERVER", api.origin);
    vi.stubEnv("TELFLO_ORG", person.organizationId);
    const calls: Array<Pick<RecordedCall, "url" | "headers">> = [];
    const client = clientFor(requireLogin(), { fetch: recordingFetch(calls) });
    await client.request("GET", "/configurations");
    expect(calls.map((call) => `${call.url.pathname} ${call.headers.get("x-telflo-org")}`)).toEqual([
      "/api/public/v1/whoami null",
      `/api/public/v1/configurations ${person.organizationId}`,
    ]);
    // Without the header, the API's own refusal: the reason the CLI sends it.
    const bare = new ApiClient({ server: api.origin, token: person.token });
    await expect(bare.request("GET", "/configurations")).rejects.toMatchObject({ status: 400, code: "organization_required" });
  });
});
