import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The 13 seeded flows as the schema tests read them (D12 decision 15,
 * Preflight ruling 20): `services/otelcol-validator/tests/fixtures/
 * seeded-flows.json`, each flow's slug, pin and YAML, which the db
 * workspace writes from migration 1700000000026's `seededFlows` and whose
 * staleness its suite checks (packages/db/src/seeded-flows-fixture.ts).
 *
 * The fixture, not the constant: the web doesn't depend on @telflo/db, and
 * the constant is reached only by a dynamic import of the migration module
 * through @telflo/db/testing; the fixture is the checked copy the
 * validator's binary tests read too, so the collector and the schema check
 * one text.
 */

export interface SeededFlow {
  slug: string;
  collectorDistribution: string;
  collectorVersion: string;
  yaml: string;
}

const FIELDS = ["slug", "collectorDistribution", "collectorVersion", "yaml"] as const;

/** `value` as a fixture flow: exactly its four fields, each a non-empty string; throws, naming the entry, otherwise. */
function seededFlow(value: unknown, index: number): SeededFlow {
  const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (keys.join() !== [...FIELDS].sort().join() || FIELDS.some((field) => typeof entry[field] !== "string" || entry[field] === "")) {
    throw new Error(`The seeded flows' fixture's flow ${index} isn't {${FIELDS.join(", ")}}, each a non-empty string.`);
  }
  return entry as unknown as SeededFlow;
}

/** The fixture's path. */
const FIXTURE = fileURLToPath(new URL("../../../../../services/otelcol-validator/tests/fixtures/seeded-flows.json", import.meta.url));

/** The seeded flows, in the seed's order, checked against the fixture's shape. */
export function seededFlows(): SeededFlow[] {
  const { flows } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { flows?: unknown };
  if (!Array.isArray(flows)) throw new Error("The seeded flows' fixture has no flows list.");
  return flows.map(seededFlow);
}

// ── The version a seeded flow is checked on ─────────────────────────────────

/** The part of a catalogue file's version `checkedVersion` reads. */
export interface CatalogueOffer {
  version: string;
  deprecated: boolean;
  default: boolean;
}

/** Each catalogue file's `versions`, by the file's path, as Vite bundles them (as the schema tests' versions are). */
const CATALOGUE_FILES = import.meta.glob<unknown>("../../../../../catalog/distributions/*.json", { eager: true, import: "versions" });

/** `value` as a catalogue version, or undefined when it isn't one. */
function catalogueOffer(value: unknown): CatalogueOffer | undefined {
  const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const { version, deprecated } = entry;
  if (typeof version !== "string" || typeof deprecated !== "boolean" || typeof entry.default !== "boolean") return undefined;
  return { version, deprecated, default: entry.default };
}

/** Each distribution's versions (the file's name → its `versions`), checked; throws, naming the file, otherwise. */
function readCatalogueOffers(files: Readonly<Record<string, unknown>>): Record<string, CatalogueOffer[]> {
  if (Object.keys(files).length === 0) throw new Error("The collector catalogue's distribution files weren't found: catalog/distributions/*.json matched nothing.");
  const byDistribution: Record<string, CatalogueOffer[]> = {};
  for (const [path, versions] of Object.entries(files)) {
    const distribution = path.replace(/^.*\//, "").replace(/\.json$/, "");
    const offers = Array.isArray(versions) ? versions.map(catalogueOffer) : [undefined];
    if (offers.some((offer) => offer === undefined)) throw new Error(`The collector catalogue's ${distribution}.json has no valid versions list.`);
    byDistribution[distribution] = offers as CatalogueOffer[];
  }
  return byDistribution;
}

/** Every distribution's versions, as the catalogue lists them. */
export const CATALOGUE_OFFERS: Readonly<Record<string, readonly CatalogueOffer[]>> = readCatalogueOffers(CATALOGUE_FILES);

/**
 * The version a seeded flow is checked on (D12 Ruling 37): its pin while the
 * catalogue offers it, else the distribution's default, the version "Use
 * this flow" gives a copy of it (`flowCopyPin`, decision 16). So retiring a
 * seeded pin moves the flow's checks to the default, with the copies, and
 * no test needs editing. Throws for a distribution the catalogue doesn't
 * list or one without an offered default (the catalogue's validator refuses
 * both).
 */
export function checkedVersion(
  flow: Pick<SeededFlow, "slug" | "collectorDistribution" | "collectorVersion">,
  catalogue: Readonly<Record<string, readonly CatalogueOffer[]>> = CATALOGUE_OFFERS,
): string {
  const offers = catalogue[flow.collectorDistribution];
  if (offers === undefined) throw new Error(`The seeded flow ${flow.slug}'s distribution ${flow.collectorDistribution} isn't in the catalogue.`);
  const offered = offers.filter((offer) => !offer.deprecated);
  if (offered.some((offer) => offer.version === flow.collectorVersion)) return flow.collectorVersion;
  const fallback = offered.find((offer) => offer.default);
  if (fallback === undefined) throw new Error(`The catalogue's ${flow.collectorDistribution} has no offered default version.`);
  return fallback.version;
}
