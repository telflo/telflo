import { z } from "zod";
import { CollectorDistributionIdSchema, CollectorVersionNumberSchema } from "./collector-distributions.js";
import { FlowSlugSchema } from "./flow-slug.js";

/*
 * The configurations endpoints: listing a page of the active organization's
 * configurations, creating one, changing its name or description, and
 * deleting it; reading one with the version the editor opens, and saving
 * that version's YAML; the version list, reading one version, creating,
 * renaming and selecting one. A configuration and a version say whether
 * they are published, and the list has a filter. A configuration has a
 * distribution and each version a collector version. A create may carry a
 * flow's content, its collector version and the flow's slug.
 */

/** The name's and the description's limits, after trimming; the table's checks say the same. */
export const CONFIGURATION_NAME_MAXIMUM_LENGTH = 200;
export const CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH = 500;

/**
 * The limit on a version's YAML: 256 Ki. It counts UTF-16 code units,
 * as a JavaScript string's length and the editor do; the table's check
 * counts code points, which are never more, so this is the stricter.
 */
export const CONFIGURATION_YAML_MAXIMUM_LENGTH = 262_144;

/** The list's search text, after trimming. */
export const CONFIGURATION_SEARCH_MAXIMUM_LENGTH = 200;

/** A page of the list holds this many unless `limit` says otherwise, and never more than the maximum. */
export const CONFIGURATIONS_PAGE_DEFAULT_LIMIT = 50;
export const CONFIGURATIONS_PAGE_MAXIMUM_LIMIT = 100;

/**
 * An opaque cursor is the base64url of a timestamp and a UUID, about 100
 * characters; anything much longer is no cursor of ours.
 */
const CONFIGURATIONS_CURSOR_MAXIMUM_LENGTH = 256;

/**
 * Trimmed, then 1 to 200 characters. Text Postgres can't store exactly is
 * refused (`hasUnstorableCharacter`): U+0000 would fail the insert, and a
 * lone surrogate would be stored as U+FFFD.
 */
export const ConfigurationNameSchema = z
  .string()
  .trim()
  .min(1, "Configuration name cannot be empty")
  .max(CONFIGURATION_NAME_MAXIMUM_LENGTH)
  .refine((name) => !hasUnstorableCharacter(name), "The name can't contain U+0000 or a lone surrogate.");

/** Trimmed, at most 500 characters; `''` is no description. Text Postgres can't store exactly is refused, as the name's is. */
export const ConfigurationDescriptionSchema = z
  .string()
  .trim()
  .max(CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH)
  .refine((description) => !hasUnstorableCharacter(description), "The description can't contain U+0000 or a lone surrogate.");

/**
 * `PATCH /api/v1/organizations/:organizationId/configurations/:configurationId`:
 * the name, the description, both or neither. `''` clears the description;
 * `null` is refused.
 */
export const UpdateConfigurationRequestSchema = z
  .object({
    name: ConfigurationNameSchema.optional(),
    description: ConfigurationDescriptionSchema.optional(),
  })
  .strict();

export type UpdateConfigurationRequest = z.infer<typeof UpdateConfigurationRequestSchema>;

/** Who created a configuration. A soft-deleted account keeps its email here. */
export const ConfigurationCreatorSchema = z
  .object({
    userId: z.string().uuid(),
    email: z.string(),
  })
  .strict();

export type ConfigurationCreator = z.infer<typeof ConfigurationCreatorSchema>;

/**
 * A configuration in a response. The timestamps are ISO 8601; `createdBy` is
 * null once the creator's account is hard-deleted. `published` is true when
 * at least one of its versions is, else it is a draft, which only its creator
 * sees. `collectorDistribution` is the catalogue distribution it is built
 * for, chosen when it was created and never changed.
 */
export const ConfigurationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    createdBy: ConfigurationCreatorSchema.nullable(),
    published: z.boolean(),
    collectorDistribution: z.string(),
  })
  .strict();

export type Configuration = z.infer<typeof ConfigurationSchema>;

/** The answer of creating and of changing one. */
export const ConfigurationResponseSchema = z.object({ configuration: ConfigurationSchema }).strict();

export type ConfigurationResponse = z.infer<typeof ConfigurationResponseSchema>;

/**
 * `GET /api/v1/organizations/:organizationId/configurations`: a page, newest
 * update first. `nextCursor` is opaque, and null on the last page.
 */
export const ConfigurationsPageSchema = z
  .object({
    items: z.array(ConfigurationSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ConfigurationsPage = z.infer<typeof ConfigurationsPageSchema>;

/**
 * The list's filters: every configuration the caller can see, only the
 * ones they created, or only the published ones. The server applies it,
 * since the list is paged.
 */
export const CONFIGURATIONS_LIST_FILTERS = ["all", "mine", "published"] as const;

export type ConfigurationsListFilter = (typeof CONFIGURATIONS_LIST_FILTERS)[number];

/**
 * The list's query, as the query string carries it: every value a string,
 * coerced here. `limit` 1 to 100, 50 when left out; `cursor` a previous
 * page's `nextCursor`; `q` the search text, trimmed, empty meaning none;
 * `filter` one of `CONFIGURATIONS_LIST_FILTERS`, `all` when left out. The
 * cursor is positional and carries neither `q` nor `filter`: a client sends
 * the same ones with every page. Strict: an unknown parameter, `mine`
 * included, is 400 `invalid_request`.
 */
export const ListConfigurationsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONFIGURATIONS_PAGE_MAXIMUM_LIMIT)
      .default(CONFIGURATIONS_PAGE_DEFAULT_LIMIT),
    cursor: z.string().max(CONFIGURATIONS_CURSOR_MAXIMUM_LENGTH).optional(),
    q: z.string().trim().max(CONFIGURATION_SEARCH_MAXIMUM_LENGTH).optional(),
    filter: z.enum(CONFIGURATIONS_LIST_FILTERS).default("all"),
  })
  .strict();

/** What a client puts in the query string. */
export type ListConfigurationsQuery = z.input<typeof ListConfigurationsQuerySchema>;

/**
 * The limit on a version's label, after trimming; the table's check says the
 * same (1 to 80 characters).
 */
export const CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH = 80;

/**
 * A version's label as a rename sends it: trimmed, then 1 to 80
 * characters, with no character Postgres can't store exactly. Labels are
 * the user's text.
 */
export const ConfigurationVersionLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH)
  .refine((label) => !hasUnstorableCharacter(label), "The label can't contain U+0000 or a lone surrogate.");

/**
 * A version as the picker lists it: no content. `label` is null for an
 * unnamed version, shown as "Version N"; `createdBy` is null once the
 * creator's account is hard-deleted, as a configuration's is. The
 * timestamps are ISO 8601; `updatedAt` is the last save, which a rename
 * doesn't move. `publishedAt` is when it was published, null on a draft; a
 * published version can't be changed. `publishedBy` is the member who
 * published it, by `createdBy`'s rule: null on a draft, and once the
 * publisher's account is hard-deleted. `collectorVersion` is the collector
 * version it is pinned to, a version of its configuration's distribution.
 * The catalogue may have deprecated it since; the pin is kept, and
 * `collectorVersionDeprecated` says so, with the catalogue's
 * `collectorVersionDeprecatedNote` (null unless deprecated).
 */
export const ConfigurationVersionSummarySchema = z
  .object({
    id: z.string().uuid(),
    versionNumber: z.number().int().min(1),
    label: z.string().nullable(),
    createdBy: ConfigurationCreatorSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
    publishedBy: ConfigurationCreatorSchema.nullable(),
    collectorVersion: z.string(),
    collectorVersionDeprecated: z.boolean(),
    collectorVersionDeprecatedNote: z.string().nullable(),
  })
  .strict();

export type ConfigurationVersionSummary = z.infer<typeof ConfigurationVersionSummarySchema>;

/**
 * A version of a configuration in a response: its summary, its configuration,
 * its YAML, and the builder's layout. The three graph columns are arrays of
 * anything on the way out: a row written by an older or another writer never
 * makes a configuration unopenable, and the editor reads what it can.
 */
export const ConfigurationVersionSchema = ConfigurationVersionSummarySchema.extend({
  configurationId: z.string().uuid(),
  yamlContent: z.string(),
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  pipelines: z.array(z.unknown()),
}).strict();

export type ConfigurationVersion = z.infer<typeof ConfigurationVersionSchema>;

/**
 * `GET /api/v1/organizations/:organizationId/configurations/:configurationId`
 * and `GET …/configurations/:configurationId/versions/:versionId`: the
 * configuration, the version the editor opens (the caller's selection, else
 * the highest; or the one the path names), and every version's summary,
 * highest number first.
 */
export const ConfigurationWithVersionResponseSchema = z
  .object({
    configuration: ConfigurationSchema,
    version: ConfigurationVersionSchema,
    versions: z.array(ConfigurationVersionSummarySchema),
  })
  .strict();

export type ConfigurationWithVersionResponse = z.infer<typeof ConfigurationWithVersionResponseSchema>;

/** The answer of saving a version, and of creating one. */
export const ConfigurationVersionResponseSchema = z.object({ version: ConfigurationVersionSchema }).strict();

export type ConfigurationVersionResponse = z.infer<typeof ConfigurationVersionResponseSchema>;

/** The answer of renaming a version: its summary. */
export const ConfigurationVersionSummaryResponseSchema = z
  .object({ version: ConfigurationVersionSummarySchema })
  .strict();

export type ConfigurationVersionSummaryResponse = z.infer<typeof ConfigurationVersionSummaryResponseSchema>;

/**
 * The versions list's filters: every version, or only the published ones.
 */
export const CONFIGURATION_VERSIONS_FILTERS = ["all", "published"] as const;

export type ConfigurationVersionsFilter = (typeof CONFIGURATION_VERSIONS_FILTERS)[number];

/**
 * `GET …/configurations/:configurationId/versions`'s query: `filter` one of
 * `CONFIGURATION_VERSIONS_FILTERS`, `all` when left out. Unpaged, as the
 * editor's read. Strict: an unknown parameter is 400 `invalid_request`.
 */
export const ConfigurationVersionsQuerySchema = z
  .object({ filter: z.enum(CONFIGURATION_VERSIONS_FILTERS).default("all") })
  .strict();

/** What a client puts in the query string. */
export type ConfigurationVersionsQuery = z.input<typeof ConfigurationVersionsQuerySchema>;

/**
 * A version as the versions route lists it: only its id, number, label
 * and published date (what a picker shows, and the id a pin names). No
 * content or layout, and none of the summary's members, times or
 * collector version. `label` is null for an unnamed version;
 * `publishedAt` null on a draft.
 */
export const ConfigurationVersionListItemSchema = z
  .object({
    id: z.string().uuid(),
    versionNumber: z.number().int().min(1),
    label: z.string().nullable(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();

export type ConfigurationVersionListItem = z.infer<typeof ConfigurationVersionListItemSchema>;

/**
 * `GET …/configurations/:configurationId/versions`'s answer: the
 * configuration's versions, highest number first (the pickers' read; the
 * editor's carries the content and the layout).
 */
export const ConfigurationVersionsResponseSchema = z
  .object({ versions: z.array(ConfigurationVersionListItemSchema) })
  .strict();

export type ConfigurationVersionsResponse = z.infer<typeof ConfigurationVersionsResponseSchema>;

/**
 * A version id in a request body: any string up to 64 characters, so one
 * that isn't a UUID reaches the service, which answers it 404
 * `configuration_version_not_found` as it does an unknown one, never
 * 400. A UUID is 36; 64 leaves room for the spellings the service refuses.
 */
const VersionIdReferenceSchema = z.string().max(64);

/**
 * A lone surrogate: a `u` pattern reads a well-formed pair as one code
 * point, never as `\p{Surrogate}`. It is `String.prototype.isWellFormed()`
 * negated, which the ES2023 library these packages compile against doesn't
 * declare.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Whether `text` holds a character Postgres can't store exactly: U+0000 or a
 * lone surrogate. The save's schema refuses both; the editor checks first,
 * so it can say what to do.
 */
export function hasUnstorableCharacter(text: string): boolean {
  return text.includes("\u0000") || LONE_SURROGATE.test(text);
}

/**
 * A version's YAML, exactly as sent: not trimmed, its line endings as they
 * are, `''` allowed, at most 262,144 characters. Text Postgres can't store
 * exactly is refused: U+0000, which a `text` column rejects, and a lone
 * surrogate, which would be stored as U+FFFD.
 */
const ConfigurationYamlSchema = z
  .string()
  .max(CONFIGURATION_YAML_MAXIMUM_LENGTH)
  .refine((text) => !text.includes("\u0000"), "The YAML can't contain the character U+0000.")
  .refine((text) => !LONE_SURROGATE.test(text), "The YAML can't contain a lone surrogate.");

/*
 * The builder's graph, as a save stores it: the nodes, edges and pipelines,
 * without React Flow's runtime fields. Strict, so `measured`, `selected`,
 * `dragging`, `width`, `height`, `positionAbsolute` and `resizing` are
 * refused, as is anything unknown.
 *
 * The bounds are what the editor's best-effort writer (`toStored`)
 * guarantees: every check here is local to one value, so the writer can run
 * these very schemas on what it built and store `config: null`, or a column
 * as `[]`, where they refuse. Nothing here stops the text's save.
 *
 * A refusal says which rule, never what was refused: no issue carries a
 * value (`z.custom` rather than `z.enum`, whose issue echoes what it
 * received) and no path goes below a node's `config`, whose keys are the
 * text's. Labels, names and configs are private.
 */

/** The ids' forms: a number, so no name can travel in an id. */
export const GRAPH_NODE_ID_PATTERN = /^node_\d{1,6}$/;
export const GRAPH_GROUP_ID_PATTERN = /^group_\d{1,6}$/;
export const GRAPH_EDGE_ID_PATTERN = /^edge_\d{1,6}$/;
export const GRAPH_PIPELINE_ID_PATTERN = /^pipeline_\d{1,6}$/;

/** The bounds on each column. */
export const GRAPH_MAXIMUM_NODES = 5_000;
export const GRAPH_MAXIMUM_EDGES = 10_000;
export const GRAPH_MAXIMUM_PIPELINES = 1_000;

/**
 * Each column's `JSON.stringify`, in UTF-8 bytes. The table's check allows
 * 4 MiB of `jsonb::text` behind it, a backstop: Postgres prints jsonb with
 * spaces and canonical numbers, so a column this allows can still exceed it
 * (`1e300` is 6 bytes here, 301 there), and the save answers that 400 too.
 */
export const GRAPH_COLUMN_MAXIMUM_BYTES = 1_048_576;

/** A position's coordinates, and a group's width and height. */
export const GRAPH_POSITION_MAXIMUM = 1_000_000;
export const GRAPH_SIZE_MAXIMUM = 100_000;

/**
 * The text fields' lengths, in UTF-16 units. A component's type (at most
 * 100) and instance name (at most 200) fit, and so does every label and
 * `sharedConfigId` derived from them: a label is the palette's
 * label or the type, then " (<instance>)"; a `sharedConfigId` is
 * "<kind>-<type>/<instance>". A group's label is its pipeline's name. Only a
 * text whose own names are longer makes the writer store a column as `[]`.
 */
export const GRAPH_COMPONENT_SUBTYPE_MAXIMUM_LENGTH = 100;
export const GRAPH_INSTANCE_NAME_MAXIMUM_LENGTH = 200;
export const GRAPH_LABEL_MAXIMUM_LENGTH = 320;
export const GRAPH_SHARED_CONFIG_ID_MAXIMUM_LENGTH = 320;
export const GRAPH_PIPELINE_NAME_MAXIMUM_LENGTH = 256;

/**
 * How deeply a node's `config` may nest arrays and objects. A collector's
 * configuration nests a dozen levels at most; the bound keeps the checks
 * below and Postgres's jsonb parser, which recurses, far from their stacks.
 */
export const GRAPH_CONFIG_MAXIMUM_DEPTH = 64;

/**
 * A pipeline's name: a lowercase word, or any `type[/name]` the text may
 * hold.
 */
const GRAPH_PIPELINE_NAME_PATTERN = /^[a-z]+(\/[^\s]{1,200})?$/u;

const GRAPH_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export const GRAPH_COMPONENT_TYPES = ["receiver", "processor", "exporter", "extension", "connector"] as const;
export type GraphComponentType = (typeof GRAPH_COMPONENT_TYPES)[number];

export const GRAPH_SIGNAL_TYPES = ["traces", "metrics", "logs"] as const;
export type GraphSignalType = (typeof GRAPH_SIGNAL_TYPES)[number];

/** A JSON value, as `config` holds it. */
export type GraphJsonValue = null | boolean | number | string | GraphJsonValue[] | { [key: string]: GraphJsonValue };

/**
 * One of `values`, refused without echoing what was sent (a `z.enum`'s issue
 * carries the value it received).
 */
function oneOf<const Values extends readonly string[]>(values: Values, message: string) {
  const allowed: ReadonlySet<unknown> = new Set(values);
  return z.custom<Values[number]>((value) => allowed.has(value), { message });
}

/** Text Postgres can store in jsonb, within `maximum` UTF-16 units. */
function storableText(maximum: number) {
  return z
    .string()
    .max(maximum)
    .refine((text) => !hasUnstorableCharacter(text), "The graph can't contain U+0000 or a lone surrogate.");
}

/** A finite number within ±`maximum`: JSON has no infinity, and `1e400` parses to one. */
function finiteWithin(minimum: number, maximum: number) {
  return z.number().finite().min(minimum).max(maximum);
}

/**
 * Whether `value` is a JSON value Postgres can store in jsonb: null, a
 * boolean, a finite number, a string, an array or a plain object of them,
 * nested at most `GRAPH_CONFIG_MAXIMUM_DEPTH` deep, with no U+0000 or lone
 * surrogate in any string or key. Iterative, so no input can exhaust the
 * stack.
 */
export function isStorableJsonValue(value: unknown): value is GraphJsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value: current, depth } = next;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current === "string") {
      if (hasUnstorableCharacter(current)) return false;
      continue;
    }
    if (typeof current !== "object" || depth >= GRAPH_CONFIG_MAXIMUM_DEPTH) return false;
    if (Array.isArray(current)) {
      for (const item of current) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const [key, item] of Object.entries(current)) {
      if (hasUnstorableCharacter(key)) return false;
      pending.push({ value: item, depth: depth + 1 });
    }
  }
  return true;
}

/**
 * The length in UTF-8 bytes of `text`, as Postgres and the wire count it. A
 * lone surrogate counts 3, as U+FFFD; `JSON.stringify` escapes them anyway.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** A column's size as the bound counts it: its `JSON.stringify`, in UTF-8 bytes. */
export function graphColumnByteLength(column: readonly unknown[]): number {
  return utf8ByteLength(JSON.stringify(column));
}

const GraphPositionSchema = z
  .object({
    x: finiteWithin(-GRAPH_POSITION_MAXIMUM, GRAPH_POSITION_MAXIMUM),
    y: finiteWithin(-GRAPH_POSITION_MAXIMUM, GRAPH_POSITION_MAXIMUM),
  })
  .strict();

const GraphGroupStyleSchema = z
  .object({
    width: finiteWithin(0, GRAPH_SIZE_MAXIMUM),
    height: finiteWithin(0, GRAPH_SIZE_MAXIMUM),
  })
  .strict();

const GraphSignalTypeSchema = oneOf(GRAPH_SIGNAL_TYPES, "Expected traces, metrics or logs.");

const GraphColorSchema = z.string().regex(GRAPH_COLOR_PATTERN, "Expected a colour as #rrggbb.");

const GraphConfigSchema = z.custom<GraphJsonValue>(isStorableJsonValue, {
  message: `Expected a JSON value nested at most ${GRAPH_CONFIG_MAXIMUM_DEPTH} deep, without U+0000 or a lone surrogate.`,
});

const ComponentNodeSchema = z
  .object({
    id: z.string().regex(GRAPH_NODE_ID_PATTERN, "Expected a node id: node_<n>."),
    type: z.enum(GRAPH_COMPONENT_TYPES),
    position: GraphPositionSchema,
    parentId: z.string().regex(GRAPH_GROUP_ID_PATTERN, "Expected a group id: group_<n>.").optional(),
    data: z
      .object({
        label: storableText(GRAPH_LABEL_MAXIMUM_LENGTH),
        componentType: oneOf(GRAPH_COMPONENT_TYPES, "Expected a component type."),
        componentSubType: storableText(GRAPH_COMPONENT_SUBTYPE_MAXIMUM_LENGTH),
        instanceName: storableText(GRAPH_INSTANCE_NAME_MAXIMUM_LENGTH).optional(),
        config: GraphConfigSchema,
        connectorSignals: z
          .object({ inputSignal: GraphSignalTypeSchema, outputSignal: GraphSignalTypeSchema })
          .strict()
          .optional(),
        sharedConfigId: storableText(GRAPH_SHARED_CONFIG_ID_MAXIMUM_LENGTH).optional(),
      })
      .strict(),
  })
  .strict();

const GroupNodeSchema = z
  .object({
    id: z.string().regex(GRAPH_GROUP_ID_PATTERN, "Expected a group id: group_<n>."),
    type: z.literal("pipelineGroup"),
    position: GraphPositionSchema,
    style: GraphGroupStyleSchema.optional(),
    data: z
      .object({
        label: storableText(GRAPH_LABEL_MAXIMUM_LENGTH),
        pipelineId: z.string().regex(GRAPH_PIPELINE_ID_PATTERN, "Expected a pipeline id: pipeline_<n>."),
        signalType: GraphSignalTypeSchema,
        color: GraphColorSchema,
        // A group may carry these three as well.
        componentType: oneOf(["pipelineGroup"] as const, "Expected pipelineGroup.").optional(),
        componentSubType: oneOf(["pipelineGroup"] as const, "Expected pipelineGroup.").optional(),
        config: GraphConfigSchema.optional(),
      })
      .strict(),
  })
  .strict();

/**
 * A node as a save stores it: a component (`node_<n>`, maybe in a group) or
 * a pipeline's group (`group_<n>`, with its size). A component's
 * `componentType` is its `type`.
 */
export const GraphNodeSchema = z
  .discriminatedUnion("type", [ComponentNodeSchema, GroupNodeSchema])
  .superRefine((node, context) => {
    if (node.type !== "pipelineGroup" && node.data.componentType !== node.type) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data", "componentType"],
        message: "A component's componentType is its type.",
      });
    }
  });

export type GraphNode = z.infer<typeof GraphNodeSchema>;

/** An edge between two nodes, as a save stores it. */
export const GraphEdgeSchema = z
  .object({
    id: z.string().regex(GRAPH_EDGE_ID_PATTERN, "Expected an edge id: edge_<n>."),
    source: z.string().regex(GRAPH_NODE_ID_PATTERN, "Expected a node id: node_<n>."),
    target: z.string().regex(GRAPH_NODE_ID_PATTERN, "Expected a node id: node_<n>."),
    type: oneOf(["smoothstep"] as const, "Expected smoothstep."),
  })
  .strict();

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** A pipeline, as a save stores it: its name is the text's (`traces`, `traces/name`). */
export const GraphPipelineSchema = z
  .object({
    id: z.string().regex(GRAPH_PIPELINE_ID_PATTERN, "Expected a pipeline id: pipeline_<n>."),
    name: storableText(GRAPH_PIPELINE_NAME_MAXIMUM_LENGTH).refine(
      (name) => GRAPH_PIPELINE_NAME_PATTERN.test(name),
      "Expected a pipeline name: <type> or <type>/<name>.",
    ),
    signalType: GraphSignalTypeSchema,
    color: GraphColorSchema,
  })
  .strict();

export type GraphPipeline = z.infer<typeof GraphPipelineSchema>;

/** A column: at most `maximum` items, and at most 1 MiB of JSON in UTF-8 bytes. */
function graphColumn<Item extends z.ZodTypeAny>(item: Item, maximum: number) {
  return z
    .array(item)
    .max(maximum)
    .superRefine((column, context) => {
      let bytes: number;
      try {
        bytes = graphColumnByteLength(column);
      } catch {
        // Only a structure too deep to print, which the items' checks refuse first.
        bytes = Number.POSITIVE_INFINITY;
      }
      if (bytes > GRAPH_COLUMN_MAXIMUM_BYTES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `The column's JSON is over ${GRAPH_COLUMN_MAXIMUM_BYTES} bytes.`,
        });
      }
    });
}

/** The three columns a save writes. */
export const GraphNodesSchema = graphColumn(GraphNodeSchema, GRAPH_MAXIMUM_NODES);
export const GraphEdgesSchema = graphColumn(GraphEdgeSchema, GRAPH_MAXIMUM_EDGES);
export const GraphPipelinesSchema = graphColumn(GraphPipelineSchema, GRAPH_MAXIMUM_PIPELINES);

/**
 * `PATCH /api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId`:
 * the YAML saved over the version, with the builder's graph. All four are
 * required. `collectorVersion` is the version's collector version, left out to
 * keep the one stored: the stored one is always accepted, even if deprecated
 * since; a change must name a non-deprecated version of the configuration's
 * distribution, else 400 `collector_version_unknown`. Strict: an unknown field
 * is 400 `invalid_request`.
 */
export const SaveConfigurationVersionRequestSchema = z
  .object({
    yamlContent: ConfigurationYamlSchema,
    nodes: GraphNodesSchema,
    edges: GraphEdgesSchema,
    pipelines: GraphPipelinesSchema,
    collectorVersion: CollectorVersionNumberSchema.optional(),
  })
  .strict();

export type SaveConfigurationVersionRequest = z.infer<typeof SaveConfigurationVersionRequestSchema>;

/** A create's content: the save's four fields, which come together or not at all. */
const CREATE_CONTENT_FIELDS = ["yamlContent", "nodes", "edges", "pipelines"] as const;

/**
 * `POST /api/v1/organizations/:organizationId/configurations`. A description
 * left out is `''`. `collectorDistribution` is the distribution it is built
 * for, fixed for its life; left out, the catalogue's default. One the
 * catalogue doesn't offer is 400 `collector_distribution_unknown`.
 *
 * A create from a flow carries its version 1's content as the browser
 * parsed the flow: `yamlContent`, `nodes`, `edges` and `pipelines`, with
 * the save's schemas and limits, all four or none (a subset is 400
 * `invalid_request`); left out, version 1 holds `''` and an empty graph, as
 * before. `collectorVersion` is version 1's collector version, which must
 * be one the distribution (the one named, else the catalogue's default)
 * offers and hasn't deprecated, else 400 `collector_version_unknown`; left
 * out, the distribution's default. `sourceFlowSlug` names the flow it was
 * made from, checked for the slug's format only (a flow may be deleted
 * later; the configuration keeps its copy), stored and never answered. Each
 * may come without the others. Strict: an unknown field (`yaml` among
 * them) is 400 `invalid_request`.
 */
export const CreateConfigurationRequestSchema = z
  .object({
    name: ConfigurationNameSchema,
    description: ConfigurationDescriptionSchema.default(""),
    collectorDistribution: CollectorDistributionIdSchema.optional(),
    yamlContent: ConfigurationYamlSchema.optional(),
    nodes: GraphNodesSchema.optional(),
    edges: GraphEdgesSchema.optional(),
    pipelines: GraphPipelinesSchema.optional(),
    collectorVersion: CollectorVersionNumberSchema.optional(),
    sourceFlowSlug: FlowSlugSchema.optional(),
  })
  .strict()
  .refine(
    (request) => {
      const given = CREATE_CONTENT_FIELDS.filter((field) => request[field] !== undefined).length;
      return given === 0 || given === CREATE_CONTENT_FIELDS.length;
    },
    { message: "yamlContent, nodes, edges and pipelines come together, or not at all." },
  );

/** What a client sends: everything but the name may be left out, the content's four fields together. */
export type CreateConfigurationRequest = z.input<typeof CreateConfigurationRequestSchema>;

/**
 * A create's label: trimmed; left out, `''` or whitespace only means none,
 * parsed as undefined; else 1 to 80 characters, with no character Postgres
 * can't store exactly.
 */
const CreatedVersionLabelSchema = z
  .string()
  .trim()
  .max(CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH)
  .refine((label) => !hasUnstorableCharacter(label), "The label can't contain U+0000 or a lone surrogate.")
  .transform((label) => (label === "" ? undefined : label))
  .optional();

/**
 * `POST /api/v1/organizations/:organizationId/configurations/:configurationId/versions`:
 * a new version from `sourceVersionId`, holding the content the editor sends,
 * which has the save's limits. `collectorVersion` is the new version's
 * collector version: left out, the source's saved one; else the save's rule
 * against the source's (equal is accepted even if deprecated; a change must
 * name a non-deprecated version of the configuration's distribution, else 400
 * `collector_version_unknown`). Strict: an unknown field is 400
 * `invalid_request`.
 */
export const CreateConfigurationVersionRequestSchema = z
  .object({
    sourceVersionId: VersionIdReferenceSchema,
    label: CreatedVersionLabelSchema,
    yamlContent: ConfigurationYamlSchema,
    nodes: GraphNodesSchema,
    edges: GraphEdgesSchema,
    pipelines: GraphPipelinesSchema,
    collectorVersion: CollectorVersionNumberSchema.optional(),
  })
  .strict();

/** What a client sends: the label and the collector version may be left out. */
export type CreateConfigurationVersionRequest = z.input<typeof CreateConfigurationVersionRequestSchema>;

/**
 * `PUT /api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/label`:
 * renames the version. Strict.
 */
export const RenameConfigurationVersionRequestSchema = z.object({ label: ConfigurationVersionLabelSchema }).strict();

export type RenameConfigurationVersionRequest = z.infer<typeof RenameConfigurationVersionRequestSchema>;

/**
 * `PUT /api/v1/organizations/:organizationId/configurations/:configurationId/selected-version`:
 * records the version as the caller's selection. Strict.
 */
export const SelectConfigurationVersionRequestSchema = z.object({ versionId: VersionIdReferenceSchema }).strict();

export type SelectConfigurationVersionRequest = z.infer<typeof SelectConfigurationVersionRequestSchema>;

/**
 * `POST /api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/publish`:
 * an optional body. The editor sends `expectedUpdatedAt`, the version's
 * `updatedAt` as it last loaded or saved it, exactly as a summary reports it
 * (ISO 8601 in UTC, with milliseconds); when the version has been saved since,
 * the publish is refused with 409 `configuration_version_changed` before the
 * opamp-server is asked, so a clean tab never publishes a save it didn't see.
 * A caller without a tab (the public API) sends no body, or `{}`, and
 * publishes what is saved. Strict: an unknown field is 400 `invalid_request`.
 */
export const PublishConfigurationVersionRequestSchema = z
  .object({ expectedUpdatedAt: z.string().datetime({ precision: 3 }).optional() })
  .strict();

export type PublishConfigurationVersionRequest = z.infer<typeof PublishConfigurationVersionRequestSchema>;

/**
 * A validation's text, exactly as the editor holds it, 1 to 262,144
 * characters (the save's limit, counted the same way). Empty text is never
 * checked (the editor sends nothing for it), so the API refuses it rather
 * than ask the validator, which refuses it too. A lone surrogate is
 * refused as a save refuses it. So is every C0 control character but tab,
 * line feed and carriage return, U+0000 among them: YAML can't hold one
 * (its printable set leaves them out), and each is six bytes once JSON
 * escapes it, so a text of them could pass the character limit and still
 * exceed the validator's 1 MiB body. The save's own schema
 * (`ConfigurationYamlSchema`) is a separate one and keeps its rules: a
 * version may store such text, it just isn't sent to be checked.
 */
const ValidationYamlSchema = z
  .string()
  .min(1)
  .max(CONFIGURATION_YAML_MAXIMUM_LENGTH)
  .refine(
    (text) => !hasYamlControlCharacter(text),
    "The YAML can't contain a control character other than tab, line feed and carriage return.",
  )
  .refine((text) => !LONE_SURROGATE.test(text), "The YAML can't contain a lone surrogate.");

/**
 * Whether `text` holds a C0 control character other than tab, line feed and
 * carriage return (all of U+0000–U+001F but U+0009, U+000A and U+000D),
 * which a validation refuses. The editor checks first, so it never sends
 * such text.
 */
export function hasYamlControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/**
 * `POST /api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/validation`:
 * checks `yaml` with the collector the version is pinned to.
 * `collectorVersion` is the tab's unsaved pick, left out to use the version's
 * saved pin; it must be a version of the configuration's distribution in the
 * catalogue, else 400 `collector_version_unknown`. There is no distribution:
 * it is always the configuration's. Strict: an unknown field (a
 * `distribution` among them) is 400 `invalid_request`. Nothing is stored.
 */
export const ValidateConfigurationVersionRequestSchema = z
  .object({
    yaml: ValidationYamlSchema,
    collectorVersion: CollectorVersionNumberSchema.optional(),
  })
  .strict();

export type ValidateConfigurationVersionRequest = z.infer<typeof ValidateConfigurationVersionRequestSchema>;

/**
 * A validation's outcome: the collector accepted the text, refused it, or
 * wasn't asked because the version is retired (deprecated in the catalogue;
 * the validator holds only offered ones).
 */
export const CONFIGURATION_VALIDATION_STATUSES = ["valid", "invalid", "retired"] as const;

export type ConfigurationValidationStatus = (typeof CONFIGURATION_VALIDATION_STATUSES)[number];

/**
 * The nine deployment-requirement categories, as the validator's
 * `openapi.yaml` names them.
 */
export const CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES = [
  "env_var",
  "k8s_in_cluster",
  "k8s_downward_api",
  "host_filesystem",
  "directory",
  "tls_files",
  "missing_path",
  "organization_variable",
  "confmap_provider",
] as const;

export type ConfigurationValidationRequirementCategory =
  (typeof CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES)[number];

/**
 * One error the collector reported: its message (which can echo the
 * configuration's values, so it goes only into a response body) and where it
 * is, `::`-separated with the whole id kept
 * (`exporters::otlp_http/my-exp.v2`), or null when it names nothing.
 */
export const ConfigurationValidationErrorSchema = z
  .object({
    message: z.string(),
    componentPath: z.string().nullable(),
  })
  .strict();

export type ConfigurationValidationError = z.infer<typeof ConfigurationValidationErrorSchema>;

/** What a host must provide to run the configuration. Never an error. */
export const ConfigurationValidationRequirementSchema = z
  .object({
    category: z.enum(CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES),
    title: z.string(),
    description: z.string(),
    componentPath: z.string().nullable(),
  })
  .strict();

export type ConfigurationValidationRequirement = z.infer<typeof ConfigurationValidationRequirementSchema>;

/**
 * A validation's answer. `collectorVersion` is the version checked
 * against: the one the request named, else the saved pin. `valid` has no
 * errors, `invalid` at least one; `retired` has neither errors nor
 * requirements, the validator having not been asked.
 */
export const ConfigurationValidationResponseSchema = z
  .object({
    status: z.enum(CONFIGURATION_VALIDATION_STATUSES),
    collectorVersion: z.string(),
    errors: z.array(ConfigurationValidationErrorSchema),
    requirements: z.array(ConfigurationValidationRequirementSchema),
  })
  .strict();

export type ConfigurationValidationResponse = z.infer<typeof ConfigurationValidationResponseSchema>;

/**
 * The configuration endpoints' own error codes, named once so a misspelled
 * code is a type error. `configuration_version_not_found` is a version that
 * isn't one of the live configuration's, named in a version's path, as a
 * create's source or as a selection. `configuration_version_published`, a
 * change to a published version, or publishing one again (409);
 * `configuration_delete_forbidden`, a delete by a member who is neither the
 * configuration's author nor an admin (403); `publishing_unavailable`, the
 * opamp-server unreachable (503); `configuration_version_changed`, a version
 * saved while it was being published (409); `configuration_version_empty`,
 * publishing an empty version (409). `collector_version_unknown`, a save or a
 * create naming a collector version the configuration's distribution doesn't
 * offer (400); `collector_distribution_unknown`, a create naming a
 * distribution the catalogue doesn't offer (400). `validation_unavailable`,
 * the collector validator couldn't check the text (503);
 * `validation_rate_limited`, too many checks by the caller in the last minute,
 * or too many at once (429, with `Retry-After`). `configuration_in_use`, a
 * delete of a configuration whose published version a collector group or a
 * collector uses (409). Their other refusals are the organization's
 * (`organization_not_found`), the session's (`rate_limited`, a delete's fleet
 * limit), the terms', and the fleets' (`fleets_unavailable`, a delete whose
 * fleet usage couldn't be read).
 */
export const CONFIGURATION_ERROR_CODES = [
  "configuration_not_found",
  "configuration_version_not_found",
  "configuration_version_published",
  "configuration_delete_forbidden",
  "publishing_unavailable",
  "configuration_version_changed",
  "configuration_version_empty",
  "collector_version_unknown",
  "collector_distribution_unknown",
  "validation_unavailable",
  "validation_rate_limited",
  "configuration_in_use",
  "configuration_invalid",
] as const;

export type ConfigurationErrorCode = (typeof CONFIGURATION_ERROR_CODES)[number];

/**
 * `configuration_invalid` (422): a public route's YAML that doesn't validate
 * (a version's PATCH with `?validate=true`) or doesn't parse (OTTL lint),
 * with `details.errors: [{ message, componentPath }]`. Fixed words: never the
 * YAML.
 */
export const CONFIGURATION_INVALID_MESSAGE = "The configuration is not valid.";
