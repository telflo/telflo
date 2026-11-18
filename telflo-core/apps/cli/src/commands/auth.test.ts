import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No browser is ever started: the opener is a stand-in (D27 decision 20).
vi.mock("../browser.js", () => ({ openBrowser: vi.fn(() => true) }));

import { envelope, routedFetch, type FakeFetch } from "../../tests/fake-fetch.js";
import { handOff, parametersOf } from "../../tests/listener-request.js";
import { fakeStdin, runCli } from "../../tests/run-cli.js";
import { openBrowser } from "../browser.js";
import { deleteCredentials, loadCredentials, saveCredentials } from "../credentials.js";
import { BROWSER_PASTE_PROMPT, BROWSER_WORDS } from "../login-browser.js";
import { NO_SERVER_MESSAGE, SERVER_NOT_HTTPS_MESSAGE } from "../server.js";
import {
  ENVIRONMENT_TOKEN_SHADOWS_MESSAGE,
  ENVIRONMENT_TOKEN_STILL_SET_MESSAGE,
  LOGGED_OUT_MESSAGE,
  NO_ORGANIZATION_MESSAGE,
  NOT_A_CHOICE_MESSAGE,
  NOT_A_TOKEN_MESSAGE,
  NOT_LOGGED_IN_LOGOUT_MESSAGE,
  NOT_ONE_OF_THEM_MESSAGE,
  PASTE_PROMPT,
  SERVER_PROMPT,
  SERVICE_ACCOUNT_WITH_ORG_MESSAGE,
  SEVERAL_ORGANIZATIONS_MESSAGE,
} from "./auth.js";

/*
 * login, whoami and logout (D27 decisions 8, 14, 15, 19 and 20) against a
 * stand-in API (and, for the browser flow, the real loopback listener).
 * Tokens are made at run time; what the CLI wrote is checked for them with
 * boolean canaries only.
 */

const SERVER = "https://telflo.example";
const PERSONAL = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const GROUP = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";
const OWN = "2d9a0cbe-3f4a-4b52-8c6d-7e8f9a0b1c2d";

const personalOrganization = { id: PERSONAL, name: "ada@example.com", type: "personal", role: "admin" };
const groupOrganization = { id: GROUP, name: "Acme", type: "group", role: "contributor" };

let token: string;
let fake: FakeFetch;

function api(options: { kind?: "person" | "service_account"; orgs?: unknown[]; whoamiStatus?: number } = {}): FakeFetch {
  const kind = options.kind ?? "person";
  fake = routedFetch({
    "GET /whoami": options.whoamiStatus
      ? { status: options.whoamiStatus, json: envelope("invalid_api_token", "Missing or invalid API token") }
      : { json: { kind, tokenName: "laptop", access: "write", organizationId: kind === "person" ? null : OWN } },
    "GET /orgs": {
      json: { items: options.orgs ?? (kind === "person" ? [personalOrganization] : [{ id: OWN, name: "Robots", type: "group", role: "admin" }]), nextCursor: null },
    },
  });
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

function holdsToken(...texts: string[]): boolean {
  return texts.some((text) => text.includes(token));
}

/**
 * runCli, then the token canary (a boolean) at once: every later assertion
 * on what the CLI wrote can't print a token when it fails (Ruling 237).
 */
async function cli(args: readonly string[], options?: Parameters<typeof runCli>[1]): ReturnType<typeof runCli> {
  const result = await runCli(args, options);
  expect(holdsToken(result.stdout, result.stderr)).toBe(false);
  return result;
}

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  vi.mocked(openBrowser).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("telflo login from stdin (decision 19)", () => {
  it("checks the token with /whoami, takes the one organization and writes the file", async () => {
    api();
    const result = await cli(["login", "--server", SERVER], { input: `${token}\n` });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Logged in to ${SERVER} as laptop (ada@example.com).\n`);
    expect(holdsToken(result.stdout, result.stderr)).toBe(false);
    const stored = loadCredentials();
    expect(stored === null ? false : stored.token === token).toBe(true);
    expect(stored?.server).toBe(SERVER);
    expect(stored?.kind).toBe("person");
    expect(stored?.organizationId).toBe(PERSONAL);
    expect(fake.calls.map((call) => `${call.method} ${call.url.pathname} ${call.headers.get("x-telflo-org")}`)).toEqual([
      "GET /api/public/v1/whoami null",
      "GET /api/public/v1/orgs null",
    ]);
  });

  it("prints JSON with --json, without the token", async () => {
    api();
    const result = await cli(["--json", "login", "--server", SERVER], { input: token });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      server: SERVER,
      kind: "person",
      tokenName: "laptop",
      access: "write",
      organizationId: PERSONAL,
      organizationName: "ada@example.com",
    });
    expect(holdsToken(result.stdout)).toBe(false);
  });

  it("warns once on stderr when TELFLO_TOKEN is set (it shadows the login just stored); JSON with --json (Ruling 249)", async () => {
    api();
    const shadow = `tf_${randomBytes(32).toString("base64url")}`;
    vi.stubEnv("TELFLO_TOKEN", shadow);
    const human = await cli(["login", "--server", SERVER], { input: token });
    expect(human.code).toBe(0);
    expect(human.stderr).toBe(`${ENVIRONMENT_TOKEN_SHADOWS_MESSAGE}\n`);
    const json = await cli(["--json", "login", "--server", SERVER], { input: token });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stderr)).toEqual({ note: ENVIRONMENT_TOKEN_SHADOWS_MESSAGE });
    expect(holdsToken(human.stdout, human.stderr, json.stdout, json.stderr) || [human, json].some((run) => `${run.stdout}${run.stderr}`.includes(shadow))).toBe(false);
    // Unset, or only spaces (which every command ignores): no warning.
    for (const value of ["", "  "]) {
      vi.stubEnv("TELFLO_TOKEN", value);
      expect((await cli(["login", "--server", SERVER], { input: token })).stderr).toBe("");
    }
    // A failed login stores nothing, so it warns of nothing.
    api({ whoamiStatus: 401 });
    vi.stubEnv("TELFLO_TOKEN", shadow);
    expect((await cli(["login", "--server", SERVER], { input: token })).stderr.includes(ENVIRONMENT_TOKEN_SHADOWS_MESSAGE)).toBe(false);
  });

  it("takes TELFLO_SERVER, then the stored server; with neither and no terminal, exit 2 naming --server and TELFLO_SERVER", async () => {
    api();
    vi.stubEnv("TELFLO_SERVER", "http://localhost:50080");
    expect((await cli(["login"], { input: token })).code).toBe(0);
    expect(fake.calls[0]?.url.origin).toBe("http://localhost:50080");
    vi.unstubAllEnvs();
    expect((await cli(["login"], { input: token })).code).toBe(0);
    expect(fake.calls[2]?.url.origin).toBe("http://localhost:50080");
    deleteCredentials();
    const none = await cli(["login"], { input: token });
    expect(none.code).toBe(2);
    expect(none.stderr).toBe(`error: ${NO_SERVER_MESSAGE}\n`);
    expect(fake.calls).toHaveLength(4);
    expect(loadCredentials()).toBeNull();
  });

  it("refuses a plain-http server before reading a token", async () => {
    api();
    const result = await cli(["login", "--server", "http://telflo.example"], { input: token });
    expect(result.code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["a short token", () => "tf_abc"],
    ["a token with a bad character", () => `${token.slice(0, -1)}!`],
    ["a token without its prefix", () => token.slice(3)],
    ["a token with a trailing word", () => `${token} extra`],
  ])("refuses %s (exit 2) without echoing it or calling the API", async (_label, text) => {
    api();
    const typed = text();
    const result = await cli(["login", "--server", SERVER], { input: typed });
    expect(result.stderr.includes(typed) || result.stdout.includes(typed)).toBe(false);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`error: ${NOT_A_TOKEN_MESSAGE}\n`);
    expect(fake.calls).toHaveLength(0);
    expect(loadCredentials()).toBeNull();
  });

  it("ends at a 401 (exit 3) with nothing stored", async () => {
    api({ whoamiStatus: 401 });
    const result = await cli(["login", "--server", SERVER], { input: token });
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("error: Missing or invalid API token. Run telflo login.\n");
    expect(loadCredentials()).toBeNull();
    expect(holdsToken(result.stderr)).toBe(false);
  });

  it("redacts a token typed as the server's host from the unreachable words (Ruling 237)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const host = token.toLowerCase();
    const result = await runCli(["login", "--server", `https://${host}.invalid`], { input: token });
    expect(result.stderr.includes(host) || result.stdout.includes(host)).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("error: Couldn't reach https://tf_….invalid.\n");
    const json = await runCli(["--json", "login", "--server", `https://${host}.invalid`], { input: token });
    expect(json.stderr.includes(host)).toBe(false);
    expect(JSON.parse(json.stderr)).toMatchObject({ error: { message: "Couldn't reach https://tf_….invalid." } });
  });

  it("strips control characters from a token's and an organization's names (Ruling 237)", async () => {
    fake = routedFetch({
      "GET /whoami": { json: { kind: "person", tokenName: "lap\u001b]0;pwned\u0007top", access: "write", organizationId: null } },
      "GET /orgs": { json: { items: [{ ...personalOrganization, name: "Ada\u001b[2J\u009b's" }], nextCursor: null } },
    });
    vi.stubGlobal("fetch", fake.fetch);
    const login = await cli(["login", "--server", SERVER], { input: token });
    expect(login.stdout).toBe(`Logged in to ${SERVER} as lap]0;pwnedtop (Ada[2J's).\n`);
    const whoami = await cli(["whoami"]);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(whoami.stdout)).toBe(false);
    expect(whoami.stdout.includes("Token:        lap]0;pwnedtop (personal token)")).toBe(true);
    expect(whoami.stdout.includes(`Organization: Ada[2J's (${PERSONAL})`)).toBe(true);
    // JSON keeps the names as they are (JSON escapes them).
    expect(JSON.parse((await cli(["--json", "whoami"])).stdout).tokenName).toBe("lap\u001b]0;pwned\u0007top");
  });

  it("strips them from a service account's organization id when /orgs doesn't name it (Ruling 242)", async () => {
    fake = routedFetch({
      "GET /whoami": { json: { kind: "service_account", tokenName: "robot", access: "read", organizationId: `${OWN}\u001b[2J` } },
      "GET /orgs": { json: { items: [], nextCursor: null } },
    });
    vi.stubGlobal("fetch", fake.fetch);
    saveCredentials({ version: 1, server: SERVER, token, kind: "service_account", tokenName: "robot", organizationId: OWN });
    const whoami = await cli(["whoami"]);
    expect(whoami.stdout.includes(`Organization: ${OWN}[2J\n`)).toBe(true);
    fake = routedFetch({
      "GET /whoami": { json: { kind: "service_account", tokenName: "robot", access: "read", organizationId: `${OWN}\u001b[2J` } },
      "GET /orgs": { json: { items: [{ id: `${OWN}\u001b[2J`, name: "Robots", type: "group", role: "admin" }], nextCursor: null } },
    });
    vi.stubGlobal("fetch", fake.fetch);
    expect((await cli(["whoami"])).stdout.includes(`Organization: Robots (${OWN}[2J)\n`)).toBe(true);
  });

  it("strips them from the numbered list of organizations at a terminal", async () => {
    api({ orgs: [{ ...personalOrganization, name: "A\u001b[31mda" }, groupOrganization] });
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${token}\r`);
    stdin.write("1\n");
    const result = await cli(["login", "--server", SERVER, "--no-browser"], { stdin });
    expect(result.stderr.includes("  1. A[31mda (personal, admin)")).toBe(true);
  });

  it("keeps the old file when a new login fails", async () => {
    api();
    expect((await cli(["login", "--server", SERVER], { input: token })).code).toBe(0);
    const first = token;
    token = `tf_${randomBytes(32).toString("base64url")}`;
    api({ whoamiStatus: 401 });
    expect((await cli(["login", "--server", SERVER], { input: token })).code).toBe(3);
    expect(loadCredentials()?.token === first).toBe(true);
  });
});

describe("the organization (decision 15)", () => {
  it("takes a service account's own, named from /orgs", async () => {
    api({ kind: "service_account" });
    const result = await cli(["login", "--server", SERVER], { input: token });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Logged in to ${SERVER} as laptop (Robots).\n`);
    expect(loadCredentials()?.organizationId).toBe(OWN);
    expect(loadCredentials()?.kind).toBe("service_account");
  });

  it("names a service account's organization by its id when /orgs doesn't list it", async () => {
    api({ kind: "service_account", orgs: [] });
    expect((await cli(["login", "--server", SERVER], { input: token })).stdout).toBe(`Logged in to ${SERVER} as laptop (${OWN}).\n`);
  });

  it("refuses --org and TELFLO_ORG for a service account's token", async () => {
    api({ kind: "service_account" });
    const flag = await cli(["login", "--server", SERVER, "--org", OWN], { input: token });
    expect(flag.code).toBe(2);
    expect(flag.stderr).toBe(`error: ${SERVICE_ACCOUNT_WITH_ORG_MESSAGE}\n`);
    vi.stubEnv("TELFLO_ORG", OWN);
    expect((await cli(["login", "--server", SERVER], { input: token })).code).toBe(2);
    expect(loadCredentials()).toBeNull();
  });

  it("takes --org among a person's, canonicalized", async () => {
    api({ orgs: [personalOrganization, groupOrganization] });
    const result = await cli(["login", "--server", SERVER, "--org", GROUP.toUpperCase()], { input: token });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Logged in to ${SERVER} as laptop (Acme).\n`);
    expect(loadCredentials()?.organizationId).toBe(GROUP);
  });

  it("takes TELFLO_ORG when --org is left out", async () => {
    api({ orgs: [personalOrganization, groupOrganization] });
    vi.stubEnv("TELFLO_ORG", GROUP);
    expect((await cli(["login", "--server", SERVER], { input: token })).code).toBe(0);
    expect(loadCredentials()?.organizationId).toBe(GROUP);
  });

  it("refuses an --org the token can't act in, and a malformed one before reading the token", async () => {
    api();
    const other = await cli(["login", "--server", SERVER, "--org", GROUP], { input: token });
    expect(other.code).toBe(2);
    expect(other.stderr).toBe(`error: ${NOT_ONE_OF_THEM_MESSAGE}\n`);
    const malformed = await cli(["login", "--server", SERVER, "--org", "acme"], { input: token });
    expect(malformed.code).toBe(2);
    expect(fake.calls).toHaveLength(2);
    expect(loadCredentials()).toBeNull();
  });

  it("fails naming --org for several organizations without a terminal", async () => {
    api({ orgs: [personalOrganization, groupOrganization] });
    const result = await cli(["login", "--server", SERVER], { input: token });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`error: ${SEVERAL_ORGANIZATIONS_MESSAGE}\n`);
    expect(loadCredentials()).toBeNull();
  });

  it("refuses a token with no organization (exit 3)", async () => {
    api({ orgs: [] });
    const result = await cli(["login", "--server", SERVER], { input: token });
    expect(result.code).toBe(3);
    expect(result.stderr).toBe(`error: ${NO_ORGANIZATION_MESSAGE}\n`);
  });
});

describe("telflo login at a terminal (decision 19)", () => {
  it("asks for the server's URL when none is set (no default server), then for the token", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${SERVER}/\n`);
    stdin.write(`${token}\r`);
    const result = await cli(["login", "--no-browser"], { stdin });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`${SERVER_PROMPT}\n${PASTE_PROMPT(SERVER)}\n`);
    expect(fake.calls.every((call) => call.url.origin === SERVER)).toBe(true);
    expect(loadCredentials()?.server).toBe(SERVER);
  });

  it("refuses a typed server the origin rules refuse (exit 2), before reading a token", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    stdin.write("http://telflo.example\n");
    stdin.write(`${token}\r`);
    const result = await cli(["login", "--no-browser"], { stdin });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`${SERVER_PROMPT}\nerror: ${SERVER_NOT_HTTPS_MESSAGE}\n`);
    expect(fake.calls).toHaveLength(0);
    expect(stdin.rawModes).toEqual([]);
  });

  it("doesn't ask for the server when the stored login names one", async () => {
    api();
    saveCredentials({ version: 1, server: SERVER, token, kind: "person", tokenName: "laptop", organizationId: PERSONAL });
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${token}\r`);
    const result = await cli(["login", "--no-browser"], { stdin });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`${PASTE_PROMPT(SERVER)}\n`);
  });

  it("--no-browser asks for the token at the hidden prompt", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${token}\r`);
    const result = await cli(["login", "--server", SERVER, "--no-browser"], { stdin });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`${PASTE_PROMPT(SERVER)}\n`);
    expect(PASTE_PROMPT(SERVER)).toBe(`Create a token at ${SERVER}/settings/account, then paste it: `);
    expect(holdsToken(result.stdout, result.stderr)).toBe(false);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("without --no-browser opens the browser on /cli-auth and takes the page's handoff (decision 20)", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    const running = cli(["login", "--server", SERVER], { stdin });
    await vi.waitFor(() => expect(vi.mocked(openBrowser)).toHaveBeenCalledOnce());
    const url = vi.mocked(openBrowser).mock.calls[0]?.[0] ?? "";
    expect(url.startsWith(`${SERVER}/cli-auth#state=`)).toBe(true);
    const { state, port } = parametersOf(url);
    expect((await handOff(port, SERVER, { state, token })).status).toBe(204);
    const result = await running;
    expect(holdsToken(result.stdout, result.stderr)).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Logged in to ${SERVER} as laptop (ada@example.com).\n`);
    expect(result.stderr).toBe(`${BROWSER_WORDS(url)}\n${BROWSER_PASTE_PROMPT}\n`);
    expect(loadCredentials()?.token === token).toBe(true);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("without --no-browser an empty Enter is ignored: the prompt keeps waiting, the page's handoff still logs in (Ruling 249)", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    const running = cli(["login", "--server", SERVER], { stdin });
    await vi.waitFor(() => expect(vi.mocked(openBrowser)).toHaveBeenCalledOnce());
    stdin.write("\r");
    stdin.write("  \n\r");
    const url = vi.mocked(openBrowser).mock.calls[0]?.[0] ?? "";
    const { state, port } = parametersOf(url);
    expect((await handOff(port, SERVER, { state, token })).status).toBe(204);
    const result = await running;
    expect(result.code).toBe(0);
    expect(loadCredentials()?.token === token).toBe(true);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("--no-browser's empty Enter still ends the login (exit 2), nothing sent", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    stdin.write("\r");
    const result = await cli(["login", "--server", SERVER, "--no-browser"], { stdin });
    expect(result.code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("without --no-browser still takes a token pasted at the prompt beside the browser", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${token}\r`);
    expect((await cli(["login", "--server", SERVER], { stdin })).code).toBe(0);
    expect(vi.mocked(openBrowser)).toHaveBeenCalledOnce();
    expect(loadCredentials()?.token === token).toBe(true);
  });

  it("--no-browser never opens the browser", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${token}\r`);
    expect((await cli(["login", "--server", SERVER, "--no-browser"], { stdin })).code).toBe(0);
    expect(vi.mocked(openBrowser)).not.toHaveBeenCalled();
  });

  it("lists several organizations, numbered, and takes the number typed", async () => {
    api({ orgs: [personalOrganization, groupOrganization] });
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${token}\r`);
    stdin.write("7\n");
    stdin.write("2\n");
    const result = await cli(["login", "--server", SERVER, "--no-browser"], { stdin });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      [
        PASTE_PROMPT(SERVER),
        "This token can act in several organizations:",
        "  1. ada@example.com (personal, admin)",
        "  2. Acme (group, contributor)",
        "Organization number:",
        NOT_A_CHOICE_MESSAGE,
        "Organization number:",
        "",
      ].join("\n"),
    );
    expect(loadCredentials()?.organizationId).toBe(GROUP);
  });

  it("gives up after three answers that aren't a number listed", async () => {
    api({ orgs: [personalOrganization, groupOrganization] });
    const stdin = fakeStdin({ tty: true });
    stdin.write(`${token}\r`);
    for (const answer of ["0\n", "x\n", "3\n"]) stdin.write(answer);
    const result = await cli(["login", "--server", SERVER, "--no-browser"], { stdin });
    expect(result.code).toBe(2);
    expect(result.stderr.endsWith(`error: ${NOT_A_CHOICE_MESSAGE}\n`)).toBe(true);
    expect(loadCredentials()).toBeNull();
  });

  it("stops at Ctrl-C with the terminal restored and nothing stored", async () => {
    api();
    const stdin = fakeStdin({ tty: true });
    stdin.write("tf_part\u0003");
    const result = await cli(["login", "--server", SERVER, "--no-browser"], { stdin });
    expect(result.code).toBe(3);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("telflo whoami", () => {
  function store(kind: "person" | "service_account"): void {
    saveCredentials({ version: 1, server: SERVER, token, kind, tokenName: "laptop", organizationId: kind === "person" ? PERSONAL : OWN });
  }

  it("names the server, the token by its name, the access and the organization: never the token", async () => {
    api();
    store("person");
    const result = await cli(["whoami"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [`Server:       ${SERVER}`, "Token:        laptop (personal token)", "Access:       write", `Organization: ada@example.com (${PERSONAL})`, ""].join("\n"),
    );
    expect(holdsToken(result.stdout, result.stderr)).toBe(false);
    expect(holdsToken(...fake.calls.map((call) => call.url.href))).toBe(false);
  });

  it("prints JSON with --json, for a service account", async () => {
    api({ kind: "service_account" });
    store("service_account");
    const result = await cli(["--json", "whoami"]);
    expect(JSON.parse(result.stdout)).toEqual({
      server: SERVER,
      source: "file",
      kind: "service_account",
      tokenName: "laptop",
      access: "write",
      organizationId: OWN,
      organizationName: "Robots",
    });
  });

  it("names the organization by its id when /orgs no longer lists it", async () => {
    api({ orgs: [] });
    store("person");
    expect((await cli(["whoami"])).stdout.includes(`Organization: ${PERSONAL}\n`)).toBe(true);
  });

  it("says where TELFLO_TOKEN's organization is missing", async () => {
    api();
    vi.stubEnv("TELFLO_TOKEN", token);
    vi.stubEnv("TELFLO_SERVER", SERVER);
    const result = await cli(["whoami"]);
    expect(result.code).toBe(0);
    expect(result.stdout.includes("Token:        laptop (personal token, from TELFLO_TOKEN)")).toBe(true);
    expect(result.stdout.includes("Organization: (none: set TELFLO_ORG)")).toBe(true);
  });

  it("exits 3 when not logged in, and for a 401", async () => {
    api({ whoamiStatus: 401 });
    expect((await cli(["whoami"])).code).toBe(3);
    store("person");
    const refused = await cli(["whoami"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr.includes("Run telflo login.")).toBe(true);
  });
});

describe("telflo logout (decision 14)", () => {
  it("removes the file and says a token is revoked on the web", async () => {
    saveCredentials({ version: 1, server: SERVER, token, kind: "person", tokenName: "laptop", organizationId: PERSONAL });
    const result = await cli(["logout"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${LOGGED_OUT_MESSAGE}\n`);
    expect(loadCredentials()).toBeNull();
  });

  it("says when there was nothing to remove, and that TELFLO_TOKEN is still set", async () => {
    vi.stubEnv("TELFLO_TOKEN", token);
    const result = await cli(["logout"]);
    expect(result.stdout).toBe(`${NOT_LOGGED_IN_LOGOUT_MESSAGE}\n${ENVIRONMENT_TOKEN_STILL_SET_MESSAGE}\n`);
    expect(JSON.parse((await cli(["--json", "logout"])).stdout)).toEqual({ removed: false });
  });
});
