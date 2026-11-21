import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";

describe("the product-admin lists' cursor", () => {
  it("round-trips a position to the millisecond, the id lowercased", () => {
    const position = { createdAt: new Date("2026-10-26T10:00:00.123Z"), id: ID };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    const upper = Buffer.from(JSON.stringify({ createdAt: "2026-10-26T10:00:00.123Z", id: ID.toUpperCase() })).toString("base64url");
    expect(decodeCursor(upper)).toEqual(position);
    expect(/^[A-Za-z0-9_-]+$/.test(encodeCursor(position))).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["outside the alphabet", "abc=="],
    ["not JSON", Buffer.from("nope").toString("base64url")],
    ["an array", Buffer.from("[]").toString("base64url")],
    ["null", Buffer.from("null").toString("base64url")],
    ["no id", Buffer.from(JSON.stringify({ createdAt: "2026-10-26T10:00:00.000Z" })).toString("base64url")],
    ["a loose date", Buffer.from(JSON.stringify({ createdAt: "2026-10-26", id: ID })).toString("base64url")],
    ["an id that isn't a uuid", Buffer.from(JSON.stringify({ createdAt: "2026-10-26T10:00:00.000Z", id: "x" })).toString("base64url")],
    ["a number", Buffer.from(JSON.stringify({ createdAt: 1, id: ID })).toString("base64url")],
  ])("refuses a cursor %s with 400 invalid_request", (_label, text) => {
    expect(() => decodeCursor(text)).toThrow(expect.objectContaining({ code: "invalid_request", statusCode: 400 }));
  });
});
