import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SortableHandle, SortableItem, SortableList, sortableId } from "./index.js";

/*
 * Keyboard reordering in jsdom: dnd-kit measures each item's rectangle, and
 * jsdom's are all zero, so rows are laid out here, 40 px apart. The pointer
 * path runs in the browsers.
 */

const ROW_HEIGHT = 40;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // The drag overlay (position: fixed) starts where the dragged row is.
    const overlay = this.closest("[style*='position: fixed']") !== null;
    const row = (overlay ? document.querySelector(".dragging") : this)?.closest<HTMLElement>(".row");
    const index = row ? [...row.parentElement!.children].indexOf(row) : 0;
    const top = index * ROW_HEIGHT;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + ROW_HEIGHT,
      width: 200,
      height: ROW_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VALUES = ["SECRET-ALPHA", "SECRET-BRAVO", "SECRET-CHARLIE"];

function List({
  onReorder,
  items = VALUES,
  overlay = true,
}: {
  onReorder: (from: number, to: number) => void;
  items?: string[];
  /** Rendered in the overlay while dragging. */
  overlay?: boolean;
}) {
  return (
    <div data-testid="panel">
      <SortableList
        list="attr"
        items={items}
        onReorder={onReorder}
        listClassName="space-y-2"
        emptyMessage={<p>No attributes</p>}
        {...(overlay ? { renderOverlay: (item: string) => <span data-testid="overlay">{item}</span> } : {})}
      >
        {(item, _index, id) => (
          <SortableItem key={id} id={id} className="row">
            {({ dragHandleProps, isDragging }) => (
              <div className={isDragging ? "dragging" : undefined}>
                <SortableHandle attributes={dragHandleProps.attributes} listeners={dragHandleProps.listeners} />
                <span>{item}</span>
              </div>
            )}
          </SortableItem>
        )}
      </SortableList>
    </div>
  );
}

async function press(element: Element, key: string, code = key) {
  await act(async () => {
    fireEvent.keyDown(element, { key, code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Sortable", () => {
  it("reorders by keyboard: Space, ArrowDown twice, Space calls back with (from, to)", async () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    act(() => handles[0]!.focus());

    await press(handles[0]!, " ", "Space");
    await press(handles[0]!, "ArrowDown");
    await press(handles[0]!, "ArrowDown");
    await press(handles[0]!, " ", "Space");

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  it("reorders upward too, and a drop where it started or a cancel calls nothing", async () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });

    act(() => handles[1]!.focus());
    await press(handles[1]!, " ", "Space");
    await press(handles[1]!, " ", "Space");
    expect(onReorder).not.toHaveBeenCalled();

    await press(handles[1]!, " ", "Space");
    await press(handles[1]!, "ArrowDown");
    await press(handles[1]!, "Escape");
    expect(onReorder).not.toHaveBeenCalled();

    await press(handles[2]!, " ", "Space");
    await press(handles[2]!, "ArrowUp");
    await press(handles[2]!, " ", "Space");
    expect(onReorder).toHaveBeenCalledWith(2, 1);
  });

  it("ids are <list>-<index>; its live region renders inline and no attribute carries a value", async () => {
    render(<List onReorder={() => {}} />);
    expect(sortableId("attr", 0)).toBe("attr-0");
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    act(() => handles[0]!.focus());
    await press(handles[0]!, " ", "Space");
    await press(handles[0]!, "ArrowDown");

    const panel = screen.getByTestId("panel");
    const live = panel.querySelector("[aria-live]");
    expect(live).not.toBeNull();
    expect(panel.textContent).toContain("attr-0");
    expect(document.querySelector(".dragging")).not.toBeNull();
    expect(screen.getByTestId("overlay")).toHaveTextContent("SECRET-ALPHA");

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (VALUES.some((value) => attribute.value.includes(value))) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(live!.textContent).not.toMatch(/SECRET/);
    await press(handles[0]!, "Escape");
  });

  it("shows its empty message for no items, and the handle with its gray and blue classes", () => {
    const { unmount } = render(<List onReorder={() => {}} items={[]} />);
    expect(screen.getByText("No attributes")).toBeInTheDocument();
    unmount();

    render(
      <SortableHandle
        attributes={{ role: "button", tabIndex: 0, "aria-disabled": false, "aria-pressed": undefined, "aria-roledescription": "sortable", "aria-describedby": "x" }}
        listeners={undefined}
        disabled
      />,
    );
    const handle = screen.getByRole("button", { name: "Drag to reorder" });
    expect(handle).toBeDisabled();
    expect(handle).toHaveClass("cursor-grab", "text-gray-400", "focus:ring-blue-500");
  });
});
