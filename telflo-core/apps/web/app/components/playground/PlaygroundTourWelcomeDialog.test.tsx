import { createRoutesStub, useLocation } from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchMediaQueries } from "~/test/intersection-observer.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import PlaygroundLayout from "~/routes/playground.js";
import PlaygroundConfigurations from "~/routes/playground._index.js";
import PlaygroundFleets from "~/routes/playground.fleet-management.js";
import {
  PLAYGROUND_TOUR_COMPLETED_KEY,
  PLAYGROUND_TOUR_STAGE_KEY,
  resetPlaygroundTourForTests,
  setPlaygroundTourStage,
} from "./playground-tour.js";
import { PLAYGROUND_TOUR_DESKTOP_QUERY, PLAYGROUND_WELCOME_TITLE, shouldOfferPlaygroundTour } from "./PlaygroundTourWelcomeDialog.js";

/*
 * The playground's welcome dialog and the tour's pages (D31-1 decision 15,
 * Preflight ruling 16): "Welcome to the Telflo playground" on a first desktop
 * visit to the list, until it is dismissed or the tour taken (one flag, the
 * tour's completion); none on a phone; the list starting the tour's first
 * stage from the dialog, from a hand-over and from the banner's "Take the
 * tour" (here or from another page); fleet's page starting the last stage.
 * Nothing here reaches the API.
 */

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPlayground(path = "/playground") {
  const Stub = createRoutesStub([
    {
      path: "/playground",
      Component: PlaygroundLayout,
      children: [
        { index: true, Component: PlaygroundConfigurations },
        { path: "fleet-management", Component: PlaygroundFleets },
      ],
    },
    { path: "/playground/editor/:configurationId?", Component: Where },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

const welcome = () => screen.queryByRole("dialog", { name: PLAYGROUND_WELCOME_TITLE });
const cards = () => screen.queryAllByRole("heading", { level: 3 });
const tourTitle = () => document.querySelector(".driver-popover-title")?.textContent;

const original = window.matchMedia;
let spies: ReturnType<typeof spyOnTheClient>;

function onDesktop() {
  window.matchMedia = matchMediaQueries([PLAYGROUND_TOUR_DESKTOP_QUERY]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetPlaygroundTourForTests();
  spies = spyOnTheClient();
});

afterEach(() => {
  for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  resetPlaygroundTourForTests();
  window.matchMedia = original;
  document.querySelectorAll(".driver-popover, .driver-overlay").forEach((el) => el.remove());
  document.body.className = "";
});

describe("the welcome dialog's flag", () => {
  it("is offered to a desktop visitor who hasn't seen it, never on a phone or after it was dismissed", () => {
    expect(shouldOfferPlaygroundTour()).toBe(false); // jsdom's matchMedia: no match, a phone
    onDesktop();
    expect(shouldOfferPlaygroundTour()).toBe(true);
    window.localStorage.setItem(PLAYGROUND_TOUR_COMPLETED_KEY, "true");
    expect(shouldOfferPlaygroundTour()).toBe(false);
  });
});

describe("the welcome dialog on the list", () => {
  it("greets a first desktop visit with its words and buttons, once the list is there", async () => {
    onDesktop();
    renderPlayground();
    const dialog = await screen.findByRole("dialog", { name: PLAYGROUND_WELCOME_TITLE });
    expect(dialog).toHaveTextContent(
      "This is the full product running on sample data. Nothing you do here is saved, so explore freely. Want a quick tour of the highlights first?",
    );
    expect(screen.getByRole("button", { name: "I'll explore on my own" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Show me around/ })).toHaveTextContent("Show me around~1 min");
    // Nothing is stored until the visitor answers.
    expect(window.localStorage.getItem(PLAYGROUND_TOUR_COMPLETED_KEY)).toBeNull();
  });

  it("I'll explore on my own: closed, remembered, never shown again", async () => {
    const user = userEvent.setup();
    onDesktop();
    const { unmount } = renderPlayground();
    await screen.findByRole("dialog", { name: PLAYGROUND_WELCOME_TITLE });
    await user.click(screen.getByRole("button", { name: "I'll explore on my own" }));
    await waitFor(() => expect(welcome()).toBeNull());
    expect(window.localStorage.getItem(PLAYGROUND_TOUR_COMPLETED_KEY)).toBe("true");
    expect(tourTitle()).toBeUndefined();

    unmount();
    renderPlayground();
    await waitFor(() => expect(cards()).toHaveLength(10));
    expect(welcome()).toBeNull();
  });

  it("Escape counts as exploring on my own", async () => {
    const user = userEvent.setup();
    onDesktop();
    renderPlayground();
    await screen.findByRole("dialog", { name: PLAYGROUND_WELCOME_TITLE });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(welcome()).toBeNull());
    expect(window.localStorage.getItem(PLAYGROUND_TOUR_COMPLETED_KEY)).toBe("true");
  });

  it("Show me around: closed, remembered, and the tour's first step on the list", async () => {
    const user = userEvent.setup();
    onDesktop();
    renderPlayground();
    await screen.findByRole("dialog", { name: PLAYGROUND_WELCOME_TITLE });
    await user.click(screen.getByRole("button", { name: /^Show me around/ }));
    await waitFor(() => expect(welcome()).toBeNull());
    expect(window.localStorage.getItem(PLAYGROUND_TOUR_COMPLETED_KEY)).toBe("true");
    await waitFor(() => expect(tourTitle()).toBe("Every collector config in one place"));
  });

  it("isn't shown on a phone (below md), and nothing is stored", async () => {
    renderPlayground();
    await waitFor(() => expect(cards()).toHaveLength(10));
    expect(welcome()).toBeNull();
    expect(window.localStorage.getItem(PLAYGROUND_TOUR_COMPLETED_KEY)).toBeNull();
  });

  it("isn't shown once the tour was taken", async () => {
    onDesktop();
    window.localStorage.setItem(PLAYGROUND_TOUR_COMPLETED_KEY, "true");
    renderPlayground();
    await waitFor(() => expect(cards()).toHaveLength(10));
    expect(welcome()).toBeNull();
  });
});

describe("the tour's pages", () => {
  it("a handed-over list stage starts on arrival, with no dialog", async () => {
    onDesktop();
    setPlaygroundTourStage("list");
    renderPlayground();
    await waitFor(() => expect(tourTitle()).toBe("Every collector config in one place"));
    expect(welcome()).toBeNull();
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBeNull();
  });

  it("Take the tour on the list restarts it from the top, the search and the filter cleared", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(PLAYGROUND_TOUR_COMPLETED_KEY, "true");
    renderPlayground();
    await waitFor(() => expect(cards()).toHaveLength(10));
    await user.type(screen.getByRole("searchbox", { name: "Search configurations" }), "ottl");
    expect(cards()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Take the tour" }));
    await waitFor(() => expect(tourTitle()).toBe("Every collector config in one place"));
    expect(screen.getByRole("searchbox", { name: "Search configurations" })).toHaveValue("");
    expect(cards()).toHaveLength(10);
  });

  it("Take the tour from the table view starts on the grid, its sample step on the first card (Ruling 294)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(PLAYGROUND_TOUR_COMPLETED_KEY, "true");
    renderPlayground();
    await waitFor(() => expect(cards()).toHaveLength(10));
    await user.click(screen.getByTitle("List view"));
    await waitFor(() => expect(cards()).toHaveLength(0));

    await user.click(screen.getByRole("button", { name: "Take the tour" }));
    await waitFor(() => expect(tourTitle()).toBe("Every collector config in one place"));
    expect(cards()).toHaveLength(10);
    for (const wanted of ["Start from a blank canvas", "Let's open a sample"]) {
      document.querySelector<HTMLButtonElement>(".driver-popover-next-btn")!.click();
      await waitFor(() => expect(tourTitle()).toBe(wanted));
    }
    const firstCard = document.querySelector('[data-tour-step="config-list"] > *');
    expect(firstCard).toHaveTextContent(cards()[0]!.textContent!);
    // Only this step ever highlights a card (jsdom keeps the earlier steps' classes until driver.js's cleanup).
    await waitFor(() => expect(firstCard).toHaveClass("driver-active-element"));
  });

  it("Take the tour from fleet goes to the list and starts there", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(PLAYGROUND_TOUR_COMPLETED_KEY, "true");
    renderPlayground("/playground/fleet-management");
    await screen.findByRole("heading", { level: 1, name: "Fleets" });
    await user.click(screen.getByRole("button", { name: "Take the tour" }));
    await waitFor(() => expect(cards()).toHaveLength(10));
    await waitFor(() => expect(tourTitle()).toBe("Every collector config in one place"));
  });

  it("fleet's page starts the last stage when the editor's hands it over, on the fleets' table", async () => {
    setPlaygroundTourStage("fleet");
    renderPlayground("/playground/fleet-management");
    await waitFor(() => expect(tourTitle()).toBe("Roll out configs over OpAMP"));
    const table = document.querySelector('[data-tour-step="fleet-table"] table');
    expect(table).not.toBeNull();
    expect(document.querySelector(".driver-active-element")).toBe(table);
  });

  it("fleet's page starts nothing without a hand-over", async () => {
    window.sessionStorage.setItem(PLAYGROUND_TOUR_STAGE_KEY, "editor");
    renderPlayground("/playground/fleet-management");
    await screen.findByRole("table");
    expect(tourTitle()).toBeUndefined();
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBe("editor");
  });
});
