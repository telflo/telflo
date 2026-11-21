import type { CollectorDistribution, CollectorSupportedComponents } from "@telflo/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PALETTE_DRAG_TYPE, readPaletteDrop } from "./canvas-handlers.js";
import { CollapsibleToolbox } from "./CollapsibleToolbox.js";
import { ComponentPalette } from "./ComponentPalette.js";
import * as apiClient from "~/lib/api-client.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { PLAYGROUND_CATALOGUE } from "~/lib/playground/catalogue.js";
import { PlaygroundContext } from "~/lib/playground/context.js";
import { sampleVisitor } from "~/lib/playground/sample/types.js";
import { resetCollectorCatalogue, useCollectorCatalogueStore } from "~/lib/stores/collector-catalogue-store.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, openText } from "~/test/builder-store.js";
import { CATALOGUE, offer, seedCatalogue } from "~/test/collector-distributions.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

/*
 * The ComponentPalette tests (the allowlist's: the palette takes the
 * components from the catalog, not a fetch of its own), with the sections,
 * the drag, the help popover, the lock, the toolbox's collapse, and the
 * distribution's filter.
 */

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  resetCollectorCatalogue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A DataTransfer jsdom lacks: what a drag writes, readable back. */
function fakeDataTransfer() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "uninitialized",
    dropEffect: "none",
  };
}

describe("ComponentPalette", () => {
  it("renders every palette entry with no flag gating", () => {
    const { container } = render(<ComponentPalette />);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);
    expect(componentPalette).toHaveLength(57);
  });

  it("lists the Datadog receiver and exporter", () => {
    render(<ComponentPalette />);
    expect(screen.getAllByText("Datadog", { selector: "span" })).toHaveLength(2);
  });

  it("renders no Quick Setup template button", () => {
    render(<ComponentPalette />);
    expect(screen.queryByText("Quick Setup")).toBeNull();
  });

  it("has five sections, in order, with their counts", () => {
    const { container } = render(<ComponentPalette />);
    const sections = [...container.querySelectorAll("h3")].map((heading) => [
      heading.textContent,
      heading.nextElementSibling?.textContent,
    ]);
    expect(sections).toEqual([
      ["Receivers", "18"],
      ["Processors", "16"],
      ["Exporters", "11"],
      ["Extensions", "8"],
      ["Connectors", "4"],
    ]);
    const receivers = container.querySelector("h3")!.parentElement!.nextElementSibling!;
    expect(receivers.children).toHaveLength(18);
    expect(receivers.children[0]).toHaveTextContent("OTLP");
  });

  it("drags the static palette entry, which the canvas reads back by its id", () => {
    render(<ComponentPalette />);
    // The receiver's (the exporter has the same label).
    const chip = screen.getAllByText("Prometheus", { selector: "span" })[0]!.closest("[draggable]")!;
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(chip, { dataTransfer });

    const entry = componentPalette.find((e) => e.id === "prometheus-receiver");
    expect(JSON.parse(dataTransfer.getData(PALETTE_DRAG_TYPE))).toEqual(entry);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(readPaletteDrop(dataTransfer)).toBe("prometheus-receiver");
  });

  it("opens the help popover with the entry's title and its help text as written, backticks and all", async () => {
    const user = userEvent.setup();
    render(<ComponentPalette />);
    // The receiver's (the exporter has the same label).
    const trigger = screen.getAllByRole("button", { name: "About Prometheus" })[0]!;
    expect(trigger).toHaveAttribute("title", "About Prometheus");
    // The help's wrapper never starts a drag of the chip.
    expect(trigger.closest("[draggable]")).toHaveAttribute("draggable", "false");

    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Prometheus")).toBeInTheDocument();
    const help = componentPalette.find((e) => e.id === "prometheus-receiver")!.helpText;
    expect(help).toContain("`/metrics`");
    expect(within(dialog).getByText(help)).toBeInTheDocument();
  });

  it("doesn't drag while the canvas is locked (manual edit mode)", () => {
    openText(corpusText("starter.yaml"));
    builderStore().setText(`${builderStore().text}# typing\n`);
    const { container } = render(<ComponentPalette />);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    // The help still opens.
    expect(screen.getAllByRole("button", { name: /^About / })).toHaveLength(componentPalette.length);
  });
});

describe("CollapsibleToolbox", () => {
  it("collapses to the rail and either of the rail's buttons expands it", async () => {
    const user = userEvent.setup();
    const { container } = render(<CollapsibleToolbox />);
    const toolbox = container.firstElementChild!;
    expect(toolbox).toHaveAttribute("data-tour-step", "toolbox");
    expect(toolbox).toHaveClass("w-60");
    expect(screen.getByText("Components")).toHaveClass("tf-label");
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);

    await user.click(screen.getByTitle("Collapse panel"));
    expect(toolbox).toHaveClass("w-11");
    expect(container.querySelectorAll("[draggable]")).toHaveLength(0);

    await user.click(screen.getByTitle("Expand panel"));
    expect(toolbox).toHaveClass("w-60");

    await user.click(screen.getByTitle("Collapse panel"));
    await user.click(screen.getByTitle("Components"));
    expect(toolbox).toHaveClass("w-60");
    expect(screen.getByText("Receivers")).toBeInTheDocument();
  });
});

/** A smaller distribution's components (a trimmed ClickStack fixture): no Jaeger receiver. */
const SMALL_COMPONENTS: CollectorSupportedComponents = {
  receivers: ["otlp", "file_log", "host_metrics"],
  processors: ["batch", "memory_limiter"],
  exporters: ["debug", "otlp_grpc", "clickhouse"],
  connectors: ["forward", "routing"],
  extensions: ["health_check"],
};

/**
 * A fixture distribution with a component list (the committed catalog's
 * one distribution, Contrib, has none): 2.36.0 supports SMALL_COMPONENTS,
 * 2.35.0 those and the Jaeger receiver.
 */
const SMALL: CollectorDistribution = {
  id: "small-collector",
  label: "Small Collector",
  description: null,
  icon: null,
  isDefault: false,
  versions: [
    offer("2.36.0", { isDefault: true, supportedComponents: SMALL_COMPONENTS }),
    offer("2.35.0", { supportedComponents: { ...SMALL_COMPONENTS, receivers: [...SMALL_COMPONENTS.receivers, "jaeger"] } }),
  ],
  renamedTypes: [],
};

/** Opens `yamlContent` as a version of a configuration of `distributionId`, pinned at `collectorVersion`. */
function openOf(distributionId: string, collectorVersion: string, yamlContent = corpusText("minimal-pipeline.yaml")) {
  builderStore().load({
    organizationId: GROUP_ID,
    configuration: { ...MINE, collectorDistribution: distributionId },
    version: versionFixture({ yamlContent, collectorVersion }),
  });
}

/** The sections shown, each with its count. */
function sectionsOf(container: HTMLElement) {
  return [...container.querySelectorAll("h3")].map((heading) => [heading.textContent, heading.nextElementSibling?.textContent]);
}

describe("ComponentPalette: the distribution's components", () => {
  it("filters the palette to the distribution's supported components, without reading the catalog itself", () => {
    const read = vi.spyOn(apiClient, "getCollectorDistributions");
    seedCatalogue([...CATALOGUE, SMALL]);
    openOf(SMALL.id, "2.36.0");

    const { container } = render(<ComponentPalette />);

    // Jaeger isn't among the fixture's receivers at all.
    expect(screen.queryByText("Jaeger")).not.toBeInTheDocument();
    // OTLP is (the receiver, and the exporter by its `otlp_grpc`).
    expect(screen.getAllByText("OTLP", { selector: "span" })).toHaveLength(2);
    expect(sectionsOf(container)).toEqual([
      ["Receivers", "3"],
      ["Processors", "2"],
      ["Exporters", "3"],
      ["Extensions", "1"],
      ["Connectors", "2"],
    ]);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(11);
    // The editor page reads the catalog; the palette never does.
    expect(read).not.toHaveBeenCalled();
  });

  it("shows the full palette when the version's supportedComponents is null (contrib)", () => {
    seedCatalogue([...CATALOGUE, SMALL]);
    openOf(CATALOGUE[0]!.id, "0.162.0");

    const { container } = render(<ComponentPalette />);

    expect(screen.getByText("Jaeger")).toBeInTheDocument();
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);
  });

  it("takes the components from the catalog for the configuration's distribution and the pin on screen", async () => {
    seedCatalogue([...CATALOGUE, SMALL]);
    openOf(SMALL.id, "2.36.0");
    render(<CollapsibleToolbox />);
    expect(screen.queryByText("Jaeger")).not.toBeInTheDocument();

    // A pick in the toolbar, unsaved: the toolbox follows it at once.
    act(() => builderStore().setCollectorVersion("2.35.0"));
    expect(screen.getByText("Jaeger")).toBeInTheDocument();
    expect(screen.getByText("Receivers").nextElementSibling).toHaveTextContent("4");

    // Discard puts the saved pin back, and its components.
    act(() => builderStore().discardChanges());
    expect(screen.queryByText("Jaeger")).not.toBeInTheDocument();
  });

  it("shows every component while the catalog is unread or its read failed, and filters once it is read", () => {
    openOf(SMALL.id, "2.36.0");
    const { container } = render(<ComponentPalette />);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);

    act(() => useCollectorCatalogueStore.setState({ status: "failed" }));
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);

    act(() => seedCatalogue([...CATALOGUE, SMALL]));
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(11);
  });

  it("shows every component for a pin the catalog no longer offers, or a distribution it doesn't list", () => {
    seedCatalogue([...CATALOGUE, SMALL]);
    openOf(SMALL.id, "2.20.0");
    const { container, unmount } = render(<ComponentPalette />);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);
    unmount();

    openOf("unknown-collector", "2.36.0");
    const second = render(<ComponentPalette />);
    expect(second.container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);
  });

  it("hides nothing on the canvas: a component the distribution doesn't support stays there, and in the text", () => {
    const text = `receivers:
  jaeger:
    protocols:
      grpc:
exporters:
  debug:
service:
  pipelines:
    traces:
      receivers: [jaeger]
      exporters: [debug]
`;
    seedCatalogue([...CATALOGUE, SMALL]);
    openOf(SMALL.id, "2.36.0", text);
    const keys = () => builderStore().graph.nodes.map((node) => componentKey(node.data));

    render(<CollapsibleToolbox />);

    expect(screen.queryByText("Jaeger")).not.toBeInTheDocument();
    expect(keys()).toContain("receivers.jaeger");
    expect(builderStore().text).toBe(text);
  });
});

describe("ComponentPalette in the playground", () => {
  it("shows every component, even with a catalog this tab read on a signed-in page that would narrow it", () => {
    seedCatalogue([...CATALOGUE, SMALL]);
    openOf(SMALL.id, "2.36.0");
    const value = { visitor: sampleVisitor(), lock: () => undefined, catalogue: PLAYGROUND_CATALOGUE, openSignInToSave: () => undefined };

    const { container } = render(
      <PlaygroundContext.Provider value={value}>
        <ComponentPalette />
      </PlaygroundContext.Provider>,
    );

    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);
    // The same store, outside the playground, narrows it.
    const outside = render(<ComponentPalette />);
    expect(outside.container.querySelectorAll('[draggable="true"]')).toHaveLength(11);
  });
});
