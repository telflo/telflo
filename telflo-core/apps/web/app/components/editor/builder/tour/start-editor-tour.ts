import type { DriveStep, Driver } from "driver.js";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "~/components/tour/tour-theme.css";
import { isGroup } from "~/lib/graph/canvas-operations.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The editor tour, with its two step sets: one for a canvas with
 * components, one for an empty canvas.
 * - there is no AI step and no "Use the AI tab";
 * - "Version History" is always the last step, the picker being always in
 *   the toolbar. Its sentence includes publishing. The picker can't be used
 *   while it is highlighted, so a choice mid-tour can't take the toolbar it
 *   points at away;
 * - "YAML View" and "Configuration & YAML" have the validation bar's
 *   sentence, and "YAML View" says the typed text reaches the canvas
 *   through Apply, not that changes sync back; "Toolbar Actions" offers no
 *   download, which the toolbar doesn't have;
 * - the page starts it only once the configuration has loaded, so the set
 *   is chosen from the configuration's own canvas;
 * - completion is remembered as `telflo-tour-completed`, and storage that
 *   refuses is survived;
 * - the shared tour theme (`tour-popover`) is reused.
 *
 * driver.js renders titles and descriptions as HTML: every word here is
 * fixed text, and nothing a person wrote (a label, a name, the YAML) may
 * ever be put into a step. The component step finds its node by comparing
 * React Flow's `data-id` (an opaque `node_<n>`), never by a built selector.
 */

export const TOUR_STORAGE_KEY = "telflo-tour-completed";

/** How long the editor gets to render before the tour. */
export const EDITOR_TOUR_DELAY_MS = 300;

/** Completion, when storage refuses to remember it: at least for this page's life. */
let completedInMemory = false;

export function isTourCompleted(): boolean {
  if (typeof window === "undefined") return true;
  if (completedInMemory) return true;
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function markTourCompleted(): void {
  if (typeof window === "undefined") return;
  completedInMemory = true;
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, "true");
  } catch {
    // Storage refused: remembered in memory only.
  }
}

/** For tests: forgets the in-memory completion. */
export function resetTourMemoryForTests(): void {
  completedInMemory = false;
}

function firstComponentId(): string | undefined {
  return useEditorStore.getState().graph.nodes.find((node) => !isGroup(node))?.id;
}

function hasComponents(): boolean {
  return firstComponentId() !== undefined;
}

/** The first component's node on the canvas, else the canvas. */
function firstComponentElement(): Element {
  const id = firstComponentId();
  const node =
    id === undefined
      ? undefined
      : Array.from(document.querySelectorAll(".react-flow__node")).find((el) => el.getAttribute("data-id") === id);
  return node ?? document.querySelector('[data-tour-step="canvas"]')!;
}

function selectFirstComponent(): void {
  const id = firstComponentId();
  if (id !== undefined) useEditorStore.getState().selectNode(id);
}

function clearSelection(): void {
  useEditorStore.getState().selectNode(null);
}

function switchTab(tab: "config" | "yaml"): void {
  useEditorStore.getState().setActiveTab(tab);
}

const TOOLBAR_ACTIONS: DriveStep = {
  element: '[data-tour-step="toolbar-actions"]',
  popover: {
    title: "Toolbar Actions",
    description: "Use the toolbar to undo/redo changes, duplicate or delete components, and save your work.",
    side: "bottom",
    align: "center",
  },
};

/** The last step, on the version picker. */
const VERSION_HISTORY: DriveStep = {
  element: '[data-tour-step="version-select"]',
  // Even if the tour's own setting changes: a version chosen mid-tour would
  // load another version under the step.
  disableActiveInteraction: true,
  popover: {
    title: "Version History",
    description:
      "Manage versions of your configuration. Switch between versions, create copies, or publish a version for deployment.",
    side: "bottom",
    align: "center",
  },
};

const ADD_PIPELINE_DESCRIPTION =
  "Need another pipeline? Click here to create one. Each pipeline groups receivers, processors, and exporters for a specific signal type.";

/**
 * What a tour holds beyond its fixed steps. `versionHistory` (default true)
 * ends it on the version picker; an editor without one (the blank
 * public editor) leaves that step out.
 */
export interface EditorTourOptions {
  versionHistory?: boolean;
}

/** The last steps: the toolbar's actions, then the version picker where the editor has one. */
function closingSteps({ versionHistory = true }: EditorTourOptions): DriveStep[] {
  return versionHistory ? [TOOLBAR_ACTIONS, VERSION_HISTORY] : [TOOLBAR_ACTIONS];
}

/** The steps for a canvas that already has components. */
export function stepsWithComponents(options: EditorTourOptions = {}): DriveStep[] {
  return [
    {
      element: '[data-tour-step="toolbox"]',
      popover: {
        title: "Component Toolbox",
        description:
          "This is where all your OpenTelemetry components live. Drag receivers, processors, exporters, and extensions onto the canvas to build your pipeline.",
        side: "right",
        align: "center",
      },
    },
    {
      element: '[data-tour-step="canvas"]',
      popover: {
        title: "Pipeline Canvas",
        description:
          "This is your workspace. Components are organized into pipelines by signal type (traces, metrics, logs). Connect them by dragging between ports.",
        side: "bottom",
        align: "center",
      },
    },
    {
      element: firstComponentElement,
      popover: {
        title: "Select a Component",
        description:
          "Click any component to select it. Its configuration will appear in the right panel where you can edit endpoints, protocols, and other settings.",
        side: "left",
        align: "center",
      },
      onHighlighted: () => {
        selectFirstComponent();
        switchTab("config");
      },
    },
    {
      element: '[data-tour-step="right-panel"]',
      popover: {
        title: "Configure Components",
        description:
          "When a component is selected, its configuration appears here. Edit endpoints, protocols, batch sizes, and more — all changes sync to the YAML automatically.",
        side: "left",
        align: "start",
      },
    },
    {
      element: '[data-tour-step="right-panel"]',
      popover: {
        title: "YAML View",
        description:
          "The YAML tab shows the raw OpenTelemetry Collector configuration. You can edit it directly here, then click Apply to update the visual canvas. A validation status bar at the bottom shows whether your config is valid.",
        side: "left",
        align: "center",
      },
      onHighlighted: () => {
        clearSelection();
        switchTab("yaml");
      },
    },
    {
      element: '[data-tour-step="add-pipeline"]',
      popover: {
        title: "Add Pipeline",
        description: ADD_PIPELINE_DESCRIPTION,
        side: "left",
        align: "center",
      },
      onHighlighted: () => {
        switchTab("config");
      },
    },
    ...closingSteps(options),
  ];
}

/** The steps for an empty canvas. */
export function stepsEmpty(options: EditorTourOptions = {}): DriveStep[] {
  return [
    {
      element: '[data-tour-step="toolbox"]',
      popover: {
        title: "Component Toolbox",
        description:
          "Start building by dragging a component from here onto the canvas. Try dragging an OTLP Receiver into the Traces pipeline to get started.",
        side: "right",
        align: "center",
      },
    },
    {
      element: '[data-tour-step="canvas"]',
      popover: {
        title: "Pipeline Canvas",
        description:
          "Drop components into these pipeline groups. Each pipeline handles a signal type — traces, metrics, or logs. Connect components by dragging between their ports.",
        side: "bottom",
        align: "center",
      },
    },
    {
      element: '[data-tour-step="right-panel"]',
      popover: {
        title: "Configuration & YAML",
        description:
          "When you select a component, configure it here. Switch to the YAML tab to view or edit the raw configuration — a validation bar at the bottom confirms if your config is valid.",
        side: "left",
        align: "center",
      },
    },
    {
      element: '[data-tour-step="add-pipeline"]',
      popover: {
        title: "Add Pipeline",
        description: ADD_PIPELINE_DESCRIPTION,
        side: "left",
        align: "center",
      },
    },
    ...closingSteps(options),
  ];
}

/**
 * Starts the tour after its delay, with the set the canvas calls for.
 * Closing it or finishing it leaves the Configuration tab showing with
 * nothing selected, and marks it completed. The function returned stops it:
 * a pending start is canceled, and a running tour is taken down without
 * being marked completed (the page is going). `options` as the steps take
 * them: `{ versionHistory: false }` where the editor has no version picker.
 */
export function startEditorTour(options: EditorTourOptions = {}): () => void {
  if (typeof window === "undefined") return () => undefined;
  let running: Driver | null = null;
  const timer = window.setTimeout(() => {
    const tour = driver({
      showProgress: true,
      animate: true,
      smoothScroll: true,
      allowClose: true,
      overlayColor: "black",
      overlayOpacity: 0.5,
      stagePadding: 8,
      stageRadius: 8,
      disableActiveInteraction: true,
      popoverClass: "tour-popover",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Get Started",
      onDestroyStarted: () => {
        switchTab("config");
        clearSelection();
        markTourCompleted();
        running = null;
        tour.destroy();
      },
      steps: hasComponents() ? stepsWithComponents(options) : stepsEmpty(options),
    });
    running = tour;
    tour.drive();
  }, EDITOR_TOUR_DELAY_MS);
  return () => {
    window.clearTimeout(timer);
    const tour = running;
    running = null;
    tour?.destroy();
  };
}
