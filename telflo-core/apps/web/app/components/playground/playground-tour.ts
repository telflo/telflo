import type { DriveStep, Driver } from "driver.js";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "~/components/tour/tour-theme.css";
import { isGroup } from "~/lib/graph/canvas-operations.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The playground tour: three driver.js runs chained across the playground's
 * pages, the configurations list, then the sample's editor, then fleet
 * management. driver.js lives within one page, so each stage is its own run
 * and the hand-over travels through sessionStorage: a stage's last step stores
 * the next stage's name and navigates, and the page it lands on takes the name
 * in an effect and starts its own run. Closing the tour at any point (✕, Esc,
 * the overlay, Finish) marks it completed, so the welcome dialog never offers
 * it again; the banner's "Take the tour" restarts it from the list
 * (`restartPlaygroundTour`).
 *
 * Its rules:
 * - the keys are `telflo-playground-tour-completed` (localStorage) and
 *   `telflo-playground-tour-stage` (sessionStorage). Storage that refuses
 *   is survived (in memory, for the page's life), as the editor's own tour
 *   does;
 * - no AI step and no `fleet-usage` step (the platform's fleet list has no
 *   usage strip); the fleet table's step names what the platform's table
 *   shows (its status and its configuration's sync; it has no collector
 *   version column);
 * - the playground editor runs only this tour's editor stage, never the
 *   editor's own tour (`start-editor-tour.ts`);
 * - a stage waits for its page's anchor (bounded) before it starts, so a
 *   page whose list arrives after the settle delay is still pointed at.
 *
 * driver.js renders titles and descriptions as HTML: every word here is
 * fixed text; nothing a visitor typed or the sample holds is put into a
 * step. Anchors are `data-tour-step` attributes with fixed words.
 */

export const PLAYGROUND_TOUR_COMPLETED_KEY = "telflo-playground-tour-completed";
export const PLAYGROUND_TOUR_STAGE_KEY = "telflo-playground-tour-stage";

/**
 * Fired by `restartPlaygroundTour` when the visitor is already on the list:
 * the list listens and clears its search and filter before starting, so the
 * steps point at the whole list.
 */
export const PLAYGROUND_TOUR_RESTART_EVENT = "telflo:playground-tour-restart";

/** How long a page gets to settle before its stage starts. */
export const PLAYGROUND_TOUR_DELAY_MS = 375;

/** How many settle delays a stage waits for its page's anchor before it starts anyway. */
export const PLAYGROUND_TOUR_READY_CHECKS = 40;

export type PlaygroundTourStage = "list" | "editor" | "fleet";

type NavigateFn = (to: string) => void;

/* ------------------------------------------------------------------ */
/* The flags                                                           */
/* ------------------------------------------------------------------ */

/** Completion and the pending stage when storage refuses them: at least for this page's life. */
let completedInMemory = false;
let stageInMemory: PlaygroundTourStage | null = null;

export function isPlaygroundTourCompleted(): boolean {
  if (typeof window === "undefined") return true;
  if (completedInMemory) return true;
  try {
    return window.localStorage.getItem(PLAYGROUND_TOUR_COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

export function markPlaygroundTourCompleted(): void {
  if (typeof window === "undefined") return;
  completedInMemory = true;
  try {
    window.localStorage.setItem(PLAYGROUND_TOUR_COMPLETED_KEY, "true");
  } catch {
    // Storage refused: remembered in memory only.
  }
}

export function setPlaygroundTourStage(stage: PlaygroundTourStage): void {
  if (typeof window === "undefined") return;
  stageInMemory = stage;
  try {
    window.sessionStorage.setItem(PLAYGROUND_TOUR_STAGE_KEY, stage);
  } catch {
    // Storage refused: handed over in memory only (a client navigation keeps it).
  }
}

function pendingStage(): string | null {
  try {
    const stored = window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY);
    if (stored !== null) return stored;
  } catch {
    // Storage refused: the memory's.
  }
  return stageInMemory;
}

/**
 * Takes the pending stage when it is `expected`, and says whether it did:
 * a stale hand-over aimed at another page never starts on the one that
 * happens to mount.
 */
export function consumePlaygroundTourStage(expected: PlaygroundTourStage): boolean {
  if (typeof window === "undefined") return false;
  if (pendingStage() !== expected) return false;
  stageInMemory = null;
  try {
    window.sessionStorage.removeItem(PLAYGROUND_TOUR_STAGE_KEY);
  } catch {
    // Storage refused: the memory's is gone.
  }
  return true;
}

/** For tests: forgets the in-memory flags and any live run. */
export function resetPlaygroundTourForTests(): void {
  completedInMemory = false;
  stageInMemory = null;
  cancelActiveTour(false);
}

/* ------------------------------------------------------------------ */
/* The one live run                                                    */
/* ------------------------------------------------------------------ */

/*
 * driver.js mounts its overlay on <body>, outside React, and a stage starts
 * behind a timer while the page settles, so a navigation tears down
 * neither. The one live run is tracked here, and every page hosting a
 * stage stops it from its effect's cleanup.
 */
interface ActiveTour {
  stage: PlaygroundTourStage;
  timer: ReturnType<typeof setTimeout> | null;
  driver: Driver | null;
}

let activeTour: ActiveTour | null = null;

function cancelActiveTour(restashPendingStage: boolean): void {
  const tour = activeTour;
  activeTour = null;
  if (!tour) return;
  if (tour.timer !== null) {
    clearTimeout(tour.timer);
    if (restashPendingStage) setPlaygroundTourStage(tour.stage);
    return;
  }
  tour.driver?.destroy();
}

/**
 * Stops the live run, if any: safe to call from any page's effect cleanup.
 * A run stopped before it showed anything gives its stage back, so the
 * page's next mount (React's StrictMode remounts once) picks it up.
 */
export function stopPlaygroundTour(): void {
  cancelActiveTour(true);
}

/** Whether a stage is waiting or showing. */
export function isPlaygroundTourActive(): boolean {
  return activeTour !== null;
}

/**
 * Starts `begin` (which makes and drives a driver run) once the page has
 * settled and `ready` answers true (or after PLAYGROUND_TOUR_READY_CHECKS
 * delays), as the single live run.
 */
function armTour(stage: PlaygroundTourStage, ready: () => boolean, begin: () => Driver): void {
  // A restart supersedes an earlier run: its stage isn't given back.
  cancelActiveTour(false);
  const tour: ActiveTour = { stage, timer: null, driver: null };
  activeTour = tour;
  let checks = 0;
  const attempt = () => {
    checks += 1;
    if (!ready() && checks < PLAYGROUND_TOUR_READY_CHECKS) {
      tour.timer = setTimeout(attempt, PLAYGROUND_TOUR_DELAY_MS);
      return;
    }
    tour.timer = null;
    tour.driver = begin();
  };
  tour.timer = setTimeout(attempt, PLAYGROUND_TOUR_DELAY_MS);
}

const present = (selector: string) => () => document.querySelector(selector) !== null;

/* ------------------------------------------------------------------ */
/* The editor's helpers                                                */
/* ------------------------------------------------------------------ */

/** Selects the first component, so the Configuration tab has something to show. */
function selectFirstComponent(): void {
  const store = useEditorStore.getState();
  const id = store.graph.nodes.find((node) => !isGroup(node))?.id;
  if (id !== undefined) store.selectNode(id);
}

function switchTab(tab: "config" | "yaml" | "testing"): void {
  useEditorStore.getState().setActiveTab(tab);
}

function clearSelection(): void {
  useEditorStore.getState().selectNode(null);
}

/* ------------------------------------------------------------------ */
/* The driver                                                          */
/* ------------------------------------------------------------------ */

/** One driver configuration, so the three stages look and close alike. */
function makePlaygroundDriver(steps: DriveStep[], onExit?: () => void): Driver {
  const driverObj = driver({
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
    doneBtnText: "Finish",
    onDestroyStarted: () => {
      activeTour = null;
      markPlaygroundTourCompleted();
      onExit?.();
      driverObj.destroy();
    },
    steps,
  });
  return driverObj;
}

/**
 * Ends this stage and hands over to the next page's. The public destroy()
 * skips onDestroyStarted, so the stage's own cleanup stays the caller's.
 */
function chainToStage(driverObj: Driver, navigate: NavigateFn, stage: PlaygroundTourStage, path: string): void {
  activeTour = null;
  markPlaygroundTourCompleted();
  setPlaygroundTourStage(stage);
  driverObj.destroy();
  navigate(path);
}

/* ------------------------------------------------------------------ */
/* Stage 1: /playground (the configurations list)                      */
/* ------------------------------------------------------------------ */

const CONFIG_LIST = '[data-tour-step="config-list"]';

/** The list stage's steps; `next` hands over to the editor's (the last step's Next). */
export function playgroundListSteps(next: () => void): DriveStep[] {
  return [
    {
      element: CONFIG_LIST,
      popover: {
        title: "Every collector config in one place",
        description:
          "These are sample configs from a fictional team. In Telflo, every collector config your team runs lives here, versioned and shareable, instead of scattered across repos and wikis.",
        side: "top",
        align: "center",
      },
    },
    {
      element: '[data-tour-step="new-config"]',
      popover: {
        title: "Start from a blank canvas",
        description:
          "Build a config from scratch and Telflo writes clean, valid collector YAML for you. No hand-editing hundreds of lines.",
        side: "bottom",
        align: "end",
      },
    },
    {
      // The first sample's card; the whole list should it have none.
      element: () => (document.querySelector(`${CONFIG_LIST} > *`) ?? document.querySelector(CONFIG_LIST)) as Element,
      popover: {
        title: "Let's open a sample",
        description: "This gateway config is a typical production setup. Click Next to open it in the visual editor.",
        side: "bottom",
        align: "center",
        // driver.js labels the last step's button with doneBtnText: this one hands over, so "Next".
        nextBtnText: "Next",
        onNextClick: next,
      },
    },
  ];
}

/**
 * The list's stage. `firstConfigurationId` answers, at the last step, the
 * id of the first configuration listed (the card the step points at): the
 * editor stage opens it.
 */
export function startPlaygroundListTour(navigate: NavigateFn, firstConfigurationId: () => string | undefined): void {
  armTour("list", present(CONFIG_LIST), () => {
    const driverObj: Driver = makePlaygroundDriver(
      playgroundListSteps(() => {
        const id = firstConfigurationId();
        chainToStage(driverObj, navigate, "editor", id === undefined ? "/playground/editor" : `/playground/editor/${id}`);
      }),
    );
    driverObj.drive();
    return driverObj;
  });
}

/* ------------------------------------------------------------------ */
/* Stage 2: /playground/editor/:configurationId (the sample's editor)  */
/* ------------------------------------------------------------------ */

const RIGHT_PANEL = '[data-tour-step="editor-right-panel"]';

/** The editor stage's steps; `next` hands over to fleet's (the last step's Next). */
export function playgroundEditorSteps(next: () => void, restoreEditor: () => void): DriveStep[] {
  return [
    {
      element: '[data-tour-step="canvas"]',
      popover: {
        title: "Your pipeline, not a wall of YAML",
        description:
          "Here's the same config as a live diagram. Receivers, processors, and exporters are grouped into pipelines by signal, so anyone on the team can see how data flows at a glance.",
        side: "bottom",
        align: "center",
      },
    },
    {
      element: '[data-tour-step="toolbox"]',
      popover: {
        title: "The component catalog",
        description:
          "The collector components teams actually use, searchable and ready to drag onto the canvas. No hunting through registry docs.",
        side: "right",
        align: "center",
      },
    },
    {
      element: RIGHT_PANEL,
      popover: {
        title: "Configure with forms, not syntax",
        description:
          "Click any component and edit its settings in a guided form. Fields are explained and checked as you type, so typos never reach the config.",
        side: "left",
        align: "center",
      },
      onHighlighted: () => {
        selectFirstComponent();
        switchTab("config");
      },
    },
    {
      element: RIGHT_PANEL,
      popover: {
        title: "It's still just standard YAML",
        description:
          "The canvas and YAML stay in sync both ways, and every change is validated against the exact collector version you run. It's plain OpenTelemetry YAML you can export anytime. No lock-in.",
        side: "left",
        align: "center",
      },
      onHighlighted: () => {
        clearSelection();
        switchTab("yaml");
      },
    },
    {
      element: RIGHT_PANEL,
      popover: {
        title: "Test changes before they ship",
        description:
          "Run sample telemetry through the pipeline and inspect what comes out. Know your new filter or sampling rule works before it touches production.",
        side: "left",
        align: "center",
      },
      onHighlighted: () => {
        switchTab("testing");
      },
    },
    {
      // The shell's sidebar item: the full-screen editor has no sidebar, so
      // driver.js centres the step.
      element: '[data-tour-step="sidebar-fleet-mgmt"]',
      popover: {
        title: "Configs are half the story",
        description: "Telflo also manages the collectors that run them. Click Next to see fleet management.",
        side: "right",
        align: "center",
        // Hands over to the fleet stage: keep the button "Next".
        nextBtnText: "Next",
        onNextClick: next,
      },
      onHighlighted: restoreEditor,
    },
  ];
}

/** The editor's stage, on the playground editor only. Closing it leaves the Configuration tab with nothing selected. */
export function startPlaygroundEditorTour(navigate: NavigateFn): void {
  armTour("editor", present('[data-tour-step="canvas"]'), () => {
    const restoreEditor = () => {
      clearSelection();
      switchTab("config");
    };
    const driverObj: Driver = makePlaygroundDriver(
      playgroundEditorSteps(() => chainToStage(driverObj, navigate, "fleet", "/playground/fleet-management"), restoreEditor),
      restoreEditor,
    );
    driverObj.drive();
    return driverObj;
  });
}

/* ------------------------------------------------------------------ */
/* Stage 3: /playground/fleet-management                               */
/* ------------------------------------------------------------------ */

const FLEET_TABLE = '[data-tour-step="fleet-table"]';

/**
 * The fleet stage's steps; the wrap-up's link goes to `signUp` (useSignUpPath),
 * a fixed path, its words following it.
 */
export function playgroundFleetSteps(signUp: "/register" | "/login"): DriveStep[] {
  return [
    {
      // The fleets' table inside the list's wrapper; the wrapper should it have none.
      element: () => (document.querySelector(`${FLEET_TABLE} table`) ?? document.querySelector(FLEET_TABLE)) as Element,
      popover: {
        title: "Roll out configs over OpAMP",
        description:
          "Each fleet shows its status and whether its config is in sync. Publish a new version and Telflo rolls it out over OpAMP. No copying files between hosts, no manual restarts.",
        side: "top",
        align: "center",
      },
    },
    {
      // No element: a centred wrap-up.
      popover: {
        title: "That's the loop: build, test, roll out",
        description:
          `You've seen the highlights: visual editing, real validation, pipeline testing, and fleet management. It's all sample data, so keep exploring. Ready to use your own configs and collectors? <a href="${signUp}">${signUp === "/register" ? "Create a free account" : "Sign in"}</a>.`,
      },
    },
  ];
}

export function startPlaygroundFleetTour(signUp: "/register" | "/login"): void {
  armTour("fleet", present(`${FLEET_TABLE} table`), () => {
    const driverObj = makePlaygroundDriver(playgroundFleetSteps(signUp));
    driverObj.drive();
    return driverObj;
  });
}

/* ------------------------------------------------------------------ */
/* Take the tour                                                       */
/* ------------------------------------------------------------------ */

/**
 * The banner's "Take the tour": the tour from the top, which is the list's.
 * The stage is stored and the list starts it: through the restart event
 * when the visitor is on it, through its mount effect otherwise. Any run
 * still waiting or showing is cancelled first without giving its stage
 * back, so a page leaving afterwards (its cleanup stops the tour) can't
 * put its own stage over the list's.
 */
export function restartPlaygroundTour(pathname: string, navigate: NavigateFn): void {
  cancelActiveTour(false);
  markPlaygroundTourCompleted();
  setPlaygroundTourStage("list");
  if (pathname.replace(/\/+$/, "") === "/playground") {
    window.dispatchEvent(new Event(PLAYGROUND_TOUR_RESTART_EVENT));
  } else {
    navigate("/playground");
  }
}
