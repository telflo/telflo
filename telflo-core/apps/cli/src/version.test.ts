import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("is the package's own version (0.3.0, D27 decision 11)", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(manifest.version);
    expect(VERSION).toBe("0.3.0");
  });
});
