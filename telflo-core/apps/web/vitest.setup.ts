import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Every findBy… and waitFor waits on its condition and returns as soon as
// it holds; the limit is only a hang guard. Testing Library's default, 1 s,
// was a wall-clock bound that CI's load overran (a page took 1.3 s to show
// "Version not found"). A test that passes its own `timeout` keeps it.
// vitest.config.ts's testTimeout stays well above it, so a failing wait
// keeps its own message.
configure({ asyncUtilTimeout: 5_000 });

// Everything below stubs what jsdom lacks. A test that runs in Node instead
// (`// @vitest-environment node`, as a server render's does) has no DOM
// to stub.
if (typeof window !== "undefined") {
  // jsdom lacks ResizeObserver, which Radix primitives (the register form's
  // Checkbox, via @radix-ui/react-use-size) call on mount. A no-op stub is
  // enough: tests assert on behavior, never on measured sizes.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // jsdom has no matchMedia. The marketing components ask it about
  // prefers-reduced-motion and prefers-color-scheme; this default answers "no"
  // to every query (full motion, light OS theme). A test that needs a different
  // answer replaces window.matchMedia for itself.
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  // jsdom has no IntersectionObserver either. The landing page uses it only to
  // start animations and videos as they scroll into view. Nothing scrolls in
  // jsdom, so an observer that never reports anything is accurate.
  if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver = class {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds: readonly number[] = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  // jsdom implements <canvas> without a drawing context and logs a
  // "not implemented" error whenever one is requested. Returning null is what a
  // browser does when no context is available, and the hero animation already
  // handles that by not starting.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

  // jsdom has no pointer capture and no scrollIntoView. Radix's Select (the
  // Change Role dialog's) calls the first when its trigger is pressed, and the
  // second to bring the selected option into view. No-ops are enough: nothing
  // is laid out or scrolls in jsdom.
  if (typeof Element.prototype.hasPointerCapture !== "function") {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
}
