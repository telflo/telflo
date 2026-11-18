import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectOnCanvas,
  displayedEdges,
  displayedNode,
  dropOnCanvas,
  minimapNodeColor,
  PALETTE_DRAG_TYPE,
  readPaletteDrop,
  readViewport,
  selectionIds,
  VIEWPORT_STORAGE_KEY,
  VIEWPORTS_KEPT,
  warnRefusedConnection,
  writePaletteDrag,
  writeViewport,
} from "./canvas-handlers.js";
import { GROUP_SOURCE_HANDLE, GROUP_TARGET_HANDLE } from "./nodes/PipelineGroupNode.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { componentPalette, findPaletteEntry } from "~/lib/graph/palette.js";
import type { OTelNode } from "~/lib/graph/types.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

const VERSION_ID = "0199c000-0000-7000-8000-000000000001";

function open(yamlContent: string) {
  const version = versionFixture({ id: VERSION_ID, yamlContent });
  store().load({ organizationId: GROUP_ID, configuration: MINE, version });
}

function transfer(data: Record<string, string>): Pick<DataTransfer, "getData"> {
  return { getData: (type: string) => data[type] ?? "" };
}

function groupOf(name: string): OTelNode {
  const found = store().graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === name);
  if (!found) throw new Error(`no group ${name}`);
  return found;
}

function nodeOf(key: string, pipeline?: string): OTelNode {
  const groupId = pipeline === undefined ? undefined : groupOf(pipeline).id;
  const found = store().graph.nodes.find(
    (n) => n.type !== "pipelineGroup" && componentKey(n.data) === key && n.parentId === groupId,
  );
  if (!found) throw new Error(`no node ${key}`);
  return found;
}

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "warning").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the palette's drag payload", () => {
  it("carries the static palette entry, and a drop reads its id back", () => {
    const entry = componentPalette[0]!;
    const data: Record<string, string> = {};
    const dataTransfer = { setData: (type: string, value: string) => void (data[type] = value), effectAllowed: "none" };
    writePaletteDrag(dataTransfer as Pick<DataTransfer, "setData" | "effectAllowed">, entry);
    expect(JSON.parse(data[PALETTE_DRAG_TYPE]!)).toEqual(entry);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(readPaletteDrop(transfer(data))).toBe(entry.id);
  });

  it("reads nothing from another kind of drag, broken JSON, or an id the palette doesn't have", () => {
    expect(readPaletteDrop(transfer({ "text/plain": "otlp-receiver" }))).toBeNull();
    expect(readPaletteDrop(transfer({ [PALETTE_DRAG_TYPE]: "{not json" }))).toBeNull();
    expect(readPaletteDrop(transfer({ [PALETTE_DRAG_TYPE]: "null" }))).toBeNull();
    expect(readPaletteDrop(transfer({ [PALETTE_DRAG_TYPE]: '"otlp-receiver"' }))).toBeNull();
    expect(readPaletteDrop(transfer({ [PALETTE_DRAG_TYPE]: '{"id":7}' }))).toBeNull();
    expect(readPaletteDrop(transfer({ [PALETTE_DRAG_TYPE]: '{"id":"no-such-entry"}' }))).toBeNull();
    expect(readPaletteDrop(transfer({ [PALETTE_DRAG_TYPE]: '{"id":"toString"}' }))).toBeNull();
  });
});

describe("a drop on the canvas", () => {
  const OTLP = JSON.stringify(findPaletteEntry("receiver", "otlp"));

  it("in a group: that parent, a position relative to it, 'Label (2)', its own config copy, selected", () => {
    open(corpusText("starter.yaml"));
    const traces = groupOf("traces");
    const at = { x: traces.position.x + 300, y: traces.position.y + 120 };
    const toFlow = vi.fn(() => at);

    const node = dropOnCanvas(transfer({ [PALETTE_DRAG_TYPE]: OTLP }), { x: 640, y: 480 }, toFlow);

    expect(toFlow).toHaveBeenCalledWith({ x: 640, y: 480 });
    expect(node).not.toBeNull();
    expect(node!.parentId).toBe(traces.id);
    expect(node!.position).toEqual({ x: 300, y: 120 });
    expect(node!.data.label).toBe("OTLP (2)");
    expect(node!.data.instanceName).toBe("2");
    const palette = findPaletteEntry("receiver", "otlp")!;
    expect(node!.data.config).toEqual(palette.defaultConfig);
    expect(node!.data.config).not.toBe(palette.defaultConfig);
    expect(Object.isFrozen(node!.data.config)).toBe(false);
    expect(store().selectedNode?.id).toBe(node!.id);
    expect(store().graph.nodes.find((n) => n.id === node!.id)?.selected).toBe(true);
    expect(store().text).toContain("otlp/2:");
    expect(store().history.past.at(-1)?.description).toBe("Add OTLP (2)");
  });

  it("outside every group: ungrouped, at the point", () => {
    open(corpusText("starter.yaml"));
    const node = dropOnCanvas(transfer({ [PALETTE_DRAG_TYPE]: JSON.stringify(findPaletteEntry("processor", "filter")) }), { x: 0, y: 0 }, () => ({
      x: -2000,
      y: -2000,
    }));
    expect(node!.parentId).toBeUndefined();
    expect(node!.position).toEqual({ x: -2000, y: -2000 });
    expect(node!.data.label).toBe("Filter");
  });

  it("does nothing for a drag that isn't a palette entry, or while the canvas is locked", () => {
    open(corpusText("starter.yaml"));
    const before = store().graph;
    expect(dropOnCanvas(transfer({ "text/plain": "x" }), { x: 0, y: 0 }, () => ({ x: 0, y: 0 }))).toBeNull();
    store().setText(`${store().text}\n# typed`);
    expect(dropOnCanvas(transfer({ [PALETTE_DRAG_TYPE]: OTLP }), { x: 0, y: 0 }, () => ({ x: 0, y: 0 }))).toBeNull();
    expect(store().graph).toBe(before);
  });
});

describe("a connection drawn on the canvas", () => {
  function refusedQuietly(source: string, target: string) {
    const before = { text: store().text, graph: store().graph, entries: store().history.past.length };
    expect(connectOnCanvas({ source, target, sourceHandle: null, targetHandle: null })).toEqual({ ok: false });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(store().text).toBe(before.text);
    expect(store().graph.edges).toBe(before.graph.edges);
    expect(store().history.past).toHaveLength(before.entries);
  }

  it("refuses each of the connection rules, silently", () => {
    open(corpusText("routing-connector.yaml"));
    const receiver = nodeOf("receivers.otlp", "traces/in");
    const exporter = nodeOf("exporters.otlp", "traces/out");
    const routing = nodeOf("connectors.routing");
    const group = groupOf("traces/in");

    refusedQuietly(group.id, exporter.id); // a group as the source
    refusedQuietly(receiver.id, group.id); // a group as the target
    refusedQuietly(receiver.id, receiver.id); // a node to itself
    refusedQuietly(routing.id, exporter.id); // routing names its targets in config
    refusedQuietly(exporter.id, receiver.id); // an exporter as the source
    refusedQuietly("node_999", exporter.id); // a node that isn't there
  });

  it("refuses a receiver as the target, an extension at either end, and a connection already drawn", () => {
    open(corpusText("starter.yaml"));
    const receiver = nodeOf("receivers.otlp", "traces");
    const batch = nodeOf("processors.batch", "traces");
    const exporter = nodeOf("exporters.otlp", "traces");
    const extension = nodeOf("extensions.health_check");

    refusedQuietly(batch.id, receiver.id);
    refusedQuietly(extension.id, exporter.id);
    refusedQuietly(batch.id, extension.id);
    refusedQuietly(receiver.id, batch.id); // already drawn
  });

  it("refuses a connector fed from a pipeline of another signal, with a two-line warning", () => {
    open(corpusText("connector-memberships.yaml"));
    const spanmetrics = nodeOf("connectors.spanmetrics");
    const debug = nodeOf("exporters.debug", "metrics");
    const logsReceiver = nodeOf("receivers.otlp", "logs");
    const before = store().text;

    expect(connectOnCanvas({ source: logsReceiver.id, target: spanmetrics.id, sourceHandle: null, targetHandle: null })).toMatchObject({
      ok: false,
    });
    expect(toast.warning).toHaveBeenCalledWith(`${spanmetrics.data.label} requires traces input`, {
      description: "The source node is in a logs pipeline",
      className: "ph-no-capture",
    });
    expect(store().text).toBe(before);

    vi.mocked(toast.warning).mockClear();
    // An exporter dropped into the logs pipeline: spanmetrics outputs metrics.
    expect(debug.parentId).toBe(groupOf("metrics").id);
    const logsGroup = groupOf("logs");
    const dropped = dropOnCanvas(
      transfer({ [PALETTE_DRAG_TYPE]: JSON.stringify(findPaletteEntry("exporter", "debug")) }),
      { x: 0, y: 0 },
      () => ({ x: logsGroup.position.x + 400, y: logsGroup.position.y + 60 }),
    );
    expect(dropped?.parentId).toBe(logsGroup.id);
    const text = store().text;
    expect(
      connectOnCanvas({ source: nodeOf("connectors.spanmetrics").id, target: dropped!.id, sourceHandle: null, targetHandle: null }),
    ).toMatchObject({ ok: false });
    expect(toast.warning).toHaveBeenCalledWith(`${spanmetrics.data.label} outputs metrics`, {
      description: "The target node is in a logs pipeline",
      className: "ph-no-capture",
    });
    expect(store().text).toBe(text);
  });

  it("draws a connection with an undo entry, writing the pipeline's list", () => {
    open(corpusText("starter.yaml"));
    const traces = groupOf("traces");
    const filter = dropOnCanvas(
      transfer({ [PALETTE_DRAG_TYPE]: JSON.stringify(findPaletteEntry("processor", "filter")) }),
      { x: 0, y: 0 },
      () => ({ x: traces.position.x + 600, y: traces.position.y + 100 }),
    )!;
    const entries = store().history.past.length;
    expect(connectOnCanvas({ source: nodeOf("processors.batch", "traces").id, target: filter.id, sourceHandle: null, targetHandle: null })).toEqual({
      ok: true,
    });
    expect(store().history.past).toHaveLength(entries + 1);
    expect(store().history.past.at(-1)?.description).toBe("Connect nodes");
    expect(store().graph.edges.some((e) => e.source === nodeOf("processors.batch", "traces").id && e.target === filter.id)).toBe(
      true,
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("adopts an ungrouped end into the other's group, as 'Add <label> to <group>'", () => {
    open(corpusText("starter.yaml"));
    const loose = dropOnCanvas(
      transfer({ [PALETTE_DRAG_TYPE]: JSON.stringify(findPaletteEntry("exporter", "debug")) }),
      { x: 0, y: 0 },
      () => ({ x: -3000, y: -3000 }),
    )!;
    expect(loose.parentId).toBeUndefined();
    const traces = groupOf("traces");
    const children = store().graph.nodes.filter((n) => n.parentId === traces.id).length;

    expect(connectOnCanvas({ source: nodeOf("processors.batch", "traces").id, target: loose.id, sourceHandle: null, targetHandle: null })).toEqual({
      ok: true,
    });
    const adopted = store().graph.nodes.find((n) => n.id === loose.id)!;
    expect(adopted.parentId).toBe(traces.id);
    expect(adopted.position).toEqual({ x: 50 + 250 * children, y: 70 });
    expect(store().history.past.at(-1)?.description).toBe("Add Debug to traces");
    expect(store().text).toMatch(/traces:\n\s+receivers: \[otlp\]\n\s+processors: \[batch\]\n\s+exporters: \[otlp, debug\]/);
  });
});

describe("the nodes the canvas is given", () => {
  it("keeps a component in a pipeline inside its group, and leaves groups and ungrouped nodes free (Ruling 41)", () => {
    open(corpusText("starter.yaml"));
    const graph = store().graph;
    const receiver = graph.nodes.find((n) => n.type === "receiver" && n.parentId !== undefined)!;
    const group = graph.nodes.find((n) => n.type === "pipelineGroup")!;
    const extension = graph.nodes.find((n) => n.type === "extension")!;

    expect(displayedNode(receiver).extent).toBe("parent");
    expect(displayedNode(receiver)).toBe(displayedNode(receiver));
    expect(receiver.extent).toBeUndefined();
    expect(displayedNode(group)).toBe(group);
    expect(displayedNode(extension)).toBe(extension);
  });
});

describe("the edges the canvas draws", () => {
  it("adds the route edges of a routing connector, read-only, and hides stored edges leaving it", () => {
    open(corpusText("routing-connector.yaml"));
    const routing = nodeOf("connectors.routing");
    const graph = store().graph;
    const stale = { id: "edge_900", source: routing.id, target: nodeOf("exporters.otlp", "traces/out").id, type: "smoothstep" };
    const edges = displayedEdges({ ...graph, edges: [...graph.edges, stale] });

    expect(edges.find((e) => e.id === "edge_900")?.hidden).toBe(true);
    const routes = edges.filter((e) => e.type === "route");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      source: routing.id,
      target: groupOf("traces/out").id,
      targetHandle: "route",
      selectable: false,
      deletable: false,
      focusable: false,
    });
    expect(routes[0]!.data?.label).toBe("1 route + default");
    for (const edge of edges) expect(edge.id).toMatch(/^(edge_\d+|route-node_\d+-group_\d+)$/);
  });

  it("draws a connector's edge to or from its pipeline's group read-only, on the group's anchors", () => {
    open(corpusText("connector-memberships.yaml"));
    const edges = displayedEdges(store().graph);
    const groups = new Set(store().graph.nodes.filter((n) => n.type === "pipelineGroup").map((n) => n.id));
    const anchored = edges.filter((e) => groups.has(e.source) || groups.has(e.target));
    expect(anchored.length).toBeGreaterThan(0);
    for (const edge of anchored) {
      expect(edge).toMatchObject({ selectable: false, deletable: false, focusable: false });
      if (groups.has(edge.target)) expect(edge.targetHandle).toBe(GROUP_TARGET_HANDLE);
      if (groups.has(edge.source)) expect(edge.sourceHandle).toBe(GROUP_SOURCE_HANDLE);
    }
    const plain = edges.filter((e) => !groups.has(e.source) && !groups.has(e.target) && e.type !== "route");
    for (const edge of plain) expect(edge.selectable).toBeUndefined();
  });
});

describe("the minimap's colours", () => {
  it("is a group's pipeline colour, a component's type colour, from nothing a person wrote", () => {
    const group = (color: unknown) => ({ type: "pipelineGroup", data: { label: "x", componentType: "pipelineGroup", componentSubType: "", config: null, color } }) as OTelNode;
    expect(minimapNodeColor(group("#f97316"))).toBe("#f97316");
    expect(minimapNodeColor(group(undefined))).toBe("#374151");
    expect(minimapNodeColor(group("red; background:url(x)"))).toBe("#374151");
    for (const type of ["receiver", "processor", "exporter", "extension", "connector"] as const) {
      expect(minimapNodeColor({ type, data: { label: "x", componentType: type, componentSubType: "x", config: null } })).toBe(
        `var(--color-node-${type})`,
      );
    }
    expect(minimapNodeColor({ type: "odd", data: { label: "x", componentType: "odd" as never, componentSubType: "x", config: null } })).toBe(
      "var(--color-gray-300)",
    );
  });
});

describe("small pieces", () => {
  it("warns only for a refusal that carries a warning", () => {
    const warn = vi.fn();
    warnRefusedConnection({ ok: true }, warn);
    warnRefusedConnection({ ok: false }, warn);
    expect(warn).not.toHaveBeenCalled();
    warnRefusedConnection({ ok: false, warning: { title: "T", description: "D" } }, warn);
    expect(warn).toHaveBeenCalledWith("T", { description: "D" });
  });

  it("gives the selection's ids", () => {
    expect(selectionIds([{ id: "node_1" }, { id: "group_0" }])).toEqual(["node_1", "group_0"]);
  });
});

describe("the viewport, per version", () => {
  const VIEWPORT = { x: 12, y: -40, zoom: 1.25 };

  it("is remembered under the product's own key, by the version's id", () => {
    expect(readViewport(VERSION_ID)).toBeNull();
    writeViewport(VERSION_ID, VIEWPORT);
    expect(readViewport(VERSION_ID)).toEqual(VIEWPORT);
    expect(JSON.parse(window.localStorage.getItem(VIEWPORT_STORAGE_KEY)!)).toEqual({ [VERSION_ID]: VIEWPORT });
    expect(readViewport("0199c000-0000-7000-8000-000000000002")).toBeNull();
    expect(readViewport(undefined)).toBeNull();
  });

  it("keeps positions only, and nothing for no version or a viewport that isn't one", () => {
    writeViewport(VERSION_ID, { ...VIEWPORT, extra: "x" } as never);
    expect(JSON.parse(window.localStorage.getItem(VIEWPORT_STORAGE_KEY)!)[VERSION_ID]).toEqual(VIEWPORT);
    window.localStorage.clear();
    writeViewport(undefined, VIEWPORT);
    writeViewport(VERSION_ID, { x: Number.NaN, y: 0, zoom: 1 });
    writeViewport(VERSION_ID, { x: 0, y: 0, zoom: 0 });
    expect(window.localStorage.getItem(VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("reads nothing from a broken or foreign value, and writes over it", () => {
    window.localStorage.setItem(VIEWPORT_STORAGE_KEY, "{not json");
    expect(readViewport(VERSION_ID)).toBeNull();
    writeViewport(VERSION_ID, VIEWPORT);
    expect(readViewport(VERSION_ID)).toEqual(VIEWPORT);
    window.localStorage.setItem(VIEWPORT_STORAGE_KEY, "[1,2]");
    expect(readViewport(VERSION_ID)).toBeNull();
    window.localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify({ [VERSION_ID]: { x: "1", y: 0, zoom: 1 } }));
    expect(readViewport(VERSION_ID)).toBeNull();
    window.localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify({ toString: VIEWPORT }));
    expect(readViewport("toString")).toEqual(VIEWPORT);
    expect(readViewport("constructor")).toBeNull();
  });

  it("never throws when storage can't be used", () => {
    const broken = () => {
      throw new Error("SecurityError");
    };
    expect(readViewport(VERSION_ID, broken)).toBeNull();
    expect(() => writeViewport(VERSION_ID, VIEWPORT, broken)).not.toThrow();
    const full = { getItem: () => null, setItem: () => {
      throw new Error("QuotaExceededError");
    } };
    expect(() => writeViewport(VERSION_ID, VIEWPORT, () => full)).not.toThrow();
    const unreadable = { getItem: () => {
      throw new Error("SecurityError");
    }, setItem: vi.fn() };
    writeViewport(VERSION_ID, VIEWPORT, () => unreadable);
    expect(unreadable.setItem).toHaveBeenCalledWith(VIEWPORT_STORAGE_KEY, JSON.stringify({ [VERSION_ID]: VIEWPORT }));
  });

  it(`keeps the ${VIEWPORTS_KEPT} versions written last`, () => {
    const id = (n: number) => `0199c000-0000-7000-8000-${String(n).padStart(12, "0")}`;
    for (let n = 1; n <= VIEWPORTS_KEPT + 5; n++) writeViewport(id(n), { x: n, y: n, zoom: 1 });
    expect(readViewport(id(5))).toBeNull();
    expect(readViewport(id(6))).toEqual({ x: 6, y: 6, zoom: 1 });
    writeViewport(id(6), { x: 0, y: 0, zoom: 2 }); // written again: now the latest
    writeViewport(id(100), { x: 1, y: 1, zoom: 1 }); // one more: the oldest, 7, goes
    const kept = Object.keys(JSON.parse(window.localStorage.getItem(VIEWPORT_STORAGE_KEY)!));
    expect(kept).toHaveLength(VIEWPORTS_KEPT);
    expect(kept.slice(-2)).toEqual([id(6), id(100)]);
    expect(readViewport(id(7))).toBeNull();
    expect(readViewport(id(6))).toEqual({ x: 0, y: 0, zoom: 2 });
  });
});
