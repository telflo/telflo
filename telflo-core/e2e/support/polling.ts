import { expect, type Page, type Request } from "@playwright/test";

// A polled screen's next poll, driven by the page's clock: the fleet list's
// and a fleet's Collectors tab's. The test installs `page.clock` before the
// page loads, at the real now (the fake opamp-server runs on real time).

/** Whether a request is (one of) the poll's reads. */
export type PolledRequest = (request: Request) => boolean;

/** The screens' polling interval (FLEETS_POLL_INTERVAL_MS). */
export const POLL_INTERVAL_MS = 15_000;

/**
 * The next poll, its reads answered. `page.clock` keeps the polling
 * interval's phase from the page's mount, and the time a test spends
 * between advances moves the next tick by that much, so no advance can
 * assume where the tick falls in it: one `runFor(15_000)` could fire the
 * tick early in its span and then the poll's own 10 s abort inside it.
 * Instead the clock goes on one second at a time (`runFor`, never
 * `fastForward`: WebKit's skipped a guarded tick), at most one interval's
 * worth of steps and one more, until a request matching each of `isPolled` is seen;
 * nothing advances while they are under way, and their answers (200) are
 * awaited: the answers to the very requests seen, not to whichever read
 * answers next. The steps are a bound, not only a wait: `page.clock` lets
 * real time flow too, so a poll that came late (a longer interval) would
 * still be seen eventually; once the steps are done (and a round trip to
 * the page has delivered its requests' events), each request must have been
 * seen within them.
 */
export async function nextPoll(
  page: Page,
  isPolled: PolledRequest | readonly PolledRequest[],
  intervalMs = POLL_INTERVAL_MS,
): Promise<void> {
  const predicates = typeof isPolled === "function" ? [isPolled] : isPolled;
  // One interval's worth of steps and one to spare (the tick may fall just past the last): 16 for 15 s.
  // A poll slower than one interval (20 s, say) fails only when this starts within about 3-4 s of the
  // interval's phase (the page's mount, or the poll before), its tick then past the 16th step: as the
  // specs call it, right after the page loads or after the previous nextPoll. Started later in the
  // interval, a 20 s tick could still fall within the steps and pass.
  const steps = intervalMs / 1_000 + 1;
  let unseen = predicates.length;
  const requested = predicates.map((predicate) => {
    const waiting = page.waitForRequest(predicate);
    // Its rejection (no request before the timeout) is the awaited one's below, not an unhandled one here.
    void waiting.then(
      () => {
        unseen -= 1;
      },
      () => undefined,
    );
    return waiting;
  });
  for (let step = 0; step < steps && unseen > 0; step += 1) {
    await page.clock.runFor(1_000);
  }
  // A round trip to the page: the events of the requests it made before it have been delivered.
  await page.evaluate("0");
  expect(unseen, `the poll's ${predicates.length === 1 ? "request" : "requests"} within ${steps} one-second steps`).toBe(0);
  for (const waiting of requested) {
    const request = await waiting;
    expect((await request.response())?.status()).toBe(200);
  }
}

/** A GET of a path `path` matches exactly (its query aside). */
export function isGetOf(path: RegExp): PolledRequest {
  return (request) => request.method() === "GET" && path.test(new URL(request.url()).pathname);
}
