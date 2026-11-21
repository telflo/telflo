import { describe, expect, it } from "vitest";
import { ConfigurationWithVersionResponseSchema, CurrentUserResponseSchema } from "@telflo/contracts";
import { schemaPathFor } from "~/lib/editor/collector-schema.js";
import { CANONICAL_UUID } from "~/lib/ids.js";
import { PLAYGROUND_CATALOGUE } from "~/lib/playground/catalogue.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";
import {
  NEW_CONFIGURATION_PIN,
  SAMPLE_CONFIGURATION_IDS,
  SAMPLE_DISTRIBUTION,
  SAMPLE_PINS,
  SAMPLE_VISITOR_USER_ID,
  sampleConfigurations,
  sampleVisitor,
  sampleWorkspace,
} from "./index.js";

/*
 * The sample workspace: its shapes parse with the contracts' schemas, its pins
 * are offered, its ids are fixed, and nothing in the WHOLE sample (every
 * area's module) is shaped like a secret.
 */

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

/** Every value of every string in `value`, recursively. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value instanceof Uint8Array) return [new TextDecoder().decode(value)];
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, entry]) => [key, ...stringsIn(entry)]);
  return [];
}

/** Every string of the whole sample, and the visitor's. */
function everyString(): string[] {
  return [...stringsIn(sampleWorkspace(NOW)), ...stringsIn(sampleVisitor())];
}

/** The offered (non-deprecated) versions of the build-time catalog for a distribution. */
function offeredVersions(distribution: string): string[] {
  return PLAYGROUND_CATALOGUE.find((entry) => entry.id === distribution)?.versions.map((offer) => offer.version) ?? [];
}

describe("the sample's configurations", () => {
  const samples = sampleConfigurations(NOW);

  it("are ten, each parsing as the editor's read answers it", () => {
    expect(samples).toHaveLength(10);
    expect(samples.map((sample) => sample.configuration.id)).toEqual(Object.values(SAMPLE_CONFIGURATION_IDS));
    for (const sample of samples) expect(ConfigurationWithVersionResponseSchema.parse(sample)).toEqual(sample);
  });

  it("open on a draft, the highest version; each published one also has an older published version", () => {
    for (const { configuration, version, versions } of samples) {
      expect(version.publishedAt).toBeNull();
      expect(version.id).toBe(versions[0]!.id);
      expect(version.configurationId).toBe(configuration.id);
      const numbers = versions.map((summary) => summary.versionNumber);
      expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
      const published = versions.filter((summary) => summary.publishedAt !== null);
      expect(configuration.published).toBe(published.length > 0);
      for (const summary of published) expect(summary.versionNumber).toBeLessThan(version.versionNumber);
    }
    expect(samples.filter((sample) => sample.configuration.published)).toHaveLength(8);
  });

  it("are pinned to versions the platform offers and has a schema for, spread across 0.159.0 to 0.162.0", () => {
    const offered = offeredVersions(SAMPLE_DISTRIBUTION);
    expect([...SAMPLE_PINS].sort()).toEqual([...offered].sort());
    expect(NEW_CONFIGURATION_PIN).toBe(offered[0]);
    const pins = new Set<string>();
    for (const { configuration, versions } of samples) {
      expect(configuration.collectorDistribution).toBe(SAMPLE_DISTRIBUTION);
      for (const summary of versions) {
        expect(offered).toContain(summary.collectorVersion);
        expect(schemaPathFor(SAMPLE_DISTRIBUTION, summary.collectorVersion)).not.toBeNull();
        expect(summary.collectorVersionDeprecated).toBe(false);
      }
      pins.add(versions[0]!.collectorVersion);
    }
    expect([...pins].sort()).toEqual([...SAMPLE_PINS].sort());
  });

  it("have fixed lowercase ids, the same on every rebuild, with times relative to now", () => {
    const later = sampleConfigurations(NOW + 60 * 60 * 1000);
    const ids = (built: typeof samples) =>
      built.flatMap(({ configuration, versions }) => [configuration.id, ...versions.map((summary) => summary.id)]);
    expect(ids(later)).toEqual(ids(samples));
    expect(new Set(ids(samples)).size).toBe(ids(samples).length);
    for (const id of ids(samples)) {
      expect(id).toMatch(CANONICAL_UUID);
      expect(id).toBe(id.toLowerCase());
    }
    expect(Date.parse(later[0]!.configuration.updatedAt) - Date.parse(samples[0]!.configuration.updatedAt)).toBe(60 * 60 * 1000);
    for (const { configuration } of samples) {
      expect(Date.parse(configuration.createdAt)).toBeLessThanOrEqual(Date.parse(configuration.updatedAt));
      expect(Date.parse(configuration.updatedAt)).toBeLessThan(NOW);
    }
  });

  it("are mostly the visitor's, some another person's (the Mine filter has something to filter)", () => {
    const mine = samples.filter((sample) => sample.configuration.createdBy?.userId === SAMPLE_VISITOR_USER_ID);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(samples.length);
  });
});

describe("the sample's visitor", () => {
  it("is /me's shape, in the sample's organization, an admin's, with the theme given", () => {
    const visitor = sampleVisitor("navy");
    expect(CurrentUserResponseSchema.parse({ ...visitor, termsAcceptanceRequired: false })).toBeTruthy();
    expect(visitor.organization.id).toBe(SAMPLE_ORGANIZATION_ID);
    expect(visitor.organizations).toEqual([visitor.organization]);
    expect(visitor.organization.role).toBe("admin");
    expect(visitor.isProductAdmin).toBe(false);
    expect(visitor.preferences.theme).toBe("navy");
  });
});

describe("the whole sample holds no secret-shaped value", () => {
  const strings = everyString();

  it("has something to search", () => {
    expect(strings.length).toBeGreaterThan(100);
  });

  it("holds no token, quick-deploy link or library link shape", () => {
    const tokenShaped = strings.filter((text) => /(^|[^A-Za-z0-9])(tf|tqd|tll)_[A-Za-z0-9_-]/.test(text));
    expect(tokenShaped.length).toBe(0);
  });

  it("holds no base64 run of 32 or more (a sha256's 64 lowercase hex digits aside)", () => {
    const runs = strings.flatMap((text) => text.match(/[A-Za-z0-9+/]{32,}={0,2}/g) ?? []);
    const secretShaped = runs.filter((run) => !/^[0-9a-f]{64}$/.test(run));
    expect(secretShaped.length).toBe(0);
  });

  it("names emails on acme.example only", () => {
    const emails = strings.flatMap((text) => text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g) ?? []);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((email) => email.endsWith("@acme.example"))).toBe(true);
  });

  it("names IPv4 addresses only in RFC 5737's ranges (or the any-address a receiver binds)", () => {
    const addresses = strings.flatMap((text) => text.match(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g) ?? []);
    const documentation = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;
    expect(addresses.filter((address) => address !== "0.0.0.0" && !documentation.test(address))).toEqual([]);
  });
});
