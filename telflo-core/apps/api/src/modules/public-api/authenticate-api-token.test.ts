import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationRole } from "@telflo/db";
import { registerErrorHandling } from "../../errors.js";
import { createApiTokenFailureLimiter, RATE_LIMITS } from "../../http/rate-limits.js";
import { serializeRequest } from "../../http/request-log.js";
import type { LiveApiToken } from "../service-accounts/repositories/api-token-repository.js";
import { apiTokenHash } from "../service-accounts/tokens.js";
import {
  createApiTokenOrganizationCheck,
  createAuthenticateApiToken,
  decorateApiTokenAuthentication,
  requireAcceptedApiToken,
  requireApiTokenAuthentication,
  type ApiTokenStore,
  type ApiTokenUse,
} from "./authenticate-api-token.js";

/*
 * The token check's order and its failure count, over a store the test
 * counts and fails, with the production limit (30 failures per 5 minutes
 * per address). Tokens are built at run time and every assertion about one
 * compares booleans or counts, so a failure prints none.
 */

const LIMIT = RATE_LIMITS.apiTokenFailuresPerIp;

/** A well-formed token, unknown to every store here unless one is told of it. */
const newToken = () => `tf_${randomBytes(32).toString("base64url")}`;

const LIVE: LiveApiToken = {
  kind: "service_account",
  tokenId: "0192a6b0-0000-7000-8000-00000000a0e1",
  organizationId: "0192a6b0-0000-7000-8000-00000000a0e2",
  userId: "0192a6b0-0000-7000-8000-00000000a0e3",
  email: "bot-0192a6b0@service-accounts.telflo.invalid",
  access: "write",
  role: "contributor",
};

/** A person's own live token, as migration 1700000000038's lookup answers it: no organization, no role. */
const PERSON: LiveApiToken = {
  kind: "person",
  tokenId: "0192a6b0-0000-7000-8000-00000000a0f1",
  organizationId: null,
  userId: "0192a6b0-0000-7000-8000-00000000a0f3",
  email: "person-0192a6b0@example.com",
  access: "write",
  role: null,
};

interface Harness {
  server: FastifyInstance;
  /** How many lookups the check has made. */
  lookups: () => number;
  /** While true, every lookup throws (a database outage), after counting. */
  failLookups: (fail: boolean) => void;
  /** The tokens (a service account's context, a person's use) "Last used" was asked to write for. */
  touched: ApiTokenUse[];
  lines: string[];
  /** How many membership reads the organization check has made. */
  roleReads: () => number;
  /** The person's live role per organization id, as the store answers it; changed between requests by a test. */
  roles: Map<string, OrganizationRole>;
}

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface HarnessOptions {
  validToken?: string;
  /** The row the lookup answers for `validToken`: a service account's (LIVE) by default. */
  found?: LiveApiToken;
  /** Makes "Last used" throw an error with this code. */
  failTouch?: string;
  /** Every lookup waits for it (after counting), so a test decides when lookups in flight settle. */
  gate?: Promise<void>;
  /** The failure limiter's clock, in milliseconds; the real one by default. */
  limiterNow?: () => number;
}

/**
 * A server with the check on one route. Only `validToken` is live; each
 * lookup waits a tick (or `gate`), so parallel requests are all in flight
 * together.
 */
async function harness({ validToken, found = LIVE, failTouch, gate, limiterNow }: HarnessOptions = {}): Promise<Harness> {
  let lookups = 0;
  let lookupsFail = false;
  let roleReads = 0;
  const touched: ApiTokenUse[] = [];
  const lines: string[] = [];
  const roles = new Map<string, OrganizationRole>();
  const store: ApiTokenStore = {
    async findLive(tokenHash) {
      lookups += 1;
      await (gate ?? new Promise((resolve) => setTimeout(resolve, 5)));
      if (lookupsFail) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      return validToken !== undefined && tokenHash === apiTokenHash(validToken) ? found : undefined;
    },
    async touchLastUsed(context) {
      if (failTouch !== undefined) {
        throw Object.assign(new Error('new row for relation "api_tokens" violates check constraint'), {
          code: failTouch,
          detail: "Failing row contains (a token's hash)",
        });
      }
      touched.push(context);
    },
    async findRole(userId, organizationId) {
      roleReads += 1;
      return userId === found.userId ? roles.get(organizationId) : undefined;
    },
  };
  const server = Fastify({
    logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
  });
  registerErrorHandling(server);
  decorateApiTokenAuthentication(server);
  const authenticate = createAuthenticateApiToken({
    store,
    failures: createApiTokenFailureLimiter(LIMIT, limiterNow === undefined ? {} : { now: limiterNow }),
    now: () => new Date("2026-10-23T12:00:00Z"),
  });
  server.get("/api/public/v1/whoami", { preHandler: authenticate }, async (request) => {
    const { context } = requireApiTokenAuthentication(request);
    return { tokenId: context.tokenId };
  });
  server.get("/api/public/v1/unguarded", async (request) => requireApiTokenAuthentication(request));
  // The organization check after the token's, as the public plugin runs them: required, and optional.
  const organization = createApiTokenOrganizationCheck({ store });
  for (const requirement of ["required", "optional"] as const) {
    server.get(
      `/api/public/v1/organization-${requirement}`,
      { preHandler: [authenticate, (request) => organization(request, requirement)] },
      async (request) => ({
        kind: requireAcceptedApiToken(request).kind,
        context: request.apiTokenAuthentication === null ? null : { ...request.apiTokenAuthentication.context },
      }),
    );
  }
  await server.ready();
  servers.push(server);
  return {
    server,
    lookups: () => lookups,
    failLookups: (fail) => {
      lookupsFail = fail;
    },
    touched,
    lines,
    roleReads: () => roleReads,
    roles,
  };
}

const whoami = (server: FastifyInstance, authorization?: string, remoteAddress = "203.0.113.7") =>
  server.inject({
    method: "GET",
    url: "/api/public/v1/whoami",
    remoteAddress,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });

describe("the token check's failure limit", () => {
  it("a burst of 100 parallel bad tokens from one address makes exactly 30 lookups: each counts before its lookup", async () => {
    const { server, lookups } = await harness();
    const replies = await Promise.all(Array.from({ length: 100 }, () => whoami(server, `Bearer ${newToken()}`)));
    const statuses = replies.map((reply) => reply.statusCode);
    expect(lookups()).toBe(LIMIT.max);
    expect(statuses.filter((status) => status === 401)).toHaveLength(LIMIT.max);
    expect(statuses.filter((status) => status === 429)).toHaveLength(100 - LIMIT.max);
  });

  it("100 parallel VALID requests from one address: the 429s, caused by lookups in flight only, carry Retry-After 1, and the next request succeeds", async () => {
    const valid = newToken();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server, lookups } = await harness({ validToken: valid, gate });
    let answered = 0;
    const pending = Array.from({ length: 100 }, () =>
      whoami(server, `Bearer ${valid}`).then((reply) => {
        answered += 1;
        return reply;
      }),
    );
    // Every request beyond the limit is answered while the first ones' lookups are held in flight.
    await vi.waitFor(() => expect(answered).toBe(100 - LIMIT.max), { timeout: 5_000 });
    expect(lookups()).toBe(LIMIT.max);
    release();
    const replies = await Promise.all(pending);
    const statuses = replies.map((reply) => reply.statusCode);
    expect(statuses.filter((status) => status === 200)).toHaveLength(LIMIT.max);
    const refused = replies.filter((reply) => reply.statusCode === 429);
    expect(refused).toHaveLength(100 - LIMIT.max);
    expect(refused.every((reply) => reply.headers["retry-after"] === "1")).toBe(true);
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
  });

  it("settled failures block the address for the window: Retry-After is the window's remaining time, and a valid token passes once it ends", async () => {
    const valid = newToken();
    let clock = Date.parse("2026-10-23T12:00:00Z");
    const { server, lookups } = await harness({ validToken: valid, limiterNow: () => clock });
    for (let attempt = 0; attempt < LIMIT.max; attempt += 1) {
      expect((await whoami(server, `Bearer ${newToken()}`)).statusCode).toBe(401);
    }
    const blocked = await whoami(server, `Bearer ${valid}`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe(String(LIMIT.windowMs / 1000));
    clock += LIMIT.windowMs - 100_000;
    const later = await whoami(server, `Bearer ${valid}`);
    expect(later.statusCode).toBe(429);
    expect(later.headers["retry-after"]).toBe("100");
    expect(lookups()).toBe(LIMIT.max);
    clock += 100_000;
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
  });

  it("a lookup that throws refunds its count before the 500: a database outage spends none of the address's budget", async () => {
    const valid = newToken();
    const { server, lookups, failLookups } = await harness({ validToken: valid });
    failLookups(true);
    for (let attempt = 0; attempt < LIMIT.max * 2; attempt += 1) {
      expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(500);
    }
    expect(lookups()).toBe(LIMIT.max * 2);
    failLookups(false);
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
    for (let attempt = 0; attempt < LIMIT.max - 1; attempt += 1) {
      expect((await whoami(server, `Bearer ${newToken()}`)).statusCode).toBe(401);
    }
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
  });

  it("a blocked address is refused 429 with Retry-After before its header is read: a valid token's included, no lookup made", async () => {
    const valid = newToken();
    const { server, lookups, touched } = await harness({ validToken: valid });
    for (let attempt = 0; attempt < LIMIT.max; attempt += 1) {
      expect((await whoami(server, `Bearer ${newToken()}`)).statusCode).toBe(401);
    }
    const blocked = await whoami(server, `Bearer ${valid}`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await whoami(server)).statusCode).toBe(429);
    expect(lookups()).toBe(LIMIT.max);
    expect(touched).toHaveLength(0);
  });

  it("a request with no Authorization header counts nothing", async () => {
    const valid = newToken();
    const { server, lookups } = await harness({ validToken: valid });
    for (let attempt = 0; attempt < LIMIT.max * 2; attempt += 1) {
      expect((await whoami(server)).statusCode).toBe(401);
    }
    expect(lookups()).toBe(0);
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
  });

  it("any header counts one, a scheme other than Bearer and a malformed token included, with no lookup: each settles as a failure, blocking for the window, and a valid token passes once it ends", async () => {
    const valid = newToken();
    let clock = Date.parse("2026-10-23T12:00:00Z");
    const { server, lookups } = await harness({ validToken: valid, limiterNow: () => clock });
    // `Bearer ${valid}A`: 44 characters after tf_, refused by the form, never looked up.
    const malformed = [`Basic ${valid}`, `Bearer ${valid.slice(0, -1)}`, `Bearer ${valid}A`, "", "Bearer", `Bearer  ${valid}`];
    for (let attempt = 0; attempt < LIMIT.max; attempt += 1) {
      expect((await whoami(server, malformed[attempt % malformed.length])).statusCode).toBe(401);
    }
    expect(lookups()).toBe(0);
    // Settled failures: the window's Retry-After, not the 1 second of attempts left in flight.
    const blocked = await whoami(server, `Bearer ${valid}`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe(String(LIMIT.windowMs / 1000));
    clock += LIMIT.windowMs;
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
    expect(lookups()).toBe(1);
  });

  it("a success takes back its own count only: valid tokens never fill the budget, and the address's failures stand", async () => {
    const valid = newToken();
    const { server } = await harness({ validToken: valid });
    for (let attempt = 0; attempt < LIMIT.max * 2; attempt += 1) {
      expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
    }
    for (let attempt = 0; attempt < LIMIT.max - 1; attempt += 1) {
      expect((await whoami(server, `Bearer ${newToken()}`)).statusCode).toBe(401);
    }
    // 29 failures: a success neither resets them nor counts.
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
    expect((await whoami(server, `Bearer ${newToken()}`)).statusCode).toBe(401);
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(429);
  });

  it("the budget is the address's: another address is unaffected", async () => {
    const valid = newToken();
    const { server } = await harness({ validToken: valid });
    for (let attempt = 0; attempt < LIMIT.max; attempt += 1) {
      await whoami(server, `Bearer ${newToken()}`, "203.0.113.7");
    }
    expect((await whoami(server, `Bearer ${valid}`, "203.0.113.7")).statusCode).toBe(429);
    expect((await whoami(server, `Bearer ${valid}`, "198.51.100.9")).statusCode).toBe(200);
  });
});

describe("the token check's order and its one refusal", () => {
  it("accepts Bearer, the scheme case aside, one space, then exactly a tf_ token", async () => {
    const valid = newToken();
    const { server } = await harness({ validToken: valid });
    for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) {
      expect((await whoami(server, `${scheme} ${valid}`)).statusCode).toBe(200);
    }
  });

  it("refuses every other form with the same 401 body and WWW-Authenticate: Bearer", async () => {
    const valid = newToken();
    const { server } = await harness({ validToken: valid });
    const forms: (string | undefined)[] = [
      undefined,
      `Basic ${valid}`,
      `Token ${valid}`,
      `Bearer${valid}`,
      `Bearer  ${valid}`,
      `Bearer ${valid} x`,
      `Bearer ${valid.slice(0, -1)}`,
      `Bearer ${valid}A`,
      `Bearer ${valid.replace(/^tf_/, "tq_")}`,
      `Bearer ${valid.replace(/^tf_/, "TF_")}`,
      `Bearer ${valid.slice(0, -1)}+`,
      `Bearer ${newToken()}`,
    ];
    const replies = await Promise.all(forms.map((form) => whoami(server, form)));
    const expected = JSON.stringify({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });
    expect(replies.map((reply) => reply.statusCode)).toEqual(forms.map(() => 401));
    expect(replies.every((reply) => reply.body === expected)).toBe(true);
    expect(replies.every((reply) => reply.headers["www-authenticate"] === "Bearer")).toBe(true);
  });

  it("builds the frozen token context from the lookup's row, and asks for Last used with it", async () => {
    const valid = newToken();
    const { server, touched } = await harness({ validToken: valid });
    const reply = await whoami(server, `Bearer ${valid}`);
    expect(reply.body.includes(valid.slice(3))).toBe(false);
    expect(reply.json()).toEqual({ tokenId: LIVE.tokenId });
    expect(touched).toHaveLength(1);
    expect(touched[0]).toEqual({
      userId: LIVE.userId,
      organizationId: LIVE.organizationId,
      role: LIVE.role,
      kind: "service_account",
      tokenId: LIVE.tokenId,
      access: LIVE.access,
    });
    expect(Object.isFrozen(touched[0])).toBe(true);
  });

  it("a failed Last used never refuses the request, and its warn line holds the token's id and the error's code only", async () => {
    const valid = newToken();
    const { server, lines } = await harness({ validToken: valid, failTouch: "23514" });
    expect((await whoami(server, `Bearer ${valid}`)).statusCode).toBe(200);
    // The canaries first: no comparison below may print a token.
    const logged = lines.join("\n");
    expect(logged.includes(valid.slice(3))).toBe(false);
    expect(logged.includes(apiTokenHash(valid))).toBe(false);
    expect(logged.includes("hash")).toBe(false);
    const warnings = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.level === 40);
    expect(warnings).toHaveLength(1);
    const { level: _level, time: _time, pid: _pid, hostname: _hostname, reqId: _reqId, ...fields } = warnings[0]!;
    expect(Object.keys(fields).sort()).toEqual(["code", "msg", "tokenId"]);
    expect(fields).toEqual({ tokenId: LIVE.tokenId, code: "23514", msg: "an API token's last use wasn't recorded" });
  });

  it("a route that forgets the check fails closed with the one 401", async () => {
    const { server } = await harness();
    const reply = await server.inject({ method: "GET", url: "/api/public/v1/unguarded" });
    expect(reply.statusCode).toBe(401);
    expect(reply.json()).toEqual({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });
  });

  it("no log line of a success or a refusal holds the token", async () => {
    const valid = newToken();
    const { server, lines } = await harness({ validToken: valid });
    const unknown = newToken();
    await whoami(server, `Bearer ${valid}`);
    await whoami(server, `Bearer ${unknown}`);
    await whoami(server, `Basic ${unknown}`);
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    expect([valid, unknown].some((token) => logged.includes(token.slice(3)))).toBe(false);
    expect(logged.includes(apiTokenHash(valid))).toBe(false);
  });
});

describe("a personal token", () => {
  const ORGANIZATION = "0192a6b0-0000-7000-8000-00000000a0f2";
  const OTHER = "0192a6b0-0000-7000-8000-00000000a0f4";
  const ORGANIZATION_REQUIRED = JSON.stringify({
    error: { code: "organization_required", message: "Send the organization's id in X-Telflo-Org." },
  });
  const ACCESS_DENIED = JSON.stringify({
    error: { code: "organization_access_denied", message: "You are not an active member of this organization" },
  });

  const call = (server: FastifyInstance, token: string, requirement: "required" | "optional", organization?: string | string[]) =>
    server.inject({
      method: "GET",
      url: `/api/public/v1/organization-${requirement}`,
      remoteAddress: "203.0.113.7",
      headers: { authorization: `Bearer ${token}`, ...(organization === undefined ? {} : { "x-telflo-org": organization }) },
    });

  it("is accepted with no organization yet: its attempt refunded, Last used asked in the person's own context (organization null), and a route needing the context fails closed", async () => {
    const valid = newToken();
    const { server, touched, lookups } = await harness({ validToken: valid, found: PERSON });
    for (let attempt = 0; attempt < LIMIT.max * 2; attempt += 1) {
      const reply = await whoami(server, `Bearer ${valid}`);
      // /whoami here reads requireApiTokenAuthentication: a person's has no organization, so the one 401.
      expect(reply.statusCode).toBe(401);
    }
    // Accepted every time: no attempt counted, so the address is never blocked.
    expect(lookups()).toBe(LIMIT.max * 2);
    expect(touched).toHaveLength(LIMIT.max * 2);
    expect(touched[0]).toEqual({ kind: "person", tokenId: PERSON.tokenId, userId: PERSON.userId, organizationId: null });
    const optional = await call(server, valid, "optional");
    expect(optional.statusCode).toBe(200);
    expect(optional.json()).toEqual({ kind: "person", context: null });
  });

  it("a route that needs the organization: none sent, or one that isn't a uuid, is 400 organization_required, never echoing it", async () => {
    const valid = newToken();
    const { server, roleReads, roles } = await harness({ validToken: valid, found: PERSON });
    roles.set(ORGANIZATION, "admin");
    const missing = await call(server, valid, "required");
    expect(missing.statusCode).toBe(400);
    expect(missing.body === ORGANIZATION_REQUIRED).toBe(true);
    for (const malformed of ["", "acme", `${ORGANIZATION}x`, ` ${ORGANIZATION}`, ORGANIZATION.replaceAll("-", ""), [ORGANIZATION, ORGANIZATION]]) {
      const reply = await call(server, valid, "required", malformed);
      expect(reply.statusCode, JSON.stringify(malformed)).toBe(400);
      expect(reply.body === ORGANIZATION_REQUIRED).toBe(true);
    }
    expect(roleReads()).toBe(0);
  });

  it("a member gets the context with their live role, read on every request; a non-member, an unknown or a deleted organization is the one 403", async () => {
    const valid = newToken();
    const { server, roleReads, roles } = await harness({ validToken: valid, found: PERSON });
    roles.set(ORGANIZATION, "contributor");
    // In capitals: canonicalIdOf lowercases it before any comparison.
    const first = await call(server, valid, "required", ORGANIZATION.toUpperCase());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      kind: "person",
      context: { userId: PERSON.userId, organizationId: ORGANIZATION, role: "contributor", kind: "person", tokenId: PERSON.tokenId, access: "write" },
    });
    // Promoted: the next request reads the new role (no cache).
    roles.set(ORGANIZATION, "admin");
    expect((await call(server, valid, "required", ORGANIZATION)).json<{ context: { role: string } }>().context.role).toBe("admin");
    // Removed (or the organization deleted, or never theirs): the one 403.
    roles.delete(ORGANIZATION);
    for (const organization of [ORGANIZATION, OTHER]) {
      const refused = await call(server, valid, "required", organization);
      expect(refused.statusCode).toBe(403);
      expect(refused.body === ACCESS_DENIED).toBe(true);
    }
    expect(roleReads()).toBe(4);
  });

  it("an optional route checks a header that is sent, as any route does; with none, no organization and no read", async () => {
    const valid = newToken();
    const { server, roleReads, roles } = await harness({ validToken: valid, found: PERSON });
    roles.set(ORGANIZATION, "admin");
    expect((await call(server, valid, "optional")).json()).toEqual({ kind: "person", context: null });
    expect(roleReads()).toBe(0);
    expect((await call(server, valid, "optional", "acme")).statusCode).toBe(400);
    expect((await call(server, valid, "optional", OTHER)).statusCode).toBe(403);
    const accepted = await call(server, valid, "optional", ORGANIZATION);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ context: { organizationId: string; role: string } }>().context).toMatchObject({ organizationId: ORGANIZATION, role: "admin" });
  });

  it("a refused organization never counts toward the address's failure limit", async () => {
    const valid = newToken();
    const { server } = await harness({ validToken: valid, found: PERSON });
    for (let attempt = 0; attempt < LIMIT.max * 2; attempt += 1) {
      expect((await call(server, valid, "required", OTHER)).statusCode).toBe(403);
      expect((await call(server, valid, "required")).statusCode).toBe(400);
    }
    // Still not blocked: a well-formed unknown token is a 401, not a 429.
    expect((await whoami(server, `Bearer ${newToken()}`)).statusCode).toBe(401);
  });

  it("a service account's token ignores X-Telflo-Org: its own organization, no membership read, whatever is sent", async () => {
    const valid = newToken();
    const { server, roleReads } = await harness({ validToken: valid });
    for (const organization of [undefined, "acme", OTHER]) {
      const reply = await call(server, valid, "required", organization);
      expect(reply.statusCode).toBe(200);
      expect(reply.json<{ context: { organizationId: string } }>().context.organizationId).toBe(LIVE.organizationId);
    }
    expect(roleReads()).toBe(0);
  });

  it("a lookup row of the wrong shape (a person's naming an organization, a service account's naming none) is refused as an unknown token", async () => {
    for (const found of [
      { ...PERSON, organizationId: LIVE.organizationId },
      { ...PERSON, role: "admin" as const },
      { ...LIVE, organizationId: null },
      { ...LIVE, role: null },
    ]) {
      const valid = newToken();
      const { server, touched } = await harness({ validToken: valid, found });
      expect((await call(server, valid, "optional")).statusCode).toBe(401);
      expect(touched).toHaveLength(0);
    }
  });
});
