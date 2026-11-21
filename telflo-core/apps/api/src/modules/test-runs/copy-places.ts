/*
 * The queue's copies in flight. A run from a definition isn't counted
 * against the 20 a minute, so without a bound a burst of them at a nearly
 * full queue could each copy its input before the re-check refused all but
 * one. Instead, at most TEST_RUN_COPIES_IN_FLIGHT_PER_USER queue requests
 * per person, per organization, hold a place at once, in memory in this API
 * process (as every limit is). A place is taken before the count of waiting
 * runs and kept until the request ends, so a request that waited counts the
 * queue as it is once it has its place, and a full queue refuses it before
 * any copy. Further requests wait for a place, first come first served;
 * beyond TEST_RUN_COPIES_WAITING_PER_USER waiting, a request is refused
 * (`test_run_rate_limited`, with its own words).
 *
 * The browser is never refused by it in practice: a Play all keeps at most
 * 4 requests in flight, though two Play alls on different versions or in
 * different tabs can have 8 in flight, and the extras wait.
 */

/** Queue requests per person, per organization, between the count of waiting runs and their end. */
export const TEST_RUN_COPIES_IN_FLIGHT_PER_USER = 4;
/** Queue requests per person, per organization, waiting for one of those places. */
export const TEST_RUN_COPIES_WAITING_PER_USER = 100;
/** The refusal's retry-after: places free as copies end, within seconds. */
export const TEST_RUN_COPIES_RETRY_AFTER_SECONDS = 1;

/** A place taken, or why not. */
export type CopyPlace =
  /** Held: `release` gives it to the longest waiting request, or frees it; a second call is a no-op. */
  | { isTaken: true; release: () => void }
  /** TEST_RUN_COPIES_WAITING_PER_USER are waiting already: nothing was taken. */
  | { isTaken: false; retryAfterSeconds: number };

export interface CopyPlaces {
  /**
   * A place for `userId` in `organizationId`: at once while one is free,
   * otherwise once the requests ahead have released theirs, in the order
   * they asked. Never holds anything else while it waits.
   */
  take(userId: string, organizationId: string): Promise<CopyPlace>;
  /** How many hold a place and how many wait, for that person and organization (tests watch it). */
  count(userId: string, organizationId: string): { holding: number; waiting: number };
  /** How many people-and-organizations it keeps in memory: none once every place is released (tests watch the clean-up). */
  keyCount(): number;
}

interface Places {
  holding: number;
  waiting: Array<() => void>;
}

export function createCopyPlaces(options: { inFlight?: number; waiting?: number } = {}): CopyPlaces {
  const inFlight = options.inFlight ?? TEST_RUN_COPIES_IN_FLIGHT_PER_USER;
  const waitingMaximum = options.waiting ?? TEST_RUN_COPIES_WAITING_PER_USER;
  const byKey = new Map<string, Places>();
  const keyOf = (userId: string, organizationId: string) => JSON.stringify([userId, organizationId]);

  function placeFor(key: string, places: Places): CopyPlace {
    let isReleased = false;
    return {
      isTaken: true,
      release: () => {
        if (isReleased) return;
        isReleased = true;
        const next = places.waiting.shift();
        // Handed on: the next request holds it, so `holding` is unchanged.
        if (next !== undefined) {
          next();
          return;
        }
        places.holding -= 1;
        if (places.holding === 0) byKey.delete(key);
      },
    };
  }

  return {
    take(userId, organizationId) {
      const key = keyOf(userId, organizationId);
      let places = byKey.get(key);
      if (places === undefined) {
        places = { holding: 0, waiting: [] };
        byKey.set(key, places);
      }
      const current = places;
      if (current.holding < inFlight) {
        current.holding += 1;
        return Promise.resolve(placeFor(key, current));
      }
      if (current.waiting.length >= waitingMaximum) {
        return Promise.resolve({ isTaken: false, retryAfterSeconds: TEST_RUN_COPIES_RETRY_AFTER_SECONDS });
      }
      return new Promise<CopyPlace>((resolve) => {
        current.waiting.push(() => resolve(placeFor(key, current)));
      });
    },
    count(userId, organizationId) {
      const places = byKey.get(keyOf(userId, organizationId));
      return { holding: places?.holding ?? 0, waiting: places?.waiting.length ?? 0 };
    },
    keyCount() {
      return byKey.size;
    },
  };
}
