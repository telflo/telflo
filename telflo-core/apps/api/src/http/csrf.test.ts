import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerErrorHandling } from "../errors.js";
import { registerCsrfGuard } from "./csrf.js";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

describe("CSRF guard", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({ logger: false });
    registerErrorHandling(server);
    registerCsrfGuard(server);
    for (const url of ["/api/v1/probe", "/health", "/api/public/v1/probe"]) {
      server.route({
        method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        url,
        handler: (_request, reply) => reply.send({ ok: true }),
      });
    }
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  const send = (method: Method, url: string, headers: Record<string, string> = {}) =>
    server.inject({ method, url, headers });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("refuses %s under /api/v1/ without the header", async (method) => {
    const response = await send(method, "/api/v1/probe");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "csrf_header_missing", message: "This request is missing a required header." },
    });
  });

  it.each(["0", "true", "11", " 1", "yes"])("refuses a header value of %j", async (value) => {
    const response = await send("POST", "/api/v1/probe", { "x-telflo-csrf": value });
    expect(response.statusCode).toBe(403);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("allows %s with the header", async (method) => {
    const response = await send(method, "/api/v1/probe", { "X-Telflo-CSRF": "1" });
    expect(response.statusCode).toBe(200);
  });

  it("refuses an unknown route under the prefix too, before the not-found handler", async () => {
    const response = await send("DELETE", "/api/v1/does-not-exist");
    expect(response.statusCode).toBe(403);
  });

  it("does not guard GET", async () => {
    expect((await send("GET", "/api/v1/probe")).statusCode).toBe(200);
  });

  it("does not guard routes outside /api/v1/", async () => {
    expect((await send("POST", "/health")).statusCode).toBe(200);
    expect((await send("POST", "/api/public/v1/probe")).statusCode).toBe(200);
  });
});
