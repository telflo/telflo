import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeStdin } from "../tests/run-cli.js";
import { CANNOT_READ_MESSAGE, readInput } from "./input.js";
import { ExitError, setIo } from "./output.js";

afterEach(() => setIo());

describe("readInput", () => {
  it("reads a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telflo-input-"));
    try {
      writeFileSync(join(dir, "c.yaml"), "receivers: {}\n");
      expect(await readInput(join(dir, "c.yaml"))).toBe("receivers: {}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads all of stdin for -", async () => {
    const stdin = fakeStdin();
    setIo({ stdin });
    stdin.write("line one\n");
    stdin.write(Buffer.from("line two\n"));
    stdin.end();
    expect(await readInput("-")).toBe("line one\nline two\n");
  });

  it("reads a stdin that yields strings", async () => {
    const stdin = fakeStdin();
    stdin.setEncoding("utf8");
    setIo({ stdin });
    stdin.end("text");
    expect(await readInput("-")).toBe("text");
  });

  it("exits 2 for a file it can't read", async () => {
    const missing = join(tmpdir(), "telflo-input-missing", "nope.yaml");
    const error = await readInput(missing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).exitCode).toBe(2);
    expect((error as ExitError).message).toBe(CANNOT_READ_MESSAGE(missing));
  });
});
