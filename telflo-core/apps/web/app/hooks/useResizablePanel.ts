import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * Hook for mouse-drag panel resizing, without an AI panel's sibling logic,
 * and with the width held by the caller. Returns the width to render,
 * resizing state, and a handler to start resizing.
 *
 * `width` is the width the person chose, from the editor's store; a drag
 * writes the new width through `onWidthChange`. A drag measures from the
 * window's right edge, so the panel must sit flush against it.
 *
 * Pass `minCanvasWidth` + `boundaryRef` (a ref to the element directly to the
 * LEFT of the panel, e.g. the canvas column) to cap how wide the panel can be
 * dragged so that element never shrinks below `minCanvasWidth`. The
 * boundary's live left edge is measured, so any fixed chrome to its left
 * (the sidebar) is accounted for automatically. Omitted → only the fixed
 * maxWidth applies.
 *
 * The cap is applied to the width rendered, not written back: a narrow
 * window's clamp stays out of the remembered width, so a temporarily narrow
 * window does not permanently shrink the chosen width.
 */
export function useResizablePanel(
  width: number,
  onWidthChange: (width: number) => void,
  minWidth = 300,
  maxWidth = 800,
  minCanvasWidth?: number,
  boundaryRef?: RefObject<HTMLElement | null>,
) {
  const [isResizing, setIsResizing] = useState(false);
  // The largest the panel may be now; measured after layout, so a server
  // render (and the first client render, which must match it) uses maxWidth.
  const [cap, setCap] = useState(maxWidth);

  // The largest the panel may be while keeping the boundary element wide enough.
  const computeMaxWidth = useCallback(() => {
    if (minCanvasWidth == null || !boundaryRef?.current) return maxWidth;
    const left = boundaryRef.current.getBoundingClientRect().left;
    const dynamicMax = window.innerWidth - left - minCanvasWidth;
    return Math.max(minWidth, Math.min(maxWidth, dynamicMax));
  }, [minWidth, maxWidth, minCanvasWidth, boundaryRef]);

  // Keep the panel within the cap on first layout and whenever the window
  // resizes — so it can't start (or be left) too wide for the current screen.
  useLayoutEffect(() => {
    const measure = () => setCap(computeMaxWidth());
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [computeMaxWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const max = computeMaxWidth();
      setCap(max);
      const newWidth = window.innerWidth - e.clientX;
      onWidthChange(Math.min(Math.max(newWidth, minWidth), max));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, minWidth, computeMaxWidth, onWidthChange]);

  return {
    panelWidth: Math.min(Math.max(width, minWidth), cap),
    isResizing,
    startResizing: () => setIsResizing(true),
  };
}
