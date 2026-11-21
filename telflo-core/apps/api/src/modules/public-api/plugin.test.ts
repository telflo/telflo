import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { registerErrorHandling, respondToFrameworkError } from "../../errors.js";
import { createApiTokenFailureLimiter, createPerKeyLimiter, RATE_LIMITS, TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import type { LiveApiToken } from "../service-accounts/repositories/api-token-repository.js";
import { apiTokenHash } from "../service-accounts/tokens.js";
import {
  createApiTokenOrganizationCheck,
  createAuthenticateApiToken,
  decorateApiTokenAuthentication,
  requireAcceptedApiToken,
  requireApiTokenAuthentication,
  type ApiTokenStore,
} from "./authenticate-api-token.js";
import { createPublicApiPlugin, PUBLIC_API_PREFIX, type RecordedPublicRoute } from "./plugin.js";

/*
 * The public plugin's hooks, on a bare Fastify with the API's error
 * handling and the production token check over a store this file
 * controls: the access declaration refused at registration, the token
 * check before any body is read, the 404 only after it, HEAD, the access
 * check, and the per-token limit. Tokens are built at run time and every
 * assertion about a reply compares statuses, fixed bodies or booleans, so
 * a failure prints none.
 */

const newToken = () => `tf_${randomBytes(32).toString("base64url")}`;

const ORGANIZATION_ID = "0192a6b0-0000-7000-8000-0000000000b2";

/** A service account's live token as the lookup answers it, with `access`. */
function liveToken(tokenId: string, access: "read" | "write"): LiveApiToken {
  return {
    kind: "service_account",
    tokenId,
    userId: "0192a6b0-0000-7000-8000-0000000000b3",
    email: "bot-0192a6b0@service-accounts.telflo.invalid",
    access,
    organizationId: ORGANIZATION_ID,
    role: "contributor",
  };
}

const PERSON_ID = "0192a6b0-0000-7000-8000-0000000000d3";
/** The person's one organization (a contributor there); ORGANIZATION_ID is not theirs. */
const PERSON_ORGANIZATION_ID = "0192a6b0-0000-7000-8000-0000000000d2";

/** A person's own live token as the lookup answers it: no organization, no role. */
function personalToken(tokenId: string, access: "read" | "write"): LiveApiToken {
  return { kind: "person", tokenId, userId: PERSON_ID, email: "person-0192a6b0@example.com", access, organizationId: null, role: null };
}

const ORGANIZATION_REQUIRED = JSON.stringify({
  error: { code: "organization_required", message: "Send the organization's id in X-Telflo-Org." },
});
const ACCESS_DENIED = JSON.stringify({
  error: { code: "organization_access_denied", message: "You are not an active member of this organization" },
});

const REFUSAL = JSON.stringify({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });
const INSUFFICIENT = JSON.stringify({ error: { code: "insufficient_access", message: "This token can't make changes." } });

interface Harness {
  server: FastifyInstance;
  readToken: string;
  writeToken: string;
  otherReadToken: string;
  /** A person's own read and write tokens. */
  personalReadToken: string;
  personalWriteToken: string;
  recorded: RecordedPublicRoute[];
  /** Moves the per-token limiter's clock. */
  advance: (ms: number) => void;
}

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface HarnessOptions {
  /** Registers one more route into the plugin, after the ones here. */
  extraRoute?: (api: FastifyInstance) => void;
  /** The per-token limit; the production one by default. */
  perToken?: { max: number; windowMs: number };
}

async function harness({ extraRoute, perToken = RATE_LIMITS.publicApiPerToken }: HarnessOptions = {}): Promise<Harness> {
  const readToken = newToken();
  const writeToken = newToken();
  const otherReadToken = newToken();
  const personalReadToken = newToken();
  const personalWriteToken = newToken();
  const tokens = new Map<string, LiveApiToken>([
    [apiTokenHash(readToken), liveToken("0192a6b0-0000-7000-8000-0000000000c1", "read")],
    [apiTokenHash(writeToken), liveToken("0192a6b0-0000-7000-8000-0000000000c2", "write")],
    [apiTokenHash(otherReadToken), liveToken("0192a6b0-0000-7000-8000-0000000000c3", "read")],
    [apiTokenHash(personalReadToken), personalToken("0192a6b0-0000-7000-8000-0000000000c4", "read")],
    [apiTokenHash(personalWriteToken), personalToken("0192a6b0-0000-7000-8000-0000000000c5", "write")],
  ]);
  const store: ApiTokenStore = {
    findLive: async (tokenHash) => tokens.get(tokenHash),
    touchLastUsed: async () => undefined,
    findRole: async (userId, organizationId) =>
      userId === PERSON_ID && organizationId === PERSON_ORGANIZATION_ID ? "contributor" : undefined,
  };
  let clock = Date.parse("2026-10-24T12:00:00Z");
  const recorded: RecordedPublicRoute[] = [];
  const server = Fastify({ logger: false, bodyLimit: 1_048_576, frameworkErrors: respondToFrameworkError });
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(server);
  decorateApiTokenAuthentication(server);
  void server.register(
    createPublicApiPlugin({
      check: createAuthenticateApiToken({
        store,
        failures: createApiTokenFailureLimiter(TEST_RATE_LIMITS.apiTokenFailuresPerIp),
        now: () => new Date(clock),
      }),
      organization: createApiTokenOrganizationCheck({ store }),
      perToken: createPerKeyLimiter(perToken, { now: () => clock }),
      record: (route) => void recorded.push(route),
      routes: (api) => {
        const typed = api.withTypeProvider<ZodTypeProvider>();
        typed.get("/things", { config: { access: "read" } }, async (request) => ({
          tokenId: requireApiTokenAuthentication(request).tokenId,
          organizationId: requireApiTokenAuthentication(request).context.organizationId,
        }));
        typed.get("/me", { config: { access: "read", organization: "optional" } }, async (request) => ({
          kind: requireAcceptedApiToken(request).kind,
          organizationId: request.apiTokenAuthentication?.context.organizationId ?? null,
        }));
        typed.post(
          "/things",
          { config: { access: "write" }, schema: { body: z.object({ name: z.string() }).strict() } },
          async () => ({ created: true }),
        );
        extraRoute?.(api);
      },
    }),
    { prefix: PUBLIC_API_PREFIX },
  );
  await server.ready();
  servers.push(server);
  return {
    server,
    readToken,
    writeToken,
    otherReadToken,
    personalReadToken,
    personalWriteToken,
    recorded,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("the public plugin's routes declare their access", () => {
  it("refuses at registration a route without config.access: ready() rejects, naming the route", async () => {
    await expect(harness({ extraRoute: (api) => api.get("/unguarded", async () => ({})) })).rejects.toThrow(
      'a public route must declare config.access "read" or "write": GET /api/public/v1/unguarded',
    );
  });

  it("refuses an access other than read or write, and an organization other than optional", async () => {
    await expect(
      harness({ extraRoute: (api) => api.get("/odd", { config: { access: "admin" as never } }, async () => ({})) }),
    ).rejects.toThrow("config.access");
    await expect(
      harness({ extraRoute: (api) => api.get("/odd", { config: { access: "read", organization: "required" as never } }, async () => ({})) }),
    ).rejects.toThrow("config.organization");
  });

  it("records every route with its access, HEAD's included, under the prefix", async () => {
    const { recorded } = await harness();
    expect(recorded).toEqual([
      { method: "GET", url: "/api/public/v1/things", access: "read" },
      { method: "HEAD", url: "/api/public/v1/things", access: "read" },
      { method: "GET", url: "/api/public/v1/me", access: "read" },
      { method: "HEAD", url: "/api/public/v1/me", access: "read" },
      { method: "POST", url: "/api/public/v1/things", access: "write" },
    ]);
  });
});

describe("the token check runs onRequest, before any body is read", () => {
  it("no token with a malformed body, or a 2 MB one, answers the one 401; with a token, the body's own 400 and 413", async () => {
    const { server, writeToken } = await harness();
    const json = { "content-type": "application/json" };
    const malformed = await server.inject({ method: "POST", url: "/api/public/v1/things", headers: json, payload: "{not json" });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.body === REFUSAL).toBe(true);
    const large = await server.inject({ method: "POST", url: "/api/public/v1/things", headers: json, payload: "x".repeat(2_000_000) });
    expect(large.statusCode).toBe(401);
    expect(large.body === REFUSAL).toBe(true);
    const invalid = await server.inject({ method: "POST", url: "/api/public/v1/things", headers: { ...json, ...bearer(writeToken) }, payload: "{not json" });
    expect(invalid.statusCode).toBe(400);
    const tooLarge = await server.inject({
      method: "POST",
      url: "/api/public/v1/things",
      headers: { ...json, ...bearer(writeToken) },
      payload: "x".repeat(2_000_000),
    });
    expect(tooLarge.statusCode).toBe(413);
  });

  it("an unknown public path or method answers the 401 without a token, and the root's 404 words after the check", async () => {
    const { server, readToken } = await harness();
    for (const [method, url] of [
      ["GET", "/api/public/v1/nope"],
      ["DELETE", "/api/public/v1/things"],
      ["GET", "/api/public/v1/"],
    ] as const) {
      const anonymous = await server.inject({ method, url });
      expect([method, url, anonymous.statusCode, anonymous.body === REFUSAL]).toEqual([method, url, 401, true]);
      const known = await server.inject({ method, url, headers: bearer(readToken) });
      expect([method, url, known.statusCode]).toEqual([method, url, 404]);
      // The fixed unmatched URL: no spelling of a public path is echoed.
      expect(known.json()).toEqual({ error: { code: "not_found", message: `No route for ${method} /api/public/v1/[unmatched]` } });
    }
  });

  it("a HEAD answers the 401 without a token, and 200 with one", async () => {
    const { server, readToken } = await harness();
    const anonymous = await server.inject({ method: "HEAD", url: "/api/public/v1/things" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toBe("Bearer");
    expect((await server.inject({ method: "HEAD", url: "/api/public/v1/things", headers: bearer(readToken) })).statusCode).toBe(200);
  });
});

describe("the access check", () => {
  it("a read token on a write route answers 403 insufficient_access before its body is read; a write token passes; both read", async () => {
    const { server, readToken, writeToken } = await harness();
    const post = (token: string, payload: string) =>
      server.inject({ method: "POST", url: "/api/public/v1/things", headers: { "content-type": "application/json", ...bearer(token) }, payload });
    const refused = await post(readToken, JSON.stringify({ name: "x" }));
    expect(refused.statusCode).toBe(403);
    expect(refused.body === INSUFFICIENT).toBe(true);
    expect(refused.headers["www-authenticate"]).toBeUndefined();
    // Refused before parsing: a malformed body changes nothing.
    expect((await post(readToken, "{not json")).statusCode).toBe(403);
    expect((await post(writeToken, JSON.stringify({ name: "x" }))).statusCode).toBe(200);
    for (const token of [readToken, writeToken]) {
      expect((await server.inject({ method: "GET", url: "/api/public/v1/things", headers: bearer(token) })).statusCode).toBe(200);
    }
  });
});

describe("the per-token limit", () => {
  it("60 requests a minute per token: the 61st answers 429 rate_limited with Retry-After, another token is unaffected, and the window resets", async () => {
    const { server, readToken, otherReadToken, advance } = await harness();
    const get = (token: string) => server.inject({ method: "GET", url: "/api/public/v1/things", headers: bearer(token) });
    for (let request = 0; request < 60; request += 1) {
      expect((await get(readToken)).statusCode).toBe(200);
    }
    advance(15_000);
    const limited = await get(readToken);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } });
    expect(limited.headers["retry-after"]).toBe("45");
    expect((await get(otherReadToken)).statusCode).toBe(200);
    advance(45_000);
    expect((await get(readToken)).statusCode).toBe(200);
  });

  it("a 404 after the check counts; a refused token counts nothing", async () => {
    const { server, readToken } = await harness({ perToken: { max: 2, windowMs: 60_000 } });
    const unknown = newToken();
    for (let request = 0; request < 5; request += 1) {
      expect((await server.inject({ method: "GET", url: "/api/public/v1/things", headers: bearer(unknown) })).statusCode).toBe(401);
    }
    expect((await server.inject({ method: "GET", url: "/api/public/v1/nope", headers: bearer(readToken) })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/public/v1/things", headers: bearer(readToken) })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/public/v1/things", headers: bearer(readToken) })).statusCode).toBe(429);
  });
});

describe("a personal token's organization", () => {
  const withOrganization = (token: string, organizationId?: string) => ({
    ...bearer(token),
    ...(organizationId === undefined ? {} : { "x-telflo-org": organizationId }),
  });

  it("a route without organization: optional needs X-Telflo-Org: none or a malformed one is 400, another organization 403, the person's own the context", async () => {
    const { server, personalReadToken } = await harness();
    const get = (organizationId?: string) =>
      server.inject({ method: "GET", url: "/api/public/v1/things", headers: withOrganization(personalReadToken, organizationId) });
    for (const organizationId of [undefined, "acme"]) {
      const refused = await get(organizationId);
      expect(refused.statusCode).toBe(400);
      expect(refused.body === ORGANIZATION_REQUIRED).toBe(true);
    }
    const denied = await get(ORGANIZATION_ID);
    expect(denied.statusCode).toBe(403);
    expect(denied.body === ACCESS_DENIED).toBe(true);
    const accepted = await get(PERSON_ORGANIZATION_ID);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ tokenId: "0192a6b0-0000-7000-8000-0000000000c4", organizationId: PERSON_ORGANIZATION_ID });
  });

  it("an optional route answers with no header and checks one that is sent; a service account's token ignores it", async () => {
    const { server, personalReadToken, readToken } = await harness();
    const me = (token: string, organizationId?: string) =>
      server.inject({ method: "GET", url: "/api/public/v1/me", headers: withOrganization(token, organizationId) });
    expect((await me(personalReadToken)).json()).toEqual({ kind: "person", organizationId: null });
    expect((await me(personalReadToken, PERSON_ORGANIZATION_ID)).json()).toEqual({ kind: "person", organizationId: PERSON_ORGANIZATION_ID });
    expect((await me(personalReadToken, "acme")).statusCode).toBe(400);
    expect((await me(personalReadToken, ORGANIZATION_ID)).statusCode).toBe(403);
    for (const organizationId of [undefined, "acme", PERSON_ORGANIZATION_ID]) {
      expect((await me(readToken, organizationId)).json()).toEqual({ kind: "service_account", organizationId: ORGANIZATION_ID });
    }
  });

  it("the organization is checked before the access: a read token's write to another organization is 403 organization_access_denied, to its own 403 insufficient_access", async () => {
    const { server, personalReadToken, personalWriteToken } = await harness();
    const post = (token: string, organizationId?: string) =>
      server.inject({
        method: "POST",
        url: "/api/public/v1/things",
        headers: { "content-type": "application/json", ...withOrganization(token, organizationId) },
        payload: JSON.stringify({ name: "x" }),
      });
    expect((await post(personalReadToken)).body === ORGANIZATION_REQUIRED).toBe(true);
    expect((await post(personalReadToken, ORGANIZATION_ID)).body === ACCESS_DENIED).toBe(true);
    expect((await post(personalReadToken, PERSON_ORGANIZATION_ID)).body === INSUFFICIENT).toBe(true);
    expect((await post(personalWriteToken, PERSON_ORGANIZATION_ID)).statusCode).toBe(200);
  });

  it("the per-token count comes first: a refused organization spends the token's minute", async () => {
    const { server, personalReadToken } = await harness({ perToken: { max: 2, windowMs: 60_000 } });
    const get = (organizationId?: string) =>
      server.inject({ method: "GET", url: "/api/public/v1/things", headers: withOrganization(personalReadToken, organizationId) });
    expect((await get()).statusCode).toBe(400);
    expect((await get(ORGANIZATION_ID)).statusCode).toBe(403);
    expect((await get(PERSON_ORGANIZATION_ID)).statusCode).toBe(429);
  });

  it("an unknown path answers 404 to a person's token whatever the header: the not-found needs no organization", async () => {
    const { server, personalReadToken } = await harness();
    for (const organizationId of [undefined, "acme", ORGANIZATION_ID]) {
      const reply = await server.inject({ method: "GET", url: "/api/public/v1/nope", headers: withOrganization(personalReadToken, organizationId) });
      expect(reply.statusCode).toBe(404);
    }
  });
});

describe("every reply under the plugin is no-store unless its route says otherwise", () => {
  it("the 401, a 400, the 403, the 404, the 429 and a route's own reply carry Cache-Control: no-store; a route's own Cache-Control is kept", async () => {
    const { server, readToken, writeToken } = await harness({
      perToken: { max: 2, windowMs: 60_000 },
      extraRoute: (api) =>
        api.get("/cached", { config: { access: "read" } }, async (_request, reply) => reply.header("cache-control", "private, max-age=60").send({})),
    });
    const json = { "content-type": "application/json" };
    const replies = [
      await server.inject({ method: "GET", url: "/api/public/v1/things" }),
      await server.inject({ method: "POST", url: "/api/public/v1/things", headers: { ...bearer(readToken), ...json }, payload: "{}" }),
      await server.inject({ method: "POST", url: "/api/public/v1/things", headers: { ...bearer(writeToken), ...json }, payload: "{}" }),
      await server.inject({ method: "GET", url: "/api/public/v1/nope", headers: bearer(writeToken) }),
      await server.inject({ method: "GET", url: "/api/public/v1/things", headers: bearer(writeToken) }),
    ];
    expect(replies.map((reply) => [reply.statusCode, reply.headers["cache-control"]])).toEqual([
      [401, "no-store"],
      [403, "no-store"],
      [400, "no-store"],
      [404, "no-store"],
      [429, "no-store"],
    ]);
    const { server: fresh, readToken: freshToken } = await harness({
      extraRoute: (api) =>
        api.get("/cached", { config: { access: "read" } }, async (_request, reply) => reply.header("cache-control", "private, max-age=60").send({})),
    });
    const plain = await fresh.inject({ method: "GET", url: "/api/public/v1/things", headers: bearer(freshToken) });
    const own = await fresh.inject({ method: "GET", url: "/api/public/v1/cached", headers: bearer(freshToken) });
    expect([plain.statusCode, plain.headers["cache-control"], own.statusCode, own.headers["cache-control"]]).toEqual([
      200,
      "no-store",
      200,
      "private, max-age=60",
    ]);
  });
});
