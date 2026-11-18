import { describe, expect, it } from "vitest";

import { collectorReadsAsOther } from "./collector-scalars.js";

/*
 * Which plain scalars the collector's yaml.v3 (go.yaml.in/yaml/v3 v3.0.5,
 * resolve.go) reads as something other than a string (D9c Rulings 69 and
 * 77). Each case below is what a decode with v3.0.5 gives (the review's
 * probe over 145,897 strings found no string this misses after Ruling 77).
 */

describe("collectorReadsAsOther (Rulings 69 and 77)", () => {
  it.each([
    // Integers: underscores, bases, signs (resolve.go:191-258).
    "1_000",
    "0b101",
    "-0x1F",
    "0o17",
    "0750",
    "+1",
    // A sign after 0b or 0o, which ParseInt reads (resolve.go:234, :246).
    "0b-1",
    "0b+1",
    "0o-7",
    "0o+7",
    "0o-0",
    // Floats, and after a `.`, underscores between digits (strconv.ParseFloat; resolve.go:173-178).
    "1.",
    "1e3",
    ".5",
    ".5_0",
    ".5e1_0",
    ".72_3",
    // Timestamps, with a comma before the fraction, and a run of spaces before the time (time.Parse).
    "2024-01-01",
    "2001-12-14t21:59:43.10-05:00",
    "2024-01-01T01:02:03,5Z",
    "2024-01-01 01:02:03,5",
    "2024-1-1  1:2:3.5",
    // The fixed spellings (resolve.go:47-66).
    "True",
    "~",
    ".inf",
    "<<",
  ])("%s is another type to the collector", (text) => {
    expect(collectorReadsAsOther(text)).toBe(true);
  });

  it.each(["yes", "on", "12:30:00", "0.0.0.0:4317", "10s", "127.0.0.1", "0B-1", "0O+7", "-0b-1", "._5", ".5__0", "1:2", "_1", "abc"])(
    "%s is a string to the collector",
    (text) => {
      expect(collectorReadsAsOther(text)).toBe(false);
    },
  );
});
