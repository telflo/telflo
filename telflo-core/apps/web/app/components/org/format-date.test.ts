import { describe, expect, it } from "vitest";
import { formatDate } from "./format-date.js";
import { enUsDateTime } from "~/test/members.js";

describe("formatDate", () => {
  it("formats a date in en-US with the time", () => {
    expect(formatDate("2026-03-15T12:00:00.000Z")).toMatch(enUsDateTime("Mar 15, 2026"));
  });

  it("says N/A when there is no date", () => {
    expect(formatDate(null)).toBe("N/A");
    expect(formatDate("")).toBe("N/A");
  });
});
