import type { Configuration, ConfigurationVersion, ConfigurationsListFilter } from "@telflo/contracts";
import type { ConfigurationReads, WorkspaceReads } from "~/lib/workspace-reads.js";
import { sampleConfiguration, sampleConfigurations } from "./sample/configurations.js";
import { SAMPLE_FLEET_READS } from "./sample/fleets.js";
import { SAMPLE_TESTING_READS } from "./sample/testing-tab.js";
import { SAMPLE_VISITOR_USER_ID, sampleNotFound } from "./sample/types.js";

/*
 * The sample workspace's answers to every read in `WorkspaceReads` (D31-1
 * decision 23, Preflight ruling 8), in the API's shapes, rebuilt on every
 * call with times relative to now. `readsFor(SAMPLE_ORGANIZATION_ID)` loads
 * this module lazily, so the signed-in bundles never hold the sample. It
 * calls no API function: it imports the client only for `ApiError`
 * (through `sampleNotFound`), so an id the sample doesn't hold answers the
 * API's own "not found" and every page shows its own (decision 25).
 *
 * The configurations' reads are here; the Testing tab's and fleet
 * management's are their sample modules' (`sample/testing-tab.ts`, Task 2;
 * `sample/fleets.ts`, Task 3).
 */

/** The configurations list's search and filter, as the API applies them, in the browser (decision 32). */
export function listedConfigurations(
  configurations: readonly Configuration[],
  { q, filter }: { q?: string; filter?: ConfigurationsListFilter },
): Configuration[] {
  const query = (q ?? "").trim().toLowerCase();
  return configurations.filter((configuration) => {
    if (filter === "mine" && configuration.createdBy?.userId !== SAMPLE_VISITOR_USER_ID) return false;
    if (filter === "published" && !configuration.published) return false;
    if (query === "") return true;
    return `${configuration.name} ${configuration.description}`.toLowerCase().includes(query);
  });
}

const configurationNotFound = () => sampleNotFound("configuration_not_found", "Configuration not found");
const versionNotFound = () => sampleNotFound("configuration_version_not_found", "Version not found");

const CONFIGURATION_READS: ConfigurationReads = {
  getConfigurations: async (_organizationId, query = {}) => {
    // Newest update first, as the API orders the list; one page holds the ten.
    const all = sampleConfigurations()
      .map((sample) => sample.configuration)
      .sort((one, other) => other.updatedAt.localeCompare(one.updatedAt));
    return { items: listedConfigurations(all, query), nextCursor: null };
  },
  getConfiguration: async (_organizationId, configurationId) => {
    const sample = sampleConfiguration(configurationId);
    if (sample === undefined) throw configurationNotFound();
    return sample;
  },
  getConfigurationVersion: async (_organizationId, configurationId, versionId) => {
    const sample = sampleConfiguration(configurationId);
    if (sample === undefined) throw configurationNotFound();
    const summary = sample.versions.find((listed) => listed.id === versionId.toLowerCase());
    if (summary === undefined) throw versionNotFound();
    // Every version of a sample holds the same text: a published one is the draft's past.
    const version: ConfigurationVersion = { ...sample.version, ...summary };
    return { configuration: sample.configuration, version, versions: sample.versions };
  },
  getConfigurationVersions: async (_organizationId, configurationId, options = {}) => {
    const sample = sampleConfiguration(configurationId);
    if (sample === undefined) throw configurationNotFound();
    const listed = options.filter === "published" ? sample.versions.filter((version) => version.publishedAt !== null) : sample.versions;
    return {
      versions: listed.map(({ id, versionNumber, label, publishedAt }) => ({ id, versionNumber, label, publishedAt })),
    };
  },
};

/** Every read of `WorkspaceReads`, answered from the sample. */
export const SAMPLE_READS: WorkspaceReads = {
  ...CONFIGURATION_READS,
  ...SAMPLE_TESTING_READS,
  ...SAMPLE_FLEET_READS,
};
