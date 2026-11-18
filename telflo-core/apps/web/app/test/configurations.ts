import {
  DEFAULT_USER_PREFERENCES,
  type Configuration,
  type ConfigurationVersion,
  type ConfigurationVersionSummary,
  type ConfigurationWithVersionResponse,
  type CurrentUserResponse,
} from "@telflo/contracts";

/*
 * Configurations of one organization, for the configurations page's tests.
 * The signed-in member created MINE, a draft; a colleague created THEIRS;
 * ORPHANED's creator's account is gone. THEIRS and ORPHANED are published,
 * since the member sees no one else's draft (D11b decision 1). Every date is
 * at noon UTC, so it falls on the same day in any time zone the tests run in.
 */

export const MEMBER_ID = "00000000-0000-4000-8000-000000000001";
export const MEMBER_EMAIL = "member@example.com";
export const PERSONAL_ID = "00000000-0000-4000-8000-000000000002";
export const GROUP_ID = "00000000-0000-4000-8000-000000000003";
export const COLLEAGUE_ID = "00000000-0000-4000-8000-000000000012";
export const COLLEAGUE_EMAIL = "colleague@example.com";

export const MINE: Configuration = {
  id: "0199a000-0000-7000-8000-000000000001",
  name: "Production Monitoring",
  description: "Collects traces and metrics from production",
  createdAt: "2026-03-15T12:00:00.000Z",
  updatedAt: "2026-04-20T12:00:00.000Z",
  createdBy: { userId: MEMBER_ID, email: MEMBER_EMAIL },
  published: false,
  collectorDistribution: "otelcol-contrib",
};

export const THEIRS: Configuration = {
  id: "0199a000-0000-7000-8000-000000000002",
  name: "Staging Logs",
  description: "",
  createdAt: "2026-02-01T12:00:00.000Z",
  updatedAt: "2026-02-03T12:00:00.000Z",
  createdBy: { userId: COLLEAGUE_ID, email: COLLEAGUE_EMAIL },
  published: true,
  collectorDistribution: "otelcol-contrib",
};

export const ORPHANED: Configuration = {
  id: "0199a000-0000-7000-8000-000000000003",
  name: "Left Behind",
  description: "From someone who left",
  createdAt: "2026-01-10T12:00:00.000Z",
  updatedAt: "2026-01-11T12:00:00.000Z",
  createdBy: null,
  published: true,
  collectorDistribution: "otelcol-contrib",
};

/** `count` configurations named "Configuration 1" onwards, created by the colleague. */
export function manyConfigurations(count: number, from = 1): Configuration[] {
  return Array.from({ length: count }, (_, index) => {
    const number = from + index;
    return {
      ...THEIRS,
      id: `0199b000-0000-7000-8000-${String(number).padStart(12, "0")}`,
      name: `Configuration ${number}`,
    };
  });
}

/** The member, active in `organizationId` (their personal organization by default). */
export function signedInMember(
  organizationId = PERSONAL_ID,
  termsAcceptanceRequired = false,
): CurrentUserResponse {
  const personal = { id: PERSONAL_ID, name: "member", type: "personal", logoId: null, role: "admin" } as const;
  const group = { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" } as const;
  return {
    user: { id: MEMBER_ID, email: MEMBER_EMAIL },
    organization: organizationId === GROUP_ID ? group : personal,
    organizations: [personal, group],
    termsAcceptanceRequired,
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: DEFAULT_USER_PREFERENCES,
  };
}

/** The id of MINE's version 1, as the editor's tests open it. */
export const VERSION_ID = "0199c000-0000-7000-8000-000000000001";

/**
 * A version of MINE, as the API answers one (D10 decision 4): number 1,
 * unnamed, created by the member, with no graph, a draft (D11b decision 10),
 * pinned to a collector version the catalogue offers (D13a decision 8); any
 * field overridden.
 */
export function versionFixture(overrides: Partial<ConfigurationVersion> = {}): ConfigurationVersion {
  return {
    id: VERSION_ID,
    configurationId: MINE.id,
    versionNumber: 1,
    label: null,
    createdBy: { userId: MEMBER_ID, email: MEMBER_EMAIL },
    yamlContent: "",
    nodes: [],
    edges: [],
    pipelines: [],
    createdAt: "2026-03-15T12:00:00.000Z",
    updatedAt: "2026-04-20T12:00:00.000Z",
    publishedAt: null,
    publishedBy: null,
    collectorVersion: "0.162.0",
    collectorVersionDeprecated: false,
    collectorVersionDeprecatedNote: null,
    ...overrides,
  };
}

/**
 * The publish fields of a version the member published (D11b decision 10),
 * to spread over `versionFixture`'s: a published version is read-only in the
 * editor (decision 4).
 */
export const PUBLISHED_FIELDS = {
  publishedAt: "2026-10-04T12:00:00.000Z",
  publishedBy: { userId: MEMBER_ID, email: MEMBER_EMAIL },
} as const satisfies Pick<ConfigurationVersion, "publishedAt" | "publishedBy">;

/** A version's summary, as the API lists it: no content. */
export function versionSummaryOf({
  id,
  versionNumber,
  label,
  createdBy,
  createdAt,
  updatedAt,
  publishedAt,
  publishedBy,
  collectorVersion,
  collectorVersionDeprecated,
  collectorVersionDeprecatedNote,
}: ConfigurationVersionSummary): ConfigurationVersionSummary {
  return {
    id,
    versionNumber,
    label,
    createdBy,
    createdAt,
    updatedAt,
    publishedAt,
    publishedBy,
    collectorVersion,
    collectorVersionDeprecated,
    collectorVersionDeprecatedNote,
  };
}

/**
 * What the API answers a read of `configuration` with (D10 decision 4): the
 * version, and the version list, by default the version's summary alone.
 */
export function answerFor(
  configuration: Configuration,
  version: ConfigurationVersion,
  versions: ConfigurationVersionSummary[] = [versionSummaryOf(version)],
): ConfigurationWithVersionResponse {
  return { configuration, version, versions };
}
