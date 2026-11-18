import { describe, expect, it } from "vitest";
import { AppError } from "../../errors.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

const ID = "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f";
const AT = new Date("2026-09-27T12:34:56.789Z");

/** The base64url of `value` as JSON: a cursor built by hand. */
const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function expectInvalid(text: string): void {
  let caught: unknown;
  try {
    decodeCursor(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ code: "invalid_request", statusCode: 400, message: "The request was not valid." });
}

describe("encodeCursor and decodeCursor", () => {
  it("round-trip a position exactly", () => {
    const cursor = encodeCursor({ updatedAt: AT, id: ID });
    expect(decodeCursor(cursor)).toEqual({ updatedAt: AT, id: ID });
    expect(decodeCursor(cursor).updatedAt.getTime()).toBe(AT.getTime());
  });

  it("encode base64url, with nothing a URL must escape", () => {
    expect(encodeCursor({ updatedAt: AT, id: ID })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("lowercase an uppercased id, as Postgres prints a uuid", () => {
    expect(decodeCursor(cursorOf({ updatedAt: AT.toISOString(), id: ID.toUpperCase() })).id).toBe(ID);
  });

  it.each([
    ["garbage", "garbage"],
    ["an empty string", ""],
    ["characters outside base64url", "eyJ1cGRhdGVkQXQiOi!!"],
    ["standard base64's + and /", `${cursorOf({ updatedAt: AT.toISOString(), id: ID })}+/`],
    ["JSON that isn't an object", cursorOf(["2026-09-27T12:34:56.789Z", ID])],
    ["null", cursorOf(null)],
    ["a number", cursorOf(42)],
    ["a missing id", cursorOf({ updatedAt: AT.toISOString() })],
    ["a missing timestamp", cursorOf({ id: ID })],
    ["a numeric timestamp", cursorOf({ updatedAt: AT.getTime(), id: ID })],
  ])("refuse %s with 400 invalid_request", (_label, text) => {
    expectInvalid(text);
  });

  it.each([
    ["not a UUID", "42"],
    ["a UUID without hyphens", ID.replaceAll("-", "")],
    ["a UUID in braces", `{${ID}}`],
    ["a UUID with SQL after it", `${ID}' or '1'='1`],
  ])("refuse an id that is %s", (_label, id) => {
    expectInvalid(cursorOf({ updatedAt: AT.toISOString(), id }));
  });

  it.each([
    ["not a date", "yesterday"],
    ["a date alone", "2026-09-27"],
    ["no milliseconds", "2026-09-27T12:34:56Z"],
    ["an offset", "2026-09-27T14:34:56.789+02:00"],
    ["microseconds", "2026-09-27T12:34:56.789123Z"],
    ["an impossible day", "2026-02-30T00:00:00.000Z"],
    ["a date Date reads loosely", "Sep 27 2026"],
  ])("refuse a timestamp that is %s", (_label, updatedAt) => {
    expectInvalid(cursorOf({ updatedAt, id: ID }));
  });
});
