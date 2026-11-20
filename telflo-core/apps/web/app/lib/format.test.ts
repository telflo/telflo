import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDateTimeToTheSecond, formatRelativeFuture, formatRelativeTime } from "./format.js";

describe("formatDate", () => {
  it("writes a YYYY-MM-DD date out in en-US, on that calendar day", () => {
    expect(formatDate("2026-08-10")).toBe("August 10, 2026");
    expect(formatDate("2026-02-01")).toBe("February 1, 2026");
  });
});

describe("formatDateTime", () => {
  it("writes a timestamp out in en-US, in the local time zone: short month, day, year, hour and minutes", () => {
    // Built from local parts, so the expectation holds in any time zone.
    const local = new Date(2026, 9, 9, 7, 58, 30);
    expect(formatDateTime(local.toISOString())).toBe("Oct 9, 2026, 7:58 AM");
    expect(formatDateTime(new Date(2026, 0, 1, 15, 4).toISOString())).toBe("Jan 1, 2026, 3:04 PM");
  });

  it("is '—' for none, or for a string that isn't a time", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not a time")).toBe("—");
  });
});

describe("formatDateTimeToTheSecond", () => {
  it("writes a timestamp out as formatDateTime does, with its seconds: two times in one minute read apart", () => {
    expect(formatDateTimeToTheSecond(new Date(2026, 9, 9, 7, 58, 30).toISOString())).toBe("Oct 9, 2026, 7:58:30 AM");
    expect(formatDateTimeToTheSecond(new Date(2026, 9, 9, 7, 58, 5).toISOString())).toBe("Oct 9, 2026, 7:58:05 AM");
    expect(formatDateTimeToTheSecond(new Date(2026, 0, 1, 15, 4).toISOString())).toBe("Jan 1, 2026, 3:04:00 PM");
  });

  it("is '—' for none, or for a string that isn't a time", () => {
    expect(formatDateTimeToTheSecond(null)).toBe("—");
    expect(formatDateTimeToTheSecond("")).toBe("—");
    expect(formatDateTimeToTheSecond("not a time")).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const NOW = Date.parse("2026-10-14T12:00:00.000Z");
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  /** The time `milliseconds` before NOW, as the API writes times. */
  const ago = (milliseconds: number) => new Date(NOW - milliseconds).toISOString();

  it.each([
    ["now itself", 0, "0 seconds ago"],
    ["under a second", 999, "0 seconds ago"],
    ["a second", SECOND, "1 second ago"],
    ["just under a minute", MINUTE - 1, "59 seconds ago"],
    ["a minute", MINUTE, "1 minute ago"],
    ["just under two minutes", 2 * MINUTE - 1, "1 minute ago"],
    ["just under an hour", HOUR - 1, "59 minutes ago"],
    ["an hour", HOUR, "1 hour ago"],
    ["just under a day", DAY - 1, "23 hours ago"],
    ["a day", DAY, "1 day ago"],
    ["just under 30 days", 30 * DAY - 1, "29 days ago"],
    ["30 days", 30 * DAY, "1 month ago"],
    ["just under 60 days", 60 * DAY - 1, "1 month ago"],
    ["60 days", 60 * DAY, "2 months ago"],
    ["330 days", 330 * DAY, "11 months ago"],
    ["360 days (12 months of 30, held at 11)", 360 * DAY, "11 months ago"],
    ["just under 365 days", 365 * DAY - 1, "11 months ago"],
    ["365 days", 365 * DAY, "1 year ago"],
    ["just under 730 days", 730 * DAY - 1, "1 year ago"],
    ["730 days", 730 * DAY, "2 years ago"],
  ])("%s: %s", (_name, milliseconds, words) => {
    expect(formatRelativeTime(ago(milliseconds), NOW)).toBe(words);
  });

  it("reads a time after now (a clock behind the server's) as 0 seconds ago, never 'in N seconds'", () => {
    expect(formatRelativeTime(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe("0 seconds ago");
  });

  it("reads an offset time by its instant", () => {
    expect(formatRelativeTime("2026-10-14T13:55:00+02:00", NOW)).toBe("5 minutes ago");
  });

  it("is '—' for none, or for a string that isn't a time", () => {
    expect(formatRelativeTime(null, NOW)).toBe("—");
    expect(formatRelativeTime("", NOW)).toBe("—");
    expect(formatRelativeTime("not a time", NOW)).toBe("—");
  });
});

describe("formatRelativeFuture", () => {
  const NOW = Date.parse("2026-10-14T12:00:00.000Z");
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  /** The time `milliseconds` after NOW, as the API writes times. */
  const after = (milliseconds: number) => new Date(NOW + milliseconds).toISOString();

  it.each([
    ["now itself", 0, "in 0 seconds"],
    ["under a second", 999, "in 0 seconds"],
    ["a second", SECOND, "in 1 second"],
    ["just under a minute", MINUTE - 1, "in 59 seconds"],
    ["a minute", MINUTE, "in 1 minute"],
    ["just under an hour", HOUR - 1, "in 59 minutes"],
    ["an hour", HOUR, "in 1 hour"],
    ["just under a day", DAY - 1, "in 23 hours"],
    ["a day", DAY, "in 1 day"],
    ["5 days and an hour (the banner's story)", 5 * DAY + HOUR, "in 5 days"],
    ["just under 6 days", 6 * DAY - 1, "in 5 days"],
    ["just under 30 days", 30 * DAY - 1, "in 29 days"],
    ["30 days", 30 * DAY, "in 1 month"],
    ["360 days (12 months of 30, held at 11)", 360 * DAY, "in 11 months"],
    ["365 days", 365 * DAY, "in 1 year"],
    ["730 days", 730 * DAY, "in 2 years"],
  ])("%s: %s", (_name, milliseconds, words) => {
    expect(formatRelativeFuture(after(milliseconds), NOW)).toBe(words);
  });

  it("reads a time before now (a clock ahead of the server's) as in 0 seconds, never 'N seconds ago'", () => {
    expect(formatRelativeFuture(new Date(NOW - 5 * MINUTE).toISOString(), NOW)).toBe("in 0 seconds");
  });

  it("is '—' for none, or for a string that isn't a time", () => {
    expect(formatRelativeFuture(null, NOW)).toBe("—");
    expect(formatRelativeFuture("", NOW)).toBe("—");
    expect(formatRelativeFuture("not a time", NOW)).toBe("—");
  });
});
