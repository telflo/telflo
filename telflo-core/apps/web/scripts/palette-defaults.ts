import { CollectorSupportedComponentsSchema, type CollectorSupportedComponents } from "@telflo/contracts";

import { CATALOGUE_RENAMED_TYPES, isAtOrAfter, spelledType, type RenamedType } from "~/lib/collector/renamed-types.js";
import { filterPaletteByAllowlist } from "~/lib/collector/distribution-allowlist.js";
import { droppedNode } from "~/lib/graph/canvas-operations.js";
import { deriveModel, readTextModel, type Model, type PipelineLists } from "~/lib/graph/model.js";
import { componentName } from "~/lib/graph/node-operations.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import { editText, valuesEqual } from "~/lib/graph/text-edits.js";
import type { PaletteComponent, PipelineSignalType } from "~/lib/graph/types.js";

/*
 * The palette's defaults, as every offered collector is asked about them:
 * for each distribution in the catalog, each version it offers and each
 * palette entry that version's toolbox shows, the text a drop of that entry
 * writes, spelled as the version's pin knows it, wired into the smallest
 * configuration the collector accepts (a receiver and an exporter around
 * it, in one pipeline of a signal it supports; an extension enabled in
 * `service.extensions`; a connector between two pipelines).
 *
 * The drop is the store's (`dropComponent`): `droppedNode` with
 * `spelledType` for the version, then the text written from
 * `deriveModel(graph, textModel)` by `editText`, onto a text holding the
 * rest of the configuration. It lands outside every pipeline, so the drop
 * writes the component's declaration only (and, for an extension, its name
 * in `service.extensions`); the pipeline's lists are then written by
 * `editText` too, as a connection on the canvas writes them.
 *
 * The result is committed as
 * `services/otelcol-validator/tests/fixtures/palette-defaults.json`, which
 * the validator's binary tests run every offered collector over
 * (`tests/test_binary_palette.py`). `npm run fixture:palette-defaults
 * --workspace @telflo/web` writes it (through Vitest, which reads the
 * catalog as the web's build does); `palette-defaults.test.ts` checks the
 * committed file is what this produces and never writes it.
 */

/** The command that writes the fixture. */
export const PALETTE_DEFAULTS_SCRIPT = "npm run fixture:palette-defaults --workspace @telflo/web";

/** Where the fixture is, from the repository's root. */
export const PALETTE_DEFAULTS_FIXTURE = "services/otelcol-validator/tests/fixtures/palette-defaults.json";

/**
 * The signals each palette entry is wired with: a connector's are its
 * `connectorSignals` (a signal-agnostic one, which has none, takes traces to
 * traces); every other entry's is here, one signal its component supports
 * (traces where it does). An entry missing from
 * this table stops the script, naming it.
 */
export const PALETTE_SIGNALS: Readonly<Record<string, PipelineSignalType>> = {
  "otlp-receiver": "traces",
  "prometheus-receiver": "metrics",
  "filelog-receiver": "logs",
  "fluentforward-receiver": "logs",
  "docker-stats-receiver": "metrics",
  "hostmetrics-receiver": "metrics",
  "jaeger-receiver": "traces",
  "zipkin-receiver": "traces",
  "datadog-receiver": "traces",
  "k8s-cluster-receiver": "metrics",
  "k8s-events-receiver": "logs",
  "k8s-objects-receiver": "logs",
  "kubeletstats-receiver": "metrics",
  "netflow-receiver": "logs",
  "journald-receiver": "logs",
  "syslog-receiver": "logs",
  "statsd-receiver": "metrics",
  "awss3-receiver": "traces",
  "batch-processor": "traces",
  "memory-limiter-processor": "traces",
  "resource-processor": "traces",
  "attributes-processor": "traces",
  "filter-processor": "traces",
  "probabilistic-sampler-processor": "traces",
  "tail-sampling-processor": "traces",
  "k8sattributes-processor": "traces",
  "redaction-processor": "traces",
  "cumulativetodelta-processor": "metrics",
  "resourcedetection-processor": "traces",
  "transform-processor": "traces",
  "logdedup-processor": "logs",
  "span-processor": "traces",
  "groupbyattrs-processor": "traces",
  "metricstransform-processor": "metrics",
  "otlp-exporter": "traces",
  "otlphttp-exporter": "traces",
  "loadbalancing-exporter": "traces",
  "zipkin-exporter": "traces",
  "prometheus-exporter": "metrics",
  "prometheusremotewrite-exporter": "metrics",
  "datadog-exporter": "traces",
  "clickhouse-exporter": "traces",
  "debug-exporter": "traces",
  "file-exporter": "traces",
  "awss3-exporter": "traces",
  "health-check-extension": "traces",
  "pprof-extension": "traces",
  "zpages-extension": "traces",
  "file-storage-extension": "traces",
  "opamp-extension": "traces",
  "memory-limiter-extension": "traces",
  "bearertokenauth-extension": "traces",
  "oidc-extension": "traces",
};

/** One text of the fixture: what a drop of `paletteId` writes on each of `versions`, wired. */
export interface PaletteDefaultCase {
  paletteId: string;
  kind: PaletteComponent["type"];
  /** The type as the text spells it on these versions (`file_log` or `filelog`). */
  type: string;
  distribution: string;
  /** The offered versions this exact text is for, oldest first. */
  versions: string[];
  yaml: string;
}

export interface PaletteDefaultsFixture {
  description: string;
  script: string;
  cases: PaletteDefaultCase[];
}

/** The part of a catalog file's version this reads. */
export interface CatalogueVersion {
  version: string;
  deprecated: boolean;
  supportedComponents: CollectorSupportedComponents | null;
}

/** `value` as a catalog version, or undefined when it isn't one. */
function catalogueVersion(value: unknown): CatalogueVersion | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, deprecated, supportedComponents } = value as Record<string, unknown>;
  const supported = CollectorSupportedComponentsSchema.nullable().safeParse(supportedComponents);
  if (typeof version !== "string" || typeof deprecated !== "boolean" || !supported.success) return undefined;
  return { version, deprecated, supportedComponents: supported.data };
}

/** Each catalog file's `versions`, by the file's path, as Vite bundles them (as the renames are). */
const CATALOGUE_VERSION_FILES = import.meta.glob<unknown>("../../../../catalog/distributions/*.json", {
  eager: true,
  import: "versions",
});

/** Each distribution's versions, by the file's name, checked; a file without a valid list throws, naming it. */
export function readCatalogueVersions(files: Readonly<Record<string, unknown>>): Record<string, CatalogueVersion[]> {
  if (Object.keys(files).length === 0) {
    throw new Error("The collector catalogue's distribution files weren't found: catalog/distributions/*.json matched nothing.");
  }
  const byDistribution: Record<string, CatalogueVersion[]> = {};
  for (const [path, versions] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const distribution = path.replace(/^.*\//, "").replace(/\.json$/, "");
    const parsed = Array.isArray(versions) ? versions.map(catalogueVersion) : [undefined];
    if (parsed.some((entry) => entry === undefined)) {
      throw new Error(`The collector catalogue's ${distribution}.json has no valid versions list.`);
    }
    byDistribution[distribution] = parsed as CatalogueVersion[];
  }
  return byDistribution;
}

/** Every distribution's versions, as the catalog lists them. */
export const CATALOGUE_VERSIONS = readCatalogueVersions(CATALOGUE_VERSION_FILES);

/** The offered (not deprecated) versions, oldest first. */
export function offeredVersions(versions: readonly CatalogueVersion[]): CatalogueVersion[] {
  return versions
    .filter((entry) => !entry.deprecated)
    .sort((a, b) => (a.version === b.version ? 0 : isAtOrAfter(a.version, b.version) ? 1 : -1));
}

// ── The smallest configuration around one component ─────────────────────────

const OTLP_RECEIVER = "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: localhost:4317\n";
const DEBUG_EXPORTER = "exporters:\n  debug: {}\n";

/** A pipeline's lists, as the text writes them (only the lists given). */
function pipelineText(name: string, lists: Partial<Record<keyof PipelineLists, string[]>>): string {
  const lines = [`    ${name}:\n`];
  for (const list of ["receivers", "processors", "exporters"] as const) {
    const names = lists[list];
    if (names !== undefined) lines.push(`      ${list}: [${names.join(", ")}]\n`);
  }
  return lines.join("");
}

/** The pipelines a connector of `entry` joins: its input and its output (renamed `/out` when they're the same signal). */
function connectorPipelines(entry: PaletteComponent): { input: string; output: string } {
  const input = entry.connectorSignals?.inputSignal ?? "traces";
  const outputSignal = entry.connectorSignals?.outputSignal ?? "traces";
  return { input, output: outputSignal === input ? `${outputSignal}/out` : outputSignal };
}

/**
 * The text the drop lands on: the configuration without the component.
 * A pipeline the component will join lacks the list it joins (the wiring
 * writes it).
 */
function surroundingText(entry: PaletteComponent, signal: PipelineSignalType): string {
  const service = "service:\n  pipelines:\n";
  switch (entry.type) {
    case "receiver":
      return `${DEBUG_EXPORTER}${service}${pipelineText(signal, { exporters: ["debug"] })}`;
    case "processor":
    case "extension":
      return `${OTLP_RECEIVER}${DEBUG_EXPORTER}${service}${pipelineText(signal, { receivers: ["otlp"], exporters: ["debug"] })}`;
    case "exporter":
      return `${OTLP_RECEIVER}${service}${pipelineText(signal, { receivers: ["otlp"] })}`;
    case "connector": {
      const { input, output } = connectorPipelines(entry);
      return (
        `${OTLP_RECEIVER}${DEBUG_EXPORTER}${service}` +
        `${pipelineText(input, { receivers: ["otlp"] })}${pipelineText(output, { exporters: ["debug"] })}`
      );
    }
  }
}

/** `model` with the dropped component `name` in the lists it joins. */
function wired(model: Model, entry: PaletteComponent, signal: PipelineSignalType, name: string): Model {
  const pipelines = new Map([...model.pipelines].map(([pipeline, lists]) => [pipeline, { ...lists }]));
  const join = (pipeline: string, list: keyof PipelineLists) => {
    const lists = pipelines.get(pipeline);
    if (lists === undefined) throw new Error(`The surrounding text has no pipeline ${pipeline}.`);
    lists[list] = [...lists[list], name];
  };
  switch (entry.type) {
    case "receiver":
      join(signal, "receivers");
      break;
    case "processor":
      join(signal, "processors");
      break;
    case "exporter":
      join(signal, "exporters");
      break;
    case "connector": {
      const { input, output } = connectorPipelines(entry);
      join(input, "exporters");
      join(output, "receivers");
      break;
    }
    case "extension":
      break; // the drop enables it in service.extensions
  }
  return { ...model, pipelines };
}

/** Far from every group: the drop joins no pipeline. */
const OUTSIDE_EVERY_GROUP = { x: -100_000, y: -100_000 };

/**
 * The text a drop of `entry` writes on `version` of `distribution`, wired
 * into the smallest configuration around it, and the type it is spelled
 * with. Throws when a step can't write it, or the text doesn't hold the
 * entry's default under the spelled key.
 */
export function paletteDefaultText(
  entry: PaletteComponent,
  distribution: string,
  version: string,
  catalogue: Readonly<Record<string, readonly RenamedType[]>> = CATALOGUE_RENAMED_TYPES,
): { type: string; yaml: string } {
  const signal = PALETTE_SIGNALS[entry.id];
  if (signal === undefined && entry.type !== "connector") {
    throw new Error(`Add the palette entry ${entry.id} to PALETTE_SIGNALS (scripts/palette-defaults.ts).`);
  }
  const pipelineSignal = signal ?? "traces";
  const surrounding = surroundingText(entry, pipelineSignal);
  const parsed = parse(surrounding);
  if (!parsed.ok) throw new Error(`The surrounding text for ${entry.id} doesn't parse: ${parsed.reason}`);

  // The store's drop (`dropComponent`): the pin's spelling, the node, the text.
  const type = spelledType(entry.type, entry.subType, distribution, version, catalogue);
  const node = droppedNode(entry, OUTSIDE_EVERY_GROUP, parsed.graph.nodes, type);
  const textModel = readTextModel(parsed.document);
  const graph = { ...parsed.graph, nodes: [...parsed.graph.nodes, node] };
  const dropped = editText(surrounding, textModel, deriveModel(graph, textModel), { document: parsed.document });

  const name = componentName(node.data);
  const written = editText(dropped.text, dropped.model, wired(dropped.model, entry, pipelineSignal, name), {
    document: dropped.document,
  });

  const key = node.data.key!;
  if (!written.model.components.has(key) || !valuesEqual(written.model.components.get(key), entry.defaultConfig)) {
    throw new Error(`The text for ${entry.id} doesn't hold its default under ${key}.`);
  }
  return { type, yaml: written.text };
}

/**
 * The fixture: for every distribution, every offered version and every
 * palette entry that version shows, its text; each distinct text once, with
 * the versions it is for. In the palette's order, then by the first version.
 */
export function paletteDefaultsFixture(
  versionsByDistribution: Readonly<Record<string, readonly CatalogueVersion[]>> = CATALOGUE_VERSIONS,
  catalogue: Readonly<Record<string, readonly RenamedType[]>> = CATALOGUE_RENAMED_TYPES,
): PaletteDefaultsFixture {
  const cases: PaletteDefaultCase[] = [];
  for (const [distribution, versions] of Object.entries(versionsByDistribution)) {
    const offered = offeredVersions(versions);
    componentPalette.forEach((entry) => {
      const byText = new Map<string, PaletteDefaultCase>();
      for (const offer of offered) {
        if (!filterPaletteByAllowlist([entry], offer.supportedComponents).length) continue;
        const { type, yaml } = paletteDefaultText(entry, distribution, offer.version, catalogue);
        const known = byText.get(yaml);
        if (known) {
          known.versions.push(offer.version);
        } else {
          byText.set(yaml, { paletteId: entry.id, kind: entry.type, type, distribution, versions: [offer.version], yaml });
        }
      }
      cases.push(...byText.values());
    });
  }
  return {
    description:
      "What a drop of each palette entry writes, per offered collector version, in the smallest configuration around it. " +
      "Generated: never edit by hand.",
    script: PALETTE_DEFAULTS_SCRIPT,
    cases,
  };
}

/** The fixture as the committed file holds it. */
export function serializedFixture(fixture: PaletteDefaultsFixture = paletteDefaultsFixture()): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}
