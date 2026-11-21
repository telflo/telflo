import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { isFleetGone, isRateLimited, isUnknownOutcome } from "~/lib/fleets.js";

/*
 * Bulk move and bulk delete's loop of single writes: one request at a time,
 * each under its own hang guard, paced on a 429's `Retry-After`, with progress
 * and a result per item. Nothing here names an item in a message: the caller
 * words each result.
 */

/** What became of one item, in the order the items were given. */
export type PacedResult<Item> =
  /** The write was made. */
  | { item: Item; kind: "done" }
  /** 404 `collector_not_found`: the collector was deleted meanwhile ("Already deleted"; a delete counts it as deleted). */
  | { item: Item; kind: "gone" }
  /** The API refused it and made nothing: `message` is `refusal`'s words for `error`. */
  | { item: Item; kind: "refused"; message: string; error: unknown }
  /** The outcome is unknown (`isUnknownOutcome`: a 5xx, no connection, the hang guard's abort): it may or may not have been made. */
  | { item: Item; kind: "unknown"; error: unknown }
  /** Not attempted, and nothing was made: the loop stopped before it was sent, or while a 429 that answered it held it back. */
  | { item: Item; kind: "not_attempted" };

/** Where the loop is: the item in flight (1-based) of `total`, and how long a 429 makes it wait before trying that item again. */
export interface PacedProgress {
  current: number;
  total: number;
  /** The seconds a 429 makes the loop wait, while it waits; null while a request is in flight. */
  waitingSeconds: number | null;
}

export interface PacedWritesOptions {
  /** Each request's hang guard: its abort is an unknown outcome. */
  timeoutMs: number;
  /** The words of a refusal, for its result: `fleetRefusalMessage(error, fallback)`. */
  refusal: (error: unknown) => string;
  /**
   * The caller's own refusals that stop the loop (a move's
   * `collector_group_not_found`: the target group is gone), beside the
   * built-in ones.
   */
  stopsOn?: (error: unknown) => boolean;
  /** Told before each request and at the start of each 429's wait. */
  onProgress?: (progress: PacedProgress) => void;
}

export interface PacedWrites<Item> {
  /** Every item's result, in the items' order, once the loop has ended. */
  results: Promise<PacedResult<Item>[]>;
  /**
   * Stops the loop: the request in flight finishes and its result is kept,
   * unless a 429 answers it, which waits not at all (that item not
   * attempted); a 429's wait ends at once, or never starts when the stop
   * comes as it is told (`onProgress`), that item not attempted; the rest
   * are not attempted.
   */
  stop: () => void;
}

const COLLECTOR_NOT_FOUND = "collector_not_found";

/**
 * Whether a refusal means the loop can't go on: the organization gone, the
 * terms to accept, the session ended, the fleet gone. The rest would be
 * refused the same way.
 */
function stopsEveryLoop(error: unknown): boolean {
  return isOrganizationGone(error) || isTermsAcceptanceRequired(error) || isSessionEnded(error) || isFleetGone(error);
}

/**
 * Writes each of `items` in turn through `write`, one request at a time, each
 * with its own `abortAfter(timeoutMs)` whose signal `write` passes on.
 *
 * - A 429 waits `max(1, retryAfterSeconds ?? 1)` seconds, then tries the
 *   same item again; `stop()` ends the wait, and a 429 answering a request
 *   in flight when `stop()` came waits not at all (that item not attempted).
 * - `collector_not_found` is `gone`, and the loop goes on.
 * - An unknown outcome is `unknown` and stops the loop: a hang would
 *   otherwise cost the hang guard's time on every item, and what the
 *   opamp-server is doing is unknown.
 * - `organization_not_found`, `terms_acceptance_required`, the session
 *   ended, `fleet_not_found` and the caller's `stopsOn` are `refused` and
 *   stop the loop; any other refusal is `refused` and the loop goes on.
 * - Once stopped, every item after the last one sent is `not_attempted`.
 */
export function runPacedWrites<Item>(
  items: readonly Item[],
  write: (item: Item, signal: AbortSignal) => Promise<unknown>,
  { timeoutMs, refusal, stopsOn, onProgress }: PacedWritesOptions,
): PacedWrites<Item> {
  let stopped = false;
  let endWait: (() => void) | null = null;

  const stop = () => {
    stopped = true;
    endWait?.();
  };

  /** Waits `seconds`, or until `stop()`; not at all once stopped (a stop from `onProgress` as the wait was told). */
  const wait = (seconds: number) =>
    new Promise<void>((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        endWait = null;
        resolve();
      }, seconds * 1000);
      endWait = () => {
        clearTimeout(timer);
        endWait = null;
        resolve();
      };
    });

  const run = async (): Promise<PacedResult<Item>[]> => {
    const results: PacedResult<Item>[] = [];
    for (const [index, item] of items.entries()) {
      let result: PacedResult<Item> | null = null;
      let haltsLoop = false;
      while (result === null && !stopped) {
        onProgress?.({ current: index + 1, total: items.length, waitingSeconds: null });
        const guard = abortAfter(timeoutMs);
        try {
          await write(item, guard.signal);
          result = { item, kind: "done" };
        } catch (error) {
          if (isRateLimited(error)) {
            // Stopped while this request was in flight: no wait, the item not attempted.
            if (stopped) continue;
            const seconds = Math.max(1, error.retryAfterSeconds ?? 1);
            onProgress?.({ current: index + 1, total: items.length, waitingSeconds: seconds });
            await wait(seconds);
            continue;
          }
          if (error instanceof ApiError && error.code === COLLECTOR_NOT_FOUND) {
            result = { item, kind: "gone" };
          } else if (isUnknownOutcome(error)) {
            result = { item, kind: "unknown", error };
            haltsLoop = true;
          } else {
            result = { item, kind: "refused", message: refusal(error), error };
            haltsLoop = stopsEveryLoop(error) || (stopsOn?.(error) ?? false);
          }
        } finally {
          guard.clear();
        }
      }
      results.push(result ?? { item, kind: "not_attempted" });
      if (haltsLoop) stopped = true;
    }
    return results;
  };

  return { results: run(), stop };
}
