import { afterEach, describe, expect, it, vi } from "vitest";
import { isCanonicalUuid, randomUuid } from "./ids.js";

describe("isCanonicalUuid", () => {
  it("takes a hyphenated UUID, in either case", () => {
    expect(isCanonicalUuid("0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e")).toBe(true);
    expect(isCanonicalUuid("0A1B2C3D-4E5F-4061-8728-394A5B6C7D8E")).toBe(true);
  });

  it.each([
    ["not a UUID", "not-a-uuid"],
    ["no hyphens", "0a1b2c3d4e5f40618728394a5b6c7d8e"],
    ["braces", "{0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e}"],
    ["a path around one", "../0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e"],
    ["a trailing newline", "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e\n"],
    ["nothing", ""],
  ])("refuses %s", (_name, value) => {
    expect(isCanonicalUuid(value)).toBe(false);
  });
});

/** A version 4 UUID, in its canonical, lower-case form. */
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid (D17a Preflight ruling 13)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID where the browser has it", () => {
    const randomUUID = vi.fn(() => "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e" as const);
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: vi.fn() });
    expect(randomUuid()).toBe("0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("makes a version 4 UUID from getRandomValues where randomUUID is missing (an insecure origin)", () => {
    const real = globalThis.crypto;
    const getRandomValues = vi.fn((array: Uint8Array) => real.getRandomValues(array));
    vi.stubGlobal("crypto", { getRandomValues });
    const made = new Set(Array.from({ length: 200 }, () => randomUuid()));
    expect(getRandomValues).toHaveBeenCalledTimes(200);
    expect(made.size).toBe(200);
    for (const id of made) {
      expect(id).toMatch(V4);
      expect(isCanonicalUuid(id)).toBe(true);
    }
  });

  it("sets the version and variant whatever the random bytes are", () => {
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array) => array.fill(0xff) });
    expect(randomUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array) => array.fill(0) });
    expect(randomUuid()).toBe("00000000-0000-4000-8000-000000000000");
  });
});
