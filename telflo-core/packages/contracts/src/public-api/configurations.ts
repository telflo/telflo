import { z } from "zod";
import { CollectorDistributionIdSchema, CollectorVersionNumberSchema } from "../collector-distributions.js";
import {
  CONFIGURATION_YAML_MAXIMUM_LENGTH,
  CONFIGURATIONS_PAGE_DEFAULT_LIMIT,
  CONFIGURATIONS_PAGE_MAXIMUM_LIMIT,
  ConfigurationDescriptionSchema,
  ConfigurationNameSchema,
  ConfigurationVersionLabelSchema,
  hasUnstorableCharacter,
} from "../configurations.js";

/*
 * The public surface's request and response shapes for configurations and
 * their versions (routes 4–12) (D25 decisions 17, 18, 19 and 31; Preflight
 * rulings 6 and 16): strict Zod schemas, camelCase, reusing the platform's contracts where they
 * already hold a field (the name, the description, the label, the YAML's
 * limit, the collector version's and the distribution's formats).
 *
 * A version's name is its `label` (1–80). The YAML is `yaml`.
 */

/**
 * A version's number in a path (Preflight ruling 16): a positive integer of
 * at most nine digits, written plainly: no sign, no leading zero, no
 * exponent (`07`, `1e2`, `0` and `-1` are 400 `invalid_request`).
 */
export const PublicVersionNumberSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/, "Expected a version number: a positive integer.")
  .transform(Number);

/**
 * A version's YAML in a request: the platform's limit (D8 decision 7), and
 * no character Postgres can't store exactly. Stored as given; nothing
 * validates it unless the version PATCH asks (`?validate=true`).
 */
const PublicConfigurationYamlSchema = z
  .string()
  .max(CONFIGURATION_YAML_MAXIMUM_LENGTH)
  .refine((text) => !hasUnstorableCharacter(text), "The YAML can't contain U+0000 or a lone surrogate.");

/**
 * A configuration as the list answers it (a summary): no YAML.
 * `versionNumber` is its latest version's number, `collectorVersion` that
 * version's pin, and `publishedVersionNumber` its HIGHEST published
 * version's number (the platform can publish several; Preflight ruling 6),
 * or null for a draft.
 */
export const PublicConfigurationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    organizationId: z.string().uuid(),
    isPublished: z.boolean(),
    distribution: z.string(),
    collectorVersion: z.string(),
    versionNumber: z.number().int().min(1),
    publishedVersionNumber: z.number().int().min(1).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PublicConfiguration = z.infer<typeof PublicConfigurationSchema>;

/** One configuration (its read, create, change and publish): the summary and its latest version's YAML. */
export const PublicConfigurationDetailSchema = PublicConfigurationSchema.extend({ yaml: z.string() }).strict();

export type PublicConfigurationDetail = z.infer<typeof PublicConfigurationDetailSchema>;

/** `GET /configurations`: a page, most recently updated first (decision 19); `nextCursor` null on the last. */
export const PublicConfigurationsPageSchema = z
  .object({
    items: z.array(PublicConfigurationSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type PublicConfigurationsPage = z.infer<typeof PublicConfigurationsPageSchema>;

/**
 * `GET /configurations`' query (decision 19): the browser list's cursor,
 * `limit` 1–100 (50 when left out) and `cursor` a previous page's
 * `nextCursor`. Strict: anything else is 400 `invalid_request`.
 */
export const PublicListConfigurationsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONFIGURATIONS_PAGE_MAXIMUM_LIMIT)
      .default(CONFIGURATIONS_PAGE_DEFAULT_LIMIT),
    cursor: z.string().max(256).optional(),
  })
  .strict();

export type PublicListConfigurationsQuery = z.input<typeof PublicListConfigurationsQuerySchema>;

/**
 * `POST /configurations` (decision 31): the configuration and its version 1
 * in one transaction, holding `yaml` as given. `distribution` is the one it
 * is built for, fixed for its life; left out, the catalogue's default. One
 * the catalogue doesn't offer is 400 `collector_distribution_unknown`.
 */
export const PublicCreateConfigurationRequestSchema = z
  .object({
    name: ConfigurationNameSchema,
    yaml: PublicConfigurationYamlSchema,
    distribution: CollectorDistributionIdSchema.optional(),
  })
  .strict();

export type PublicCreateConfigurationRequest = z.input<typeof PublicCreateConfigurationRequestSchema>;

/**
 * `PATCH /configurations/{configurationId}` (decision 31): the name, the
 * description, both or neither. The description's maximum is the
 * platform's 500; `null` clears it to `""`.
 */
export const PublicUpdateConfigurationRequestSchema = z
  .object({
    name: ConfigurationNameSchema.optional(),
    description: ConfigurationDescriptionSchema.nullable()
      .optional()
      .transform((description) => (description === null ? "" : description)),
  })
  .strict();

export type PublicUpdateConfigurationRequest = z.input<typeof PublicUpdateConfigurationRequestSchema>;

/** A version's status: published or not. */
export const PUBLIC_CONFIGURATION_VERSION_STATUSES = ["draft", "published"] as const;

export type PublicConfigurationVersionStatus = (typeof PUBLIC_CONFIGURATION_VERSION_STATUSES)[number];

/**
 * A version as the versions list answers it: no YAML. `label` is null for
 * an unnamed version; `publishedAt` null on a draft.
 */
export const PublicConfigurationVersionSummarySchema = z
  .object({
    id: z.string().uuid(),
    versionNumber: z.number().int().min(1),
    status: z.enum(PUBLIC_CONFIGURATION_VERSION_STATUSES),
    label: z.string().nullable(),
    distribution: z.string(),
    collectorVersion: z.string(),
    createdAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();

export type PublicConfigurationVersionSummary = z.infer<typeof PublicConfigurationVersionSummarySchema>;

/** One version (its read, append and PATCH): the summary, its configuration's id and its YAML. */
export const PublicConfigurationVersionSchema = PublicConfigurationVersionSummarySchema.extend({
  configurationId: z.string().uuid(),
  yaml: z.string(),
}).strict();

export type PublicConfigurationVersion = z.infer<typeof PublicConfigurationVersionSchema>;

/** `GET /configurations/{configurationId}/versions`: every version, highest first, never paginated (decision 19). */
export const PublicConfigurationVersionsSchema = z
  .object({
    items: z.array(PublicConfigurationVersionSummarySchema),
    nextCursor: z.null(),
  })
  .strict();

export type PublicConfigurationVersions = z.infer<typeof PublicConfigurationVersionsSchema>;

/**
 * `POST /configurations/{configurationId}/versions` (decision 31): the next
 * version, from the latest, holding `yaml` as given, with the latest's pin
 * and its suites and validation pipelines copied. `label` is the version's
 * name, 1–80 characters after trimming; left out or
 * null, the version is unnamed.
 */
export const PublicCreateConfigurationVersionRequestSchema = z
  .object({
    yaml: PublicConfigurationYamlSchema,
    label: ConfigurationVersionLabelSchema.nullable().optional(),
  })
  .strict();

export type PublicCreateConfigurationVersionRequest = z.input<typeof PublicCreateConfigurationVersionRequestSchema>;

/**
 * `PATCH /configurations/{configurationId}/versions/{versionNumber}`
 * (decision 31): merges `yaml` and `collectorVersion` over a draft; a field
 * left out keeps the one stored, and neither changes nothing. A change of
 * pin must name a version the configuration's distribution offers, else 400
 * `collector_version_unknown`.
 */
export const PublicUpdateConfigurationVersionRequestSchema = z
  .object({
    yaml: PublicConfigurationYamlSchema.optional(),
    collectorVersion: CollectorVersionNumberSchema.optional(),
  })
  .strict();

export type PublicUpdateConfigurationVersionRequest = z.input<typeof PublicUpdateConfigurationVersionRequestSchema>;

/**
 * The version PATCH's query: `validate=true` validates the merged text
 * first, and an invalid text is 422 `configuration_invalid` with nothing
 * saved; `false` or left out stores the text as given.
 */
export const PublicUpdateConfigurationVersionQuerySchema = z
  .object({
    validate: z
      .enum(["true", "false"])
      .optional()
      .transform((validate) => validate === "true"),
  })
  .strict();

export type PublicUpdateConfigurationVersionQuery = z.input<typeof PublicUpdateConfigurationVersionQuerySchema>;
