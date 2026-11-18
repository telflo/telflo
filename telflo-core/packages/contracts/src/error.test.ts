import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "./error.js";

describe("ErrorResponseSchema", () => {
  it("accepts a minimal envelope", () => {
    expect(
      ErrorResponseSchema.safeParse({ error: { code: "invalid_request", message: "Bad." } })
        .success,
    ).toBe(true);
  });

  it("accepts an envelope with details", () => {
    expect(
      ErrorResponseSchema.safeParse({
        error: { code: "invalid_request", message: "Bad.", details: { field: "email" } },
      }).success,
    ).toBe(true);
  });

  it("rejects an envelope missing message", () => {
    expect(
      ErrorResponseSchema.safeParse({ error: { code: "invalid_request" } }).success,
    ).toBe(false);
  });

  it("rejects unknown properties at the top level", () => {
    expect(
      ErrorResponseSchema.safeParse({
        error: { code: "invalid_request", message: "Bad." },
        status: 400,
      }).success,
    ).toBe(false);
  });
});
