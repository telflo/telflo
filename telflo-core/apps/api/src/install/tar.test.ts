import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tarGz, TarNameError } from "./tar.js";

// The archive read back by the system tar (bsdtar on a Mac, GNU tar on Linux):
// extracted with -xzpf and each file stat'ed, never `tar -tv` parsed (the two
// print it differently).

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "install-tar-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function extracted(archive: Buffer): Promise<string> {
  const file = join(directory, "bundle.tar.gz");
  await writeFile(file, archive);
  const out = join(directory, "out");
  execFileSync("mkdir", ["-p", out]);
  execFileSync("tar", ["-xzpf", file, "-C", out]);
  return out;
}

describe("tarGz", () => {
  const mtime = new Date("2026-10-16T09:30:00.000Z");
  const script = "#!/bin/bash\necho hi\n";
  const long = "x".repeat(1500) + "\n";

  it("is a gzip stream of a ustar archive, owned by 0:0 with empty owner names", () => {
    const archive = tarGz([{ name: "a.txt", content: Buffer.from("A\n"), mode: 0o644 }], mtime);
    expect([archive[0], archive[1]]).toEqual([0x1f, 0x8b]);
    const tar = gunzipSync(archive);
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(257, 263).toString("latin1")).toBe("ustar\0");
    expect(tar.subarray(108, 115).toString("latin1")).toBe("0000000");
    expect(tar.subarray(116, 123).toString("latin1")).toBe("0000000");
    expect(tar.subarray(265, 329).every((byte) => byte === 0)).toBe(true);
    // The two zero blocks after one header and one content block.
    expect(tar.length).toBe(512 * 4);
  });

  it("reads back with the system tar: names at the root, contents, modes 0755 and 0644, the render's time", async () => {
    const archive = tarGz(
      [
        { name: "start_supervisor.sh", content: Buffer.from(script), mode: 0o755 },
        { name: "README.md", content: Buffer.from(long), mode: 0o644 },
        { name: "empty.yaml", content: Buffer.alloc(0), mode: 0o644 },
      ],
      mtime,
    );
    const out = await extracted(archive);
    expect(await readFile(join(out, "start_supervisor.sh"), "utf8")).toBe(script);
    expect(await readFile(join(out, "README.md"), "utf8")).toBe(long);
    expect(await readFile(join(out, "empty.yaml"), "utf8")).toBe("");
    expect(((await stat(join(out, "start_supervisor.sh"))).mode & 0o777).toString(8)).toBe("755");
    expect(((await stat(join(out, "README.md"))).mode & 0o777).toString(8)).toBe("644");
    expect((await stat(join(out, "README.md"))).mtime.getTime()).toBe(mtime.getTime());
    expect(execFileSync("ls", ["-A", out], { encoding: "utf8" }).trim().split("\n").sort()).toEqual([
      "README.md",
      "empty.yaml",
      "start_supervisor.sh",
    ]);
  });

  it("writes a name of exactly 100 bytes and refuses one of 101", async () => {
    const name = `${"n".repeat(96)}.txt`;
    const out = await extracted(tarGz([{ name, content: Buffer.from("ok"), mode: 0o644 }], mtime));
    expect(await readFile(join(out, name), "utf8")).toBe("ok");
    expect(() => tarGz([{ name: `${name}x`, content: Buffer.from("ok"), mode: 0o644 }], mtime)).toThrow(TarNameError);
  });

  it.each(["", "linux/a.sh", "../a.sh", "a\0b"])("refuses the name %j: only a file at the archive's root", (name) => {
    expect(() => tarGz([{ name, content: Buffer.from("x"), mode: 0o644 }], mtime)).toThrow(TarNameError);
  });
});
