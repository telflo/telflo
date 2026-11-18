import type { Transaction } from "kysely";
import type { Database } from "@telflo/db";
import { createOrganizationScope, type OrganizationScopeContext } from "../../../tenancy/organization-scope.js";
import { visibleTo } from "./configuration-repository.js";

/*
 * Each person's selected version of each configuration of the context's
 * organization (D10 decision 3): the version they last opened, which
 * `/editor/{id}` opens again. Through the organization scope, with row-level
 * security on configuration_version_selections (migration 1700000000018)
 * behind it: the transaction must carry a database context naming the same
 * organization, or the policies show and admit nothing.
 *
 * The policies limit a selection to its organization, not to its person:
 * every method here filters by the person's id, and no endpoint reads
 * another person's. A selection is reachable only through a live
 * configuration, as its versions are: a deleted configuration's selections
 * stay in the table, unread, until its row goes and takes them. And only a
 * configuration the person can see counts (D11b decision 1): theirs, or
 * published, the configuration repository's rule (`visibleTo`), which the
 * policies apply too (migration 1700000000021). The person is the viewer:
 * every caller passes the request's user.
 *
 * The time comes from the caller, as `at`, never from SQL `now()`.
 */

export interface IConfigurationVersionSelectionRepository {
  /**
   * The id of the version this person last selected of the live
   * configuration; undefined when they have none, or the configuration is
   * deleted or isn't the context's organization's. The composite foreign key
   * makes it a version of that configuration.
   */
  find(userId: string, configurationId: string): Promise<string | undefined>;
  /**
   * Records the version as this person's selection of the configuration,
   * replacing any earlier one, selected `at`. First a read, through the scope,
   * of that version of the live configuration: when there is none (an
   * unknown version, another configuration's, a deleted configuration's, or
   * another organization's), it writes nothing and returns false (D10
   * Preflight ruling 1). Then an upsert on the person's row, which sets only
   * the version and the time. The caller holds the configuration's lock.
   */
  record(userId: string, configurationId: string, versionId: string, at: Date): Promise<boolean>;
}

/** Bound to a transaction that carries the database context and to the context whose organization it acts on. */
export function createConfigurationVersionSelectionRepository(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): IConfigurationVersionSelectionRepository {
  const scope = createOrganizationScope(transaction, context);

  return {
    async find(userId: string, configurationId: string): Promise<string | undefined> {
      // Joined on both columns of the composite foreign key, so the
      // configuration is the selection's own, and only a live one counts.
      const row = await scope
        .selectFrom("configuration_version_selections")
        .innerJoin("configurations", (join) =>
          join
            .onRef("configurations.id", "=", "configuration_version_selections.configuration_id")
            .onRef("configurations.organization_id", "=", "configuration_version_selections.organization_id"),
        )
        .select("configuration_version_selections.version_id")
        .where("configuration_version_selections.user_id", "=", userId)
        .where("configuration_version_selections.configuration_id", "=", configurationId)
        .where("configurations.deleted_at", "is", null)
        .where(visibleTo(userId))
        .executeTakeFirst();
      return row?.version_id;
    },

    async record(userId: string, configurationId: string, versionId: string, at: Date): Promise<boolean> {
      // Read first: in another organization's context the scope would name
      // this organization on the insert, and a version of another
      // organization's configuration would fail its foreign key (23503)
      // rather than be refused quietly.
      const version = await scope
        .selectFrom("configuration_versions")
        .innerJoin("configurations", (join) =>
          join
            .onRef("configurations.id", "=", "configuration_versions.configuration_id")
            .onRef("configurations.organization_id", "=", "configuration_versions.organization_id"),
        )
        .select("configuration_versions.id")
        .where("configuration_versions.id", "=", versionId)
        .where("configuration_versions.configuration_id", "=", configurationId)
        .where("configurations.deleted_at", "is", null)
        .where(visibleTo(userId))
        .executeTakeFirst();
      if (version === undefined) return false;

      // The conflict target is the person's row in this organization: the
      // update names only the version and the time, so it can't move the row
      // to another person, configuration or organization.
      await scope
        .insertInto("configuration_version_selections", {
          configuration_id: configurationId,
          version_id: versionId,
          user_id: userId,
          selected_at: at,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["organization_id", "user_id", "configuration_id"])
            .doUpdateSet({ version_id: versionId, selected_at: at }),
        )
        .execute();
      return true;
    },
  };
}
