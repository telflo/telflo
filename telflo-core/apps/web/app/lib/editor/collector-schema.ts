import type { JSONSchema, MonacoYamlOptions } from "monaco-yaml";

/*
 * Which collector schema the YAML tab's Monaco uses, and the options
 * monaco-yaml gets for it. Type imports only: nothing here loads Monaco or
 * monaco-yaml, so the schema tests (app/test/schema-worker.ts) build their
 * worker from the same options the editor gives.
 *
 * The pin on screen picks the schema: an offered version of a distribution
 * that has schemas gets `public/schemas/<distribution>/v<version>.json`, the
 * file the generator wrote for it; a null pin, a retired one, a version the
 * catalog doesn't list, or a distribution without schemas gets syntax
 * only. The versions are read from the catalog when the web is built, as
 * the renames are (`renamed-types.ts`), so the choice is synchronous and
 * never asks the API.
 */

/** The distributions whose offered versions each have a generated schema (contrib only). */
export const SCHEMA_DISTRIBUTIONS: ReadonlySet<string> = new Set(["otelcol-contrib"]);

/** The part of a catalog file's version this reads. */
export interface SchemaCatalogueVersion {
  version: string;
  deprecated: boolean;
}

/** Each catalog file's `versions`, by the file's path, as Vite bundles them. */
const CATALOGUE_VERSION_FILES = import.meta.glob<unknown>("../../../../../../catalog/distributions/*.json", {
  eager: true,
  import: "versions",
});

/**
 * Each distribution's versions (the file's name → its `versions`), checked.
 * A file without a valid list throws, naming it, and so does no file at all
 * (the glob matched nothing: `catalog/` missing where the web is built), as
 * `readRenamedTypes` does.
 */
export function readSchemaCatalogue(files: Readonly<Record<string, unknown>>): Readonly<Record<string, readonly SchemaCatalogueVersion[]>> {
  if (Object.keys(files).length === 0) {
    throw new Error("The collector catalogue's distribution files weren't found: catalog/distributions/*.json matched nothing.");
  }
  const byDistribution: Record<string, readonly SchemaCatalogueVersion[]> = {};
  for (const [path, versions] of Object.entries(files)) {
    const distribution = path.replace(/^.*\//, "").replace(/\.json$/, "");
    const entries = Array.isArray(versions) ? versions.map(catalogueVersion) : [undefined];
    if (entries.some((entry) => entry === undefined)) {
      throw new Error(`The collector catalogue's ${distribution}.json has no valid versions list.`);
    }
    byDistribution[distribution] = entries as SchemaCatalogueVersion[];
  }
  return byDistribution;
}

/** `value` as a catalog version, or undefined when it isn't one. */
function catalogueVersion(value: unknown): SchemaCatalogueVersion | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, deprecated } = value as Record<string, unknown>;
  if (typeof version !== "string" || typeof deprecated !== "boolean") return undefined;
  return { version, deprecated };
}

/** Every distribution's versions, as the catalog lists them. */
export const SCHEMA_CATALOGUE = readSchemaCatalogue(CATALOGUE_VERSION_FILES);

/**
 * The app-relative path of the schema for `distribution` pinned to `pin`
 * (`/schemas/otelcol-contrib/v0.162.0.json`), or null for syntax only: a
 * null distribution or pin, a distribution not in `SCHEMA_DISTRIBUTIONS` or
 * not in the catalog, a version the catalog doesn't list, or a retired
 * (deprecated) one.
 */
export function schemaPathFor(
  distribution: string | null,
  pin: string | null,
  catalogue: Readonly<Record<string, readonly SchemaCatalogueVersion[]>> = SCHEMA_CATALOGUE,
): string | null {
  if (distribution === null || pin === null) return null;
  if (!SCHEMA_DISTRIBUTIONS.has(distribution) || !Object.hasOwn(catalogue, distribution)) return null;
  const offered = catalogue[distribution]!.some((entry) => entry.version === pin && !entry.deprecated);
  return offered ? `/schemas/${distribution}/v${pin}.json` : null;
}

/** A schema as monaco-yaml takes it inline: where it came from, and its content. */
export interface CollectorSchemaEntry {
  /** The schema's URI (the editor's: the app's origin and the schema's path). Never fetched: schema requests are off. */
  uri: string;
  schema: JSONSchema;
}

/**
 * The options monaco-yaml gets for `entry`, or for syntax only when it is
 * null: the one place they are written. The editor passes exactly this to
 * `configureMonacoYaml` and `update`; the schema tests build their worker
 * from it.
 *
 * With a schema: completion and hover on, hover without the "Source:
 * v0.162.0.json" link, the schema inline and matched to every model
 * (`fileMatch: ["*"]`, since the model has no `path`: it is
 * `inmemory://model/N`). Schema requests are off in both: with them on, a
 * `# yaml-language-server: $schema=<url>` line in a text made every viewer's
 * browser fetch that URL.
 *
 * Without one: YAML's syntax markers only; completion and hover off, since
 * the worker can echo a typed word when no schema matches.
 * `hoverSchemaSource` is written in both, as `update` merges into what was
 * there, so the options never depend on the pins before. `format: {}` leaves
 * monaco-yaml's formatter as it always was here.
 */
export function monacoYamlOptions(entry: CollectorSchemaEntry | null): MonacoYamlOptions {
  if (entry === null) {
    return {
      validate: true,
      completion: false,
      hover: false,
      hoverSchemaSource: false,
      format: {},
      enableSchemaRequest: false,
      schemas: [],
    };
  }
  return {
    validate: true,
    completion: true,
    hover: true,
    hoverSchemaSource: false,
    format: {},
    enableSchemaRequest: false,
    schemas: [{ uri: entry.uri, fileMatch: ["*"], schema: entry.schema }],
  };
}
