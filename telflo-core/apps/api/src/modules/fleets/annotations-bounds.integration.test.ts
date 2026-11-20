import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  annotationsTextBytes,
  annotationsWithDockerMounts,
  annotationsWithKubernetes,
  COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES,
  CollectorGroupAnnotationsSchema,
} from "@telflo/contracts";
import type { Database } from "@telflo/db";
import { openTestDatabases, type TestDatabases } from "@telflo/db/testing";

/*
 * A group's annotations are bounded in the contract by both the opamp-server's
 * canonical bytes and Postgres's jsonb text, which its table's check counts
 * (octet_length(annotations::text) <= 16384,
 * migrations/00011_collector_group_annotations.sql in the opamp-server's
 * repository), so annotations the opamp-server's table would refuse are the
 * person's 400 before any call, not its 400 answered 503. Here the contract's
 * count of the second is held equal to Postgres's own, on the same major
 * version the opamp-server runs, and the bound is checked on the whole object
 * a mounts write sends (the "telflo" key merged into the object read). A
 * Kubernetes group's volumes are in its annotations too, so this bound is
 * theirs.
 */
/** An object holding `depth - 1` more containers, arrays and objects in turn, with a key and an item beside each. */
function nestedAnnotations(depth: number): Record<string, unknown> {
  let value: unknown = "leaf";
  for (let level = depth - 1; level >= 1; level--) value = level % 2 === 0 ? [value, level] : { v: value, n: level };
  return { root: value };
}

describe("a group's annotations as Postgres writes them back", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  /** Postgres's own count: the annotations as JSON, read as jsonb and written back as text. */
  const postgresBytes = async (value: unknown) => {
    const { rows } = await sql<{ bytes: number }>`select octet_length(${JSON.stringify(value)}::jsonb::text)::int as bytes`.execute(db);
    return rows[0]?.bytes;
  };

  const MOUNT = { hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true };
  const VOLUME = { hostPath: "/var/log/journal", hostPathType: "Directory", mountPath: "/var/log/journal", readOnly: true };
  const KUBERNETES = {
    role: "gateway",
    namespace: "telemetry",
    replicas: 3,
    volumes: Array.from({ length: 32 }, (_, index) => ({ ...VOLUME, mountPath: `/volumes/${index}`, readOnly: index % 2 === 0 })),
  };

  const VALUES: [string, Record<string, unknown>][] = [
    ["an empty object", {}],
    ["the platform's mounts", { telflo: { dockerMounts: [MOUNT, { ...MOUNT, containerPath: "/logs", readOnly: false }] } }],
    ["another client's keys beside them", { "acme.io/owner": { team: "ops", tags: ["a", "b"] }, telflo: { dockerMounts: [MOUNT] } }],
    ["a Kubernetes group's settings, 32 volumes", { telflo: { kubernetes: KUBERNETES } }],
    ["keys out of order, nested", { b: [3, { d: null, c: true }], a: { z: {}, y: [] } }],
    ["numbers as the platform sends them", { n: [0, 0.1, 100, -1.5, 1e20, 0.000001, 0.1 + 0.2, 123456789.12345679, -0, 2 ** 53] }],
    ["escapes: a quote, a backslash, \\b \\f \\n \\r \\t", { s: 'q"\\\b\f\n\r\t' }],
    ["C0 controls, DEL and C1 controls", { s: "\u0001\u001f\u007f\u0080\u009f" }],
    ["U+2028 and U+2029", { s: "a b " }],
    ["HTML characters", { "<k>": "<>&" }],
    ["multibyte characters", { "é": " 　\u{1F680}" }],
    ["keys with escapes", { 'a"b': "\u0001", "c ": 1, "\u{1F680}": [] }],
    ["an empty string and an empty key", { "": "" }],
    ["64 arrays and objects deep, the most the contract takes", nestedAnnotations(64)],
  ];

  it.each(VALUES)("counts %s as Postgres does", async (_label, value) => {
    expect(annotationsTextBytes(value)?.jsonb).toBe(await postgresBytes(value));
  });

  it("refuses annotations at Postgres's bound plus one and takes them at the bound, as Postgres counts them", async () => {
    // {"n": "…"}: 9 bytes and the string's, as jsonb writes it.
    const atBound = { n: "a".repeat(16_375) };
    const overBound = { n: "a".repeat(16_376) };
    expect(await postgresBytes(atBound)).toBe(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    expect(CollectorGroupAnnotationsSchema.safeParse(atBound).success).toBe(true);
    expect(await postgresBytes(overBound)).toBe(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES + 1);
    expect(CollectorGroupAnnotationsSchema.safeParse(overBound).success).toBe(false);

    // Many keys: jsonb's spaces after each comma and colon, which the canonical form lacks.
    const keys = (last: number) =>
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`k${String(index).padStart(2, "0")}`, "a".repeat(index === 31 ? last : 500)]));
    expect(await postgresBytes(keys(532))).toBe(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    expect(CollectorGroupAnnotationsSchema.safeParse(keys(532)).success).toBe(true);
    expect(await postgresBytes(keys(533))).toBe(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES + 1);
    expect(annotationsTextBytes(keys(533))?.canonical).toBeLessThanOrEqual(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    expect(CollectorGroupAnnotationsSchema.safeParse(keys(533)).success).toBe(false);
  });

  it("counts U+2028 and U+2029 as Postgres does (three bytes) and as the opamp-server's canonical form does (six)", async () => {
    // The opamp-server checks this same pair, so the platform takes nothing it refuses.
    const separators = "\u2028\u2029".repeat(500);
    const atCanonical = { z: separators + "v".repeat(16_384 - 8 - 6_000) };
    const overCanonical = { z: separators + "v".repeat(16_384 - 8 - 6_000 + 1) };
    expect(annotationsTextBytes(atCanonical)).toEqual({ canonical: 16_384, jsonb: await postgresBytes(atCanonical) });
    expect(await postgresBytes(atCanonical)).toBe(16_384 - 3_000 + 1);
    expect(CollectorGroupAnnotationsSchema.safeParse(atCanonical).success).toBe(true);
    // Postgres' check would take it; the canonical bound (both sides') doesn't.
    expect(await postgresBytes(overCanonical)).toBeLessThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    expect(CollectorGroupAnnotationsSchema.safeParse(overCanonical).success).toBe(false);
    // The review's case: one U+2028, canonical 16,384, jsonb 16,382.
    const one = { z: "\u2028" + "v".repeat(16_370) };
    expect(annotationsTextBytes(one)).toEqual({ canonical: 16_384, jsonb: 16_382 });
    expect(await postgresBytes(one)).toBe(16_382);
    expect(CollectorGroupAnnotationsSchema.safeParse(one).success).toBe(true);
  });

  it("bounds the whole object a mounts write sends: another client's keys near the bound and the mounts merged in", async () => {
    const theirs = { "acme.io/notes": "a".repeat(15_000) };
    expect(CollectorGroupAnnotationsSchema.safeParse(theirs).success).toBe(true);
    const mounts = Array.from({ length: 32 }, (_, index) => ({ ...MOUNT, containerPath: `/mounts/${index}` }));
    const merged = annotationsWithDockerMounts(theirs, mounts);
    expect(await postgresBytes(merged)).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    expect(CollectorGroupAnnotationsSchema.safeParse(merged).success).toBe(false);
    expect(CollectorGroupAnnotationsSchema.safeParse(annotationsWithDockerMounts(theirs, mounts.slice(0, 2))).success).toBe(true);
  });

  it("bounds the whole object a Kubernetes settings write sends: another client's keys near the bound and the settings merged in", async () => {
    const theirs = { "acme.io/notes": "a".repeat(13_500) };
    const kubernetes = KUBERNETES as Parameters<typeof annotationsWithKubernetes>[1];
    const merged = annotationsWithKubernetes(theirs, kubernetes);
    expect(await postgresBytes(merged)).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    // Past the bound the walk stops: some count above it.
    expect(annotationsTextBytes(merged)?.jsonb).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    expect(CollectorGroupAnnotationsSchema.safeParse(merged).success).toBe(false);
    const fewer = annotationsWithKubernetes(theirs, { ...KUBERNETES, volumes: KUBERNETES.volumes.slice(0, 2) } as Parameters<typeof annotationsWithKubernetes>[1]);
    expect(CollectorGroupAnnotationsSchema.safeParse(fewer).success).toBe(true);
  });
});
