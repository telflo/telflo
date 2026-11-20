import { z } from "zod";
import { CollectorDistributionIdSchema, CollectorVersionNumberSchema } from "./collector-distributions.js";
import { CONFIGURATION_YAML_MAXIMUM_LENGTH, hasUnstorableCharacter } from "./configurations.js";
import { FlowSlugSchema } from "./flow-slug.js";

export { FLOW_SLUG_MAXIMUM_LENGTH, FLOW_SLUG_PATTERN, FlowSlugSchema } from "./flow-slug.js";

/*
 * The flows endpoints: prebuilt collector configurations, each solving one
 * problem, in camelCase. Anyone reads the published flows' cards
 * (`GET /api/v1/flow-showcase`); a signed-in user lists and reads them in full
 * (`GET /api/v1/flows`, `GET /api/v1/flows/:slug`), the hidden ones too when a
 * product admin; only a product admin creates, changes and deletes them
 * (`POST /api/v1/flows`, `PATCH` and `DELETE /api/v1/flows/:id`) and runs the
 * security lint over a configuration (`POST /api/v1/flows/lint`).
 *
 * The request's limits: the name's 120 and the author's 80, the summary's
 * 300, the slug's 80, the source link's http(s) scheme (the table's
 * ck_flows_source_url_scheme). The YAML has the configuration's limit.
 * Text Postgres can't store exactly is refused, as the configurations' is
 * (`hasUnstorableCharacter`).
 */

/** The signals a flow handles, derived from its pipelines by the admin dialog. */
export const FLOW_SIGNALS = ["traces", "metrics", "logs"] as const;

export type FlowSignal = (typeof FLOW_SIGNALS)[number];

/**
 * Who authored a flow: `telflo`, which every
 * create writes, or `community`, reserved for user-submitted flows, which
 * aren't built.
 */
export const FLOW_SOURCES = ["telflo", "community"] as const;

export type FlowSource = (typeof FLOW_SOURCES)[number];

/** The admin dialog's limits, after trimming. */
export const FLOW_NAME_MAXIMUM_LENGTH = 120;
export const FLOW_SUMMARY_MAXIMUM_LENGTH = 300;
export const FLOW_AUTHOR_NAME_MAXIMUM_LENGTH = 80;

/** The YAML's limit: a configuration version's. */
export const FLOW_YAML_MAXIMUM_LENGTH = CONFIGURATION_YAML_MAXIMUM_LENGTH;

/**
 * The description is bounded at the YAML's, which no flow's comes near (the seeded ones' are at
 * most 1,337 characters), so a write's body has a ceiling the route can set.
 */
export const FLOW_DESCRIPTION_MAXIMUM_LENGTH = CONFIGURATION_YAML_MAXIMUM_LENGTH;

/**
 * These bound a write's body; the seeded flows have at most 7 tags of at most 11 characters.
 */
export const FLOW_MAXIMUM_TAGS = 32;
export const FLOW_TAG_MAXIMUM_LENGTH = 64;

/** 2,048 characters is longer than any browser keeps in its address bar. */
export const FLOW_SOURCE_URL_MAXIMUM_LENGTH = 2_048;

/**
 * The source link's scheme, exactly as the table's ck_flows_source_url_scheme
 * checks it (case-sensitive): it is rendered into an href on a public page,
 * so a `javascript:` or `data:` link would be stored XSS.
 */
export const FLOW_SOURCE_URL_PATTERN = /^https?:\/\//;

/** The `int4` range of `sort_order`. */
const SORT_ORDER_MINIMUM = -2_147_483_648;
const SORT_ORDER_MAXIMUM = 2_147_483_647;

/** Text Postgres stores exactly: no U+0000, no lone surrogate. */
const storable = (text: string) => !hasUnstorableCharacter(text);

/** Trimmed, 1 to 120 characters. */
export const FlowNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(FLOW_NAME_MAXIMUM_LENGTH)
  .refine(storable, "The name can't contain U+0000 or a lone surrogate.");

/** Trimmed, 1 to 300 characters: the card's one line. */
export const FlowSummarySchema = z
  .string()
  .trim()
  .min(1, "Summary is required.")
  .max(FLOW_SUMMARY_MAXIMUM_LENGTH)
  .refine(storable, "The summary can't contain U+0000 or a lone surrogate.");

/** Trimmed; `''` allowed (the admin dialog sends the summary in its place). */
export const FlowDescriptionSchema = z
  .string()
  .trim()
  .max(FLOW_DESCRIPTION_MAXIMUM_LENGTH)
  .refine(storable, "The description can't contain U+0000 or a lone surrogate.");

/**
 * The signals, each at most once. The admin dialog derives them from the
 * YAML's pipelines and sends them; the API stores the list it is given.
 */
export const FlowSignalsSchema = z
  .array(z.enum(FLOW_SIGNALS))
  .max(FLOW_SIGNALS.length)
  .refine((signals) => new Set(signals).size === signals.length, "Each signal may be named once.");

/** Each tag trimmed and not empty (the dialog drops empty ones). */
export const FlowTagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "A tag can't be empty.")
      .max(FLOW_TAG_MAXIMUM_LENGTH)
      .refine(storable, "A tag can't contain U+0000 or a lone surrogate."),
  )
  .max(FLOW_MAXIMUM_TAGS);

/**
 * The collector configuration, exactly as sent (not trimmed), at most
 * 262,144 characters, not blank.
 */
export const FlowYamlSchema = z
  .string()
  .max(FLOW_YAML_MAXIMUM_LENGTH)
  .refine((text) => text.trim() !== "", "YAML is required.")
  .refine(storable, "The YAML can't contain U+0000 or a lone surrogate.");

/** Trimmed; `''` and `null` are none (the dialog's `authorName.trim() || null`), which reads "Built by Telflo". */
export const FlowAuthorNameSchema = z
  .string()
  .trim()
  .max(FLOW_AUTHOR_NAME_MAXIMUM_LENGTH)
  .refine(storable, "The author can't contain U+0000 or a lone surrogate.")
  .transform((name) => (name === "" ? null : name))
  .nullable();

/** Trimmed; `''` and `null` are none (the dialog's `trimmedUrl || null`). Else an http(s) link. */
export const FlowSourceUrlSchema = z
  .string()
  .trim()
  .max(FLOW_SOURCE_URL_MAXIMUM_LENGTH)
  .refine((url) => url === "" || FLOW_SOURCE_URL_PATTERN.test(url), "Source URL must start with http:// or https://")
  .refine(storable, "The source URL can't contain U+0000 or a lone surrogate.")
  .transform((url) => (url === "" ? null : url))
  .nullable();

/** The gallery's order, ascending, the name breaking ties: any `int4`. */
export const FlowSortOrderSchema = z.number().int().min(SORT_ORDER_MINIMUM).max(SORT_ORDER_MAXIMUM);

/** The admin dialog's fields, each with its schema. */
const flowInputFields = {
  slug: FlowSlugSchema,
  name: FlowNameSchema,
  summary: FlowSummarySchema,
  description: FlowDescriptionSchema,
  signals: FlowSignalsSchema,
  tags: FlowTagsSchema,
  yaml: FlowYamlSchema,
  /** One the catalogue doesn't have is 400 `collector_distribution_unknown`. */
  collectorDistribution: CollectorDistributionIdSchema,
  /** One the distribution doesn't offer (unknown or deprecated) is 400 `collector_version_unknown`. */
  collectorVersion: CollectorVersionNumberSchema,
  sourceUrl: FlowSourceUrlSchema,
  authorName: FlowAuthorNameSchema,
  sortOrder: FlowSortOrderSchema,
};

/**
 * `POST /api/v1/flows`, product admins only: the admin dialog's fields,
 * every one required but `published`, which is true left out. The source
 * is always `telflo`, so the body can't name one; nor an author link,
 * which the dialog never sets. Strict: an unknown field is 400
 * `invalid_request`. A slug another flow has is 409 `flow_slug_taken`.
 */
export const CreateFlowRequestSchema = z
  .object({ ...flowInputFields, published: z.boolean().default(true) })
  .strict();

/** What a client sends: `published` may be left out. */
export type CreateFlowRequest = z.input<typeof CreateFlowRequestSchema>;

/**
 * `PATCH /api/v1/flows/:id`, product admins only: any of the dialog's
 * fields and `published` (the visibility switch); a field left out stays as
 * it is. A pin left as it is stays even if deprecated since; a changed one
 * must be offered.
 */
export const UpdateFlowRequestSchema = z
  .object({
    slug: flowInputFields.slug.optional(),
    name: flowInputFields.name.optional(),
    summary: flowInputFields.summary.optional(),
    description: flowInputFields.description.optional(),
    signals: flowInputFields.signals.optional(),
    tags: flowInputFields.tags.optional(),
    yaml: flowInputFields.yaml.optional(),
    collectorDistribution: flowInputFields.collectorDistribution.optional(),
    collectorVersion: flowInputFields.collectorVersion.optional(),
    sourceUrl: flowInputFields.sourceUrl.optional(),
    authorName: flowInputFields.authorName.optional(),
    sortOrder: flowInputFields.sortOrder.optional(),
    published: z.boolean().optional(),
  })
  .strict();

export type UpdateFlowRequest = z.input<typeof UpdateFlowRequestSchema>;

/**
 * A flow in full, camelCase: what a signed-in read and every write
 * answer. `yaml` is the configuration "Use this flow" and "Start from a
 * flow" copy byte for byte. `published` false hides it from everyone but
 * product admins. The timestamps are ISO 8601, from the API's clock.
 */
export const FlowSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    description: z.string(),
    source: z.enum(FLOW_SOURCES),
    authorName: z.string().nullable(),
    authorUrl: z.string().nullable(),
    signals: z.array(z.enum(FLOW_SIGNALS)),
    tags: z.array(z.string()),
    yaml: z.string(),
    collectorDistribution: z.string(),
    collectorVersion: z.string(),
    sourceUrl: z.string().nullable(),
    published: z.boolean(),
    sortOrder: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Flow = z.infer<typeof FlowSchema>;

/**
 * A published flow's card: `GET /api/v1/flow-showcase`'s, read signed out
 * where public flows are on. Never the YAML.
 */
export const FlowCardSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    signals: z.array(z.enum(FLOW_SIGNALS)),
    tags: z.array(z.string()),
    authorName: z.string().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type FlowCard = z.infer<typeof FlowCardSchema>;

/** `GET /api/v1/flow-showcase`: every published flow's card, in the gallery's order (`sort_order`, then the name). */
export const FlowShowcaseResponseSchema = z.object({ flows: z.array(FlowCardSchema) }).strict();

export type FlowShowcaseResponse = z.infer<typeof FlowShowcaseResponseSchema>;

/**
 * `GET /api/v1/flows`: every flow the caller may see, in full, in the
 * gallery's order: the published ones, and the hidden ones too for a product
 * admin. The YAML is in the list, so the gallery, the create dialog's picker
 * and the admin table instantiate or edit a flow without a second read.
 */
export const FlowsResponseSchema = z.object({ flows: z.array(FlowSchema) }).strict();

export type FlowsResponse = z.infer<typeof FlowsResponseSchema>;

/** The answer of reading one flow, creating one and changing one. */
export const FlowResponseSchema = z.object({ flow: FlowSchema }).strict();

export type FlowResponse = z.infer<typeof FlowResponseSchema>;

/**
 * A published flow as the open flow read answers it: `FlowSchema` without
 * what only the signed-in reads and the admin's table need (`id`,
 * `published`, `sortOrder`, `createdAt`). The YAML is in it, as in the
 * signed-in reads: the playground's gallery and a flow's page show it.
 * Strict: nothing else is answered.
 */
export const PublishedFlowSchema = FlowSchema.omit({ id: true, published: true, sortOrder: true, createdAt: true }).strict();

export type PublishedFlow = z.infer<typeof PublishedFlowSchema>;

/**
 * `GET /api/v1/published-flows`: every published flow, in the gallery's order
 * (`sort_order`, then the name), with no session. A hidden flow is never in
 * it, whoever asks.
 */
export const PublishedFlowsResponseSchema = z.object({ flows: z.array(PublishedFlowSchema) }).strict();

export type PublishedFlowsResponse = z.infer<typeof PublishedFlowsResponseSchema>;

/** `GET /api/v1/published-flows/:slug`: one published flow; 404 `flow_not_found` for a hidden or unknown slug. */
export const PublishedFlowResponseSchema = z.object({ flow: PublishedFlowSchema }).strict();

export type PublishedFlowResponse = z.infer<typeof PublishedFlowResponseSchema>;

/**
 * `POST /api/v1/flows/lint`, product admins only: the security lint over a
 * configuration, advisory. The YAML has a flow's limit and is otherwise any
 * text, blank included: an empty one is the lint's `empty-config`, not a
 * refusal. Strict: `yaml` is required and nothing else is accepted. Nothing
 * is stored, so text Postgres can't store is linted too.
 */
export const FlowLintRequestSchema = z.object({ yaml: z.string().max(FLOW_YAML_MAXIMUM_LENGTH) }).strict();

export type FlowLintRequest = z.infer<typeof FlowLintRequestSchema>;

/** A finding's verdict: `block` means the flow shouldn't be published as it is; `warn`, that an importer should know. */
export const FLOW_LINT_SEVERITIES = ["block", "warn"] as const;

export type FlowLintSeverity = (typeof FLOW_LINT_SEVERITIES)[number];

/**
 * The 14 codes: the 11 rules, then the 3 for input the lint can't read
 * (`empty-config`, `invalid-yaml`, `invalid-config`).
 */
export const FLOW_LINT_CODES = [
  "provider-not-allowed",
  "org-scoped-reference",
  "placeholder-credential",
  "hardcoded-credential",
  "literal-endpoint-default",
  "literal-endpoint",
  "local-endpoint",
  "sensitive-path",
  "privileged-component",
  "tls-verification-disabled",
  "no-memory-limiter",
  "empty-config",
  "invalid-yaml",
  "invalid-config",
] as const;

export type FlowLintCode = (typeof FLOW_LINT_CODES)[number];

/**
 * One finding: `message` and `path` quote the configuration's keys and values
 * (and, for `invalid-yaml`, the parser's message), so both are configuration
 * text. `path` is where in the configuration (`exporters.otlp.endpoint`,
 * `config` for the whole text).
 */
export const FlowLintFindingSchema = z
  .object({
    severity: z.enum(FLOW_LINT_SEVERITIES),
    code: z.enum(FLOW_LINT_CODES),
    message: z.string(),
    path: z.string(),
  })
  .strict();

export type FlowLintFinding = z.infer<typeof FlowLintFindingSchema>;

/**
 * The lint's answer: `blocked` when any finding is `block`; the findings in
 * rules' order; `destinations`, every place the configuration sends
 * data (`exporters.otlp.endpoint → https://…`, or an extension that
 * forwards traffic), configuration text too.
 */
export const FlowLintResponseSchema = z
  .object({
    blocked: z.boolean(),
    findings: z.array(FlowLintFindingSchema),
    destinations: z.array(z.string()),
  })
  .strict();

export type FlowLintResponse = z.infer<typeof FlowLintResponseSchema>;

/**
 * The flows endpoints' own refusals: `flow_not_found` (404), a slug or id no
 * flow has, a hidden flow read by anyone but a product admin, and an id that
 * isn't a UUID; `flow_slug_taken` (409), a create or a rename to a slug
 * another flow has. Their other refusals are shared: `product_admin_required`
 * (403, IDENTITY_ERROR_CODES) for a write by anyone but a product admin;
 * `collector_distribution_unknown` and `collector_version_unknown` (400,
 * CONFIGURATION_ERROR_CODES) for a pin the catalogue doesn't offer; the
 * session's.
 */
export const FLOW_ERROR_CODES = ["flow_not_found", "flow_slug_taken"] as const;

export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number];
