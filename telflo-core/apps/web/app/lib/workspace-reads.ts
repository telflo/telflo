import * as api from "~/lib/api-client.js";

/*
 * The one seam between the platform's screens and the playground's sample
 * workspace. Every reused reader asks `readsFor(organizationId)` for its
 * reads instead of importing them from the API client:
 * - for any organization but the sample's, the answer is the API client's
 *   module namespace itself, its functions looked up at each call, so a
 *   signed-in page reads exactly as before (and a test's
 *   `vi.spyOn(apiClient, …)` still sees every call);
 * - for the sample's organization, `SAMPLE_ORGANIZATION_ID`, an id the API
 *   never mints (it mints UUIDv7), the answer is the sample's reads
 *   (`lib/playground/sample-reads.ts`), imported lazily on the first call so
 *   the signed-in bundles never hold the sample.
 * A pure function of the id: safe on the server, and a poll re-reads the
 * sample, which is rebuilt with times relative to now on every call.
 *
 * The names below are every reader the playground's reused screens call: the
 * stores take the id from the editor store, which the playground loads with
 * the sample's id; the hooks take it from `useCurrentUser()`, which inside
 * the playground answers the sample's visitor first. A screen switching a
 * reader replaces `getX(orgId, …)` by `readsFor(orgId).getX(orgId, …)`; this
 * module never changes for it.
 */

/** The sample workspace's organization: a canonical lowercase UUID (v4-shaped) no real organization has. */
export const SAMPLE_ORGANIZATION_ID = "00000000-0000-4000-8000-00000000ac3e";

/** The configurations' reads: the playground's configurations page, and the editor's should one be reached. */
export const CONFIGURATION_READ_NAMES = [
  "getConfigurations",
  "getConfiguration",
  "getConfigurationVersion",
  "getConfigurationVersions",
] as const;

/**
 * The Testing tab's reads: the testing store's files, heads, templates,
 * runs and a run's detail; a run's input and output (`TestRunResults`,
 * open to be read); the suites store's; the validation pipelines store's
 * (and `TestRunResults`' pipelines read).
 */
export const TESTING_READ_NAMES = [
  "getTestFiles",
  "getTestFileHead",
  "getTestTemplates",
  "getTestRuns",
  "getTestRun",
  "getTestRunFile",
  "getTestSuites",
  "getTestDefinitions",
  "getValidationPipelines",
  "getValidationRules",
] as const;

/**
 * Fleet management's reads: `lib/fleets.ts`' list and a fleet,
 * `lib/collectors.ts`' collectors and groups, `lib/groups.ts`',
 * `lib/tokens.ts`' tokens, their events and install links, and
 * `CollectorDetailsDialog`'s collector, its errors and the tokens.
 */
export const FLEET_READ_NAMES = [
  "getFleets",
  "getFleet",
  "getCollectors",
  "getCollector",
  "getCollectorErrors",
  "getCollectorGroups",
  "getEnrollmentTokens",
  "getEnrollmentTokenEvents",
  "getQuickDeployLinks",
] as const;

export const WORKSPACE_READ_NAMES = [...CONFIGURATION_READ_NAMES, ...TESTING_READ_NAMES, ...FLEET_READ_NAMES] as const;

export type ConfigurationReadName = (typeof CONFIGURATION_READ_NAMES)[number];
export type TestingReadName = (typeof TESTING_READ_NAMES)[number];
export type FleetReadName = (typeof FLEET_READ_NAMES)[number];
export type WorkspaceReadName = (typeof WORKSPACE_READ_NAMES)[number];

/** Every read a reused screen may ask for, with the API client's own signatures. */
export type WorkspaceReads = Pick<typeof api, WorkspaceReadName>;
export type ConfigurationReads = Pick<typeof api, ConfigurationReadName>;
export type TestingReads = Pick<typeof api, TestingReadName>;
export type FleetReads = Pick<typeof api, FleetReadName>;

let sample: WorkspaceReads | null = null;

/** The sample's reads, each loading `sample-reads.ts` on its first call (one import, shared). */
function sampleReads(): WorkspaceReads {
  if (sample !== null) return sample;
  const load = () => import("~/lib/playground/sample-reads.js").then((module) => module.SAMPLE_READS);
  sample = Object.fromEntries(
    WORKSPACE_READ_NAMES.map((name) => [
      name,
      async (...args: unknown[]) => ((await load())[name] as (...given: unknown[]) => unknown)(...args),
    ]),
  ) as unknown as WorkspaceReads;
  return sample;
}

/** Whether `organizationId` is the sample workspace's. */
export function isSampleOrganization(organizationId: string | null | undefined): boolean {
  return organizationId === SAMPLE_ORGANIZATION_ID;
}

/** The reads for `organizationId`: the sample's for the sample workspace, the API client's otherwise. */
export function readsFor(organizationId: string | null | undefined): WorkspaceReads {
  return isSampleOrganization(organizationId) ? sampleReads() : api;
}
