import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { openTestDatabases, type TestDatabases } from "@telflo/db/testing";
import { createCollectorCatalogueRepository } from "./collector-catalogue-repository.js";

/*
 * A version's binaries and the offered versions' binaries, which a Linux
 * bundle downloads, read from the committed collector catalogue as the test
 * setup's migration step (db:migrate's runMigrationStep) synced it into
 * telflo_platform_test (the API reads only the database), as the API's role.
 */
describe("the collector catalogue's binaries", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  const RELEASES = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download";

  it("finds a version's binaries by platform, a deprecated one's too, and nothing of an unknown version or distribution", async () => {
    const catalogue = createCollectorCatalogueRepository(db);
    const found = await catalogue.findVersionBinaries("otelcol-contrib", "0.162.0");
    expect(found?.version).toBe("0.162.0");
    expect(found?.otelcolContrib.linux_arm64).toEqual({
      downloadUrl: `${RELEASES}/v0.162.0/otelcol-contrib_0.162.0_linux_arm64.tar.gz`,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(found?.opampSupervisor.linux_amd64?.downloadUrl).toBe(`${RELEASES}/cmd%2Fopampsupervisor%2Fv0.162.0/opampsupervisor_0.162.0_linux_amd64`);
    expect((await catalogue.findVersionBinaries("otelcol-contrib", "0.158.0"))?.version).toBe("0.158.0");
    expect(await catalogue.findVersionBinaries("otelcol-contrib", "9.9.9")).toBeUndefined();
    expect(await catalogue.findVersionBinaries("no-such-distribution", "0.162.0")).toBeUndefined();
  });

  it("lists the offered versions' binaries, newest first by number, never a deprecated one", async () => {
    const catalogue = createCollectorCatalogueRepository(db);
    const offered = await catalogue.listOfferedBinaries("otelcol-contrib");
    const committed = (await db.selectFrom("collector_versions").select(["version", "deprecated"]).where("distribution", "=", "otelcol-contrib").execute())
      .filter((row) => !row.deprecated)
      .map((row) => row.version)
      .sort((left, right) => {
        const [a, b] = [left, right].map((version) => version.split(".").map(Number)) as [number[], number[]];
        return b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!;
      });
    expect(offered.map((version) => version.version)).toEqual(committed);
    expect(committed.length).toBeGreaterThan(1);
    expect(offered.every((version) => version.opampSupervisor.linux_arm64 !== undefined)).toBe(true);
    expect(offered.map((version) => version.version)).not.toContain("0.158.0");
    expect(await catalogue.listOfferedBinaries("no-such-distribution")).toEqual([]);
  });
});
