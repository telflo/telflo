import type { CollectorDistribution } from "@telflo/contracts";

/*
 * The collector catalog as the web was built with it: each
 * `catalog/distributions/<distribution>.json`, bundled by Vite, never fetched
 * (the playground calls no catalog route), in the shape
 * `GET /api/v1/collector-distributions` answers, with its deprecated versions
 * left out as the API leaves them out. What the playground's pickers list and
 * its configurations' distribution tags name (`useCollectorDistributions()`
 * answers it inside the playground). The same files give the editor's schemas
 * (`SCHEMA_CATALOGUE`), so the pins it offers are exactly those with a schema.
 */

const CATALOGUE_FILES = import.meta.glob<unknown>("../../../../../../catalog/distributions/*.json", {
  eager: true,
  import: "default",
});

interface CatalogueVersionFile {
  version: string;
  label: string;
  description: string | null;
  releasedAt: string;
  default: boolean;
  deprecated: boolean;
  supportedComponents: CollectorDistribution["versions"][number]["supportedComponents"];
}

interface CatalogueFile {
  distribution: string;
  label: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  default: boolean;
  renamedTypes: CollectorDistribution["renamedTypes"];
  versions: CatalogueVersionFile[];
}

/** Each version's parts compared as numbers, newest first: the API's order. */
function newestFirst(one: string, other: string): number {
  const a = one.split(".").map(Number);
  const b = other.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The catalog files, as the API answers them: in the catalog's order, each with its offered versions, newest first. */
export function readPlaygroundCatalogue(files: Readonly<Record<string, unknown>>): CollectorDistribution[] {
  return Object.values(files)
    .map((file) => file as CatalogueFile)
    .sort((one, other) => one.sortOrder - other.sortOrder)
    .map((file) => ({
      id: file.distribution,
      label: file.label,
      description: file.description,
      icon: file.icon,
      isDefault: file.default,
      versions: file.versions
        .filter((version) => !version.deprecated)
        .sort((one, other) => newestFirst(one.version, other.version))
        .map((version) => ({
          version: version.version,
          label: version.label,
          description: version.description,
          releasedAt: version.releasedAt,
          isDefault: version.default,
          supportedComponents: version.supportedComponents,
        })),
      renamedTypes: file.renamedTypes,
    }));
}

/** The playground's collector catalog. */
export const PLAYGROUND_CATALOGUE: CollectorDistribution[] = readPlaygroundCatalogue(CATALOGUE_FILES);
