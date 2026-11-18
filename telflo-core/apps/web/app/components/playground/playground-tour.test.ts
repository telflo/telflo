import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLAYGROUND_TOUR_COMPLETED_KEY,
  PLAYGROUND_TOUR_DELAY_MS,
  PLAYGROUND_TOUR_READY_CHECKS,
  PLAYGROUND_TOUR_RESTART_EVENT,
  PLAYGROUND_TOUR_STAGE_KEY,
  consumePlaygroundTourStage,
  isPlaygroundTourActive,
  isPlaygroundTourCompleted,
  markPlaygroundTourCompleted,
  playgroundEditorSteps,
  playgroundFleetSteps,
  playgroundListSteps,
  resetPlaygroundTourForTests,
  restartPlaygroundTour,
  setPlaygroundTourStage,
  startPlaygroundEditorTour,
  startPlaygroundFleetTour,
  startPlaygroundListTour,
  stopPlaygroundTour,
} from "./playground-tour.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, openText } from "~/test/builder-store.js";

/*
 * The playground tour (D31-1 decision 15, Preflight ruling 16):
 * its three stages' words, with the spec's changes; the hand-over between
 * pages through sessionStorage, completion in localStorage, under telflo's
 * keys; one live run; the editor stage's effects on the editor. driver.js
 * runs for real over fake timers, as the editor tour's tests run it.
 */

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();
const FIRST_ID = "11111111-0000-4000-8000-000000000001";

const copy = (steps: ReturnType<typeof playgroundListSteps>) =>
  steps.map((step) => ({ title: step.popover?.title, description: step.popover?.description }));

const popover = () => document.querySelector(".driver-popover");
const title = () => popover()?.querySelector(".driver-popover-title")?.textContent;
const progress = () => popover()?.querySelector(".driver-popover-progress-text")?.textContent;
const nextButton = () => popover()!.querySelector<HTMLButtonElement>(".driver-popover-next-btn")!;

/** driver.js's animation: its frames and timeouts, run out. */
function settle() {
  vi.advanceTimersByTime(1000);
}

function next() {
  nextButton().click();
  settle();
}

/** Waits out the settle delay (once the page's anchor is there). */
function arrive() {
  vi.advanceTimersByTime(PLAYGROUND_TOUR_DELAY_MS);
  settle();
}

function anchor(step: string, parent: Element = document.body): HTMLElement {
  const el = document.createElement("div");
  el.dataset.tourStep = step;
  parent.append(el);
  return el;
}

/** The configurations page's anchors: the list with two cards, New configuration, and the sidebar. */
function renderList() {
  const list = anchor("config-list");
  for (let card = 0; card < 2; card++) list.append(document.createElement("button"));
  anchor("new-config");
  anchor("sidebar-fleet-mgmt");
  return list;
}

/** The playground editor's anchors (no sidebar: it is full screen). */
function renderEditor() {
  for (const step of ["toolbox", "canvas", "editor-right-panel"]) anchor(step);
}

/** The fleet list's wrapper, and its table inside. */
function renderFleets() {
  const wrapper = anchor("fleet-table");
  const table = document.createElement("table");
  wrapper.append(table);
  return { wrapper, table };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  useEditorStore.setState(initialState, true);
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetPlaygroundTourForTests();
});

afterEach(() => {
  resetPlaygroundTourForTests();
  settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("the stages' words", () => {
  it("the list's: three steps", () => {
    expect(copy(playgroundListSteps(() => undefined))).toEqual([
      {
        title: "Every collector config in one place",
        description:
          "These are sample configs from a fictional team. In Telflo, every collector config your team runs lives here, versioned and shareable, instead of scattered across repos and wikis.",
      },
      {
        title: "Start from a blank canvas",
        description:
          "Build a config from scratch and Telflo writes clean, valid collector YAML for you. No hand-editing hundreds of lines.",
      },
      {
        title: "Let's open a sample",
        description: "This gateway config is a typical production setup. Click Next to open it in the visual editor.",
      },
    ]);
  });

  it("the editor's: six steps, no AI step (ADR 0007)", () => {
    expect(copy(playgroundEditorSteps(() => undefined, () => undefined))).toEqual([
      {
        title: "Your pipeline, not a wall of YAML",
        description:
          "Here's the same config as a live diagram. Receivers, processors, and exporters are grouped into pipelines by signal, so anyone on the team can see how data flows at a glance.",
      },
      {
        title: "The component catalog",
        description:
          "The collector components teams actually use, searchable and ready to drag onto the canvas. No hunting through registry docs.",
      },
      {
        title: "Configure with forms, not syntax",
        description:
          "Click any component and edit its settings in a guided form. Fields are explained and checked as you type, so typos never reach the config.",
      },
      {
        title: "It's still just standard YAML",
        description:
          "The canvas and YAML stay in sync both ways, and every change is validated against the exact collector version you run. It's plain OpenTelemetry YAML you can export anytime. No lock-in.",
      },
      {
        title: "Test changes before they ship",
        description:
          "Run sample telemetry through the pipeline and inspect what comes out. Know your new filter or sampling rule works before it touches production.",
      },
      {
        title: "Configs are half the story",
        description: "Telflo also manages the collectors that run them. Click Next to see fleet management.",
      },
    ]);
  });

  it("the fleet's: no usage step, the table's step naming what the table shows, the wrap-up", () => {
    expect(copy(playgroundFleetSteps("/register"))).toEqual([
      {
        title: "Roll out configs over OpAMP",
        description:
          "Each fleet shows its status and whether its config is in sync. Publish a new version and Telflo rolls it out over OpAMP. No copying files between hosts, no manual restarts.",
      },
      {
        title: "That's the loop: build, test, roll out",
        description:
          'You\'ve seen the highlights: visual editing, real validation, pipeline testing, and fleet management. It\'s all sample data, so keep exploring. Ready to use your own configs and collectors? <a href="/register">Create a free account</a>.',
      },
    ]);
  });

  it("the wrap-up's link goes where it is given, its words following: Sign in where registration isn't open (D36-1 decision 23, Ruling 352)", () => {
    expect(copy(playgroundFleetSteps("/login"))[1]?.description).toContain('<a href="/login">Sign in</a>.');
    expect(copy(playgroundFleetSteps("/login"))[1]?.description).not.toContain("Create a free account");
  });

  it("points only at fixed anchors: the spec's, never fleet-usage or the AI's", () => {
    const selectors = [...playgroundListSteps(() => undefined), ...playgroundEditorSteps(() => undefined, () => undefined), ...playgroundFleetSteps("/register")]
      .map((step) => step.element)
      .filter((element): element is string => typeof element === "string");
    expect(selectors).toEqual([
      '[data-tour-step="config-list"]',
      '[data-tour-step="new-config"]',
      '[data-tour-step="canvas"]',
      '[data-tour-step="toolbox"]',
      '[data-tour-step="editor-right-panel"]',
      '[data-tour-step="editor-right-panel"]',
      '[data-tour-step="editor-right-panel"]',
      '[data-tour-step="sidebar-fleet-mgmt"]',
    ]);
  });
});

describe("the flags", () => {
  it("uses telflo's keys: completion in localStorage, the stage in sessionStorage", () => {
    expect(isPlaygroundTourCompleted()).toBe(false);
    markPlaygroundTourCompleted();
    expect(window.localStorage.getItem(PLAYGROUND_TOUR_COMPLETED_KEY)).toBe("true");
    expect(PLAYGROUND_TOUR_COMPLETED_KEY).toBe("telflo-playground-tour-completed");

    setPlaygroundTourStage("editor");
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("editor");
    expect(PLAYGROUND_TOUR_STAGE_KEY).toBe("telflo-playground-tour-stage");
  });

  it("reads completion from storage", () => {
    window.localStorage.setItem(PLAYGROUND_TOUR_COMPLETED_KEY, "true");
    expect(isPlaygroundTourCompleted()).toBe(true);
  });

  it("hands a stage only to its own page, once; a stale one stays for its page", () => {
    setPlaygroundTourStage("fleet");
    expect(consumePlaygroundTourStage("list")).toBe(false);
    expect(consumePlaygroundTourStage("editor")).toBe(false);
    expect(consumePlaygroundTourStage("fleet")).toBe(true);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBeNull();
    expect(consumePlaygroundTourStage("fleet")).toBe(false);
  });

  it("survives storage that throws: completion and the hand-over remembered for the page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(isPlaygroundTourCompleted()).toBe(false);
    markPlaygroundTourCompleted();
    expect(isPlaygroundTourCompleted()).toBe(true);
    setPlaygroundTourStage("editor");
    expect(consumePlaygroundTourStage("editor")).toBe(true);
    expect(consumePlaygroundTourStage("editor")).toBe(false);
  });
});

describe("the list stage", () => {
  it("starts after the settle delay on the list, and hands over to the first configuration's editor", () => {
    renderList();
    const navigate = vi.fn();
    startPlaygroundListTour(navigate, () => FIRST_ID);
    vi.advanceTimersByTime(PLAYGROUND_TOUR_DELAY_MS - 1);
    expect(popover()).toBeNull();
    vi.advanceTimersByTime(1);
    settle();

    expect(popover()).toHaveClass("tour-popover");
    expect(title()).toBe("Every collector config in one place");
    expect(progress()).toBe("1 of 3");
    expect(document.querySelector(".driver-active-element")).toBe(document.querySelector('[data-tour-step="config-list"]'));
    next();
    expect(title()).toBe("Start from a blank canvas");
    next();
    expect(title()).toBe("Let's open a sample");
    // The first card, not the whole list.
    expect(document.querySelector(".driver-active-element")).toBe(document.querySelector('[data-tour-step="config-list"] > *'));
    expect(nextButton().textContent).toBe("Next");
    expect(isPlaygroundTourCompleted()).toBe(false);

    next();
    expect(popover()).toBeNull();
    expect(navigate.mock.calls).toEqual([[`/playground/editor/${FIRST_ID}`]]);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("editor");
    expect(isPlaygroundTourCompleted()).toBe(true);
    expect(isPlaygroundTourActive()).toBe(false);
  });

  it("waits for the list to arrive (bounded), then starts", () => {
    startPlaygroundListTour(vi.fn(), () => FIRST_ID);
    vi.advanceTimersByTime(PLAYGROUND_TOUR_DELAY_MS * 3);
    expect(popover()).toBeNull();
    renderList();
    arrive();
    expect(title()).toBe("Every collector config in one place");
  });

  it("starts anyway after its last check, should the anchor never come", () => {
    startPlaygroundListTour(vi.fn(), () => FIRST_ID);
    vi.advanceTimersByTime(PLAYGROUND_TOUR_DELAY_MS * (PLAYGROUND_TOUR_READY_CHECKS - 1));
    expect(popover()).toBeNull();
    arrive();
    expect(title()).toBe("Every collector config in one place");
  });

  it("closing it early marks it completed, and hands nothing over", () => {
    renderList();
    const navigate = vi.fn();
    startPlaygroundListTour(navigate, () => FIRST_ID);
    arrive();
    popover()!.querySelector<HTMLButtonElement>(".driver-popover-close-btn")!.click();
    settle();

    expect(popover()).toBeNull();
    expect(isPlaygroundTourCompleted()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBeNull();
  });
});

describe("the editor stage", () => {
  it("walks the canvas, the toolbox and the panel's three tabs, then hands over to fleet", () => {
    openText(STARTER);
    renderEditor();
    const first = builderStore().graph.nodes.find((n) => n.type !== "pipelineGroup")!;
    const navigate = vi.fn();
    startPlaygroundEditorTour(navigate);
    arrive();

    expect(title()).toBe("Your pipeline, not a wall of YAML");
    expect(progress()).toBe("1 of 6");
    next();
    expect(title()).toBe("The component catalog");
    next();
    expect(title()).toBe("Configure with forms, not syntax");
    expect(builderStore().selectedNode?.id).toBe(first.id);
    expect(builderStore().activeTab).toBe("config");
    next();
    expect(title()).toBe("It's still just standard YAML");
    expect(builderStore().selectedNode).toBeNull();
    expect(builderStore().activeTab).toBe("yaml");
    next();
    expect(title()).toBe("Test changes before they ship");
    expect(builderStore().activeTab).toBe("testing");
    next();
    expect(title()).toBe("Configs are half the story");
    expect(builderStore().activeTab).toBe("config");
    expect(nextButton().textContent).toBe("Next");

    next();
    expect(popover()).toBeNull();
    expect(navigate.mock.calls).toEqual([["/playground/fleet-management"]]);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("fleet");
  });

  it("closing it on the Testing tab goes back to Configuration, nothing selected, completed", () => {
    openText(STARTER);
    renderEditor();
    startPlaygroundEditorTour(vi.fn());
    arrive();
    for (let step = 0; step < 4; step++) next();
    expect(builderStore().activeTab).toBe("testing");
    popover()!.querySelector<HTMLButtonElement>(".driver-popover-close-btn")!.click();
    settle();

    expect(popover()).toBeNull();
    expect(builderStore().activeTab).toBe("config");
    expect(builderStore().selectedNode).toBeNull();
    expect(isPlaygroundTourCompleted()).toBe(true);
  });

  it("never puts a component's name into a step", () => {
    openText("receivers:\n  otlp/tourmarker:\n    protocols:\n      grpc: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp/tourmarker]\n");
    renderEditor();
    startPlaygroundEditorTour(vi.fn());
    arrive();
    for (let step = 0; step < 6; step++) {
      expect(popover()!.innerHTML).not.toContain("tourmarker");
      if (step < 5) next();
    }
  });
});

describe("the fleet stage", () => {
  it("points at the fleets' table, then the wrap-up; Finish completes it and goes nowhere", () => {
    const { table } = renderFleets();
    startPlaygroundFleetTour("/register");
    arrive();

    expect(title()).toBe("Roll out configs over OpAMP");
    expect(progress()).toBe("1 of 2");
    expect(document.querySelector(".driver-active-element")).toBe(table);
    next();
    expect(title()).toBe("That's the loop: build, test, roll out");
    expect(popover()!.querySelector(".driver-popover-description a")).toHaveAttribute("href", "/register");
    expect(nextButton().textContent).toBe("Finish");
    nextButton().click();
    settle();

    expect(popover()).toBeNull();
    expect(document.body).not.toHaveClass("driver-active");
    expect(isPlaygroundTourCompleted()).toBe(true);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBeNull();
  });
});

describe("one run per page", () => {
  it("stopping a stage before it shows gives its stage back (StrictMode's remount picks it up)", () => {
    renderList();
    startPlaygroundListTour(vi.fn(), () => FIRST_ID);
    stopPlaygroundTour();
    arrive();
    expect(popover()).toBeNull();
    expect(consumePlaygroundTourStage("list")).toBe(true);
  });

  it("stopping a showing stage takes it down unfinished: not completed, nothing handed over", () => {
    renderList();
    startPlaygroundListTour(vi.fn(), () => FIRST_ID);
    arrive();
    expect(popover()).not.toBeNull();
    stopPlaygroundTour();
    settle();

    expect(popover()).toBeNull();
    expect(document.body).not.toHaveClass("driver-active");
    expect(isPlaygroundTourCompleted()).toBe(false);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBeNull();
  });

  it("a new start supersedes a pending one, which isn't given back", () => {
    renderList();
    renderFleets();
    startPlaygroundFleetTour("/register");
    startPlaygroundListTour(vi.fn(), () => FIRST_ID);
    arrive();
    expect(title()).toBe("Every collector config in one place");
    expect(document.querySelectorAll(".driver-popover")).toHaveLength(1);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBeNull();
  });
});

describe("Take the tour (restartPlaygroundTour)", () => {
  it("cancels a stage still waiting, without giving its stage back: the page leaving can't overwrite the list's (Ruling 294)", () => {
    // Fleet's stage armed, its page not yet settled (no table): still on its timer.
    startPlaygroundFleetTour("/register");
    expect(isPlaygroundTourActive()).toBe(true);
    const navigate = vi.fn();
    restartPlaygroundTour("/playground/fleet-management", navigate);
    // The fleet page unmounts as the list opens: its cleanup stops the tour.
    stopPlaygroundTour();
    arrive();

    expect(popover()).toBeNull();
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("list");
    expect(consumePlaygroundTourStage("list")).toBe(true);
    expect(navigate.mock.calls).toEqual([["/playground"]]);
  });

  it("takes down a showing stage first, unfinished", () => {
    renderFleets();
    startPlaygroundFleetTour("/register");
    arrive();
    expect(title()).toBe("Roll out configs over OpAMP");
    restartPlaygroundTour("/playground/fleet-management", vi.fn());
    settle();
    expect(popover()).toBeNull();
    stopPlaygroundTour();
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("list");
  });

  it("on the list: marks it completed, stores the list's stage and tells the list", () => {
    const restarted = vi.fn();
    window.addEventListener(PLAYGROUND_TOUR_RESTART_EVENT, restarted);
    const navigate = vi.fn();
    try {
      restartPlaygroundTour("/playground/", navigate);
    } finally {
      window.removeEventListener(PLAYGROUND_TOUR_RESTART_EVENT, restarted);
    }
    expect(restarted).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(isPlaygroundTourCompleted()).toBe(true);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("list");
  });

  it("elsewhere: stores the list's stage and goes to the list", () => {
    const restarted = vi.fn();
    window.addEventListener(PLAYGROUND_TOUR_RESTART_EVENT, restarted);
    const navigate = vi.fn();
    try {
      restartPlaygroundTour("/playground/fleet-management", navigate);
    } finally {
      window.removeEventListener(PLAYGROUND_TOUR_RESTART_EVENT, restarted);
    }
    expect(restarted).not.toHaveBeenCalled();
    expect(navigate.mock.calls).toEqual([["/playground"]]);
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("list");
  });
});
