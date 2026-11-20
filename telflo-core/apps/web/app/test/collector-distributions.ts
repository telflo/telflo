import type { CollectorDistribution, CollectorVersionOffer } from "@telflo/contracts";
import { CATALOGUE_RENAMED_TYPES } from "~/lib/collector/renamed-types.js";
import { useCollectorCatalogueStore } from "~/lib/stores/collector-catalogue-store.js";

/*
 * The collector catalog as the API answers it, for the web's tests:
 * Contrib, the catalog's one distribution and its default, offering three
 * versions, newest first, 0.162.0 the default with its catalog
 * description. 0.155.0 is a version it no longer offers (deprecated), which
 * a pin can still name, with its note. A second distribution, with no mark
 * of its own, is a fixture only: every picker is built for several. Contrib
 * carries the catalog's renames, as the API serves them; the fixture
 * distribution none.
 */

export const CONTRIB_ID = "otelcol-contrib";
export const CONTRIB_LABEL = "OpenTelemetry Collector Contrib";
export const CONTRIB_DESCRIPTION =
  "The full upstream component catalog. Pick this unless your collectors run a specific vendor build.";

/** A version the catalog offers, `v{version}` its label. */
export function offer(version: string, overrides: Partial<CollectorVersionOffer> = {}): CollectorVersionOffer {
  return {
    version,
    label: `v${version}`,
    description: null,
    releasedAt: "2026-09-29",
    isDefault: false,
    supportedComponents: null,
    ...overrides,
  };
}

export const CONTRIB: CollectorDistribution = {
  id: CONTRIB_ID,
  label: CONTRIB_LABEL,
  description: CONTRIB_DESCRIPTION,
  icon: "otel",
  isDefault: true,
  versions: [
    offer("0.162.0", { description: "Current default.", isDefault: true }),
    offer("0.161.0", { releasedAt: "2026-09-16" }),
    offer("0.160.0", { releasedAt: "2026-09-02" }),
  ],
  renamedTypes: [...(CATALOGUE_RENAMED_TYPES[CONTRIB_ID] ?? [])],
};

/** A pin the catalog retired, as a version summary carries it. */
export const RETIRED_VERSION = "0.155.0";
export const RETIRED_NOTE = "Retired: upgrade to 0.162.0.";

/** A second distribution, not the default, with no mark the web knows. */
export const ACME: CollectorDistribution = {
  id: "acme-collector",
  label: "Acme Collector",
  description: "A smaller component set, for Acme's backend.",
  icon: null,
  isDefault: false,
  versions: [offer("2.36.0", { isDefault: true })],
  renamedTypes: [],
};

/** The catalog as read: Contrib alone, as the committed catalog is. */
export const CATALOGUE: CollectorDistribution[] = [CONTRIB];

/** Puts `distributions` in the catalog store, read. */
export function seedCatalogue(distributions: CollectorDistribution[] = CATALOGUE): void {
  useCollectorCatalogueStore.setState({ distributions, status: "loaded" });
}
