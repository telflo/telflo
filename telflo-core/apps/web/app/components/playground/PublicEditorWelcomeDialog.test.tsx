import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_EDITOR_WELCOME_DONE_KEY,
  PUBLIC_EDITOR_WELCOME_TITLE,
  PublicEditorWelcomeDialog,
  SKIP_TOUR_LABEL,
  START_BLANK_LABEL,
  START_EXAMPLE_LABEL,
  isPublicEditorWelcomeDone,
} from "./PublicEditorWelcomeDialog.js";

/*
 * The blank public editor's Welcome dialog: it shows until a choice is made,
 * its one flag read after mount and written once the visitor chooses; a
 * choice says which start and whether to take the tour; it can't be dismissed
 * without one; storage that refuses shows it again.
 */

function renderDialog() {
  const onStart = vi.fn();
  const view = render(<PublicEditorWelcomeDialog onStart={onStart} />);
  return { onStart, view, user: userEvent.setup() };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PublicEditorWelcomeDialog", () => {
  it("shows on a first visit, with its two choices and the tour's opt-out", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE });
    expect(dialog).toHaveTextContent("Build OpenTelemetry Collector configurations visually. How would you like to start?");
    expect(screen.getByRole("button", { name: START_BLANK_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: START_EXAMPLE_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: SKIP_TOUR_LABEL })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    // Nothing is written by showing it.
    expect(window.localStorage.getItem(PUBLIC_EDITOR_WELCOME_DONE_KEY)).toBeNull();
  });

  it("Start from Scratch: the blank start with the tour, the flag written, the dialog gone", async () => {
    const { onStart, user } = renderDialog();
    await user.click(await screen.findByRole("button", { name: START_BLANK_LABEL }));
    expect(onStart.mock.calls).toEqual([["blank", true]]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.localStorage.getItem(PUBLIC_EDITOR_WELCOME_DONE_KEY)).toBe("true");
    expect(isPublicEditorWelcomeDone()).toBe(true);
  });

  it("Use a Template with Skip tour ticked: the example start, no tour", async () => {
    const { onStart, user } = renderDialog();
    await user.click(await screen.findByRole("checkbox", { name: SKIP_TOUR_LABEL }));
    await user.click(screen.getByRole("button", { name: START_EXAMPLE_LABEL }));
    expect(onStart.mock.calls).toEqual([["example", false]]);
    expect(window.localStorage.getItem(PUBLIC_EDITOR_WELCOME_DONE_KEY)).toBe("true");
  });

  it("waits while the cookie banner asks, then shows once it is answered", async () => {
    const onStart = vi.fn();
    const { rerender } = render(<PublicEditorWelcomeDialog onStart={onStart} consentPending />);
    // Effects have run: still nothing over the banner.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE })).toBeNull());
    rerender(<PublicEditorWelcomeDialog onStart={onStart} consentPending={false} />);
    expect(await screen.findByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE })).toBeInTheDocument();
  });

  it("isn't shown once done, and starts nothing", async () => {
    window.localStorage.setItem(PUBLIC_EDITOR_WELCOME_DONE_KEY, "true");
    const { onStart } = renderDialog();
    // The flag is read in an effect: give it its turn.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("shows again after a remount until the visitor chooses", async () => {
    const { view } = renderDialog();
    await screen.findByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE });
    view.unmount();
    renderDialog();
    expect(await screen.findByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE })).toBeInTheDocument();
  });

  it("can't be dismissed without a choice: Escape leaves it open", async () => {
    const { onStart, user } = renderDialog();
    await screen.findByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE })).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PUBLIC_EDITOR_WELCOME_DONE_KEY)).toBeNull();
  });

  it("shows when storage can't be read, and survives storage that refuses the write", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { onStart, user } = renderDialog();
    await user.click(await screen.findByRole("button", { name: START_BLANK_LABEL }));
    expect(onStart.mock.calls).toEqual([["blank", true]]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
