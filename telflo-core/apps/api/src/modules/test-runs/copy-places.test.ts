import { describe, expect, it } from "vitest";
import {
  createCopyPlaces,
  TEST_RUN_COPIES_IN_FLIGHT_PER_USER,
  TEST_RUN_COPIES_RETRY_AFTER_SECONDS,
  TEST_RUN_COPIES_WAITING_PER_USER,
  type CopyPlace,
} from "./copy-places.js";

/* D14b Ruling 33: the queue's places for requests in flight, per person, per organization. */

const ANA = "ana";
const ACME = "acme";

/** A taken place's release; fails the test for a refusal. */
function releaseOf(place: CopyPlace): () => void {
  if (!place.isTaken) throw new Error("expected a place");
  return place.release;
}

/** Resolves once every promise already resolved has run its callbacks (a macrotask after them). */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("the queue's copy places", () => {
  it("are Ruling 33's: 4 in flight, 100 waiting, a second's retry", () => {
    expect(TEST_RUN_COPIES_IN_FLIGHT_PER_USER).toBe(4);
    expect(TEST_RUN_COPIES_WAITING_PER_USER).toBe(100);
    expect(TEST_RUN_COPIES_RETRY_AFTER_SECONDS).toBe(1);
  });

  it("give four places at once; the fifth waits until one is released, then holds it", async () => {
    const places = createCopyPlaces();
    const releases = [];
    for (let index = 0; index < 4; index += 1) releases.push(releaseOf(await places.take(ANA, ACME)));
    let fifth: CopyPlace | undefined;
    const waiting = places.take(ANA, ACME).then((place) => {
      fifth = place;
    });
    await Promise.resolve();
    expect(fifth).toBeUndefined();
    expect(places.count(ANA, ACME)).toEqual({ holding: 4, waiting: 1 });

    releases[2]!();
    await waiting;

    expect(fifth?.isTaken).toBe(true);
    expect(places.count(ANA, ACME)).toEqual({ holding: 4, waiting: 0 });
  });

  it("hand places on first come, first served: each release goes to the longest waiting, the others still waiting", async () => {
    const places = createCopyPlaces({ inFlight: 1 });
    const first = releaseOf(await places.take(ANA, ACME));
    /** The waiters in the order they got a place, each with its release. */
    const served: Array<{ index: number; release: () => void }> = [];
    const waiters = [1, 2, 3].map((index) =>
      places.take(ANA, ACME).then((place) => {
        served.push({ index, release: releaseOf(place) });
      }),
    );
    expect(places.count(ANA, ACME)).toEqual({ holding: 1, waiting: 3 });

    // Each step settles every promise a release resolved (no timing), so a
    // wrong order fails on the assertion rather than waiting forever.
    first();
    await settled();
    expect(served.map((each) => each.index)).toEqual([1]);
    expect(places.count(ANA, ACME)).toEqual({ holding: 1, waiting: 2 });

    served[0]!.release();
    await settled();
    expect(served.map((each) => each.index)).toEqual([1, 2]);
    expect(places.count(ANA, ACME)).toEqual({ holding: 1, waiting: 1 });

    served[1]!.release();
    await settled();
    expect(served.map((each) => each.index)).toEqual([1, 2, 3]);

    served[2]!.release();
    await Promise.all(waiters);
    expect(places.count(ANA, ACME)).toEqual({ holding: 0, waiting: 0 });
  });

  it("refuse a request beyond 100 waiting, taking nothing", async () => {
    const places = createCopyPlaces();
    for (let index = 0; index < 4; index += 1) await places.take(ANA, ACME);
    for (let index = 0; index < 100; index += 1) void places.take(ANA, ACME);

    expect(await places.take(ANA, ACME)).toEqual({ isTaken: false, retryAfterSeconds: 1 });
    expect(places.count(ANA, ACME)).toEqual({ holding: 4, waiting: 100 });
  });

  it("count per person and per organization: Ana's in Acme take nothing of hers in Globex or Ben's in Acme", async () => {
    const places = createCopyPlaces({ inFlight: 1 });
    await places.take(ANA, ACME);
    expect((await places.take(ANA, "globex")).isTaken).toBe(true);
    expect((await places.take("ben", ACME)).isTaken).toBe(true);
    expect(places.count(ANA, ACME)).toEqual({ holding: 1, waiting: 0 });
  });

  it("release once: a second release frees nothing more", async () => {
    const places = createCopyPlaces({ inFlight: 2 });
    const release = releaseOf(await places.take(ANA, ACME));
    await places.take(ANA, ACME);
    release();
    release();
    expect(places.count(ANA, ACME)).toEqual({ holding: 1, waiting: 0 });
  });

  it("forget a person and organization once every place is released, handed-on ones included, and keep them while any is held", async () => {
    const places = createCopyPlaces({ inFlight: 1 });
    expect(places.keyCount()).toBe(0);
    const anaInAcme = releaseOf(await places.take(ANA, ACME));
    const waiting = places.take(ANA, ACME);
    const anaInGlobex = releaseOf(await places.take(ANA, "globex"));
    const benInAcme = releaseOf(await places.take("ben", ACME));
    expect(places.keyCount()).toBe(3);

    anaInGlobex();
    benInAcme();
    expect(places.keyCount()).toBe(1);

    // Handed on to the waiting request: still held, so still kept.
    anaInAcme();
    const handedOn = releaseOf(await waiting);
    expect(places.keyCount()).toBe(1);

    handedOn();
    expect(places.keyCount()).toBe(0);
    // A second release changes nothing.
    handedOn();
    expect(places.keyCount()).toBe(0);
  });

  it("forget them after a refusal beyond the waiting maximum, once the holder releases", async () => {
    const places = createCopyPlaces({ inFlight: 1, waiting: 0 });
    const held = releaseOf(await places.take(ANA, ACME));
    expect((await places.take(ANA, ACME)).isTaken).toBe(false);
    expect(places.keyCount()).toBe(1);
    held();
    expect(places.keyCount()).toBe(0);
  });
});
