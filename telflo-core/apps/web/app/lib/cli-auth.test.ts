import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTokenNameSchema } from "@telflo/contracts";
import {
  cliTokenName,
  cliTokenNamePrefix,
  isCliAuthDocument,
  isCliAuthPath,
  namesCliAuth,
  parseCliAuthFragment,
  postToListener,
} from "./cli-auth.js";

/*
 * `/cli-auth`'s parts (D27 decisions 20-22; Preflight rulings 13, 14 and
 * 16): the fragment's checks, the token's name, the handoff's request, and
 * which addresses name the page.
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

describe("the token's name (decision 21, Preflight ruling 16)", () => {
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

describe("postToListener", () => {
  it("posts the answer as JSON to 127.0.0.1's /callback, without credentials or referrer, and answers the status", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect(await postToListener(54321, { state: STATE, error: "denied" })).toBe(204);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:54321/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: STATE, error: "denied" }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  });

  it("refuses as fetch does", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(postToListener(54321, { state: STATE, error: "denied" })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the addresses that name the page (Preflight rulings 13 and 14)", () => {
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
