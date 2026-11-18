/**
 * The most keys a failure limiter holds at once, unless told otherwise.
 * Each entry is a short string and two numbers, so this caps the limiter at
 * roughly a megabyte however many addresses an attacker sprays.
 */
export const DEFAULT_FAILURE_LIMITER_MAX_KEYS = 10_000;

export interface FailureLimiterOptions {
  /** Failures allowed per key in one window; the next attempt is blocked. */
  max: number;
  windowMs: number;
  /** Defaults to DEFAULT_FAILURE_LIMITER_MAX_KEYS. */
  maxKeys?: number;
  /** Milliseconds since the epoch. Injectable for tests. */
  now?: () => number;
}

export interface FailureLimitCheck {
  isBlocked: boolean;
  /** Whole seconds until the key's window ends; 0 when not blocked. */
  retryAfterSeconds: number;
}

export interface FailureLimiter {
  /** Whether `key` is blocked. Counts nothing. */
  check(key: string): FailureLimitCheck;
  /** The failures counted for `key` in its live window; 0 when it has none. Counts nothing. */
  count(key: string): number;
  /**
   * Counts one failure; the first failure opens the key's window. Returns
   * when the window it was counted in opened, for `refund`.
   */
  recordFailure(key: string): number;
  /**
   * Takes back one failure recorded in the key's current window. With
   * `windowStartedAt` (what `recordFailure` returned), only while that same
   * window is the key's live one: a failure counted in a window that has
   * ended is never taken from the next one, however close the two are
   * (D14a Ruling 45).
   */
  refund(key: string, windowStartedAt?: number): void;
  /** Forgets the key: its count starts again from zero. */
  reset(key: string): void;
  /** How many keys are held (for tests of the bound). */
  readonly size: number;
}

interface Window {
  startedAt: number;
  failures: number;
}

/**
 * A fixed-window failure counter, in memory, per API process (D2a
 * Ruling 13). Unlike @fastify/rate-limit it can check without counting, so
 * a caller counts only the outcomes it means to limit. Every operation is
 * synchronous, so a check and the count that follows it never interleave
 * with another request's.
 *
 * A key's window opens at its first failure and lasts `windowMs`; when it
 * ends the key is forgotten. The Map's insertion order is the order windows
 * opened (a key is re-inserted when a new window opens), so the oldest
 * window is always first. When a new key would exceed `maxKeys`, the oldest
 * window is dropped: an expired one if any is left, since they sit in front,
 * otherwise the oldest live one. That bounds memory at the cost that
 * spraying more than `maxKeys` addresses can push an earlier address's count
 * out early; the per-IP limit still applies to whoever does the spraying.
 */
export function createFailureLimiter(options: FailureLimiterOptions): FailureLimiter {
  const { max, windowMs, maxKeys = DEFAULT_FAILURE_LIMITER_MAX_KEYS, now = Date.now } = options;
  const windows = new Map<string, Window>();

  const isExpired = (window: Window, at: number) => at - window.startedAt >= windowMs;

  const liveWindow = (key: string, at: number): Window | undefined => {
    const window = windows.get(key);
    if (window === undefined) return undefined;
    if (!isExpired(window, at)) return window;
    windows.delete(key);
    return undefined;
  };

  /** Windows sit in the order they opened: the first is the oldest, and any expired one is in front. */
  const makeRoom = () => {
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) return;
      windows.delete(key);
    }
  };

  return {
    check(key) {
      const at = now();
      const window = liveWindow(key, at);
      if (window === undefined || window.failures < max) return { isBlocked: false, retryAfterSeconds: 0 };
      return {
        isBlocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - at) / 1000)),
      };
    },
    count(key) {
      return liveWindow(key, now())?.failures ?? 0;
    },
    recordFailure(key) {
      const at = now();
      const window = liveWindow(key, at);
      if (window !== undefined) {
        window.failures += 1;
        return window.startedAt;
      }
      makeRoom();
      windows.set(key, { startedAt: at, failures: 1 });
      return at;
    },
    refund(key, windowStartedAt) {
      const window = liveWindow(key, now());
      if (window === undefined) return;
      if (windowStartedAt !== undefined && window.startedAt !== windowStartedAt) return;
      window.failures -= 1;
      if (window.failures <= 0) windows.delete(key);
    },
    reset(key) {
      windows.delete(key);
    },
    get size() {
      return windows.size;
    },
  };
}
