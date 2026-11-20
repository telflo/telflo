import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { AppError, publicRefusalDetails, publicValidationDetails, registerErrorHandling, respondToFrameworkError } from "./errors.js";
import { fieldDetail } from "./modules/fleets/errors.js";
import { serializeRequest } from "./http/request-log.js";

describe("AppError", () => {
  it("carries a machine-readable code and an http status", () => {
    const error = new AppError("invalid_token", "That link is no longer valid.", 400);
    expect(error.code).toBe("invalid_token");
    expect(error.statusCode).toBe(400);
  });

  it("is an instance of Error, so ordinary handling still applies", () => {
    expect(new AppError("x", "y", 400)).toBeInstanceOf(Error);
  });

  it("defaults to status 400 when none is supplied", () => {
    expect(new AppError("x", "y").statusCode).toBe(400);
  });
});

/**
 * The 400 branch of the error handler must narrow to genuine Zod
 * schema-validation failures — not to every error that happens to carry
 * statusCode 400 — because it forwards structured detail to the client.
 * Verified empirically (see errors.ts's comment) against the real
 * fastify-type-provider-zod validator: a Zod body-schema failure produces
 * error.code "FST_ERR_VALIDATION" with a populated `validation` array;
 * Fastify's own malformed-JSON error produces "FST_ERR_CTP_INVALID_JSON_BODY"
 * with no `validation` property, and must NOT be treated the same way.
 */
describe("registerErrorHandling — the 400 branch", () => {
  function buildProbeServer() {
    const server = Fastify({ logger: false });
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    registerErrorHandling(server);
    server.route({
      method: "POST",
      url: "/probe",
      schema: { body: z.object({ name: z.string().min(4) }) },
      handler: (_request, reply) => reply.send({ ok: true }),
    });
    return server;
  }

  it("forwards details for a genuine Zod validation failure", async () => {
    const server = buildProbeServer();
    const response = await server.inject({ method: "POST", url: "/probe", payload: { name: "ab" } });
    await server.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
    // The point of this test: real validation detail reaches the client.
    expect(response.json().error.details).toBeDefined();
    expect(response.json().error.details.length).toBeGreaterThan(0);
  });

  it("reports malformed JSON as a 400 client error, not a 500", async () => {
    const server = buildProbeServer();
    // Malformed JSON: Fastify's own content-type parser rejects this before
    // the Zod validator ever runs. Its error also carries statusCode 400,
    // which is exactly the case the old `error.statusCode === 400` check
    // could not distinguish from a real validation failure — but it is
    // still a genuine client mistake, and must be reported as one.
    const response = await server.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    await server.close();

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("invalid_request");
    // The load-bearing assertion: the parser's own error text
    // ("Body is not valid JSON but content-type is set to...") must not
    // reach the client.
    expect(JSON.stringify(body)).not.toMatch(/not valid JSON/);
  });

  it("reports a body over the size limit as 413, not a 500", async () => {
    const server = Fastify({ logger: false, bodyLimit: 16 });
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    registerErrorHandling(server);
    server.route({
      method: "POST",
      url: "/probe-body-limit",
      handler: (_request, reply) => reply.send({ ok: true }),
    });

    const response = await server.inject({
      method: "POST",
      url: "/probe-body-limit",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(64) }),
    });
    await server.close();

    expect(response.statusCode).toBe(413);
    const body = response.json();
    expect(body.error.code).toBe("payload_too_large");
  });

  it("reports an unsupported content type as 415, not a 500", async () => {
    const server = buildProbeServer();
    // Fastify has built-in parsers for application/json and text/plain, so
    // this needs a content type it has no parser registered for at all
    // (FST_ERR_CTP_INVALID_MEDIA_TYPE), not merely one that fails Zod's body
    // schema — that would just produce a 400 via the Zod branch above.
    const response = await server.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/x-not-a-registered-type" },
      payload: "whatever",
    });
    await server.close();

    expect(response.statusCode).toBe(415);
    const body = response.json();
    expect(body.error.code).toBe("unsupported_media_type");
  });

  it("still reports a genuine unexpected error as 500 internal_error", async () => {
    const server = Fastify({ logger: false });
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    registerErrorHandling(server);
    server.route({
      method: "GET",
      url: "/probe-throws",
      handler: () => {
        throw new Error("boom");
      },
    });

    const response = await server.inject({ method: "GET", url: "/probe-throws" });
    await server.close();

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toMatch(/boom/);
  });
});

/*
 * On the public surface a 400's details carry each issue's path and Zod's
 * code only, never a value the caller sent; the browser's routes keep Zod's
 * issues. Booleans for the markers.
 */
describe("registerErrorHandling — the public surface's validation details", () => {
  const MARKER = "MarkerValue175";
  // Built at run time, as every token in a test.
  const TOKEN = `tf_${randomBytes(32).toString("base64url")}`;
  const Body = z.object({ kind: z.enum(["read", "write"]), items: z.array(z.object({ size: z.number() }).strict()).optional() }).strict();
  const Query = z.object({ validate: z.enum(["true", "false"]).optional() }).strict();

  function buildServer() {
    const server = Fastify({ logger: false });
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    registerErrorHandling(server);
    for (const url of ["/api/public/v1/things", "/api/v1/things"]) {
      server.route({ method: "POST", url, schema: { body: Body, querystring: Query }, handler: async () => ({ ok: true }) });
    }
    return server;
  }

  const post = (server: ReturnType<typeof buildServer>, url: string, payload: unknown) =>
    server.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });

  it.each([
    ["a marker in an enum field", "/api/public/v1/things", { kind: MARKER }, [{ path: ["kind"], code: "invalid_enum_value" }]],
    ["a token in an enum field", "/api/public/v1/things", { kind: TOKEN }, [{ path: ["kind"], code: "invalid_enum_value" }]],
    ["a marker as an unknown key", "/api/public/v1/things", { kind: "read", [MARKER]: 1 }, [{ path: ["<unknown>"], code: "unrecognized_keys" }]],
    ["a token as an unknown key", "/api/public/v1/things", { kind: "read", [TOKEN]: 1 }, [{ path: ["<unknown>"], code: "unrecognized_keys" }]],
    [
      "a nested unknown key",
      "/api/public/v1/things",
      { kind: "read", items: [{ size: 1 }, { size: 2, [MARKER]: true }] },
      [{ path: ["items", 1, "<unknown>"], code: "unrecognized_keys" }],
    ],
    ["a marker in a query enum", `/api/public/v1/things?validate=${MARKER}`, { kind: "read" }, [{ path: ["validate"], code: "invalid_enum_value" }]],
    ["a marker in an absolute-form spelling", `http://x/API/public/v1/things?validate=${MARKER}`, { kind: "read" }, undefined],
  ])("answers %s with the path and the code only", async (_label, url, payload, details) => {
    const server = buildServer();
    const response = await post(server, url, payload);
    if (details === undefined) {
      // No route matches the absolute form here (the real server's verification answers it 401); whatever answers echoes nothing.
      expect(response.body.includes(MARKER)).toBe(false);
      return;
    }
    expect(response.statusCode).toBe(400);
    expect(response.body.includes(MARKER)).toBe(false);
    expect(response.body.includes(TOKEN.slice(3))).toBe(false);
    expect(response.json()).toEqual({ error: { code: "invalid_request", message: "The request was not valid.", details } });
  });

  it("names any path segment that isn't a schema's camelCase key <unknown>, whatever the issue", () => {
    const issueAt = (path: unknown[], code = "invalid_type") => ({ params: { issue: { code, path, received: MARKER, message: MARKER } } });
    const details = publicValidationDetails([
      issueAt(["labels", "my key", "value"]),
      issueAt(["env", TOKEN]),
      issueAt(["items", 3, "kebab-key"]),
      issueAt(["fine", 0, "camelCase"]),
    ]);
    expect(JSON.stringify(details).includes(MARKER)).toBe(false);
    expect(JSON.stringify(details).includes(TOKEN.slice(3))).toBe(false);
    expect(details).toEqual([
      { path: ["labels", "<unknown>", "value"], code: "invalid_type" },
      { path: ["env", "<unknown>"], code: "invalid_type" },
      { path: ["items", 3, "<unknown>"], code: "invalid_type" },
      { path: ["fine", 0, "camelCase"], code: "invalid_type" },
    ]);
  });

  it("keeps a browser route's details as before: Zod's issues, message and received included", async () => {
    const server = buildServer();
    const response = await post(server, "/api/v1/things", { kind: MARKER });
    expect(response.statusCode).toBe(400);
    const { details } = response.json<{ error: { details: Array<{ message: string; params: { issue: { received: unknown } } }> } }>().error;
    expect(details[0]!.params.issue.received === MARKER).toBe(true);
    expect(typeof details[0]!.message).toBe("string");
  });
});

/*
 * A public 400 `invalid_request` carries one of two shapes, Zod's
 * `{ path, code }` (above) or a route's or a service's own
 * `{ path, message }`. The fleets area's Zod-like entries (fieldDetail),
 * which the browser's screens read, become `{ path, message }` on the
 * public surface only.
 */
describe("registerErrorHandling — the public surface's refusal details", () => {
  const MESSAGE = "Not a variable this group's published version reads.";
  const errors: Record<string, () => AppError> = {
    fieldDetail: () => new AppError("invalid_request", "Refused.", 400, [fieldDetail(["env", 1, "name"], MESSAGE), fieldDetail("cursor", "Not a cursor.")]),
    pathMessage: () => new AppError("invalid_request", "The request was not valid.", 400, [{ path: ["distribution"], message: "Not its distribution." }]),
    object: () => new AppError("validation_rule_invalid", "Refused.", 400, { ruleIndex: 1, problems: ["x"] }),
    none: () => new AppError("invalid_request", "The request was not valid.", 400),
  };

  function buildServer() {
    const server = Fastify({ logger: false });
    registerErrorHandling(server);
    for (const prefix of ["/api/public/v1", "/api/v1"]) {
      server.get(`${prefix}/refusals/:kind`, (request) => {
        throw errors[(request.params as { kind: string }).kind]!();
      });
    }
    return server;
  }

  const detailsAt = async (url: string): Promise<unknown> => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url });
    await server.close();
    return response.json<{ error: { details?: unknown } }>().error.details;
  };

  it("answers the fleets area's entries as { path, message } on the public surface, any spelling of it", async () => {
    const expected = [
      { path: ["env", 1, "name"], message: MESSAGE },
      { path: ["cursor"], message: "Not a cursor." },
    ];
    expect(await detailsAt("/api/public/v1/refusals/fieldDetail")).toEqual(expected);
    expect(await detailsAt("/api/./public/v1/refusals/fieldDetail")).toEqual(expected);
  });

  it("keeps { path, message } entries, an object's details and none as they are on the public surface", async () => {
    expect(await detailsAt("/api/public/v1/refusals/pathMessage")).toEqual([{ path: ["distribution"], message: "Not its distribution." }]);
    expect(await detailsAt("/api/public/v1/refusals/object")).toEqual({ ruleIndex: 1, problems: ["x"] });
    expect(await detailsAt("/api/public/v1/refusals/none")).toBeUndefined();
  });

  it("keeps the browser's entries as they were: fieldDetail's Zod-like shape", async () => {
    expect(await detailsAt("/api/v1/refusals/fieldDetail")).toEqual([fieldDetail(["env", 1, "name"], MESSAGE), fieldDetail("cursor", "Not a cursor.")]);
  });

  it("maps only a well-formed fieldDetail entry: anything else passes through", () => {
    const odd = [{ keyword: "custom", message: "m", params: { issue: { path: [{}] } } }, { keyword: "other", message: "m", params: { issue: { path: ["a"] } } }, null, "text"];
    expect(publicRefusalDetails(odd)).toEqual(odd);
    expect(publicRefusalDetails("text")).toBe("text");
  });
});

describe("registerErrorHandling — AppError logging", () => {
  /** A server whose log lines are collected, and one route that throws the given error. */
  async function throwAndCollectLogs(error: AppError) {
    const lines: { level: number; msg: string; err?: { code?: string } }[] = [];
    const server = Fastify({
      logger: { level: "info", stream: { write: (line: string) => lines.push(JSON.parse(line)) } },
    });
    registerErrorHandling(server);
    server.get("/probe-app-error", () => {
      throw error;
    });
    const response = await server.inject({ method: "GET", url: "/probe-app-error" });
    await server.close();
    return { response, errorLines: lines.filter((line) => line.level >= 50) };
  }

  it("logs a 5xx AppError at error level, with the response body unchanged", async () => {
    const { response, errorLines } = await throwAndCollectLogs(
      new AppError("internal_error", "Something went wrong. Please try again.", 500),
    );

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "Something went wrong. Please try again." },
    });
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatchObject({ msg: "server error", err: { code: "internal_error" } });
  });

  it("does not log a 4xx AppError at error level", async () => {
    const { response, errorLines } = await throwAndCollectLogs(new AppError("unauthenticated", "You need to sign in.", 401));
    expect(response.statusCode).toBe(401);
    expect(errorLines).toHaveLength(0);
  });
});

/**
 * Fastify's framework errors (server.ts' `frameworkErrors`): a URL the
 * router refuses before any route or hook. Fastify's own reply quotes the
 * path, which may hold a quick-deploy link's secret; ours answers generic
 * words and logs the error's code, never the URL. On a path that may hold a
 * secret, the public route's plain text and headers; elsewhere the
 * envelope.
 */
describe("respondToFrameworkError", () => {
  const SECRET = "tqd_FRAMEWORKerrorCANARYframeworkERRORcanary0000";

  function buildProbeServer(lines: string[]) {
    const server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
      frameworkErrors: respondToFrameworkError,
    });
    registerErrorHandling(server);
    server.get("/api/v1/quick-deploy/:secret", (_request, reply) => reply.send("stand-in"));
    server.get("/api/v1/organizations/:organizationId", (_request, reply) => reply.send("stand-in"));
    return server;
  }

  async function probe(url: string) {
    const lines: string[] = [];
    const server = buildProbeServer(lines);
    const response = await server.inject({ method: "GET", url });
    await server.close();
    return { response, lines };
  }

  it.each([
    ["a malformed escape (FST_ERR_BAD_URL)", `/api/v1/quick-deploy/${SECRET}%zz`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a lone %", `/api/v1/quick-deploy/${SECRET}%`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a parameter over maxParamLength (FST_ERR_MAX_PARAM_LENGTH)", `/api/v1/quick-deploy/${SECRET}${"x".repeat(100)}`, 414, "The request's URL is too long.", "FST_ERR_MAX_PARAM_LENGTH"],
    ["another spelling of the path", `/api/v1/Quick-Deploy/${SECRET}%zz`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a secret in another route's parameter", `/api/v1/organizations/${SECRET}%zz`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
  ])("answers %s on a path that may hold a secret as the public route does: plain text, no-store, nosniff, no-referrer, quoting and logging no URL", async (_label, url, status, text, fastifyCode) => {
    const { response, lines } = await probe(url);
    expect({ status: response.statusCode, body: response.body }).toEqual({ status, body: `${text}\n` });
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes(SECRET))).toEqual([]);
    expect(lines.some((line) => line.includes(fastifyCode))).toBe(true);
  });

  it.each([
    ["a malformed escape (FST_ERR_BAD_URL)", "/api/v1/organizations/abc%zz", 400, "invalid_request", "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a parameter over maxParamLength (FST_ERR_MAX_PARAM_LENGTH)", `/api/v1/organizations/${"x".repeat(120)}`, 414, "uri_too_long", "The request's URL is too long.", "FST_ERR_MAX_PARAM_LENGTH"],
  ])("answers %s elsewhere with the envelope's generic words, as before", async (_label, url, status, code, message, fastifyCode) => {
    const { response, lines } = await probe(url);
    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.headers["referrer-policy"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBeUndefined();
    expect(response.json()).toEqual({ error: { code, message } });
    expect(lines.some((line) => line.includes(fastifyCode))).toBe(true);
  });

  it.each([
    ["a malformed escape", "/api/public/v1/fleets/abc%zz", 400, "invalid_request", "The request was not valid."],
    ["a parameter over maxParamLength", `/api/public/v1/fleets/${"x".repeat(120)}`, 414, "uri_too_long", "The request's URL is too long."],
    ["a malformed escape in another spelling", "/API/Public/v1/fleets/abc%zz", 400, "invalid_request", "The request was not valid."],
  ])("answers %s under /api/public/v1 with the envelope, no-store as every public reply", async (_label, url, status, code, message) => {
    const server = Fastify({ logger: false, frameworkErrors: respondToFrameworkError });
    registerErrorHandling(server);
    server.get("/api/public/v1/fleets/:fleetId", (_request, reply) => reply.send("stand-in"));
    server.get("/API/Public/v1/fleets/:fleetId", (_request, reply) => reply.send("stand-in"));
    const response = await server.inject({ method: "GET", url });
    await server.close();
    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: { code, message } });
  });

  /*
   * A path that may hold a library link answers the same plain text. The
   * canary is visibly fake (no key signed it) and is checked by booleans
   * only.
   */
  const LINK_BODY = `FAKE${"LinkCanary0".repeat(6)}abcdefg`;
  const LINK = `tll_${LINK_BODY}`;

  function buildLibraryProbeServer(lines: string[]) {
    const server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
      frameworkErrors: respondToFrameworkError,
    });
    registerErrorHandling(server);
    server.get("/api/v1/library-links/:link", (_request, reply) => reply.send("stand-in"));
    server.get("/api/v1/organizations/:organizationId", (_request, reply) => reply.send("stand-in"));
    return server;
  }

  it.each([
    ["a malformed escape", `/api/v1/library-links/${LINK}%zz`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a lone %", `/api/v1/library-links/${LINK}%`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a parameter over maxParamLength", `/api/v1/library-links/${LINK}${"x".repeat(100)}`, 414, "The request's URL is too long.", "FST_ERR_MAX_PARAM_LENGTH"],
    ["another spelling of the path", `/api/v1/Library-Links/${LINK}%zz`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a link in another route's parameter", `/api/v1/organizations/${LINK}%zz`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
    ["a link's prefix percent-encoded", `/api/v1/organizations/%74ll_${LINK_BODY}%zz`, 400, "The request was not valid.", "FST_ERR_BAD_URL"],
  ])("answers %s on a path that may hold a library link as the public route does: plain text, quoting and logging no link", async (_label, url, status, text, fastifyCode) => {
    const lines: string[] = [];
    const server = buildLibraryProbeServer(lines);
    const response = await server.inject({ method: "GET", url });
    await server.close();
    expect(response.statusCode).toBe(status);
    expect(response.body === `${text}\n`).toBe(true);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes(LINK_BODY))).toBe(false);
    expect(lines.some((line) => line.includes(fastifyCode))).toBe(true);
  });
});
