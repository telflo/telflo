import { sql, type Kysely, type Transaction } from "kysely";
import type { CollectorRenamedType, CollectorSupportedComponents, Database } from "@telflo/db";

/*
 * The collector catalogue: the distributions a configuration can be built for
 * and their versions, which the migration step syncs from the catalogue's
 * JSON files. The API reads only the tables, never the files.
 *
 * A global repository (the resource registry's `kind: "global"`):
 * the catalogue belongs to no organization, so there is no organization
 * scope and no row-level security, and the API's role may only read it
 * (migration 1700000000023). It reads through the caller's transaction, so
 * a default read here and the rows written with it see the same catalogue.
 *
 * "Offered" is what a picker shows and a new pin may name: a version that isn't
 * deprecated. A deprecated one still resolves for a pin already on it (the
 * foreign key), but nothing here offers it.
 */

/** A collector pin: a distribution of the catalogue and one of its versions. */
export interface CollectorPin {
  distribution: string;
  version: string;
}

/**
 * Where a version stands in a distribution's catalogue: offered (a pin may
 * name it, and the validator holds it), deprecated (a pin may keep it, but
 * nothing checks it: retired), or not one of the distribution's at all.
 */
export type CollectorVersionState = "offered" | "deprecated" | "unknown";

/** A version a distribution offers, as the catalogue endpoint lists it. */
export interface OfferedCollectorVersion {
  version: string;
  label: string;
  description: string | null;
  /** The upstream release's day, `YYYY-MM-DD` (the pool reads a `date` as its text). */
  releasedAt: string;
  isDefault: boolean;
  /** Null for the full palette (Contrib). */
  supportedComponents: CollectorSupportedComponents | null;
}

/** A distribution with the versions it offers, newest first, and the collector's renames. */
export interface OfferedCollectorDistribution {
  id: string;
  label: string;
  description: string | null;
  icon: string | null;
  isDefault: boolean;
  versions: OfferedCollectorVersion[];
  /** The catalogue file's `renamedTypes`, in its order; `[]` when it has none. */
  renamedTypes: CollectorRenamedType[];
}

/** One platform's binary (`linux_amd64`, …): where upstream publishes it, and its sha256. */
export interface CollectorBinary {
  downloadUrl: string;
  sha256: string;
}

/** A version's binaries by platform: `{}` for a container-only distribution. */
export interface CollectorVersionBinaries {
  version: string;
  otelcolContrib: Partial<Record<string, CollectorBinary>>;
  opampSupervisor: Partial<Record<string, CollectorBinary>>;
}

export interface ICollectorCatalogueRepository {
  /**
   * The catalogue's default distribution and that distribution's default
   * version: what a new configuration and its version 1 get, the sign-up
   * starter included. One default, read from the tables: no constant
   * anywhere. The sync keeps exactly one of each, so a missing one is a
   * broken database, and throws.
   */
  findDefaults(): Promise<CollectorPin>;
  /**
   * The default version of `distribution`: what a configuration created for
   * it gets as its version 1. Undefined when the catalogue has no such
   * distribution, or it offers no default version (a default is never
   * deprecated: the table's check).
   */
  findDistributionDefault(distribution: string): Promise<CollectorPin | undefined>;
  /**
   * Whether `distribution` offers `version`: it is in the catalogue and not
   * deprecated, so a pin may change to it.
   */
  isOffered(distribution: string, version: string): Promise<boolean>;
  /**
   * Whether `distribution` offers `version`, deprecated it, or doesn't have
   * it: what a validation checks before it asks the validator. A version of
   * another distribution is `unknown` here.
   */
  findVersionState(distribution: string, version: string): Promise<CollectorVersionState>;
  /**
   * Every distribution, in the catalogue's order (`sort_order`, then the id),
   * each with the versions it offers, newest first: each part of
   * `major.minor.patch` compared as a number, so 0.100.0 comes before 0.99.0.
   * A distribution that offers none lists no versions. Each carries its
   * renames, as the sync stored them.
   */
  listOffered(): Promise<OfferedCollectorDistribution[]>;
  /**
   * A version's binaries: the bundle's downloads. Undefined when
   * `distribution` has no such version, deprecated or not.
   */
  findVersionBinaries(distribution: string, version: string): Promise<CollectorVersionBinaries | undefined>;
  /**
   * The binaries of every version `distribution` offers (not deprecated),
   * newest first (as listOffered orders them): own-binary's table of
   * supervisors, one per collector version.
   */
  listOfferedBinaries(distribution: string): Promise<CollectorVersionBinaries[]>;
}

export function createCollectorCatalogueRepository(
  db: Kysely<Database> | Transaction<Database>,
): ICollectorCatalogueRepository {
  return {
    async findDefaults(): Promise<CollectorPin> {
      const row = await db
        .selectFrom("collector_distributions")
        .innerJoin("collector_versions", (join) =>
          join
            .onRef("collector_versions.distribution", "=", "collector_distributions.id")
            .on("collector_versions.is_default", "=", true),
        )
        .select(["collector_distributions.id as distribution", "collector_versions.version"])
        .where("collector_distributions.is_default", "=", true)
        .executeTakeFirst();
      if (row === undefined) {
        throw new Error("The collector catalogue has no default distribution and version: run npm run db:migrate.");
      }
      return { distribution: row.distribution, version: row.version };
    },

    async findDistributionDefault(distribution: string): Promise<CollectorPin | undefined> {
      const row = await db
        .selectFrom("collector_versions")
        .select(["distribution", "version"])
        .where("distribution", "=", distribution)
        .where("is_default", "=", true)
        .where("deprecated", "=", false)
        .executeTakeFirst();
      return row === undefined ? undefined : { distribution: row.distribution, version: row.version };
    },

    async isOffered(distribution: string, version: string): Promise<boolean> {
      const row = await db
        .selectFrom("collector_versions")
        .select("version")
        .where("distribution", "=", distribution)
        .where("version", "=", version)
        .where("deprecated", "=", false)
        .executeTakeFirst();
      return row !== undefined;
    },

    async findVersionState(distribution: string, version: string): Promise<CollectorVersionState> {
      const row = await db
        .selectFrom("collector_versions")
        .select("deprecated")
        .where("distribution", "=", distribution)
        .where("version", "=", version)
        .executeTakeFirst();
      if (row === undefined) return "unknown";
      return row.deprecated ? "deprecated" : "offered";
    },

    async findVersionBinaries(distribution: string, version: string): Promise<CollectorVersionBinaries | undefined> {
      const row = await db
        .selectFrom("collector_versions")
        .select(["version", "otelcol_contrib", "opamp_supervisor"])
        .where("distribution", "=", distribution)
        .where("version", "=", version)
        .executeTakeFirst();
      return row === undefined ? undefined : { version: row.version, otelcolContrib: row.otelcol_contrib, opampSupervisor: row.opamp_supervisor };
    },

    async listOfferedBinaries(distribution: string): Promise<CollectorVersionBinaries[]> {
      const rows = await db
        .selectFrom("collector_versions")
        .select(["version", "otelcol_contrib", "opamp_supervisor"])
        .where("distribution", "=", distribution)
        .where("deprecated", "=", false)
        .orderBy(sql`string_to_array(version, '.')::numeric[]`, "desc")
        .execute();
      return rows.map((row) => ({ version: row.version, otelcolContrib: row.otelcol_contrib, opampSupervisor: row.opamp_supervisor }));
    },

    async listOffered(): Promise<OfferedCollectorDistribution[]> {
      const distributions = await db
        .selectFrom("collector_distributions")
        .select(["id", "label", "description", "icon", "is_default", "renamed_types"])
        .orderBy("sort_order", "asc")
        .orderBy("id", "asc")
        .execute();
      // A version is `major.minor.patch` (the table's check), so its parts
      // as numerics sort as numbers: numeric, not integer, so no part is too
      // long to compare.
      const versions = await db
        .selectFrom("collector_versions")
        .select([
          "distribution",
          "version",
          "label",
          "description",
          "released_at",
          "is_default",
          "supported_components",
        ])
        .where("deprecated", "=", false)
        .orderBy("distribution", "asc")
        .orderBy(sql`string_to_array(version, '.')::numeric[]`, "desc")
        .execute();
      return distributions.map((distribution) => ({
        id: distribution.id,
        label: distribution.label,
        description: distribution.description,
        icon: distribution.icon,
        isDefault: distribution.is_default,
        versions: versions
          .filter((version) => version.distribution === distribution.id)
          .map((version) => ({
            version: version.version,
            label: version.label,
            description: version.description,
            releasedAt: version.released_at,
            isDefault: version.is_default,
            supportedComponents: version.supported_components,
          })),
        renamedTypes: distribution.renamed_types,
      }));
    },
  };
}
