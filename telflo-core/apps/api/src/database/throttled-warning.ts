/*
 * A warning for a database call a background loop repeats: the dispatcher's
 * claim every second, the reaper's rules and the health monitor's row every
 * 5 s. While the database is down each would log a line per try; instead
 * the first failure is logged, then at most one a minute while the failures
 * last (with how many were left out), and one line when a call succeeds
 * again.
 */

/** At most one failure line a minute while failures last. */
export const THROTTLED_WARNING_INTERVAL_MS = 60_000;

/** Where the lines go. A pino/Fastify logger fits. */
export interface ThrottledWarningLog {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface ThrottledWarning {
  /** The call failed: logged when it is the first since a success, or a minute after the last line. */
  failed(details: Record<string, unknown>): void;
  /** The call succeeded: after failures, one recovery line. */
  succeeded(): void;
}

export interface ThrottledWarningOptions {
  /** The failure's line. */
  failed: string;
  /** The recovery's line. */
  recovered: string;
  /** THROTTLED_WARNING_INTERVAL_MS by default. */
  intervalMs?: number;
  /** Date.now by default. */
  now?: () => number;
}

export function createThrottledWarning(log: ThrottledWarningLog, options: ThrottledWarningOptions): ThrottledWarning {
  const intervalMs = options.intervalMs ?? THROTTLED_WARNING_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  /** When the failures began; undefined while calls succeed. */
  let failingSince: number | undefined;
  let lastLineAt = 0;
  let failures = 0;
  let leftOut = 0;
  return {
    failed(details) {
      const at = now();
      failures += 1;
      if (failingSince === undefined) {
        failingSince = at;
        lastLineAt = at;
        log.warn(details, options.failed);
        return;
      }
      if (at - lastLineAt < intervalMs) {
        leftOut += 1;
        return;
      }
      log.warn({ ...details, failures, leftOut }, options.failed);
      lastLineAt = at;
      leftOut = 0;
    },
    succeeded() {
      if (failingSince === undefined) return;
      log.warn({ failures, failingForMs: now() - failingSince }, options.recovered);
      failingSince = undefined;
      failures = 0;
      leftOut = 0;
    },
  };
}
