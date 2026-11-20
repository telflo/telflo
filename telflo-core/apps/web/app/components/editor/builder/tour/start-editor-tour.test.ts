import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_TOUR_DELAY_MS,
  TOUR_STORAGE_KEY,
  isTourCompleted,
  markTourCompleted,
  resetTourMemoryForTests,
  startEditorTour,
  stepsEmpty,
  stepsWithComponents,
} from "./start-editor-tour.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, openText } from "~/test/builder-store.js";

/*
 * The editor tour: its two step sets, word for word, the set the canvas
 * calls for, the steps' effects on the editor, and completion.
 */

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();

const copy = (steps: ReturnType<typeof stepsEmpty>) =>
  steps.map((step) => ({ title: step.popover?.title, description: step.popover?.description }));

/** The editor's anchors, and a React Flow node for each component on the canvas. */
function renderAnchors({ withNodes = true }: { withNodes?: boolean } = {}) {
  for (const anchor of ["toolbox", "canvas", "right-panel", "add-pipeline", "toolbar-actions", "version-select"]) {
    const el = document.createElement("div");
    el.dataset.tourStep = anchor;
    document.body.append(el);
  }
  if (!withNodes) return;
  const canvas = document.querySelector('[data-tour-step="canvas"]')!;
  for (const node of builderStore().graph.nodes) {
    const el = document.createElement("div");
    el.className = "react-flow__node";
    el.dataset.id = node.id;
    canvas.append(el);
  }
}

const popover = () => document.querySelector(".driver-popover");
const title = () => popover()?.querySelector(".driver-popover-title")?.textContent;
const progress = () => popover()?.querySelector(".driver-popover-progress-text")?.textContent;

/** driver.js's animation: its frames and timeouts, run out. */
function settle() {
  vi.advanceTimersByTime(1000);
}

function next() {
  const button = popover()!.querySelector<HTMLButtonElement>(".driver-popover-next-btn")!;
  button.click();
  settle();
}

/** Every tour a test starts, taken down after it: driver.js keeps its popover between tours. */
const stops: (() => void)[] = [];

function start() {
  const stop = startEditorTour();
  stops.push(stop);
  return stop;
}

/** Starts the tour and waits out its delay. */
function started() {
  const stop = start();
  vi.advanceTimersByTime(EDITOR_TOUR_DELAY_MS);
  settle();
  return stop;
}

/** Steps forward until the step titled `wanted`. */
function stepTo(wanted: string) {
  for (let guard = 0; title() !== wanted; guard++) {
    if (guard > 10) throw new Error(`no step ${wanted}`);
    next();
  }
}

beforeEach(() => {
  // driver.js moves between steps over 400 ms of animation frames.
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  useEditorStore.setState(initialState, true);
  window.localStorage.clear();
  resetTourMemoryForTests();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("the step sets", () => {
  it("says its words for a canvas with components", () => {
    expect(copy(stepsWithComponents())).toEqual([
      {
        title: "Component Toolbox",
        description:
          "This is where all your OpenTelemetry components live. Drag receivers, processors, exporters, and extensions onto the canvas to build your pipeline.",
      },
      {
        title: "Pipeline Canvas",
        description:
          "This is your workspace. Components are organized into pipelines by signal type (traces, metrics, logs). Connect them by dragging between ports.",
      },
      {
        title: "Select a Component",
        description:
          "Click any component to select it. Its configuration will appear in the right panel where you can edit endpoints, protocols, and other settings.",
      },
      {
        title: "Configure Components",
        description:
          "When a component is selected, its configuration appears here. Edit endpoints, protocols, batch sizes, and more — all changes sync to the YAML automatically.",
      },
      {
        title: "YAML View",
        description:
          "The YAML tab shows the raw OpenTelemetry Collector configuration. You can edit it directly here, then click Apply to update the visual canvas. A validation status bar at the bottom shows whether your config is valid.",
      },
      {
        title: "Add Pipeline",
        description:
          "Need another pipeline? Click here to create one. Each pipeline groups receivers, processors, and exporters for a specific signal type.",
      },
      {
        title: "Toolbar Actions",
        description: "Use the toolbar to undo/redo changes, duplicate or delete components, and save your work.",
      },
      {
        title: "Version History",
        description:
          "Manage versions of your configuration. Switch between versions, create copies, or publish a version for deployment.",
      },
    ]);
  });

  it("says its words for an empty canvas", () => {
    expect(copy(stepsEmpty())).toEqual([
      {
        title: "Component Toolbox",
        description:
          "Start building by dragging a component from here onto the canvas. Try dragging an OTLP Receiver into the Traces pipeline to get started.",
      },
      {
        title: "Pipeline Canvas",
        description:
          "Drop components into these pipeline groups. Each pipeline handles a signal type — traces, metrics, or logs. Connect components by dragging between their ports.",
      },
      {
        title: "Configuration & YAML",
        description:
          "When you select a component, configure it here. Switch to the YAML tab to view or edit the raw configuration — a validation bar at the bottom confirms if your config is valid.",
      },
      {
        title: "Add Pipeline",
        description:
          "Need another pipeline? Click here to create one. Each pipeline groups receivers, processors, and exporters for a specific signal type.",
      },
      {
        title: "Toolbar Actions",
        description: "Use the toolbar to undo/redo changes, duplicate or delete components, and save your work.",
      },
      {
        title: "Version History",
        description:
          "Manage versions of your configuration. Switch between versions, create copies, or publish a version for deployment.",
      },
    ]);
  });

  it("has the validation bar's sentence, word for word, in YAML View and Configuration & YAML only", () => {
    const sentences = new Map([
      ["YAML View", "A validation status bar at the bottom shows whether your config is valid."],
      ["Configuration & YAML", "— a validation bar at the bottom confirms if your config is valid."],
    ]);
    const steps = [...stepsWithComponents(), ...stepsEmpty()];
    for (const [title, sentence] of sentences) {
      const step = steps.find((candidate) => candidate.popover?.title === title);
      expect(step?.popover?.description?.endsWith(sentence)).toBe(true);
    }
    // "YAML View" says Apply puts the typed text on the canvas (not that it syncs back).
    expect(steps.find((step) => step.popover?.title === "YAML View")?.popover?.description).toContain(
      "You can edit it directly here, then click Apply to update the visual canvas.",
    );
    for (const step of steps) {
      if (!sentences.has(step.popover?.title ?? "")) expect(step.popover?.description).not.toMatch(/validation/i);
    }
  });

  it("has no AI step, and names neither the AI nor a download; only Version History names publishing", () => {
    for (const steps of [stepsWithComponents(), stepsEmpty()]) {
      for (const step of steps) {
        if (typeof step.element === "string") {
          expect(["toolbox", "canvas", "right-panel", "add-pipeline", "toolbar-actions", "version-select"]).toContain(
            /data-tour-step="([^"]+)"/.exec(step.element)?.[1],
          );
        }
        const words = `${step.popover?.title} ${step.popover?.description}`;
        expect(words).not.toMatch(/\bAI\b|assistant|download/i);
        if (step.popover?.title !== "Version History") expect(words).not.toMatch(/publish|deploy/i);
      }
    }
  });

  it("ends both sets on the version picker, Version History, which can't be used while shown", () => {
    for (const steps of [stepsWithComponents(), stepsEmpty()]) {
      const last = steps.at(-1)!;
      expect(last).toEqual({
        element: '[data-tour-step="version-select"]',
        disableActiveInteraction: true,
        popover: {
          title: "Version History",
          description:
            "Manage versions of your configuration. Switch between versions, create copies, or publish a version for deployment.",
          side: "bottom",
          align: "center",
        },
      });
      expect(steps.filter((step) => step.popover?.title === "Version History")).toHaveLength(1);
    }
  });
});

describe("startEditorTour", () => {
  it("waits 300 ms, then shows the component steps for a canvas with components", () => {
    openText(STARTER);
    renderAnchors();

    start();
    vi.advanceTimersByTime(EDITOR_TOUR_DELAY_MS - 1);
    expect(popover()).toBeNull();
    vi.advanceTimersByTime(1);

    expect(popover()).toHaveClass("tour-popover");
    expect(title()).toBe("Component Toolbox");
    expect(popover()!.querySelector(".driver-popover-description")!.textContent).toMatch(/^This is where all/);
    expect(progress()).toBe("1 of 8");
    expect(popover()!.querySelector(".driver-popover-next-btn")!.textContent).toBe("Next");
  });

  it("shows the empty canvas's steps when the canvas has no component", () => {
    openText("");
    expect(builderStore().graph.nodes.length).toBeGreaterThan(0); // the three default pipelines' groups
    renderAnchors();

    started();

    expect(progress()).toBe("1 of 6");
    expect(popover()!.querySelector(".driver-popover-description")!.textContent).toMatch(/^Start building/);
    next();
    expect(popover()!.querySelector(".driver-popover-prev-btn")!.textContent).toBe("Back");
  });

  it("highlights and selects the first component, on the Configuration tab", () => {
    openText(STARTER);
    renderAnchors();
    useEditorStore.setState({ activeTab: "yaml" });
    const first = builderStore().graph.nodes.find((n) => n.type !== "pipelineGroup")!;

    started();
    stepTo("Select a Component");

    expect(document.querySelector(".driver-active-element")).toBe(
      document.querySelector(`.react-flow__node[data-id="${first.id}"]`),
    );
    expect(builderStore().selectedNode?.id).toBe(first.id);
    expect(builderStore().activeTab).toBe("config");
  });

  it("points the component step at the canvas when the node isn't drawn", () => {
    openText(STARTER);
    renderAnchors({ withNodes: false });

    started();
    stepTo("Select a Component");

    expect(document.querySelector(".driver-active-element")).toBe(document.querySelector('[data-tour-step="canvas"]'));
  });

  it("clears the selection for the YAML tab, and goes back to Configuration for Add Pipeline", () => {
    openText(STARTER);
    renderAnchors();

    started();
    stepTo("YAML View");
    expect(builderStore().selectedNode).toBeNull();
    expect(builderStore().selectedNodes).toEqual([]);
    expect(builderStore().activeTab).toBe("yaml");

    next();
    expect(title()).toBe("Add Pipeline");
    expect(builderStore().activeTab).toBe("config");
  });

  it("highlights the version picker last, with no interaction while it is shown", () => {
    openText(STARTER);
    renderAnchors();

    started();
    stepTo("Version History");

    const picker = document.querySelector('[data-tour-step="version-select"]');
    expect(document.querySelector(".driver-active-element")).toBe(picker);
    expect(picker).toHaveClass("driver-no-interaction");
    expect(progress()).toBe("8 of 8");
    expect(popover()!.querySelector(".driver-popover-description")!.textContent).toBe(
      "Manage versions of your configuration. Switch between versions, create copies, or publish a version for deployment.",
    );
  });

  it("on Get Started: Configuration, nothing selected, completed", () => {
    openText(STARTER);
    renderAnchors();

    started();
    stepTo("Version History");
    useEditorStore.getState().selectNode(builderStore().graph.nodes.find((n) => n.type !== "pipelineGroup")!.id);
    useEditorStore.setState({ activeTab: "yaml" });
    expect(isTourCompleted()).toBe(false);
    const done = popover()!.querySelector<HTMLButtonElement>(".driver-popover-next-btn")!;
    expect(done.textContent).toBe("Get Started");
    done.click();
    settle();

    expect(popover()).toBeNull();
    expect(document.body).not.toHaveClass("driver-active");
    expect(builderStore().activeTab).toBe("config");
    expect(builderStore().selectedNode).toBeNull();
    expect(window.localStorage.getItem(TOUR_STORAGE_KEY)).toBe("true");
    expect(isTourCompleted()).toBe(true);
  });

  it("closing it early also marks it completed", () => {
    openText("");
    renderAnchors();

    started();
    popover()!.querySelector<HTMLButtonElement>(".driver-popover-close-btn")!.click();
    settle();

    expect(popover()).toBeNull();
    expect(window.localStorage.getItem(TOUR_STORAGE_KEY)).toBe("true");
  });

  it("stopping it cancels a pending start", () => {
    openText(STARTER);
    renderAnchors();

    const stop = start();
    stop();
    vi.advanceTimersByTime(EDITOR_TOUR_DELAY_MS * 2);

    expect(popover()).toBeNull();
  });

  it("stopping a running tour takes it down unfinished: not completed", () => {
    openText(STARTER);
    renderAnchors();

    const stop = started();
    expect(popover()).not.toBeNull();
    stop();
    settle();

    expect(popover()).toBeNull();
    expect(document.body).not.toHaveClass("driver-active");
    expect(isTourCompleted()).toBe(false);
  });

  it("never puts a component's name into a step", () => {
    openText("receivers:\n  otlp/tourmarker:\n    protocols:\n      grpc: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp/tourmarker]\n");
    renderAnchors();

    started();
    for (let step = 0; step < 8; step++) {
      expect(popover()!.innerHTML).not.toContain("tourmarker");
      if (step < 7) next();
    }
  });
});

describe("completion", () => {
  it("reads its completion flag under telflo's key", () => {
    expect(TOUR_STORAGE_KEY).toBe("telflo-tour-completed");
    expect(isTourCompleted()).toBe(false);
    window.localStorage.setItem(TOUR_STORAGE_KEY, "true");
    expect(isTourCompleted()).toBe(true);
  });

  it("survives storage that throws: completion is remembered for the page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    openText("");
    renderAnchors();

    expect(isTourCompleted()).toBe(false);
    started();
    expect(() => popover()!.querySelector<HTMLButtonElement>(".driver-popover-close-btn")!.click()).not.toThrow();

    expect(popover()).toBeNull();
    expect(isTourCompleted()).toBe(true);
  });

  it("marks completion directly", () => {
    markTourCompleted();
    expect(window.localStorage.getItem(TOUR_STORAGE_KEY)).toBe("true");
  });
});

describe("an editor without a version picker (the public editor: `versionHistory: false`)", () => {
  it("leaves out Version History, ending both sets on the toolbar's actions; the other steps as before", () => {
    for (const [without, all] of [
      [stepsWithComponents({ versionHistory: false }), stepsWithComponents()],
      [stepsEmpty({ versionHistory: false }), stepsEmpty()],
    ] as const) {
      expect(copy(without)).toEqual(copy(all).slice(0, -1));
      expect(without.at(-1)?.element).toBe('[data-tour-step="toolbar-actions"]');
    }
    expect(copy(stepsEmpty({ versionHistory: true }))).toEqual(copy(stepsEmpty()));
  });
});
