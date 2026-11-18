import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollectorErrorSchema,
  CollectorErrorsPageSchema,
  CollectorGroupAnnotationsSchema,
  CollectorGroupSchema,
  CollectorGroupsResponseSchema,
  CollectorSchema,
  CollectorsPageSchema,
  EnrollmentTokenEventSchema,
  EnrollmentTokenEventsPageSchema,
  EnrollmentTokenListedSchema,
  EnrollmentTokensResponseSchema,
  FleetDetailSchema,
  FleetsPageSchema,
  kubernetesOf,
  QuickDeployLinkSchema,
  QuickDeployLinksPageSchema,
  type Collector,
} from "@telflo/contracts";
import { CANONICAL_UUID } from "~/lib/ids.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { FLEET_READ_NAMES, SAMPLE_ORGANIZATION_ID, readsFor } from "~/lib/workspace-reads.js";
import { sampleConfigurations } from "./configurations.js";
import { SAMPLE_COLLECTOR_IDS, SAMPLE_FLEET_IDS, SAMPLE_FLEET_READS, SAMPLE_GROUP_IDS, sampleFleets } from "./fleets.js";

/*
 * The fleets sample (D31-1 decisions 10 and 35, Preflight ruling 6): every
 * object parses with its contracts schema; the sample's counts, with the
 * platform's groups; summaries that agree with the collectors and tokens;
 * every published version named is one of the sample configurations'; fixed
 * ids; no secret-shaped field; and the reads answer every fleet read from
 * it, as the API applies its queries, never calling the API client.
 * sample.test.ts searches the whole sample (this one included) for
 * secret-shaped strings.
 */

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Every key of every object in `value`, recursively. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, entry]) => [key, ...keysIn(entry)]);
  return [];
}

/** Every string in `value`, recursively. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

describe("the fleets sample's shapes", () => {
  const { fleets } = sampleFleets(NOW);

  it("is 3 server fleets and 1 Kubernetes fleet, with their 14 and 6 collectors", () => {
    expect(fleets.map((each) => each.fleet.label).sort()).toEqual(["edge-import-pilot", "k8s-prod-us-west", "prod-us-east", "staging-eu"]);
    const ofType = (type: string) => fleets.filter((each) => each.fleet.type === type);
    expect(ofType("server")).toHaveLength(3);
    expect(ofType("kubernetes-supervisor")).toHaveLength(1);
    expect(ofType("server").flatMap((each) => each.collectors)).toHaveLength(14);
    expect(ofType("kubernetes-supervisor").flatMap((each) => each.collectors)).toHaveLength(6);
    // Newest first, as the list orders them.
    const created = fleets.map((each) => each.fleet.createdAt);
    expect(created).toEqual([...created].sort().reverse());
  });

  it("parses with the contracts' schemas, every one of them strictly", () => {
    for (const each of fleets) {
      expect(FleetDetailSchema.parse(each.fleet)).toEqual(each.fleet);
      for (const group of each.groups) {
        expect(CollectorGroupSchema.parse(group)).toEqual(group);
        if (group.annotations !== null) expect(CollectorGroupAnnotationsSchema.safeParse(group.annotations).success).toBe(true);
      }
      for (const collector of each.collectors) expect(CollectorSchema.parse(collector)).toEqual(collector);
      for (const errors of Object.values(each.errors)) for (const error of errors) expect(CollectorErrorSchema.parse(error)).toEqual(error);
      for (const token of each.tokens) expect(EnrollmentTokenListedSchema.parse(token)).toEqual(token);
      for (const event of each.events) expect(EnrollmentTokenEventSchema.parse(event)).toEqual(event);
      for (const link of each.links) expect(QuickDeployLinkSchema.parse(link)).toEqual(link);
    }
  });

  it("has collector groups of both kinds: server groups, and the Agent, the Cluster and gateways with their Kubernetes settings", () => {
    const server = fleets.filter((each) => each.fleet.type === "server");
    for (const each of server) {
      expect(each.groups[0]!.isDefault).toBe(true);
      expect(each.groups.every((group) => kubernetesOf(group.annotations).kubernetes === null)).toBe(true);
    }
    expect(server.flatMap((each) => each.groups).length).toBeGreaterThan(server.length);
    const kubernetes = fleets.find((each) => each.fleet.id === SAMPLE_FLEET_IDS.kubernetes)!;
    const roles = kubernetes.groups.map((group) => kubernetesOf(group.annotations));
    expect(roles.every((role) => role.readable && role.kubernetes !== null)).toBe(true);
    expect(roles.map((role) => role.kubernetes!.role)).toEqual(["node", "cluster", "gateway", "gateway"]);
    // Every collector is in one of its fleet's groups.
    for (const each of fleets) {
      const ids = new Set(each.groups.map((group) => group.id));
      expect(each.collectors.every((collector) => ids.has(collector.groupId) && collector.fleetId === each.fleet.id)).toBe(true);
    }
  });

  it("has summaries counted from the collectors and the tokens", () => {
    for (const { fleet, collectors, tokens } of fleets) {
      const count = (test: (collector: Collector) => boolean) => collectors.filter(test).length;
      const { summary } = fleet;
      expect(summary.collectors).toBe(collectors.length);
      expect(summary.online + summary.warning + summary.unknown + summary.offline).toBe(collectors.length);
      expect(summary.inSync + summary.pending + summary.failed + summary.drifted + summary.unassigned).toBe(collectors.length);
      for (const liveness of ["online", "warning", "unknown", "offline"] as const) {
        expect(summary[liveness]).toBe(count((collector) => collector.liveness === liveness));
      }
      for (const drift of ["inSync", "pending", "failed", "drifted", "unassigned"] as const) {
        expect(summary[drift]).toBe(count((collector) => collector.drift === drift));
      }
      expect(summary.lastSeenAt).toBe(collectors.map((collector) => collector.lastSeenAt).sort().at(-1));
      const validRotate = tokens.filter(
        (token) => token.kind === "rotate" && token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > NOW),
      );
      expect(summary.rotateToken?.validCount).toBe(validRotate.length);
    }
  });

  it("shows the states worth showing: a failed apply with its history, a pending one, every liveness, a pin, a token in its grace and one revoked", () => {
    const collectors = fleets.flatMap((each) => each.collectors);
    expect(new Set(collectors.map((collector) => collector.liveness))).toEqual(new Set(["online", "warning", "unknown", "offline"]));
    expect(new Set(collectors.map((collector) => collector.drift))).toEqual(new Set(["inSync", "pending", "failed"]));
    const failing = collectors.find((collector) => collector.id === SAMPLE_COLLECTOR_IDS.braveFalcon)!;
    expect(failing.effective?.status).toBe("failed");
    const prod = fleets.find((each) => each.fleet.id === SAMPLE_FLEET_IDS.prod)!;
    expect(prod.errors[SAMPLE_COLLECTOR_IDS.braveFalcon]!.length).toBeGreaterThan(1);
    expect(collectors.filter((collector) => collector.pin !== null).length).toBeGreaterThan(0);
    const tokens = fleets.flatMap((each) => each.tokens);
    expect(tokens.some((token) => token.doRefresh && token.revokedAt === null)).toBe(true);
    expect(tokens.some((token) => token.revokedAt !== null)).toBe(true);
    const staging = fleets.find((each) => each.fleet.id === SAMPLE_FLEET_IDS.staging)!;
    // Its rotate token expires within 30 days: the Tokens tab's banner shows.
    expect(Date.parse(staging.fleet.summary.rotateToken!.expiresAt!) - NOW).toBeLessThan(30 * 24 * 60 * 60 * 1000);
    expect(new Set(fleets.flatMap((each) => each.links).map((link) => link.status))).toEqual(new Set(["active", "expired", "revoked"]));
  });

  it("names, as pins, assignments, resolutions and served versions, only the sample configurations' published versions", () => {
    const published = new Map(
      sampleConfigurations(NOW).flatMap((sample) =>
        sample.versions.filter((version) => version.publishedAt !== null).map((version) => [version.id, { sample, version }] as const),
      ),
    );
    const named = fleets.flatMap((each) => [
      ...each.groups.map((group) => group.assignedVersion),
      ...each.collectors.flatMap((collector) => [collector.pin?.version, collector.resolution?.version, collector.served?.version]),
    ]);
    const versions = named.filter((version) => version !== null && version !== undefined);
    expect(versions.length).toBeGreaterThan(20);
    for (const version of versions) {
      const found = published.get(version.versionId);
      expect(found, version.versionId).toBeDefined();
      expect(version.configurationId).toBe(found!.sample.configuration.id);
      expect(version.configurationName).toBe(found!.sample.configuration.name);
      expect(version.versionNumber).toBe(found!.version.versionNumber);
      expect(version.collectorVersion).toBe(found!.version.collectorVersion);
    }
    for (const { collectors } of fleets) {
      for (const collector of collectors) {
        if (collector.pin !== null) expect(collector.pin.versionId).toBe(collector.pin.version?.versionId);
        if (collector.resolution !== null) expect(collector.resolution.from).toBe(collector.pin === null ? "groupVersion" : "pinnedVersion");
      }
    }
  });

  it("has no variable groups, and no secret-shaped field: no bearer, prefix, secret or URL, nothing like a ?token=", () => {
    for (const each of fleets) {
      expect(each.groups.every((group) => group.variableGroupId === null)).toBe(true);
      expect(each.collectors.every((collector) => collector.pinnedVariableGroupId === null)).toBe(true);
    }
    const keys = keysIn(fleets).map((key) => key.toLowerCase());
    expect(keys.filter((key) => /bearer|prefix|secret|url|request_?string|password/.test(key))).toEqual([]);
    const strings = stringsIn(fleets);
    expect(strings.some((text) => /token=|https?:\/\/[^/]*telflo|\btf_|\btqd_|\btll_/.test(text))).toBe(false);
    // Host and node names hold no private address's shape (`ip-10-0-1-23`): plain names, RFC 5737 aside.
    expect(strings.some((text) => /\bip-(?!(?:192-0-2|198-51-100|203-0-113)-)\d{1,3}(?:-\d{1,3}){3}\b/.test(text))).toBe(false);
  });

  it("has fixed lowercase ids, the same on every rebuild, with times relative to now", () => {
    const later = sampleFleets(NOW + 60 * 60 * 1000);
    const ids = (built: typeof fleets) =>
      built.flatMap((each) => [
        each.fleet.id,
        ...each.groups.map((group) => group.id),
        ...each.collectors.flatMap((collector) => [collector.id, collector.instanceUid]),
        ...each.tokens.map((token) => token.id),
        ...each.events.map((event) => event.id),
        ...each.links.map((link) => link.id),
        ...Object.values(each.errors).flatMap((errors) => errors.map((error) => error.id)),
      ]);
    expect(ids(later.fleets)).toEqual(ids(fleets));
    expect(new Set(ids(fleets)).size).toBe(ids(fleets).length);
    for (const id of ids(fleets)) {
      expect(id).toMatch(CANONICAL_UUID);
      expect(id).toBe(id.toLowerCase());
    }
    const lastSeen = (built: typeof fleets) => built[0]!.collectors[0]!.lastSeenAt;
    expect(Date.parse(lastSeen(later.fleets)) - Date.parse(lastSeen(fleets))).toBe(60 * 60 * 1000);
  });
});

describe("the fleets sample's reads", () => {
  const reads = SAMPLE_FLEET_READS;
  const org = SAMPLE_ORGANIZATION_ID;

  it("answers every fleet read, behind readsFor, never calling the API client", async () => {
    const spies = spyOnTheClient();
    expect(Object.keys(reads).sort()).toEqual([...FLEET_READ_NAMES].sort());
    const sample = readsFor(org);
    const page = FleetsPageSchema.parse(await sample.getFleets(org));
    expect(page.fleets).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
    const fleet = FleetDetailSchema.parse(await sample.getFleet(org, SAMPLE_FLEET_IDS.prod));
    expect(fleet.label).toBe("prod-us-east");
    const collectors = CollectorsPageSchema.parse(await sample.getCollectors(org, SAMPLE_FLEET_IDS.prod));
    expect(collectors.collectors).toHaveLength(9);
    CollectorSchema.parse(await sample.getCollector(org, SAMPLE_FLEET_IDS.prod, SAMPLE_COLLECTOR_IDS.braveFalcon));
    const errors = CollectorErrorsPageSchema.parse(await sample.getCollectorErrors(org, SAMPLE_FLEET_IDS.prod, SAMPLE_COLLECTOR_IDS.braveFalcon));
    expect(errors.errors.length).toBeGreaterThan(1);
    const groups = CollectorGroupsResponseSchema.parse(await sample.getCollectorGroups(org, SAMPLE_FLEET_IDS.kubernetes));
    expect(groups.groups).toHaveLength(4);
    const tokens = EnrollmentTokensResponseSchema.parse(await sample.getEnrollmentTokens(org, SAMPLE_FLEET_IDS.staging));
    expect(tokens.tokens).toHaveLength(3);
    EnrollmentTokenEventsPageSchema.parse(await sample.getEnrollmentTokenEvents(org, SAMPLE_FLEET_IDS.staging));
    const links = QuickDeployLinksPageSchema.parse(await sample.getQuickDeployLinks(org, SAMPLE_FLEET_IDS.kubernetes));
    expect(links.links).toHaveLength(2);
    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  });

  it("rebuilds at each read: a poll finds last seen as fresh as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const first = (await reads.getCollectors(org, SAMPLE_FLEET_IDS.prod)).collectors.find((each) => each.id === SAMPLE_COLLECTOR_IDS.braveFalcon)!;
    vi.setSystemTime(NOW + 15_000);
    const polled = (await reads.getCollectors(org, SAMPLE_FLEET_IDS.prod)).collectors.find((each) => each.id === SAMPLE_COLLECTOR_IDS.braveFalcon)!;
    expect(Date.parse(polled.lastSeenAt) - Date.parse(first.lastSeenAt)).toBe(15_000);
    expect(polled.liveness).toBe(first.liveness);
  });

  it("filters the list by status, as the API's", async () => {
    expect((await reads.getFleets(org, { status: "active" })).fleets).toHaveLength(4);
    expect((await reads.getFleets(org, { status: "archived" })).fleets).toEqual([]);
  });

  it("searches, filters by group and sorts the collectors as the API's query does", async () => {
    const names = async (query: Parameters<typeof reads.getCollectors>[2]) =>
      (await reads.getCollectors(org, SAMPLE_FLEET_IDS.prod, query)).collectors.map((collector) => collector.name);
    expect(await names({ q: "FALCON" })).toEqual(["brave-falcon"]);
    expect(await names({ q: "198.51.100.77" })).toEqual(["brave-falcon"]);
    expect(await names({ q: "nothing-like-it" })).toEqual([]);
    expect((await names({ groupId: SAMPLE_GROUP_IDS.prodCanary })).sort()).toEqual(["bright-finch", "noble-ibex"]);
    const byName = await names({ sort: "name", order: "asc" });
    expect(byName).toEqual([...byName].sort());
    expect(await names({ sort: "name", order: "desc" })).toEqual([...byName].reverse());
    const newest = (await reads.getCollectors(org, SAMPLE_FLEET_IDS.prod)).collectors.map((collector) => collector.createdAt);
    expect(newest).toEqual([...newest].sort().reverse());
    const page = await reads.getCollectors(org, SAMPLE_FLEET_IDS.prod, { limit: 4 });
    expect(page.collectors).toHaveLength(4);
    const next = await reads.getCollectors(org, SAMPLE_FLEET_IDS.prod, { limit: 4, cursor: page.nextCursor! });
    expect(next.collectors.map((collector) => collector.id)).not.toContain(page.collectors[0]!.id);
  });

  it("answers an id the sample doesn't hold with the API's own 404", async () => {
    const unknown = "0199a000-0000-7000-8000-0000000000ff";
    await expect(reads.getFleet(org, unknown)).rejects.toMatchObject({ code: "fleet_not_found", status: 404 });
    for (const name of ["getCollectors", "getCollectorGroups", "getEnrollmentTokens", "getEnrollmentTokenEvents", "getQuickDeployLinks"] as const) {
      await expect((reads[name] as (o: string, f: string) => Promise<unknown>)(org, unknown), name).rejects.toMatchObject({ code: "fleet_not_found" });
    }
    await expect(reads.getCollector(org, SAMPLE_FLEET_IDS.prod, unknown)).rejects.toMatchObject({ code: "collector_not_found", status: 404 });
    await expect(reads.getCollectorErrors(org, SAMPLE_FLEET_IDS.prod, unknown)).rejects.toMatchObject({ code: "collector_not_found" });
    // A collector of another fleet isn't this fleet's.
    await expect(reads.getCollector(org, SAMPLE_FLEET_IDS.staging, SAMPLE_COLLECTOR_IDS.braveFalcon)).rejects.toMatchObject({
      code: "collector_not_found",
    });
  });
});
