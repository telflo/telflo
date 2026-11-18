import { sql, type Transaction } from "kysely";
import type { PublishedVersion } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";
import { isPublished, visibleTo, type ConfigurationViewerContext } from "./configuration-repository.js";

/*
 * A configuration version and its published copy in the opamp-server, both
 * ways (D16b decision 14, Preflight ruling 5): the fleet routes take a
 * configuration version from the browser and send the opamp-server its
 * `publication_id`, and answer each publication id the opamp-server names
 * with the platform's configuration and version beside it.
 *
 * The configuration repository's pattern: through the organization scope
 * (row-level security on both tables behind it), each version joined to its
 * configuration on the composite foreign key's two columns, a deleted
 * configuration skipped, and only what the viewer can see (`visibleTo`: their
 * own drafts and every published configuration). With no viewer (D17c-2's
 * public download, Preflight ruling 9: `userId` null, the database context's
 * user empty), only what needs none: a published configuration's versions
 * (`isPublished`; `visibleTo('')` would raise 22P02). Another organization's
 * version, another member's draft and a deleted configuration's version are
 * as absent as an unknown one.
 *
 * A configuration's name and a version's label are the user's text (ADR
 * 0024): nothing here logs them.
 */

/** A version as the fleet routes resolve it: its published copy's id, or null for a draft. */
export interface ResolvedVersion {
  publicationId: string | null;
}

/** A published version as an install reads it (D17c-1 decisions 33 and 38): its YAML and the collector it is built for. */
export interface InstallableVersion {
  /** Configuration text (ADR 0024): never logged. */
  yaml: string;
  collectorDistribution: string;
  collectorVersion: string;
}

export interface IPublishedVersionRepository {
  /**
   * The version of a live configuration the viewer can see, with its
   * publication id (null while it is a draft); undefined when there is none.
   * The version's primary key.
   */
  resolve(versionId: string): Promise<ResolvedVersion | undefined>;
  /**
   * The configuration and version each of `publicationIds` records (with
   * the collector the version is built for, D17c-1 decision 33), keyed by
   * the publication id in lower case; an id no live version of the
   * organization's records (an orphan, a deleted configuration's, another
   * organization's) has no entry. One query (on
   * `configuration_versions.publication_id`, `= any($1)`, served by
   * uq_configuration_versions_publication_id); none for no ids.
   */
  describe(publicationIds: readonly string[]): Promise<Map<string, PublishedVersion>>;
  /**
   * The YAML and the collector of the version `publicationId` records
   * (Preflight ruling 8), under the same filter: a live configuration's
   * version the viewer can see. Undefined for a deleted configuration's
   * version, an orphan, or another organization's.
   */
  findForInstall(publicationId: string): Promise<InstallableVersion | undefined>;
}

/** Whose reads: the organization, and the viewer, or null for none (the public download's). */
export type PublishedVersionReadContext = Pick<ConfigurationViewerContext, "organizationId"> & { userId: string | null };

/**
 * Bound to a transaction that carries the database context, and to the
 * organization and viewer it reads for; the database context must name the
 * same two (for no viewer, an empty user: database/context.ts' context of
 * an organization with no person, which only the public download opens).
 */
export function createPublishedVersionRepository(
  transaction: Transaction<Database>,
  context: PublishedVersionReadContext,
): IPublishedVersionRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /** The organization's versions of the live configurations the viewer can see, each joined to its own configuration. */
  const ofLiveConfigurations = () =>
    scope
      .selectFrom("configuration_versions")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "configuration_versions.configuration_id")
          .onRef("configurations.organization_id", "=", "configuration_versions.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      // No viewer (the public download): only what needs none, a published configuration's.
      .where(viewer === null ? isPublished("configurations") : visibleTo(viewer));

  return {
    async resolve(versionId: string): Promise<ResolvedVersion | undefined> {
      const row = await ofLiveConfigurations()
        .select("configuration_versions.publication_id")
        .where("configuration_versions.id", "=", versionId)
        .executeTakeFirst();
      return row ? { publicationId: row.publication_id } : undefined;
    },

    async describe(publicationIds: readonly string[]): Promise<Map<string, PublishedVersion>> {
      const ids = [...new Set(publicationIds.map((id) => id.toLowerCase()))];
      if (ids.length === 0) return new Map();
      const rows = await ofLiveConfigurations()
        .select([
          "configuration_versions.publication_id",
          "configuration_versions.id as version_id",
          "configuration_versions.version_number",
          "configuration_versions.label",
          "configuration_versions.collector_distribution",
          "configuration_versions.collector_version",
          "configurations.id as configuration_id",
          "configurations.name as configuration_name",
        ])
        .where(sql<boolean>`configuration_versions.publication_id = any(${ids}::uuid[])`)
        .execute();
      const described = new Map<string, PublishedVersion>();
      for (const row of rows) {
        if (row.publication_id === null) continue;
        described.set(row.publication_id.toLowerCase(), {
          configurationId: row.configuration_id,
          configurationName: row.configuration_name,
          versionId: row.version_id,
          versionNumber: row.version_number,
          versionLabel: row.label,
          collectorDistribution: row.collector_distribution,
          collectorVersion: row.collector_version,
        });
      }
      return described;
    },

    async findForInstall(publicationId: string): Promise<InstallableVersion | undefined> {
      const row = await ofLiveConfigurations()
        .select([
          "configuration_versions.yaml_content",
          "configuration_versions.collector_distribution",
          "configuration_versions.collector_version",
        ])
        .where("configuration_versions.publication_id", "=", publicationId.toLowerCase())
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { yaml: row.yaml_content, collectorDistribution: row.collector_distribution, collectorVersion: row.collector_version };
    },
  };
}
