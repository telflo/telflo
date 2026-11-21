import { CollectorRenamedTypesSchema, type CollectorRenamedType } from "@telflo/contracts";

import { COMPONENT_TYPES, type ComponentType } from "../graph/types.js";

/*
 * The collector's renames, read from the catalog when the web is built:
 * each `catalog/distributions/<distribution>.json`'s `renamedTypes`,
 * bundled by Vite, never fetched from the API (the parser is synchronous
 * and runs everywhere). The catalog is the one source: there is no
 * second copy here. The web image copies `catalog/` before it builds.
 *
 * Every rename is kind-specific: from upstream's `since` on, the collector
 * calls the `kind` of component `deprecatedName` by `name`, and keeps the old
 * name as a deprecated alias. Another kind spelled `name` is a type the
 * collector doesn't have (an `otlp_grpc` receiver, an `aws_s3` exporter).
 *
 * The palette keeps the old spellings, so the parser maps a current name to
 * its palette entry for the label, icon, help and form (`paletteSubType`),
 * and the text keeps its spelling. A component dropped from the palette is
 * written as the version's pin knows it (`spelledType`).
 */

/** Each catalog file's `renamedTypes`, by the file's path, as Vite bundles them. */
const CATALOGUE_FILES = import.meta.glob<unknown>("../../../../../../catalog/distributions/*.json", {
  eager: true,
  import: "renamedTypes",
});

/** A rename, as the catalog lists it. */
export type RenamedType = CollectorRenamedType;

/** Each kind's renames: the collector's current name → the deprecated name the palette spells. */
export type RenamedTypeTable = Readonly<Record<ComponentType, Readonly<Record<string, string>>>>;

/**
 * The renames of every file in `files` (a path → that file's
 * `renamedTypes`), checked against the catalog's format, by distribution
 * (the file's name), in each file's order. A file without a valid list
 * throws, naming it, and so does no file at all (the glob matched nothing:
 * `catalog/` missing where the web is built). Vite bundles an
 * empty glob without complaint, so this throws when the module loads, not
 * when it is bundled: the built server at its start (its one bundle reads
 * the renames as it is imported), the dev server at its first page, every
 * test that imports it. The web image's build checks for the files before
 * it builds, and refuses without them (`telflo-core/Dockerfile`).
 */
export function readRenamedTypes(files: Readonly<Record<string, unknown>>): Readonly<Record<string, readonly RenamedType[]>> {
  if (Object.keys(files).length === 0) {
    throw new Error("The collector catalogue's distribution files weren't found: catalog/distributions/*.json matched nothing.");
  }
  const byDistribution: Record<string, readonly RenamedType[]> = {};
  for (const [path, renamedTypes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const distribution = path.replace(/^.*\//, "").replace(/\.json$/, "");
    const parsed = CollectorRenamedTypesSchema.safeParse(renamedTypes);
    if (!parsed.success) {
      throw new Error(`The collector catalogue's ${distribution}.json has no valid renamedTypes list.`);
    }
    byDistribution[distribution] = parsed.data;
  }
  return byDistribution;
}

/**
 * The union of every distribution's renames, by kind. A kind's current name
 * has one deprecated name across the files (the catalog's cross-file rule);
 * a file that disagrees throws.
 */
export function renamedTypeTable(byDistribution: Readonly<Record<string, readonly RenamedType[]>>): RenamedTypeTable {
  const table = Object.fromEntries(COMPONENT_TYPES.map((kind) => [kind, {} as Record<string, string>])) as Record<
    ComponentType,
    Record<string, string>
  >;
  for (const [distribution, renames] of Object.entries(byDistribution)) {
    for (const { kind, name, deprecatedName } of renames) {
      const seen = Object.hasOwn(table[kind], name) ? table[kind][name] : undefined;
      if (seen !== undefined && seen !== deprecatedName) {
        throw new Error(
          `The collector catalogue's ${distribution}.json renames the ${kind} ${name} from ${deprecatedName}; another file says ${seen}.`,
        );
      }
      table[kind][name] = deprecatedName;
    }
  }
  return table;
}

/** Every distribution's renames, as its catalog file lists them. */
export const CATALOGUE_RENAMED_TYPES = readRenamedTypes(CATALOGUE_FILES);

/** The collector's renames, by kind: current name → the palette's (deprecated) name. */
export const RENAMED_TYPES: RenamedTypeTable = renamedTypeTable(CATALOGUE_RENAMED_TYPES);

/**
 * A collector version's `major.minor.patch` as numbers (each part any
 * length, as the catalog's format allows), or null when `version` isn't
 * in that format.
 */
function versionParts(version: string): readonly bigint[] | null {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return null;
  return version.split(".").map((part) => BigInt(part));
}

/** Whether collector version `version` is `since` or later; false when either isn't `major.minor.patch`. */
export function isAtOrAfter(version: string, since: string): boolean {
  const at = versionParts(version);
  const from = versionParts(since);
  if (at === null || from === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (at[index]! !== from[index]!) return at[index]! > from[index]!;
  }
  return true;
}

/**
 * The type a component dropped from the palette is written with: the
 * palette's `paletteType` of `kind`, unless `distribution`'s catalog file
 * renames that kind's `paletteType` (its `deprecatedName`) and the pin
 * `collectorVersion` is at or after the rename's `since`, when the current
 * name. A null pin, a distribution the catalog doesn't have, or a pin not
 * in the catalog's format keeps the palette's (old) name, which every
 * offered collector still accepts. Changing the pin never rewrites text
 * already written: this decides only what a new component is called.
 */
export function spelledType(
  kind: ComponentType,
  paletteType: string,
  distribution: string | null,
  collectorVersion: string | null,
  catalogue: Readonly<Record<string, readonly RenamedType[]>> = CATALOGUE_RENAMED_TYPES,
): string {
  if (distribution === null || collectorVersion === null || !Object.hasOwn(catalogue, distribution)) return paletteType;
  const rename = catalogue[distribution]!.find((entry) => entry.kind === kind && entry.deprecatedName === paletteType);
  return rename !== undefined && isAtOrAfter(collectorVersion, rename.since) ? rename.name : paletteType;
}
