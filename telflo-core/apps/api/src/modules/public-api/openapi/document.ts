import { readFileSync } from "node:fs";
import { parse } from "yaml";

/*
 * The public surface's OpenAPI 3.1 document (D25 decision 49, Preflight
 * ruling 19): hand-written, one YAML fragment per area beside this file,
 * assembled once at start into one document, served at
 * `GET /api/public/v1/openapi.json` (open-routes.ts). A fragment holds only
 * `paths` and `components`; a path, or a component of any kind, named by
 * two fragments (or twice in one: yaml's unique keys) refuses the whole
 * document, so the server doesn't start with an ambiguous one. Every
 * operation carries `x-telflo-access` (read, write, or none for the open
 * routes), which the coverage test checks against each route's
 * `config.access`.
 */

/** The fragments, in the document's order: the shared components first, then each area's. */
export const PUBLIC_API_FRAGMENTS = [
  "common",
  "organizations",
  "configurations",
  "validation-pipelines",
  "validate",
  "ottl",
  "fleets",
  "flows",
  "test-runs",
] as const;

type JsonObject = Record<string, unknown>;

export interface PublicApiDocument extends JsonObject {
  openapi: string;
  paths: Record<string, Record<string, JsonObject>>;
  components: Record<string, Record<string, unknown>>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a fragment's text, by its name (tests pass their own reader). */
export type FragmentReader = (name: string) => string;

const readFragment: FragmentReader = (name) => readFileSync(new URL(`./${name}.yaml`, import.meta.url), "utf8");

/**
 * Assembles the fragments into one document. Throws, naming the fragment
 * and the key, on anything but `paths` and `components` at a fragment's
 * top, on a duplicate key within a fragment, and on a path or a component
 * two fragments define.
 */
export function assemblePublicApiDocument(
  names: readonly string[] = PUBLIC_API_FRAGMENTS,
  read: FragmentReader = readFragment,
): PublicApiDocument {
  const paths: PublicApiDocument["paths"] = {};
  const components: PublicApiDocument["components"] = {};
  for (const name of names) {
    const fragment: unknown = parse(read(name), { uniqueKeys: true });
    if (fragment === null || fragment === undefined) continue;
    if (!isObject(fragment)) throw new Error(`OpenAPI fragment ${name} is not a mapping`);
    for (const key of Object.keys(fragment)) {
      if (key !== "paths" && key !== "components") throw new Error(`OpenAPI fragment ${name} has an unexpected key: ${key}`);
    }
    const fragmentPaths = fragment.paths ?? {};
    if (!isObject(fragmentPaths)) throw new Error(`OpenAPI fragment ${name}'s paths is not a mapping`);
    for (const [path, item] of Object.entries(fragmentPaths)) {
      if (path in paths) throw new Error(`OpenAPI path ${path} is defined twice (again in ${name})`);
      if (!isObject(item)) throw new Error(`OpenAPI path ${path} in ${name} is not a mapping`);
      paths[path] = item as Record<string, JsonObject>;
    }
    const fragmentComponents = fragment.components ?? {};
    if (!isObject(fragmentComponents)) throw new Error(`OpenAPI fragment ${name}'s components is not a mapping`);
    for (const [kind, entries] of Object.entries(fragmentComponents)) {
      if (!isObject(entries)) throw new Error(`OpenAPI components.${kind} in ${name} is not a mapping`);
      const section = (components[kind] ??= {});
      for (const [entry, value] of Object.entries(entries)) {
        if (entry in section) throw new Error(`OpenAPI component ${kind}.${entry} is defined twice (again in ${name})`);
        section[entry] = value;
      }
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Telflo public API",
      version: "1",
      description:
        "The API for the CLI, CI and servers: configurations, validation, fleets, flows and test runs. " +
        "Authenticate with a `tf_` token; a personal token also names its organization in X-Telflo-Org.",
    },
    servers: [{ url: "/api/public/v1" }],
    security: [{ bearer: [], organization: [] }, { bearer: [] }],
    paths,
    components,
  };
}

let cached: { document: PublicApiDocument; json: string } | undefined;

/** The document, assembled once per process and kept. */
export function publicApiDocument(): PublicApiDocument {
  cached ??= assembled();
  return cached.document;
}

/** The document as served: its JSON text, made once. */
export function publicApiDocumentJson(): string {
  cached ??= assembled();
  return cached.json;
}

function assembled(): { document: PublicApiDocument; json: string } {
  const document = assemblePublicApiDocument();
  return { document, json: JSON.stringify(document) };
}
