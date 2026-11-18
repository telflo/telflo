/**
 * An IntersectionObserver a test can drive. The global stub in
 * vitest.setup.ts never reports anything; install this one with
 * `vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver)`
 * when a test needs to scroll an element into or out of view.
 */
const liveObservers = new Set<ControllableIntersectionObserver>();

export class ControllableIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  readonly targets = new Set<Element>();

  constructor(readonly callback: IntersectionObserverCallback) {
    liveObservers.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    liveObservers.delete(this);
  }

  takeRecords() {
    return [];
  }
}

/** Reports `target` entering (or leaving) the viewport to every observer watching it. */
export function reportIntersection(target: Element, isIntersecting: boolean) {
  for (const observer of [...liveObservers]) {
    if (!observer.targets.has(target)) continue;
    observer.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  }
}

/** Whether anything is currently watching `target`. */
export function isObserved(target: Element): boolean {
  return [...liveObservers].some((observer) => observer.targets.has(target));
}

/** Makes window.matchMedia answer `true` only for the given queries. */
export function matchMediaQueries(matching: readonly string[]): typeof window.matchMedia {
  return (query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
