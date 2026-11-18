import { z } from "zod";

/*
 * The collector catalogue (D13a decisions 1 to 3, 8 and 11): the
 * distributions a configuration can be built for and the collector versions
 * a version can be pinned to. The catalogue's file is the source
 * (catalog/distributions/<distribution>.json); the migration step syncs it
 * into two global tables, which the API reads.
 */

/**
 * A distribution's id as a request names it (`otelcol-contrib`): lowercase
 * words joined by hyphens, at most 64 characters, the catalogue's and the
 * opamp-server's format (D13a Preflight rulings 5 and 8 (d)). Anything else
 * is no distribution of the catalogue, so the contract refuses it (400
 * `invalid_request`); one in this format the catalogue doesn't offer is the
 * service's `collector_distribution_unknown`.
 */
export const CollectorDistributionIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Expected a distribution id: lowercase words joined by hyphens.");

/**
 * A collector version as a request names it (`0.162.0`): `major.minor.patch`,
 * at most 64 characters, the catalogue's and the opamp-server's format
 * (`[0-9]`, not `\d`: Preflight ruling 5). Anything else is refused here (400
 * `invalid_request`); one in this format the distribution doesn't offer is
 * the service's `collector_version_unknown`.
 */
export const CollectorVersionNumberSchema = z
  .string()
  .max(64)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, "Expected a collector version: major.minor.patch.");

/** The sections of a configuration a distribution may support components of (D13a decision 6). */
export const COLLECTOR_COMPONENT_SECTIONS = ["receivers", "processors", "exporters", "connectors", "extensions"] as const;

export type CollectorComponentSection = (typeof COLLECTOR_COMPONENT_SECTIONS)[number];

/**
 * The components a distribution's version supports, by section (D13a
 * decision 6): exactly the five sections, each a list of component names.
 * Null in a version means the full palette (Contrib).
 */
export const CollectorSupportedComponentsSchema = z
  .object({
    receivers: z.array(z.string()),
    processors: z.array(z.string()),
    exporters: z.array(z.string()),
    connectors: z.array(z.string()),
    extensions: z.array(z.string()),
  })
  .strict();

export type CollectorSupportedComponents = z.infer<typeof CollectorSupportedComponentsSchema>;

/**
 * A version a distribution offers (D13a decisions 8 and 11): never a
 * deprecated one, which pickers hide. `label` is what a picker shows
 * (`v0.162.0`), `description` a note beside it or null, `releasedAt` the
 * upstream release's day (`YYYY-MM-DD`), `isDefault` the version a new
 * configuration of the distribution starts at.
 */
export const CollectorVersionOfferSchema = z
  .object({
    version: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    releasedAt: z.string().date(),
    isDefault: z.boolean(),
    supportedComponents: CollectorSupportedComponentsSchema.nullable(),
  })
  .strict();

export type CollectorVersionOffer = z.infer<typeof CollectorVersionOfferSchema>;

/**
 * The kinds of component a configuration's sections hold, singular, as a
 * renamed type names its kind (D13b Preflight ruling 16): the web's
 * `ComponentType`.
 */
export const COLLECTOR_COMPONENT_KINDS = ["receiver", "processor", "exporter", "connector", "extension"] as const;

export type CollectorComponentKind = (typeof COLLECTOR_COMPONENT_KINDS)[number];

/** A component type's name as the collector spells it (`file_log`): the catalogue's rule. */
const ComponentTypeNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "Expected a component type: a lowercase letter, then lowercase letters, digits or _.");

/**
 * One of the collector's renames (D13b decision 6, Preflight rulings 5, 15
 * and 16): from upstream's version `since` on, the `kind` of component
 * `deprecatedName` is called `name`, the old name kept as a deprecated
 * alias. Kind-specific: another kind spelled `name` is a type the
 * collector doesn't have. `since` is an upstream version, which the
 * distribution needn't offer.
 */
export const CollectorRenamedTypeSchema = z
  .object({
    kind: z.enum(COLLECTOR_COMPONENT_KINDS),
    name: ComponentTypeNameSchema,
    deprecatedName: ComponentTypeNameSchema,
    since: CollectorVersionNumberSchema,
  })
  .strict();

export type CollectorRenamedType = z.infer<typeof CollectorRenamedTypeSchema>;

/** A distribution's renames, in its catalogue file's order. */
export const CollectorRenamedTypesSchema = z.array(CollectorRenamedTypeSchema);

/**
 * A distribution of the catalogue (D13a decision 1): its id, the name and
 * sentence pickers show, which icon the web shows (`otel`, or null for
 * none), whether it is the one a new configuration gets when it names none,
 * the versions it offers, newest first, and the collector's renames
 * (D13b decision 6; the web reads its own copy from the catalogue at build
 * time, Preflight ruling 15).
 */
export const CollectorDistributionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    isDefault: z.boolean(),
    versions: z.array(CollectorVersionOfferSchema),
    renamedTypes: CollectorRenamedTypesSchema,
  })
  .strict();

export type CollectorDistribution = z.infer<typeof CollectorDistributionSchema>;

/**
 * `GET /api/v1/collector-distributions` (D13a decision 11, Ruling 26): every
 * distribution, in the catalogue's order, each with its non-deprecated
 * versions, newest first by version (each part compared as a number).
 */
export const CollectorDistributionsResponseSchema = z
  .object({ distributions: z.array(CollectorDistributionSchema) })
  .strict();

export type CollectorDistributionsResponse = z.infer<typeof CollectorDistributionsResponseSchema>;
