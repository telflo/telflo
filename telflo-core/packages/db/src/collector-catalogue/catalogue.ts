import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";

/*
 * The collector catalogue (D13a decision 2): one hand-edited file per
 * distribution, `catalog/distributions/<distribution>.json` at the
 * repository's root, in a fixed format (Preflight ruling 8).
 * The migration step reads it, refuses a malformed one, and upserts it into
 * the two global tables (./sync.ts). Other components read the same files
 * (D13b's validator image, D14's testing image, D18's install scripts), so
 * the folder sits outside telflo-core.
 *
 * The validator's eleven rules are each marked below as "rule N", and it
 * adds Preflight ruling 8's (a) to (h).
 */

/**
 * The folder holding the catalogue's files (Preflight ruling 7): the
 * repository's `catalog/distributions/` in a checkout, and
 * `/catalog/distributions/` in the API image, which the Dockerfile copies
 * there (Preflight ruling 6). Only the migration step reads it: the API
 * process reads the tables, never the files. No setting.
 */
export const COLLECTOR_CATALOGUE_DIRECTORY = new URL("../../../../../catalog/distributions/", import.meta.url);

/** Every platform a binary distribution ships both binaries for, in a fixed order. */
export const COLLECTOR_PLATFORMS = [
  "linux_amd64",
  "linux_arm64",
  "darwin_amd64",
  "darwin_arm64",
  "windows_amd64",
] as const;

export type CollectorPlatform = (typeof COLLECTOR_PLATFORMS)[number];

/** The sections of a configuration a distribution may support components of (D13a decision 6). */
export const SUPPORTED_COMPONENT_SECTIONS = [
  "receivers",
  "processors",
  "exporters",
  "connectors",
  "extensions",
] as const;

/**
 * The kinds a renamed type names (D13b Preflight ruling 16): a section's
 * singular, as the web's `ComponentType` and the contract's
 * `COLLECTOR_COMPONENT_KINDS` spell them.
 */
export const RENAMED_TYPE_KINDS = ["receiver", "processor", "exporter", "connector", "extension"] as const;

/** The distribution whose versions are the base other distributions are built on (rule 6). */
export const CONTRIB_DISTRIBUTION = "otelcol-contrib";

/** Where every download comes from: upstream's releases (Preflight ruling 8 (a)). */
export const UPSTREAM_RELEASES_DOWNLOAD_URL =
  "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/";

/*
 * The allowlists. VERSION and DISTRIBUTION_ID
 * are the opamp-server's formats too (`[0-9]`, not `\d`, so Go, ajv and
 * Postgres agree; Preflight ruling 5).
 */
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9._%/+-]+$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+(@sha256:[a-f0-9]{64})?$/;
const DISTRIBUTION_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DISTRIBUTION_ID_MAXIMUM_LENGTH = 64;
/** A version's cap, as the contracts, the opamp-server's API and its migration 00003 cap it. */
const VERSION_MAXIMUM_LENGTH = 64;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
/** A component type's name as the collector spells it (`file_log`, `filelog`): D13b Preflight ruling 16. */
const COMPONENT_TYPE_NAME = /^[a-z][a-z0-9_]*$/;
const COMPONENT_TYPE_NAME_MAXIMUM_LENGTH = 64;

/** One binary of one platform: where upstream publishes it, and its sha256. */
const PlatformBinarySchema = z.object({ downloadUrl: z.string(), sha256: z.string() }).strict();

/**
 * A binary's downloads by platform. Each platform may be absent (a
 * deprecated version upstream skipped a build of, rule 10);
 * any other key is refused (ruling 8 (g)).
 */
const PlatformBinariesSchema = z
  .object(
    Object.fromEntries(COLLECTOR_PLATFORMS.map((platform) => [platform, PlatformBinarySchema.optional()])) as Record<
      CollectorPlatform,
      z.ZodOptional<typeof PlatformBinarySchema>
    >,
  )
  .strict();

/** Exactly the five sections, each a list of component names (ruling 8 (h)). */
const SupportedComponentsSchema = z
  .object(
    Object.fromEntries(SUPPORTED_COMPONENT_SECTIONS.map((section) => [section, z.array(z.string().min(1))])) as Record<
      (typeof SUPPORTED_COMPONENT_SECTIONS)[number],
      z.ZodArray<z.ZodString>
    >,
  )
  .strict();

/** One version of a distribution. */
const CatalogueVersionSchema = z
  .object({
    version: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    releasedAt: z.string(),
    default: z.boolean(),
    deprecated: z.boolean(),
    deprecatedNote: z.string().nullable(),
    containerImage: z.string(),
    distribution: z.string(),
    /** The Contrib release a non-Contrib build is based on; null for Contrib itself. */
    otelcolContribVersion: z.string().nullable(),
    /** Null: the full palette (Contrib). */
    supportedComponents: SupportedComponentsSchema.nullable(),
    /** Both absent: a container-only distribution, which ships no binaries. */
    otelcolContrib: PlatformBinariesSchema.optional(),
    opampSupervisor: PlatformBinariesSchema.optional(),
  })
  .strict();

/**
 * One of the collector's renames (D13b decision 6, Preflight rulings 5, 15
 * and 16): from upstream's `since` on, the `kind` of component
 * `deprecatedName` is called `name`, the old name kept as a deprecated
 * alias. Every rename is kind-specific.
 */
const CatalogueRenamedTypeSchema = z
  .object({
    kind: z.enum(RENAMED_TYPE_KINDS),
    name: z.string(),
    deprecatedName: z.string(),
    since: z.string(),
  })
  .strict();

/**
 * One file: a distribution and its versions, and the collector's renames
 * (D13b decision 6): required, `[]` when there are none (Preflight ruling
 * 16).
 */
const CatalogueDistributionSchema = z
  .object({
    distribution: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    sortOrder: z.number().int(),
    default: z.boolean(),
    renamedTypes: z.array(CatalogueRenamedTypeSchema),
    versions: z.array(CatalogueVersionSchema),
  })
  .strict();

export type CatalogueVersion = z.infer<typeof CatalogueVersionSchema>;
export type CatalogueRenamedType = z.infer<typeof CatalogueRenamedTypeSchema>;
export type CatalogueDistribution = z.infer<typeof CatalogueDistributionSchema>;
export type PlatformBinaries = z.infer<typeof PlatformBinariesSchema>;
export type SupportedComponents = z.infer<typeof SupportedComponentsSchema>;

/** One catalogue file as read: its name in the folder, and its parsed JSON, not yet validated. */
export interface CatalogueFile {
  name: string;
  content: unknown;
}

/**
 * A catalogue that failed its validator, or couldn't be read. `problems`
 * lists every rule it breaks; the message lists them too.
 */
export class CollectorCatalogueError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The collector catalogue is invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "CollectorCatalogueError";
    this.problems = problems;
  }
}

/**
 * Reads every `.json` file in `directory`, sorted by name, and parses it.
 * Other files are skipped. A file that isn't JSON is a
 * `CollectorCatalogueError` naming it; validating the rest is
 * `validateCollectorCatalogue`'s.
 */
export async function readCollectorCatalogueFiles(
  directory: URL = COLLECTOR_CATALOGUE_DIRECTORY,
): Promise<CatalogueFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const files: CatalogueFile[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const text = await readFile(new URL(name, directory), "utf8");
    try {
      files.push({ name, content: JSON.parse(text) });
    } catch (error) {
      problems.push(`${name}: not JSON (${(error as Error).message})`);
    }
  }
  if (problems.length > 0) throw new CollectorCatalogueError(problems);
  return files;
}

/** Whether `text` is a `YYYY-MM-DD` date that exists (ruling 8 (e)). */
function isRealDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The URL upstream publishes `binary` of `version` for `platform` at
 * (ruling 8 (a)): upstream's patterns, the supervisor's tag
 * `cmd/opampsupervisor/v<version>` URL-encoded, and `.exe` on Windows.
 */
export function upstreamDownloadUrl(
  binary: "otelcolContrib" | "opampSupervisor",
  version: string,
  platform: CollectorPlatform,
): string {
  if (binary === "otelcolContrib") {
    return `${UPSTREAM_RELEASES_DOWNLOAD_URL}v${version}/otelcol-contrib_${version}_${platform}.tar.gz`;
  }
  const extension = platform.startsWith("windows_") ? ".exe" : "";
  return `${UPSTREAM_RELEASES_DOWNLOAD_URL}cmd%2Fopampsupervisor%2Fv${version}/opampsupervisor_${version}_${platform}${extension}`;
}

/** The problems of one version's entry, in its distribution's file. */
function versionProblems(
  where: string,
  distribution: string,
  entry: CatalogueVersion,
  liveContribVersions: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const at = `${where} version ${JSON.stringify(entry.version)}`;

  // Rule 4: major.minor.patch; and at most 64 characters, as
  // everything downstream of the catalogue caps it (D13a Ruling 38).
  if (!VERSION.test(entry.version) || entry.version.length > VERSION_MAXIMUM_LENGTH) {
    problems.push(`${at}: the version must be major.minor.patch, at most ${VERSION_MAXIMUM_LENGTH} characters`);
  }
  // Ruling 8 (f): a label to show.
  if (entry.label.trim() === "") problems.push(`${at}: the label is empty`);
  // Ruling 8 (e): a real date.
  if (!isRealDate(entry.releasedAt)) {
    problems.push(`${at}: releasedAt ${JSON.stringify(entry.releasedAt)} is not a real YYYY-MM-DD date`);
  }
  // Ruling 8 (d): the version is its file's distribution's.
  if (entry.distribution !== distribution) {
    problems.push(`${at}: its distribution ${JSON.stringify(entry.distribution)} is not its file's (${distribution})`);
  }
  // Ruling 8 (b): a deprecated version says why (decision 4 shows the note).
  if (entry.deprecated && (entry.deprecatedNote === null || entry.deprecatedNote.trim() === "")) {
    problems.push(`${at}: a deprecated version needs its deprecatedNote`);
  }
  // Ruling 8 (c): the default is offered, so it can't be deprecated.
  if (entry.default && entry.deprecated) problems.push(`${at}: the default version can't be deprecated`);

  // Rule 6: a non-Contrib build names a live Contrib base.
  if (
    distribution !== CONTRIB_DISTRIBUTION &&
    (entry.otelcolContribVersion === null || !liveContribVersions.has(entry.otelcolContribVersion))
  ) {
    problems.push(
      `${at}: otelcolContribVersion ${JSON.stringify(entry.otelcolContribVersion)} must name a non-deprecated ` +
        `${CONTRIB_DISTRIBUTION} version`,
    );
  }

  const isContainerOnly = entry.otelcolContrib === undefined && entry.opampSupervisor === undefined;
  if (!entry.deprecated) {
    // Rule 7: an offered version's image is a valid image name.
    if (!IMAGE.test(entry.containerImage)) {
      problems.push(`${at}: invalid containerImage ${JSON.stringify(entry.containerImage)}`);
    }
    if (isContainerOnly) {
      // Rule 8: a container-only build names its Contrib base.
      if (entry.otelcolContribVersion === null || !VERSION.test(entry.otelcolContribVersion)) {
        problems.push(`${at}: a container-only version needs a valid otelcolContribVersion`);
      }
      // Rule 9: and lists what it supports, every section.
      if (entry.supportedComponents === null) {
        problems.push(`${at}: a container-only version needs its supportedComponents`);
      } else {
        for (const section of SUPPORTED_COMPONENT_SECTIONS) {
          if (entry.supportedComponents[section].length === 0) {
            problems.push(`${at}: supportedComponents.${section} must not be empty`);
          }
        }
      }
    }
  }

  for (const binary of ["otelcolContrib", "opampSupervisor"] as const) {
    const binaries = entry[binary];
    for (const platform of COLLECTOR_PLATFORMS) {
      const download = binaries?.[platform];
      if (download === undefined) {
        // Rule 10: an offered binary version ships both
        // binaries for every platform; a deprecated one may have gaps.
        if (!entry.deprecated && !isContainerOnly) {
          problems.push(`${at}: ${binary} is missing platform ${platform}`);
        }
        continue;
      }
      // Rule 11: what is there is a GitHub URL and a sha256,
      // deprecated or not.
      if (!GITHUB_URL.test(download.downloadUrl)) {
        problems.push(`${at}: ${binary}.${platform} has an unsafe downloadUrl ${JSON.stringify(download.downloadUrl)}`);
      } else if (download.downloadUrl !== upstreamDownloadUrl(binary, entry.version, platform)) {
        // Ruling 8 (a): upstream's release of this very version and platform.
        problems.push(
          `${at}: ${binary}.${platform} downloadUrl must be upstream's release of this version and platform, ` +
            upstreamDownloadUrl(binary, entry.version, platform),
        );
      }
      if (!SHA256.test(download.sha256)) {
        problems.push(`${at}: ${binary}.${platform} has an invalid sha256 ${JSON.stringify(download.sha256)}`);
      }
    }
  }
  return problems;
}

/**
 * The problems of one distribution's renames (D13b Preflight ruling 16):
 * well-formed names and `since`, a name that is a rename, each kind's
 * current and deprecated names listed once, and no chain (Ruling 52): a
 * kind's deprecatedName is never another of its renames' current name, in
 * either order in the file, since the palette writes one rename's current
 * name for its deprecated one and a chain would leave a name both.
 */
function renamedTypeProblems(where: string, renamedTypes: readonly CatalogueRenamedType[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const deprecatedNames = new Set<string>();
  renamedTypes.forEach((entry, index) => {
    const at = `${where} renamedTypes.${index} (${entry.kind} ${JSON.stringify(entry.name)})`;
    for (const field of ["name", "deprecatedName"] as const) {
      if (!COMPONENT_TYPE_NAME.test(entry[field]) || entry[field].length > COMPONENT_TYPE_NAME_MAXIMUM_LENGTH) {
        problems.push(
          `${at}: ${field} ${JSON.stringify(entry[field])} must be a lowercase letter, then lowercase letters, ` +
            `digits or _, at most ${COMPONENT_TYPE_NAME_MAXIMUM_LENGTH} characters`,
        );
      }
    }
    if (!VERSION.test(entry.since) || entry.since.length > VERSION_MAXIMUM_LENGTH) {
      problems.push(
        `${at}: since ${JSON.stringify(entry.since)} must be major.minor.patch, at most ${VERSION_MAXIMUM_LENGTH} characters`,
      );
    }
    if (entry.name === entry.deprecatedName) problems.push(`${at}: the name and its deprecatedName are the same`);
    const name = `${entry.kind} ${entry.name}`;
    if (names.has(name)) problems.push(`${where}: the ${entry.kind} ${entry.name} is renamed twice`);
    names.add(name);
    const deprecatedName = `${entry.kind} ${entry.deprecatedName}`;
    if (deprecatedNames.has(deprecatedName)) {
      problems.push(`${where}: the ${entry.kind} ${entry.deprecatedName} is a deprecatedName twice`);
    }
    deprecatedNames.add(deprecatedName);
  });
  renamedTypes.forEach((entry, index) => {
    const chained = renamedTypes.findIndex(
      (other, otherIndex) => otherIndex !== index && other.kind === entry.kind && other.name === entry.deprecatedName,
    );
    if (chained === -1) return;
    problems.push(
      `${where} renamedTypes.${index} (${entry.kind} ${JSON.stringify(entry.name)}): its deprecatedName ` +
        `${JSON.stringify(entry.deprecatedName)} is renamedTypes.${chained}'s name; a rename can't chain to another`,
    );
  });
  return problems;
}

/**
 * Validates the catalogue's files and returns their distributions, sorted
 * as the catalogue orders them (`sortOrder`, then id). Throws a
 * `CollectorCatalogueError` listing every problem: the sync writes nothing
 * from a catalogue that has one.
 */
export function validateCollectorCatalogue(files: readonly CatalogueFile[]): CatalogueDistribution[] {
  const problems: string[] = [];
  // Rule 1: there is a catalogue.
  if (files.length === 0) throw new CollectorCatalogueError(["the catalogue has no distribution file"]);

  const distributions: CatalogueDistribution[] = [];
  for (const file of files) {
    // Ruling 8 (g) and (h), and every field's type: the shape first.
    const parsed = CatalogueDistributionSchema.safeParse(file.content);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
        problems.push(`${file.name}${path}: ${issue.message}`);
      }
      continue;
    }
    const distribution = parsed.data;
    // Ruling 8 (d): a well-formed id, and the file named after it.
    if (
      !DISTRIBUTION_ID.test(distribution.distribution) ||
      distribution.distribution.length > DISTRIBUTION_ID_MAXIMUM_LENGTH
    ) {
      problems.push(
        `${file.name}: the distribution id ${JSON.stringify(distribution.distribution)} must be lowercase words ` +
          `joined by hyphens, at most ${DISTRIBUTION_ID_MAXIMUM_LENGTH} characters`,
      );
    }
    if (file.name !== `${distribution.distribution}.json`) {
      problems.push(`${file.name}: a distribution's file is named after it, ${distribution.distribution}.json`);
    }
    // Ruling 8 (f).
    if (distribution.label.trim() === "") problems.push(`${file.name}: the distribution's label is empty`);
    distributions.push(distribution);
  }
  if (problems.length > 0) throw new CollectorCatalogueError(problems);

  const ids = distributions.map((distribution) => distribution.distribution);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) {
    problems.push(`the distribution ${id} is in more than one file`);
  }

  // Rule 2: exactly one distribution is new configurations' default.
  const defaultDistributions = distributions.filter((distribution) => distribution.default);
  if (defaultDistributions.length !== 1) {
    problems.push(
      `exactly one distribution must be the default; found ${defaultDistributions.length}` +
        (defaultDistributions.length > 0 ? ` (${defaultDistributions.map((d) => d.distribution).join(", ")})` : ""),
    );
  }

  const liveContribVersions = new Set(
    distributions
      .filter((distribution) => distribution.distribution === CONTRIB_DISTRIBUTION)
      .flatMap((distribution) => distribution.versions)
      .filter((entry) => !entry.deprecated)
      .map((entry) => entry.version),
  );

  for (const distribution of distributions) {
    const where = `${distribution.distribution}.json`;
    // Rule 3: exactly one offered default version.
    const defaults = distribution.versions.filter((entry) => !entry.deprecated && entry.default);
    if (defaults.length !== 1) {
      problems.push(
        `${where}: exactly one non-deprecated version must be the default; found ${defaults.length}` +
          (defaults.length > 0 ? ` (${defaults.map((entry) => entry.version).join(", ")})` : ""),
      );
    }
    problems.push(...renamedTypeProblems(where, distribution.renamedTypes));
    const seen = new Set<string>();
    for (const entry of distribution.versions) {
      // Rule 5: each version once.
      if (seen.has(entry.version)) problems.push(`${where}: the version ${entry.version} is listed twice`);
      seen.add(entry.version);
      problems.push(...versionProblems(where, distribution.distribution, entry, liveContribVersions));
    }
  }

  // D13b Preflight ruling 15: the web's table of renames is the union of
  // every file's, so a kind's current name has one deprecated name across
  // the files. A file isn't compared with itself: a name renamed twice in
  // one file is reported once, as that (Ruling 53).
  const deprecatedNameOf = new Map<string, { deprecatedName: string; file: string }>();
  for (const distribution of distributions) {
    const file = `${distribution.distribution}.json`;
    for (const entry of distribution.renamedTypes) {
      const name = `${entry.kind} ${entry.name}`;
      const seen = deprecatedNameOf.get(name);
      if (seen === undefined) {
        deprecatedNameOf.set(name, { deprecatedName: entry.deprecatedName, file });
      } else if (seen.file !== file && seen.deprecatedName !== entry.deprecatedName) {
        problems.push(
          `${distribution.distribution}.json: the ${name}'s deprecatedName ${JSON.stringify(entry.deprecatedName)} ` +
            `is not ${seen.file}'s (${JSON.stringify(seen.deprecatedName)}); a rename is the same in every file`,
        );
      }
    }
  }
  if (problems.length > 0) throw new CollectorCatalogueError(problems);

  return [...distributions].sort((a, b) =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.distribution.localeCompare(b.distribution),
  );
}
