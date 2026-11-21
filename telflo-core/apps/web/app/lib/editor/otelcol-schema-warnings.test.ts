// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { CATALOGUE_VERSIONS, offeredVersions, paletteDefaultsFixture } from "../../../scripts/palette-defaults.js";
import { spelledType } from "~/lib/collector/renamed-types.js";
import { CORPUS } from "~/lib/graph/corpus/corpus.js";
import { committedSchemaWorker, WARNING, type Diagnostic, type SchemaWorker } from "~/test/schema-worker.js";
import { checkedVersion, seededFlows, type CatalogueOffer } from "~/test/seeded-flows.js";

/*
 * Every palette default, spelled for each offered pin, every corpus text and
 * every seeded flow on the version a copy of it gets (the flows' fixture,
 * which the db suite checks against the migrations' seededFlows; its pin while
 * offered, else the distribution's default), run through monaco-yaml's own
 * worker with that version's committed schema: what the YAML tab marks. A text
 * the collector accepts must get no schema warning; the texts that aren't
 * collector configurations warn exactly as EXPECTED_WARNINGS lists, line by
 * line, with the reason. No text gets an Error (they all parse).
 *
 * A new warning here is either the schema warning about a text the collector
 * accepts (upstream wrong: the generator's open parts) or a text the collector
 * refuses (a new entry below, with its reason). Each was checked against the
 * collector's Go at the pinned commits.
 */

const DISTRIBUTION = "otelcol-contrib";

/** The catalog's offered versions of the distribution, oldest first. */
const VERSIONS = offeredVersions(CATALOGUE_VERSIONS[DISTRIBUTION] ?? []).map((offer) => offer.version);

/** What a drop of each palette entry writes on each offered version. */
const PALETTE_CASES = paletteDefaultsFixture().cases.filter((entry) => entry.distribution === DISTRIBUTION);

/**
 * The seeded flows: each is checked on one version only, the one a
 * copy of it is created on (`checkedVersion`: its pin while offered, else the
 * default), so retiring a seeded pin moves its check rather than dropping it.
 */
const SEEDED_FLOWS = seededFlows();

interface Text {
  /** `palette <entry id>`, `corpus <file name>` or `flow <slug>`. */
  name: string;
  text: string;
}

/** The texts checked on `version`. */
function textsOn(version: string): Text[] {
  return [
    ...PALETTE_CASES.filter((entry) => entry.versions.includes(version)).map((entry) => ({
      name: `palette ${entry.paletteId}`,
      text: entry.yaml,
    })),
    ...CORPUS.map((entry) => ({ name: `corpus ${entry.name}`, text: entry.text })),
    ...SEEDED_FLOWS.filter((flow) => flow.collectorDistribution === DISTRIBUTION && checkedVersion(flow) === version).map(
      (flow) => ({ name: `flow ${flow.slug}`, text: flow.yaml }),
    ),
  ];
}

interface ExpectedWarnings {
  /** The text, as `textsOn` names it. */
  text: string;
  /** Which offered versions it warns on; every one when absent. */
  on?: (version: string) => boolean;
  /** Each warning: its line (1-based) and message. */
  warnings: readonly (readonly [line: number, message: string])[];
  /** Why the collector refuses the text (a test or a builder case, not a configuration it runs). */
  reason: string;
}

/** The versions before the collector named the awss3 receiver `aws_s3` (the catalog's rename). */
const beforeAwsS3Receiver = (version: string) => spelledType("receiver", "awss3", DISTRIBUTION, version) !== "aws_s3";

const notAllowed = (key: string) => `Property ${key} is not allowed.`;

/**
 * The texts that warn, and why. No seeded flow may be listed: each passes
 * its pin's collector (test_binary_flows.py), so a warning on one is the
 * schema's error, for the maintainers to fix.
 */
const EXPECTED_WARNINGS: readonly ExpectedWarnings[] = [
  {
    text: "palette memory-limiter-extension",
    warnings: [[9, notAllowed("memory_limiter")]],
    reason: "Contrib has no memory_limiter extension (the processor is the component).",
  },
  // A top-level key that holds anchors for the rest of the text. The
  // collector decodes the top level strictly (only its six sections), so it
  // refuses these; the builder's tests keep them to prove anchors survive.
  { text: "corpus anchors-merges.yaml", warnings: [[2, notAllowed("x-defaults")], [5, notAllowed("x-tls")]], reason: "Top-level x-* keys hold anchors; the collector refuses unknown top-level keys." },
  { text: "corpus forms-host.yaml", warnings: [[4, notAllowed("x-interval")]], reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys." },
  { text: "corpus forms-kubernetes.yaml", warnings: [[3, notAllowed("x-k8s-auth")]], reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys." },
  { text: "corpus forms-logs-operators.yaml", warnings: [[12, notAllowed("x-retry")]], reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys." },
  { text: "corpus forms-metrics.yaml", warnings: [[5, notAllowed("x-scrape")]], reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys." },
  { text: "corpus forms-ottl.yaml", warnings: [[5, notAllowed("x-dedup")]], reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys." },
  { text: "corpus forms-traces.yaml", warnings: [[4, notAllowed("x-slow")]], reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys." },
  { text: "corpus forms-vendors.yaml", warnings: [[4, notAllowed("x-dd-api")]], reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys." },
  {
    text: "corpus forms-routing.yaml",
    warnings: [
      [6, notAllowed("x-otlp-out")],
      [64, 'Incorrect type. Expected "string".'],
    ],
    reason:
      "A top-level x-* anchor key; and load_balancing's dns `port: 4317`, an integer for a string the collector's decoder never converts (confmap decoder.go: WeaklyTypedInput false).",
  },
  {
    text: "corpus forms-storage.yaml",
    warnings: [[6, notAllowed("x-rotation")]],
    reason: "A top-level x-* key holds an anchor; the collector refuses unknown top-level keys.",
  },
  {
    text: "corpus forms-storage.yaml",
    on: beforeAwsS3Receiver,
    warnings: [[28, notAllowed("aws_s3/replay")]],
    reason: "The receiver under its 0.162.0 name: a collector before the rename has no aws_s3 type.",
  },
  // Keys made up for the parser's and the text edits' tests: no component
  // reads them, and the collector refuses every one.
  {
    text: "corpus unknown-keys.yaml",
    warnings: [
      [2, notAllowed("x-notes")],
      [5, notAllowed("mysterious")],
      [9, notAllowed("custom_enricher/eu")],
      [14, notAllowed("not_a_real_option")],
      [16, notAllowed("flags")],
      [23, notAllowed("x-comment")],
    ],
    reason: "Unknown components, sections and keys the builder must keep: the collector refuses each.",
  },
  {
    text: "corpus numbers.yaml",
    warnings: [
      [7, notAllowed("octal")],
      [8, notAllowed("hex")],
      [9, notAllowed("leading_zero")],
      [10, notAllowed("big")],
      [11, notAllowed("exponent")],
      [12, notAllowed("date")],
      [13, notAllowed("yes_is_text")],
    ],
    reason: "Made-up keys under the file exporter holding YAML 1.2 numbers and dates for the parser's tests.",
  },
  {
    text: "corpus layout-preserved.yaml",
    warnings: [
      [14, notAllowed("note")],
      [17, notAllowed("plain_multi")],
    ],
    reason: "Made-up keys under transform holding a literal block and a multi-line plain scalar the edits must keep.",
  },
  {
    text: "corpus item-lists.yaml",
    warnings: [
      [20, notAllowed("only")],
      [30, notAllowed("only")],
      [44, 'Incorrect type. Expected "string".'],
      [45, notAllowed("conditions")],
    ],
    reason:
      "Made-up list items (`only`) and a top-level transform `conditions` list, for the forms' item edits, and a number among transform's flat statements, which the collector refuses (the number isn't a statement string, so the list mixes styles).",
  },
  {
    text: "corpus anchors-owned.yaml",
    warnings: [
      [2, notAllowed("x-tls")],
      [26, notAllowed("hosts")],
      [29, notAllowed("hosts")],
      [30, notAllowed("items")],
    ],
    reason: "A top-level x-* anchor key, and made-up otlp exporter keys owning and aliasing anchors.",
  },
  {
    text: "corpus anchored-items.yaml",
    warnings: [[36, notAllowed("rules")]],
    reason: "A made-up file exporter list whose items alias anchors, for the forms' item edits.",
  },
  {
    text: "corpus extensions-undeclared.yaml",
    warnings: [[5, notAllowed("auth")]],
    reason: "`auth` directly under the otlp receiver: the collector reads it under protocols.grpc/http only.",
  },
];

/** The warnings the table lists for `name` on `version`, sorted. */
function expectedOn(name: string, version: string): string[] {
  return EXPECTED_WARNINGS.filter((entry) => entry.text === name && (entry.on?.(version) ?? true))
    .flatMap((entry) => entry.warnings.map(([line, message]) => `${line}: ${message}`))
    .sort();
}

/** The diagnostics as the table spells them, sorted. */
function asListed(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => `${diagnostic.range.start.line + 1}: ${diagnostic.message}`).sort();
}

describe("the expected-warnings table", () => {
  it("lists only texts that exist, each on an offered version, each with a reason", () => {
    const names = new Set(VERSIONS.flatMap((version) => textsOn(version).map((text) => text.name)));
    for (const entry of EXPECTED_WARNINGS) {
      expect(names, entry.text).toContain(entry.text);
      expect(VERSIONS.some((version) => entry.on?.(version) ?? true), entry.text).toBe(true);
      expect(entry.reason.length, entry.text).toBeGreaterThan(0);
      expect(entry.warnings.length, entry.text).toBeGreaterThan(0);
    }
  });

  it("covers every offered version, every palette entry and every corpus file", () => {
    expect(VERSIONS.length).toBeGreaterThan(0);
    expect(PALETTE_CASES.length).toBeGreaterThan(0);
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  it("covers every seeded flow once, on the version a copy of it gets, and lists none of them", () => {
    expect(SEEDED_FLOWS).toHaveLength(16);
    const catalogued = (CATALOGUE_VERSIONS[DISTRIBUTION] ?? []).map((entry) => entry.version);
    for (const flow of SEEDED_FLOWS) {
      // A pin is the catalog's, offered or deprecated (it never deletes one); the checked version is offered.
      expect(flow.collectorDistribution, flow.slug).toBe(DISTRIBUTION);
      expect(catalogued, flow.slug).toContain(flow.collectorVersion);
      expect(VERSIONS, flow.slug).toContain(checkedVersion(flow));
    }
    const checked = VERSIONS.flatMap((version) =>
      textsOn(version)
        .filter((text) => text.name.startsWith("flow "))
        .map((text) => `${text.name} on ${version}`),
    );
    expect(checked.sort()).toEqual(SEEDED_FLOWS.map((flow) => `flow ${flow.slug} on ${checkedVersion(flow)}`).sort());
    expect(EXPECTED_WARNINGS.filter((entry) => entry.text.startsWith("flow "))).toEqual([]);
  });
});

describe("a seeded flow's checked version", () => {
  const offer = (version: string, flags: { deprecated?: boolean; isDefault?: boolean } = {}): CatalogueOffer => ({
    version,
    deprecated: flags.deprecated ?? false,
    default: flags.isDefault ?? false,
  });
  const catalogue = {
    [DISTRIBUTION]: [offer("0.3.0", { isDefault: true }), offer("0.2.0"), offer("0.1.0", { deprecated: true })],
  };
  const flow = (collectorVersion: string) => ({ slug: "a-flow", collectorDistribution: DISTRIBUTION, collectorVersion });

  it("is the pin while the catalog offers it, default or not", () => {
    expect(checkedVersion(flow("0.2.0"), catalogue)).toBe("0.2.0");
    expect(checkedVersion(flow("0.3.0"), catalogue)).toBe("0.3.0");
  });

  it("is the distribution's default once the pin is deprecated, as a copy's pin is (flowCopyPin)", () => {
    expect(checkedVersion(flow("0.1.0"), catalogue)).toBe("0.3.0");
  });

  it("refuses a distribution the catalog doesn't list", () => {
    expect(() => checkedVersion({ ...flow("0.2.0"), collectorDistribution: "elsewhere" }, catalogue)).toThrow("isn't in the catalogue");
  });
});

describe.each(VERSIONS)(`${DISTRIBUTION} %s's schema`, (version) => {
  let worker: SchemaWorker;

  beforeAll(async () => {
    worker = await committedSchemaWorker(DISTRIBUTION, version);
  });

  it.each(textsOn(version))("$name warns only as the table lists", async ({ name, text }) => {
    const diagnostics = await worker.validate(text);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity !== WARNING)).toEqual([]);
    expect(asListed(diagnostics)).toEqual(expectedOn(name, version));
  });
});
