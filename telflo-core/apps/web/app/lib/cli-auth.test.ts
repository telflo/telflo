import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTokenNameSchema } from "@telflo/contracts";
import {
  cliTokenName,
  cliTokenNamePrefix,
  isCliAuthDocument,
  isCliAuthPath,
  namesCliAuth,
  listenerKnowsState,
  listenerProof,
  ListenerUnprovenError,
  parseCliAuthFragment,
  postToListener,
  PROOF_CONTEXT,
} from "./cli-auth.js";

/*
 * `/cli-auth`'s parts: the fragment's checks, the token's name, the
 * handoff's request, and which addresses name the page.
 */

const STATE = `${"A".repeat(20)}-_${"b".repeat(21)}`;
const GOOD = `#state=${STATE}&port=54321&host=ada-laptop.local`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseCliAuthFragment", () => {
  it("reads the state, the port and the host, with its # or without", () => {
    expect(parseCliAuthFragment(GOOD)).toEqual({ state: STATE, port: 54321, host: "ada-laptop.local" });
    expect(parseCliAuthFragment(GOOD.slice(1))).toEqual({ state: STATE, port: 54321, host: "ada-laptop.local" });
    expect(parseCliAuthFragment(`#host=unknown-host&port=1024&state=${STATE}`)).toEqual({ state: STATE, port: 1024, host: "unknown-host" });
    expect(parseCliAuthFragment(`#state=${STATE}&port=65535&host=${"h".repeat(32)}`)?.port).toBe(65535);
  });

  it.each([
    ["nothing", ""],
    ["a bare #", "#"],
    ["no state", "#port=54321&host=box"],
    ["no port", `#state=${STATE}&host=box`],
    ["no host", `#state=${STATE}&port=54321`],
    ["a state too short", `#state=${STATE.slice(1)}&port=54321&host=box`],
    ["a state too long", `#state=${STATE}A&port=54321&host=box`],
    ["a state with another character", `#state=${STATE.slice(1)}.&port=54321&host=box`],
    ["a port below 1024", `#state=${STATE}&port=1023&host=box`],
    ["a port above 65535", `#state=${STATE}&port=65536&host=box`],
    ["a port with a leading zero", `#state=${STATE}&port=08080&host=box`],
    ["a port that isn't a number", `#state=${STATE}&port=80a0&host=box`],
    ["an empty host", `#state=${STATE}&port=54321&host=`],
    ["a host over 32 characters", `#state=${STATE}&port=54321&host=${"h".repeat(33)}`],
    ["a host with a space", `#state=${STATE}&port=54321&host=ada%20laptop`],
    ["a host with markup", `#state=${STATE}&port=54321&host=%3Cb%3E`],
    ["a second state", `#state=${STATE}&state=${STATE}&port=54321&host=box`],
    ["another parameter", `${GOOD}&token=x`],
  ])("refuses %s", (_kind, hash) => {
    expect(parseCliAuthFragment(hash)).toBeNull();
  });
});

describe("the token's name", () => {
  it("is CLI — <host> · <UTC time>, and its prefix is exactly the part before the time", () => {
    const at = new Date("2026-10-26T07:08:09.123Z");
    expect(cliTokenName("ada-laptop", at)).toBe("CLI — ada-laptop · 2026-10-26 07:08:09");
    expect(cliTokenNamePrefix("ada-laptop")).toBe("CLI — ada-laptop · ");
    expect(cliTokenName("ada-laptop", at).startsWith(cliTokenNamePrefix("ada-laptop"))).toBe(true);
    expect(cliTokenName("ada-laptop-2", at).startsWith(cliTokenNamePrefix("ada-laptop"))).toBe(false);
  });

  it("fits the API's name rule at the longest host: 60 characters", () => {
    const name = cliTokenName("h".repeat(32), new Date("2026-10-26T23:59:59.999Z"));
    expect(name.length).toBe(60);
    expect(ApiTokenNameSchema.safeParse(name).success).toBe(true);
  });
});

/** The CLI's listener's proof (apps/cli/src/login-listener.ts), made with node's crypto. */
const cliProof = (state: string, challenge: string): string =>
  createHmac("sha256", state).update(PROOF_CONTEXT + challenge, "utf8").digest("base64url");

/** A fetch answering as the CLI's listener does: a challenge's proof, then 204 to the answer. */
function cliListener(state: string = STATE) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if ("challenge" in body) return new Response(JSON.stringify({ proof: cliProof(state, String(body.challenge)) }), { status: 200 });
    return new Response(null, { status: 204 });
  });
}

describe("listenerProof", () => {
  it("is the CLI's: HMAC-SHA256 of the context and the challenge, keyed by the state, base64url", async () => {
    const challenge = "c".repeat(43);
    expect(await listenerProof(STATE, challenge)).toBe(cliProof(STATE, challenge));
  });
});

describe("postToListener", () => {
  it("first sends a fresh challenge, never the state; then, the proof checked, posts the answer, without credentials or referrer", async () => {
    const fetch = cliListener();
    vi.stubGlobal("fetch", fetch);
    expect(await postToListener(54321, { state: STATE, error: "denied" })).toBe(204);
    const options = { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" };
    expect(fetch).toHaveBeenCalledTimes(2);
    const [[firstUrl, first], [secondUrl, second]] = fetch.mock.calls as unknown as [[string, RequestInit], [string, RequestInit]];
    expect(firstUrl).toBe("http://127.0.0.1:54321/callback");
    const { body: challengeBody, ...challengeOptions } = first;
    expect(challengeOptions).toEqual(options);
    const { challenge } = JSON.parse(String(challengeBody)) as { challenge: string };
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(challengeBody).includes(STATE)).toBe(false);
    expect([secondUrl, second]).toEqual(["http://127.0.0.1:54321/callback", { ...options, body: JSON.stringify({ state: STATE, error: "denied" }) }]);
  });

  it("sends a new challenge each time", async () => {
    const fetch = cliListener();
    vi.stubGlobal("fetch", fetch);
    await postToListener(54321, { state: STATE, error: "denied" });
    await postToListener(54321, { state: STATE, error: "denied" });
    const challenges = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)
      .map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>)
      .filter((body) => "challenge" in body)
      .map((body) => body.challenge);
    expect(new Set(challenges).size).toBe(2);
  });

  it.each([
    ["a listener keyed by another state", () => cliListener(`${"B".repeat(20)}-_${"c".repeat(21)}`)],
    ["a 204 to the challenge (a CLI from before it)", () => vi.fn(async () => new Response(null, { status: 204 }))],
    ["a 403 to the challenge", () => vi.fn(async () => new Response(null, { status: 403 }))],
    ["a body that isn't JSON", () => vi.fn(async () => new Response("proof", { status: 200 }))],
    ["no proof in the body", () => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))],
  ])("refuses with ListenerUnprovenError for %s, sending only the challenge", async (_case, make) => {
    const fetch = make();
    vi.stubGlobal("fetch", fetch);
    await expect(postToListener(54321, { state: STATE, token: "tf_x" })).rejects.toBeInstanceOf(ListenerUnprovenError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await listenerKnowsState(54321, STATE)).toBe(false);
  });

  it("refuses as fetch does", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(postToListener(54321, { state: STATE, error: "denied" })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the handoff to a listener that took the port (it never saw the state)", () => {
  const TOKEN = `tf_${"t".repeat(43)}`;

  it("never sends the token, nor Cancel's answer, to a listener that can't prove the state", async () => {
    // An impostor on the CLI's port: every request answered as the CLI's listener would accept one.
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ proof: "A".repeat(43) }), { status: 200 });
      }),
    );
    await expect(postToListener(54321, { state: STATE, token: TOKEN })).rejects.toThrow();
    await expect(postToListener(54321, { state: STATE, error: "denied" })).rejects.toThrow();
    expect(bodies.some((body) => body.includes(TOKEN) || body.includes(STATE))).toBe(false);
  });
});

describe("the addresses that name the page", () => {
  it.each(["/cli-auth", "/cli-auth/", "/CLI-Auth", "/cli%2Dauth", "/cli-auth//"])("%s is the page's path", (path) => {
    expect(isCliAuthPath(path)).toBe(true);
  });

  it.each(["/cli-authx", "/cli-auth/x", "/app/cli-auth", "/cli", "/", "/cli%2"])("%s isn't", (path) => {
    expect(isCliAuthPath(path)).toBe(false);
  });

  it.each([
    ["as spelt", "/cli-auth"],
    ["with a query", "/cli-auth?x=1"],
    ["with a fragment", "/cli-auth#state=x"],
    ["encoded once", "%2Fcli-auth"],
    ["encoded twice", "%252Fcli-auth"],
    ["in capitals, a trailing slash", "%2FCLI-AUTH%2F"],
  ])("a redirectTo naming it %s counts", (_kind, value) => {
    expect(namesCliAuth(value)).toBe(true);
  });

  it.each(["/app", "%2Fapp", "/cli-authx", "%2Fcli-authx", "/app?next=/cli-auth", "%252Fcli-authx", "%E0%A4%A"])("a redirectTo of %s doesn't", (value) => {
    expect(namesCliAuth(value)).toBe(false);
  });

  it.each([
    "https://telflo.example/cli-auth",
    "https://telflo.example/cli-auth#state=x&port=54321&host=box",
    "https://telflo.example/CLI-AUTH/",
    "https://telflo.example/login?redirectTo=%2Fcli-auth",
    "https://telflo.example/login?redirectTo=%2Fcli-auth#state=x",
    "https://telflo.example/login/?error=oauth_failed&redirectTo=%252Fcli-auth",
    "https://telflo.example/Login?REDIRECTTO=/cli-auth",
    "https://telflo.example/login?redirect%54o=%2Fcli-auth",
  ])("%s is the page's document", (href) => {
    expect(isCliAuthDocument(href)).toBe(true);
  });

  it.each([
    "https://telflo.example/cli-authx",
    "https://telflo.example/login",
    "https://telflo.example/login?redirectTo=%2Fapp",
    "https://telflo.example/login?redirectTo",
    "https://telflo.example/login?next=%2Fcli-auth",
    "https://telflo.example/register?redirectTo=%2Fcli-auth",
    "https://telflo.example/pricing?host=box",
    "not a url",
  ])("%s isn't", (href) => {
    expect(isCliAuthDocument(href)).toBe(false);
  });
});
