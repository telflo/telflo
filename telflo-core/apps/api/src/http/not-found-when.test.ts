import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerErrorHandling } from "../errors.js";
import { notFoundWhen } from "./not-found-when.js";

/*
 * notFoundWhen (D36-1 decision 31, Preflight ruling 7): off, a route answers
 * as a path no route serves, and nothing after the gate runs (the next
 * hook, the body's limit, the handler); on, the route answers as before.
 */
describe("notFoundWhen", () => {
  let server: FastifyInstance;
  const ran: string[] = [];

  beforeAll(async () => {
    server = Fastify({ logger: false });
    registerErrorHandling(server);
    for (const [url, off] of [
      ["/api/v1/switched-off", true],
      ["/api/v1/switched-on", false],
    ] as const) {
      server.route({
        method: ["GET", "POST"],
        url,
        bodyLimit: 16,
        onRequest: [notFoundWhen(off), async () => void ran.push(`limit ${url}`)],
        handler: (_request, reply) => {
          ran.push(`handler ${url}`);
          return reply.send({ ok: true });
        },
      });
    }
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it.each(["GET", "POST"] as const)("off: %s answers exactly as an unknown path, and nothing after the gate runs", async (method) => {
    ran.length = 0;
    const gated = await server.inject({ method, url: "/api/v1/switched-off?q=1" });
    const unknown = await server.inject({ method, url: "/api/v1/never-registered?q=1" });

    expect(gated.statusCode).toBe(404);
    // sendNotFound's words, the path as the request log spells it (here, with its query).
    expect(gated.json()).toEqual({ error: { code: "not_found", message: `No route for ${method} /api/v1/switched-off?q=1` } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: { code: "not_found", message: `No route for ${method} /api/v1/never-registered?q=1` } });
    expect(ran).toEqual([]);
  });

  it("off: answers 404 before the body's limit, however large the body", async () => {
    ran.length = 0;
    const gated = await server.inject({
      method: "POST",
      url: "/api/v1/switched-off",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(1024) }),
    });

    expect(gated.statusCode).toBe(404);
    expect(gated.json()).toMatchObject({ error: { code: "not_found" } });
    expect(ran).toEqual([]);
  });

  it("on: the route's own hooks and handler run, as before", async () => {
    ran.length = 0;
    const open = await server.inject({ method: "GET", url: "/api/v1/switched-on" });

    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ ok: true });
    expect(ran).toEqual(["limit /api/v1/switched-on", "handler /api/v1/switched-on"]);
  });
});
