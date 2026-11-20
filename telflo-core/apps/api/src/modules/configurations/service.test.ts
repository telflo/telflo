import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationRole } from "@telflo/db";
import type { ActorContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import type { AuditEvent } from "../identity/repositories/audit-repository.js";
import type { Member } from "../organizations/repositories/member-repository.js";
import type { Actor } from "../organizations/service.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type {
  Configuration,
  ConfigurationChanges,
  CreateConfigurationInput as CreateConfigurationRowInput,
  IConfigurationRepository,
  ListConfigurationsInput,
  LockedConfiguration,
} from "./repositories/configuration-repository.js";
import type {
  ConfigurationVersion,
  ConfigurationVersionFacts,
  ConfigurationVersionSummary,
  CreateConfigurationVersionInput,
  CreateNextConfigurationVersionInput,
  IConfigurationVersionRepository,
  SavedConfigurationVersion,
} from "./repositories/configuration-version-repository.js";
import type { IConfigurationVersionSelectionRepository } from "./repositories/configuration-version-selection-repository.js";
import { OpampServerMisconfigurationError } from "../../opamp-server/client.js";
import { createConfigurationService, type ConfigurationTransaction, type FleetUsageAnswer } from "./service.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const EARLIER = new Date("2029-06-01T00:00:00.000Z");
const origin = { ipAddress: "203.0.113.7", userAgent: "vitest" };
/** The fake catalog's defaults: a fixture's, not the real catalog's, which the integration tests read. */
const CATALOGUE_DEFAULTS = { distribution: "fixture-distribution", version: "1.2.3" };
/** Another version of the default distribution the fake catalog offers. */
const OFFERED_VERSION = "1.1.0";
/** A version of the default distribution the fake catalog has deprecated, and its note. */
const DEPRECATED_VERSION = "1.0.0";
const DEPRECATED_NOTE = "Retired: upgrade to 1.2.3.";
/** Another distribution of the fake catalog, not the default, and its default version. */
const OTHER_DISTRIBUTION = { distribution: "other-distribution", version: "2.0.0" };

/**
 * The fake catalog's versions, by `distribution@version`: whether each is
 * deprecated, and its note. A version missing here isn't in the catalog.
 */
const CATALOGUE = new Map<string, { deprecated: boolean; note: string | null }>([
  [`${CATALOGUE_DEFAULTS.distribution}@${CATALOGUE_DEFAULTS.version}`, { deprecated: false, note: null }],
  [`${CATALOGUE_DEFAULTS.distribution}@${OFFERED_VERSION}`, { deprecated: false, note: null }],
  [`${CATALOGUE_DEFAULTS.distribution}@${DEPRECATED_VERSION}`, { deprecated: true, note: DEPRECATED_NOTE }],
  [`${OTHER_DISTRIBUTION.distribution}@${OTHER_DISTRIBUTION.version}`, { deprecated: false, note: null }],
]);

/** A pin's deprecation, as the real repository's join to the catalog reads it. */
function deprecationOf(distribution: string, version: string) {
  const entry = CATALOGUE.get(`${distribution}@${version}`);
  return {
    collectorVersionDeprecated: entry?.deprecated ?? false,
    collectorVersionDeprecatedNote: entry?.deprecated ? entry.note : null,
  };
}

/** A save's content: the text, and a small graph, which the service passes on as it is. */
const GRAPH = {
  nodes: [{ id: "node_0", type: "receiver", position: { x: 1, y: 2 }, data: { label: "OTLP", config: {} } }],
  edges: [{ id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep" }],
  pipelines: [{ id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316" }],
};
const contentOf = (yamlContent: string) => ({ yamlContent, ...GRAPH });

/**
 * Hand-built fakes typed against the repository interfaces. Every call is
 * logged in order, so a test can see that the organization's lock and the
 * membership's re-read came first. There is no real transaction:
 * routes.integration.test.ts proves the locks and atomicity against
 * Postgres.
 */
function buildHarness() {
  const calls: string[] = [];
  const auditEvents: AuditEvent[] = [];
  const contexts: ActorContext[] = [];
  const organizationId = randomUUID();
  const state = { isOrganizationLive: true };
  const people = new Map<string, Member>();
  const rows = new Map<string, LockedConfiguration & { deleted: boolean }>();
  const creatorEmail = (userId: string | null) =>
    userId === null ? null : { userId, email: people.get(userId)?.email ?? "gone@example.com" };
  const versionRows = new Map<string, ConfigurationVersion>();
  const view = (row: LockedConfiguration): Configuration => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: creatorEmail(row.createdByUserId),
    published: [...versionRows.values()].some(
      (version) => version.configurationId === row.id && version.publishedAt !== null,
    ),
    collectorDistribution: row.collectorDistribution,
  });
  const pages: { items: Configuration[]; hasMore: boolean } = { items: [], hasMore: false };
  const isLive = (configurationId: string) => {
    const row = rows.get(configurationId);
    return row !== undefined && !row.deleted;
  };

  const configurations = {
    listPage: vi.fn(async (_input: ListConfigurationsInput) => {
      calls.push("configurations.listPage");
      return pages;
    }),
    find: vi.fn(async (id: string) => {
      calls.push("configurations.find");
      const row = rows.get(id);
      return row && !row.deleted ? view(row) : undefined;
    }),
    lockForUpdate: vi.fn(async (id: string) => {
      calls.push("configurations.lockForUpdate");
      const row = rows.get(id);
      if (!row || row.deleted) return undefined;
      const { deleted: _deleted, ...locked } = row;
      return locked;
    }),
    create: vi.fn(async (input: CreateConfigurationRowInput) => {
      calls.push("configurations.create");
      const row = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        createdByUserId: input.createdByUserId,
        createdAt: input.at,
        updatedAt: input.at,
        collectorDistribution: input.collectorDistribution,
        deleted: false,
      };
      rows.set(row.id, row);
      return view(row);
    }),
    update: vi.fn(async (id: string, changes: ConfigurationChanges, at: Date) => {
      calls.push(`configurations.update:${JSON.stringify(changes)}`);
      const row = rows.get(id);
      if (!row || row.deleted) return undefined;
      Object.assign(row, changes, { updatedAt: at });
      return view(row);
    }),
    touch: vi.fn(async (id: string, at: Date) => {
      calls.push(`configurations.touch:${at.toISOString()}`);
      const row = rows.get(id);
      if (!row || row.deleted) return false;
      row.updatedAt = at;
      return true;
    }),
    markDeleted: vi.fn(async (id: string, at: Date) => {
      calls.push(`configurations.markDeleted:${at.toISOString()}`);
      const row = rows.get(id);
      if (!row || row.deleted) return false;
      Object.assign(row, { deleted: true, updatedAt: at });
      return true;
    }),
  } satisfies IConfigurationRepository;

  /** Versions reached only through a live configuration, as the real repository's joins reach them. */
  const versions = {
    findOpened: vi.fn(async (configurationId: string) => {
      calls.push("versions.findOpened");
      if (!isLive(configurationId)) return undefined;
      const own = [...versionRows.values()].filter((version) => version.configurationId === configurationId);
      const highest = own.sort((a, b) => b.versionNumber - a.versionNumber)[0];
      // A fresh copy each time, as the real repository reads a fresh row.
      return highest && { ...highest };
    }),
    find: vi.fn(async (configurationId: string, versionId: string) => {
      calls.push("versions.find");
      const version = versionRows.get(versionId);
      return version && version.configurationId === configurationId && isLive(configurationId)
        ? { ...version }
        : undefined;
    }),
    findSummary: vi.fn(async (configurationId: string, versionId: string) => {
      calls.push("versions.findSummary");
      const version = versionRows.get(versionId);
      return version && version.configurationId === configurationId && isLive(configurationId)
        ? summaryOf(version)
        : undefined;
    }),
    listSummaries: vi.fn(async (configurationId: string): Promise<ConfigurationVersionSummary[]> => {
      calls.push("versions.listSummaries");
      if (!isLive(configurationId)) return [];
      return [...versionRows.values()]
        .filter((version) => version.configurationId === configurationId)
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .map(summaryOf);
    }),
    create: vi.fn(async (input: CreateConfigurationVersionInput) => {
      calls.push("versions.create");
      const version: ConfigurationVersion = {
        id: randomUUID(),
        configurationId: input.configurationId,
        versionNumber: input.versionNumber,
        label: input.label ?? null,
        createdBy: creatorEmail(input.createdByUserId),
        yamlContent: input.yamlContent,
        // The table's `[]` unless a graph is given.
        nodes: input.graph?.nodes ?? [],
        edges: input.graph?.edges ?? [],
        pipelines: input.graph?.pipelines ?? [],
        createdAt: input.at,
        updatedAt: input.at,
        publishedAt: null,
        publishedBy: null,
        collectorDistribution: input.collectorDistribution,
        collectorVersion: input.collectorVersion,
        ...deprecationOf(input.collectorDistribution, input.collectorVersion),
      };
      versionRows.set(version.id, version);
      return version;
    }),
    createNext: vi.fn(async (input: CreateNextConfigurationVersionInput) => {
      calls.push(`versions.createNext:${input.at.toISOString()}`);
      if (!isLive(input.configurationId)) return undefined;
      const highest = Math.max(
        0,
        ...[...versionRows.values()]
          .filter((version) => version.configurationId === input.configurationId)
          .map((version) => version.versionNumber),
      );
      const version: ConfigurationVersion = {
        id: randomUUID(),
        configurationId: input.configurationId,
        versionNumber: highest + 1,
        label: input.label,
        createdBy: creatorEmail(input.createdByUserId),
        yamlContent: input.yamlContent,
        nodes: input.nodes,
        edges: input.edges,
        pipelines: input.pipelines,
        createdAt: input.at,
        updatedAt: input.at,
        publishedAt: null,
        publishedBy: null,
        collectorDistribution: input.collectorDistribution,
        collectorVersion: input.collectorVersion,
        ...deprecationOf(input.collectorDistribution, input.collectorVersion),
      };
      versionRows.set(version.id, version);
      return { ...version };
    }),
    rename: vi.fn(async (configurationId: string, versionId: string, label: string) => {
      calls.push(`versions.rename:${label}`);
      const version = versionRows.get(versionId);
      if (!version || version.configurationId !== configurationId || !isLive(configurationId)) return undefined;
      version.label = label;
      return summaryOf(version);
    }),
    save: vi.fn(async (configurationId: string, versionId: string, input: SavedConfigurationVersion, at: Date) => {
      calls.push(`versions.save:${at.toISOString()}`);
      const version = versionRows.get(versionId);
      if (!version || version.configurationId !== configurationId || !isLive(configurationId)) return undefined;
      const { collectorVersion, ...content } = input;
      Object.assign(version, { ...content, updatedAt: at });
      if (collectorVersion !== undefined) {
        Object.assign(version, {
          collectorVersion,
          ...deprecationOf(version.collectorDistribution, collectorVersion),
        });
      }
      return { ...version };
    }),
    // The public API's reads by number and its list's facts.
    findIdByNumber: vi.fn(async (configurationId: string, versionNumber: number) => {
      calls.push("versions.findIdByNumber");
      if (!isLive(configurationId)) return undefined;
      return [...versionRows.values()].find(
        (version) => version.configurationId === configurationId && version.versionNumber === versionNumber,
      )?.id;
    }),
    listFacts: vi.fn(async (configurationIds: readonly string[]) => {
      calls.push("versions.listFacts");
      const facts = new Map<string, ConfigurationVersionFacts>();
      for (const configurationId of configurationIds) {
        if (!isLive(configurationId)) continue;
        const own = [...versionRows.values()]
          .filter((version) => version.configurationId === configurationId)
          .sort((a, b) => b.versionNumber - a.versionNumber);
        const latest = own[0];
        if (latest === undefined) continue;
        facts.set(configurationId, {
          latestVersionId: latest.id,
          latestVersionNumber: latest.versionNumber,
          collectorVersion: latest.collectorVersion,
          publishedVersionNumber: own.find((version) => version.publishedAt !== null)?.versionNumber ?? null,
        });
      }
      return facts;
    }),
    // The publish service's (publishing.ts), which has its own tests.
    recordPublish: vi.fn(async () => {
      throw new Error("the configuration service never records a publish");
    }),
    isPublicationRecorded: vi.fn(async () => {
      throw new Error("the configuration service never asks about a publication");
    }),
  } satisfies IConfigurationVersionRepository;

  /**
   * Each person's selected version, keyed by person and configuration, as
   * the real repository keeps them: `find` answers only a live
   * configuration's, and `record` writes only a version of that live
   * configuration.
   */
  const selectionRows = new Map<string, string>();
  const selectionKey = (userId: string, configurationId: string) => `${userId}/${configurationId}`;
  const selections = {
    find: vi.fn(async (userId: string, configurationId: string) => {
      calls.push("selections.find");
      return isLive(configurationId) ? selectionRows.get(selectionKey(userId, configurationId)) : undefined;
    }),
    record: vi.fn(async (userId: string, configurationId: string, versionId: string, at: Date) => {
      calls.push(`selections.record:${at.toISOString()}`);
      const version = versionRows.get(versionId);
      if (!version || version.configurationId !== configurationId || !isLive(configurationId)) return false;
      selectionRows.set(selectionKey(userId, configurationId), versionId);
      return true;
    }),
  } satisfies IConfigurationVersionSelectionRepository;

  /** The collector catalog: CATALOGUE's versions, the two distributions' defaults. */
  const catalogue = {
    findDefaults: vi.fn(async () => {
      calls.push("catalogue.findDefaults");
      return { ...CATALOGUE_DEFAULTS };
    }),
    findDistributionDefault: vi.fn(async (distribution: string) => {
      calls.push(`catalogue.findDistributionDefault:${distribution}`);
      return [CATALOGUE_DEFAULTS, OTHER_DISTRIBUTION].find((pin) => pin.distribution === distribution);
    }),
    isOffered: vi.fn(async (distribution: string, version: string) => {
      calls.push(`catalogue.isOffered:${distribution}@${version}`);
      const entry = CATALOGUE.get(`${distribution}@${version}`);
      return entry !== undefined && !entry.deprecated;
    }),
    findVersionState: vi.fn(async () => {
      throw new Error("the configuration service never asks for a version's state: only a validation does");
    }),
  } satisfies ConfigurationTransaction["catalogue"];

  /**
   * The test suites' version copy, which
   * test-suites/routes.integration.test.ts proves against Postgres: here,
   * only that createVersion asks for it, in order, and audits its counts.
   */
  const suites = {
    copyToVersion: vi.fn(async (_configurationId: string, _fromVersionId: string, _toVersionId: string, at: Date) => {
      calls.push(`suites.copyToVersion:${at.toISOString()}`);
      return { suites: 2, definitions: 5 };
    }),
  } satisfies ConfigurationTransaction["suites"];

  /**
   * The validation pipelines' version copy, which
   * validation-pipelines/routes.integration.test.ts proves against Postgres:
   * here, only that createVersion asks for it after the suites' and audits
   * its counts.
   */
  const validationPipelines = {
    copyToVersion: vi.fn(async (_configurationId: string, _fromVersionId: string, _toVersionId: string, at: Date) => {
      calls.push(`validationPipelines.copyToVersion:${at.toISOString()}`);
      return { pipelines: 3, rules: 7 };
    }),
  } satisfies ConfigurationTransaction["validationPipelines"];

  const transaction: ConfigurationTransaction = {
    organization: {
      findActiveForShare: vi.fn(async () => {
        calls.push("organization.findActiveForShare");
        return state.isOrganizationLive
          ? {
              id: organizationId,
              name: "Acme",
              type: "group" as const,
              ownerUserId: null,
              createdAt: EARLIER,
              logoId: null,
              logoContentType: null,
            }
          : undefined;
      }),
    },
    members: {
      find: vi.fn(async (userId: string) => {
        calls.push("members.find");
        const member = people.get(userId);
        return member ? { ...member } : undefined;
      }),
    },
    configurations,
    versions,
    selections,
    suites,
    validationPipelines,
    catalogue,
    audit: {
      record: vi.fn(async (event: AuditEvent) => {
        calls.push(`audit:${event.action}`);
        auditEvents.push(event);
      }),
    },
  };

  /** Each delete's clean-up scheduled: its organization and configuration. */
  const afterDeletes: Array<[organizationId: string, configurationId: string]> = [];

  /**
   * A delete's fleet usage check: in the calls' order as `fleetUsage`,
   * answering not in use unless a test says otherwise.
   */
  const fleetUsage = vi.fn(async (_context: ActorContext, configurationId: string): Promise<FleetUsageAnswer> => {
    calls.push("fleetUsage");
    transactionsOpenAtUsage.push(transactionsOpen);
    return { kind: "found", usage: { configurationId, inUse: false, publications: [] } };
  });
  const log = { warn: vi.fn(), error: vi.fn() };
  /** How many units of work are under way: a call to the opamp-server must find none. */
  let transactionsOpen = 0;
  const transactionsOpenAtUsage: number[] = [];

  const service = createConfigurationService({
    withTransaction: async (context, work) => {
      contexts.push(context);
      transactionsOpen++;
      try {
        return await work(transaction);
      } finally {
        transactionsOpen--;
      }
    },
    now: () => NOW,
    afterDelete: (deletedOrganizationId, configurationId) => {
      afterDeletes.push([deletedOrganizationId, configurationId]);
    },
    fleetUsage,
    log,
  });

  /** A member of the organization, in `role`, signed in to it. */
  function memberActor(role: OrganizationRole = "contributor"): Actor {
    const userId = randomUUID();
    const email = `member-${userId}@example.com`;
    people.set(userId, {
      userId,
      email,
      role,
      isOrganizationOwner: false,
      createdAt: EARLIER,
      deletedAt: null,
      isServiceAccount: false,
    });
    return {
      context: { userId, organizationId, role },
      email,
      ...origin,
    };
  }

  /** A live configuration of the organization. */
  function configuration(overrides: Partial<LockedConfiguration> = {}): LockedConfiguration {
    const row = {
      id: randomUUID(),
      name: "Gateway",
      description: "Collects traces",
      createdByUserId: null,
      createdAt: EARLIER,
      updatedAt: EARLIER,
      collectorDistribution: CATALOGUE_DEFAULTS.distribution,
      ...overrides,
    };
    rows.set(row.id, { ...row, deleted: false });
    return row;
  }

  /** A version of `configurationId`, number 1 unless given. */
  function version(configurationId: string, overrides: Partial<ConfigurationVersion> = {}): ConfigurationVersion {
    const row: ConfigurationVersion = {
      id: randomUUID(),
      configurationId,
      versionNumber: 1,
      label: null,
      createdBy: null,
      yamlContent: "receivers: {}\n",
      nodes: [],
      edges: [],
      pipelines: [],
      createdAt: EARLIER,
      updatedAt: EARLIER,
      publishedAt: null,
      publishedBy: null,
      collectorDistribution: CATALOGUE_DEFAULTS.distribution,
      collectorVersion: CATALOGUE_DEFAULTS.version,
      // As the catalog holds the pin, unless the test says otherwise.
      ...deprecationOf(
        overrides.collectorDistribution ?? CATALOGUE_DEFAULTS.distribution,
        overrides.collectorVersion ?? CATALOGUE_DEFAULTS.version,
      ),
      ...overrides,
    };
    versionRows.set(row.id, row);
    return { ...row };
  }

  return {
    calls,
    auditEvents,
    afterDeletes,
    fleetUsage,
    transactionsOpenAtUsage,
    log,
    contexts,
    organizationId,
    state,
    people,
    rows,
    pages,
    configurations,
    versions,
    versionRows,
    selections,
    selectionRows,
    selectionKey,
    suites,
    validationPipelines,
    catalogue,
    audit: transaction.audit,
    service,
    memberActor,
    configuration,
    version,
  };
}

type Harness = ReturnType<typeof buildHarness>;

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(AppError);
  return caught as AppError;
}

async function expectRefusal(promise: Promise<unknown>, statusCode: number, code: string, message: string) {
  expect(await refusal(promise)).toMatchObject({ statusCode, code, message });
}

const ORGANIZATION_NOT_FOUND = [404, "organization_not_found", "Organization not found"] as const;
const CONFIGURATION_NOT_FOUND = [404, "configuration_not_found", "Configuration not found"] as const;
const VERSION_NOT_FOUND = [404, "configuration_version_not_found", "Version not found"] as const;
const VERSION_PUBLISHED = [
  409,
  "configuration_version_published",
  "This version is published and can't be changed.",
] as const;
const DELETE_FORBIDDEN = [
  403,
  "configuration_delete_forbidden",
  "Only the configuration's author or an organization admin can delete it.",
] as const;

/** A published version's two fields, for `harness.version`. */
const PUBLISHED = {
  publishedAt: new Date("2029-12-01T00:00:00.000Z"),
  publishedBy: { userId: randomUUID(), email: "publisher@example.com" },
};

/** A summary of `version`, as the real repository's listSummaries and rename return one: no content. */
const summaryOf = ({
  id,
  versionNumber,
  label,
  createdBy,
  createdAt,
  updatedAt,
  publishedAt,
  publishedBy,
  collectorDistribution,
  collectorVersion,
  collectorVersionDeprecated,
  collectorVersionDeprecatedNote,
}: ConfigurationVersion): ConfigurationVersionSummary => ({
  id,
  versionNumber,
  label,
  createdBy,
  createdAt,
  updatedAt,
  publishedAt,
  publishedBy,
  collectorDistribution,
  collectorVersion,
  collectorVersionDeprecated,
  collectorVersionDeprecatedNote,
});

/** Malformed version ids: none reaches a repository. */
const MALFORMED_IDS = ["42", "not-a-uuid", "0192f1a47b3c7d2e8f101a2b3c4d5e6f", "{0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f}"];

describe("createConfigurationService", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  describe("every method", () => {
    const methods = [
      [
        "list",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.list(actor, organizationId, { limit: 50, filter: "all" }),
      ],
      ["get", (h: Harness, actor: Actor, organizationId: string) => h.service.get(actor, organizationId, randomUUID())],
      [
        "create",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.create(actor, organizationId, { name: "A", description: "" }),
      ],
      [
        "update",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.update(actor, organizationId, randomUUID(), { name: "A" }),
      ],
      [
        "remove",
        (h: Harness, actor: Actor, organizationId: string) => h.service.remove(actor, organizationId, randomUUID()),
      ],
      [
        "saveVersion",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.saveVersion(actor, organizationId, randomUUID(), randomUUID(), contentOf("receivers: {}\n")),
      ],
      [
        "getVersion",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.getVersion(actor, organizationId, randomUUID(), randomUUID()),
      ],
      [
        "createVersion",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.createVersion(actor, organizationId, randomUUID(), {
            sourceVersionId: randomUUID(),
            ...contentOf("receivers: {}\n"),
          }),
      ],
      [
        "renameVersion",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.renameVersion(actor, organizationId, randomUUID(), randomUUID(), "Renamed"),
      ],
      [
        "selectVersion",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.selectVersion(actor, organizationId, randomUUID(), randomUUID()),
      ],
      // The public API's.
      [
        "listWithFacts",
        (h: Harness, actor: Actor, organizationId: string) => h.service.listWithFacts(actor, organizationId, { limit: 50 }),
      ],
      ["getDetail", (h: Harness, actor: Actor, organizationId: string) => h.service.getDetail(actor, organizationId, randomUUID())],
      [
        "versionIdOf",
        (h: Harness, actor: Actor, organizationId: string) => h.service.versionIdOf(actor, organizationId, randomUUID(), 1),
      ],
      [
        "appendVersion",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.appendVersion(actor, organizationId, randomUUID(), { yamlContent: "receivers: {}\n" }),
      ],
      [
        "patchVersion",
        (h: Harness, actor: Actor, organizationId: string) =>
          h.service.patchVersion(actor, organizationId, randomUUID(), randomUUID(), { yamlContent: "receivers: {}\n" }),
      ],
    ] as const;

    it.each(methods)(
      "%s: refuses any organization but the active one with 404 organization_not_found, before any transaction",
      async (_name, call) => {
        const actor = harness.memberActor();
        await expectRefusal(call(harness, actor, randomUUID()), ...ORGANIZATION_NOT_FOUND);
        await expectRefusal(call(harness, actor, "not-a-uuid"), ...ORGANIZATION_NOT_FOUND);
        expect(harness.contexts).toEqual([]);
        expect(harness.calls).toEqual([]);
      },
    );

    it.each(methods)("%s: runs in the caller's context", async (_name, call) => {
      const actor = harness.memberActor();
      // Get, update, remove and saveVersion name an unknown configuration
      // here: their 404 still ran in the context.
      await call(harness, actor, harness.organizationId).catch(() => undefined);
      expect(harness.contexts).toEqual([actor.context]);
    });
  });

  describe("list", () => {
    it("takes no lock and reads no membership: authenticate did", async () => {
      const actor = harness.memberActor();
      await harness.service.list(actor, harness.organizationId, { limit: 50, filter: "all" });
      expect(harness.calls).toEqual(["configurations.listPage"]);
    });

    it.each(["all", "mine", "published"] as const)(
      "passes the limit, the decoded cursor, the search and the filter (%s)",
      async (filter) => {
        const actor = harness.memberActor();
        const after = { updatedAt: EARLIER, id: randomUUID() };
        await harness.service.list(actor, harness.organizationId, {
          limit: 7,
          cursor: encodeCursor(after),
          search: "gate",
          filter,
        });
        expect(harness.configurations.listPage).toHaveBeenCalledWith({ limit: 7, after, search: "gate", filter });
      },
    );

    it("passes no search for an empty q", async () => {
      const actor = harness.memberActor();
      await harness.service.list(actor, harness.organizationId, { limit: 50, search: "", filter: "all" });
      expect(harness.configurations.listPage).toHaveBeenCalledWith({ limit: 50, filter: "all" });
    });

    it("refuses a cursor that doesn't decode with 400 invalid_request, reading nothing", async () => {
      const actor = harness.memberActor();
      await expectRefusal(
        harness.service.list(actor, harness.organizationId, { limit: 50, cursor: "garbage", filter: "all" }),
        400,
        "invalid_request",
        "The request was not valid.",
      );
      expect(harness.calls).toEqual([]);
    });

    it("gives the last item's position as nextCursor when more follow, and null on the last page", async () => {
      const actor = harness.memberActor();
      const item = (updatedAt: Date): Configuration => ({
        id: randomUUID(),
        name: "Gateway",
        description: "",
        createdAt: EARLIER,
        updatedAt,
        createdBy: null,
        published: false,
        collectorDistribution: CATALOGUE_DEFAULTS.distribution,
      });
      const items = [item(NOW), item(EARLIER)];
      harness.pages.items = items;
      harness.pages.hasMore = true;

      const page = await harness.service.list(actor, harness.organizationId, { limit: 2, filter: "all" });
      expect(page.nextCursor).not.toBeNull();
      expect(decodeCursor(page.nextCursor!)).toEqual({ updatedAt: EARLIER, id: items[1]!.id });

      harness.pages.hasMore = false;
      expect(
        (await harness.service.list(actor, harness.organizationId, { limit: 2, filter: "all" })).nextCursor,
      ).toBeNull();
    });

    it("answers an empty organization with no items and no cursor", async () => {
      const actor = harness.memberActor();
      expect(await harness.service.list(actor, harness.organizationId, { limit: 50, filter: "all" })).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  describe("get", () => {
    it("reads the configuration, the caller's selection, the version the editor opens and the list, with no lock and no membership read", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const opened = harness.version(row.id);

      const found = await harness.service.get(actor, harness.organizationId, row.id);

      expect(found).toEqual({
        configuration: expect.objectContaining({ id: row.id, name: "Gateway" }),
        version: opened,
        versions: [summaryOf(opened)],
      });
      expect(harness.calls).toEqual([
        "configurations.find",
        "selections.find",
        "versions.findOpened",
        "versions.listSummaries",
      ]);
      expect(harness.selections.find).toHaveBeenCalledWith(actor.context.userId, row.id);
      expect(harness.auditEvents).toEqual([]);
    });

    it("opens the highest version_number when the caller has no selection, and lists every version highest first with its creator", async () => {
      const actor = harness.memberActor();
      const creator = harness.memberActor();
      const row = harness.configuration();
      const first = harness.version(row.id, { versionNumber: 1, label: "Initial version" });
      const second = harness.version(row.id, {
        versionNumber: 2,
        createdBy: { userId: creator.context.userId, email: creator.email },
      });

      const found = await harness.service.get(actor, harness.organizationId, row.id);

      expect(found.version).toEqual(second);
      expect(found.versions).toEqual([summaryOf(second), summaryOf(first)]);
    });

    it("opens the caller's selection, though a higher version exists", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const first = harness.version(row.id, { versionNumber: 1 });
      const second = harness.version(row.id, { versionNumber: 2 });
      harness.selectionRows.set(harness.selectionKey(actor.context.userId, row.id), first.id);

      const found = await harness.service.get(actor, harness.organizationId, row.id);

      expect(found.version).toEqual(first);
      expect(found.versions).toEqual([summaryOf(second), summaryOf(first)]);
      expect(harness.calls).toEqual([
        "configurations.find",
        "selections.find",
        "versions.find",
        "versions.listSummaries",
      ]);
      expect(harness.versions.findOpened).not.toHaveBeenCalled();
    });

    it("never opens another member's selection", async () => {
      const actor = harness.memberActor();
      const other = harness.memberActor();
      const row = harness.configuration();
      const first = harness.version(row.id, { versionNumber: 1 });
      const second = harness.version(row.id, { versionNumber: 2 });
      harness.selectionRows.set(harness.selectionKey(other.context.userId, row.id), first.id);

      expect((await harness.service.get(actor, harness.organizationId, row.id)).version).toEqual(second);
      expect((await harness.service.get(other, harness.organizationId, row.id)).version).toEqual(first);
    });

    it("opens the highest when the selection's version is no longer found", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id, { versionNumber: 1 });
      const second = harness.version(row.id, { versionNumber: 2 });
      harness.selectionRows.set(harness.selectionKey(actor.context.userId, row.id), randomUUID());

      expect((await harness.service.get(actor, harness.organizationId, row.id)).version).toEqual(second);
    });

    it("refuses with 404 configuration_not_found when the list comes back empty: the configuration was deleted meanwhile", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      harness.versions.listSummaries.mockResolvedValueOnce([]);
      await expectRefusal(harness.service.get(actor, harness.organizationId, row.id), ...CONFIGURATION_NOT_FOUND);
    });

    it.each(["42", "not-a-uuid", "0192f1a47b3c7d2e8f101a2b3c4d5e6f", "{0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f}"])(
      "refuses an id that isn't a canonical UUID (%s) with 404 configuration_not_found, before any transaction",
      async (id) => {
        const actor = harness.memberActor();
        await expectRefusal(harness.service.get(actor, harness.organizationId, id), ...CONFIGURATION_NOT_FOUND);
        expect(harness.contexts).toEqual([]);
        expect(harness.calls).toEqual([]);
      },
    );

    it("refuses a configuration that is missing, deleted or another organization's, with 404 configuration_not_found", async () => {
      const actor = harness.memberActor();
      const deleted = harness.configuration();
      harness.version(deleted.id);
      harness.rows.get(deleted.id)!.deleted = true;
      for (const id of [randomUUID(), deleted.id]) {
        await expectRefusal(harness.service.get(actor, harness.organizationId, id), ...CONFIGURATION_NOT_FOUND);
      }
      expect(harness.versions.findOpened).not.toHaveBeenCalled();
    });

    it("refuses with 404 configuration_not_found when no version is found", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      await expectRefusal(harness.service.get(actor, harness.organizationId, row.id), ...CONFIGURATION_NOT_FOUND);
      expect(harness.calls).toEqual(["configurations.find", "selections.find", "versions.findOpened"]);
    });

    it("lowercases an uppercased id, which names the same row", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      await harness.service.get(actor, harness.organizationId, row.id.toUpperCase());
      expect(harness.configurations.find).toHaveBeenCalledWith(row.id);
      expect(harness.versions.findOpened).toHaveBeenCalledWith(row.id);
    });
  });

  describe("create", () => {
    it("locks the organization, re-reads the membership, inserts it and its version 1 at the clock's time, and audits the name", async () => {
      const actor = harness.memberActor("contributor");

      const created = await harness.service.create(actor, harness.organizationId, {
        name: "Gateway",
        description: "Prod",
      });

      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "catalogue.findDefaults",
        "configurations.create",
        "versions.create",
        "audit:configuration.created",
      ]);
      // The catalog's defaults, read in the transaction.
      expect(harness.configurations.create).toHaveBeenCalledWith({
        name: "Gateway",
        description: "Prod",
        createdByUserId: actor.context.userId,
        collectorDistribution: CATALOGUE_DEFAULTS.distribution,
        at: NOW,
      });
      expect(harness.versions.create).toHaveBeenCalledWith({
        configurationId: expect.any(String),
        versionNumber: 1,
        yamlContent: "",
        createdByUserId: actor.context.userId,
        collectorDistribution: CATALOGUE_DEFAULTS.distribution,
        collectorVersion: CATALOGUE_DEFAULTS.version,
        at: NOW,
      });
      expect(created).toMatchObject({ name: "Gateway", createdAt: NOW, updatedAt: NOW });
      expect(harness.versions.create.mock.calls[0]![0].configurationId).toBe(created.id);
      expect(harness.auditEvents).toEqual([
        {
          action: "configuration.created",
          actorUserId: actor.context.userId,
          actorEmail: actor.email,
          organizationId: harness.organizationId,
          subjectType: "configuration",
          subjectId: created.id,
          metadata: { name: "Gateway" },
          ...origin,
        },
      ]);
    });
  });

  describe.each([
    ["create", (h: Harness, actor: Actor) => h.service.create(actor, h.organizationId, { name: "A", description: "" })],
    [
      "update",
      (h: Harness, actor: Actor) =>
        h.service.update(actor, h.organizationId, h.configuration().id, { name: "Renamed" }),
    ],
    // Its author's own: whatever their role, an author may delete it;
    // another member's is the remove block's.
    [
      "remove",
      (h: Harness, actor: Actor) =>
        h.service.remove(actor, h.organizationId, h.configuration({ createdByUserId: actor.context.userId }).id),
    ],
    [
      "saveVersion",
      (h: Harness, actor: Actor) => {
        const row = h.configuration();
        return h.service.saveVersion(
          actor,
          h.organizationId,
          row.id,
          h.version(row.id).id,
          contentOf("receivers: {}\n"),
        );
      },
    ],
    [
      "createVersion",
      (h: Harness, actor: Actor) => {
        const row = h.configuration();
        return h.service.createVersion(actor, h.organizationId, row.id, {
          sourceVersionId: h.version(row.id).id,
          ...contentOf("receivers: {}\n"),
        });
      },
    ],
    [
      "renameVersion",
      (h: Harness, actor: Actor) => {
        const row = h.configuration();
        return h.service.renameVersion(actor, h.organizationId, row.id, h.version(row.id).id, "Renamed");
      },
    ],
  ] as const)("%s, under the organization's lock", (_name, write) => {
    it("refuses when the organization is no longer live, with 404 organization_not_found, writing nothing", async () => {
      const actor = harness.memberActor();
      harness.state.isOrganizationLive = false;
      await expectRefusal(write(harness, actor), ...ORGANIZATION_NOT_FOUND);
      expect(harness.calls).toEqual(["organization.findActiveForShare"]);
      expect(harness.auditEvents).toEqual([]);
    });

    it("refuses a caller removed since the request was authenticated, with 404 organization_not_found", async () => {
      const actor = harness.memberActor();
      harness.people.set(actor.context.userId, { ...harness.people.get(actor.context.userId)!, deletedAt: NOW });
      await expectRefusal(write(harness, actor), ...ORGANIZATION_NOT_FOUND);
      expect(harness.calls).toEqual(["organization.findActiveForShare", "members.find"]);
      expect(harness.auditEvents).toEqual([]);
    });

    it("refuses a caller with no membership (or a deleted account), with 404 organization_not_found", async () => {
      const actor = harness.memberActor();
      harness.people.delete(actor.context.userId);
      await expectRefusal(write(harness, actor), ...ORGANIZATION_NOT_FOUND);
      expect(harness.calls).toEqual(["organization.findActiveForShare", "members.find"]);
    });

    it.each(["admin", "contributor"] as const)("never checks the role for the write: a %s may", async (role) => {
      const actor = harness.memberActor(role);
      await write(harness, actor);
      expect(harness.auditEvents).toHaveLength(1);
    });
  });

  describe("selectVersion, under the organization's lock", () => {
    const select = (actor: Actor) => {
      const row = harness.configuration();
      const version = harness.version(row.id);
      return harness.service.selectVersion(actor, harness.organizationId, row.id, version.id);
    };

    it("refuses when the organization is no longer live, with 404 organization_not_found, recording nothing", async () => {
      const actor = harness.memberActor();
      harness.state.isOrganizationLive = false;
      await expectRefusal(select(actor), ...ORGANIZATION_NOT_FOUND);
      expect(harness.calls).toEqual(["organization.findActiveForShare"]);
      expect(harness.selectionRows.size).toBe(0);
    });

    it("refuses a caller removed since the request was authenticated, with 404 organization_not_found", async () => {
      const actor = harness.memberActor();
      harness.people.set(actor.context.userId, { ...harness.people.get(actor.context.userId)!, deletedAt: NOW });
      await expectRefusal(select(actor), ...ORGANIZATION_NOT_FOUND);
      expect(harness.calls).toEqual(["organization.findActiveForShare", "members.find"]);
      expect(harness.selectionRows.size).toBe(0);
    });

    it.each(["admin", "contributor"] as const)("never checks the role: a %s may", async (role) => {
      const actor = harness.memberActor(role);
      await select(actor);
      expect(harness.selectionRows.size).toBe(1);
    });
  });

  describe("update", () => {
    it("locks the configuration after the organization and the membership, and audits only what changed", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration({ name: "Gateway", description: "Old" });

      const updated = await harness.service.update(actor, harness.organizationId, row.id, {
        name: "Gateway",
        description: "New",
      });

      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        'configurations.update:{"description":"New"}',
        "audit:configuration.updated",
      ]);
      expect(updated).toMatchObject({ name: "Gateway", description: "New", updatedAt: NOW });
      expect(harness.auditEvents).toEqual([
        expect.objectContaining({
          action: "configuration.updated",
          subjectType: "configuration",
          subjectId: row.id,
          organizationId: harness.organizationId,
          metadata: { from: { description: "Old" }, to: { description: "New" } },
        }),
      ]);
    });

    it("changes both, auditing both", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration({ name: "A", description: "B" });
      await harness.service.update(actor, harness.organizationId, row.id, { name: "C", description: "" });
      expect(harness.auditEvents[0]!.metadata).toEqual({
        from: { name: "A", description: "B" },
        to: { name: "C", description: "" },
      });
    });

    it.each([
      ["an empty change", {}],
      ["the values already there", { name: "Gateway", description: "Collects traces" }],
    ])("answers %s with the configuration as it is: no write, no audit", async (_label, changes) => {
      const actor = harness.memberActor();
      const row = harness.configuration();

      const unchanged = await harness.service.update(actor, harness.organizationId, row.id, changes);

      expect(unchanged).toMatchObject({ id: row.id, updatedAt: EARLIER });
      expect(harness.configurations.update).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
      expect(harness.calls.at(-1)).toBe("configurations.find");
    });

    it("lowercases an uppercased id, which names the same row", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      await harness.service.update(actor, harness.organizationId, row.id.toUpperCase(), { name: "Renamed" });
      expect(harness.configurations.lockForUpdate).toHaveBeenCalledWith(row.id);
    });
  });

  describe("remove", () => {
    it("locks the configuration, deletes it at the clock's time, and audits its name", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration({ name: "Gateway", createdByUserId: actor.context.userId });

      await harness.service.remove(actor, harness.organizationId, row.id);

      expect(harness.calls).toEqual([
        // The rights first, read and committed: a draft asks no fleet.
        "organization.findActiveForShare",
        "members.find",
        "configurations.find",
        // Then today's transaction.
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        `configurations.markDeleted:${NOW.toISOString()}`,
        "audit:configuration.deleted",
      ]);
      expect(harness.contexts).toHaveLength(2);
      expect(harness.fleetUsage).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([
        expect.objectContaining({
          action: "configuration.deleted",
          subjectType: "configuration",
          subjectId: row.id,
          metadata: { name: "Gateway" },
        }),
      ]);
    });

    describe("its snapshots' clean-up", () => {
      it("schedules it once, with the organization and the configuration, after the delete", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration({ createdByUserId: actor.context.userId });
        await harness.service.remove(actor, harness.organizationId, row.id.toUpperCase());
        expect(harness.afterDeletes).toEqual([[harness.organizationId, row.id]]);
      });

      it("schedules nothing for a refused delete: unknown, forbidden, or another organization's path", async () => {
        const author = harness.memberActor("admin");
        const teammate = harness.memberActor("contributor");
        const row = harness.configuration({ createdByUserId: author.context.userId });
        await expectRefusal(
          harness.service.remove(teammate, harness.organizationId, randomUUID()),
          ...CONFIGURATION_NOT_FOUND,
        );
        await expectRefusal(harness.service.remove(teammate, harness.organizationId, row.id), ...DELETE_FORBIDDEN);
        await expectRefusal(harness.service.remove(author, randomUUID(), row.id), ...ORGANIZATION_NOT_FOUND);
        expect(harness.afterDeletes).toEqual([]);
      });

      it("schedules nothing when the delete's transaction fails", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration({ createdByUserId: actor.context.userId });
        vi.mocked(harness.audit.record).mockRejectedValueOnce(new Error("the audit row failed"));
        await expect(harness.service.remove(actor, harness.organizationId, row.id)).rejects.toThrow(
          "the audit row failed",
        );
        expect(harness.afterDeletes).toEqual([]);
      });
    });

    describe("a published one, only when no fleet uses it", () => {
      const IN_USE = [
        409,
        "configuration_in_use",
        "A collector group or a collector uses a published version of this configuration. Remove it from them first.",
      ] as const;
      const UNAVAILABLE_AT_DELETE = [
        503,
        "fleets_unavailable",
        "Couldn't check whether a fleet uses this configuration, so nothing was deleted.",
      ] as const;

      /** A configuration of `author`'s with a published version. */
      function published(author: Actor) {
        const row = harness.configuration({ createdByUserId: author.context.userId });
        harness.version(row.id, PUBLISHED);
        return row;
      }

      function expectNothingDeleted(rowId: string) {
        expect(harness.rows.get(rowId)!.deleted).toBe(false);
        expect(harness.configurations.markDeleted).not.toHaveBeenCalled();
        expect(harness.auditEvents).toEqual([]);
        expect(harness.afterDeletes).toEqual([]);
      }

      it("asks after the rights' read, with no transaction open, then deletes in today's transaction when no fleet uses it", async () => {
        const author = harness.memberActor();
        const row = published(author);

        await harness.service.remove(author, harness.organizationId, row.id.toUpperCase());

        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "configurations.find",
          "fleetUsage",
          "organization.findActiveForShare",
          "members.find",
          "configurations.lockForUpdate",
          `configurations.markDeleted:${NOW.toISOString()}`,
          "audit:configuration.deleted",
        ]);
        expect(harness.fleetUsage.mock.calls).toEqual([[author.context, row.id]]);
        expect(harness.transactionsOpenAtUsage).toEqual([0]);
        expect(harness.afterDeletes).toEqual([[harness.organizationId, row.id]]);
        expect(harness.log.warn).not.toHaveBeenCalled();
        expect(harness.log.error).not.toHaveBeenCalled();
      });

      it("refuses 409 configuration_in_use when a collector group or a collector uses one, deleting nothing", async () => {
        const admin = harness.memberActor("admin");
        const row = published(harness.memberActor("contributor"));
        harness.fleetUsage.mockImplementationOnce(async (_context, configurationId) => ({
          kind: "found",
          usage: {
            configurationId,
            inUse: true,
            publications: [
              {
                id: randomUUID(),
                version: { number: 1, id: randomUUID(), label: null },
                publishedAt: PUBLISHED.publishedAt.toISOString(),
                groups: [{ fleetId: randomUUID(), groupId: randomUUID() }],
                pinnedCollectors: 0,
              },
            ],
          },
        }));

        await expectRefusal(harness.service.remove(admin, harness.organizationId, row.id), ...IN_USE);

        expectNothingDeleted(row.id);
        expect(harness.contexts).toHaveLength(1);
      });

      it("deletes when the opamp-server doesn't know the organization: it holds nothing of it", async () => {
        const author = harness.memberActor();
        const row = published(author);
        harness.fleetUsage.mockResolvedValueOnce({ kind: "organization_not_found" });

        await harness.service.remove(author, harness.organizationId, row.id);

        expect(harness.rows.get(row.id)!.deleted).toBe(true);
        expect(harness.afterDeletes).toEqual([[harness.organizationId, row.id]]);
        expect(harness.log.warn).not.toHaveBeenCalled();
      });

      it("refuses 429 rate_limited with its Retry-After when the person's fleet limit is spent, deleting nothing", async () => {
        const author = harness.memberActor();
        const row = published(author);
        harness.fleetUsage.mockResolvedValueOnce({ kind: "rate_limited", retryAfterSeconds: 7 });

        const refused = await refusal(harness.service.remove(author, harness.organizationId, row.id));

        expect(refused).toMatchObject({
          statusCode: 429,
          code: "rate_limited",
          message: "Too many attempts. Please wait and try again.",
          headers: { "retry-after": 7 },
        });
        expectNothingDeleted(row.id);
      });

      it.each([
        ["down", { kind: "unavailable", reason: "timeout" } as const, "warn", { result: "unavailable", reason: "timeout" }],
        ["a 5xx", { kind: "unavailable", reason: "server_error", status: 502 } as const, "warn", { result: "unavailable", reason: "server_error", status: 502 }],
        ["oversized", { kind: "unavailable", reason: "oversized_reply" } as const, "warn", { result: "unavailable", reason: "oversized_reply" }],
        [
          "a 413",
          { kind: "invalid", code: "payload_too_large" } as const,
          "error",
          { result: "invalid", code: "payload_too_large" },
        ],
      ])("refuses 503 fleets_unavailable with the delete's own words when it answers %s, logged with ids and the kind only", async (_label, answer, level, described) => {
        const author = harness.memberActor();
        const row = published(author);
        harness.fleetUsage.mockResolvedValueOnce(answer);

        await expectRefusal(harness.service.remove(author, harness.organizationId, row.id), ...UNAVAILABLE_AT_DELETE);

        expectNothingDeleted(row.id);
        const logged = harness.log[level as "warn" | "error"];
        expect(logged.mock.calls).toEqual([
          [{ operation: "getConfigurationUsage", organizationId: harness.organizationId, configurationId: row.id, ...described }, expect.any(String)],
        ]);
        expect(JSON.stringify(logged.mock.calls)).not.toContain("CANARY-MESSAGE");
        expect(JSON.stringify(logged.mock.calls)).not.toContain("Gateway");
      });

      it("refuses 503 for a misconfiguration (a 401, an answer the API doesn't document), logged at error with the client's message", async () => {
        const author = harness.memberActor();
        const row = published(author);
        harness.fleetUsage.mockRejectedValueOnce(
          new OpampServerMisconfigurationError("The opamp-server refused the management secret (401) for getConfigurationUsage."),
        );

        await expectRefusal(harness.service.remove(author, harness.organizationId, row.id), ...UNAVAILABLE_AT_DELETE);

        expectNothingDeleted(row.id);
        expect(harness.log.error.mock.calls).toEqual([
          [
            {
              operation: "getConfigurationUsage",
              organizationId: harness.organizationId,
              configurationId: row.id,
              error: "The opamp-server refused the management secret (401) for getConfigurationUsage.",
            },
            expect.any(String),
          ],
        ]);
      });

      it("refuses 503 for any other failure too, logged at error with its name only, deleting nothing", async () => {
        const author = harness.memberActor();
        const row = published(author);
        harness.fleetUsage.mockRejectedValueOnce(new RangeError("a plain failure quoting CANARY-MESSAGE"));

        await expectRefusal(harness.service.remove(author, harness.organizationId, row.id), ...UNAVAILABLE_AT_DELETE);

        expectNothingDeleted(row.id);
        expect(harness.log.error.mock.calls).toEqual([
          [
            { operation: "getConfigurationUsage", organizationId: harness.organizationId, configurationId: row.id, error: "RangeError" },
            "a configuration's delete couldn't check its fleet usage: asking the opamp-server failed",
          ],
        ]);
        expect(JSON.stringify(harness.log.error.mock.calls)).not.toContain("CANARY-MESSAGE");
      });

      it("asks nothing for one never published: no call, no limit spent", async () => {
        const author = harness.memberActor();
        const row = harness.configuration({ createdByUserId: author.context.userId });
        harness.version(row.id);

        await harness.service.remove(author, harness.organizationId, row.id);

        expect(harness.fleetUsage).not.toHaveBeenCalled();
        expect(harness.rows.get(row.id)!.deleted).toBe(true);
      });

      it("refuses an unknown, malformed or invisible one 404, and another organization's path 404, asking nothing", async () => {
        const author = harness.memberActor("admin");
        published(author);
        await expectRefusal(harness.service.remove(author, harness.organizationId, randomUUID()), ...CONFIGURATION_NOT_FOUND);
        for (const malformed of MALFORMED_IDS) {
          await expectRefusal(harness.service.remove(author, harness.organizationId, malformed), ...CONFIGURATION_NOT_FOUND);
        }
        await expectRefusal(harness.service.remove(author, randomUUID(), randomUUID()), ...ORGANIZATION_NOT_FOUND);
        expect(harness.fleetUsage).not.toHaveBeenCalled();
      });

      it("re-checks the rights under the locks: an admin demoted while the opamp-server answered is refused 403", async () => {
        const admin = harness.memberActor("admin");
        const row = published(harness.memberActor("contributor"));
        harness.fleetUsage.mockImplementationOnce(async (_context, configurationId) => {
          harness.people.get(admin.context.userId)!.role = "contributor";
          return { kind: "found", usage: { configurationId, inUse: false, publications: [] } };
        });

        await expectRefusal(harness.service.remove(admin, harness.organizationId, row.id), ...DELETE_FORBIDDEN);

        expectNothingDeleted(row.id);
        expect(harness.calls.slice(-3)).toEqual(["organization.findActiveForShare", "members.find", "configurations.lockForUpdate"]);
      });

      it("answers 404 when the configuration was deleted while the opamp-server answered", async () => {
        const author = harness.memberActor();
        const row = published(author);
        harness.fleetUsage.mockImplementationOnce(async (_context, configurationId) => {
          harness.rows.get(row.id)!.deleted = true;
          return { kind: "found", usage: { configurationId, inUse: false, publications: [] } };
        });

        await expectRefusal(harness.service.remove(author, harness.organizationId, row.id), ...CONFIGURATION_NOT_FOUND);
        expect(harness.afterDeletes).toEqual([]);
      });
    });

    describe("only its author or an organization admin", () => {
      it("lets its author delete it, whatever their role", async () => {
        const author = harness.memberActor("contributor");
        const row = harness.configuration({ createdByUserId: author.context.userId });
        await harness.service.remove(author, harness.organizationId, row.id);
        expect(harness.rows.get(row.id)!.deleted).toBe(true);
      });

      it("lets an admin delete another member's configuration", async () => {
        const author = harness.memberActor("contributor");
        const admin = harness.memberActor("admin");
        const row = harness.configuration({ createdByUserId: author.context.userId });
        await harness.service.remove(admin, harness.organizationId, row.id);
        expect(harness.rows.get(row.id)!.deleted).toBe(true);
        expect(harness.auditEvents).toEqual([expect.objectContaining({ actorUserId: admin.context.userId })]);
      });

      it("refuses another contributor with 403 configuration_delete_forbidden, in the first read, writing, auditing and asking nothing", async () => {
        const author = harness.memberActor("admin");
        const teammate = harness.memberActor("contributor");
        const row = harness.configuration({ createdByUserId: author.context.userId });
        // Published: still refused before any fleet is asked.
        harness.version(row.id, PUBLISHED);
        await expectRefusal(harness.service.remove(teammate, harness.organizationId, row.id), ...DELETE_FORBIDDEN);
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "configurations.find",
        ]);
        expect(harness.fleetUsage).not.toHaveBeenCalled();
        expect(harness.rows.get(row.id)!.deleted).toBe(false);
        expect(harness.auditEvents).toEqual([]);
      });

      it("lets only an admin delete one whose author's account is gone", async () => {
        const contributor = harness.memberActor("contributor");
        const admin = harness.memberActor("admin");
        const row = harness.configuration({ createdByUserId: null });
        await expectRefusal(harness.service.remove(contributor, harness.organizationId, row.id), ...DELETE_FORBIDDEN);
        await harness.service.remove(admin, harness.organizationId, row.id);
        expect(harness.rows.get(row.id)!.deleted).toBe(true);
      });

      it("takes the role from the membership re-read under the lock, not from the request", async () => {
        const author = harness.memberActor("contributor");
        const row = harness.configuration({ createdByUserId: author.context.userId });
        // Signed in as an admin, demoted since: the re-read says contributor.
        const demoted = harness.memberActor("admin");
        harness.people.get(demoted.context.userId)!.role = "contributor";
        await expectRefusal(harness.service.remove(demoted, harness.organizationId, row.id), ...DELETE_FORBIDDEN);
        // Promoted since signing in as a contributor: the re-read says admin.
        const promoted = harness.memberActor("contributor");
        harness.people.get(promoted.context.userId)!.role = "admin";
        await harness.service.remove(promoted, harness.organizationId, row.id);
        expect(harness.rows.get(row.id)!.deleted).toBe(true);
      });

      it("answers 404 configuration_not_found, not 403, for a configuration the caller can't see", async () => {
        const teammate = harness.memberActor("contributor");
        // The repository finds none for this caller: another member's draft,
        // as for an unknown id.
        await expectRefusal(
          harness.service.remove(teammate, harness.organizationId, randomUUID()),
          ...CONFIGURATION_NOT_FOUND,
        );
      });
    });
  });

  describe("saveVersion", () => {
    const YAML = "receivers:\r\n  otlp: {} # 🚀  \n";

    it("locks the configuration, saves the text exactly at the clock's time, touches the configuration, and audits the version without its YAML", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const saved = harness.version(row.id);

      const version = await harness.service.saveVersion(
        actor,
        harness.organizationId,
        row.id,
        saved.id,
        contentOf(YAML),
      );

      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        "versions.findSummary",
        `versions.save:${NOW.toISOString()}`,
        `configurations.touch:${NOW.toISOString()}`,
        "audit:configuration.version_saved",
      ]);
      // The text and the graph, together.
      expect(harness.versions.save).toHaveBeenCalledWith(row.id, saved.id, { yamlContent: YAML, ...GRAPH }, NOW);
      expect(version).toEqual({ ...saved, yamlContent: YAML, ...GRAPH, updatedAt: NOW });
      expect(harness.auditEvents).toEqual([
        {
          action: "configuration.version_saved",
          actorUserId: actor.context.userId,
          actorEmail: actor.email,
          organizationId: harness.organizationId,
          subjectType: "configuration",
          subjectId: row.id,
          metadata: { versionId: saved.id, versionNumber: 1 },
          ...origin,
        },
      ]);
      expect(JSON.stringify(harness.auditEvents)).not.toContain("otlp");
      expect(JSON.stringify(harness.auditEvents)).not.toContain("OTLP");
      expect(JSON.stringify(harness.auditEvents)).not.toContain("node_0");
    });

    it("writes even when the text is the one already there", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const saved = harness.version(row.id, { yamlContent: YAML });

      await harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, contentOf(YAML));

      expect(harness.versions.save).toHaveBeenCalledTimes(1);
      expect(harness.configurations.touch).toHaveBeenCalledTimes(1);
      expect(harness.auditEvents).toHaveLength(1);
    });

    it("refuses a published version with 409 configuration_version_published, under the lock and before any write", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration({ createdByUserId: actor.context.userId });
      const published = harness.version(row.id, PUBLISHED);
      await expectRefusal(
        harness.service.saveVersion(actor, harness.organizationId, row.id, published.id, contentOf("changed")),
        ...VERSION_PUBLISHED,
      );
      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        "versions.findSummary",
      ]);
      expect(harness.versionRows.get(published.id)!.yamlContent).toBe(published.yamlContent);
      expect(harness.auditEvents).toEqual([]);
    });

    it("saves a published configuration's draft version", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id, PUBLISHED);
      const draft = harness.version(row.id, { versionNumber: 2 });
      await harness.service.saveVersion(actor, harness.organizationId, row.id, draft.id, contentOf("saved"));
      expect(harness.versionRows.get(draft.id)!.yamlContent).toBe("saved");
    });

    it("lets any member save anyone's configuration: the last save wins", async () => {
      const first = harness.memberActor("admin");
      const second = harness.memberActor("contributor");
      const row = harness.configuration({ createdByUserId: first.context.userId });
      const saved = harness.version(row.id);

      await harness.service.saveVersion(first, harness.organizationId, row.id, saved.id, contentOf("first"));
      await harness.service.saveVersion(second, harness.organizationId, row.id, saved.id, contentOf("second"));

      expect(harness.versionRows.get(saved.id)!.yamlContent).toBe("second");
      expect(harness.auditEvents.map((event) => event.actorUserId)).toEqual([
        first.context.userId,
        second.context.userId,
      ]);
    });

    it("moves the version's updatedAt strictly forward when two saves read the same millisecond, the configuration's staying the clock's", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const saved = harness.version(row.id);

      const firstSave = await harness.service.saveVersion(
        actor,
        harness.organizationId,
        row.id,
        saved.id,
        contentOf("a"),
      );
      const secondSave = await harness.service.saveVersion(
        actor,
        harness.organizationId,
        row.id,
        saved.id,
        contentOf("b"),
      );

      expect(firstSave.updatedAt).toEqual(NOW);
      expect(secondSave.updatedAt).toEqual(new Date(NOW.getTime() + 1));
      expect(harness.versionRows.get(saved.id)!.updatedAt).toEqual(new Date(NOW.getTime() + 1));
      expect(harness.calls.filter((call) => call.startsWith("versions.save:"))).toEqual([
        `versions.save:${NOW.toISOString()}`,
        `versions.save:${new Date(NOW.getTime() + 1).toISOString()}`,
      ]);
      expect(harness.calls.filter((call) => call.startsWith("configurations.touch:"))).toEqual([
        `configurations.touch:${NOW.toISOString()}`,
        `configurations.touch:${NOW.toISOString()}`,
      ]);
    });

    it("moves a version saved past the clock a millisecond past its last save", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const ahead = new Date(NOW.getTime() + 5_000);
      const saved = harness.version(row.id, { updatedAt: ahead });

      const version = await harness.service.saveVersion(
        actor,
        harness.organizationId,
        row.id,
        saved.id,
        contentOf("a"),
      );

      expect(version.updatedAt).toEqual(new Date(ahead.getTime() + 1));
    });

    it("lowercases uppercased ids, which name the same rows", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const saved = harness.version(row.id);
      await harness.service.saveVersion(
        actor,
        harness.organizationId,
        row.id.toUpperCase(),
        saved.id.toUpperCase(),
        contentOf("x"),
      );
      expect(harness.configurations.lockForUpdate).toHaveBeenCalledWith(row.id);
      expect(harness.versions.save).toHaveBeenCalledWith(row.id, saved.id, contentOf("x"), NOW);
    });

    it.each(["42", "not-a-uuid", "0192f1a47b3c7d2e8f101a2b3c4d5e6f"])(
      "refuses a version id that isn't a canonical UUID (%s) with 404 configuration_not_found, after the configuration's lock and without a write",
      async (versionId) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        harness.version(row.id);
        await expectRefusal(
          harness.service.saveVersion(actor, harness.organizationId, row.id, versionId, contentOf("x")),
          ...CONFIGURATION_NOT_FOUND,
        );
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "configurations.lockForUpdate",
        ]);
        expect(harness.auditEvents).toEqual([]);
      },
    );

    it("refuses an unknown version, and one of another configuration, with 404 configuration_not_found, touching and auditing nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      const other = harness.configuration();
      const othersVersion = harness.version(other.id);

      for (const versionId of [randomUUID(), othersVersion.id]) {
        await expectRefusal(
          harness.service.saveVersion(actor, harness.organizationId, row.id, versionId, contentOf("x")),
          ...CONFIGURATION_NOT_FOUND,
        );
      }
      expect(harness.versionRows.get(othersVersion.id)!.yamlContent).toBe("receivers: {}\n");
      expect(harness.configurations.touch).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });

    it("passes the text and the graph alone to the repository, whatever else the content carries", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const saved = harness.version(row.id);
      const content = { ...contentOf("x"), versionNumber: 9 };

      await harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, content);

      expect(harness.versions.save).toHaveBeenCalledWith(row.id, saved.id, contentOf("x"), NOW);
    });

    it("lets a graph check's 23514 through for the route to answer, touching and auditing nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const saved = harness.version(row.id);
      const violation = Object.assign(new Error("new row violates check constraint"), {
        code: "23514",
        constraint: "ck_configuration_versions_nodes_size",
      });
      harness.versions.save.mockRejectedValueOnce(violation);

      await expect(
        harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, contentOf("x")),
      ).rejects.toBe(violation);
      expect(harness.configurations.touch).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });
  });

  describe("getVersion", () => {
    it("reads the configuration, that version and the list, with no lock, no membership read and no selection", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const first = harness.version(row.id, { versionNumber: 1 });
      const second = harness.version(row.id, { versionNumber: 2 });

      const found = await harness.service.getVersion(actor, harness.organizationId, row.id, first.id);

      expect(found).toEqual({
        configuration: expect.objectContaining({ id: row.id }),
        version: first,
        versions: [summaryOf(second), summaryOf(first)],
      });
      expect(harness.calls).toEqual(["configurations.find", "versions.find", "versions.listSummaries"]);
      expect(harness.auditEvents).toEqual([]);
      expect(harness.selectionRows.size).toBe(0);
    });

    it("reads each version", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const first = harness.version(row.id, { versionNumber: 1 });
      const second = harness.version(row.id, { versionNumber: 2 });
      for (const version of [first, second]) {
        expect((await harness.service.getVersion(actor, harness.organizationId, row.id, version.id)).version).toEqual(
          version,
        );
      }
    });

    it("lowercases uppercased ids, which name the same rows", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const version = harness.version(row.id);
      await harness.service.getVersion(actor, harness.organizationId, row.id.toUpperCase(), version.id.toUpperCase());
      expect(harness.versions.find).toHaveBeenCalledWith(row.id, version.id);
    });

    it("refuses an unknown version, and one of another configuration, with 404 configuration_version_not_found", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      const other = harness.configuration();
      const othersVersion = harness.version(other.id);
      for (const versionId of [randomUUID(), othersVersion.id]) {
        await expectRefusal(
          harness.service.getVersion(actor, harness.organizationId, row.id, versionId),
          ...VERSION_NOT_FOUND,
        );
      }
      expect(harness.versions.listSummaries).not.toHaveBeenCalled();
    });

    it.each(MALFORMED_IDS)(
      "refuses a version id that isn't a canonical UUID (%s) with 404 configuration_version_not_found, without a lookup",
      async (versionId) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        harness.version(row.id);
        await expectRefusal(
          harness.service.getVersion(actor, harness.organizationId, row.id, versionId),
          ...VERSION_NOT_FOUND,
        );
        expect(harness.calls).toEqual(["configurations.find"]);
      },
    );

    it("refuses a deleted, unknown or malformed configuration with 404 configuration_not_found, whatever the version", async () => {
      const actor = harness.memberActor();
      const deleted = harness.configuration();
      const deletedVersion = harness.version(deleted.id);
      harness.rows.get(deleted.id)!.deleted = true;
      for (const [id, versionId] of [
        [deleted.id, deletedVersion.id],
        [deleted.id, "42"],
        [randomUUID(), randomUUID()],
        ["42", deletedVersion.id],
      ] as const) {
        await expectRefusal(
          harness.service.getVersion(actor, harness.organizationId, id, versionId),
          ...CONFIGURATION_NOT_FOUND,
        );
      }
      expect(harness.versions.find).not.toHaveBeenCalled();
    });
  });

  describe("createVersion", () => {
    const YAML = "receivers:\r\n  otlp: {} # 🚀  \n";

    it("locks the configuration, checks the source, creates the next version at the clock's time, touches the configuration, and audits it without its YAML, graph or label", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      // Pinned to another version than the catalog's default: the new one copies the source's.
      const source = harness.version(row.id, { versionNumber: 1, yamlContent: "saved: true\n", collectorVersion: "1.1.0" });
      harness.version(row.id, { versionNumber: 4 });

      const created = await harness.service.createVersion(actor, harness.organizationId, row.id, {
        sourceVersionId: source.id,
        label: "Private-label",
        ...contentOf(YAML),
      });

      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        "versions.findSummary",
        `versions.createNext:${NOW.toISOString()}`,
        `configurations.touch:${NOW.toISOString()}`,
        `suites.copyToVersion:${NOW.toISOString()}`,
        `validationPipelines.copyToVersion:${NOW.toISOString()}`,
        "audit:configuration.version_created",
      ]);
      // The source's suites, copied to the new version as the caller, at its
      // time, then its validation pipelines and rules likewise.
      expect(harness.suites.copyToVersion).toHaveBeenCalledWith(row.id, source.id, created.id, NOW);
      expect(harness.validationPipelines.copyToVersion).toHaveBeenCalledWith(row.id, source.id, created.id, NOW);
      // The source's summary: its content isn't read.
      expect(harness.versions.findSummary).toHaveBeenCalledWith(row.id, source.id);
      expect(harness.versions.find).not.toHaveBeenCalled();
      expect(harness.versions.createNext).toHaveBeenCalledWith({
        configurationId: row.id,
        label: "Private-label",
        yamlContent: YAML,
        ...GRAPH,
        createdByUserId: actor.context.userId,
        collectorDistribution: CATALOGUE_DEFAULTS.distribution,
        collectorVersion: "1.1.0",
        at: NOW,
      });
      expect(created).toEqual({
        id: expect.any(String),
        configurationId: row.id,
        versionNumber: 5,
        label: "Private-label",
        createdBy: { userId: actor.context.userId, email: actor.email },
        yamlContent: YAML,
        ...GRAPH,
        createdAt: NOW,
        updatedAt: NOW,
        publishedAt: null,
        publishedBy: null,
        collectorDistribution: CATALOGUE_DEFAULTS.distribution,
        collectorVersion: "1.1.0",
        collectorVersionDeprecated: false,
        collectorVersionDeprecatedNote: null,
      });
      // The source is left as it was saved.
      expect(harness.versionRows.get(source.id)).toEqual(source);
      expect(harness.rows.get(row.id)!.updatedAt).toEqual(NOW);
      expect(harness.auditEvents).toEqual([
        {
          action: "configuration.version_created",
          actorUserId: actor.context.userId,
          actorEmail: actor.email,
          organizationId: harness.organizationId,
          subjectType: "configuration",
          subjectId: row.id,
          // The copies' counts: never a suite's, a definition's or a rule's text.
          metadata: {
            versionId: created.id,
            versionNumber: 5,
            sourceVersionId: source.id,
            copiedSuites: 2,
            copiedDefinitions: 5,
            copiedValidationPipelines: 3,
            copiedValidationRules: 7,
          },
          ...origin,
        },
      ]);
      const audited = JSON.stringify(harness.auditEvents);
      for (const secret of ["otlp", "OTLP", "node_0", "pipeline_0", "Private-label", YAML]) {
        expect(audited).not.toContain(secret);
      }
    });

    it("creates an unnamed version when no label is given", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const source = harness.version(row.id);
      const created = await harness.service.createVersion(actor, harness.organizationId, row.id, {
        sourceVersionId: source.id,
        ...contentOf(""),
      });
      expect(created).toMatchObject({ versionNumber: 2, label: null, yamlContent: "" });
      expect(harness.versions.createNext).toHaveBeenCalledWith(expect.objectContaining({ label: null }));
    });

    it("lowercases uppercased ids, which name the same rows", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const source = harness.version(row.id);
      await harness.service.createVersion(actor, harness.organizationId, row.id.toUpperCase(), {
        sourceVersionId: source.id.toUpperCase(),
        ...contentOf("x"),
      });
      expect(harness.configurations.lockForUpdate).toHaveBeenCalledWith(row.id);
      expect(harness.versions.findSummary).toHaveBeenCalledWith(row.id, source.id);
      expect(harness.auditEvents[0]!.metadata).toMatchObject({ sourceVersionId: source.id });
    });

    it("refuses an unknown source, and one of another configuration, with 404 configuration_version_not_found, writing nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      const other = harness.configuration();
      const othersVersion = harness.version(other.id);
      for (const sourceVersionId of [randomUUID(), othersVersion.id]) {
        await expectRefusal(
          harness.service.createVersion(actor, harness.organizationId, row.id, { sourceVersionId, ...contentOf("x") }),
          ...VERSION_NOT_FOUND,
        );
      }
      expect(harness.versions.createNext).not.toHaveBeenCalled();
      expect(harness.configurations.touch).not.toHaveBeenCalled();
      expect(harness.suites.copyToVersion).not.toHaveBeenCalled();
      expect(harness.validationPipelines.copyToVersion).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
      expect(harness.versionRows.size).toBe(2);
    });

    it.each(MALFORMED_IDS)(
      "refuses a source that isn't a canonical UUID (%s) with 404 configuration_version_not_found, after the configuration's lock and writing nothing",
      async (sourceVersionId) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        harness.version(row.id);
        await expectRefusal(
          harness.service.createVersion(actor, harness.organizationId, row.id, { sourceVersionId, ...contentOf("x") }),
          ...VERSION_NOT_FOUND,
        );
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "configurations.lockForUpdate",
        ]);
        expect(harness.versionRows.size).toBe(1);
      },
    );

    it("lets a graph check's 23514 through for the route to answer, touching and auditing nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const source = harness.version(row.id);
      const violation = Object.assign(new Error("new row violates check constraint"), {
        code: "23514",
        constraint: "ck_configuration_versions_nodes_size",
      });
      harness.versions.createNext.mockRejectedValueOnce(violation);

      await expect(
        harness.service.createVersion(actor, harness.organizationId, row.id, {
          sourceVersionId: source.id,
          ...contentOf("x"),
        }),
      ).rejects.toBe(violation);
      expect(harness.configurations.touch).not.toHaveBeenCalled();
      expect(harness.suites.copyToVersion).not.toHaveBeenCalled();
      expect(harness.validationPipelines.copyToVersion).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });

    it("lets a failed suites' copy through, auditing nothing: the transaction rolls the version back with it", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const source = harness.version(row.id);
      const failure = new Error("the copy failed");
      harness.suites.copyToVersion.mockRejectedValueOnce(failure);

      await expect(
        harness.service.createVersion(actor, harness.organizationId, row.id, { sourceVersionId: source.id, ...contentOf("x") }),
      ).rejects.toBe(failure);
      expect(harness.validationPipelines.copyToVersion).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });

    it("lets a failed validation pipelines' copy through, auditing nothing: the transaction rolls the version and the suites' copy back with it", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const source = harness.version(row.id);
      const failure = new Error("the copy failed");
      harness.validationPipelines.copyToVersion.mockRejectedValueOnce(failure);

      await expect(
        harness.service.createVersion(actor, harness.organizationId, row.id, { sourceVersionId: source.id, ...contentOf("x") }),
      ).rejects.toBe(failure);
      expect(harness.suites.copyToVersion).toHaveBeenCalledTimes(1);
      expect(harness.auditEvents).toEqual([]);
    });
  });

  describe("the public API's version writes", () => {
    it("patchVersion merges the text over the stored content under the lock, keeping the stored graph and pin", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const stored = harness.version(row.id, { yamlContent: "stored: 1\n", ...GRAPH });

      const version = await harness.service.patchVersion(actor, harness.organizationId, row.id, stored.id, {
        yamlContent: "patched: 1\n",
      });

      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        "versions.find",
        `versions.save:${NOW.toISOString()}`,
        `configurations.touch:${NOW.toISOString()}`,
        "audit:configuration.version_saved",
      ]);
      expect(harness.versions.save).toHaveBeenCalledWith(row.id, stored.id, { yamlContent: "patched: 1\n", ...GRAPH }, NOW);
      expect(version).toMatchObject({ yamlContent: "patched: 1\n", ...GRAPH, collectorVersion: CATALOGUE_DEFAULTS.version });
    });

    it("patchVersion with only a pin keeps the stored text; with neither writes and audits nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const stored = harness.version(row.id, { yamlContent: "stored: 1\n", ...GRAPH });

      await harness.service.patchVersion(actor, harness.organizationId, row.id, stored.id, { collectorVersion: OFFERED_VERSION });
      expect(harness.versions.save).toHaveBeenCalledWith(
        row.id,
        stored.id,
        { yamlContent: "stored: 1\n", ...GRAPH, collectorVersion: OFFERED_VERSION },
        NOW,
      );

      harness.versions.save.mockClear();
      harness.auditEvents.length = 0;
      const unchanged = await harness.service.patchVersion(actor, harness.organizationId, row.id, stored.id, {});
      expect(unchanged).toMatchObject({ yamlContent: "stored: 1\n", collectorVersion: OFFERED_VERSION });
      expect(harness.versions.save).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });

    it("patchVersion refuses a published version with 409, even with nothing to change, before any write", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration({ createdByUserId: actor.context.userId });
      const published = harness.version(row.id, PUBLISHED);
      for (const change of [{ yamlContent: "changed" }, {}]) {
        await expectRefusal(
          harness.service.patchVersion(actor, harness.organizationId, row.id, published.id, change),
          ...VERSION_PUBLISHED,
        );
      }
      expect(harness.versions.save).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });

    it("patchVersion with expectedUpdatedAt writes only over that save: a save since is 409 configuration_version_changed, nothing written", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const stored = harness.version(row.id, { yamlContent: "stored: 1\n", updatedAt: EARLIER });
      for (const change of [{ yamlContent: "patched: 1\n" }, {}]) {
        await expectRefusal(
          harness.service.patchVersion(actor, harness.organizationId, row.id, stored.id, {
            ...change,
            expectedUpdatedAt: new Date(EARLIER.getTime() - 1),
          }),
          409,
          "configuration_version_changed",
          "This version changed while it was being validated. Nothing was saved. Try again.",
        );
      }
      expect(harness.versions.save).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);

      await harness.service.patchVersion(actor, harness.organizationId, row.id, stored.id, {
        yamlContent: "patched: 1\n",
        expectedUpdatedAt: new Date(EARLIER.getTime()),
      });
      expect(harness.versions.save).toHaveBeenCalledTimes(1);
    });

    it("appendVersion creates the next version from the latest, read under the lock: its pin, an empty graph, the label given", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      const latest = harness.version(row.id, { versionNumber: 2, collectorVersion: OFFERED_VERSION });

      const version = await harness.service.appendVersion(actor, harness.organizationId, row.id, {
        yamlContent: "appended: 1\n",
        label: "Third",
      });

      expect(harness.calls.slice(0, 5)).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        "versions.listSummaries",
        `versions.createNext:${NOW.toISOString()}`,
      ]);
      expect(version).toMatchObject({
        versionNumber: 3,
        label: "Third",
        yamlContent: "appended: 1\n",
        nodes: [],
        edges: [],
        pipelines: [],
        collectorVersion: OFFERED_VERSION,
      });
      expect(harness.auditEvents.at(-1)?.metadata).toMatchObject({ sourceVersionId: latest.id, versionNumber: 3 });
    });

    it("versionIdOf finds a version by its number: 404 configuration_not_found first, then configuration_version_not_found", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const second = harness.version(row.id, { versionNumber: 2 });
      expect(await harness.service.versionIdOf(actor, harness.organizationId, row.id, 2)).toBe(second.id);
      await expectRefusal(harness.service.versionIdOf(actor, harness.organizationId, row.id, 3), ...VERSION_NOT_FOUND);
      await expectRefusal(harness.service.versionIdOf(actor, harness.organizationId, "not-a-uuid", 2), ...CONFIGURATION_NOT_FOUND);
      await expectRefusal(harness.service.versionIdOf(actor, harness.organizationId, randomUUID(), 2), ...CONFIGURATION_NOT_FOUND);
    });
  });

  describe("renameVersion", () => {
    it("locks the configuration, sets the label, and audits from and to, moving no updatedAt", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const version = harness.version(row.id, { versionNumber: 3, label: "Old" });

      const renamed = await harness.service.renameVersion(actor, harness.organizationId, row.id, version.id, "New");

      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        "versions.findSummary",
        "versions.rename:New",
        "audit:configuration.version_renamed",
      ]);
      // The old label from the version's summary: its content isn't read.
      expect(harness.versions.findSummary).toHaveBeenCalledWith(row.id, version.id);
      expect(harness.versions.find).not.toHaveBeenCalled();
      expect(harness.versions.rename).toHaveBeenCalledWith(row.id, version.id, "New");
      expect(renamed).toEqual({ ...summaryOf(version), label: "New" });
      expect(renamed.updatedAt).toEqual(EARLIER);
      expect(harness.configurations.touch).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([
        {
          action: "configuration.version_renamed",
          actorUserId: actor.context.userId,
          actorEmail: actor.email,
          organizationId: harness.organizationId,
          subjectType: "configuration",
          subjectId: row.id,
          metadata: { versionId: version.id, versionNumber: 3, from: "Old", to: "New" },
          ...origin,
        },
      ]);
    });

    it("audits from null when the version was unnamed", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const version = harness.version(row.id);
      await harness.service.renameVersion(actor, harness.organizationId, row.id, version.id, "Named");
      expect(harness.auditEvents[0]!.metadata).toEqual({
        versionId: version.id,
        versionNumber: 1,
        from: null,
        to: "Named",
      });
    });

    it("refuses a published version with 409 configuration_version_published, under the lock and before any write, even with its own label", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const published = harness.version(row.id, { ...PUBLISHED, label: "Released" });
      for (const label of ["Renamed", "Released"]) {
        await expectRefusal(
          harness.service.renameVersion(actor, harness.organizationId, row.id, published.id, label),
          ...VERSION_PUBLISHED,
        );
      }
      expect(harness.versions.rename).not.toHaveBeenCalled();
      expect(harness.versionRows.get(published.id)!.label).toBe("Released");
      expect(harness.auditEvents).toEqual([]);
    });

    it("answers the same label with the summary as it is: no write, no audit", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const version = harness.version(row.id, { label: "Same" });

      const unchanged = await harness.service.renameVersion(actor, harness.organizationId, row.id, version.id, "Same");

      // toEqual: the summary alone, no content key.
      expect(unchanged).toEqual(summaryOf(version));
      expect(harness.versions.find).not.toHaveBeenCalled();
      expect(harness.versions.rename).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });

    it("refuses an unknown version, and one of another configuration, with 404 configuration_version_not_found, writing nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      const other = harness.configuration();
      const othersVersion = harness.version(other.id, { label: "Theirs" });
      for (const versionId of [randomUUID(), othersVersion.id]) {
        await expectRefusal(
          harness.service.renameVersion(actor, harness.organizationId, row.id, versionId, "Sneaky"),
          ...VERSION_NOT_FOUND,
        );
      }
      expect(harness.versions.rename).not.toHaveBeenCalled();
      expect(harness.versionRows.get(othersVersion.id)!.label).toBe("Theirs");
      expect(harness.auditEvents).toEqual([]);
    });

    it.each(MALFORMED_IDS)(
      "refuses a version id that isn't a canonical UUID (%s) with 404 configuration_version_not_found, after the configuration's lock",
      async (versionId) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        harness.version(row.id);
        await expectRefusal(
          harness.service.renameVersion(actor, harness.organizationId, row.id, versionId, "X"),
          ...VERSION_NOT_FOUND,
        );
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "configurations.lockForUpdate",
        ]);
      },
    );
  });

  describe("selectVersion", () => {
    it("locks the configuration and records the caller's selection at the clock's time, auditing nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const version = harness.version(row.id);

      await harness.service.selectVersion(actor, harness.organizationId, row.id, version.id);

      expect(harness.calls).toEqual([
        "organization.findActiveForShare",
        "members.find",
        "configurations.lockForUpdate",
        `selections.record:${NOW.toISOString()}`,
      ]);
      expect(harness.selections.record).toHaveBeenCalledWith(actor.context.userId, row.id, version.id, NOW);
      expect(harness.auditEvents).toEqual([]);
    });

    it("makes get open the selected version for the caller alone", async () => {
      const actor = harness.memberActor();
      const other = harness.memberActor();
      const row = harness.configuration();
      const first = harness.version(row.id, { versionNumber: 1 });
      const second = harness.version(row.id, { versionNumber: 2 });

      await harness.service.selectVersion(actor, harness.organizationId, row.id, first.id);

      expect((await harness.service.get(actor, harness.organizationId, row.id)).version).toEqual(first);
      expect((await harness.service.get(other, harness.organizationId, row.id)).version).toEqual(second);
    });

    it("lowercases uppercased ids, which name the same rows", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      const version = harness.version(row.id);
      await harness.service.selectVersion(actor, harness.organizationId, row.id.toUpperCase(), version.id.toUpperCase());
      expect(harness.selections.record).toHaveBeenCalledWith(actor.context.userId, row.id, version.id, NOW);
    });

    it("refuses an unknown version, and one of another configuration, with 404 configuration_version_not_found, recording nothing", async () => {
      const actor = harness.memberActor();
      const row = harness.configuration();
      harness.version(row.id);
      const other = harness.configuration();
      const othersVersion = harness.version(other.id);
      for (const versionId of [randomUUID(), othersVersion.id]) {
        await expectRefusal(
          harness.service.selectVersion(actor, harness.organizationId, row.id, versionId),
          ...VERSION_NOT_FOUND,
        );
      }
      expect(harness.selectionRows.size).toBe(0);
    });

    it.each(MALFORMED_IDS)(
      "refuses a version id that isn't a canonical UUID (%s) with 404 configuration_version_not_found, recording nothing",
      async (versionId) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        harness.version(row.id);
        await expectRefusal(
          harness.service.selectVersion(actor, harness.organizationId, row.id, versionId),
          ...VERSION_NOT_FOUND,
        );
        expect(harness.selections.record).not.toHaveBeenCalled();
        expect(harness.selectionRows.size).toBe(0);
      },
    );
  });

  describe.each([
    ["update", (h: Harness, actor: Actor, id: string) => h.service.update(actor, h.organizationId, id, { name: "X" })],
    ["remove", (h: Harness, actor: Actor, id: string) => h.service.remove(actor, h.organizationId, id)],
    [
      "saveVersion",
      (h: Harness, actor: Actor, id: string) =>
        h.service.saveVersion(actor, h.organizationId, id, randomUUID(), contentOf("x")),
    ],
    [
      "createVersion",
      (h: Harness, actor: Actor, id: string) =>
        h.service.createVersion(actor, h.organizationId, id, { sourceVersionId: randomUUID(), ...contentOf("x") }),
    ],
    [
      "renameVersion",
      (h: Harness, actor: Actor, id: string) => h.service.renameVersion(actor, h.organizationId, id, randomUUID(), "X"),
    ],
    [
      "selectVersion",
      (h: Harness, actor: Actor, id: string) => h.service.selectVersion(actor, h.organizationId, id, randomUUID()),
    ],
  ] as const)("%s refuses with 404 configuration_not_found", (_name, write) => {
    it.each(["42", "not-a-uuid", "0192f1a47b3c7d2e8f101a2b3c4d5e6f", "{0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f}"])(
      "an id that isn't a canonical UUID (%s), after the organization's checks and without a lookup",
      async (id) => {
        const actor = harness.memberActor();
        await expectRefusal(write(harness, actor, id), ...CONFIGURATION_NOT_FOUND);
        expect(harness.calls).toEqual(["organization.findActiveForShare", "members.find"]);
      },
    );

    it("a configuration that is missing, deleted or another organization's, writing nothing", async () => {
      const actor = harness.memberActor();
      const deleted = harness.configuration();
      harness.rows.get(deleted.id)!.deleted = true;
      for (const id of [randomUUID(), deleted.id]) {
        await expectRefusal(write(harness, actor, id), ...CONFIGURATION_NOT_FOUND);
      }
      expect(harness.configurations.update).not.toHaveBeenCalled();
      expect(harness.configurations.markDeleted).not.toHaveBeenCalled();
      expect(harness.versions.save).not.toHaveBeenCalled();
      expect(harness.versions.createNext).not.toHaveBeenCalled();
      expect(harness.versions.rename).not.toHaveBeenCalled();
      expect(harness.selections.record).not.toHaveBeenCalled();
      expect(harness.configurations.touch).not.toHaveBeenCalled();
      expect(harness.auditEvents).toEqual([]);
    });

    it("but a removed caller still gets organization_not_found first, for any id", async () => {
      const actor = harness.memberActor();
      harness.people.delete(actor.context.userId);
      await expectRefusal(write(harness, actor, "42"), ...ORGANIZATION_NOT_FOUND);
    });
  });

  describe("collector distributions and versions", () => {
    const VERSION_UNKNOWN = [400, "collector_version_unknown", "That collector version isn't available."] as const;
    const DISTRIBUTION_UNKNOWN = [
      400,
      "collector_distribution_unknown",
      "That collector distribution isn't available.",
    ] as const;

    describe("create, for a named distribution", () => {
      it("builds the configuration for the distribution named, its version 1 at that distribution's default, read in the transaction", async () => {
        const actor = harness.memberActor();

        const created = await harness.service.create(actor, harness.organizationId, {
          name: "Gateway",
          description: "",
          collectorDistribution: OTHER_DISTRIBUTION.distribution,
        });

        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          `catalogue.findDistributionDefault:${OTHER_DISTRIBUTION.distribution}`,
          "configurations.create",
          "versions.create",
          "audit:configuration.created",
        ]);
        expect(created.collectorDistribution).toBe(OTHER_DISTRIBUTION.distribution);
        expect(harness.versions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            collectorDistribution: OTHER_DISTRIBUTION.distribution,
            collectorVersion: OTHER_DISTRIBUTION.version,
          }),
        );
      });

      it("refuses a distribution the catalog doesn't offer with collector_distribution_unknown, after the membership's checks, writing nothing", async () => {
        const actor = harness.memberActor();

        await expectRefusal(
          harness.service.create(actor, harness.organizationId, { name: "Gateway", description: "", collectorDistribution: "clickstack" }),
          ...DISTRIBUTION_UNKNOWN,
        );
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "catalogue.findDistributionDefault:clickstack",
        ]);
        expect(harness.auditEvents).toEqual([]);
      });

      it("answers organization_not_found before it reads the catalog", async () => {
        const actor = harness.memberActor();
        harness.state.isOrganizationLive = false;
        await expectRefusal(
          harness.service.create(actor, harness.organizationId, { name: "Gateway", description: "", collectorDistribution: "clickstack" }),
          ...ORGANIZATION_NOT_FOUND,
        );
        expect(harness.calls).toEqual(["organization.findActiveForShare"]);
      });
    });

    describe("create from a flow", () => {
      /** A flow's text, exactly as the seed holds one: an env reference, a trailing newline. */
      const FLOW_YAML = "exporters:\n  otlp:\n    endpoint: ${env:OTLP_ENDPOINT}\n";
      const fromFlow = {
        name: "PII Redaction Gateway",
        description: "",
        content: contentOf(FLOW_YAML),
        sourceFlowSlug: "pii-redaction-gateway",
      };

      it("writes the content exactly as given to version 1, the slug to the configuration, and audits only the name", async () => {
        const actor = harness.memberActor();

        const created = await harness.service.create(actor, harness.organizationId, fromFlow);

        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "catalogue.findDefaults",
          "configurations.create",
          "versions.create",
          "audit:configuration.created",
        ]);
        expect(harness.configurations.create).toHaveBeenCalledWith({
          name: "PII Redaction Gateway",
          description: "",
          createdByUserId: actor.context.userId,
          collectorDistribution: CATALOGUE_DEFAULTS.distribution,
          sourceFlowSlug: "pii-redaction-gateway",
          at: NOW,
        });
        expect(harness.versions.create).toHaveBeenCalledWith({
          configurationId: created.id,
          versionNumber: 1,
          yamlContent: FLOW_YAML,
          graph: GRAPH,
          createdByUserId: actor.context.userId,
          collectorDistribution: CATALOGUE_DEFAULTS.distribution,
          collectorVersion: CATALOGUE_DEFAULTS.version,
          at: NOW,
        });
        // The very arrays given: nothing copied, filtered or reordered.
        const written = harness.versions.create.mock.calls[0]![0];
        expect(written.yamlContent).toBe(FLOW_YAML);
        expect(written.graph?.nodes).toBe(GRAPH.nodes);
        expect(written.graph?.edges).toBe(GRAPH.edges);
        expect(written.graph?.pipelines).toBe(GRAPH.pipelines);
        expect(harness.auditEvents.map((event) => event.metadata)).toEqual([{ name: "PII Redaction Gateway" }]);
      });

      it("names neither a graph nor a slug when they aren't given: today's writes", async () => {
        const actor = harness.memberActor();

        await harness.service.create(actor, harness.organizationId, { name: "Gateway", description: "" });

        expect(harness.configurations.create.mock.calls[0]![0]).not.toHaveProperty("sourceFlowSlug");
        expect(harness.versions.create.mock.calls[0]![0]).not.toHaveProperty("graph");
        expect(harness.versions.create.mock.calls[0]![0].yamlContent).toBe("");
      });

      it("pins version 1 to a collector version the default distribution offers, checked after the distribution's read", async () => {
        const actor = harness.memberActor();

        await harness.service.create(actor, harness.organizationId, { ...fromFlow, collectorVersion: OFFERED_VERSION });

        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "catalogue.findDefaults",
          `catalogue.isOffered:${CATALOGUE_DEFAULTS.distribution}@${OFFERED_VERSION}`,
          "configurations.create",
          "versions.create",
          "audit:configuration.created",
        ]);
        expect(harness.versions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            collectorDistribution: CATALOGUE_DEFAULTS.distribution,
            collectorVersion: OFFERED_VERSION,
          }),
        );
      });

      it("checks the collector version against the distribution named, not the default", async () => {
        const actor = harness.memberActor();
        const named = { ...fromFlow, collectorDistribution: OTHER_DISTRIBUTION.distribution };

        // The default distribution's offered version isn't the other distribution's.
        await expectRefusal(
          harness.service.create(actor, harness.organizationId, { ...named, collectorVersion: OFFERED_VERSION }),
          ...VERSION_UNKNOWN,
        );
        expect(harness.calls).toContain(`catalogue.isOffered:${OTHER_DISTRIBUTION.distribution}@${OFFERED_VERSION}`);
      });

      it("takes the distribution's default given again without asking the catalog whether it is offered", async () => {
        const actor = harness.memberActor();

        await harness.service.create(actor, harness.organizationId, {
          ...fromFlow,
          collectorVersion: CATALOGUE_DEFAULTS.version,
        });

        expect(harness.calls.filter((call) => call.startsWith("catalogue.isOffered"))).toEqual([]);
        expect(harness.versions.create).toHaveBeenCalledWith(
          expect.objectContaining({ collectorVersion: CATALOGUE_DEFAULTS.version }),
        );
      });

      it.each([
        ["a deprecated version", DEPRECATED_VERSION],
        ["a version the catalogue doesn't have", "9.9.9"],
        ["another distribution's version", OTHER_DISTRIBUTION.version],
      ])("refuses %s with collector_version_unknown, before anything is written", async (_label, collectorVersion) => {
        const actor = harness.memberActor();

        await expectRefusal(
          harness.service.create(actor, harness.organizationId, { ...fromFlow, collectorVersion }),
          ...VERSION_UNKNOWN,
        );
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "catalogue.findDefaults",
          `catalogue.isOffered:${CATALOGUE_DEFAULTS.distribution}@${collectorVersion}`,
        ]);
        expect(harness.auditEvents).toEqual([]);
      });

      it("refuses an unknown distribution first: collector_distribution_unknown, the version never asked about", async () => {
        const actor = harness.memberActor();

        await expectRefusal(
          harness.service.create(actor, harness.organizationId, {
            ...fromFlow,
            collectorDistribution: "clickstack",
            collectorVersion: "2.36.0",
          }),
          ...DISTRIBUTION_UNKNOWN,
        );
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "catalogue.findDistributionDefault:clickstack",
        ]);
      });

      it("lets a graph check's 23514 through for the route to answer, auditing nothing", async () => {
        const actor = harness.memberActor();
        const violation = Object.assign(new Error("check"), { code: "23514" });
        harness.versions.create.mockRejectedValueOnce(violation);

        await expect(harness.service.create(actor, harness.organizationId, fromFlow)).rejects.toBe(violation);
        expect(harness.auditEvents).toEqual([]);
      });
    });

    describe("saveVersion's collector version", () => {
      it("stores a collector version the configuration's distribution offers, as an ordinary save: the lock, the updatedAt moved strictly forward, the configuration touched, the audit", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const saved = harness.version(row.id, { updatedAt: NOW });

        const version = await harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, {
          ...contentOf(saved.yamlContent),
          collectorVersion: OFFERED_VERSION,
        });

        const savedAt = new Date(NOW.getTime() + 1);
        expect(harness.calls).toEqual([
          "organization.findActiveForShare",
          "members.find",
          "configurations.lockForUpdate",
          "versions.findSummary",
          `catalogue.isOffered:${CATALOGUE_DEFAULTS.distribution}@${OFFERED_VERSION}`,
          `versions.save:${savedAt.toISOString()}`,
          `configurations.touch:${NOW.toISOString()}`,
          "audit:configuration.version_saved",
        ]);
        expect(harness.versions.save).toHaveBeenCalledWith(
          row.id,
          saved.id,
          { ...contentOf(saved.yamlContent), collectorVersion: OFFERED_VERSION },
          savedAt,
        );
        expect(version).toMatchObject({ collectorVersion: OFFERED_VERSION, updatedAt: savedAt });
      });

      it("checks a change against the configuration's distribution", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration({ collectorDistribution: OTHER_DISTRIBUTION.distribution });
        const saved = harness.version(row.id, {
          collectorDistribution: OTHER_DISTRIBUTION.distribution,
          collectorVersion: OTHER_DISTRIBUTION.version,
        });

        // The default distribution's version: not one this configuration's distribution offers.
        await expectRefusal(
          harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, {
            ...contentOf("x"),
            collectorVersion: OFFERED_VERSION,
          }),
          ...VERSION_UNKNOWN,
        );
        expect(harness.catalogue.isOffered).toHaveBeenCalledWith(OTHER_DISTRIBUTION.distribution, OFFERED_VERSION);
      });

      it.each([
        ["one the catalogue doesn't have", "9.9.9"],
        ["a deprecated one", DEPRECATED_VERSION],
      ])("refuses a change to %s with collector_version_unknown, writing, touching and auditing nothing", async (_label, collectorVersion) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const saved = harness.version(row.id);

        await expectRefusal(
          harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, {
            ...contentOf("x"),
            collectorVersion,
          }),
          ...VERSION_UNKNOWN,
        );
        expect(harness.versions.save).not.toHaveBeenCalled();
        expect(harness.configurations.touch).not.toHaveBeenCalled();
        expect(harness.auditEvents).toEqual([]);
        expect(harness.versionRows.get(saved.id)).toEqual(saved);
      });

      it("accepts the stored collector version even though the catalog deprecated it since, asking the catalog nothing and writing no pin", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const saved = harness.version(row.id, { collectorVersion: DEPRECATED_VERSION });
        expect(saved).toMatchObject({ collectorVersionDeprecated: true, collectorVersionDeprecatedNote: DEPRECATED_NOTE });

        const version = await harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, {
          ...contentOf("x"),
          collectorVersion: DEPRECATED_VERSION,
        });

        expect(harness.catalogue.isOffered).not.toHaveBeenCalled();
        expect(harness.versions.save).toHaveBeenCalledWith(row.id, saved.id, contentOf("x"), NOW);
        expect(version).toMatchObject({
          yamlContent: "x",
          collectorVersion: DEPRECATED_VERSION,
          collectorVersionDeprecated: true,
          collectorVersionDeprecatedNote: DEPRECATED_NOTE,
        });
      });

      it("keeps the stored collector version when the save leaves it out", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const saved = harness.version(row.id, { collectorVersion: OFFERED_VERSION });

        const version = await harness.service.saveVersion(actor, harness.organizationId, row.id, saved.id, contentOf("x"));

        expect(harness.catalogue.isOffered).not.toHaveBeenCalled();
        expect(version.collectorVersion).toBe(OFFERED_VERSION);
      });

      it.each([
        ["a version the catalogue offers", OFFERED_VERSION],
        ["one it doesn't have", "9.9.9"],
        ["the stored one", CATALOGUE_DEFAULTS.version],
      ])("refuses a published version's save naming %s with 409 configuration_version_published, before the catalog is asked", async (_label, collectorVersion) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const published = harness.version(row.id, PUBLISHED);

        await expectRefusal(
          harness.service.saveVersion(actor, harness.organizationId, row.id, published.id, {
            ...contentOf(published.yamlContent),
            collectorVersion,
          }),
          ...VERSION_PUBLISHED,
        );
        expect(harness.catalogue.isOffered).not.toHaveBeenCalled();
        expect(harness.versions.save).not.toHaveBeenCalled();
      });
    });

    describe("createVersion's pin and distribution", () => {
      const created = (
        actor: Actor,
        configurationId: string,
        sourceVersionId: string,
        collectorVersion?: string,
      ) =>
        harness.service.createVersion(actor, harness.organizationId, configurationId, {
          sourceVersionId,
          ...contentOf("x"),
          ...(collectorVersion === undefined ? {} : { collectorVersion }),
        });

      it("copies the source's saved collector version when none is given, even a deprecated one, asking the catalog nothing", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const source = harness.version(row.id, { collectorVersion: DEPRECATED_VERSION });

        const version = await created(actor, row.id, source.id);

        expect(harness.catalogue.isOffered).not.toHaveBeenCalled();
        expect(version).toMatchObject({
          collectorVersion: DEPRECATED_VERSION,
          collectorVersionDeprecated: true,
          collectorVersionDeprecatedNote: DEPRECATED_NOTE,
        });
      });

      it("copies a published source's collector version, as the banner's create does", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const source = harness.version(row.id, { ...PUBLISHED, collectorVersion: OFFERED_VERSION });

        expect((await created(actor, row.id, source.id)).collectorVersion).toBe(OFFERED_VERSION);
      });

      it("accepts the source's collector version given again, even a deprecated one", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const source = harness.version(row.id, { collectorVersion: DEPRECATED_VERSION });

        expect((await created(actor, row.id, source.id, DEPRECATED_VERSION)).collectorVersion).toBe(DEPRECATED_VERSION);
        expect(harness.catalogue.isOffered).not.toHaveBeenCalled();
      });

      it("takes another version the distribution offers, the source left as it was", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const source = harness.version(row.id);

        const version = await created(actor, row.id, source.id, OFFERED_VERSION);

        expect(harness.catalogue.isOffered).toHaveBeenCalledWith(CATALOGUE_DEFAULTS.distribution, OFFERED_VERSION);
        expect(version.collectorVersion).toBe(OFFERED_VERSION);
        expect(harness.versionRows.get(source.id)).toEqual(source);
      });

      it.each([
        ["one the catalogue doesn't have", "9.9.9"],
        ["a deprecated one", DEPRECATED_VERSION],
      ])("refuses a change to %s with collector_version_unknown, after the source's check, creating nothing", async (_label, collectorVersion) => {
        const actor = harness.memberActor();
        const row = harness.configuration();
        const source = harness.version(row.id);

        await expectRefusal(created(actor, row.id, source.id, collectorVersion), ...VERSION_UNKNOWN);
        expect(harness.versions.createNext).not.toHaveBeenCalled();
        expect(harness.configurations.touch).not.toHaveBeenCalled();
        expect(harness.auditEvents).toEqual([]);
        // An unknown source is still version_not_found first.
        await expectRefusal(created(actor, row.id, randomUUID(), collectorVersion), ...VERSION_NOT_FOUND);
      });

      it("stamps the new version with the configuration's distribution, read under its lock, never the source's", async () => {
        const actor = harness.memberActor();
        const row = harness.configuration({ collectorDistribution: OTHER_DISTRIBUTION.distribution });
        // A source whose distribution disagrees (the database's composite
        // key rules it out): the configuration's is the one that counts.
        const source = harness.version(row.id, {
          collectorDistribution: "stale-distribution",
          collectorVersion: OTHER_DISTRIBUTION.version,
        });

        await created(actor, row.id, source.id);

        expect(harness.versions.createNext).toHaveBeenCalledWith(
          expect.objectContaining({
            collectorDistribution: OTHER_DISTRIBUTION.distribution,
            collectorVersion: OTHER_DISTRIBUTION.version,
          }),
        );
      });
    });
  });
});
