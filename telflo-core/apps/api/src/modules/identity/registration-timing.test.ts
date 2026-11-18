import { describe, expect, it } from "vitest";
import { createRegistrationTiming } from "./registration-timing.js";

describe("registration timing", () => {
  it("returns the fallback before anything is recorded", () => {
    const timing = createRegistrationTiming({ capacity: 4, fallbackMilliseconds: 10 });
    expect(timing.sample()).toBe(10);
  });

  it("samples only from recorded observations once there are any", () => {
    const timing = createRegistrationTiming({ capacity: 4, fallbackMilliseconds: 10 });
    timing.record(21);
    timing.record(23);
    const samples = new Set(Array.from({ length: 200 }, () => timing.sample()));
    expect([...samples].sort()).toEqual([21, 23]);
  });

  it("picks the observation the random draw points at", () => {
    const draws = [0, 0.5, 0.99];
    const timing = createRegistrationTiming({
      capacity: 4,
      fallbackMilliseconds: 10,
      random: () => draws.shift()!,
    });
    timing.record(1);
    timing.record(2);
    timing.record(3);
    expect([timing.sample(), timing.sample(), timing.sample()]).toEqual([1, 2, 3]);
  });

  it("keeps only the most recent observations, up to its capacity", () => {
    const timing = createRegistrationTiming({ capacity: 2, fallbackMilliseconds: 10 });
    timing.record(1);
    timing.record(2);
    timing.record(3);
    timing.record(4);
    const samples = new Set(Array.from({ length: 200 }, () => timing.sample()));
    expect([...samples].sort()).toEqual([3, 4]);
  });
});
