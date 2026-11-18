import { sql, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import { createOrganizationScope } from "../../tenancy/organization-scope.js";
import { visibleTo, type ConfigurationViewerContext } from "../configurations/repositories/configuration-repository.js";

/*
 * Default 21's warning (D20 Preflight ruling 27): the configurations whose
 * current draft holds a variable's reference. A configuration's current
 * draft is its highest-numbered version, when that version is unpublished
 * (`published_at` null), among the live configurations the viewer can see
 * (`visibleTo`: their own drafts and every published configuration; within
 * a visible configuration every version is visible, drafts included).
 *
 * The configuration repository's pattern: through the organization scope
 * (row-level security on both tables behind it), each version joined to its
 * configuration on the composite foreign key's two columns, a deleted
 * configuration skipped. The text is prefiltered here with `strpos` on the
 * reference's exact spelling, `${org:NAME}`; the caller confirms each with
 * the fill-in's scanner, since an escaped `$${org:NAME}` matches too.
 *
 * The name and the text are configuration text (Q88; ADR 0024): nothing
 * here logs them, and the name is a bound parameter, never in the SQL.
 */

/** A configuration whose current draft holds the reference's spelling: its id, its name, and the draft's text to confirm it in. */
export interface DraftCandidate {
  id: string;
  /** The user's text (ADR 0024): never logged. */
  name: string;
  /** Configuration text: never logged. */
  yaml: string;
}

export interface IVariableDraftsRepository {
  /**
   * The live configurations the viewer can see whose highest-numbered
   * version is unpublished and holds `reference` (the exact text, e.g.
   * `${org:OTLP_EP}`), by name then id.
   */
  candidates(reference: string): Promise<DraftCandidate[]>;
}

/** Bound to a transaction that carries the database context naming the same organization and viewer. */
export function createVariableDraftsRepository(
  transaction: Transaction<Database>,
  context: ConfigurationViewerContext,
): IVariableDraftsRepository {
  const scope = createOrganizationScope(transaction, context);

  return {
    async candidates(reference: string): Promise<DraftCandidate[]> {
      const rows = await scope
        .selectFrom("configuration_versions")
        .innerJoin("configurations", (join) =>
          join
            .onRef("configurations.id", "=", "configuration_versions.configuration_id")
            .onRef("configurations.organization_id", "=", "configuration_versions.organization_id"),
        )
        .select(["configurations.id", "configurations.name", "configuration_versions.yaml_content"])
        .where("configurations.deleted_at", "is", null)
        .where(visibleTo(context.userId))
        .where("configuration_versions.published_at", "is", null)
        // The highest-numbered version: no later one of its configuration's.
        .where(
          sql<boolean>`not exists (
            select 1 from configuration_versions later
            where later.organization_id = configuration_versions.organization_id
              and later.configuration_id = configuration_versions.configuration_id
              and later.version_number > configuration_versions.version_number
          )`,
        )
        .where(sql<boolean>`strpos(configuration_versions.yaml_content, ${reference}) > 0`)
        .orderBy("configurations.name")
        .orderBy("configurations.id")
        .execute();
      return rows.map((row) => ({ id: row.id, name: row.name, yaml: row.yaml_content }));
    },
  };
}
