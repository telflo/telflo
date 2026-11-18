/**
 * React Flow's documented jsdom mocks (reactflow.dev, "Testing"), installed
 * per canvas test file and restored after it (Preflight ruling 17): a
 * `ResizeObserver` that reports each observed element (with a
 * `contentRect`) once the current commit is done; `DOMMatrixReadOnly`,
 * which React Flow reads the zoom from; `offsetWidth`/`offsetHeight` from
 * an element's inline size; and
 * `getBBox` for SVG. Never in the global setup: Radix's tests rely on the
 * global no-op observer.
 *
 * Usage: `beforeAll(installReactFlowMocks)` returns the function that
 * restores what was there; vitest calls it after the file.
 */

class ReportingResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    const element = target as HTMLElement;
    const width = parseFloat(element.style?.width ?? "") || 1;
    const height = parseFloat(element.style?.height ?? "") || 1;
    const entry = {
      target,
      contentRect: { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height },
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry;
    // Reported after the current commit: React Flow observes a node in the
    // node's effect, before the effect that records the canvas's element.
    queueMicrotask(() => this.callback([entry], this as unknown as ResizeObserver));
  }

  unobserve() {}

  disconnect() {}
}

class ZoomOnlyDOMMatrixReadOnly {
  readonly m22: number;

  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

export function installReactFlowMocks(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    ResizeObserver: globals.ResizeObserver,
    DOMMatrixReadOnly: globals.DOMMatrixReadOnly,
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    getBBox: Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox"),
  };

  globals.ResizeObserver = ReportingResizeObserver;
  globals.DOMMatrixReadOnly = ZoomOnlyDOMMatrixReadOnly;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.width) || 1;
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.height) || 1;
      },
    },
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });

  return () => {
    globals.ResizeObserver = saved.ResizeObserver;
    if (saved.DOMMatrixReadOnly === undefined) delete globals.DOMMatrixReadOnly;
    else globals.DOMMatrixReadOnly = saved.DOMMatrixReadOnly;
    for (const [name, descriptor] of [
      ["offsetWidth", saved.offsetWidth],
      ["offsetHeight", saved.offsetHeight],
    ] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
    if (saved.getBBox) Object.defineProperty(SVGElement.prototype, "getBBox", saved.getBBox);
    else delete (SVGElement.prototype as unknown as Record<string, unknown>).getBBox;
  };
}
