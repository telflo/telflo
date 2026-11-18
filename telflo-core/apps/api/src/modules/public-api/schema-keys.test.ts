import * as contracts from "@telflo/contracts";
import { createDb, createPool } from "@telflo/db";
import type { FastifyInstance, RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";

/*
 * D25 Ruling 176: a public 400's details name each issue's path, and
 * errors.ts shows a path segment as itself only when it looks like a
 * schema's camelCase key. That holds only while no public schema takes
 * KEYS from the caller: a record's (z.record), a map's (z.map) or an
 * object's catchall keys are caller text, which a camelCase-shaped value
 * would pass through. So every public schema a caller's request is checked
 * against is walked, the contracts' request-side Public…Schema exports
 * (requests, queries, params, a version's number, a pipeline's name) and
 * the body, query, params and headers schemas the real server's public
 * routes register, and none may hold one. Replies aren't validated against
 * the caller, so a reply's record (a run's mutation details) is outside.
 */

const opamp = useFakeOpampServer();

const ADVICE =
  "a public schema takes keys from the caller: mask such keys in errors.ts' publicValidationDetails before adding it (Ruling 176)";

/** The places in `schema` (a dotted trail) that take keys from the caller. */
function callerKeyedPlaces(schema: z.ZodTypeAny, trail = "", seen = new Set<z.ZodTypeAny>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const walk = (inner: z.ZodTypeAny, step: string) => callerKeyedPlaces(inner, `${trail}${step}`, seen);
  if (schema instanceof z.ZodRecord || schema instanceof z.ZodMap) return [trail || "(root)"];
  if (schema instanceof z.ZodObject) {
    const places: string[] = [];
    const catchall = schema._def.catchall as z.ZodTypeAny;
    if (!(catchall instanceof z.ZodNever)) places.push(`${trail}.(catchall)`);
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) places.push(...walk(value, `.${key}`));
    return places;
  }
  if (schema instanceof z.ZodArray) return walk(schema.element, "[]");
  if (schema instanceof z.ZodSet) return walk(schema._def.valueType, "[]");
  if (schema instanceof z.ZodTuple) return (schema.items as z.ZodTypeAny[]).flatMap((item, index) => walk(item, `[${index}]`));
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    return (schema.options as z.ZodTypeAny[]).flatMap((option, index) => walk(option, `|${index}`));
  }
  if (schema instanceof z.ZodIntersection) return [...walk(schema._def.left, "&0"), ...walk(schema._def.right, "&1")];
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return walk(schema.unwrap(), "");
  if (schema instanceof z.ZodDefault) return walk(schema._def.innerType, "");
  if (schema instanceof z.ZodCatch) return walk(schema._def.innerType, "");
  if (schema instanceof z.ZodReadonly) return walk(schema._def.innerType, "");
  if (schema instanceof z.ZodBranded) return walk(schema.unwrap(), "");
  if (schema instanceof z.ZodEffects) return walk(schema.innerType(), "");
  if (schema instanceof z.ZodPipeline) return [...walk(schema._def.in, ""), ...walk(schema._def.out, "")];
  if (schema instanceof z.ZodLazy) return walk(schema.schema, "");
  if (schema instanceof z.ZodPromise) return walk(schema.unwrap(), "");
  return [];
}

describe("no public schema takes keys from the caller (D25 Ruling 176)", () => {
  const routeSchemas: Array<[string, z.ZodTypeAny]> = [];
  let server: FastifyInstance;
  let destroy: () => Promise<void>;

  beforeAll(async () => {
    const settings = loadSettings(process.env);
    const db = createDb(createPool(settings.databaseUrl));
    destroy = () => db.destroy();
    server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings,
      db,
      mailer: createInMemoryMailer(),
      rateLimits: TEST_RATE_LIMITS,
    });
    // Before ready: the public plugin registers its routes as the server readies, under this root hook too.
    server.addHook("onRoute", (route: RouteOptions) => {
      if (!route.url.toLowerCase().startsWith("/api/public/v1")) return;
      const schema = (route.schema ?? {}) as Record<string, unknown>;
      for (const part of ["body", "querystring", "params", "headers"]) {
        if (schema[part] instanceof z.ZodType) routeSchemas.push([`${String(route.method)} ${route.url} ${part}`, schema[part] as z.ZodTypeAny]);
      }
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await destroy();
  });

  it("the walk finds a record, a map and a catchall wherever they sit", () => {
    const sample = z
      .object({
        labels: z.record(z.string()).optional(),
        rules: z.array(z.object({ byName: z.map(z.string(), z.number()) })),
        extra: z.object({ name: z.string() }).catchall(z.string()),
        choice: z.union([z.object({ a: z.string() }), z.object({ b: z.lazy(() => z.record(z.number())) })]),
        piped: z.string().transform((value) => value.length),
      })
      .strict();
    expect(callerKeyedPlaces(sample).sort()).toEqual([".choice|1.b", ".extra.(catchall)", ".labels", ".rules[].byName"]);
    expect(callerKeyedPlaces(z.object({ a: z.string(), b: z.array(z.number()) }).strict())).toEqual([]);
  });

  it("holds for every request-side Public…Schema the contracts export", () => {
    const schemas = Object.entries(contracts).filter(
      (entry): entry is [string, z.ZodTypeAny] =>
        /^Public.*(Request|Query|Params|Number|Name)Schema$/.test(entry[0]) && entry[1] instanceof z.ZodType,
    );
    expect(schemas.length).toBeGreaterThan(10);
    const offenders = schemas.flatMap(([name, schema]) => callerKeyedPlaces(schema).map((place) => `${name}${place}`));
    expect(offenders, ADVICE).toEqual([]);
  });

  it("holds for the body, query, params and headers of every route the real server registers under /api/public/v1", () => {
    expect(routeSchemas.length).toBeGreaterThan(10);
    const offenders = routeSchemas.flatMap(([name, schema]) => callerKeyedPlaces(schema).map((place) => `${name}${place}`));
    expect(offenders, ADVICE).toEqual([]);
  });
});
