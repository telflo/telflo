import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { setDatabaseContext, withDatabaseContext } from "../../../database/context.js";
import {
  createConfigurationVersionRepository,
  type IConfigurationVersionRepository,
} from "./configuration-version-repository.js";

describe("configuration version repository", () => {
  /** The repository's connection, as the API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;
  /** The catalogue's default distribution and version (D13a), which a version is created at. */
  let pin: { collectorDistribution: string; collectorVersion: string };
  /** The pin as a summary reads it: the default is never deprecated (D13a decision 4). */
  let summaryPin: typeof pin & { collectorVersionDeprecated: boolean; collectorVersionDeprecatedNote: string | null };

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    const defaults = await catalogueDefaults(ownerDb);
    pin = { collectorDistribution: defaults.distribution, collectorVersion: defaults.version };
    summaryPin = { ...pin, collectorVersionDeprecated: false, collectorVersionDeprecatedNote: null };
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A clock's reading, with milliseconds, as the API's clock gives them. */
  const at = (iso: string) => new Date(iso);

  /** A small graph in the stored shape (D9a decision 6): anything JSON at this layer. */
  const GRAPH = {
    nodes: [
      {
        id: "receiver-otlp-1",
        type: "receiver",
        position: { x: 100, y: 40.5 },
        parentId: "group-traces",
        data: { label: "otlp", componentType: "receiver", instanceName: "otlp", config: { protocols: { grpc: {} } } },
      },
      {
        id: "group-traces",
        type: "group",
        position: { x: 0, y: 0 },
        style: { width: 800, height: 240 },
        data: { pipelineId: "traces", signalType: "traces", color: "#3b82f6" },
      },
    ],
    edges: [{ id: "edge-1", source: "receiver-otlp-1", target: "exporter-debug-1", type: "smoothstep" }],
    pipelines: [{ id: "traces", name: "traces", signalType: "traces", color: "#3b82f6" }],
  };

  const versionRow = (id: string) =>
    ownerDb.selectFrom("configuration_versions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  /**
   * A member acting in a live group organization (they keep their personal
   * one) with a configuration, and another organization with a configuration
   * and its version 1.
   */
  const organizationWithNeighbour = async () => {
    const member = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: member.user.id, role: "contributor" });
    const configuration = await addConfiguration(ownerDb, {
      organizationId: group.organization.id,
      created_by_user_id: member.user.id,
    });
    const neighbour = await createUserWithOrganization(ownerDb);
    const elsewhere = await addConfiguration(ownerDb, { organizationId: neighbour.organization.id });
    const versionElsewhere = await addConfigurationVersion(ownerDb, {
      configurationId: elsewhere.id,
      organizationId: neighbour.organization.id,
      yaml_content: "elsewhere",
    });
    return {
      memberId: member.user.id,
      memberEmail: member.user.email,
      organizationId: group.organization.id,
      configuration,
      elsewhere,
      versionElsewhere,
    };
  };

  /** Runs `work` in `organizationId`'s database context, as `userId`, with the repository bound to it. */
  const inOrganization = <Result>(
    userId: string,
    organizationId: string,
    work: (versions: IConfigurationVersionRepository) => Promise<Result>,
  ) =>
    withDatabaseContext(db, { userId, organizationId }, (transaction) =>
      work(createConfigurationVersionRepository(transaction, { organizationId, userId })),
    );

  /** Deletes the configuration softly, as the configurations repository's markDeleted does. */
  const markDeleted = (configurationId: string) =>
    ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", configurationId).execute();

  /**
   * Fails with 55P03 while another transaction holds a conflicting lock on
   * the row: the deterministic way to see a lock held (D2a Ruling 6). `for
   * update` conflicts with every row lock, a foreign key check's `for key
   * share` included.
   */
  const probeLock = (table: "configurations" | "users", id: string) =>
    ownerDb
      .transaction()
      .execute((transaction) =>
        sql`select 1 from ${sql.table(table)} where id = ${id} for update nowait`.execute(transaction),
      );

  describe("create", () => {
    it("creates a version of the configuration in the context's organization, created and updated at the clock's time, and returns it", async () => {
      const { memberId, memberEmail, organizationId, configuration } = await organizationWithNeighbour();
      const now = at("2030-01-01T00:00:00.123Z");

      const version = await inOrganization(memberId, organizationId, (versions) =>
        versions.create({
          configurationId: configuration.id,
          versionNumber: 1,
          yamlContent: "receivers: {}\n",
          createdByUserId: memberId,
          ...pin,
          at: now,
        }),
      );

      // The graph is the table's '[]': a new version is laid out on open (D9a decision 6).
      // Unnamed when no label is given (D10 decision 14), with its creator's email.
      expect(version).toEqual({
        id: expect.any(String),
        configurationId: configuration.id,
        versionNumber: 1,
        label: null,
        createdBy: { userId: memberId, email: memberEmail },
        yamlContent: "receivers: {}\n",
        nodes: [],
        edges: [],
        pipelines: [],
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        publishedBy: null,
        ...summaryPin,
      });
      expect(await versionRow(version.id)).toEqual({
        id: version.id,
        configuration_id: configuration.id,
        organization_id: organizationId,
        version_number: 1,
        yaml_content: "receivers: {}\n",
        label: null,
        created_by_user_id: memberId,
        created_at: now,
        updated_at: now,
        nodes: [],
        edges: [],
        pipelines: [],
        // A new version is a draft (D11b decision 10).
        published_at: null,
        published_by_user_id: null,
        publication_id: null,
        collector_distribution: pin.collectorDistribution,
        collector_version: pin.collectorVersion,
      });
    });

    it("stores the label given, as the starter's version 1 is named (D10 decision 14)", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();

      const version = await inOrganization(memberId, organizationId, (versions) =>
        versions.create({
          configurationId: configuration.id,
          versionNumber: 1,
          label: "Initial version",
          yamlContent: "",
          createdByUserId: memberId,
          ...pin,
          at: new Date(),
        }),
      );

      expect(version.label).toBe("Initial version");
      expect((await versionRow(version.id)).label).toBe("Initial version");
    });

    it("reads a timestamp written from the clock back equal, to the millisecond", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const now = at("2030-06-15T12:34:56.789Z");
      await inOrganization(memberId, organizationId, (versions) =>
        versions.create({
          configurationId: configuration.id,
          versionNumber: 1,
          yamlContent: "",
          createdByUserId: memberId,
          ...pin,
          at: now,
        }),
      );

      const opened = await inOrganization(memberId, organizationId, (versions) => versions.findOpened(configuration.id));
      expect(opened?.createdAt.getTime()).toBe(now.getTime());
      expect(opened?.updatedAt.toISOString()).toBe("2030-06-15T12:34:56.789Z");
    });

    it("refuses a version of another organization's configuration (42501): the scope names the context's organization, where no such configuration is visible, so row-level security refuses it before the composite foreign key would (D11b Preflight ruling 15)", async () => {
      const { memberId, organizationId, elsewhere } = await organizationWithNeighbour();
      await expect(
        inOrganization(memberId, organizationId, (versions) =>
          versions.create({
            configurationId: elsewhere.id,
            versionNumber: 2,
            yamlContent: "smuggled",
            createdByUserId: memberId,
            ...pin,
            at: new Date(),
          }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const smuggled = await ownerDb
        .selectFrom("configuration_versions")
        .select("id")
        .where("yaml_content", "=", "smuggled")
        .execute();
      expect(smuggled).toEqual([]);
    });
  });

  describe("findOpened", () => {
    it("returns the configuration's version with the highest number", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId });
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "first",
      });
      const second = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        yaml_content: "second",
        created_at: at("2030-01-02T00:00:00.000Z"),
        updated_at: at("2030-01-03T00:00:00.000Z"),
      });
      // Higher still, but another configuration's: only this one's count.
      await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId, version_number: 3 });

      expect(
        await inOrganization(memberId, organizationId, (versions) => versions.findOpened(configuration.id)),
      ).toEqual({
        id: second.id,
        configurationId: configuration.id,
        versionNumber: 2,
        label: null,
        createdBy: null,
        yamlContent: "second",
        nodes: [],
        edges: [],
        pipelines: [],
        createdAt: at("2030-01-02T00:00:00.000Z"),
        updatedAt: at("2030-01-03T00:00:00.000Z"),
        publishedAt: null,
        publishedBy: null,
        ...summaryPin,
      });
    });

    it("prefers the highest number even when a lower one was inserted last", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const second = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
      });
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 1 });

      const opened = await inOrganization(memberId, organizationId, (versions) => versions.findOpened(configuration.id));
      expect(opened?.id).toBe(second.id);
    });

    it("finds nothing for a deleted configuration, another organization's, or one with no version", async () => {
      const { memberId, organizationId, configuration, elsewhere } = await organizationWithNeighbour();
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      const empty = await addConfiguration(ownerDb, { organizationId });
      await markDeleted(configuration.id);

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.findOpened(configuration.id)).toBeUndefined();
        expect(await versions.findOpened(elsewhere.id)).toBeUndefined();
        expect(await versions.findOpened(empty.id)).toBeUndefined();
      });
    });
  });

  describe("find", () => {
    it("finds the version when it belongs to that configuration, with its label and its creator's email", async () => {
      const { memberId, memberEmail, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        label: "Add tail sampling",
        created_by_user_id: memberId,
        yaml_content: "exporters: {}\n",
        nodes: JSON.stringify(GRAPH.nodes),
        edges: JSON.stringify(GRAPH.edges),
        pipelines: JSON.stringify(GRAPH.pipelines),
      });
      expect({ nodes: version.nodes, edges: version.edges, pipelines: version.pipelines }).toEqual(GRAPH);

      expect(
        await inOrganization(memberId, organizationId, (versions) => versions.find(configuration.id, version.id)),
      ).toEqual({
        id: version.id,
        configurationId: configuration.id,
        versionNumber: 1,
        label: "Add tail sampling",
        createdBy: { userId: memberId, email: memberEmail },
        yamlContent: "exporters: {}\n",
        nodes: version.nodes,
        edges: version.edges,
        pipelines: version.pipelines,
        createdAt: version.created_at,
        updatedAt: version.updated_at,
        publishedAt: null,
        publishedBy: null,
        ...summaryPin,
      });
    });

    it("misses with another configuration's id, even in the same organization", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId });
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });

      expect(
        await inOrganization(memberId, organizationId, (versions) => versions.find(other.id, version.id)),
      ).toBeUndefined();
    });

    it("finds nothing for a deleted configuration's version, or another organization's", async () => {
      const { memberId, organizationId, configuration, elsewhere, versionElsewhere } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      await markDeleted(configuration.id);

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.find(configuration.id, version.id)).toBeUndefined();
        expect(await versions.find(elsewhere.id, versionElsewhere.id)).toBeUndefined();
      });
    });
  });

  describe("findSummary (D10 Ruling 41)", () => {
    it("finds the version's summary when it belongs to that configuration: its label and creator, no content", async () => {
      const { memberId, memberEmail, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        label: "Add tail sampling",
        created_by_user_id: memberId,
        yaml_content: "exporters: {}\n",
        nodes: JSON.stringify(GRAPH.nodes),
        created_at: at("2030-01-02T00:00:00.000Z"),
        updated_at: at("2030-01-03T00:00:00.000Z"),
      });

      // toEqual: no content key (yamlContent, the graph, configurationId) may appear.
      expect(
        await inOrganization(memberId, organizationId, (versions) => versions.findSummary(configuration.id, version.id)),
      ).toEqual({
        id: version.id,
        versionNumber: 2,
        label: "Add tail sampling",
        createdBy: { userId: memberId, email: memberEmail },
        createdAt: at("2030-01-02T00:00:00.000Z"),
        updatedAt: at("2030-01-03T00:00:00.000Z"),
        publishedAt: null,
        publishedBy: null,
        ...summaryPin,
      });
    });

    it("misses with another configuration's id, even in the same organization", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId });
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });

      expect(
        await inOrganization(memberId, organizationId, (versions) => versions.findSummary(other.id, version.id)),
      ).toBeUndefined();
    });

    it("finds nothing for a deleted configuration's version, another organization's, or an unknown one", async () => {
      const { memberId, organizationId, configuration, elsewhere, versionElsewhere } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      await markDeleted(configuration.id);

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.findSummary(configuration.id, version.id)).toBeUndefined();
        expect(await versions.findSummary(elsewhere.id, versionElsewhere.id)).toBeUndefined();
        expect(await versions.findSummary(configuration.id, "00000000-0000-7000-8000-000000000000")).toBeUndefined();
      });
    });
  });

  describe("save", () => {
    it("sets the YAML, the graph and updated_at to the clock's time, leaves the rest, and returns the version", async () => {
      const { memberId, memberEmail, organizationId, configuration } = await organizationWithNeighbour();
      const created = at("2030-01-01T00:00:00.000Z");
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        label: "kept",
        yaml_content: "before",
        created_by_user_id: memberId,
        created_at: created,
        updated_at: created,
      });
      const now = at("2030-01-02T00:00:00.001Z");

      const saved = await inOrganization(memberId, organizationId, (versions) =>
        versions.save(configuration.id, version.id, { yamlContent: "after", ...GRAPH }, now),
      );

      expect(saved).toEqual({
        id: version.id,
        configurationId: configuration.id,
        versionNumber: 1,
        label: "kept",
        createdBy: { userId: memberId, email: memberEmail },
        yamlContent: "after",
        ...GRAPH,
        createdAt: created,
        updatedAt: now,
        publishedAt: null,
        publishedBy: null,
        ...summaryPin,
      });
      expect(await versionRow(version.id)).toEqual({
        ...version,
        yaml_content: "after",
        ...GRAPH,
        updated_at: now,
      });
      // The configuration itself is the caller's to touch.
      expect(
        await ownerDb.selectFrom("configurations").selectAll().where("id", "=", configuration.id).executeTakeFirst(),
      ).toEqual(configuration);
    });

    it("round-trips the graph as JSON: nested values, numbers, non-BMP text, and an empty array", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      const graph = {
        nodes: [
          {
            id: "receiver-otlp-1",
            data: {
              label: "📈 𝒳 é \"quoted\" \\ back\nslash",
              config: { z: [1, 2.5, -0, 1e21, true, null, { deep: { deeper: [] } }], a: "" },
              connectorSignals: null,
            },
          },
        ],
        edges: [],
        pipelines: [{ name: "traces/𝕏", color: "#aabbcc", position: -1.25 }],
      };

      await inOrganization(memberId, organizationId, (versions) =>
        versions.save(configuration.id, version.id, { yamlContent: "x", ...graph }, new Date()),
      );

      // jsonb keeps no key order and no duplicate keys, so the graph compares
      // as JSON; the numbers come back as JavaScript read them.
      const opened = await inOrganization(memberId, organizationId, (versions) => versions.findOpened(configuration.id));
      expect({ nodes: opened?.nodes, edges: opened?.edges, pipelines: opened?.pipelines }).toEqual(
        JSON.parse(JSON.stringify(graph)),
      );
    });

    it("replaces a stored graph with the one given, empty arrays included", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        nodes: JSON.stringify(GRAPH.nodes),
        edges: JSON.stringify(GRAPH.edges),
        pipelines: JSON.stringify(GRAPH.pipelines),
      });

      await inOrganization(memberId, organizationId, (versions) =>
        versions.save(configuration.id, version.id, { yamlContent: "", nodes: [], edges: [], pipelines: [] }, new Date()),
      );

      expect(await versionRow(version.id)).toMatchObject({ nodes: [], edges: [], pipelines: [] });
    });

    it.each([
      ["CRLF line endings", "receivers:\r\n  otlp: {}\r\n"],
      ["trailing spaces and a trailing newline", "  receivers: {}   \n\n"],
      ["the empty string", ""],
      ["characters outside the Basic Multilingual Plane", "# 📈 metrics 𝒳\nreceivers: {}\n"],
      ["tabs and a lone carriage return", "\tkey: value\rnext: 1"],
    ])("stores %s exactly, and reads them back exactly", async (_what, text) => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "before",
      });

      const saved = await inOrganization(memberId, organizationId, (versions) =>
        versions.save(configuration.id, version.id, { yamlContent: text, ...GRAPH }, new Date()),
      );

      expect(saved?.yamlContent).toBe(text);
      expect((await versionRow(version.id)).yaml_content).toBe(text);
      const opened = await inOrganization(memberId, organizationId, (versions) => versions.findOpened(configuration.id));
      expect(opened?.yamlContent).toBe(text);
    });

    it("writes even when nothing changes", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "same",
        updated_at: at("2030-01-01T00:00:00.000Z"),
      });
      const now = at("2030-01-02T00:00:00.000Z");

      const saved = await inOrganization(memberId, organizationId, (versions) =>
        versions.save(configuration.id, version.id, { yamlContent: "same", nodes: [], edges: [], pipelines: [] }, now),
      );

      expect(saved?.updatedAt).toEqual(now);
      expect((await versionRow(version.id)).updated_at).toEqual(now);
    });

    it("refuses a graph column the table's backstop refuses (23514), writing nothing", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });

      await expect(
        inOrganization(memberId, organizationId, (versions) =>
          versions.save(
            configuration.id,
            version.id,
            { yamlContent: "changed", nodes: [], edges: ["x".repeat(4_194_301)], pipelines: [] },
            new Date(),
          ),
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_configuration_versions_edges_size" });
      expect(await versionRow(version.id)).toEqual(version);
    });

    it("returns undefined and writes nothing for a deleted configuration's version", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      await markDeleted(configuration.id);

      expect(
        await inOrganization(memberId, organizationId, (versions) =>
          versions.save(configuration.id, version.id, { yamlContent: "changed", ...GRAPH }, new Date()),
        ),
      ).toBeUndefined();
      expect(await versionRow(version.id)).toEqual(version);
    });

    it("returns undefined and writes nothing with another configuration's id, or for another organization's version", async () => {
      const { memberId, organizationId, configuration, elsewhere, versionElsewhere } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId });
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      const changed = { yamlContent: "changed", ...GRAPH };

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.save(other.id, version.id, changed, new Date())).toBeUndefined();
        expect(await versions.save(elsewhere.id, versionElsewhere.id, changed, new Date())).toBeUndefined();
      });
      expect(await versionRow(version.id)).toEqual(version);
      expect(await versionRow(versionElsewhere.id)).toEqual(versionElsewhere);
    });

    it("takes no lock on the creator's account or on the configuration (no key column changes, so no foreign-key check runs)", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        created_by_user_id: memberId,
      });

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(
          await versions.save(configuration.id, version.id, { yamlContent: "changed", ...GRAPH }, new Date()),
        ).toBeDefined();
        await expect(probeLock("users", memberId)).resolves.toBeDefined();
        await expect(probeLock("configurations", configuration.id)).resolves.toBeDefined();
      });
    });
  });

  describe("the creator's email (D10 Preflight ruling 13)", () => {
    it("keeps a soft-deleted creator's email, and is null for a hard-deleted creator or none, on every read and write", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      // Members of the group, so deleting their accounts leaves the configuration.
      const soft = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: soft.user.id, organizationId, role: "contributor" });
      const hard = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: hard.user.id, organizationId, role: "contributor" });
      const bySoft = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        created_by_user_id: soft.user.id,
      });
      const byHard = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        created_by_user_id: hard.user.id,
      });
      const byNobody = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 3,
      });
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", soft.user.id).execute();
      await ownerDb.deleteFrom("users").where("id", "=", hard.user.id).execute();
      const softCreator = { userId: soft.user.id, email: soft.user.email };

      await inOrganization(memberId, organizationId, async (versions) => {
        expect((await versions.find(configuration.id, bySoft.id))?.createdBy).toEqual(softCreator);
        expect((await versions.find(configuration.id, byHard.id))?.createdBy).toBeNull();
        expect((await versions.findSummary(configuration.id, bySoft.id))?.createdBy).toEqual(softCreator);
        expect((await versions.findSummary(configuration.id, byHard.id))?.createdBy).toBeNull();
        expect((await versions.findOpened(configuration.id))?.createdBy).toBeNull();
        expect((await versions.listSummaries(configuration.id)).map((summary) => summary.createdBy)).toEqual([
          null,
          null,
          softCreator,
        ]);
        const saved = await versions.save(
          configuration.id,
          bySoft.id,
          { yamlContent: "", nodes: [], edges: [], pipelines: [] },
          new Date(),
        );
        expect(saved?.createdBy).toEqual(softCreator);
        expect((await versions.rename(configuration.id, bySoft.id, "renamed"))?.createdBy).toEqual(softCreator);
        expect((await versions.rename(configuration.id, byNobody.id, "renamed"))?.createdBy).toBeNull();
      });
    });
  });

  describe("the publisher (D11b decision 10; D10 Preflight ruling 13's rule)", () => {
    it("reads a published version's time and publisher on every read, a soft-deleted publisher keeping their email, a hard-deleted one none, and a draft neither", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const soft = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: soft.user.id, organizationId, role: "contributor" });
      const hard = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: hard.user.id, organizationId, role: "contributor" });
      const softAt = at("2030-01-01T00:00:00.123Z");
      const hardAt = at("2030-01-02T00:00:00.456Z");
      const bySoft = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        publishedAt: softAt,
        publishedByUserId: soft.user.id,
      });
      const byHard = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        publishedAt: hardAt,
        publishedByUserId: hard.user.id,
      });
      const draft = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 3,
      });
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", soft.user.id).execute();
      await ownerDb.deleteFrom("users").where("id", "=", hard.user.id).execute();
      const softPublisher = { userId: soft.user.id, email: soft.user.email };

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.find(configuration.id, bySoft.id)).toMatchObject({
          publishedAt: softAt,
          publishedBy: softPublisher,
        });
        expect(await versions.findSummary(configuration.id, byHard.id)).toMatchObject({
          publishedAt: hardAt,
          publishedBy: null,
        });
        expect(await versions.findOpened(configuration.id)).toMatchObject({
          id: draft.id,
          publishedAt: null,
          publishedBy: null,
        });
        expect(
          (await versions.listSummaries(configuration.id)).map(({ publishedAt, publishedBy }) => [
            publishedAt,
            publishedBy,
          ]),
        ).toEqual([
          [null, null],
          [hardAt, null],
          [softAt, softPublisher],
        ]);
        // A write answers them too: a draft's save and rename, a draft's create.
        expect(
          await versions.save(
            configuration.id,
            draft.id,
            { yamlContent: "x", nodes: [], edges: [], pipelines: [] },
            new Date(),
          ),
        ).toMatchObject({ publishedAt: null, publishedBy: null });
        expect(await versions.rename(configuration.id, draft.id, "Draft")).toMatchObject({
          publishedAt: null,
          publishedBy: null,
        });
      });
    });

    it("never copies a publish column into the next version (Preflight ruling 15)", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        publishedAt: new Date(),
        publishedByUserId: memberId,
      });
      const next = await inOrganization(memberId, organizationId, (versions) =>
        versions.createNext({
          configurationId: configuration.id,
          label: null,
          yamlContent: "",
          nodes: [],
          edges: [],
          pipelines: [],
          createdByUserId: memberId,
          ...pin,
          at: new Date(),
        }),
      );
      expect(next).toMatchObject({ versionNumber: 2, publishedAt: null, publishedBy: null });
      expect(await versionRow(next!.id)).toMatchObject({
        published_at: null,
        published_by_user_id: null,
        publication_id: null,
      });
    });
  });

  describe("the viewer (D11b decision 1)", () => {
    /**
     * A colleague's draft (v1) and their published configuration (v1
     * published, v2 a draft), beside the member's own.
     */
    const withColleague = async () => {
      const fixture = await organizationWithNeighbour();
      const colleague = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, {
        userId: colleague.user.id,
        organizationId: fixture.organizationId,
        role: "contributor",
      });
      const theirDraft = await addConfiguration(ownerDb, {
        organizationId: fixture.organizationId,
        created_by_user_id: colleague.user.id,
      });
      const theirDraftV1 = await addConfigurationVersion(ownerDb, {
        configurationId: theirDraft.id,
        organizationId: fixture.organizationId,
        yaml_content: "private",
      });
      const theirPublished = await addConfiguration(ownerDb, {
        organizationId: fixture.organizationId,
        created_by_user_id: colleague.user.id,
      });
      const publishedV1 = await addConfigurationVersion(ownerDb, {
        configurationId: theirPublished.id,
        organizationId: fixture.organizationId,
        publishedAt: new Date(),
        publishedByUserId: colleague.user.id,
      });
      const draftV2 = await addConfigurationVersion(ownerDb, {
        configurationId: theirPublished.id,
        organizationId: fixture.organizationId,
        version_number: 2,
      });
      return {
        ...fixture,
        colleagueId: colleague.user.id,
        theirDraft,
        theirDraftV1,
        theirPublished,
        publishedV1,
        draftV2,
      };
    };

    it("reads none of another member's draft's versions, and writes none: every read misses and every write answers undefined, writing nothing", async () => {
      const { memberId, organizationId, theirDraft, theirDraftV1 } = await withColleague();
      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.findOpened(theirDraft.id)).toBeUndefined();
        expect(await versions.find(theirDraft.id, theirDraftV1.id)).toBeUndefined();
        expect(await versions.findSummary(theirDraft.id, theirDraftV1.id)).toBeUndefined();
        expect(await versions.listSummaries(theirDraft.id)).toEqual([]);
        expect(
          await versions.save(theirDraft.id, theirDraftV1.id, { yamlContent: "taken", ...GRAPH }, new Date()),
        ).toBeUndefined();
        expect(await versions.rename(theirDraft.id, theirDraftV1.id, "Taken")).toBeUndefined();
        expect(
          await versions.createNext({
            configurationId: theirDraft.id,
            label: null,
            yamlContent: "slipped in",
            nodes: [],
            edges: [],
            pipelines: [],
            createdByUserId: memberId,
            ...pin,
            at: new Date(),
          }),
        ).toBeUndefined();
      });
      expect(await versionRow(theirDraftV1.id)).toEqual(theirDraftV1);
      const versionsOfDraft = await ownerDb
        .selectFrom("configuration_versions")
        .select("id")
        .where("configuration_id", "=", theirDraft.id)
        .execute();
      expect(versionsOfDraft).toEqual([{ id: theirDraftV1.id }]);
    });

    it("refuses create on another member's draft (42501, row-level security)", async () => {
      const { memberId, organizationId, theirDraft } = await withColleague();
      await expect(
        inOrganization(memberId, organizationId, (versions) =>
          versions.create({
            configurationId: theirDraft.id,
            versionNumber: 2,
            yamlContent: "slipped in",
            createdByUserId: memberId,
            ...pin,
            at: new Date(),
          }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("reads every version of another member's published configuration, its draft v2 included, and saves, renames and adds to its drafts", async () => {
      const { memberId, organizationId, theirPublished, publishedV1, draftV2 } = await withColleague();
      await inOrganization(memberId, organizationId, async (versions) => {
        expect((await versions.listSummaries(theirPublished.id)).map((summary) => summary.id)).toEqual([
          draftV2.id,
          publishedV1.id,
        ]);
        expect(await versions.find(theirPublished.id, publishedV1.id)).toMatchObject({ id: publishedV1.id });
        expect(await versions.findOpened(theirPublished.id)).toMatchObject({ id: draftV2.id });
        expect(
          await versions.save(theirPublished.id, draftV2.id, { yamlContent: "saved", ...GRAPH }, new Date()),
        ).toMatchObject({ yamlContent: "saved" });
        expect(await versions.rename(theirPublished.id, draftV2.id, "Mine now")).toMatchObject({ label: "Mine now" });
        expect(
          await versions.createNext({
            configurationId: theirPublished.id,
            label: null,
            yamlContent: "",
            nodes: [],
            edges: [],
            pipelines: [],
            createdByUserId: memberId,
            ...pin,
            at: new Date(),
          }),
        ).toMatchObject({ versionNumber: 3, createdBy: { userId: memberId } });
      });
    });
  });

  describe("listSummaries", () => {
    it("lists every version of the configuration, highest number first, without content, with labels and creators' emails", async () => {
      const { memberId, memberEmail, organizationId, configuration } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId });
      const colleague = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: colleague.user.id, organizationId, role: "contributor" });
      // Inserted out of order: the list is ordered by number, not by insertion.
      const second = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        label: "Add tail sampling",
        yaml_content: "second",
        nodes: JSON.stringify(GRAPH.nodes),
        created_by_user_id: colleague.user.id,
        created_at: at("2030-01-02T00:00:00.000Z"),
        updated_at: at("2030-01-04T00:00:00.000Z"),
      });
      const first = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "first",
        created_by_user_id: memberId,
        created_at: at("2030-01-01T00:00:00.000Z"),
        updated_at: at("2030-01-01T00:00:00.000Z"),
      });
      const tenth = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 10,
        label: "Ten",
        created_by_user_id: memberId,
        created_at: at("2030-01-03T00:00:00.000Z"),
        updated_at: at("2030-01-03T00:00:00.000Z"),
      });
      // Another configuration's version: not listed.
      await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId, version_number: 3 });

      const summaries = await inOrganization(memberId, organizationId, (versions) =>
        versions.listSummaries(configuration.id),
      );

      // toEqual: no content key (yamlContent, the graph, configurationId) may appear.
      expect(summaries).toEqual([
        {
          id: tenth.id,
          versionNumber: 10,
          label: "Ten",
          createdBy: { userId: memberId, email: memberEmail },
          createdAt: at("2030-01-03T00:00:00.000Z"),
          updatedAt: at("2030-01-03T00:00:00.000Z"),
          publishedAt: null,
          publishedBy: null,
          ...summaryPin,
        },
        {
          id: second.id,
          versionNumber: 2,
          label: "Add tail sampling",
          createdBy: { userId: colleague.user.id, email: colleague.user.email },
          createdAt: at("2030-01-02T00:00:00.000Z"),
          updatedAt: at("2030-01-04T00:00:00.000Z"),
          publishedAt: null,
          publishedBy: null,
          ...summaryPin,
        },
        {
          id: first.id,
          versionNumber: 1,
          label: null,
          createdBy: { userId: memberId, email: memberEmail },
          createdAt: at("2030-01-01T00:00:00.000Z"),
          updatedAt: at("2030-01-01T00:00:00.000Z"),
          publishedAt: null,
          publishedBy: null,
          ...summaryPin,
        },
      ]);
    });

    it("lists a version whose creator's account was hard-deleted, with no creator", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const departing = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: departing.user.id, organizationId, role: "contributor" });
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        created_by_user_id: departing.user.id,
      });
      await ownerDb.deleteFrom("users").where("id", "=", departing.user.id).execute();

      const summaries = await inOrganization(memberId, organizationId, (versions) =>
        versions.listSummaries(configuration.id),
      );
      expect(summaries.map(({ id, createdBy }) => ({ id, createdBy }))).toEqual([{ id: version.id, createdBy: null }]);
    });

    it("lists only the published versions, highest number first, when publishedOnly (D17b-1 decision 31)", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const publishedAt = at("2030-01-05T00:00:00.000Z");
      const first = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, publishedAt });
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 2 });
      const third = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 3,
        publishedAt,
      });
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 4 });

      await inOrganization(memberId, organizationId, async (versions) => {
        const published = await versions.listSummaries(configuration.id, { publishedOnly: true });
        expect(published.map(({ id, publishedAt: when }) => [id, when])).toEqual([
          [third.id, publishedAt],
          [first.id, publishedAt],
        ]);
        expect((await versions.listSummaries(configuration.id, { publishedOnly: false })).map((summary) => summary.versionNumber)).toEqual([
          4, 3, 2, 1,
        ]);
      });
    });

    it("lists nothing for a deleted configuration, another organization's, or an unknown one", async () => {
      const { memberId, organizationId, configuration, elsewhere } = await organizationWithNeighbour();
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 2 });
      await markDeleted(configuration.id);

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.listSummaries(configuration.id)).toEqual([]);
        expect(await versions.listSummaries(elsewhere.id)).toEqual([]);
        expect(await versions.listSummaries("00000000-0000-7000-8000-000000000000")).toEqual([]);
      });
    });
  });

  describe("findIdByNumber and listFacts (D25 Preflight ruling 6)", () => {
    /** Another member of the organization, with a draft of their own (versions 1 and 2). */
    const othersDraft = async (organizationId: string) => {
      const other = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: other.user.id, organizationId, role: "contributor" });
      const draft = await addConfiguration(ownerDb, { organizationId, created_by_user_id: other.user.id });
      for (const version_number of [1, 2]) {
        await addConfigurationVersion(ownerDb, { configurationId: draft.id, organizationId, version_number });
      }
      return draft;
    };

    it("finds a version's id by its number, only of a live configuration the viewer can see in the context's organization", async () => {
      const { memberId, organizationId, configuration, elsewhere } = await organizationWithNeighbour();
      const first = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      const second = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 2 });
      const draft = await othersDraft(organizationId);

      const found = await inOrganization(memberId, organizationId, async (versions) => ({
        first: await versions.findIdByNumber(configuration.id, 1),
        second: await versions.findIdByNumber(configuration.id, 2),
        missing: await versions.findIdByNumber(configuration.id, 3),
        othersDraft: await versions.findIdByNumber(draft.id, 1),
        elsewhere: await versions.findIdByNumber(elsewhere.id, 1),
      }));
      expect(found).toEqual({ first: first.id, second: second.id, missing: undefined, othersDraft: undefined, elsewhere: undefined });

      await markDeleted(configuration.id);
      expect(await inOrganization(memberId, organizationId, (versions) => versions.findIdByNumber(configuration.id, 1))).toBeUndefined();
    });

    it("answers each visible configuration's latest version and pin and its HIGHEST published number; none for what the viewer can't see", async () => {
      const { memberId, organizationId, configuration, elsewhere } = await organizationWithNeighbour();
      const other = await ownerDb
        .selectFrom("collector_versions")
        .select("version")
        .where("distribution", "=", pin.collectorDistribution)
        .where("is_default", "=", false)
        .where("deprecated", "=", false)
        .executeTakeFirstOrThrow();
      // Versions 1 and 3 published, 2 and 4 drafts, 4 at another pin: the highest published is 3, not the latest.
      const rows = [];
      for (const version_number of [1, 2, 3, 4]) {
        rows.push(
          await addConfigurationVersion(ownerDb, {
            configurationId: configuration.id,
            organizationId,
            version_number,
            ...(version_number % 2 === 1 && { publishedAt: new Date(), publishedByUserId: memberId }),
            ...(version_number === 4 && { collector_version: other.version }),
          }),
        );
      }
      const draftOnly = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });
      const draftVersion = await addConfigurationVersion(ownerDb, { configurationId: draftOnly.id, organizationId });
      const othersDraftId = (await othersDraft(organizationId)).id;
      const deleted = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });
      await addConfigurationVersion(ownerDb, { configurationId: deleted.id, organizationId });
      await markDeleted(deleted.id);

      const facts = await inOrganization(memberId, organizationId, (versions) =>
        versions.listFacts([configuration.id, draftOnly.id, othersDraftId, deleted.id, elsewhere.id, randomUUID()]),
      );
      expect(Object.fromEntries(facts)).toEqual({
        [configuration.id]: {
          latestVersionId: rows[3]!.id,
          latestVersionNumber: 4,
          collectorVersion: other.version,
          publishedVersionNumber: 3,
        },
        [draftOnly.id]: {
          latestVersionId: draftVersion.id,
          latestVersionNumber: 1,
          collectorVersion: pin.collectorVersion,
          publishedVersionNumber: null,
        },
      });
      expect(await inOrganization(memberId, organizationId, (versions) => versions.listFacts([]))).toEqual(new Map());
    });
  });

  describe("createNext (D10 decision 5)", () => {
    /** createNext's input for `configurationId`, by `createdByUserId`: unnamed and now unless given. */
    const nextInput = (
      configurationId: string,
      createdByUserId: string,
      overrides: { label?: string | null; at?: Date } = {},
    ) => ({
      configurationId,
      label: overrides.label ?? null,
      yamlContent: "receivers: {}\n",
      ...GRAPH,
      createdByUserId,
      ...pin,
      at: overrides.at ?? new Date(),
    });

    it("creates the next version with the content, label and creator given, created and updated at the clock's time, and returns it", async () => {
      const { memberId, memberEmail, organizationId, configuration } = await organizationWithNeighbour();
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, yaml_content: "v1" });
      const now = at("2030-03-01T00:00:00.007Z");

      const created = await inOrganization(memberId, organizationId, (versions) =>
        versions.createNext(nextInput(configuration.id, memberId, { label: "Add tail sampling", at: now })),
      );

      expect(created).toEqual({
        id: expect.any(String),
        configurationId: configuration.id,
        versionNumber: 2,
        label: "Add tail sampling",
        createdBy: { userId: memberId, email: memberEmail },
        yamlContent: "receivers: {}\n",
        ...GRAPH,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        publishedBy: null,
        ...summaryPin,
      });
      expect(await versionRow(created!.id)).toEqual({
        id: created!.id,
        configuration_id: configuration.id,
        organization_id: organizationId,
        version_number: 2,
        label: "Add tail sampling",
        yaml_content: "receivers: {}\n",
        ...GRAPH,
        created_by_user_id: memberId,
        created_at: now,
        updated_at: now,
        // A new version is a draft (D11b decision 10).
        published_at: null,
        published_by_user_id: null,
        publication_id: null,
        collector_distribution: pin.collectorDistribution,
        collector_version: pin.collectorVersion,
      });
      // The configuration itself is the caller's to touch.
      expect(
        await ownerDb.selectFrom("configurations").selectAll().where("id", "=", configuration.id).executeTakeFirst(),
      ).toEqual(configuration);
    });

    it("numbers 1, 2 and 3 in turn, from a configuration with no version", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();

      const numbers: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        const created = await inOrganization(memberId, organizationId, (versions) =>
          versions.createNext(nextInput(configuration.id, memberId)),
        );
        numbers.push(created!.versionNumber);
      }

      expect(numbers).toEqual([1, 2, 3]);
      const rows = await ownerDb
        .selectFrom("configuration_versions")
        .select("version_number")
        .where("configuration_id", "=", configuration.id)
        .orderBy("version_number")
        .execute();
      expect(rows.map((row) => row.version_number)).toEqual([1, 2, 3]);
    });

    it("numbers after the highest, past a gap: 1 and 5 make 6", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 5 });
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 1 });
      // Higher still, but another configuration's: only this one's count.
      const other = await addConfiguration(ownerDb, { organizationId });
      await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId, version_number: 9 });

      const created = await inOrganization(memberId, organizationId, (versions) =>
        versions.createNext(nextInput(configuration.id, memberId)),
      );

      expect(created?.versionNumber).toBe(6);
    });

    it("returns undefined and writes nothing for a deleted configuration, another organization's, or an unknown one", async () => {
      const { memberId, organizationId, configuration, elsewhere } = await organizationWithNeighbour();
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      await markDeleted(configuration.id);
      const before = await ownerDb.selectFrom("configuration_versions").selectAll().orderBy("id").execute();

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.createNext(nextInput(configuration.id, memberId))).toBeUndefined();
        expect(await versions.createNext(nextInput(elsewhere.id, memberId))).toBeUndefined();
        expect(
          await versions.createNext(nextInput("00000000-0000-7000-8000-000000000000", memberId)),
        ).toBeUndefined();
      });
      expect(await ownerDb.selectFrom("configuration_versions").selectAll().orderBy("id").execute()).toEqual(before);
    });

    it("refuses a graph column the table's backstop refuses (23514), writing nothing", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();

      await expect(
        inOrganization(memberId, organizationId, (versions) =>
          versions.createNext({ ...nextInput(configuration.id, memberId), edges: ["x".repeat(4_194_301)] }),
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_configuration_versions_edges_size" });
      expect(
        await ownerDb
          .selectFrom("configuration_versions")
          .select("id")
          .where("configuration_id", "=", configuration.id)
          .execute(),
      ).toEqual([]);
    });
  });

  describe("rename (D10 decision 6)", () => {
    it("sets only the label, leaving updated_at and the content, and returns the summary", async () => {
      const { memberId, memberEmail, organizationId, configuration } = await organizationWithNeighbour();
      const created = at("2030-01-01T00:00:00.000Z");
      const saved = at("2030-01-02T00:00:00.001Z");
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "kept",
        nodes: JSON.stringify(GRAPH.nodes),
        created_by_user_id: memberId,
        created_at: created,
        updated_at: saved,
      });

      const renamed = await inOrganization(memberId, organizationId, (versions) =>
        versions.rename(configuration.id, version.id, "Add tail sampling"),
      );

      // toEqual: a summary, so no content key may appear.
      expect(renamed).toEqual({
        id: version.id,
        versionNumber: 1,
        label: "Add tail sampling",
        createdBy: { userId: memberId, email: memberEmail },
        createdAt: created,
        updatedAt: saved,
        publishedAt: null,
        publishedBy: null,
        ...summaryPin,
      });
      expect(await versionRow(version.id)).toEqual({ ...version, label: "Add tail sampling" });
      expect(
        await ownerDb.selectFrom("configurations").selectAll().where("id", "=", configuration.id).executeTakeFirst(),
      ).toEqual(configuration);
    });

    it("replaces an existing label", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        label: "Before",
      });

      await inOrganization(memberId, organizationId, (versions) =>
        versions.rename(configuration.id, version.id, "After"),
      );

      expect((await versionRow(version.id)).label).toBe("After");
    });

    it("returns undefined and writes nothing with another configuration's id, for a deleted configuration's version, or for another organization's", async () => {
      const { memberId, organizationId, configuration, elsewhere, versionElsewhere } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId });
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      const deleted = await addConfiguration(ownerDb, { organizationId, deleted_at: new Date() });
      const ofDeleted = await addConfigurationVersion(ownerDb, { configurationId: deleted.id, organizationId });

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.rename(other.id, version.id, "smuggled")).toBeUndefined();
        expect(await versions.rename(deleted.id, ofDeleted.id, "smuggled")).toBeUndefined();
        expect(await versions.rename(elsewhere.id, versionElsewhere.id, "smuggled")).toBeUndefined();
      });
      expect(await versionRow(version.id)).toEqual(version);
      expect(await versionRow(ofDeleted.id)).toEqual(ofDeleted);
      expect(await versionRow(versionElsewhere.id)).toEqual(versionElsewhere);
    });

    it("takes no lock on the creator's account or on the configuration (no key column changes, so no foreign-key check runs)", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        created_by_user_id: memberId,
      });

      await inOrganization(memberId, organizationId, async (versions) => {
        expect(await versions.rename(configuration.id, version.id, "renamed")).toBeDefined();
        await expect(probeLock("users", memberId)).resolves.toBeDefined();
        await expect(probeLock("configurations", configuration.id)).resolves.toBeDefined();
      });
    });
  });

  describe("recordPublish (D11b decisions 9 and 10, Preflight ruling 8)", () => {
    /** A draft version 1 of the member's configuration, saved earlier. */
    const withDraft = async () => {
      const fixture = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: fixture.configuration.id,
        organizationId: fixture.organizationId,
        created_by_user_id: fixture.memberId,
        label: "Initial version",
        yaml_content: "receivers: {}\n",
        updated_at: at("2029-06-01T00:00:00.000Z"),
      });
      return { ...fixture, version };
    };

    const record = (
      yamlContent = "receivers: {}\n",
      publicationId: string = randomUUID(),
      label: string | null = "Initial version",
    ) => ({
      publishedAt: at("2030-01-01T00:00:00.456Z"),
      publicationId,
      yamlContent,
      label,
      // The fixture's pin: the catalogue's default (D13a Preflight ruling 12).
      collectorVersion: pin.collectorVersion,
    });

    it("sets the three publish columns on a draft holding the YAML given, leaving the rest, and returns its summary", async () => {
      const { memberId, memberEmail, organizationId, configuration, version } = await withDraft();
      const input = { ...record(), publishedByUserId: memberId };

      const summary = await inOrganization(memberId, organizationId, (versions) =>
        versions.recordPublish(configuration.id, version.id, input),
      );

      expect(summary).toEqual({
        id: version.id,
        versionNumber: 1,
        label: "Initial version",
        createdBy: { userId: memberId, email: memberEmail },
        createdAt: version.created_at,
        updatedAt: version.updated_at,
        publishedAt: input.publishedAt,
        publishedBy: { userId: memberId, email: memberEmail },
        ...summaryPin,
      });
      expect(await versionRow(version.id)).toEqual({
        ...version,
        published_at: input.publishedAt,
        publication_id: input.publicationId,
        published_by_user_id: memberId,
      });
    });

    it("writes nothing for a version holding other text, one published already, another configuration's, a deleted configuration's, or another organization's", async () => {
      const { memberId, organizationId, configuration, version, elsewhere, versionElsewhere } = await withDraft();
      const other = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });
      const published = await addConfigurationVersion(ownerDb, {
        configurationId: other.id,
        organizationId,
        yaml_content: "receivers: {}\n",
        publishedAt: at("2029-12-01T00:00:00.000Z"),
        publishedByUserId: memberId,
      });
      const publishedBefore = await versionRow(published.id);

      await inOrganization(memberId, organizationId, async (versions) => {
        const input = (yaml?: string) => ({ ...record(yaml), publishedByUserId: memberId });
        // Saved since: the snapshot's text isn't the version's.
        expect(await versions.recordPublish(configuration.id, version.id, input("receivers: {} \n"))).toBeUndefined();
        expect(await versions.recordPublish(configuration.id, version.id, input("receivers: {}"))).toBeUndefined();
        expect(await versions.recordPublish(other.id, published.id, input())).toBeUndefined();
        expect(await versions.recordPublish(other.id, version.id, input())).toBeUndefined();
        expect(
          await versions.recordPublish(elsewhere.id, versionElsewhere.id, { ...input(), yamlContent: "elsewhere" }),
        ).toBeUndefined();
      });
      await markDeleted(configuration.id);
      expect(
        await inOrganization(memberId, organizationId, (versions) =>
          versions.recordPublish(configuration.id, version.id, { ...record(), publishedByUserId: memberId }),
        ),
      ).toBeUndefined();

      expect(await versionRow(version.id)).toEqual(version);
      expect(await versionRow(published.id)).toEqual(publishedBefore);
      expect(await versionRow(versionElsewhere.id)).toEqual(versionElsewhere);
    });

    it("writes nothing on another member's draft (D11b decision 1)", async () => {
      const fixture = await organizationWithNeighbour();
      const colleague = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: colleague.user.id, organizationId: fixture.organizationId });
      const theirs = await addConfiguration(ownerDb, {
        organizationId: fixture.organizationId,
        created_by_user_id: colleague.user.id,
      });
      const theirV1 = await addConfigurationVersion(ownerDb, {
        configurationId: theirs.id,
        organizationId: fixture.organizationId,
        yaml_content: "receivers: {}\n",
      });

      expect(
        await inOrganization(fixture.memberId, fixture.organizationId, (versions) =>
          versions.recordPublish(theirs.id, theirV1.id, {
            ...record("receivers: {}\n", randomUUID(), null),
            publishedByUserId: fixture.memberId,
          }),
        ),
      ).toBeUndefined();
      expect(await versionRow(theirV1.id)).toEqual(theirV1);
    });

    it("writes nothing for a version pinned to another collector version than the one given (D13a Preflight ruling 3)", async () => {
      const { memberId, organizationId, configuration, version } = await withDraft();
      // Another version the catalogue offers than the fixture's pin.
      const { version: other } = await ownerDb
        .selectFrom("collector_versions")
        .select("version")
        .where("distribution", "=", pin.collectorDistribution)
        .where("version", "<>", pin.collectorVersion)
        .where("deprecated", "=", false)
        .orderBy("version")
        .executeTakeFirstOrThrow();

      // Pinned to the default: a snapshot of another pin isn't this version's.
      expect(
        await inOrganization(memberId, organizationId, (versions) =>
          versions.recordPublish(configuration.id, version.id, {
            ...record(),
            collectorVersion: other,
            publishedByUserId: memberId,
          }),
        ),
      ).toBeUndefined();
      expect(await versionRow(version.id)).toEqual(version);

      // The pin given is the version's: recorded.
      expect(
        await inOrganization(memberId, organizationId, (versions) =>
          versions.recordPublish(configuration.id, version.id, { ...record(), publishedByUserId: memberId }),
        ),
      ).toMatchObject({ id: version.id, collectorVersion: pin.collectorVersion, publishedAt: at("2030-01-01T00:00:00.456Z") });
    });

    it("writes nothing for a version whose label isn't the one given (Ruling 29): renamed, named, or unnamed since", async () => {
      const { memberId, organizationId, configuration, version } = await withDraft();
      const unnamed = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        yaml_content: "receivers: {}\n",
      });

      await inOrganization(memberId, organizationId, async (versions) => {
        const input = (label: string | null) => ({
          ...record("receivers: {}\n", randomUUID(), label),
          publishedByUserId: memberId,
        });
        // Labelled "Initial version": another label, or none, isn't it.
        expect(await versions.recordPublish(configuration.id, version.id, input("Renamed"))).toBeUndefined();
        expect(await versions.recordPublish(configuration.id, version.id, input("initial version"))).toBeUndefined();
        expect(await versions.recordPublish(configuration.id, version.id, input(null))).toBeUndefined();
        // Unnamed (null): only null matches, never a label.
        expect(await versions.recordPublish(configuration.id, unnamed.id, input("Version 2"))).toBeUndefined();
      });
      expect(await versionRow(version.id)).toEqual(version);
      expect(await versionRow(unnamed.id)).toEqual(unnamed);

      // Null matches null (is not distinct from).
      const recorded = await inOrganization(memberId, organizationId, (versions) =>
        versions.recordPublish(configuration.id, unnamed.id, {
          ...record("receivers: {}\n", randomUUID(), null),
          publishedByUserId: memberId,
        }),
      );
      expect(recorded).toMatchObject({ id: unnamed.id, label: null, publishedAt: at("2030-01-01T00:00:00.456Z") });
    });
  });

  describe("isPublicationRecorded (D11b Ruling 29)", () => {
    it("answers whether a version of the organization records the id: live or deleted configuration, and nothing else", async () => {
      const { memberId, organizationId, configuration, elsewhere } = await organizationWithNeighbour();
      const recordedId = randomUUID();
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "receivers: {}\n",
        publishedAt: at("2030-01-01T00:00:00.000Z"),
        publicationId: recordedId,
      });
      const elsewhereId = randomUUID();
      await addConfigurationVersion(ownerDb, {
        configurationId: elsewhere.id,
        organizationId: elsewhere.organization_id,
        version_number: 2,
        yaml_content: "elsewhere",
        publishedAt: at("2030-01-01T00:00:00.000Z"),
        publicationId: elsewhereId,
      });
      const ask = (publicationId: string) =>
        inOrganization(memberId, organizationId, (versions) => versions.isPublicationRecorded(publicationId));

      expect(await ask(recordedId)).toBe(true);
      expect(await ask(randomUUID())).toBe(false);
      // Another organization's record isn't this one's.
      expect(await ask(elsewhereId)).toBe(false);
      // A deleted configuration's record is still a record.
      await markDeleted(configuration.id);
      expect(await ask(recordedId)).toBe(true);
    });
  });

  describe("the collector pin (D13a decisions 4 and 8)", () => {
    it("save writes a collector version given, and leaves the stored one when none is", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      expect(version.collector_version).toBe(pin.collectorVersion);
      // Another version the catalogue offers.
      const { version: other } = await ownerDb
        .selectFrom("collector_versions")
        .select("version")
        .where("distribution", "=", pin.collectorDistribution)
        .where("version", "<>", pin.collectorVersion)
        .where("deprecated", "=", false)
        .orderBy("version")
        .executeTakeFirstOrThrow();

      const changed = await inOrganization(memberId, organizationId, (versions) =>
        versions.save(configuration.id, version.id, { yamlContent: "a", ...GRAPH, collectorVersion: other }, new Date()),
      );
      expect(changed).toMatchObject({ yamlContent: "a", collectorVersion: other, collectorVersionDeprecated: false });
      expect(await versionRow(version.id)).toMatchObject({ collector_version: other });

      const kept = await inOrganization(memberId, organizationId, (versions) =>
        versions.save(configuration.id, version.id, { yamlContent: "b", ...GRAPH }, new Date()),
      );
      expect(kept).toMatchObject({ yamlContent: "b", collectorVersion: other });
      expect(await versionRow(version.id)).toMatchObject({ yaml_content: "b", collector_version: other });
    });

    it("reads a pin the catalogue deprecated since as deprecated, with the catalogue's note, in every read and write, and a pin it offers with no note", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      const context = { organizationId, userId: memberId };
      const RETIRED = "0.0.1";
      const NOTE = "Retired fixture: upgrade.";
      const rolledBack = new Error("rolled back: the fixture never stays in telflo_platform_test");

      // As the tables' owner, in a transaction rolled back at the end: the
      // deprecated version is a fixture's, and the catalogue in telflo_platform_test
      // stays the committed one.
      await expect(
        ownerDb.transaction().execute(async (transaction) => {
          await transaction
            .insertInto("collector_versions")
            .values({
              distribution: pin.collectorDistribution,
              version: RETIRED,
              label: `v${RETIRED}`,
              description: null,
              released_at: "2020-01-01",
              is_default: false,
              deprecated: true,
              deprecated_note: NOTE,
              container_image: `otel/opentelemetry-collector-contrib:${RETIRED}`,
              otelcol_contrib_version: null,
              supported_components: null,
              otelcol_contrib: "{}",
              opamp_supervisor: "{}",
            })
            .execute();
          const first = await addConfigurationVersion(transaction, {
            configurationId: configuration.id,
            organizationId,
            collector_distribution: pin.collectorDistribution,
            collector_version: RETIRED,
          });
          await setDatabaseContext(transaction, context);
          const versions = createConfigurationVersionRepository(transaction, context);
          const deprecated = { collectorVersion: RETIRED, collectorVersionDeprecated: true, collectorVersionDeprecatedNote: NOTE };

          expect(await versions.findOpened(configuration.id)).toMatchObject(deprecated);
          expect(await versions.find(configuration.id, first.id)).toMatchObject(deprecated);
          expect(await versions.findSummary(configuration.id, first.id)).toMatchObject(deprecated);
          expect(await versions.listSummaries(configuration.id)).toEqual([expect.objectContaining(deprecated)]);
          expect(await versions.rename(configuration.id, first.id, "Renamed")).toMatchObject(deprecated);
          expect(
            await versions.createNext({
              configurationId: configuration.id,
              label: null,
              yamlContent: "",
              nodes: [],
              edges: [],
              pipelines: [],
              createdByUserId: memberId,
              collectorDistribution: pin.collectorDistribution,
              collectorVersion: RETIRED,
              at: new Date(),
            }),
          ).toMatchObject({ versionNumber: 2, ...deprecated });
          expect(
            await versions.recordPublish(configuration.id, first.id, {
              publishedAt: new Date(),
              publicationId: randomUUID(),
              publishedByUserId: memberId,
              yamlContent: first.yaml_content,
              label: "Renamed",
              collectorVersion: RETIRED,
            }),
          ).toMatchObject(deprecated);
          // The pin changed to one the catalogue offers: no longer deprecated, and no note.
          const second = (await versions.listSummaries(configuration.id))[0]!;
          expect(
            await versions.save(
              configuration.id,
              second.id,
              { yamlContent: "", nodes: [], edges: [], pipelines: [], collectorVersion: pin.collectorVersion },
              new Date(),
            ),
          ).toMatchObject({
            collectorVersion: pin.collectorVersion,
            collectorVersionDeprecated: false,
            collectorVersionDeprecatedNote: null,
          });
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);

      expect(
        await ownerDb.selectFrom("collector_versions").select("version").where("version", "=", RETIRED).execute(),
      ).toEqual([]);
    });
  });
});
