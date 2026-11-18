import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { createDb, createPool } from "@telflo/db";
import {
  claimPublicSurface,
  isPublicRequestPath,
  isUnderPublicPrefix,
  normalizedRouteUrl,
  OPEN_PUBLIC_ROUTES,
  PUBLIC_API_PREFIX,
  registerPublicRouteGuard,
} from "./route-guard.js";

/*
 * The public surface's registration guard (D25 decision 13, Rulings 163
 * and 164; the request-time verification is route-verification.integration.test.ts): a route under /api/public/v1, in any spelling, that
 * isn't the public plugin's or an allowed open route refuses the server's
 * start (ready() rejects), on a bare Fastify with the guard and on the
 * real server.
 */

const opamp = useFakeOpampServer();

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
});

/** A bare server with the guard, then `register` run on it. */
async function readied(register: (server: FastifyInstance) => void): Promise<void> {
  const server = Fastify({ logger: false });
  servers.push(server);
  registerPublicRouteGuard(server);
  register(server);
  await server.ready();
}

const ok = async () => ({ ok: true });

describe("the root guard (D25 Ruling 163)", () => {
  it("lets the public plugin register anything under the prefix, its child plugins' routes included", async () => {
    await expect(
      readied((server) => {
        void server.register(
          async (api) => {
            claimPublicSurface(api, "plugin");
            api.get("/things", ok);
            await api.register(async (child) => {
              child.post("/things/upload", ok);
            });
          },
          { prefix: PUBLIC_API_PREFIX },
        );
      }),
    ).resolves.toBeUndefined();
  });

  it("lets the open plugin register its allowlist only, Task 7's /docs routes and D27's POST /validate/anonymous included", async () => {
    expect([...OPEN_PUBLIC_ROUTES].sort()).toEqual(
      [
        ...["/docs", "/docs/*", "/health", "/openapi.json"].flatMap((path) =>
          ["GET", "HEAD"].map((method) => `${method} /api/public/v1${path}`),
        ),
        "POST /api/public/v1/validate/anonymous",
      ].sort(),
    );
    await expect(
      readied((server) => {
        void server.register(
          async (open) => {
            claimPublicSurface(open, "open");
            for (const path of ["/health", "/openapi.json", "/docs", "/docs/*"]) open.get(path, ok);
            open.post("/validate/anonymous", ok);
          },
          { prefix: PUBLIC_API_PREFIX },
        );
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a data route added to the open plugin, a POST to an allowed path, and any other method of the anonymous validate's (D27 decision 23)", async () => {
    for (const add of [
      (open: FastifyInstance) => open.get("/configurations", ok),
      (open: FastifyInstance) => open.post("/health", ok),
      (open: FastifyInstance) => open.post("/validate", ok),
      (open: FastifyInstance) => open.get("/validate/anonymous", ok),
      (open: FastifyInstance) => open.put("/validate/anonymous", ok),
      (open: FastifyInstance) => open.route({ method: ["POST", "GET"], url: "/validate/anonymous", handler: ok }),
      (open: FastifyInstance) => open.post("/validate/anonymous/*", ok),
    ]) {
      await expect(
        readied((server) => {
          void server.register(
            async (open) => {
              claimPublicSurface(open, "open");
              add(open);
            },
            { prefix: PUBLIC_API_PREFIX },
          );
        }),
      ).rejects.toThrow("a route under /api/public/v1 must be the public plugin's or an allowed open route");
    }
  });

  it.each([
    ["the root", "/api/public/v1/x"],
    ["the prefix itself", "/api/public/v1"],
    ["upper case", "/API/Public/v1/x"],
    ["a doubled slash", "/api//public/v1/x"],
    ["a dot segment", "/api/./public/v1/x"],
    ["a parent segment", "/api/x/../public/v1/x"],
    ["an encoded letter", "/api/%70ublic/v1/x"],
    ["a wildcard", "/api/public/v1*"],
    // Ruling 164: a parameter or a wildcard that could match the prefix's segments.
    ["a parameter for public", "/api/:x/v1/escape"],
    ["a parameter for v1", "/api/public/:v/escape"],
    ["a parameter for api", "/:a/public/v1/escape"],
    ["a regex parameter", "/api/:x(^public$)/v1/escape"],
    ["a wildcard after api", "/api/*"],
    ["a wildcard after public", "/api/public/*"],
    ["a root wildcard", "/*"],
    ["a partial wildcard", "/api/pub*"],
  ])("refuses a route on %s under the prefix: %s", async (_label, url) => {
    await expect(readied((server) => void server.get(url, ok))).rejects.toThrow(
      "a route under /api/public/v1 must be the public plugin's or an allowed open route",
    );
  });

  it("refuses one in an unmarked plugin with the prefix, and lets every other route through", async () => {
    await expect(
      readied((server) => {
        void server.register(async (other) => void other.get("/x", ok), { prefix: PUBLIC_API_PREFIX });
      }),
    ).rejects.toThrow("must be the public plugin's");
    await expect(
      readied((server) => {
        server.get("/api/v1/auth/me", ok);
        server.get("/api/public/v", ok);
        // Ruling 164: segments that run out, or can't match, before the prefix's three.
        server.get("/api/:x", ok);
        server.get("/api/v1/*", ok);
        server.get("/api/public/v2/*", ok);
        // The root's CORS preflight, exactly (Ruling 163).
        server.options("*", ok);
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses any other route on *, and a GET on it", async () => {
    await expect(readied((server) => void server.get("*", ok))).rejects.toThrow("must be the public plugin's");
  });

  it("matches the prefix segment by segment: parameters match any, a wildcard everything after its start", () => {
    for (const url of ["/api/public/v1", "/api/:x/v1", "/:a/:b/:c/d", "/api/public/v1*", "/api/p*", "/*", "/API//Public/./v1/x"]) {
      expect([url, isUnderPublicPrefix(url)]).toEqual([url, true]);
    }
    for (const url of ["/api/:x", "/api/v1/*", "/api/public/v2", "/api/q*", "/health", "/api/public"]) {
      expect([url, isUnderPublicPrefix(url)]).toEqual([url, false]);
    }
  });

  it("takes a request's path under the prefix with a segment boundary, the request log's (Ruling 166)", () => {
    for (const url of [
      "/api/public/v1",
      "/api/public/v1/",
      "/api/public/v1/x?q=1",
      "/API/Public/V1/x",
      "/api//public/./v1/x",
      "/api/public/v1#x",
      // Ruling 173: an absolute-form target, a double encoding.
      "http://x/API/public/v1/nope?q=1",
      "/api/%2570ublic/v1/x",
    ]) {
      expect([url, isPublicRequestPath(url)]).toEqual([url, true]);
    }
    for (const url of ["/api/public/v1x", "/api/public/v10/x", "/api/public/v1x/y", "/api/public", "/api/v1/x"]) {
      expect([url, isPublicRequestPath(url)]).toEqual([url, false]);
    }
  });

  it("refuses a second claim on an instance that holds a surface, its own or a parent's", async () => {
    await expect(
      readied((server) => {
        void server.register(
          async (api) => {
            claimPublicSurface(api, "plugin");
            await api.register(async (child) => claimPublicSurface(child, "open"));
          },
          { prefix: PUBLIC_API_PREFIX },
        );
      }),
    ).rejects.toThrow("this instance already holds a public surface");
    await expect(
      readied((server) => {
        void server.register(async (open) => {
          claimPublicSurface(open, "open");
          claimPublicSurface(open, "plugin");
        });
      }),
    ).rejects.toThrow("this instance already holds a public surface");
  });

  it("normalizes a route's URL: decoded once, lower case, slashes collapsed, dot segments resolved", () => {
    expect(normalizedRouteUrl("/API//Public/./v1/x/../y")).toBe("/api/public/v1/y");
    expect(normalizedRouteUrl("api/%70ublic/v1")).toBe("/api/public/v1");
    expect(normalizedRouteUrl("/api/%2570ublic/v1")).toBe("/api/%70ublic/v1");
  });

  it("on the real server, with both guards, a not-found handler a plugin sets under the prefix answers nothing: the one 401 (Ruling 166)", async () => {
    const settings = loadSettings(process.env);
    const db = createDb(createPool(settings.databaseUrl));
    try {
      const server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
      });
      servers.push(server);
      // The reviewer's probe: it registers no route, so the registration guard has nothing to refuse.
      void server.register(async (plugin) => void plugin.setNotFoundHandler(async () => ({ escaped404: true })), {
        prefix: "/api/public/v1/x",
      });
      await server.ready();
      const refusal = JSON.stringify({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });
      for (const [method, url] of [
        ["GET", "/api/public/v1/x/anything"],
        ["POST", "/api/public/v1/x"],
        ["DELETE", "/api/public/v1/x/y/z"],
      ] as const) {
        const response = await server.inject({ method, url });
        // no-store as every public reply (Ruling 187).
        expect([method, url, response.statusCode, response.body === refusal, response.headers["cache-control"]]).toEqual([
          method,
          url,
          401,
          true,
          "no-store",
        ]);
      }
      // The root's not-found handler answers no public path either; outside the prefix, as before.
      const rootNotFound = await server.inject({ method: "GET", url: "/API/Public/V1/whoami" });
      expect(rootNotFound.statusCode === 401 && rootNotFound.body === refusal).toBe(true);
      expect(rootNotFound.headers["cache-control"]).toBe("no-store");
      expect((await server.inject({ method: "GET", url: "/api/public/v1x" })).statusCode).toBe(404);
    } finally {
      await db.destroy();
    }
  });

  it("is on the real server: a root route under the prefix refuses its start", async () => {
    const settings = loadSettings(process.env);
    const db = createDb(createPool(settings.databaseUrl));
    try {
      const server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
      });
      servers.push(server);
      // Refused as the route is added, or at the latest by ready(): either way the server never starts.
      await expect(
        (async () => {
          server.get("/API/public/v1/escape", ok);
          await server.ready();
        })(),
      ).rejects.toThrow("must be the public plugin's");
    } finally {
      await db.destroy();
    }
  });
});
