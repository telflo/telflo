import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_CATALOGUE_DIRECTORY,
  COLLECTOR_PLATFORMS,
  CollectorCatalogueError,
  readCollectorCatalogueFiles,
  upstreamDownloadUrl,
  validateCollectorCatalogue,
  type CatalogueDistribution,
  type CatalogueFile,
  type CatalogueRenamedType,
  type CatalogueVersion,
} from "./catalogue.js";

/*
 * The catalogue's validator: its eleven rules, and checks (a) to (h), each
 * refused on its own; and the committed catalogue passes.
 */

/** Both binaries for every platform, at upstream's URLs for `version`. */
function binaries(version: string): Pick<CatalogueVersion, "otelcolContrib" | "opampSupervisor"> {
  const map = (binary: "otelcolContrib" | "opampSupervisor") =>
    Object.fromEntries(
      COLLECTOR_PLATFORMS.map((platform) => [
        platform,
        { downloadUrl: upstreamDownloadUrl(binary, version, platform), sha256: "a".repeat(64) },
      ]),
    );
  return { otelcolContrib: map("otelcolContrib"), opampSupervisor: map("opampSupervisor") };
}

/** A valid Contrib version entry. */
function entry(overrides: Partial<CatalogueVersion> & { version: string }): CatalogueVersion {
  return {
    label: `v${overrides.version}`,
    description: null,
    releasedAt: "2026-01-01",
    default: false,
    deprecated: false,
    deprecatedNote: null,
    containerImage: `otel/opentelemetry-collector-contrib:${overrides.version}`,
    distribution: "otelcol-contrib",
    otelcolContribVersion: null,
    supportedComponents: null,
    ...binaries(overrides.version),
    ...overrides,
  };
}

/** A distribution's file around `versions`: Contrib, the default, unless overridden. */
function distribution(
  versions: CatalogueVersion[],
  overrides: Partial<CatalogueDistribution> = {},
): CatalogueDistribution {
  return {
    distribution: "otelcol-contrib",
    label: "OpenTelemetry Collector Contrib",
    description: null,
    icon: null,
    sortOrder: 0,
    default: true,
    renamedTypes: [],
    versions,
    ...overrides,
  };
}

/** Files named after their distributions. */
function filesOf(...distributions: unknown[]): CatalogueFile[] {
  return distributions.map((content) => ({
    name: `${(content as { distribution: string }).distribution}.json`,
    content,
  }));
}

/** A container-only distribution built on Contrib `base`, such as ClickStack. */
function containerOnly(base: string, overrides: Partial<CatalogueVersion> = {}): CatalogueDistribution {
  const version: CatalogueVersion = {
    version: "2.36.0",
    label: "v2.36.0",
    description: null,
    releasedAt: "2026-01-01",
    default: true,
    deprecated: false,
    deprecatedNote: null,
    containerImage: "clickhouse/clickstack-otel-collector:2.36.0",
    distribution: "clickstack",
    otelcolContribVersion: base,
    supportedComponents: {
      receivers: ["otlp"],
      processors: ["batch"],
      exporters: ["clickhouse"],
      connectors: ["routing"],
      extensions: ["health_check"],
    },
    ...overrides,
  };
  return distribution([version], { distribution: "clickstack", label: "ClickStack", sortOrder: 1, default: false });
}

/** Every problem the validator reports for `files` (none when it passes). */
function problemsOf(files: CatalogueFile[]): readonly string[] {
  try {
    validateCollectorCatalogue(files);
  } catch (error) {
    if (error instanceof CollectorCatalogueError) return error.problems;
    throw error;
  }
  return [];
}

/** Expects the validator to refuse `files` with a problem containing `needle`. */
function expectRefused(files: CatalogueFile[], needle: string | RegExp): void {
  let caught: unknown;
  try {
    validateCollectorCatalogue(files);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CollectorCatalogueError);
  const problems = (caught as CollectorCatalogueError).problems;
  expect(
    problems.some((problem) => (typeof needle === "string" ? problem.includes(needle) : needle.test(problem))),
    JSON.stringify(problems),
  ).toBe(true);
}

describe("the collector catalogue's validator", () => {
  it("passes a valid single-distribution catalogue", () => {
    expect(
      validateCollectorCatalogue(filesOf(distribution([entry({ version: "0.147.0", default: true })]))),
    ).toHaveLength(1);
  });

  describe("the eleven rules", () => {
    it("1: refuses an empty catalogue", () => {
      expectRefused([], "no distribution file");
    });

    it("2: refuses no default distribution, and two", () => {
      const version = entry({ version: "0.147.0", default: true });
      expectRefused(
        filesOf(distribution([version], { default: false })),
        "exactly one distribution must be the default; found 0",
      );
      expectRefused(
        filesOf(distribution([version]), { ...containerOnly("0.147.0"), default: true }),
        "exactly one distribution must be the default; found 2",
      );
    });

    it("3: refuses a distribution with no default version, and with two", () => {
      expectRefused(
        filesOf(distribution([entry({ version: "0.147.0" })])),
        "exactly one non-deprecated version must be the default; found 0",
      );
      expectRefused(
        filesOf(
          distribution([entry({ version: "0.147.0", default: true }), entry({ version: "0.145.0", default: true })]),
        ),
        "found 2 (0.147.0, 0.145.0)",
      );
    });

    it("4: refuses a version that isn't major.minor.patch", () => {
      expectRefused(filesOf(distribution([entry({ version: "0.147", default: true })])), "must be major.minor.patch");
    });

    it("refuses a version over 64 characters, as the contracts and the opamp-server do, and accepts one of 64", () => {
      const longest = `0.0.${"1".repeat(60)}`;
      expect(longest).toHaveLength(64);
      const atTheCap = filesOf(distribution([entry({ version: longest, default: true })]));
      expect(() => validateCollectorCatalogue(atTheCap)).not.toThrow();
      expectRefused(
        filesOf(distribution([entry({ version: `${longest}1`, default: true })])),
        "must be major.minor.patch, at most 64 characters",
      );
    });

    it("5: refuses a version listed twice", () => {
      expectRefused(
        filesOf(distribution([entry({ version: "0.147.0", default: true }), entry({ version: "0.147.0" })])),
        "listed twice",
      );
    });

    it("6: refuses a non-Contrib version whose otelcolContribVersion is missing, unknown or deprecated, and accepts a live one", () => {
      const contrib = distribution([
        entry({ version: "0.147.0", default: true }),
        entry({ version: "0.146.0", deprecated: true, deprecatedNote: "Superseded." }),
      ]);
      for (const base of ["0.140.0", "0.146.0"]) {
        expectRefused(filesOf(contrib, containerOnly(base)), "must name a non-deprecated otelcol-contrib version");
      }
      expectRefused(
        filesOf(contrib, containerOnly("0.147.0", { otelcolContribVersion: null })),
        "must name a non-deprecated otelcol-contrib version",
      );
      expect(validateCollectorCatalogue(filesOf(contrib, containerOnly("0.147.0")))).toHaveLength(2);
    });

    it("7: refuses an offered version with an invalid containerImage", () => {
      expectRefused(
        filesOf(distribution([entry({ version: "0.147.0", default: true, containerImage: "NOT A VALID IMAGE" })])),
        "invalid containerImage",
      );
    });

    it("8: refuses a container-only version without a valid otelcolContribVersion", () => {
      // Contrib itself is exempt from rule 6, so a container-only Contrib entry reaches rule 8 alone.
      const {
        otelcolContrib: _contrib,
        opampSupervisor: _supervisor,
        ...withoutBinaries
      } = entry({
        version: "0.147.0",
        default: true,
      });
      expectRefused(
        filesOf(
          distribution([
            { ...withoutBinaries, supportedComponents: containerOnly("0.147.0").versions[0]!.supportedComponents },
          ]),
        ),
        "a container-only version needs a valid otelcolContribVersion",
      );
    });

    it("9: refuses a container-only version without supportedComponents, or with an empty section, and allows one with no binaries", () => {
      const contrib = distribution([entry({ version: "0.147.0", default: true })]);
      expectRefused(
        filesOf(contrib, containerOnly("0.147.0", { supportedComponents: null })),
        "a container-only version needs its supportedComponents",
      );
      const empty = { ...containerOnly("0.147.0").versions[0]!.supportedComponents!, connectors: [] };
      expectRefused(
        filesOf(contrib, containerOnly("0.147.0", { supportedComponents: empty })),
        "supportedComponents.connectors must not be empty",
      );
      expect(validateCollectorCatalogue(filesOf(contrib, containerOnly("0.147.0")))).toHaveLength(2);
    });

    it("10: refuses an offered binary version missing a platform of either binary; a deprecated one may have gaps", () => {
      const missing = entry({ version: "0.147.0", default: true });
      delete missing.opampSupervisor!.windows_amd64;
      expectRefused(filesOf(distribution([missing])), "opampSupervisor is missing platform windows_amd64");

      const gappy = entry({ version: "0.146.0", deprecated: true, deprecatedNote: "Upstream skipped a build." });
      gappy.opampSupervisor = {};
      expect(
        validateCollectorCatalogue(filesOf(distribution([entry({ version: "0.147.0", default: true }), gappy]))),
      ).toHaveLength(1);
    });

    it("11: refuses a download URL off GitHub, and a malformed sha256, a deprecated version's present ones included", () => {
      const offGithub = entry({ version: "0.147.0", default: true });
      offGithub.otelcolContrib!.linux_amd64!.downloadUrl = "https://evil.example/x";
      expectRefused(filesOf(distribution([offGithub])), "otelcolContrib.linux_amd64 has an unsafe downloadUrl");

      const badSha = entry({ version: "0.147.0", default: true });
      badSha.otelcolContrib!.linux_amd64!.sha256 = "deadbeef";
      expectRefused(filesOf(distribution([badSha])), "otelcolContrib.linux_amd64 has an invalid sha256");

      const upperSha = entry({ version: "0.147.0", default: true });
      upperSha.opampSupervisor!.darwin_arm64!.sha256 = "A".repeat(64);
      expectRefused(filesOf(distribution([upperSha])), "opampSupervisor.darwin_arm64 has an invalid sha256");

      const deprecated = entry({ version: "0.146.0", deprecated: true, deprecatedNote: "Superseded." });
      deprecated.otelcolContrib!.linux_amd64!.sha256 = "deadbeef";
      expectRefused(
        filesOf(distribution([entry({ version: "0.147.0", default: true }), deprecated])),
        'version "0.146.0": otelcolContrib.linux_amd64 has an invalid sha256',
      );
    });
  });

  describe("the further checks, (a) to (h)", () => {
    it("(a) refuses a GitHub download URL that isn't upstream's release of the entry's own version and platform", () => {
      const otherRepository = entry({ version: "0.147.0", default: true });
      otherRepository.otelcolContrib!.linux_amd64!.downloadUrl =
        "https://github.com/someone/fork/releases/download/v0.147.0/otelcol-contrib_0.147.0_linux_amd64.tar.gz";
      expectRefused(
        filesOf(distribution([otherRepository])),
        "must be upstream's release of this version and platform",
      );

      const otherVersion = entry({ version: "0.147.0", default: true });
      otherVersion.otelcolContrib!.linux_amd64!.downloadUrl = upstreamDownloadUrl(
        "otelcolContrib",
        "0.146.0",
        "linux_amd64",
      );
      expectRefused(
        filesOf(distribution([otherVersion])),
        "otelcolContrib.linux_amd64 downloadUrl must be upstream's release",
      );

      const otherPlatform = entry({ version: "0.147.0", default: true });
      otherPlatform.opampSupervisor!.windows_amd64!.downloadUrl = upstreamDownloadUrl(
        "opampSupervisor",
        "0.147.0",
        "linux_amd64",
      );
      expectRefused(
        filesOf(distribution([otherPlatform])),
        "opampSupervisor.windows_amd64 downloadUrl must be upstream's release",
      );
    });

    it("(b) refuses a deprecated version without its deprecatedNote", () => {
      for (const deprecatedNote of [null, "", "  "]) {
        expectRefused(
          filesOf(
            distribution([
              entry({ version: "0.147.0", default: true }),
              entry({ version: "0.146.0", deprecated: true, deprecatedNote }),
            ]),
          ),
          "a deprecated version needs its deprecatedNote",
        );
      }
    });

    it("(c) refuses a deprecated default version", () => {
      expectRefused(
        filesOf(
          distribution([
            entry({ version: "0.147.0", default: true }),
            entry({ version: "0.146.0", default: true, deprecated: true, deprecatedNote: "Superseded." }),
          ]),
        ),
        "the default version can't be deprecated",
      );
    });

    it("(d) refuses a malformed distribution id, a file not named after its distribution, and a version of another distribution", () => {
      const version = entry({ version: "0.147.0", default: true });
      for (const id of ["Otelcol-Contrib", "otelcol_contrib", "-contrib", "contrib-", "a".repeat(65)]) {
        expectRefused(
          filesOf(distribution([{ ...version, distribution: id }], { distribution: id })),
          "must be lowercase words joined by hyphens",
        );
      }
      expectRefused(
        [{ name: "contrib.json", content: distribution([version]) }],
        "a distribution's file is named after it, otelcol-contrib.json",
      );
      expectRefused(
        filesOf(distribution([{ ...version, distribution: "clickstack" }])),
        'its distribution "clickstack" is not its file\'s',
      );
      expectRefused(
        filesOf(distribution([version]), distribution([version])),
        "the distribution otelcol-contrib is in more than one file",
      );
    });

    it("(e) refuses a releasedAt that isn't a real YYYY-MM-DD date", () => {
      for (const releasedAt of ["2026-02-30", "2026-13-01", "2026-9-29", "29/09/2026", "2026-09-29T00:00:00Z"]) {
        expectRefused(
          filesOf(distribution([entry({ version: "0.147.0", default: true, releasedAt })])),
          "is not a real YYYY-MM-DD date",
        );
      }
      expect(
        validateCollectorCatalogue(
          filesOf(distribution([entry({ version: "0.147.0", default: true, releasedAt: "2028-02-29" })])),
        ),
      ).toHaveLength(1);
    });

    it("(f) refuses an empty label, a version's or a distribution's", () => {
      expectRefused(
        filesOf(distribution([entry({ version: "0.147.0", default: true, label: " " })])),
        "the label is empty",
      );
      expectRefused(
        filesOf(distribution([entry({ version: "0.147.0", default: true })], { label: "" })),
        "the distribution's label is empty",
      );
    });

    it("(g) refuses an unknown key: in a distribution, a version, a binary map and a download", () => {
      const version = entry({ version: "0.147.0", default: true });
      expectRefused(
        filesOf({ ...distribution([version]), image: "x" }),
        /otelcol-contrib\.json: Unrecognized key\(s\) in object: 'image'/,
      );
      expectRefused(
        filesOf(distribution([{ ...version, imageDigest: "x" } as CatalogueVersion])),
        "at versions.0: Unrecognized key(s) in object: 'imageDigest'",
      );
      const extraPlatform = entry({ version: "0.147.0", default: true });
      (extraPlatform.otelcolContrib as Record<string, unknown>).linux_s390x = extraPlatform.otelcolContrib!.linux_amd64;
      expectRefused(
        filesOf(distribution([extraPlatform])),
        "at versions.0.otelcolContrib: Unrecognized key(s) in object: 'linux_s390x'",
      );
      const extraField = entry({ version: "0.147.0", default: true });
      (extraField.otelcolContrib!.linux_amd64 as Record<string, unknown>).md5 = "x";
      expectRefused(
        filesOf(distribution([extraField])),
        "at versions.0.otelcolContrib.linux_amd64: Unrecognized key(s) in object: 'md5'",
      );
      // And every field's type: a string default is no boolean.
      expectRefused(
        filesOf({ ...distribution([version]), default: "true" }),
        "at default: Expected boolean, received string",
      );
    });

    it("(h) refuses supportedComponents with a section missing or an unknown one", () => {
      const contrib = distribution([entry({ version: "0.147.0", default: true })]);
      const { extensions: _extensions, ...fourSections } = containerOnly("0.147.0").versions[0]!.supportedComponents!;
      expectRefused(
        filesOf(contrib, containerOnly("0.147.0", { supportedComponents: fourSections as never })),
        "at versions.0.supportedComponents.extensions: Required",
      );
      expectRefused(
        filesOf(
          contrib,
          containerOnly("0.147.0", {
            supportedComponents: { ...fourSections, extensions: [], pipelines: [] } as never,
          }),
        ),
        "Unrecognized key(s) in object: 'pipelines'",
      );
    });
  });

  describe("the collector's renames", () => {
    const FILE_LOG: CatalogueRenamedType = {
      kind: "receiver",
      name: "file_log",
      deprecatedName: "filelog",
      since: "0.149.0",
    };
    const OTLP_GRPC: CatalogueRenamedType = {
      kind: "exporter",
      name: "otlp_grpc",
      deprecatedName: "otlp",
      since: "0.144.0",
    };
    const version = entry({ version: "0.147.0", default: true });
    /** Contrib's file with `renamedTypes`. */
    const withRenames = (renamedTypes: unknown[]) =>
      filesOf(distribution([version], { renamedTypes: renamedTypes as CatalogueRenamedType[] }));

    it("passes renames of each kind, none, a since the file doesn't offer, and one name renamed in two kinds", () => {
      for (const kind of ["receiver", "processor", "exporter", "connector", "extension"] as const) {
        expect(() => validateCollectorCatalogue(withRenames([{ ...FILE_LOG, kind }]))).not.toThrow();
      }
      expect(() => validateCollectorCatalogue(withRenames([]))).not.toThrow();
      expect(() => validateCollectorCatalogue(withRenames([{ ...FILE_LOG, since: "9.0.0" }]))).not.toThrow();
      expect(() =>
        validateCollectorCatalogue(withRenames([FILE_LOG, { ...FILE_LOG, kind: "exporter", deprecatedName: "fileexp" }])),
      ).not.toThrow();
      const [contrib] = validateCollectorCatalogue(withRenames([FILE_LOG, OTLP_GRPC]));
      expect(contrib!.renamedTypes).toEqual([FILE_LOG, OTLP_GRPC]);
    });

    it("refuses a file without renamedTypes, and one that isn't a list", () => {
      const { renamedTypes: _renamedTypes, ...without } = distribution([version]);
      expectRefused(filesOf(without), "otelcol-contrib.json at renamedTypes: Required");
      expectRefused(filesOf({ ...distribution([version]), renamedTypes: {} }), "at renamedTypes: Expected array");
    });

    it("refuses an unknown kind, a plural one, an unknown field and a missing one", () => {
      expectRefused(withRenames([{ ...FILE_LOG, kind: "pipeline" }]), "at renamedTypes.0.kind: Invalid enum value");
      expectRefused(withRenames([{ ...FILE_LOG, kind: "receivers" }]), "at renamedTypes.0.kind: Invalid enum value");
      expectRefused(
        withRenames([{ ...FILE_LOG, note: "x" }]),
        "at renamedTypes.0: Unrecognized key(s) in object: 'note'",
      );
      const { since: _since, ...withoutSince } = FILE_LOG;
      expectRefused(withRenames([withoutSince]), "at renamedTypes.0.since: Required");
    });

    it("refuses a malformed name or deprecatedName, and accepts one of 64 characters", () => {
      for (const name of ["File_log", "1filelog", "_filelog", "file-log", "file.log", "", "a".repeat(65)]) {
        expectRefused(withRenames([{ ...FILE_LOG, name }]), `name ${JSON.stringify(name)} must be a lowercase letter`);
        expectRefused(
          withRenames([{ ...FILE_LOG, deprecatedName: name }]),
          `deprecatedName ${JSON.stringify(name)} must be a lowercase letter`,
        );
      }
      expect(() => validateCollectorCatalogue(withRenames([{ ...FILE_LOG, name: "a".repeat(64) }]))).not.toThrow();
    });

    it("refuses a since that isn't the catalogue's version format", () => {
      for (const since of ["0.149", "v0.149.0", "0.149.0-rc.1", `0.0.${"1".repeat(61)}`, ""]) {
        expectRefused(withRenames([{ ...FILE_LOG, since }]), `since ${JSON.stringify(since)} must be major.minor.patch`);
      }
    });

    it("refuses a name equal to its deprecatedName", () => {
      expectRefused(
        withRenames([{ ...FILE_LOG, deprecatedName: "file_log" }]),
        'renamedTypes.0 (receiver "file_log"): the name and its deprecatedName are the same',
      );
    });

    it("refuses a kind's name renamed twice, and a kind's deprecatedName listed twice", () => {
      expectRefused(
        withRenames([FILE_LOG, { ...FILE_LOG, deprecatedName: "logfile" }]),
        "otelcol-contrib.json: the receiver file_log is renamed twice",
      );
      expectRefused(
        withRenames([FILE_LOG, { ...FILE_LOG, name: "log_file" }]),
        "otelcol-contrib.json: the receiver filelog is a deprecatedName twice",
      );
    });

    it("reports a kind's name renamed twice in one file once: the cross-file rule doesn't compare a file with itself", () => {
      expect(problemsOf(withRenames([FILE_LOG, { ...FILE_LOG, deprecatedName: "logfile" }]))).toEqual([
        "otelcol-contrib.json: the receiver file_log is renamed twice",
      ]);
    });

    it("refuses a chain, a rename's deprecatedName another's name in the same kind, in either order", () => {
      // filelog → file_log, then file_log → log_file: file_log would be both a current and a deprecated name.
      const NEXT: CatalogueRenamedType = { kind: "receiver", name: "log_file", deprecatedName: "file_log", since: "0.170.0" };
      const chained =
        'renamedTypes.1 (receiver "log_file"): its deprecatedName "file_log" is renamedTypes.0\'s name; a rename can\'t chain to another';
      expect(problemsOf(withRenames([FILE_LOG, NEXT]))).toEqual([`otelcol-contrib.json ${chained}`]);
      expect(problemsOf(withRenames([NEXT, FILE_LOG]))).toEqual([
        'otelcol-contrib.json renamedTypes.0 (receiver "log_file"): its deprecatedName "file_log" is renamedTypes.1\'s name; ' +
          "a rename can't chain to another",
      ]);
      // A cycle: each entry's deprecatedName is the other's name.
      expect(
        problemsOf(withRenames([FILE_LOG, { kind: "receiver", name: "filelog", deprecatedName: "file_log", since: "0.150.0" }])),
      ).toEqual([
        'otelcol-contrib.json renamedTypes.0 (receiver "file_log"): its deprecatedName "filelog" is renamedTypes.1\'s name; ' +
          "a rename can't chain to another",
        'otelcol-contrib.json renamedTypes.1 (receiver "filelog"): its deprecatedName "file_log" is renamedTypes.0\'s name; ' +
          "a rename can't chain to another",
      ]);
    });

    it("passes a name that is another kind's deprecatedName: renames are kind-specific", () => {
      // An exporter renamed from file_log is no chain with the receiver renamed to file_log.
      expect(
        problemsOf(withRenames([FILE_LOG, { kind: "exporter", name: "log_file", deprecatedName: "file_log", since: "0.170.0" }])),
      ).toEqual([]);
    });

    it("refuses a kind's name with another deprecatedName in another file, and passes the same rename in both", () => {
      const contrib = distribution([version], { renamedTypes: [FILE_LOG, OTLP_GRPC] });
      const other = (renamedTypes: CatalogueRenamedType[]) => ({ ...containerOnly("0.147.0"), renamedTypes });
      expectRefused(
        filesOf(contrib, other([{ ...FILE_LOG, deprecatedName: "logfile" }])),
        `clickstack.json: the receiver file_log's deprecatedName "logfile" is not otelcol-contrib.json's ("filelog")`,
      );
      expect(validateCollectorCatalogue(filesOf(contrib, other([{ ...FILE_LOG, since: "0.150.0" }])))).toHaveLength(2);
      // Kind-specific: an exporter file_log is another rename.
      expect(
        validateCollectorCatalogue(filesOf(contrib, other([{ ...FILE_LOG, kind: "exporter", deprecatedName: "x" }]))),
      ).toHaveLength(2);
    });
  });

  it("reads only a folder's .json files, refuses one that isn't JSON, naming it, and refuses a missing folder", async () => {
    const folder = await mkdtemp(join(tmpdir(), "telflo-catalogue-"));
    try {
      const directory = pathToFileURL(`${folder}/`);
      await writeFile(join(folder, "README.md"), "# not a distribution\n");
      await writeFile(
        join(folder, "otelcol-contrib.json"),
        JSON.stringify(distribution([entry({ version: "0.147.0", default: true })])),
      );
      expect((await readCollectorCatalogueFiles(directory)).map((file) => file.name)).toEqual(["otelcol-contrib.json"]);

      await writeFile(join(folder, "broken.json"), "{");
      await expect(readCollectorCatalogueFiles(directory)).rejects.toMatchObject({
        problems: [expect.stringMatching(/^broken\.json: not JSON/)],
      });
      // Never an empty catalogue: a folder that isn't there is an error.
      await expect(readCollectorCatalogueFiles(pathToFileURL(`${folder}/missing/`))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("the committed catalogue", () => {
  it("lives where COLLECTOR_CATALOGUE_DIRECTORY points, the repository's catalog/distributions, and holds otelcol-contrib.json", () => {
    const directory = fileURLToPath(COLLECTOR_CATALOGUE_DIRECTORY);
    const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
    expect(relative(repository, directory)).toBe(join("catalog", "distributions"));
    expect(existsSync(join(repository, ".git"))).toBe(true);
    expect(readdirSync(directory)).toContain("otelcol-contrib.json");
  });

  it("passes the validator: Contrib alone, the default, at 0.162.0 by default, offering the four newest and keeping the five it retired, with the collector's 16 renames", async () => {
    const distributions = validateCollectorCatalogue(await readCollectorCatalogueFiles());
    expect(distributions.map((each) => each.distribution)).toEqual(["otelcol-contrib"]);
    const [contrib] = distributions;
    expect(contrib!.default).toBe(true);
    expect(contrib!.versions.filter((version) => version.default).map((version) => version.version)).toEqual([
      "0.162.0",
    ]);
    expect(contrib!.versions.map((version) => version.version)).toEqual([
      "0.162.0",
      "0.161.0",
      "0.160.0",
      "0.159.0",
      "0.158.0",
      "0.157.0",
      "0.156.0",
      "0.155.0",
      "0.147.0",
    ]);
    expect(contrib!.versions.filter((version) => !version.deprecated).map((version) => version.version)).toEqual([
      "0.162.0",
      "0.161.0",
      "0.160.0",
      "0.159.0",
    ]);
    // The collector's renames, as the binaries showed them.
    expect(contrib!.renamedTypes.map(({ kind, name, deprecatedName, since }) => `${kind} ${name} ${deprecatedName} ${since}`)).toEqual([
      "receiver file_log filelog 0.149.0",
      "receiver fluent_forward fluentforward 0.151.0",
      "receiver k8s_objects k8sobjects 0.151.0",
      "receiver kubelet_stats kubeletstats 0.152.0",
      "receiver host_metrics hostmetrics 0.151.0",
      "receiver aws_s3 awss3 0.162.0",
      "processor k8s_attributes k8sattributes 0.146.0",
      "processor resource_detection resourcedetection 0.153.0",
      "processor log_dedup logdedup 0.151.0",
      "processor metrics_transform metricstransform 0.152.0",
      "processor cumulative_to_delta cumulativetodelta 0.157.0",
      "exporter load_balancing loadbalancing 0.153.0",
      "exporter otlp_grpc otlp 0.144.0",
      "exporter otlp_http otlphttp 0.144.0",
      "exporter prometheus_remote_write prometheusremotewrite 0.154.0",
      "connector span_metrics spanmetrics 0.151.0",
    ]);
    // Retired, never deleted: a pin to one keeps resolving.
    expect(
      contrib!.versions
        .filter((version) => version.deprecated)
        .map((version) => [version.version, version.deprecatedNote]),
    ).toEqual(
      ["0.158.0", "0.157.0", "0.156.0", "0.155.0", "0.147.0"].map((version) => [
        version,
        "No longer offered. Pick a newer collector version.",
      ]),
    );
  });
});

describe("the API never reads the catalogue's files", () => {
  /** Every TypeScript source under `directory`, recursively. */
  const sources = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
      return /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
    });

  it("no apps/api source names catalog/ or the catalogue's directory", () => {
    const api = fileURLToPath(new URL("../../../../apps/api/src/", import.meta.url));
    const files = sources(api);
    expect(files.length).toBeGreaterThan(50);
    const readers = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return /catalog\/distributions|["'`/]catalog\/|COLLECTOR_CATALOGUE_DIRECTORY|readCollectorCatalogueFiles|syncCollectorCatalogue/.test(
        text,
      );
    });
    expect(readers).toEqual([]);
  });
});
