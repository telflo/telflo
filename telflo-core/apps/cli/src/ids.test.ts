import { describe, expect, it } from "vitest";
import { canonicalIdOf, requireId } from "./ids.js";
import { ExitError } from "./output.js";

/* canonicalIdOf: the API's semantics. */

const ID = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";

describe("canonicalIdOf", () => {
  it("lowercases a canonical hyphenated uuid", () => {
    expect(canonicalIdOf(ID)).toBe(ID);
    expect(canonicalIdOf(ID.toUpperCase())).toBe(ID);
  });

  it.each([`{${ID}}`, ID.replaceAll("-", ""), ` ${ID}`, `${ID}x`, "not-a-uuid", "", `urn:uuid:${ID}`])(
    "answers undefined for %j, as the API's does",
    (input) => {
      expect(canonicalIdOf(input)).toBeUndefined();
    },
  );
});

describe("requireId", () => {
  it("trims and canonicalizes, or exits 2 naming the field, not the text", () => {
    expect(requireId(` ${ID.toUpperCase()} `, "organization")).toBe(ID);
    try {
      requireId("tf_not-an-id", "organization");
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ExitError);
      expect((error as ExitError).exitCode).toBe(2);
      expect((error as ExitError).message).toBe("The organization must be an id (a UUID).");
    }
  });
});
