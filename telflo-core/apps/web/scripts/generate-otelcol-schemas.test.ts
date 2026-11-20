// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CATALOGUE_RENAMED_TYPES, isAtOrAfter } from "~/lib/collector/renamed-types.js";
import {
  generateSchema,
  type CapitalisedKeys,
  offeredVersions,
  readInputs,
  REFERENCE_PATTERN,
  SchemaGenerationError,
  schemaFile,
  sortKeys,
  VALUE_MESSAGES,
  type DistributionInputs,
  type Json,
  type OpenPart,
  type Schema,
  type SchemaRequest,
} from "./generate-otelcol-schemas.js";

/*
 * The generator on small upstream trees in miniature
 * (`otelcol-schemas/fixtures/`: contrib and core with every `$ref` form,
 * `allOf`, a declared map, every value type, a component without a schema,
 * one whose schema is `{}` and one without settings, a component another
 * refers to, an embedded open definition, a hand-copied set of definitions,
 * optional sections, settings named after Go fields, and a release
 * manifest), never on the network; then the committed schemas against the
 * catalogue.
 */

const FIXTURES = fileURLToPath(new URL("./otelcol-schemas/fixtures/", import.meta.url));
const CATALOGUE = fileURLToPath(new URL("../../../../catalog/distributions/", import.meta.url));
const PUBLIC_SCHEMAS = fileURLToPath(new URL("../public/schemas/", import.meta.url));

const { inputs: committedInputs, handWritten } = readInputs();

const SOURCES = {
  contrib: { repository: "open-telemetry/opentelemetry-collector-contrib", tag: "v0.200.0", commit: "c".repeat(40) },
  core: { repository: "open-telemetry/opentelemetry-collector", tag: "v0.200.0", commit: "d".repeat(40) },
  releases: { repository: "open-telemetry/opentelemetry-collector-releases", tag: "v0.200.0", commit: "e".repeat(40) },
};

const INPUTS: DistributionInputs = {
  manifest: "distributions/otelcol-sample/manifest.yaml",
  modules: {
    contrib: "github.com/open-telemetry/opentelemetry-collector-contrib",
    core: "go.opentelemetry.io/collector",
  },
  external: [{ module: "example.com/outside/collector", kind: "receiver", type: "outside", repository: "example/outside" }],
  versions: { "0.200.0": SOURCES },
};

/** The open parts the fixtures need: each kind of entry once. */
const OPEN_PARTS: OpenPart[] = [
  { definition: "core/config/confighttp.client_config", open: "unknown keys", reason: "the fixture's client reads deprecated keys" },
  { definition: "contrib/pkg/nowhere.gone", open: "any value", reason: "the fixture refers to a definition it never wrote" },
  { component: "processor/sample", path: "statements.[]", open: "any value", reason: "the fixture's statements may be strings" },
  { component: "exporter/bare", open: "unknown keys", reason: "the fixture's exporter has no schema" },
  { component: "receiver/outside", open: "unknown keys", reason: "built from outside contrib and core" },
  { definition: "contrib/receiver/innerreceiver", open: "unknown keys", reason: "the fixture's inner receiver reads more than it says" },
  { definition: "contrib/receiver/samplereceiver.copy_outer", open: "unknown keys", reason: "the fixture's copy omits a key" },
  { definition: "contrib/receiver/samplereceiver.copy_*", open: "strings take any scalar", reason: "the fixture's copy reads any scalar as text" },
  { definition: "contrib/receiver/samplereceiver.copy_outer", path: "kind", open: "any casing", reason: "the fixture's kind is lowercased first" },
  { definition: "contrib/receiver/samplereceiver.copy_outer", path: "scheme", open: "any string", reason: "the fixture's scheme is never checked" },
  { component: "processor/sample", path: "groups.[]", open: "a string too", reason: "the fixture's groups may be strings" },
  { definition: "contrib/processor/policyprocessor.policy", path: "ExtensionCfg", open: "unknown keys in its place", reason: "the fixture's policy holds its other keys" },
  { definition: "contrib/processor/policyprocessor.sub_policy", path: "ExtensionCfg", open: "unknown keys in its place", reason: "the fixture's sub-policy holds its other keys" },
];

/** The settings the fixtures name with a capital letter that the collector reads by that name. */
const CAPITALISED_KEYS: CapitalisedKeys[] = [
  { definition: "contrib/processor/policyprocessor.headers", keys: ["Fixed"], reason: "the fixture's headers are read by their Go names" },
];

/** The committed hand-written parts, and the fixtures' connector whose upstream schema is `{}`. */
const HAND_WRITTEN = {
  ...handWritten,
  withoutSettings: { ...handWritten.withoutSettings, "connector/empty": "The fixture's empty connector takes no settings." },
};

function request(overrides: Partial<SchemaRequest> = {}): SchemaRequest {
  return {
    distribution: "otelcol-sample",
    version: "0.200.0",
    trees: { contrib: `${FIXTURES}contrib`, core: `${FIXTURES}core` },
    manifest: readFileSync(`${FIXTURES}manifest.yaml`, "utf8"),
    inputs: INPUTS,
    openParts: OPEN_PARTS,
    capitalisedKeys: CAPITALISED_KEYS,
    handWritten: HAND_WRITTEN,
    ...overrides,
  };
}

function generate(overrides: Partial<SchemaRequest> = {}): Schema {
  return JSON.parse(generateSchema(request(overrides))) as Schema;
}

/** A string setting that takes any scalar, as a "strings take any scalar" part writes it. */
const SCALAR_STRING = { anyOf: [{ type: "string" }, { not: { type: ["object", "array", "null", "string"] } }] };

/** The problems a run stops on. */
function problems(overrides: Partial<SchemaRequest>): readonly string[] {
  try {
    generateSchema(request(overrides));
  } catch (error) {
    if (error instanceof SchemaGenerationError) return error.problems;
    throw error;
  }
  throw new Error("The run didn't stop.");
}

function definitions(schema: Schema): Record<string, Schema> {
  return schema.$defs as Record<string, Schema>;
}

/** `node`, or the definition its `$ref` names. */
function resolved(schema: Schema, node: Json | undefined): Schema {
  const value = node as Schema;
  if (typeof value.$ref !== "string") return value;
  const target = definitions(schema)[value.$ref.slice("#/$defs/".length)];
  if (!target) throw new Error(`No definition for ${value.$ref}.`);
  return target;
}

function section(schema: Schema, name: string): Schema {
  return (schema.properties as Record<string, Schema>)[name]!;
}

function properties(node: Schema): Record<string, Schema> {
  return node.properties as Record<string, Schema>;
}

/** Every key anywhere in `node`. */
function keysOf(node: Json, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keysOf(item, into));
  else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      into.add(key);
      keysOf(value, into);
    }
  }
  return into;
}

describe("generateSchema", () => {
  const schema = generate();
  const receiver = resolved(schema, properties(section(schema, "receivers")).sample_logs);
  const settings = properties(receiver);

  it("resolves a bare $ref to the same file's definition", () => {
    expect(properties(resolved(schema, settings.local)).depth).toBeDefined();
    expect(settings.operators!.items).toEqual({ $ref: settings.local!.$ref });
  });

  it("resolves ./, / and module $refs to the files they name", () => {
    expect(Object.keys(properties(resolved(schema, settings.relative)))).toEqual(["level"]);
    expect(Object.keys(properties(resolved(schema, settings.shared)))).toEqual(["size"]);
    expect(Object.keys(properties(resolved(schema, settings.client)))).toEqual(["endpoint", "timeout"]);
    // core's own root-relative form names the same definition
    const otlp = resolved(schema, properties(section(schema, "receivers")).otlp);
    const grpc = properties(properties(otlp).protocols!).grpc!;
    expect(grpc.$ref).toBe(settings.client!.$ref);
  });

  it("reads <pkg>.config as the file's root when the file has no config definition", () => {
    const rooted = resolved(schema, settings.rooted);
    expect(Object.keys(properties(rooted))).toEqual(["path"]);
    expect(rooted.additionalProperties).toBe(false);
  });

  it("flattens allOf into its object and closes it", () => {
    expect(settings.retry).toMatchObject({ description: "Embedded by the sample receiver.", type: ["boolean", "string"] });
    expect(receiver.additionalProperties).toBe(false);
    expect(keysOf(schema).has("allOf")).toBe(false);
  });

  it("keeps a map upstream declares as one a map", () => {
    const labels = resolved(schema, settings.labels);
    expect(labels.additionalProperties).toEqual({ type: "string" });
    expect(labels.properties).toBeUndefined();
  });

  it("closes every object upstream describes", () => {
    expect(resolved(schema, settings.local).additionalProperties).toBe(false);
    expect(resolved(schema, settings.relative).additionalProperties).toBe(false);
  });

  it("leaves a definition on the open list open: unknown keys accepted, its settings kept", () => {
    const client = resolved(schema, settings.client);
    expect(client.additionalProperties).toBeUndefined();
    expect(client.$comment).toBe("Open: the fixture's client reads deprecated keys");
    expect(Object.keys(properties(client))).toEqual(["endpoint", "timeout"]);
  });

  it("leaves a dangling reference on the open list open to any value", () => {
    expect(settings.missing).toEqual({
      $comment: "Open: the fixture refers to a definition it never wrote",
      description: "A definition upstream never wrote.",
    });
  });

  it("leaves a component's part on the open list open", () => {
    const processor = resolved(schema, properties(section(schema, "processors")).sample);
    expect(properties(processor).statements!.items).toEqual({ $comment: "Open: the fixture's statements may be strings" });
  });

  it("leaves a component without an upstream schema open when it is listed", () => {
    expect(resolved(schema, properties(section(schema, "exporters")).bare)).toEqual({
      $comment: "Open: the fixture's exporter has no schema",
      pattern: REFERENCE_PATTERN,
      patternErrorMessage: VALUE_MESSAGES.map,
      type: ["object", "string", "null"],
    });
    expect(properties(section(schema, "receivers")).outside).toBeDefined();
  });

  it("stops on a reference to a definition upstream never wrote that isn't listed", () => {
    expect(problems({ openParts: OPEN_PARTS.filter((part) => part.definition !== "contrib/pkg/nowhere.gone") })).toEqual([
      "contrib/pkg/nowhere.gone doesn't exist upstream (referenced from contrib/receiver/samplereceiver.missing): list it in open-parts.json",
    ]);
  });

  it("stops on a component without an upstream schema that isn't listed", () => {
    expect(problems({ openParts: OPEN_PARTS.filter((part) => part.component !== "exporter/bare") })).toEqual([
      "exporter/bare has no upstream schema: list it in open-parts.json or hand-written.json's withoutSettings",
    ]);
  });

  it("stops on an open part nothing uses, and on one a version it applies to doesn't use", () => {
    const unused: OpenPart = { definition: "contrib/pkg/shared.gone", open: "any value", reason: "nothing" };
    expect(problems({ openParts: [...OPEN_PARTS, unused] })).toEqual([
      "the open part contrib/pkg/shared.gone is used nowhere on 0.200.0: remove it, or limit its versions",
    ]);
    const path: OpenPart = { component: "processor/sample", path: "nothing.[]", open: "any value", reason: "nothing" };
    expect(problems({ openParts: [...OPEN_PARTS, path] })).toContain("processor/sample has no nothing.[] to open");
    // an entry limited to other versions doesn't apply
    expect(() => generate({ openParts: [...OPEN_PARTS, { ...unused, versions: ["0.199.0"] }] })).not.toThrow();
  });

  it("accepts a ${…} reference for every setting that isn't a string, and leaves a string setting as it is", () => {
    expect(settings.count).toEqual({
      default: 3,
      description: "How many.",
      errorMessage: VALUE_MESSAGES.integer,
      pattern: REFERENCE_PATTERN,
      type: ["integer", "string"],
    });
    expect(settings.enabled).toMatchObject({ type: ["boolean", "string"], pattern: REFERENCE_PATTERN, errorMessage: VALUE_MESSAGES.boolean });
    expect(settings.ratio).toMatchObject({ type: ["number", "string"], pattern: REFERENCE_PATTERN, errorMessage: VALUE_MESSAGES.number });
    expect(resolved(schema, settings.local)).toMatchObject({ pattern: REFERENCE_PATTERN, patternErrorMessage: VALUE_MESSAGES.map });
    expect(settings.operators).toMatchObject({ pattern: REFERENCE_PATTERN, errorMessage: VALUE_MESSAGES.list });
    expect(settings.name).toEqual({ type: "string" });
  });

  it("accepts a ${…} reference in a setting with an enum", () => {
    expect(settings.mode).toEqual({
      anyOf: [
        { enum: ["fast", "slow"], type: "string" },
        { pattern: REFERENCE_PATTERN, type: "string" },
      ],
    });
  });

  it("accepts null for a component, an object and a list, and never for a scalar", () => {
    expect(receiver.type).toContain("null");
    expect(resolved(schema, settings.local).type).toContain("null");
    expect(settings.operators!.type).toContain("null");
    for (const scalar of ["count", "enabled", "ratio", "timeout", "name"]) expect(settings[scalar]!.type).not.toContain("null");
  });

  it("accepts a plain string for a list of strings", () => {
    expect(settings.include).toEqual({ errorMessage: VALUE_MESSAGES.listOfStrings, items: { type: "string" }, type: ["array", "string", "null"] });
  });

  it("accepts an integer for a duration", () => {
    expect(settings.timeout).toEqual({ errorMessage: VALUE_MESSAGES.duration, type: ["string", "integer"] });
  });

  it("leaves a Go type upstream only names open", () => {
    expect(settings.anything).toEqual({});
  });

  it("opens an object that embeds an open definition, keeping its settings", () => {
    const exporter = resolved(schema, properties(section(schema, "exporters")).http_sample);
    expect(exporter.additionalProperties).toBeUndefined();
    expect(exporter.$comment).toBe("Open: the fixture's client reads deprecated keys");
    expect(Object.keys(properties(exporter))).toEqual(["encoding", "endpoint", "timeout"]);
  });

  it("lets the object's own keys win over an embedded member's", () => {
    const exporter = resolved(schema, properties(section(schema, "exporters")).http_sample);
    expect(properties(exporter).endpoint).toEqual({
      description: "The exporter's own endpoint, which wins over the embedded client's.",
      type: "string",
    });
  });

  it("merges allOf members in order, a later member's key replacing an earlier one's", () => {
    expect(settings.order).toMatchObject({ description: "From the second embedded member, which wins.", type: ["boolean", "string"] });
  });

  it("accepts a plain string for a list whose items are a string definition", () => {
    expect(settings.names).toEqual({
      errorMessage: VALUE_MESSAGES.listOfStrings,
      items: { $ref: "#/$defs/name" },
      type: ["array", "string", "null"],
    });
  });

  it("applies a component's own open part when another file referred to it first", () => {
    const inner = properties(section(schema, "receivers")).inner!;
    expect(settings.inner).toEqual(inner);
    expect(resolved(schema, inner).$comment).toBe("Open: the fixture's inner receiver reads more than it says");
    expect(resolved(schema, inner).additionalProperties).toBeUndefined();
    expect(Object.keys(properties(resolved(schema, inner)))).toEqual(["depth"]);
  });

  it("opens a definition's enum to any casing at a path, its values still offered", () => {
    const copied = resolved(schema, settings.copied);
    expect(properties(copied).kind).toEqual({
      $comment: "Open: the fixture's kind is lowercased first",
      anyOf: [
        { enum: ["first", "second"], type: "string" },
        { pattern: `(?i)^(?:first|second)$|${REFERENCE_PATTERN}`, type: "string" },
      ],
      description: "An enum checked in any casing.",
    });
  });

  it("keeps a never-checked enum's values as suggestions and accepts any string (any scalar, in a copy)", () => {
    expect(properties(resolved(schema, settings.copied)).scheme).toEqual({
      $comment: "Open: the fixture's scheme is never checked",
      ...SCALAR_STRING,
      description: "An enum never checked.",
      examples: ["plain", "secure"],
    });
  });

  it("lets every string a `*` part's definitions write take any scalar: settings, nested objects, list items, map values", () => {
    const copied = properties(resolved(schema, settings.copied));
    expect(copied.label).toEqual(SCALAR_STRING);
    expect(properties(copied.nested!).tag).toEqual(SCALAR_STRING);
    expect(properties(copied.nested!).depth).toMatchObject({ type: ["integer", "string"] });
    expect(copied.tags!.items).toEqual(SCALAR_STRING);
    expect(copied.headers!.additionalProperties).toEqual(SCALAR_STRING);
  });

  it("lets the strings of an embedded `*` definition take any scalar where it is embedded", () => {
    expect(settings.inherited).toEqual({ ...SCALAR_STRING, description: "A copied string the receiver embeds." });
  });

  it("never lets a `*` part reach through a $ref, nor name a definition of another package", () => {
    const copied = properties(resolved(schema, settings.copied));
    expect(copied.named).toEqual({ $ref: "#/$defs/name" });
    expect(definitions(schema).name).toEqual({ type: "string" });
    expect(resolved(schema, settings.other_copy)).toEqual({
      description: "A string in another package whose name starts like the copy's.",
      type: "string",
    });
    // a `*` definition with no string of its own (an enum) is left as it is
    expect(resolved(schema, copied.protocols!.items).anyOf).toEqual([
      { enum: ["One", "Two"], type: "string" },
      { pattern: REFERENCE_PATTERN, type: "string" },
    ]);
  });

  it("opens a definition to unknown keys beside its other parts", () => {
    const copied = resolved(schema, settings.copied);
    expect(copied.additionalProperties).toBeUndefined();
    expect(copied.$comment).toBe("Open: the fixture's copy omits a key");
  });

  it("stops on a definition's path that isn't there or crosses a $ref, and on an enum kind for what isn't an enum", () => {
    const at = (path: string, open: OpenPart["open"]): OpenPart => ({ definition: "contrib/receiver/samplereceiver.copy_outer", path, open, reason: "x" });
    expect(problems({ openParts: [...OPEN_PARTS, at("missing", "any value")] })).toEqual([
      "contrib/receiver/samplereceiver.copy_outer has no missing to open",
    ]);
    // a path ending at a reference opens the reference, never the definition it names
    expect(problems({ openParts: [...OPEN_PARTS, at("protocols.[]", "any casing")] })).toEqual([
      `contrib/receiver/samplereceiver.copy_outer protocols.[] isn't an enum, so its open part can't be "any casing"`,
    ]);
    expect(problems({ openParts: [...OPEN_PARTS, at("label", "any casing"), at("tags", "any string")] })).toEqual([
      `contrib/receiver/samplereceiver.copy_outer label isn't an enum, so its open part can't be "any casing"`,
      `contrib/receiver/samplereceiver.copy_outer tags isn't an enum, so its open part can't be "any string"`,
    ]);
  });

  it("stops on a part naming one definition with no string for strings taking any scalar, and on a `*` with no file before it", () => {
    const one: OpenPart = { definition: "contrib/receiver/samplereceiver.copy_protocol", open: "strings take any scalar", reason: "nothing" };
    expect(problems({ openParts: [...OPEN_PARTS, one] })).toEqual([
      `contrib/receiver/samplereceiver.copy_protocol has no string setting of its own, so its open part can't be "strings take any scalar"`,
    ]);
    const noFile: OpenPart = { definition: "contrib/receiver/sample*", open: "unknown keys", reason: "nothing" };
    expect(problems({ openParts: [...OPEN_PARTS, noFile] })).toEqual([
      "the open part contrib/receiver/sample* is used nowhere on 0.200.0: remove it, or limit its versions",
    ]);
  });

  it("counts a root that only says it is an object as describing no settings", () => {
    const objectOnly = "  - gomod: github.com/open-telemetry/opentelemetry-collector-contrib/exporter/objectonlyexporter v0.200.0\n";
    const manifest = request().manifest.replace("extensions:\n", `${objectOnly}extensions:\n`);
    expect(problems({ manifest })).toEqual([
      "exporter/object_only has an upstream schema that describes none of its settings: list it in open-parts.json or hand-written.json's withoutSettings",
    ]);
  });

  it("stops on an unknown-keys part for an object that is already open", () => {
    const own: OpenPart = { definition: "contrib/exporter/httpexporter", open: "unknown keys", reason: "nothing" };
    expect(problems({ openParts: [...OPEN_PARTS, own] })).toEqual([
      `contrib/exporter/httpexporter isn't a closed object, so its open part can't be "unknown keys"`,
    ]);
  });

  it("stops on an alias that is also a type", () => {
    const clash = "  - gomod: github.com/open-telemetry/opentelemetry-collector-contrib/receiver/clashreceiver v0.200.0\n";
    const manifest = request().manifest.replace("processors:\n", `${clash}processors:\n`);
    const outside: OpenPart = { component: "receiver/clash", open: "unknown keys", reason: "the fixture's clash receiver has no schema" };
    expect(problems({ manifest, openParts: [...OPEN_PARTS, outside] })).toEqual(["the receiver alias otlp is also a receiver's type"]);
  });

  it("keeps only the definitions something refers to", () => {
    const $defs = definitions(schema);
    // the open path replaced the only reference to the sample processor's statement_group
    expect($defs.statement_group).toBeUndefined();
    const reached = new Set<string>();
    const visit = (node: Json): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string") {
            const name = value.slice("#/$defs/".length);
            expect($defs[name], value).toBeDefined();
            if (!reached.has(name)) {
              reached.add(name);
              visit($defs[name]!);
            }
          } else if (key !== "$defs") {
            visit(value);
          }
        }
      }
    };
    visit(schema);
    expect(Object.keys($defs).sort()).toEqual([...reached].sort());
  });

  it("offers each component by its type and accepts its old name through a pattern only, with the same settings", () => {
    const receivers = section(schema, "receivers");
    expect(Object.keys(properties(receivers))).toEqual(["inner", "otlp", "outside", "sample_logs"]);
    const patterns = receivers.patternProperties as Record<string, Schema>;
    expect(patterns["^samplelogs(/.+)?$"]).toEqual(properties(receivers).sample_logs);
    expect(receivers.additionalProperties).toBe(false);
  });

  it("accepts every component's instance ids through a pattern", () => {
    for (const name of ["receivers", "processors", "exporters", "extensions", "connectors"]) {
      const kind = section(schema, name);
      expect(Object.keys(properties(kind)).length, name).toBeGreaterThan(0);
      for (const [type, reference] of Object.entries(properties(kind))) {
        expect((kind.patternProperties as Record<string, Schema>)[`^${type}/.+$`]).toEqual(reference);
      }
    }
  });

  it("accepts only an empty map, null or a reference for a component without settings", () => {
    const forward = resolved(schema, properties(section(schema, "connectors")).forward);
    expect(forward).toEqual({
      additionalProperties: false,
      description: handWritten.withoutSettings["connector/forward"],
      pattern: REFERENCE_PATTERN,
      patternErrorMessage: VALUE_MESSAGES.map,
      type: ["object", "string", "null"],
    });
  });

  it("closes a component whose upstream schema is {} when hand-written.json says it takes no settings", () => {
    const connectors = section(schema, "connectors");
    const empty = resolved(schema, properties(connectors).empty);
    expect(empty).toEqual({
      additionalProperties: false,
      description: HAND_WRITTEN.withoutSettings["connector/empty"],
      pattern: REFERENCE_PATTERN,
      patternErrorMessage: VALUE_MESSAGES.map,
      type: ["object", "string", "null"],
    });
    expect((connectors.patternProperties as Record<string, Schema>)["^emptyold(/.+)?$"]).toEqual(properties(connectors).empty);
  });

  it("stops on a component whose upstream schema is {} that isn't listed, and opens it when open-parts.json lists it", () => {
    expect(problems({ handWritten })).toEqual([
      "connector/empty has an upstream schema that describes none of its settings: list it in open-parts.json or hand-written.json's withoutSettings",
    ]);
    const listed: OpenPart = { component: "connector/empty", open: "unknown keys", reason: "the fixture's connector reads keys it doesn't say" };
    const open = generate({ handWritten, openParts: [...OPEN_PARTS, listed] });
    expect(resolved(open, properties(section(open, "connectors")).empty)).toMatchObject({ $comment: `Open: ${listed.reason}` });
    expect(resolved(open, properties(section(open, "connectors")).empty).additionalProperties).toBeUndefined();
    expect(problems({ openParts: [...OPEN_PARTS, listed] })).toEqual([
      "connector/empty is in both open-parts.json and hand-written.json's withoutSettings: keep one",
    ]);
  });

  it("stops on a component hand-written.json says takes no settings when upstream's schema has some", () => {
    const withoutSettings = { ...HAND_WRITTEN.withoutSettings, "extension/sample_storage": "No settings." };
    expect(problems({ handWritten: { ...HAND_WRITTEN, withoutSettings } })).toEqual([
      "extension/sample_storage has an upstream schema with settings now: take it out of hand-written.json's withoutSettings",
    ]);
  });

  describe("an optional section (x-optional)", () => {
    const otlp = resolved(schema, properties(section(schema, "receivers")).otlp);
    const protocols = properties(properties(otlp).protocols!);
    const enabled = { description: expect.any(String), errorMessage: VALUE_MESSAGES.boolean, pattern: REFERENCE_PATTERN, type: ["boolean", "string"] };

    it("accepts enabled through an optional copy of its definition, the definition itself unchanged where it isn't optional", () => {
      expect(protocols.http).toEqual({ $ref: "#/$defs/client_config_optional" });
      const copy = resolved(schema, protocols.http);
      expect(properties(copy).enabled).toEqual(enabled);
      expect(Object.keys(properties(copy))).toEqual(["enabled", "endpoint", "timeout"]);
      // the copy keeps what the definition is: here open to unknown keys
      expect(copy.$comment).toBe("Open: the fixture's client reads deprecated keys");
      expect(protocols.grpc).toEqual({ $ref: "#/$defs/client_config" });
      expect(properties(resolved(schema, protocols.grpc)).enabled).toBeUndefined();
      expect(properties(resolved(schema, settings.client)).enabled).toBeUndefined();
    });

    it("keeps only the copy of a definition used only where it's optional, and a copy's own optional sections are copies", () => {
      expect(definitions(schema).keepalive_settings).toBeUndefined();
      const copy = definitions(schema).keepalive_settings_optional!;
      expect(copy.additionalProperties).toBe(false);
      expect(properties(copy).enabled).toEqual(enabled);
      expect(properties(copy).params).toEqual({ $ref: "#/$defs/keepalive_params_optional" });
      expect(properties(definitions(schema).keepalive_params_optional!).enabled).toEqual(enabled);
    });

    it("accepts enabled in an optional object upstream writes in place", () => {
      expect(Object.keys(properties(protocols.inline!))).toEqual(["enabled", "port"]);
      expect(protocols.inline!.additionalProperties).toBe(false);
    });

    it("refers to a definition that describes enabled itself as it is", () => {
      expect(protocols.switch).toEqual({ $ref: "#/$defs/switchable" });
      expect(properties(resolved(schema, protocols.switch)).enabled).toMatchObject({ description: "Upstream's own description of the section's enabled." });
    });

    it("follows a definition that is only a reference to the object it names, copying it there", () => {
      expect(protocols.aliased).toEqual({ $ref: "#/$defs/aliased_optional" });
      expect(Object.keys(properties(definitions(schema).aliased_optional!))).toEqual(["depth", "enabled"]);
      // the object behind the alias describes enabled itself: nothing to copy
      expect(protocols.switch_alias).toEqual({ $ref: "#/$defs/alias_switch" });
      expect(definitions(schema).switchable_optional).toBeUndefined();
    });

    it("stops on an optional section behind references that never reach a definition", () => {
      const loop = "  - gomod: github.com/open-telemetry/opentelemetry-collector-contrib/receiver/loopreceiver v0.200.0\n";
      const manifest = request().manifest.replace("processors:\n", `${loop}processors:\n`);
      expect(problems({ manifest })).toEqual([
        "contrib/receiver/loopreceiver.section is optional (x-optional), but contrib/receiver/loopreceiver.first refers on without reaching a definition",
      ]);
    });

    it("leaves a scalar marked optional as it is", () => {
      expect(settings.name).toEqual({ type: "string" });
    });
  });

  describe("a setting named after a Go field", () => {
    const policy = resolved(schema, properties(section(schema, "processors")).policy);

    it("drops a ,remain map listed to be dropped, its object's other keys holding the map's values, where its definition is used and where it is embedded", () => {
      const item = resolved(schema, properties(policy).policies!.items);
      expect(Object.keys(properties(item))).toEqual(["name"]);
      // map[string]map[string]any: each other key holds a map of anything
      expect(item.additionalProperties).toEqual({
        additionalProperties: {},
        pattern: REFERENCE_PATTERN,
        patternErrorMessage: VALUE_MESSAGES.map,
        type: ["object", "string", "null"],
      });
      expect(item.$comment).toBe("Other keys: the fixture's policy holds its other keys");
      const group = properties(policy).group!;
      expect(Object.keys(properties(group))).toEqual(["kind", "label"]);
      expect(group.additionalProperties).toMatchObject({ type: ["object", "string", "null"] });
      expect(group.$comment).toBe("Other keys: the fixture's sub-policy holds its other keys");
      expect(keysOf(schema).has("ExtensionCfg")).toBe(false);
    });

    it("stops on a part dropping a setting in its place that isn't a map", () => {
      const scalar: OpenPart = { definition: "contrib/processor/policyprocessor.policy", path: "name", open: "unknown keys in its place", reason: "x" };
      expect(problems({ openParts: [...OPEN_PARTS, scalar] })).toEqual([
        `contrib/processor/policyprocessor.policy.name isn't a map, so its open part can't be "unknown keys in its place"`,
      ]);
    });

    it("keeps a capitalised setting the collector reads by that name", () => {
      expect(properties(policy).Fixed).toMatchObject({ additionalProperties: { type: "string" } });
      expect(policy.additionalProperties).toBe(false);
    });

    it("stops on one neither list names, and on an entry nothing uses", () => {
      expect(problems({ capitalisedKeys: [] })).toEqual([
        "contrib/processor/policyprocessor.headers has a setting named Fixed, a Go field's name: if the collector reads it by that name, " +
          "list it in open-parts.json's capitalisedKeys under contrib/processor/policyprocessor.headers; " +
          'if it is a ,remain map, drop it with an "unknown keys in its place" part',
      ]);
      const stale: CapitalisedKeys = { definition: "contrib/processor/policyprocessor.policy", keys: ["Name"], reason: "nothing" };
      expect(problems({ capitalisedKeys: [...CAPITALISED_KEYS, stale] })).toEqual([
        "the capitalised keys of contrib/processor/policyprocessor.policy are used nowhere on 0.200.0: remove the entry, or limit its versions",
      ]);
      const missing: OpenPart = { definition: "contrib/processor/policyprocessor.headers", path: "Missing", open: "unknown keys in its place", reason: "x" };
      expect(problems({ openParts: [...OPEN_PARTS, missing] })).toEqual([
        "the open part contrib/processor/policyprocessor.headers is used nowhere on 0.200.0: remove it, or limit its versions",
      ]);
    });

    it("stops on a part dropping a setting in its place that names no definition's own setting", () => {
      const atComponent: OpenPart = { component: "processor/sample", path: "statements", open: "unknown keys in its place", reason: "x" };
      expect(problems({ openParts: [...OPEN_PARTS, atComponent] })).toEqual([
        `processor/sample statements isn't a definition's own setting named after a Go field (the part names the definition and the setting as its path), so its open part can't be "unknown keys in its place"`,
      ]);
    });
  });

  it("lets a list's items also be a plain string, keeping the closed object they refer to", () => {
    const processor = resolved(schema, properties(section(schema, "processors")).sample);
    expect(properties(processor).groups!.items).toEqual({
      $comment: "Open: the fixture's groups may be strings",
      anyOf: [{ type: "string" }, { $ref: "#/$defs/group" }],
    });
    expect(definitions(schema).group).toMatchObject({ additionalProperties: false, properties: { statements: expect.any(Object) } });
  });

  it("stops on an entry naming a component upstream has a schema with settings for", () => {
    const stale: OpenPart = { component: "receiver/inner", open: "unknown keys", reason: "Upstream has no schema for it." };
    expect(problems({ openParts: [...OPEN_PARTS, stale] })).toEqual([
      "receiver/inner has an upstream schema with settings now (contrib/receiver/innerreceiver): its open-parts.json entry says upstream describes none; " +
        "remove it, or name contrib/receiver/innerreceiver as a definition if a part of the schema is still wrong",
    ]);
  });

  it("says to extend an entry's versions when one limited to other versions would answer", () => {
    const extend = "its open-parts.json entry applies to 0.199.0 only: extend its versions with 0.200.0 if its reason still holds there";
    const limit = (part: OpenPart): OpenPart => ({ ...part, versions: ["0.199.0"] });
    const openParts = OPEN_PARTS.map((part) =>
      part.component === "exporter/bare" || part.definition === "contrib/pkg/nowhere.gone" ? limit(part) : part,
    );
    expect(problems({ openParts })).toEqual([
      `exporter/bare has no upstream schema: ${extend}`,
      `contrib/pkg/nowhere.gone doesn't exist upstream (referenced from contrib/receiver/samplereceiver.missing): ${extend}`,
    ]);
    const capitalisedKeys = CAPITALISED_KEYS.map((entry) => ({ ...entry, versions: ["0.199.0"] }));
    expect(problems({ capitalisedKeys })).toEqual([
      `contrib/processor/policyprocessor.headers has a setting named Fixed, a Go field's name: ${extend}`,
    ]);
  });

  it("writes the service section by hand", () => {
    expect(section(schema, "service")).toEqual(sortKeys(handWritten.service));
    const pipelines = properties(section(schema, "service")).pipelines!;
    expect(Object.keys(properties(pipelines))).toEqual(["logs", "metrics", "profiles", "traces"]);
    expect(Object.keys(pipelines.patternProperties as Schema)).toEqual(["^(logs|metrics|profiles|traces)/.+$"]);
    const pipeline = resolved(schema, properties(pipelines).traces);
    expect(Object.keys(properties(pipeline))).toEqual(["exporters", "processors", "receivers"]);
    expect(properties(pipeline).receivers).toMatchObject({ type: ["array", "string", "null"], errorMessage: VALUE_MESSAGES.listOfStrings });
    expect(properties(section(schema, "service")).telemetry!.type).toBeUndefined();
  });

  it("closes the configuration's top level", () => {
    expect(Object.keys(properties(schema))).toEqual(["connectors", "exporters", "extensions", "processors", "receivers", "service"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("names its sources, their commits and the license in a top-level $comment", () => {
    const comment = schema.$comment as string;
    for (const source of Object.values(SOURCES)) {
      expect(comment).toContain(`${source.repository} ${source.tag} (commit ${source.commit})`);
    }
    expect(comment).toContain("distributions/otelcol-sample/manifest.yaml");
    expect(comment).toContain("metadata.yaml type names");
    expect(comment).toContain("Apache License, Version 2.0");
  });

  it("drops x- extensions, format and titles", () => {
    const keys = keysOf(schema);
    expect([...keys].filter((key) => key.startsWith("x-"))).toEqual([]);
    expect(keys.has("format")).toBe(false);
    expect(keys.has("title")).toBe(false);
  });

  it("gives every definition a readable name, without a . or a /", () => {
    const names = Object.keys(definitions(schema));
    expect(names.filter((name) => /[./]/.test(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(["sample_logs_receiver", "local_settings", "client_config", "rootonly_config"]));
  });

  it("writes the same bytes from the same inputs, minified with sorted keys", () => {
    const first = generateSchema(request());
    expect(generateSchema(request({ openParts: [...OPEN_PARTS].reverse() }))).toBe(first);
    expect(JSON.stringify(sortKeys(JSON.parse(first) as Json))).toBe(first);
    expect(first).not.toContain("\n");
  });
});

describe("the committed schemas", () => {
  const distributions = Object.keys(committedInputs.distributions);
  const catalogue = (distribution: string): unknown => JSON.parse(readFileSync(`${CATALOGUE}${distribution}.json`, "utf8"));

  it("have a file for every offered version of every distribution with schemas, and none for another version", () => {
    const withFiles = readdirSync(PUBLIC_SCHEMAS).sort();
    expect(withFiles).toEqual([...distributions].sort());
    for (const distribution of withFiles) {
      expect(existsSync(`${CATALOGUE}${distribution}.json`)).toBe(true);
      const offered = offeredVersions(catalogue(distribution));
      expect(offered.length).toBeGreaterThan(0);
      expect(readdirSync(`${PUBLIC_SCHEMAS}${distribution}`).sort()).toEqual(offered.map((version) => `v${version}.json`).sort());
      expect(Object.keys(committedInputs.distributions[distribution]!.versions).sort()).toEqual([...offered].sort());
    }
  });

  for (const distribution of distributions) {
    for (const version of Object.keys(committedInputs.distributions[distribution]!.versions)) {
      describe(`${distribution} ${version}`, () => {
        const read = (): Schema => JSON.parse(readFileSync(schemaFile(distribution, version), "utf8")) as Schema;

        it("names the pinned sources and the license", () => {
          const schema = read();
          const sources = committedInputs.distributions[distribution]!.versions[version]!;
          for (const source of [sources.contrib, sources.core, sources.releases]) {
            expect(schema.$comment).toContain(`${source.repository} ${source.tag} (commit ${source.commit})`);
          }
          expect(schema.$comment).toContain("Apache License, Version 2.0");
        });

        it("accepts each of the catalogue's renames by its old name from its since, with the new name's settings", () => {
          const schema = read();
          const renames = (CATALOGUE_RENAMED_TYPES[distribution] ?? []).filter((rename) => isAtOrAfter(version, rename.since));
          expect(renames.length).toBeGreaterThan(0);
          for (const { kind, name, deprecatedName } of renames) {
            const kindSection = section(schema, `${kind}s`);
            const reference = properties(kindSection)[name];
            expect(reference, `${kind} ${name}`).toBeDefined();
            expect(properties(kindSection)[deprecatedName], `${kind} ${deprecatedName} isn't offered`).toBeUndefined();
            expect((kindSection.patternProperties as Record<string, Schema>)[`^${deprecatedName}(/.+)?$`], `${kind} ${deprecatedName}`).toEqual(reference);
          }
        });
      });
    }
  }
});
