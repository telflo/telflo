import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useResizablePanel } from "./useResizablePanel.js";

const WINDOW_WIDTH = 1440;
const originalInnerWidth = window.innerWidth;

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

/** The center column, whose left edge the hook measures. */
function boundaryAt(left: number) {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({ left }) as DOMRect;
  return { current: element };
}

/** The hook with its width held in state, as the layout holds it in the store. */
function renderPanel(initialWidth: number, options: { minCanvasWidth?: number; boundaryLeft?: number } = {}) {
  const boundaryRef = options.boundaryLeft === undefined ? undefined : boundaryAt(options.boundaryLeft);
  return renderHook(() => {
    const [width, setWidth] = useState(initialWidth);
    return { width, ...useResizablePanel(width, setWidth, 320, 800, options.minCanvasWidth, boundaryRef) };
  });
}

function drag(result: { current: { startResizing: () => void } }, clientX: number) {
  act(() => result.current.startResizing());
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
  });
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup"));
  });
}

beforeEach(() => {
  setWindowWidth(WINDOW_WIDTH);
});

afterEach(() => {
  setWindowWidth(originalInnerWidth);
});

describe("useResizablePanel", () => {
  it("renders the width it is given", () => {
    const { result } = renderPanel(640);

    expect(result.current.panelWidth).toBe(640);
    expect(result.current.isResizing).toBe(false);
  });

  it("dragging sets the width to the distance from the window's right edge", () => {
    const { result } = renderPanel(640);

    drag(result, WINDOW_WIDTH - 500);

    expect(result.current.width).toBe(500);
    expect(result.current.panelWidth).toBe(500);
  });

  it("dragging never makes the panel narrower than 320 px or wider than 800 px", () => {
    const { result } = renderPanel(640);

    drag(result, WINDOW_WIDTH - 100);
    expect(result.current.width).toBe(320);

    drag(result, WINDOW_WIDTH - 1200);
    expect(result.current.width).toBe(800);
  });

  it("dragging leaves the center at least its minimum width", () => {
    // The center starts 240 px in (the sidebar); 1440 - 240 - 320 = 880 is
    // over 800, so on a narrower window: 1000 - 240 - 320 = 440.
    setWindowWidth(1000);
    const { result } = renderPanel(400, { minCanvasWidth: 320, boundaryLeft: 240 });

    drag(result, 0);

    expect(result.current.width).toBe(440);
    expect(result.current.panelWidth).toBe(440);
  });

  it("320 px wins over the center's minimum on a window too narrow for both", () => {
    setWindowWidth(800);
    const { result } = renderPanel(640, { minCanvasWidth: 320, boundaryLeft: 240 });

    expect(result.current.panelWidth).toBe(320);
    drag(result, 0);
    expect(result.current.width).toBe(320);
  });

  it("a narrower window caps the width rendered without changing the width chosen", () => {
    const { result } = renderPanel(640, { minCanvasWidth: 320, boundaryLeft: 240 });
    expect(result.current.panelWidth).toBe(640);

    act(() => {
      setWindowWidth(1000);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.panelWidth).toBe(440);
    expect(result.current.width).toBe(640);

    act(() => {
      setWindowWidth(WINDOW_WIDTH);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.panelWidth).toBe(640);
  });

  it("releasing the mouse ends the drag and restores the page's cursor", () => {
    const { result } = renderPanel(640);

    act(() => result.current.startResizing());
    expect(result.current.isResizing).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(result.current.isResizing).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: WINDOW_WIDTH - 500 }));
    });
    expect(result.current.width).toBe(640);
  });
});
