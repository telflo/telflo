import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/*
 * One JSON Schema per offered collector version, for the YAML tab's Monaco
 * (D13c decision 1), generated from upstream's own component schemas:
 *
 *   npm run generate:otelcol-schemas --workspace=@telflo/web
 *
 * For each distribution and offered version in `otelcol-schemas/inputs.json`
 * (Preflight ruling 2), the script fetches, by sparse shallow clone, the
 * `config.schema.yaml` and `metadata.yaml` files of contrib and core at the
 * version's tags and the release manifest, refuses a checkout whose HEAD
 * isn't the pinned commit, and writes
 * `public/schemas/<distribution>/v<version>.json`, committed (decision 6).
 * Nothing else reaches the network: CI, the tests and the build read the
 * committed files. The same inputs always give the same bytes.
 *
 * What a schema says (decisions 5-10, Preflight rulings 4, 5 and 8):
 * - each section offers the components the manifest builds, under the type
 *   names their `metadata.yaml` gives (`properties`); an instance id
 *   (`otlp/2`) and every `deprecated_type` alias are accepted through
 *   `patternProperties` only, so completion never offers them;
 * - upstream's `$ref`s are resolved, `allOf` is flattened into its object,
 *   and every object is closed, except a map upstream declares as one and
 *   the open parts: what upstream doesn't describe (no schema, a reference
 *   to a definition it never wrote, a Go type it only names), what it
 *   describes wrongly, and a key the collector reads by hand that upstream
 *   omits (a key the collector only ignores stays flagged), each listed with its
 *   reason in `otelcol-schemas/open-parts.json` (decision 4). A new dangling
 *   reference, a component upstream describes no settings of that neither
 *   list names, or an entry no longer used, stops the run;
 * - a section upstream marks `x-optional` (a configoptional.Optional, whose
 *   Unmarshal reads and deletes `enabled`) accepts `enabled` where it is
 *   optional: a definition used both ways gets an optional copy;
 * - a setting upstream names with a capital letter is a Go field's name,
 *   which the collector reads only where its tag gives no name: the run
 *   stops on one unless open-parts.json lists it as read by that name, or
 *   drops it as a `,remain` map, whose keys are the object's other keys
 *   and whose values are what those keys hold;
 * - what the collector accepts is never warned about: a `${…}` reference
 *   for every setting that isn't a string and in a setting with an enum,
 *   null for every component and every map or list, a plain string for a
 *   list of strings, an integer for a duration. Scalars aren't nullable
 *   (completion would offer null for every value);
 * - the service section and the components that take no settings are
 *   written by hand (`otelcol-schemas/hand-written.json`, decision 9), a
 *   component without settings closed: an empty map, null or a reference.
 *
 * The run writes nothing until every version is generated, and then each
 * file through a temporary file renamed into place.
 *
 * Definitions get readable names (a type mismatch on a referenced object
 * names its definition, and an array item's completion shows it), and
 * `x-*` extensions, `format` and titles are dropped.
 */

/** The command that writes the schemas. */
export const GENERATE_OTELCOL_SCHEMAS_SCRIPT = "npm run generate:otelcol-schemas --workspace=@telflo/web";

/** The generator, from the repository's root, as each schema's `$comment` names it. */
const GENERATOR_PATH = "telflo-core/apps/web/scripts/generate-otelcol-schemas.ts";

/** The component kinds, as `metadata.yaml`'s `status.class` names them; a section is the plural. */
export const COMPONENT_KINDS = ["receiver", "processor", "exporter", "extension", "connector"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** The two upstream repositories whose schema files are read. */
export type UpstreamRepository = "contrib" | "core";
const UPSTREAM_REPOSITORIES: readonly UpstreamRepository[] = ["contrib", "core"];

/** A repository at a tag, pinned to its commit. */
export interface PinnedSource {
  /** `owner/name` on GitHub. */
  repository: string;
  tag: string;
  commit: string;
}

/** One offered version's sources. */
export interface VersionSources {
  contrib: PinnedSource;
  core: PinnedSource;
  releases: PinnedSource;
}

/** A component the manifest builds from outside contrib and core: no schema, known by its type. */
export interface ExternalComponent {
  module: string;
  kind: ComponentKind;
  type: string;
  repository: string;
}

/** One distribution's inputs. */
export interface DistributionInputs {
  /** The release manifest's path in the releases repository. */
  manifest: string;
  /** Each upstream repository's Go module path, which `$ref`s and the manifest name it by. */
  modules: Record<UpstreamRepository, string>;
  external: ExternalComponent[];
  versions: Record<string, VersionSources>;
}

/** `otelcol-schemas/inputs.json`. */
export interface SchemaInputs {
  distributions: Record<string, DistributionInputs>;
}

/**
 * An entry of `otelcol-schemas/open-parts.json` (decision 4): a definition
 * (`core/config/confighttp.client_config`: the repository, the package's
 * path, a `.`, the definition's name; a name ending in `*` names every
 * definition of that file whose name starts with what precedes it; the
 * repository and the package's path alone for a file's root,
 * `contrib/receiver/receivercreator`), a whole component upstream describes
 * none of the settings of (`exporter/datadog`), or a part of either at `path`
 * (`trace_statements.[]`: `.`-separated keys, `[]` a list's items, `*` a map's
 * values; a component's path goes through the definitions it refers to, a
 * definition's stays inside it). `versions` limits it to those versions; it
 * applies to every one otherwise. How it is opened (`open`):
 * - "unknown keys": an object keeps its settings and accepts any other key;
 * - "any value": the type is dropped altogether;
 * - "any casing": an enum accepts its values in any casing (Go lowercases it
 *   before checking), completion still offering them;
 * - "any string": an enum's values are only suggestions (Go never checks
 *   them), any string accepted;
 * - "strings take any scalar": every string setting the definition writes
 *   itself (through lists, maps and embedded definitions, not through a
 *   `$ref`) also accepts a number or true/false, as yaml.v2 reads a scalar's
 *   text into a Go string.
 */
export interface OpenPart {
  definition?: string;
  component?: string;
  path?: string;
  versions?: string[];
  open: OpenKind;
  reason: string;
}

/**
 * How an open part is opened (see {@link OpenPart}), and two more:
 * - "unknown keys in its place": `path` names a setting of the definition's
 *   own that upstream named after a Go field tagged `,remain` (a map that
 *   holds the object's other keys); the setting is dropped and any other
 *   key of the object holds what the map's values are (a map, for
 *   tail_sampling's `map[string]map[string]any`), wherever the definition
 *   is used or embedded;
 * - "a string too": the part keeps what upstream says and also accepts a
 *   plain string (a list item Go reads either way).
 */
export type OpenKind =
  | "unknown keys"
  | "any value"
  | "any casing"
  | "any string"
  | "strings take any scalar"
  | "unknown keys in its place"
  | "a string too";

/**
 * An entry of open-parts.json's `capitalisedKeys`: settings a definition (or
 * an object inside one, as the run's message names it) has whose names start
 * with a capital letter, which the collector reads by those names (a Go field
 * tagged with no name, matched case-sensitively), with why.
 */
export interface CapitalisedKeys {
  definition: string;
  keys: string[];
  versions?: string[];
  reason: string;
}

/** A JSON value, as the schemas hold them. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A node of the generated schema. */
export type Schema = { [key: string]: Json };

/** `otelcol-schemas/hand-written.json`. */
export interface HandWritten {
  service: Schema;
  /** Definitions the service refers to, by name. */
  definitions: Record<string, Schema>;
  /** The components that take no settings (`connector/forward`), each with its description. */
  withoutSettings: Record<string, string>;
}

/** Everything one schema is generated from. */
export interface SchemaRequest {
  distribution: string;
  version: string;
  /** The checked-out contrib and core trees. */
  trees: Record<UpstreamRepository, string>;
  /** The release manifest's text. */
  manifest: string;
  inputs: DistributionInputs;
  openParts: readonly OpenPart[];
  capitalisedKeys: readonly CapitalisedKeys[];
  handWritten: HandWritten;
}

/** A run that found what it can't decide: each problem on its own line. */
export class SchemaGenerationError extends Error {
  constructor(
    readonly where: string,
    readonly problems: readonly string[],
  ) {
    super(`${where}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "SchemaGenerationError";
  }
}

/** A reference's value pattern: a string holding `${`, which the collector expands. */
export const REFERENCE_PATTERN = "\\$\\{";

/**
 * What a wrong value is told, by the type it should have been (Preflight
 * ruling 8): a scalar's or a list's `errorMessage`, which the language
 * service shows for a string without `${` and for a value of another type
 * alike; a map's `patternErrorMessage`, as a map's `errorMessage` would
 * replace "Property x is not allowed." too.
 */
export const VALUE_MESSAGES = {
  integer: "Expected an integer or a ${…} reference.",
  number: "Expected a number or a ${…} reference.",
  boolean: "Expected true, false or a ${…} reference.",
  map: "Expected a map or a ${…} reference.",
  list: "Expected a list or a ${…} reference.",
  listOfStrings: "Expected a list or a string.",
  duration: "Expected a duration (30s, 5m) or an integer.",
} as const;

/** The setting every optional section (`x-optional`) accepts: configoptional's Unmarshal reads it as a bool and deletes it. */
const OPTIONAL_ENABLED: Schema = {
  description:
    "Whether this optional section is on: false turns it off, whatever else it sets; true, or leaving it out, turns it on.",
  type: ["boolean", "string"],
  pattern: REFERENCE_PATTERN,
  errorMessage: VALUE_MESSAGES.boolean,
};

/** What an optional copy's address (and its readable name) ends with. */
const OPTIONAL_SUFFIX = "_optional";

/** Whether a generated node is an object (a map, null or a reference): what an optional section can be. */
function isObjectNode(node: Schema): boolean {
  return Array.isArray(node.type) && node.type.includes("object");
}

/**
 * Whether a generated object already has `enabled`: upstream writes it itself
 * for some optional sections (confighttp's keepalive from 0.160.0), the one
 * configoptional reads, as Go refuses an Optional whose type has its own.
 */
function describesEnabled(node: Schema): boolean {
  return isRecord(node.properties) && Object.hasOwn(node.properties, "enabled");
}

/** An object (a generated one) accepting `enabled`, as an optional section does. */
function withEnabled(schema: Schema): Schema {
  return { ...schema, properties: { ...(schema.properties as Schema | undefined), enabled: OPTIONAL_ENABLED } };
}

/** A Go field's name, as upstream writes a field whose tag gives none: it starts with a capital letter. */
function isGoFieldName(key: string): boolean {
  return /^[A-Z]/.test(key);
}

/** A component's, a map's or a list's types: null is `otlp:`, a string a reference. */
const MAP_TYPES = ["object", "string", "null"];
const LIST_TYPES = ["array", "string", "null"];

/** A definition upstream writes, located: its repository, its package's path and its name; `ROOT` is the file's root. */
interface Target {
  repository: UpstreamRepository;
  pkg: string;
  definition: string;
}
const ROOT = "";

/** `contrib/pkg/stanza/operator/helper.byte_size`, or `contrib/internal/healthcheck` for a root. */
function addressOf(target: Target): string {
  const where = `${target.repository}/${target.pkg}`;
  return target.definition === ROOT ? where : `${where}.${target.definition}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An open node: any value, with upstream's description and why it's open. */
function openNode(description: unknown, reason: string): Schema {
  const node: Schema = { $comment: `Open: ${reason}` };
  if (typeof description === "string") node.description = description;
  return node;
}

/** An open component: a map (or null, or a reference) with any keys. */
function openComponent(description: unknown, reason: string): Schema {
  return { type: MAP_TYPES, pattern: REFERENCE_PATTERN, patternErrorMessage: VALUE_MESSAGES.map, ...openNode(description, reason) };
}

/** A string setting that also takes any other scalar (a number, true or false), never a map, a list or null. */
function scalarString(node: Schema): Schema {
  const { type: _type, ...rest } = node;
  return { ...rest, anyOf: [{ type: "string" }, { not: { type: ["object", "array", "null", "string"] } }] };
}

/** Whether `node` is a plain string setting (suggested values at most): no enum, no pattern, no other type. */
function isPlainString(node: Schema): boolean {
  return node.type === "string" && Object.keys(node).every((key) => ["type", "description", "default", "examples", "$comment"].includes(key));
}

/**
 * `node` with every plain string setting it writes itself (through its
 * settings, a list's items and a map's values, never through a `$ref`) taking
 * any scalar; `node` itself when it has none.
 */
function scalarStrings(node: Schema): Schema {
  if (isPlainString(node)) return scalarString(node);
  if (typeof node.$ref === "string") return node;
  let changed = false;
  const visit = (child: Json): Json => {
    if (!isRecord(child)) return child;
    const result = scalarStrings(child as Schema);
    if (result !== child) changed = true;
    return result;
  };
  const result: Schema = { ...node };
  if (isRecord(node.properties)) {
    result.properties = Object.fromEntries(Object.entries(node.properties as Schema).map(([key, child]) => [key, visit(child)]));
  }
  if (isRecord(node.additionalProperties)) result.additionalProperties = visit(node.additionalProperties);
  if (isRecord(node.items)) result.items = visit(node.items);
  return changed ? result : node;
}

/**
 * A pattern matching each of `values` in any casing, or a `${…}` reference.
 * The language service reads a leading `(?i)` as the `i` flag
 * (safeCreateUnicodeRegExp), which with its `u` flag also folds the Kelvin
 * sign to k, as Go's strings.ToLower does.
 */
function anyCasingPattern(values: readonly string[]): string {
  return `(?i)^(?:${values.map(escapeRegExp).join("|")})$|${REFERENCE_PATTERN}`;
}

/** The values of an enum setting as `string()` writes it, or undefined for anything else. */
function enumValues(node: Schema): string[] | undefined {
  const first = Array.isArray(node.anyOf) ? node.anyOf[0] : undefined;
  return isRecord(first) && Array.isArray(first.enum) && first.enum.every((value) => typeof value === "string")
    ? (first.enum as string[])
    : undefined;
}

/** `value` with every object's keys sorted (by code point, so no locale changes the bytes). */
export function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) sorted[key] = sortKeys(value[key]!);
  return sorted;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The flattened object an upstream node describes (Preflight ruling 4). */
interface ObjectView {
  properties: Record<string, Schema>;
  map: Schema | undefined;
  /** Why unknown keys are accepted, or undefined when they aren't. */
  openBecause: string | undefined;
  /** Why the object's other keys take `map`'s values: a `,remain` map dropped in its place. */
  otherKeys?: string | undefined;
}

/** One schema's generation. */
class Generation {
  private readonly files = new Map<string, Record<string, unknown> | null>();
  /** Each emitted definition by its address; null while it is being built (a recursive reference). */
  private readonly definitions = new Map<string, Schema | null>();
  /** Definitions with a fixed name: the components' roots. */
  private readonly fixedNames = new Map<string, string>();
  private readonly dangling = new Map<string, Set<string>>();
  private readonly used = new Set<OpenPart | CapitalisedKeys>();
  private readonly problems: string[] = [];
  private readonly parts: readonly OpenPart[];
  private readonly capitalised: readonly CapitalisedKeys[];
  /** The references through an `x-optional` setting, each to its definition until optionalSections() points it at the optional copy. */
  private readonly optionalReferences: { reference: Schema; address: string; from: string }[] = [];
  /** Each optional copy's address, with its definition's. */
  private readonly optionalCopies = new Map<string, string>();

  constructor(private readonly request: SchemaRequest) {
    const applies = (entry: { versions?: string[] }) => !entry.versions || entry.versions.includes(request.version);
    this.parts = request.openParts.filter(applies);
    this.capitalised = request.capitalisedKeys.filter(applies);
  }

  run(): string {
    const { request } = this;
    const sections: Record<string, Json> = {};
    for (const kind of COMPONENT_KINDS) sections[`${kind}s`] = this.section(kind);
    this.optionalSections();
    this.openPaths();
    this.reportLeftovers();
    if (this.problems.length > 0) {
      throw new SchemaGenerationError(`${request.distribution} ${request.version}`, this.problems);
    }

    const names = this.readableNames();
    const $defs: Record<string, Json> = {};
    for (const [address, schema] of this.definitions) $defs[names.get(address)!] = schema;
    for (const [name, schema] of Object.entries(request.handWritten.definitions)) $defs[name] = schema;
    const schema: Schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $comment: sourcesComment(request),
      type: "object",
      properties: { ...sections, service: request.handWritten.service },
      additionalProperties: false,
      $defs,
    };
    renameReferences(schema, names);
    pruneDefinitions(schema);
    return JSON.stringify(sortKeys(schema));
  }

  // ---------- upstream's files ----------

  /** A package's `config.schema.yaml`, parsed, or null when it has none. */
  private file(repository: UpstreamRepository, pkg: string): Record<string, unknown> | null {
    const key = `${repository}/${pkg}`;
    if (!this.files.has(key)) {
      const file = path.join(this.request.trees[repository], pkg, "config.schema.yaml");
      const parsed: unknown = existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : null;
      this.files.set(key, isRecord(parsed) ? parsed : null);
    }
    return this.files.get(key)!;
  }

  /**
   * A `$ref` as upstream writes it (Preflight ruling 4), from a file of
   * `at`: a bare `<def>` (the same file), `./<rel>.<def>` (relative to the
   * file's package), `/<pkg>.<def>` (the file's repository) or
   * `<module>/<pkg>.<def>` (contrib's or core's module), split at the last
   * `.`.
   */
  private parseReference(at: Target, reference: string): Target {
    if (/^\w+$/.test(reference)) return { repository: at.repository, pkg: at.pkg, definition: reference };
    const dot = reference.lastIndexOf(".");
    const where = reference.slice(0, dot);
    const definition = reference.slice(dot + 1);
    if (dot > 0 && /^\w+$/.test(definition)) {
      if (where.startsWith("./") || where.startsWith("../")) {
        return { repository: at.repository, pkg: path.posix.normalize(path.posix.join(at.pkg, where)), definition };
      }
      if (where.startsWith("/")) return { repository: at.repository, pkg: where.slice(1), definition };
      for (const repository of UPSTREAM_REPOSITORIES) {
        const module = `${this.request.inputs.modules[repository]}/`;
        if (where.startsWith(module)) return { repository, pkg: where.slice(module.length), definition };
      }
    }
    throw new SchemaGenerationError(`${this.request.distribution} ${this.request.version}`, [
      `${addressOf(at)} has a $ref of a form the generator doesn't know: ${reference}`,
    ]);
  }

  /**
   * The upstream node `target` names, with the target it's found at, or
   * null when upstream never wrote it. `<pkg>.config` naming a file with no
   * `config` definition is that file's root.
   */
  private resolve(target: Target): { target: Target; node: Record<string, unknown> } | null {
    const file = this.file(target.repository, target.pkg);
    if (!file) return null;
    const definitions = isRecord(file.$defs) ? file.$defs : {};
    if (target.definition !== ROOT && Object.hasOwn(definitions, target.definition) && isRecord(definitions[target.definition])) {
      return { target, node: definitions[target.definition] as Record<string, unknown> };
    }
    const { $defs: _definitions, $schema: _schema, $id: _id, title: _title, ...root } = file;
    // A component's own file is its root, even an empty one (`{}`: upstream
    // describes none of its settings, so it's open).
    if (target.definition === ROOT) return { target, node: root };
    if (target.definition === "config" && (root.type !== undefined || root.properties !== undefined || root.allOf !== undefined)) {
      return { target: { ...target, definition: ROOT }, node: root };
    }
    return null;
  }

  // ---------- open parts ----------

  /** The open parts naming a definition (by any of the addresses it is written or found at), in the list's order. */
  private definitionParts(...targets: Target[]): OpenPart[] {
    const addresses = targets.map(addressOf);
    // `<file>.<prefix>*` names that file's definitions starting with the
    // prefix; without a `.` before the `*` it names nothing (and is unused).
    const names = (entry: string, address: string) =>
      entry.endsWith("*") ? entry.slice(0, -1).includes(".") && address.startsWith(entry.slice(0, -1)) : address === entry;
    const parts = this.parts.filter((entry) => entry.definition !== undefined && addresses.some((address) => names(entry.definition!, address)));
    // A setting dropped in its place counts as used only where it is dropped.
    for (const part of parts) if (part.open !== "unknown keys in its place") this.used.add(part);
    return parts;
  }

  /** The open parts for a whole definition (no path). */
  private wholeDefinitionParts(...targets: Target[]): OpenPart[] {
    return this.definitionParts(...targets).filter((part) => part.path === undefined);
  }

  private componentPart(component: string): OpenPart | undefined {
    const part = this.parts.find((entry) => entry.component === component && entry.path === undefined);
    if (part) this.used.add(part);
    return part;
  }

  /** The "unknown keys in its place" part dropping `key` of the object at `from` (a definition's address), if any. */
  private inItsPlacePart(from: string, key: string): OpenPart | undefined {
    const part = this.parts.find((entry) => entry.open === "unknown keys in its place" && entry.definition === from && entry.path === key);
    if (part) this.used.add(part);
    return part;
  }

  /** Whether `capitalisedKeys` lists `key` of the object at `from` as a key the collector reads by that name. */
  private capitalisedKeyListed(from: string, key: string): boolean {
    const entry = this.capitalised.find((candidate) => candidate.definition === from && candidate.keys.includes(key));
    if (entry) this.used.add(entry);
    return entry !== undefined;
  }

  /**
   * What to do about a problem an entry would answer, but for its versions:
   * extend them (Preflight ruling 6's open parts end at the newest offered
   * version when upstream changed under them); `otherwise` when no entry
   * limited to other versions names it.
   */
  private advice<T extends { versions?: string[] }>(entries: readonly T[], names: (entry: T) => boolean, otherwise: string): string {
    const { version } = this.request;
    const limited = entries.find((entry) => entry.versions !== undefined && !entry.versions.includes(version) && names(entry));
    if (!limited) return otherwise;
    return `its open-parts.json entry applies to ${limited.versions!.join(", ")} only: extend its versions with ${version} if its reason still holds there`;
  }

  /** A reference to a definition upstream never wrote: open when listed, a problem otherwise. */
  private danglingReference(target: Target, from: string, description: unknown): Schema {
    const [part, ...others] = this.wholeDefinitionParts(target);
    if (part) {
      for (const listed of [part, ...others]) {
        if (listed.open !== "any value") {
          this.problems.push(`${listed.definition} doesn't exist upstream, so its open part can only be "any value"`);
        }
      }
      return openNode(description, part.reason);
    }
    const address = addressOf(target);
    if (!this.dangling.has(address)) this.dangling.set(address, new Set());
    this.dangling.get(address)!.add(from);
    return openNode(description, "upstream refers to a definition it never wrote");
  }

  // ---------- the transformation ----------

  /**
   * A reference to `target`, from `from`: a `$ref` to its definition, built
   * once, or an open node. An optional one (`x-optional`) is recorded, to
   * point at the definition's optional copy once every definition is built.
   */
  private reference(at: Target, reference: string, from: string, description: unknown, optional = false): Schema {
    const written = this.parseReference(at, reference);
    const resolved = this.resolve(written);
    if (!resolved) return this.danglingReference(written, from, description);
    const address = addressOf(resolved.target);
    if (!this.definitions.has(address)) {
      this.definitions.set(address, null);
      this.definitions.set(address, this.definition(resolved.target, resolved.node, written));
    }
    const schema: Schema = { $ref: `#/$defs/${address}` };
    if (optional) this.optionalReferences.push({ reference: schema, address, from });
    if (typeof description === "string") schema.description = description;
    return schema;
  }

  /** A definition's schema, opened as its open part says. */
  private definition(target: Target, node: Record<string, unknown>, written: Target): Schema {
    const parts = this.definitionParts(target, written);
    const anyValue = parts.find((part) => part.path === undefined && part.open === "any value");
    if (anyValue) return openNode(node.description, anyValue.reason);
    const where = addressOf(target);
    let schema = this.transform(node, target, where);
    // A part of the definition first (an enum's alternatives), then the whole;
    // a setting dropped in its place is dropped where the object is read.
    for (const part of parts.filter((entry) => entry.path !== undefined && entry.open !== "unknown keys in its place")) {
      const opened = this.openAt(schema, part.path!.split("."), part, `${part.definition} ${part.path}`, false);
      if (opened) schema = opened;
      else this.problems.push(`${part.definition} has no ${part.path} to open`);
    }
    for (const part of parts.filter((entry) => entry.path === undefined)) schema = this.applyPart(schema, part, where);
    return schema;
  }

  /** `schema` opened as `part` says. */
  private applyPart(schema: Schema, part: OpenPart, where: string): Schema {
    const cannot = (what: string) => {
      this.problems.push(`${where} ${what}, so its open part can't be "${part.open}"`);
      return schema;
    };
    switch (part.open) {
      case "any value":
        return openNode(schema.description, part.reason);
      case "unknown keys":
        this.openKeys(schema, part.reason, where);
        return schema;
      case "any casing": {
        const values = enumValues(schema);
        if (!values) return cannot("isn't an enum");
        return {
          ...openNode(schema.description, part.reason),
          ...(schema.default === undefined ? {} : { default: schema.default }),
          // Two alternatives, so hover shows the setting's description, not
          // each alternative's joined by "||".
          anyOf: [
            { type: "string", enum: values },
            { type: "string", pattern: anyCasingPattern(values) },
          ],
        };
      }
      case "any string": {
        const values = enumValues(schema);
        if (!values) return cannot("isn't an enum");
        return {
          ...openNode(schema.description, part.reason),
          ...(schema.default === undefined ? {} : { default: schema.default }),
          // Suggestions only: completion offers them, a list or null is told
          // only that a string is expected.
          type: "string",
          examples: values,
        };
      }
      case "strings take any scalar": {
        // A `*` part names definitions by their names' start: one with no
        // string setting (an enum of its own) is left as it is.
        const result = scalarStrings(schema);
        if (result === schema && !part.definition?.endsWith("*")) return cannot("has no string setting of its own");
        return result;
      }
      case "a string too": {
        const { description, default: defaultValue, $comment: _comment, ...rest } = schema;
        return {
          ...openNode(description, part.reason),
          ...(defaultValue === undefined ? {} : { default: defaultValue }),
          anyOf: [{ type: "string" }, rest],
        };
      }
      case "unknown keys in its place":
        return cannot("isn't a definition's own setting named after a Go field (the part names the definition and the setting as its path)");
    }
  }

  /** `schema` (a closed object) accepting unknown keys, with why. */
  private openKeys(schema: Schema, reason: string, where: string): void {
    if (schema.additionalProperties !== false) {
      this.problems.push(`${where} isn't a closed object, so its open part can't be "unknown keys"`);
      return;
    }
    delete schema.additionalProperties;
    schema.$comment = `Open: ${reason}`;
  }

  /** An upstream node as the generated schema says it, from a file of `at`. */
  private transform(node: unknown, at: Target, from: string): Schema {
    if (!isRecord(node)) return {};
    const isObject = node.type === "object" || node.properties !== undefined || node.allOf !== undefined;
    if (typeof node.$ref === "string" && isObject) {
      this.problems.push(`${from} has both a $ref and an object's keywords, which the generator doesn't combine`);
    }
    let schema: Schema;
    const optional = node["x-optional"] === true;
    if (typeof node.$ref === "string" && !isObject) {
      return this.withDefault(this.reference(at, node.$ref, from, node.description, optional), node);
    } else if (isObject) {
      schema = this.object(node, at, from);
      if (optional && !describesEnabled(schema)) schema = withEnabled(schema);
    } else if (node.type === "array") {
      schema = this.list(node, at, from);
    } else if (node.type === "integer" || node.type === "number" || node.type === "boolean") {
      schema = { type: [node.type, "string"], pattern: REFERENCE_PATTERN, errorMessage: VALUE_MESSAGES[node.type] };
    } else if (node.type === "string") {
      schema = this.string(node);
    } else {
      // No type: a Go type upstream only names (`x-customType: any`, `net/url.values`).
      schema = {};
    }
    if (typeof node.description === "string") schema.description = node.description;
    return this.withDefault(schema, node);
  }

  private withDefault(schema: Schema, node: Record<string, unknown>): Schema {
    if (node.default !== undefined) schema.default = node.default as Json;
    return schema;
  }

  private object(node: Record<string, unknown>, at: Target, from: string): Schema {
    const view = this.objectView(node, at, from, new Set());
    const schema: Schema = { type: MAP_TYPES, pattern: REFERENCE_PATTERN, patternErrorMessage: VALUE_MESSAGES.map };
    if (Object.keys(view.properties).length > 0) schema.properties = view.properties;
    if (view.map) {
      schema.additionalProperties = view.map;
      if (view.otherKeys !== undefined) schema.$comment = `Other keys: ${view.otherKeys}`;
    } else if (view.openBecause === undefined) schema.additionalProperties = false;
    else schema.$comment = `Open: ${view.openBecause}`;
    return schema;
  }

  /**
   * The keys an upstream object has: its `allOf` members' (an embedded
   * struct's, squashed), then its own, which win. A member that is open
   * opens the object.
   */
  private objectView(node: Record<string, unknown>, at: Target, from: string, seen: ReadonlySet<string>): ObjectView {
    if (typeof node.$ref === "string" && node.properties === undefined && node.allOf === undefined) {
      const written = this.parseReference(at, node.$ref);
      const resolved = this.resolve(written);
      if (!resolved) {
        const open = this.danglingReference(written, `${from} (allOf)`, undefined);
        return { properties: {}, map: undefined, openBecause: (open.$comment as string).slice("Open: ".length) };
      }
      const address = addressOf(resolved.target);
      if (seen.has(address)) {
        this.problems.push(`${from} embeds ${address} in itself`);
        return { properties: {}, map: undefined, openBecause: "a recursive embedding" };
      }
      // An embedded definition's whole parts apply to the keys it brings; a
      // part at a path applies where the definition is referred to, not here.
      const parts = this.wholeDefinitionParts(resolved.target, written);
      const anyValue = parts.find((part) => part.open === "any value");
      if (anyValue) return { properties: {}, map: undefined, openBecause: anyValue.reason };
      let view = this.objectView(resolved.node, resolved.target, address, new Set([...seen, address]));
      for (const part of parts) {
        if (part.open === "unknown keys") {
          view = { ...view, openBecause: view.openBecause ?? part.reason };
        } else if (part.open === "strings take any scalar") {
          const properties = Object.fromEntries(Object.entries(view.properties).map(([key, schema]) => [key, scalarStrings(schema)]));
          view = { ...view, properties, map: view.map && scalarStrings(view.map) };
        } else {
          this.problems.push(`${address} is embedded in ${from}, so its open part can't be "${part.open}"`);
        }
      }
      return view;
    }
    const members = Array.isArray(node.allOf) ? node.allOf : [];
    if (node.properties === undefined && members.length === 0 && node.additionalProperties === undefined) {
      const goType = node["x-customType"];
      const openBecause =
        typeof goType === "string" ? `upstream only names its Go type, ${goType}` : "upstream describes none of its settings";
      return { properties: {}, map: undefined, openBecause };
    }
    const properties: Record<string, Schema> = {};
    let map: Schema | undefined;
    let openBecause: string | undefined;
    let otherKeys: string | undefined;
    for (const member of members) {
      const view = isRecord(member) ? this.objectView(member, at, from, seen) : undefined;
      if (!view) continue;
      Object.assign(properties, view.properties);
      map ??= view.map;
      openBecause ??= view.openBecause;
      otherKeys ??= view.otherKeys;
    }
    if (isRecord(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) {
        if (key === "__proto__") throw new Error(`${from} has a key named __proto__.`);
        const inItsPlace = this.inItsPlacePart(from, key);
        if (inItsPlace) {
          // The map's values are what each other key of the object holds
          // (`map[string]map[string]any`: a map under each).
          if (isRecord(value) && isRecord(value.additionalProperties)) {
            map ??= this.transform(value.additionalProperties, at, `${from}.${key}.*`);
            otherKeys ??= inItsPlace.reason;
          } else {
            this.problems.push(`${from}.${key} isn't a map, so its open part can't be "unknown keys in its place"`);
          }
          continue;
        }
        if (isGoFieldName(key) && !this.capitalisedKeyListed(from, key)) {
          const listIt =
            `if the collector reads it by that name, list it in open-parts.json's capitalisedKeys under ${from}; ` +
            `if it is a ,remain map, drop it with an "unknown keys in its place" part`;
          const limited =
            this.advice(this.request.capitalisedKeys, (entry) => entry.definition === from && entry.keys.includes(key), "") ||
            this.advice(this.request.openParts, (entry) => entry.open === "unknown keys in its place" && entry.definition === from && entry.path === key, listIt);
          this.problems.push(`${from} has a setting named ${key}, a Go field's name: ${limited}`);
        }
        properties[key] = this.transform(value, at, `${from}.${key}`);
      }
    }
    if (isRecord(node.additionalProperties)) map = this.transform(node.additionalProperties, at, `${from}.*`);
    else if (node.additionalProperties === true) openBecause ??= "upstream accepts any key";
    return { properties, map, openBecause, otherKeys };
  }

  private list(node: Record<string, unknown>, at: Target, from: string): Schema {
    const items = node.items === undefined ? {} : this.transform(node.items, at, `${from}[]`);
    // mapstructure's StringToSliceHookFunc(",") turns a string into a list
    // of strings; where the items' type isn't known, a string may be one.
    if (this.mayBeString(node.items, at, 0)) {
      return { type: LIST_TYPES, items, errorMessage: VALUE_MESSAGES.listOfStrings };
    }
    return { type: LIST_TYPES, items, pattern: REFERENCE_PATTERN, errorMessage: VALUE_MESSAGES.list };
  }

  /** Whether an upstream node is a string, or of a type upstream doesn't give. */
  private mayBeString(node: unknown, at: Target, depth: number): boolean {
    if (!isRecord(node) || depth > 16) return true;
    if (node.type !== undefined) return node.type === "string";
    if (node.properties !== undefined || node.allOf !== undefined) return false;
    if (typeof node.$ref !== "string") return true;
    const resolved = this.resolve(this.parseReference(at, node.$ref));
    if (!resolved) return true;
    if (this.wholeDefinitionParts(resolved.target).some((part) => part.open === "any value")) return true;
    return this.mayBeString(resolved.node, resolved.target, depth + 1);
  }

  private string(node: Record<string, unknown>): Schema {
    if (Array.isArray(node.enum)) {
      return { anyOf: [{ type: "string", enum: node.enum as Json[] }, { type: "string", pattern: REFERENCE_PATTERN }] };
    }
    if (node.format === "duration" || node["x-customType"] === "time.Duration") {
      // time.Duration is an int64: an integer is nanoseconds.
      return { type: ["string", "integer"], errorMessage: VALUE_MESSAGES.duration };
    }
    return { type: "string" };
  }

  // ---------- components ----------

  /** A section (`receivers`): each built component by type, its instance ids and old names by pattern. */
  private section(kind: ComponentKind): Schema {
    const { request } = this;
    const manifest: unknown = parseYaml(request.manifest);
    const entries = isRecord(manifest) && Array.isArray(manifest[`${kind}s`]) ? (manifest[`${kind}s`] as unknown[]) : [];
    const properties: Record<string, Json> = {};
    const patternProperties: Record<string, Json> = {};
    const aliases: string[] = [];
    for (const entry of entries) {
      const component = this.component(kind, entry);
      if (!component) continue;
      const { type, alias, address } = component;
      if (Object.hasOwn(properties, type)) this.problems.push(`the manifest builds two ${kind}s of type ${type}`);
      const reference = { $ref: `#/$defs/${address}` };
      properties[type] = reference;
      patternProperties[`^${escapeRegExp(type)}/.+$`] = reference;
      if (alias !== undefined) {
        aliases.push(alias);
        patternProperties[`^${escapeRegExp(alias)}(/.+)?$`] = reference;
      }
    }
    for (const alias of aliases) {
      if (Object.hasOwn(properties, alias)) this.problems.push(`the ${kind} alias ${alias} is also a ${kind}'s type`);
      if (aliases.indexOf(alias) !== aliases.lastIndexOf(alias)) this.problems.push(`two ${kind}s have the alias ${alias}`);
    }
    return {
      type: MAP_TYPES,
      pattern: REFERENCE_PATTERN,
      patternErrorMessage: VALUE_MESSAGES.map,
      properties,
      patternProperties,
      additionalProperties: false,
    };
  }

  /** A manifest entry's component: its type, its old name, and its definition's address. */
  private component(kind: ComponentKind, entry: unknown): { type: string; alias: string | undefined; address: string } | undefined {
    const { request } = this;
    const module = isRecord(entry) ? (typeof entry.import === "string" ? entry.import : String(entry.gomod ?? "").split(" ")[0]) : "";
    const external = request.inputs.external.find((candidate) => candidate.module === module);
    if (external) {
      if (external.kind !== kind) this.problems.push(`${module} is listed as a ${external.kind} but the manifest builds it as a ${kind}`);
      return this.componentWithoutSchema(kind, external.type, undefined, `component/${kind}/${external.type}`, "has no upstream schema");
    }
    const repository = UPSTREAM_REPOSITORIES.find((candidate) => module?.startsWith(`${request.inputs.modules[candidate]}/`));
    if (!repository || !module) {
      this.problems.push(`the manifest's ${kind} ${module || "(no module)"} is from neither contrib nor core, and isn't listed as external`);
      return undefined;
    }
    const pkg = module.slice(request.inputs.modules[repository].length + 1);
    const metadataPath = path.join(request.trees[repository], pkg, "metadata.yaml");
    const metadata: unknown = existsSync(metadataPath) ? parseYaml(readFileSync(metadataPath, "utf8")) : null;
    if (!isRecord(metadata) || typeof metadata.type !== "string") {
      this.problems.push(`${repository}/${pkg} has no metadata.yaml with a type`);
      return undefined;
    }
    const type = metadata.type;
    const status = isRecord(metadata.status) ? metadata.status : {};
    if (status.class !== undefined && status.class !== kind) {
      this.problems.push(`${repository}/${pkg} is a ${String(status.class)}, but the manifest builds it as a ${kind}`);
    }
    const alias = typeof metadata.deprecated_type === "string" ? metadata.deprecated_type : undefined;
    const component = `${kind}/${type}`;
    const root = this.resolve({ repository, pkg, definition: ROOT });
    if (!root) return this.componentWithoutSchema(kind, type, alias, `${repository}/${pkg}`, "has no upstream schema");
    const { properties, allOf, additionalProperties, $ref } = root.node;
    if ([properties, allOf, additionalProperties, $ref].every((keyword) => keyword === undefined)) {
      // `{}` (or a bare `type: object`): upstream describes none of its
      // settings, which may be none at all (`type Config struct{}`).
      return this.componentWithoutSchema(kind, type, alias, addressOf(root.target), "has an upstream schema that describes none of its settings");
    }
    if (Object.hasOwn(request.handWritten.withoutSettings, component)) {
      this.problems.push(`${component} has an upstream schema with settings now: take it out of hand-written.json's withoutSettings`);
    }
    const address = addressOf(root.target);
    this.fixedNames.set(address, `${type}_${kind}`);
    // An entry naming the component is for one upstream describes none of the
    // settings of; its schema's own parts name the schema (`address`).
    if (this.componentPart(component)) {
      this.problems.push(
        `${component} has an upstream schema with settings now (${address}): its open-parts.json entry says upstream describes none; ` +
          `remove it, or name ${address} as a definition if a part of the schema is still wrong`,
      );
    }
    const parts = this.wholeDefinitionParts(root.target);
    // Built here even when another schema referred to it first (`.config`),
    // so the component's own open parts apply.
    if (this.definitions.get(address) !== null) {
      this.definitions.set(address, null);
      let schema: Schema;
      const anyValue = parts.find((part) => part.open === "any value");
      if (anyValue) {
        schema = openComponent(root.node.description, anyValue.reason);
      } else {
        schema = this.transform(root.node, root.target, address);
        for (const part of parts) schema = this.applyPart(schema, part, address);
      }
      this.definitions.set(address, schema);
    }
    return { type, alias, address };
  }

  /**
   * A component upstream describes no settings of (no schema, or one that
   * describes none): no settings (hand-written, closed), or open when listed.
   * Every component accepts null and a reference (Preflight ruling 8).
   */
  private componentWithoutSchema(kind: ComponentKind, type: string, alias: string | undefined, address: string, why: string) {
    const component = `${kind}/${type}`;
    this.fixedNames.set(address, `${type}_${kind}`);
    const description = this.request.handWritten.withoutSettings[component];
    const part = this.componentPart(component);
    let schema: Schema;
    if (description !== undefined && part) {
      this.problems.push(`${component} is in both open-parts.json and hand-written.json's withoutSettings: keep one`);
      schema = {};
    } else if (description !== undefined) {
      schema = { description, type: MAP_TYPES, pattern: REFERENCE_PATTERN, patternErrorMessage: VALUE_MESSAGES.map, additionalProperties: false };
    } else if (part) {
      schema = openComponent(undefined, part.reason);
    } else {
      const listIt = "list it in open-parts.json or hand-written.json's withoutSettings";
      this.problems.push(`${component} ${why}: ${this.advice(this.request.openParts, (entry) => entry.component === component && entry.path === undefined, listIt)}`);
      schema = {};
    }
    this.definitions.set(address, schema);
    return { type, alias, address };
  }

  /** The open parts addressed by component and path. */
  private openPaths(): void {
    for (const part of this.parts) {
      if (part.component === undefined || part.path === undefined) continue;
      const [kind, type] = part.component.split("/");
      const address = [...this.fixedNames].find(([, name]) => name === `${type}_${kind}`)?.[0];
      const schema = address === undefined ? undefined : this.definitions.get(address);
      if (!schema) continue; // not built at this version: reported as unused
      const opened = this.openAt(schema, part.path.split("."), part, `${part.component} ${part.path}`, true);
      if (opened) {
        this.definitions.set(address!, opened);
        this.used.add(part);
      } else {
        this.problems.push(`${part.component} has no ${part.path} to open`);
      }
    }
  }

  /**
   * `node` with the part at `steps` opened, a referenced definition copied in
   * on the way when `throughReferences` (a component's path; a definition's
   * stays inside it); undefined when there is none.
   */
  private openAt(node: Schema, steps: readonly string[], part: OpenPart, where: string, throughReferences: boolean): Schema | undefined {
    let local = node;
    // A definition's path stays inside it: a reference is opened as it is
    // (no settings or items to step into), never copied in. A reference that
    // only takes a string too stays a reference.
    if (typeof node.$ref === "string" && throughReferences && (steps.length > 0 || part.open !== "a string too")) {
      const { $ref, ...siblings } = node;
      const target = this.definitions.get($ref.slice("#/$defs/".length));
      if (!target) return undefined;
      local = { ...structuredClone(target), ...siblings };
    }
    const [step, ...rest] = steps;
    if (step === undefined) return this.applyPart(local, part, where);
    const slot =
      step === "[]" ? { holder: local, key: "items" }
      : step === "*" ? { holder: local, key: "additionalProperties" }
      : isRecord(local.properties) ? { holder: local.properties as Schema, key: step }
      : undefined;
    const child = slot?.holder[slot.key];
    if (!slot || !isRecord(child) || !Object.hasOwn(slot.holder, slot.key)) return undefined;
    const opened = this.openAt(child as Schema, rest, part, where, throughReferences);
    if (!opened) return undefined;
    slot.holder[slot.key] = opened;
    return local;
  }

  /**
   * Each reference through an `x-optional` setting pointed at its
   * definition's optional copy, which accepts `enabled` (configoptional's
   * Unmarshal reads and deletes it for every Optional): where the definition
   * is an object, the copy is made once all references point at their
   * copies, so a copy's own optional sections are copies too. A definition
   * open to any value, or not an object, is referred to as it is.
   */
  private optionalSections(): void {
    // Each reference's object first, before any reference is pointed at a
    // copy: a definition that is only a reference (an alias) is followed to
    // what it names, where the copy is made.
    const objects = this.optionalReferences.map(({ reference, address: referred, from }) => {
      let address = referred;
      const seen = new Set<string>();
      let definition = this.definitions.get(address);
      while (typeof definition?.$ref === "string" && !seen.has(address)) {
        seen.add(address);
        address = definition.$ref.slice("#/$defs/".length);
        definition = this.definitions.get(address);
      }
      if (!definition || typeof definition.$ref === "string") {
        this.problems.push(`${from} is optional (x-optional), but ${referred} refers on without reaching a definition`);
        return undefined;
      }
      return { reference, address, definition };
    });
    for (const found of objects) {
      if (!found || !isObjectNode(found.definition) || describesEnabled(found.definition)) continue;
      const { reference, address } = found;
      const copy = `${address}${OPTIONAL_SUFFIX}`;
      if (this.definitions.has(copy) && !this.optionalCopies.has(copy)) {
        throw new Error(`${copy} is both an upstream definition and ${address}'s optional copy.`);
      }
      this.optionalCopies.set(copy, address);
      reference.$ref = `#/$defs/${copy}`;
    }
    for (const [copy, address] of this.optionalCopies) {
      this.definitions.set(copy, withEnabled(structuredClone(this.definitions.get(address)!)));
    }
  }

  /** Dangling references nobody listed, and open parts nothing used. */
  private reportLeftovers(): void {
    for (const [address, from] of [...this.dangling].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const listIt = this.advice(this.request.openParts, (entry) => entry.definition === address, "list it in open-parts.json");
      this.problems.push(`${address} doesn't exist upstream (referenced from ${[...from].sort().join(", ")}): ${listIt}`);
    }
    for (const part of this.parts) {
      if (!this.used.has(part)) {
        const what = part.definition ?? `${part.component}${part.path === undefined ? "" : ` ${part.path}`}`;
        this.problems.push(`the open part ${what} is used nowhere on ${this.request.version}: remove it, or limit its versions`);
      }
    }
    for (const entry of this.capitalised) {
      if (!this.used.has(entry)) {
        this.problems.push(`the capitalised keys of ${entry.definition} are used nowhere on ${this.request.version}: remove the entry, or limit its versions`);
      }
    }
  }

  /**
   * Each definition's name in `$defs`: a component's `<type>_<kind>`;
   * another's upstream name, prefixed with as many of its package's path
   * segments as tell it apart from every other (`confighttp_client_config`).
   * A name never has a `.` or a `/`: the language service shows what follows
   * the last `/` of a `$ref`.
   */
  private readableNames(): Map<string, string> {
    const names = new Map<string, string>();
    const taken = new Set(Object.keys(this.request.handWritten.definitions));
    for (const [address, name] of this.fixedNames) {
      if (taken.has(name)) throw new Error(`Two definitions are both named ${name}.`);
      taken.add(name);
      names.set(address, name);
    }
    const rest = [...this.definitions.keys()].filter((address) => !names.has(address) && !this.optionalCopies.has(address)).sort();
    const parts = (address: string): [string, string] => {
      const [where, definition = "config"] = address.split(/\.(?=\w+$)/);
      return [where!, definition];
    };
    // A bare "config" says nothing: it starts with its package's name.
    const depth = new Map(rest.map((address) => [address, parts(address)[1] === "config" ? 1 : 0]));
    const candidate = (address: string): string => {
      const [where, definition] = parts(address);
      const segments = where.split("/");
      const prefix = segments.slice(Math.max(0, segments.length - depth.get(address)!));
      return [...prefix, definition].join("_").replace(/[^A-Za-z0-9_-]/g, "_");
    };
    for (;;) {
      const byName = new Map<string, string[]>();
      for (const address of rest) {
        const name = candidate(address);
        byName.set(name, [...(byName.get(name) ?? []), address]);
      }
      let changed = false;
      for (const [name, addresses] of byName) {
        if (addresses.length === 1 && !taken.has(name)) continue;
        for (const address of addresses) {
          if (depth.get(address)! >= address.split("/").length) throw new Error(`No readable name tells ${address} apart.`);
          depth.set(address, depth.get(address)! + 1);
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const address of rest) names.set(address, candidate(address));
    // An optional copy is named after its definition.
    for (const [copy, address] of this.optionalCopies) {
      const name = `${names.get(address)!}${OPTIONAL_SUFFIX}`;
      if (taken.has(name) || rest.some((other) => names.get(other) === name)) throw new Error(`Two definitions are both named ${name}.`);
      names.set(copy, name);
    }
    return names;
  }
}

/** Each `$ref` to an emitted definition, by its readable name. */
function renameReferences(node: Json, names: ReadonlyMap<string, string>): void {
  if (Array.isArray(node)) {
    for (const item of node) renameReferences(item, names);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
        const name = names.get(value.slice("#/$defs/".length));
        if (name !== undefined) node[key] = `#/$defs/${name}`;
      } else {
        renameReferences(value, names);
      }
    }
  }
}

/** The schema without the definitions nothing refers to any more (an opened path's copy replaced them). */
function pruneDefinitions(schema: Schema): void {
  const $defs = schema.$defs as Record<string, Json>;
  const reached = new Set<string>();
  const visit = (node: Json): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
          const name = value.slice("#/$defs/".length);
          if (!reached.has(name)) {
            reached.add(name);
            visit($defs[name]!);
          }
        } else if (node !== $defs) {
          visit(value);
        }
      }
    }
  };
  visit({ ...schema, $defs: null });
  for (const name of Object.keys($defs)) if (!reached.has(name)) delete $defs[name];
}

/** The schema's `$comment`: its sources, their commits and their license (decision 14, Preflight ruling 16). */
function sourcesComment(request: SchemaRequest): string {
  const sources = request.inputs.versions[request.version]!;
  const at = (source: PinnedSource) => `${source.repository} ${source.tag} (commit ${source.commit})`;
  return (
    `The configuration schema of ${request.distribution} ${request.version}, generated by ${GENERATOR_PATH} ` +
    `(${GENERATE_OTELCOL_SCHEMAS_SCRIPT}); do not edit. Derived from the config.schema.yaml files and the ` +
    `metadata.yaml type names of ${at(sources.contrib)} and ${at(sources.core)}, and from ` +
    `${request.inputs.manifest} of ${at(sources.releases)}; each licensed under the Apache License, Version 2.0. ` +
    `Where upstream's schema is missing or wrong, that part is open, with its reason in ` +
    `telflo-core/apps/web/scripts/otelcol-schemas/open-parts.json.`
  );
}

/** One schema, as the file's bytes. Throws a SchemaGenerationError listing every problem found. */
export function generateSchema(request: SchemaRequest): string {
  return new Generation(request).run();
}

// ---------- the run ----------

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const INPUTS = path.join(SCRIPTS, "otelcol-schemas");
const PUBLIC_SCHEMAS = path.join(SCRIPTS, "..", "public", "schemas");
const CATALOGUE = path.join(SCRIPTS, "..", "..", "..", "..", "catalog", "distributions");

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** The committed inputs. */
export function readInputs(): { inputs: SchemaInputs; openParts: OpenPart[]; capitalisedKeys: CapitalisedKeys[]; handWritten: HandWritten } {
  const openParts = readJson<{ parts: OpenPart[]; capitalisedKeys: CapitalisedKeys[] }>(path.join(INPUTS, "open-parts.json"));
  return {
    inputs: readJson<SchemaInputs>(path.join(INPUTS, "inputs.json")),
    openParts: openParts.parts,
    capitalisedKeys: openParts.capitalisedKeys,
    handWritten: readJson<HandWritten>(path.join(INPUTS, "hand-written.json")),
  };
}

/** The versions a catalogue file offers (not deprecated), as it lists them. */
export function offeredVersions(catalogueFile: unknown): string[] {
  const versions = isRecord(catalogueFile) && Array.isArray(catalogueFile.versions) ? catalogueFile.versions : [];
  return versions.filter((entry) => isRecord(entry) && !entry.deprecated).map((entry) => String((entry as Record<string, unknown>).version));
}

/** Where a distribution's schema for a version is written, under `public/`. */
export function schemaFile(distribution: string, version: string): string {
  return path.join(PUBLIC_SCHEMAS, distribution, `v${version}.json`);
}

/** A sparse, shallow clone of `source` holding only `patterns`, at its pinned commit. */
function fetchSource(source: PinnedSource, patterns: readonly string[], directory: string): void {
  // git's output is kept back (a shallow clone of an annotated tag warns
  // that the tag "is not a commit"); a failure's error carries it.
  const git = (...args: string[]) => execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
  git("-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse",
    "--branch", source.tag, `https://github.com/${source.repository}.git`, directory);
  git("-C", directory, "sparse-checkout", "set", "--no-cone", ...patterns);
  const head = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== source.commit) {
    throw new Error(`${source.repository} ${source.tag} is at ${head}, not the pinned ${source.commit}.`);
  }
}

async function main(): Promise<void> {
  const { inputs, openParts, capitalisedKeys, handWritten } = readInputs();
  const work = mkdtempSync(path.join(tmpdir(), "otelcol-schemas-"));
  // Every schema is generated before any file is written: a run that stops
  // on one version leaves every committed file as it was.
  const schemas: { file: string; json: string }[] = [];
  const offeredBy = new Map<string, string[]>();
  try {
    for (const [distribution, distributionInputs] of Object.entries(inputs.distributions)) {
      const offered = offeredVersions(readJson<unknown>(path.join(CATALOGUE, `${distribution}.json`)));
      const listed = Object.keys(distributionInputs.versions);
      const missing = offered.filter((version) => !listed.includes(version));
      const retired = listed.filter((version) => !offered.includes(version));
      if (missing.length > 0 || retired.length > 0) {
        throw new Error(
          `inputs.json's ${distribution} versions aren't the catalogue's offered ones: ` +
            `${missing.length > 0 ? `add ${missing.join(", ")}` : ""}${missing.length > 0 && retired.length > 0 ? "; " : ""}` +
            `${retired.length > 0 ? `remove ${retired.join(", ")}` : ""}.`,
        );
      }
      offeredBy.set(distribution, offered);
      for (const version of offered) {
        const sources = distributionInputs.versions[version]!;
        const directory = (name: string) => path.join(work, `${distribution}-${version}-${name}`);
        const schemaPatterns = ["/**/config.schema.yaml", "/**/metadata.yaml"];
        console.log(`Fetching ${distribution} ${version}'s sources…`);
        fetchSource(sources.contrib, schemaPatterns, directory("contrib"));
        fetchSource(sources.core, schemaPatterns, directory("core"));
        fetchSource(sources.releases, [`/${distributionInputs.manifest}`], directory("releases"));
        const json = generateSchema({
          distribution,
          version,
          trees: { contrib: directory("contrib"), core: directory("core") },
          manifest: readFileSync(path.join(directory("releases"), distributionInputs.manifest), "utf8"),
          inputs: distributionInputs,
          openParts,
          capitalisedKeys,
          handWritten,
        });
        schemas.push({ file: schemaFile(distribution, version), json });
        console.log(`Generated ${distribution} ${version} (${Buffer.byteLength(json)} bytes).`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // Each file is written beside itself first and renamed into place once
  // every one is written, so no reader ever sees a half-written schema.
  const temporary = (file: string) => `${file}.${process.pid}.tmp`;
  try {
    for (const { file, json } of schemas) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temporary(file), json);
    }
    for (const { file } of schemas) {
      renameSync(temporary(file), file);
      console.log(`Wrote ${path.relative(process.cwd(), file)}.`);
    }
  } finally {
    for (const { file } of schemas) rmSync(temporary(file), { force: true });
  }
  // A retired version's schema goes (decision 2).
  for (const [distribution, offered] of offeredBy) {
    for (const name of readdirSync(path.join(PUBLIC_SCHEMAS, distribution))) {
      if (/\.json\.\d+\.tmp$/.test(name)) {
        rmSync(path.join(PUBLIC_SCHEMAS, distribution, name), { force: true });
        console.log(`Removed ${distribution}/${name}: a temporary file an interrupted run left.`);
        continue;
      }
      if (!offered.some((version) => name === `v${version}.json`)) {
        rmSync(path.join(PUBLIC_SCHEMAS, distribution, name));
        console.log(`Removed ${distribution}/${name}: the catalogue doesn't offer it.`);
      }
    }
  }
}

// Run, not imported (the test imports it).
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
