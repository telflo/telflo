import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { addApiToken, addMembership, addServiceAccount, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { documentedOperations, documentPathOf, validatePublicReply } from "../../testing/public-api-openapi.js";
import { apiTokenHash } from "../service-accounts/tokens.js";
import { publicApiDocument } from "./openapi/document.js";
import { publicApiRoutesOf } from "./routes.js";

/*
 * The public surface's plugin on the real server: the open routes, the 401
 * before the 404, the per-token limit over real tokens, the request log's
 * query rule, and the OpenAPI document's coverage and reply validation.
 * Tokens are built at run time by addApiToken and never printed: the
 * canaries (booleans) run before any comparison of a reply or a log line
 * that could hold one.
 */

const opamp = useFakeOpampServer();

const WHOAMI = "/api/public/v1/whoami";
const REFUSAL = JSON.stringify({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });

describe("the public surface's plugin", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  const servers: FastifyInstance[] = [];
  let server: FastifyInstance;
  let logLines: string[] = [];

  const serverWith = async (rateLimits: RateLimits) => {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
    await built.ready();
    servers.push(built);
    return built;
  };

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = await serverWith(TEST_RATE_LIMITS);
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
  });

  /** A live token of a new service account, made by the owner a minute ago. */
  const liveToken = async (access: "read" | "write" = "read") => {
    const admin = await createUserWithOrganization(ownerDb);
    const { organization } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const at = new Date(Date.now() - 60_000);
    const { user } = await addServiceAccount(ownerDb, { organizationId: organization.id, createdAt: at });
    const { token } = await addApiToken(ownerDb, { organizationId: organization.id, serviceAccountUserId: user.id, created_at: at, access });
    return { token, organizationId: organization.id };
  };

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  describe("the open routes", () => {
    it("GET /health answers without a token, whatever Authorization is sent, as the document says", async () => {
      for (const headers of [{}, { authorization: "Bearer nonsense" }]) {
        const response = await server.inject({ method: "GET", url: "/api/public/v1/health", headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "healthy" });
        expect(validatePublicReply("GET", "/api/public/v1/health", 200, response.json())).toEqual({ isValid: true, errors: [] });
      }
    });

    it("GET /openapi.json answers the document without a token, cacheable for five minutes", async () => {
      const response = await server.inject({ method: "GET", url: "/api/public/v1/openapi.json" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.json()).toEqual(publicApiDocument());
    });
  });

  describe("the plugin's 404 answers after the check", () => {
    it("an unknown public path answers the one 401 without a token, and 404 with one, the query left out of the reply", async () => {
      const { token } = await liveToken();
      const anonymous = await server.inject({ method: "GET", url: "/api/public/v1/nope?q=x" });
      expect(anonymous.statusCode === 401 && anonymous.body === REFUSAL).toBe(true);
      expect(validatePublicReply("GET", WHOAMI, 401, anonymous.json()).isValid).toBe(true);
      const known = await server.inject({ method: "GET", url: "/api/public/v1/nope?q=x", headers: { authorization: `Bearer ${token}` } });
      expect(holdsToken(known.body, token)).toBe(false);
      expect(known.statusCode).toBe(404);
      expect(known.json()).toEqual({ error: { code: "not_found", message: "No route for GET /api/public/v1/[unmatched]" } });
    });

    it("/whoami answers as before, its reply valid against the document; HEAD too", async () => {
      const { token, organizationId } = await liveToken();
      const response = await server.inject({ method: "GET", url: WHOAMI, headers: { authorization: `Bearer ${token}` } });
      expect(holdsToken(response.body, token)).toBe(false);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ organizationId, access: "read", kind: "service_account" });
      expect(validatePublicReply("GET", WHOAMI, 200, response.json())).toEqual({ isValid: true, errors: [] });
      const head = await server.inject({ method: "HEAD", url: WHOAMI, headers: { authorization: `Bearer ${token}` } });
      expect(head.statusCode).toBe(200);
    });
  });

  describe("the OpenAPI document covers the routes", () => {
    /** Routes outside the document: the document itself, and the reference page (its 301 and its files). */
    const UNDOCUMENTED = new Set(["GET /openapi.json", "GET /docs", `GET ${documentPathOf("/api/public/v1/docs/*")}`]);

    it("every registered public route (HEAD aside) is an operation with its access, and every operation a registered route", () => {
      const registered = publicApiRoutesOf(server)
        .filter((route) => route.method !== "HEAD")
        .map((route) => ({ operation: `${route.method} ${documentPathOf(route.url)}`, access: route.access }))
        .filter(({ operation }) => !UNDOCUMENTED.has(operation));
      const documented = documentedOperations().map(({ method, path, access }) => ({ operation: `${method} ${path}`, access }));
      expect(registered.length).toBeGreaterThan(0);
      expect([...registered].sort((x, y) => x.operation.localeCompare(y.operation))).toEqual(
        [...documented].sort((x, y) => x.operation.localeCompare(y.operation)),
      );
    });

    it("the reply validator refuses a reply the document doesn't allow, naming no value", () => {
      const secret = `tf_${randomBytes(32).toString("base64url")}`;
      const refused = validatePublicReply("GET", WHOAMI, 200, { organizationId: "x", tokenName: secret, access: "admin", kind: "person" });
      expect(refused.isValid).toBe(false);
      expect(refused.errors.length).toBeGreaterThan(0);
      expect(refused.errors.join("\n").includes(secret.slice(3))).toBe(false);
      expect(validatePublicReply("GET", "/api/public/v1/nope", 200, {}).isValid).toBe(false);
      expect(validatePublicReply("GET", WHOAMI, 418, {}).isValid).toBe(false);
    });
  });

  describe("the request log", () => {
    it("drops the query of every /api/public/v1/ path from its log lines: a route's, an unknown path's, an open route's", async () => {
      const { token } = await liveToken();
      logLines = [];
      await server.inject({ method: "GET", url: `${WHOAMI}?name=Acme%20prod`, headers: { authorization: `Bearer ${token}` } });
      await server.inject({ method: "GET", url: "/api/public/v1/nope?name=Acme%20prod" });
      await server.inject({ method: "GET", url: "/api/public/v1/health?name=Acme%20prod" });
      await server.inject({ method: "GET", url: "/API/Public/V1/whoami/?name=Acme%20prod" });
      const urls = logLines.flatMap((line) => {
        const { req } = JSON.parse(line) as { req?: { url?: string } };
        return req?.url === undefined ? [] : [req.url];
      });
      expect(holdsToken(logLines.join("\n"), token)).toBe(false);
      // A route's pattern, or the fixed unmatched URL; never the path as sent.
      expect(urls).toEqual(["/api/public/v1/whoami", "/api/public/v1/[unmatched]", "/api/public/v1/health", "/api/public/v1/[unmatched]"]);
      expect(logLines.join("\n").includes("Acme")).toBe(false);
    });
  });

  describe("the request log over a raw socket: dot segments, which inject resolves and the router doesn't", () => {
    /** Sends `target` as the request line to `listening` over a raw socket, and resolves with the reply. */
    const sendRaw = (listening: FastifyInstance, target: string, authorization?: string, method = "GET") =>
      new Promise<string>((resolve, reject) => {
        const address = listening.server.address();
        if (address === null || typeof address === "string") throw new Error("a TCP address expected");
        const socket = connect(address.port, "127.0.0.1", () => {
          const auth = authorization === undefined ? "" : `Authorization: ${authorization}\r\n`;
          socket.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`);
        });
        let reply = "";
        socket.on("data", (chunk: Buffer) => (reply += chunk.toString("latin1")));
        socket.on("end", () => resolve(reply));
        socket.on("error", reject);
      });

    it.each([
      ["a dot segment", "/api/./public/v1/whoami?name=Acme%20prod"],
      ["a parent segment", "/api/x/../public/v1/whoami?name=Acme%20prod"],
      ["a leading dot segment", "/./api/public/v1/nope?name=Acme%20prod"],
    ])("drops the query of a public path with %s from its log line, and answers it the one 401 (no route matched it, and only the plugin's own 404 may answer under the prefix)", async (_label, target) => {
      const listening = await serverWith(TEST_RATE_LIMITS);
      await listening.listen({ host: "127.0.0.1", port: 0 });
      const { token } = await liveToken();
      logLines = [];
      const reply = await sendRaw(listening, target, `Bearer ${token}`);
      expect(holdsToken(reply, token)).toBe(false);
      expect(holdsToken(logLines.join("\n"), token)).toBe(false);
      expect(/^HTTP\/1\.1 401 /.test(reply)).toBe(true);
      expect(reply.includes("Acme")).toBe(false);
      expect(logLines.length).toBeGreaterThan(0);
      expect(logLines.join("\n").includes("Acme")).toBe(false);
    });

    it("an absolute-form target under the prefix is the public surface's: the one 401 from no root 404, nothing of its path or query logged", async () => {
      const listening = await serverWith(TEST_RATE_LIMITS);
      await listening.listen({ host: "127.0.0.1", port: 0 });
      const { token } = await liveToken();
      const MARKER = "marker-absolute-form-r173";
      logLines = [];
      const replies = [
        await sendRaw(listening, `http://x/API/public/v1/nope?name=${MARKER}`),
        await sendRaw(listening, `http://x/API/public/v1/nope?name=${MARKER}`, `Bearer ${token}`),
        await sendRaw(listening, `http://x/api/public/v1/nope?name=${MARKER}`),
      ];
      expect(replies.some((reply) => holdsToken(reply, token))).toBe(false);
      expect(holdsToken(logLines.join("\n"), token)).toBe(false);
      expect(replies.every((reply) => /^HTTP\/1\.1 401 /.test(reply) && reply.includes('"code":"invalid_api_token"'))).toBe(true);
      expect(replies.some((reply) => reply.includes(MARKER))).toBe(false);
      expect(logLines.length).toBeGreaterThan(0);
      expect(logLines.join("\n").includes(MARKER)).toBe(false);
    });

    it("logs and echoes the validation-pipeline PUT's pipeline name as the redaction: the real route, a raw and an encoded slash, case, a dot segment", async () => {
      const listening = await serverWith(TEST_RATE_LIMITS);
      await listening.listen({ host: "127.0.0.1", port: 0 });
      const { token } = await liveToken();
      const MARKER = "marker-pipeline-name-r167";
      const base = "/api/public/v1/configurations/0192a6b0-0000-7000-8000-0000000000d1/versions/1/validation-pipelines";
      logLines = [];
      const json = { "content-type": "application/json", authorization: `Bearer ${token}` };
      const replies = [
        await listening.inject({ method: "PUT", url: `${base}/traces/${MARKER}?q=${MARKER}`, headers: json, payload: "{}" }),
        await listening.inject({ method: "PUT", url: `${base}/traces%2F${MARKER}`, headers: json, payload: "{}" }),
        await listening.inject({ method: "PUT", url: `${base}/${MARKER}` }),
        await listening.inject({ method: "GET", url: `${base}/${MARKER}`, headers: { authorization: `Bearer ${token}` } }),
        await listening.inject({ method: "GET", url: `${base.replace("/api/public/v1", "/API/Public/V1")}/Validation-Pipelines/${MARKER}` }),
      ].map((reply) => reply.body);
      replies.push(await sendRaw(listening, `${base.replace("/api/public/v1", "/api/./public/v1")}/${MARKER}`, `Bearer ${token}`));
      // Not only at a segment boundary, raw over the socket.
      replies.push(await sendRaw(listening, `${base};x/traces/${MARKER}`, `Bearer ${token}`));
      replies.push(await sendRaw(listening, `${base.replace("/versions/1/", "/versions/1%2F")}/${MARKER}`, `Bearer ${token}`));
      // Characters that grow in lower case, an absolute-form target (PUT, with a ;-parameter), a double encoding.
      const grown = base.replace("/validation-pipelines", `/${"%C4%B0".repeat(25)}validation%2Dpipelines`);
      replies.push(await sendRaw(listening, `${grown}/${MARKER}`, `Bearer ${token}`, "PUT"));
      replies.push(await sendRaw(listening, `http://x${base};x/${MARKER}`, `Bearer ${token}`, "PUT"));
      replies.push(await sendRaw(listening, `${base.replace("validation-pipelines", "validation%252Dpipelines")}/${MARKER}`, `Bearer ${token}`));
      expect(holdsToken(logLines.join("\n"), token)).toBe(false);
      expect(replies.some((reply) => holdsToken(reply, token))).toBe(false);
      expect(logLines.length).toBeGreaterThan(0);
      expect(logLines.join("\n").includes(MARKER)).toBe(false);
      expect(replies.some((reply) => reply.includes(MARKER))).toBe(false);
      const urls = logLines.flatMap((line) => {
        const { req } = JSON.parse(line) as { req?: { url?: string } };
        return req?.url === undefined ? [] : [req.url];
      });
      // Every line is the route's pattern or the fixed unmatched URL.
      const pattern = "/api/public/v1/configurations/:configurationId/versions/:versionNumber/validation-pipelines/*";
      expect(urls.length).toBeGreaterThanOrEqual(11);
      expect(urls.every((url) => url === pattern || url === "/api/public/v1/[unmatched]")).toBe(true);
      expect(urls.filter((url) => url === pattern).length).toBeGreaterThanOrEqual(3);
      // The list route logs its own pattern, the query left out.
      logLines = [];
      await listening.inject({ method: "GET", url: `${base}?q=${MARKER}`, headers: { authorization: `Bearer ${token}` } });
      expect(logLines.join("\n").includes(MARKER)).toBe(false);
      expect(logLines.some((line) => line.includes('"url":"/api/public/v1/configurations/:configurationId/versions/:versionNumber/validation-pipelines"'))).toBe(true);
    });
  });

  describe("a 400's details on the public surface", () => {
    const MARKER = "MarkerValue175";

    it("name the field's path and Zod's code only: no value from an enum field, a query enum, a path parameter or an unknown key", async () => {
      const { token } = await liveToken("write");
      const pasted = `tf_${randomBytes(32).toString("base64url")}`;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const version = `/api/public/v1/configurations/${"0192a6b0-0000-7000-8000-0000000000e1"}/versions`;
      const cases: Array<[string, Promise<{ statusCode: number; body: string; json: () => unknown }>, unknown]> = [
        [
          "an enum field",
          server.inject({ method: "POST", url: "/api/public/v1/fleets", headers, payload: JSON.stringify({ label: "edge", type: MARKER }) }),
          [{ path: ["type"], code: "invalid_enum_value" }],
        ],
        [
          "a pasted token in an enum field",
          server.inject({ method: "POST", url: "/api/public/v1/fleets", headers, payload: JSON.stringify({ label: "edge", type: pasted }) }),
          [{ path: ["type"], code: "invalid_enum_value" }],
        ],
        [
          "an unknown key",
          server.inject({ method: "POST", url: "/api/public/v1/fleets", headers, payload: JSON.stringify({ label: "edge", type: "server", [MARKER]: 1 }) }),
          [{ path: ["<unknown>"], code: "unrecognized_keys" }],
        ],
        [
          "a pasted token as an unknown key",
          server.inject({ method: "POST", url: "/api/public/v1/fleets", headers, payload: JSON.stringify({ label: "edge", type: "server", [pasted]: 1 }) }),
          [{ path: ["<unknown>"], code: "unrecognized_keys" }],
        ],
        [
          "a query enum",
          server.inject({ method: "PATCH", url: `${version}/1?validate=${MARKER}`, headers, payload: JSON.stringify({ yaml: "receivers: {}" }) }),
          [{ path: ["validate"], code: "invalid_enum_value" }],
        ],
        [
          "a path parameter",
          server.inject({ method: "GET", url: `${version}/${MARKER}`, headers: { authorization: `Bearer ${token}` } }),
          [{ path: ["versionNumber"], code: "invalid_string" }],
        ],
      ];
      for (const [label, pending, details] of cases) {
        const response = await pending;
        expect([label, response.body.includes(MARKER), response.body.includes(pasted.slice(3)), holdsToken(response.body, token)]).toEqual([
          label,
          false,
          false,
          false,
        ]);
        expect([label, response.statusCode]).toEqual([label, 400]);
        expect([label, response.json()]).toEqual([label, { error: { code: "invalid_request", message: "The request was not valid.", details } }]);
      }
    });

    it("leave a browser route's details as before (Zod's issues; the wider change is the controller's TODO)", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: { "x-telflo-csrf": "1", "content-type": "application/json" },
        payload: JSON.stringify({ email: 42, password: MARKER }),
      });
      expect(response.statusCode).toBe(400);
      const { details } = response.json<{ error: { details: Array<Record<string, unknown>> } }>().error;
      expect(details.some((issue) => typeof issue.message === "string" && "params" in issue)).toBe(true);
    });
  });

  describe("the per-token limit, with the production number", () => {
    // Its bound is the request count (60, then the 61st), never the time:
    // the generous hang guard only keeps a loaded machine's 63 real
    // requests from tripping the default 5 s test timeout.
    it("60 requests a minute per token: the 61st answers 429 rate_limited with Retry-After; another token is unaffected", { timeout: 30_000 }, async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, publicApiPerToken: RATE_LIMITS.publicApiPerToken });
      const first = await liveToken();
      const second = await liveToken();
      const whoami = (token: string) => limited.inject({ method: "GET", url: WHOAMI, headers: { authorization: `Bearer ${token}` } });
      const statuses: number[] = [];
      for (let request = 0; request < 60; request += 1) statuses.push((await whoami(first.token)).statusCode);
      expect(statuses.every((status) => status === 200)).toBe(true);
      const refused = await whoami(first.token);
      expect(holdsToken(refused.body, first.token)).toBe(false);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toEqual({ error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } });
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
      expect(validatePublicReply("GET", WHOAMI, 429, refused.json()).isValid).toBe(true);
      expect((await whoami(second.token)).statusCode).toBe(200);
      // The open routes are outside it.
      expect((await limited.inject({ method: "GET", url: "/api/public/v1/health", headers: { authorization: `Bearer ${first.token}` } })).statusCode).toBe(200);
    });
  });
});
