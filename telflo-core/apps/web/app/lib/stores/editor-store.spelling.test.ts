import type { Configuration } from "@telflo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { useEditorStore } from "./editor-store.js";
import { componentIcon } from "~/components/editor/builder/component-icons.js";
import { formFor } from "~/components/editor/builder/config-forms/registry.js";
import { CATALOGUE_RENAMED_TYPES, type RenamedType } from "~/lib/collector/renamed-types.js";
import { componentKey, SECTION_OF_TYPE } from "~/lib/graph/node-operations.js";
import { componentPalette, findPaletteEntry } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import type { ComponentType, OTelNode } from "~/lib/graph/types.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

/*
 * The palette writes the spelling the pin knows: a component dropped from the
 * palette is written with the collector's current name when the version on
 * screen is pinned at or after the rename's `since`, with the palette's
 * (deprecated) name before it; the node's palette subtype, label, icon and
 * form are the entry's either way. Contrib's real renames here; a distribution
 * with its own `since` values is `spelledType`'s (renamed-types.test.ts).
 */

const CONTRIB: readonly RenamedType[] = CATALOGUE_RENAMED_TYPES["otelcol-contrib"]!;

const BASE = [
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc: {}",
  "exporters:",
  "  debug: {}",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
});

function openPinned(collectorVersion: string, yamlContent = BASE, configuration: Configuration = MINE): void {
  store().load({ organizationId: GROUP_ID, configuration, version: versionFixture({ yamlContent, collectorVersion }) });
}

/** The version just before `since` (`0.148.0` for `0.149.0`), and one just after it. */
function versionBefore(since: string): string {
  const [major, minor, patch] = since.split(".").map(Number) as [number, number, number];
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.99`;
  return `${major - 1}.99.99`;
}
function versionAfter(since: string): string {
  const [major, minor] = since.split(".").map(Number) as [number, number, number];
  return `${major}.${minor + 1}.0`;
}

function paletteIdOf(kind: ComponentType, subType: string): string {
  const entry = componentPalette.find((candidate) => candidate.type === kind && candidate.subType === subType);
  if (!entry) throw new Error(`no palette entry ${kind} ${subType}`);
  return entry.id;
}

/** Drops the palette's `kind` `subType` away from every group. */
function drop(kind: ComponentType, subType: string): OTelNode {
  const node = store().dropComponent(paletteIdOf(kind, subType), { x: -3000, y: -3000 });
  if (!node) throw new Error("the drop was refused");
  return node;
}

/** The names the text's `kind` section holds, in order. */
function namesIn(kind: ComponentType, text = store().text): string[] {
  const value = parseYaml(text) as Record<string, Record<string, unknown> | null | undefined>;
  return Object.keys(value[SECTION_OF_TYPE[kind]] ?? {});
}

function nodeByKey(key: string): OTelNode {
  const found = store().graph.nodes.find((n) => n.type !== "pipelineGroup" && componentKey(n.data) === key);
  if (!found) throw new Error(`no node ${key}`);
  return found;
}

const PINS = (since: string) =>
  [
    ["before", versionBefore(since), "old"],
    ["at", since, "current"],
    ["after", versionAfter(since), "current"],
  ] as const;

describe("the palette writes the spelling the pin knows", () => {
  it("has Contrib's renames to check", () => {
    expect(CONTRIB.length).toBeGreaterThan(0);
  });

  describe.each(CONTRIB.map((rename) => [`${rename.kind} ${rename.deprecatedName} → ${rename.name} (${rename.since})`, rename] as const))(
    "%s",
    (_label, { kind, name, deprecatedName, since }) => {
      it.each(PINS(since))("on a pin %s since (%s) writes the %s name", (_when, pin, spelling) => {
        openPinned(pin);
        const current = spelling === "current";
        const entry = findPaletteEntry(kind, deprecatedName)!;
        const written = current ? name : deprecatedName;

        const node = drop(kind, deprecatedName);

        expect(namesIn(kind)).toContain(written);
        expect(namesIn(kind)).not.toContain(current ? deprecatedName : name);
        expect(node.data.key).toBe(`${SECTION_OF_TYPE[kind]}.${written}`);
        // The palette's subtype stays: label, icon and form are the entry's.
        expect(node.data.componentSubType).toBe(deprecatedName);
        expect(node.data.label).toBe(entry.label);
        // Read back from the text, as a reload would: the same entry.
        const parsed = parse(store().text);
        if (!parsed.ok) throw new Error(parsed.reason);
        const reread = parsed.graph.nodes.find((n) => componentKey(n.data) === `${SECTION_OF_TYPE[kind]}.${written}`)!;
        expect(reread.data.componentSubType).toBe(deprecatedName);
        expect(reread.data.label).toBe(entry.label);
        expect(formFor(kind, reread.data.componentSubType)).toBe(formFor(kind, deprecatedName));
        expect(formFor(kind, written)).toBe(formFor(kind, deprecatedName));
        expect(componentIcon(kind, reread.data.componentSubType)).toBe(componentIcon(kind, deprecatedName));
      });
    },
  );

  it("on Contrib's offered pins: the S3 receiver is awss3 on 0.161.0 and aws_s3 on 0.162.0; the OTLP exporter otlp_grpc on both", () => {
    openPinned("0.161.0");
    drop("receiver", "awss3");
    drop("exporter", "otlp");
    expect(namesIn("receiver")).toEqual(["otlp", "awss3"]);
    expect(namesIn("exporter")).toEqual(["debug", "otlp_grpc"]);

    openPinned("0.162.0");
    drop("receiver", "awss3");
    drop("exporter", "otlp");
    expect(namesIn("receiver")).toEqual(["otlp", "aws_s3"]);
    expect(namesIn("exporter")).toEqual(["debug", "otlp_grpc"]);
  });

  it("a type not renamed is written as the palette spells it", () => {
    openPinned("0.162.0");
    drop("processor", "batch");
    expect(namesIn("processor")).toEqual(["batch"]);
  });

  it("with no pin on screen, writes the old name", () => {
    openPinned("0.162.0");
    useEditorStore.setState({ collectorVersion: null });

    drop("receiver", "filelog");
    drop("exporter", "otlp");

    expect(namesIn("receiver")).toEqual(["otlp", "filelog"]);
    expect(namesIn("exporter")).toEqual(["debug", "otlp"]);
  });

  it("for a distribution the catalog doesn't list, writes the old name", () => {
    openPinned("0.162.0", BASE, { ...MINE, collectorDistribution: "acme" });
    drop("receiver", "filelog");
    expect(namesIn("receiver")).toEqual(["otlp", "filelog"]);
  });

  it("follows the pin on screen, a pick not yet saved included", () => {
    openPinned("0.148.0");
    store().setCollectorVersion("0.162.0");
    drop("receiver", "filelog");
    expect(namesIn("receiver")).toEqual(["otlp", "file_log"]);
  });

  it("a pin change rewrites nothing: what was written stays, and the next drop takes the new pin's spelling", () => {
    openPinned("0.162.0");
    drop("receiver", "filelog");
    const written = store().text;
    expect(namesIn("receiver")).toEqual(["otlp", "file_log"]);

    store().setCollectorVersion("0.148.0");
    expect(store().text).toBe(written);
    expect(nodeByKey("receivers.file_log").data.componentSubType).toBe("filelog");

    // The next one is numbered after the first, whichever its spelling.
    drop("receiver", "filelog");
    expect(namesIn("receiver")).toEqual(["otlp", "file_log", "filelog/2"]);
    const both = store().text;

    store().setCollectorVersion("0.162.0");
    expect(store().text).toBe(both);
    drop("receiver", "filelog");
    expect(namesIn("receiver")).toEqual(["otlp", "file_log", "filelog/2", "file_log/3"]);
  });

  it("a drop next to the other spelling already in the text is numbered after it", () => {
    openPinned("0.162.0", BASE.replace("  debug: {}\n", "  debug: {}\n  otlp:\n    endpoint: collector:4317\n"));
    const node = drop("exporter", "otlp");
    expect(namesIn("exporter")).toEqual(["debug", "otlp", "otlp_grpc/2"]);
    expect(node.data.label).toBe("OTLP (2)");
  });
});

describe("a duplicate keeps the spelling of the node it duplicates", () => {
  const OLD_SPELLING = BASE.replace("  debug: {}\n", "  debug: {}\n  otlp:\n    endpoint: collector:4317\n");
  const NEW_SPELLING = BASE.replace("  debug: {}\n", "  debug: {}\n  otlp_grpc:\n    endpoint: collector:4317\n");

  it("the old spelling, on a pin that knows the new one", () => {
    openPinned("0.162.0", OLD_SPELLING);
    const copy = store().duplicateNode(nodeByKey("exporters.otlp").id);
    expect(copy?.data.key).toBe("exporters.otlp/2");
    expect(namesIn("exporter")).toEqual(["debug", "otlp", "otlp/2"]);
  });

  it("the new spelling, on a pin before it", () => {
    openPinned("0.143.0", NEW_SPELLING);
    const copy = store().duplicateNode(nodeByKey("exporters.otlp_grpc").id);
    expect(copy?.data.key).toBe("exporters.otlp_grpc/2");
    expect(copy?.data.componentSubType).toBe("otlp");
    expect(namesIn("exporter")).toEqual(["debug", "otlp_grpc", "otlp_grpc/2"]);
  });

  it("a component dropped on one pin, duplicated after a pin change", () => {
    openPinned("0.162.0");
    const dropped = drop("exporter", "otlp");
    store().setCollectorVersion("0.143.0");
    const copy = store().duplicateNode(dropped.id);
    expect(copy?.data.key).toBe("exporters.otlp_grpc/2");
    expect(namesIn("exporter")).toEqual(["debug", "otlp_grpc", "otlp_grpc/2"]);
  });

  it("the selection's duplicates, each in its own node's spelling", () => {
    openPinned("0.162.0", OLD_SPELLING.replace("receivers:\n", "receivers:\n  file_log: {}\n"));
    store().setSelection([nodeByKey("exporters.otlp").id, nodeByKey("receivers.file_log").id]);
    const copies = store().duplicateSelectedNodes();
    expect(copies.map((copy) => copy.data.key).sort()).toEqual(["exporters.otlp/2", "receivers.file_log/2"]);
    expect(namesIn("exporter")).toEqual(["debug", "otlp", "otlp/2"]);
    expect(namesIn("receiver")).toEqual(["file_log", "otlp", "file_log/2"]);
  });
});

describe("a dropped or duplicated node of a renamed type keeps its place after a save and reload", () => {
  /** Where a node is drawn on the canvas: its position, plus its group's. */
  function placeOf(nodeId: string): { x: number; y: number } {
    const { nodes } = store().graph;
    const node = nodes.find((n) => n.id === nodeId)!;
    const parent = node.parentId === undefined ? undefined : nodes.find((n) => n.id === node.parentId);
    return { x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0) };
  }

  /** Saves the text and the graph's stored columns, then opens them again, as a reload does. */
  function saveAndReload(pin: string): void {
    const text = store().text;
    const stored = toStored(store().graph);
    useEditorStore.setState(initialState, true);
    store().load({
      organizationId: GROUP_ID,
      configuration: MINE,
      version: versionFixture({ yamlContent: text, collectorVersion: pin, ...stored }),
    });
  }

  function traces(): OTelNode {
    return store().graph.nodes.find((n) => n.type === "pipelineGroup")!;
  }

  it.each([
    ["exporter", "otlp", "exporters.otlp_grpc"],
    ["receiver", "filelog", "receivers.file_log"],
  ] as const)("the %s %s dropped on 0.162.0, written %s, in a group", (kind, paletteType, written) => {
    openPinned("0.162.0");
    const group = traces();
    const node = store().dropComponent(paletteIdOf(kind, paletteType), { x: group.position.x + 333, y: group.position.y + 77 })!;
    expect(componentKey(node.data)).toBe(written);
    const before = placeOf(node.id);

    saveAndReload("0.162.0");

    expect(placeOf(nodeByKey(written).id)).toEqual(before);
  });

  it("the OTLP exporter dropped on 0.162.0, away from every group", () => {
    openPinned("0.162.0");
    const node = drop("exporter", "otlp");
    const before = placeOf(node.id);

    saveAndReload("0.162.0");

    expect(placeOf(nodeByKey("exporters.otlp_grpc").id)).toEqual(before);
  });

  it("a duplicate of a typed otlp_grpc", () => {
    openPinned(
      "0.162.0",
      BASE.replace("  debug: {}\n", "  debug: {}\n  otlp_grpc:\n    endpoint: collector:4317\n").replace(
        "exporters: [debug]",
        "exporters: [debug, otlp_grpc]",
      ),
    );
    const copy = store().duplicateNode(nodeByKey("exporters.otlp_grpc").id)!;
    expect(componentKey(copy.data)).toBe("exporters.otlp_grpc/2");
    const before = placeOf(copy.id);

    saveAndReload("0.162.0");

    expect(placeOf(nodeByKey("exporters.otlp_grpc/2").id)).toEqual(before);
  });

  it("the selection's duplicates of a typed file_log", () => {
    openPinned("0.162.0", BASE.replace("receivers:\n", "receivers:\n  file_log: {}\n"));
    store().setSelection([nodeByKey("receivers.file_log").id]);
    const [copy] = store().duplicateSelectedNodes();
    expect(componentKey(copy!.data)).toBe("receivers.file_log/2");
    const before = placeOf(copy!.id);

    saveAndReload("0.162.0");

    expect(placeOf(nodeByKey("receivers.file_log/2").id)).toEqual(before);
  });

  it("a dropped node carries the parser's sharedConfigId for its key", () => {
    openPinned("0.162.0");
    const node = drop("exporter", "otlp");
    const parsed = parse(store().text);
    if (!parsed.ok) throw new Error(parsed.reason);
    const reread = parsed.graph.nodes.find((n) => componentKey(n.data) === "exporters.otlp_grpc")!;
    expect(node.data.sharedConfigId).toBe("exporter-otlp_grpc");
    expect(node.data.sharedConfigId).toBe(reread.data.sharedConfigId);
  });
});
