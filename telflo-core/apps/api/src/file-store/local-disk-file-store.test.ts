import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeFileStoreContract } from "../testing/file-store-contract.js";
import { createFileStore } from "./create-file-store.js";
import {
  FileStoreError,
  FileTooLargeError,
  UnsafeFilePathError,
  type FileKey,
  type IFileStore,
} from "./file-store.js";
import { createLocalDiskFileStore } from "./local-disk-file-store.js";

// Every call into node:fs/promises, from these tests and from the store,
// is counted, so a test can show that a refused key reached no filesystem
// call at all (each id is checked first). The contract suite reads it as the
// store's backend calls.
const filesystem = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const counted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    counted[name] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            filesystem.calls += 1;
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return { ...counted, default: counted };
});

const ORGANIZATION_A = "0190f5c2-7d1a-7c4e-8a3b-1f2e3d4c5b6a";
const ORGANIZATION_B = "0190f5c2-7d1a-7c4e-8a3b-1f2e3d4c5b6b";
const USER = "0190f5c2-7d1a-7c4e-8a3b-2f2e3d4c5b6a";
const OTHER_USER = "0190f5c2-7d1a-7c4e-8a3b-2f2e3d4c5b6b";
const FILE = "0190f5c2-7d1a-7c4e-8a3b-3f2e3d4c5b6a";
const RUN = "0190f5c2-7d1a-7c4e-8a3b-4f2e3d4c5b6a";
const TEMPLATE = "0190f5c2-7d1a-7c4e-8a3b-5f2e3d4c5b6a";
const DEFINITION_INPUT = "0190f5c2-7d1a-7c4e-8a3b-6f2e3d4c5b6a";
const LOGO = "0190f5c2-7d1a-7c4e-8a3b-7f2e3d4c5b6a";
const LIBRARY_FILE = "0190f5c2-7d1a-7c4e-8a3b-8f2e3d4c5b6a";

const MAX = 1024 * 1024;

function testInput(organizationId = ORGANIZATION_A, userId = USER, fileId = FILE): FileKey {
  return { kind: "test-input", organizationId, userId, fileId };
}

function testRun(name: "input" | "output" | "decoded-input", organizationId = ORGANIZATION_A, runId = RUN): FileKey {
  return { kind: "test-run", organizationId, runId, name };
}

function definitionInput(organizationId = ORGANIZATION_A, inputId = DEFINITION_INPUT): FileKey {
  return { kind: "test-definition-input", organizationId, inputId };
}

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

/** Every entry under `directory` that isn't a directory, relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
}

async function readAll(store: IFileStore, key: FileKey): Promise<string | undefined> {
  const result = await store.read(key);
  return result.found ? text(result.stream) : undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const NEVER = new Promise<never>(() => {});

// The cases every store passes, each on a fresh, empty temporary root.
describeFileStoreContract("LocalDiskFileStore", async () => {
  const fresh = await realpath(await mkdtemp(join(tmpdir(), "telflo-file-store-contract-")));
  return {
    store: await createLocalDiskFileStore(fresh),
    cleanUp: () => rm(fresh, { recursive: true, force: true }),
    countBackendCalls: () => filesystem.calls,
  };
});

// The disk's own cases: where files land, their modes, links, the FIFO,
// the filesystem's failures, the temporary file and the root's checks.

let temporaries: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "telflo-file-store-test-"));
  temporaries.push(directory);
  return directory;
}

let root: string;
let store: IFileStore;

async function useTemporaryRoot(): Promise<void> {
  temporaries = [];
  root = await realpath(await temporaryDirectory());
  store = await createLocalDiskFileStore(root);
}

async function removeTemporaries(): Promise<void> {
  for (const directory of temporaries) {
    await chmod(directory, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

describe("LocalDiskFileStore, on the disk", () => {
  beforeEach(useTemporaryRoot);
  afterEach(removeTemporaries);

  describe("every kind of key at its place under the root", () => {
    const cases: [string, FileKey, string][] = [
      [
        "a person's test input",
        testInput(),
        `organizations/${ORGANIZATION_A}/users/${USER}/test-inputs/${FILE}`,
      ],
      ["a run's input", testRun("input"), `organizations/${ORGANIZATION_A}/test-runs/${RUN}/input`],
      ["a run's output", testRun("output"), `organizations/${ORGANIZATION_A}/test-runs/${RUN}/output`],
      [
        "a run's decoded input",
        testRun("decoded-input"),
        `organizations/${ORGANIZATION_A}/test-runs/${RUN}/decoded-input`,
      ],
      ["a test template", { kind: "test-template", templateId: TEMPLATE }, `global/test-templates/${TEMPLATE}`],
      [
        "a test definition's input",
        definitionInput(),
        `organizations/${ORGANIZATION_A}/test-definition-inputs/${DEFINITION_INPUT}`,
      ],
      [
        "an organization's logo",
        { kind: "organization-logo", organizationId: ORGANIZATION_A, logoId: LOGO },
        `organizations/${ORGANIZATION_A}/logos/${LOGO}`,
      ],
      [
        "a library file",
        { kind: "library-file", fileId: LIBRARY_FILE },
        `global/library-files/${LIBRARY_FILE}`,
      ],
    ];

    it.each(cases)("writes %s at its place under the root, mode 0600, and removes it from there", async (_name, key, path) => {
      const content = '{"resourceLogs":[]}\n';
      await store.write(key, chunks('{"resourceLogs"', ":[]}\n"), { maxBytes: MAX });

      expect(await filesUnder(root)).toEqual([path]);
      expect(await readFile(join(root, path), "utf8")).toBe(content);
      expect((await stat(join(root, path))).mode & 0o777).toBe(0o600);

      await store.remove(key);
      expect(await filesUnder(root)).toEqual([]);
    });

    it("keeps a Readable's bytes exactly on the disk", async () => {
      const bytes = Uint8Array.from([0, 255, 0xef, 0xbb, 0xbf, 10, 13]);
      await store.write(testInput(), Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), { maxBytes: MAX });
      expect(new Uint8Array(await readFile(join(root, (await filesUnder(root))[0]!)))).toEqual(bytes);
    });

    it("copies to the destination's place, beside its source", async () => {
      await store.write(testInput(), chunks("line one\nline two\n"), { maxBytes: MAX });
      await store.copy(testInput(), testRun("input"));
      expect(await filesUnder(root)).toEqual(
        [
          `organizations/${ORGANIZATION_A}/test-runs/${RUN}/input`,
          `organizations/${ORGANIZATION_A}/users/${USER}/test-inputs/${FILE}`,
        ].sort(),
      );
    });

    it("a copy whose source has no file creates nothing on the disk", async () => {
      await store.copy(testInput(), testRun("input"));
      expect(await filesUnder(root)).toEqual([]);
    });

    it("a remove for a key with no file creates no directory", async () => {
      await store.remove(testInput());
      await store.remove(testRun("decoded-input"));
      await store.remove({ kind: "test-template", templateId: TEMPLATE });
      await store.remove(definitionInput());
      expect(await readdir(root)).toEqual([]);
    });
  });

  describe("the temporary file", () => {
    it("an abort while the source is waiting: the first part sits in a temporary file in the key's own directory, and none is left after", async () => {
      const controller = new AbortController();
      const waiting = deferred();
      async function* stalled(): AsyncIterable<Uint8Array> {
        yield Buffer.from("the first part");
        waiting.resolve();
        await NEVER;
      }

      const write = store.write(testInput(), stalled(), { maxBytes: MAX, signal: controller.signal });
      await waiting.promise;
      // The first part sits in a temporary file in the key's own directory.
      const during = await filesUnder(root);
      expect(during).toHaveLength(1);
      expect(during[0]).toMatch(new RegExp(`^organizations/${ORGANIZATION_A}/users/${USER}/test-inputs/\\.`));

      controller.abort();
      await expect(write).rejects.toMatchObject({ name: "AbortError" });
      expect(await filesUnder(root)).toEqual([]);
    });

    const KEPT = `organizations/${ORGANIZATION_A}/users/${USER}/test-inputs/${FILE}`;

    /** A write over a file already at the key (or none), and what the disk holds after it. */
    const WRITES: [string, (store: IFileStore) => Promise<void>, string[]][] = [
      [
        "a replaced file",
        async (s) => {
          await s.write(testInput(), chunks("first"), { maxBytes: MAX });
          await s.write(testInput(), chunks("second"), { maxBytes: MAX });
        },
        [KEPT],
      ],
      [
        "an abort of a Readable source, over a file already at the key",
        async (s) => {
          await s.write(testInput(), chunks("kept"), { maxBytes: MAX });
          const controller = new AbortController();
          const waiting = deferred();
          let reads = 0;
          const source = new Readable({
            read() {
              reads += 1;
              if (reads === 1) this.push(Buffer.from("replacement"));
              else waiting.resolve();
            },
          });
          const write = s.write(testInput(), source, { maxBytes: MAX, signal: controller.signal });
          await waiting.promise;
          controller.abort();
          await expect(write).rejects.toMatchObject({ name: "AbortError" });
        },
        [KEPT],
      ],
      [
        "a signal aborted already",
        async (s) => {
          await expect(
            s.write(testInput(), chunks("x"), { maxBytes: MAX, signal: AbortSignal.abort() }),
          ).rejects.toMatchObject({ name: "AbortError" });
        },
        [],
      ],
      [
        "a source that fails",
        async (s) => {
          async function* failing(): AsyncIterable<Uint8Array> {
            yield Buffer.from("part");
            throw new Error("the upload broke off");
          }
          await expect(s.write(testRun("input"), failing(), { maxBytes: MAX })).rejects.toThrow("the upload broke off");
        },
        [],
      ],
      [
        "a source that yields something other than bytes",
        async (s) => {
          const strings = (async function* () {
            yield "text" as unknown as Uint8Array;
          })();
          await expect(s.write(testRun("input"), strings, { maxBytes: MAX })).rejects.toThrow(TypeError);
        },
        [],
      ],
      [
        "one byte more than maxBytes",
        async (s) => {
          const source = Readable.from([Buffer.from("123456"), Buffer.from("78901"), Buffer.from("never read")]);
          await expect(s.write(testInput(), source, { maxBytes: 10 })).rejects.toBeInstanceOf(FileTooLargeError);
        },
        [],
      ],
      [
        "too large an overwrite",
        async (s) => {
          await s.write(testInput(), chunks("kept"), { maxBytes: 10 });
          await expect(s.write(testInput(), chunks("far too long"), { maxBytes: 10 })).rejects.toBeInstanceOf(
            FileTooLargeError,
          );
        },
        [KEPT],
      ],
      ...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(
        (maxBytes): [string, (store: IFileStore) => Promise<void>, string[]] => [
          `maxBytes ${maxBytes}`,
          async (s) => {
            await expect(s.write(testInput(), chunks("x"), { maxBytes })).rejects.toThrow(RangeError);
          },
          [],
        ],
      ),
    ];

    it.each(WRITES)("%s leaves no temporary file behind", async (_name, writes, expected) => {
      await writes(store);
      expect(await filesUnder(root)).toEqual(expected);
    });
  });

  describe("isolation on the disk", () => {
    it("two organizations' keys never share a directory, even with the same person and ids", async () => {
      for (const organization of [ORGANIZATION_A, ORGANIZATION_B]) {
        await store.write(testInput(organization), chunks(`${organization} input`), { maxBytes: MAX });
        await store.write(testRun("input", organization), chunks(`${organization} run input`), { maxBytes: MAX });
        await store.write(testRun("output", organization), chunks(`${organization} run output`), {
          maxBytes: MAX,
        });
      }

      const files = await filesUnder(root);
      expect(files).toHaveLength(6);
      const directoriesOf = (organization: string): Set<string> =>
        new Set(
          files
            .filter((file) => file.startsWith(`organizations/${organization}/`))
            .map((file) => file.slice(0, file.lastIndexOf("/"))),
        );
      const a = directoriesOf(ORGANIZATION_A);
      const b = directoriesOf(ORGANIZATION_B);
      expect(a.size + b.size).toBe(4);
      expect([...a].filter((directory) => b.has(directory))).toEqual([]);
      // Every file is under its own organization's directory.
      expect(files.every((file) => file.startsWith(`organizations/${ORGANIZATION_A}/`) || file.startsWith(`organizations/${ORGANIZATION_B}/`))).toBe(true);
    });

    it("two organizations' definition inputs never share a directory, even with the same input id", async () => {
      for (const organization of [ORGANIZATION_A, ORGANIZATION_B]) {
        await store.write(definitionInput(organization), chunks(`${organization} definition input`), { maxBytes: MAX });
      }
      expect(await filesUnder(root)).toEqual(
        [
          `organizations/${ORGANIZATION_A}/test-definition-inputs/${DEFINITION_INPUT}`,
          `organizations/${ORGANIZATION_B}/test-definition-inputs/${DEFINITION_INPUT}`,
        ].sort(),
      );
    });

    it("two people's files in one organization sit in separate directories", async () => {
      await store.write(testInput(ORGANIZATION_A, USER), chunks("mine"), { maxBytes: MAX });
      await store.write(testInput(ORGANIZATION_A, OTHER_USER), chunks("theirs"), { maxBytes: MAX });
      expect(await filesUnder(root)).toEqual(
        [
          `organizations/${ORGANIZATION_A}/users/${OTHER_USER}/test-inputs/${FILE}`,
          `organizations/${ORGANIZATION_A}/users/${USER}/test-inputs/${FILE}`,
        ].sort(),
      );
    });
  });

  describe("a symbolic link inside the root that points out of it is refused", () => {
    let outside: string;

    beforeEach(async () => {
      outside = await realpath(await temporaryDirectory());
    });

    it("an organization's directory linked out: nothing is written, read or removed through it", async () => {
      await mkdir(join(root, "organizations"));
      await symlink(outside, join(root, "organizations", ORGANIZATION_A));

      await expect(store.write(testInput(), chunks("escaped"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      await expect(store.write(testRun("output"), chunks("escaped"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      // Not even a directory was created through the link.
      expect(await readdir(outside)).toEqual([]);

      // A file waiting outside, where the key's path would lead through the link.
      await mkdir(join(outside, "users", USER, "test-inputs"), { recursive: true });
      await writeFile(join(outside, "users", USER, "test-inputs", FILE), "outside the root");
      await expect(store.read(testInput())).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.copy(testInput(), testRun("input", ORGANIZATION_B))).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      await expect(store.remove(testInput())).rejects.toBeInstanceOf(UnsafeFilePathError);
      expect(await readFile(join(outside, "users", USER, "test-inputs", FILE), "utf8")).toBe("outside the root");
      expect(await filesUnder(root)).toEqual([`organizations/${ORGANIZATION_A}`]);
    });

    it("a deeper directory linked out (a person's test-inputs)", async () => {
      const users = join(root, "organizations", ORGANIZATION_A, "users", USER);
      await mkdir(users, { recursive: true });
      await symlink(outside, join(users, "test-inputs"));
      await writeFile(join(outside, FILE), "outside the root");

      await expect(store.write(testInput(), chunks("escaped"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      await expect(store.read(testInput())).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.remove(testInput())).rejects.toBeInstanceOf(UnsafeFilePathError);
      expect(await readdir(outside)).toEqual([FILE]);
      expect(await readFile(join(outside, FILE), "utf8")).toBe("outside the root");
    });

    it("a link to a directory elsewhere inside the root is refused too", async () => {
      await store.write(testRun("input", ORGANIZATION_B), chunks("organization B's"), { maxBytes: MAX });
      await symlink(join(root, "organizations", ORGANIZATION_B), join(root, "organizations", ORGANIZATION_A));
      await expect(store.read(testRun("input"))).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.write(testRun("input"), chunks("x"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      expect(await readAll(store, testRun("input", ORGANIZATION_B))).toBe("organization B's");
    });

    it("a file linked out: not read, not copied, not written through", async () => {
      const target = join(outside, "secret");
      await writeFile(target, "outside the root");
      await store.write(testInput(), chunks("placeholder"), { maxBytes: MAX });
      const file = join(root, "organizations", ORGANIZATION_A, "users", USER, "test-inputs", FILE);
      await rm(file);
      await symlink(target, file);

      await expect(store.read(testInput())).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.copy(testInput(), testRun("input"))).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.write(testInput(), chunks("overwritten"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      expect(await readFile(target, "utf8")).toBe("outside the root");
      // The refused write left no temporary file; the link is still a link.
      expect(await filesUnder(root)).toEqual([
        `organizations/${ORGANIZATION_A}/users/${USER}/test-inputs/${FILE}`,
      ]);
      expect((await lstat(file)).isSymbolicLink()).toBe(true);
      // Removing it removes the link, never its target.
      await store.remove(testInput());
      expect(await readFile(target, "utf8")).toBe("outside the root");
      expect(await filesUnder(root)).toEqual([]);
    });
  });

  describe("a FIFO at a key's path", () => {
    it("is never opened for reading (which would block), copied or written over, and remove takes it away", async () => {
      const directory = join(root, "organizations", ORGANIZATION_A, "test-runs", RUN);
      await mkdir(directory, { recursive: true });
      const fifo = join(directory, "input");
      execFileSync("mkfifo", [fifo]);

      await expect(store.read(testRun("input"))).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.copy(testRun("input"), testRun("output"))).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.write(testRun("input"), chunks("x"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      expect((await lstat(fifo)).isFIFO()).toBe(true);
      expect(await filesUnder(root)).toEqual([`organizations/${ORGANIZATION_A}/test-runs/${RUN}/input`]);

      await store.remove(testRun("input"));
      expect(await filesUnder(root)).toEqual([]);
    });
  });

  describe("a filesystem failure the store doesn't handle carries no path or id", () => {
    /**
     * A FileStoreError keeping the call's code and syscall, and nothing that
     * names the root, a key's ids or any path: not in its message, its
     * properties, its stack or a cause.
     */
    function expectWithoutPath(error: unknown, code: string | string[], syscall: string): void {
      expect(error).toBeInstanceOf(FileStoreError);
      const failure = error as FileStoreError;
      expect([code].flat()).toContain(failure.code);
      expect(failure.syscall).toBe(syscall);
      expect(failure).not.toHaveProperty("path");
      expect(failure).not.toHaveProperty("dest");
      expect(failure).not.toHaveProperty("cause");
      const shown = [failure.message, inspect(failure), JSON.stringify(failure), failure.stack ?? ""].join("\n");
      for (const leak of [root, ORGANIZATION_A, RUN, USER, FILE, "test-runs", "organizations"]) {
        expect(shown).not.toContain(leak);
      }
    }

    it("a run's directory the API can't write (0500): the write and the remove fail as EACCES, with no path", async () => {
      // Assumes the tests don't run as root, which ignores the mode.
      await store.write(testRun("input"), chunks("kept"), { maxBytes: MAX });
      const directory = join(root, "organizations", ORGANIZATION_A, "test-runs", RUN);
      await chmod(directory, 0o500);
      try {
        expectWithoutPath(
          await store.write(testRun("output"), chunks("x"), { maxBytes: MAX }).catch((error: unknown) => error),
          "EACCES",
          "open",
        );
        expectWithoutPath(await store.remove(testRun("input")).catch((error: unknown) => error), "EACCES", "unlink");
        expectWithoutPath(
          await store.copy(testRun("input"), testRun("decoded-input")).catch((error: unknown) => error),
          "EACCES",
          "open",
        );
      } finally {
        await chmod(directory, 0o700);
      }
      expect(await readAll(store, testRun("input"))).toBe("kept");
      expect(await filesUnder(root)).toEqual([`organizations/${ORGANIZATION_A}/test-runs/${RUN}/input`]);
    });

    it("a regular file where a directory of the key's path should be: reads and removes fail as ENOTDIR, with no path", async () => {
      await mkdir(join(root, "organizations", ORGANIZATION_A), { recursive: true });
      await writeFile(join(root, "organizations", ORGANIZATION_A, "test-runs"), "not a directory");

      expectWithoutPath(await store.read(testRun("input")).catch((error: unknown) => error), "ENOTDIR", "realpath");
      expectWithoutPath(await store.remove(testRun("output")).catch((error: unknown) => error), "ENOTDIR", "realpath");
      expectWithoutPath(
        await store.copy(testRun("input"), testInput()).catch((error: unknown) => error),
        "ENOTDIR",
        "realpath",
      );
      // A write refuses it before any such call: it isn't a directory.
      await expect(store.write(testRun("input"), chunks("x"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      expect(await readFile(join(root, "organizations", ORGANIZATION_A, "test-runs"), "utf8")).toBe("not a directory");
    });

    it("a directory at the key's own path: read and write refuse it, and remove fails with no path", async () => {
      const path = join(root, "organizations", ORGANIZATION_A, "test-runs", RUN, "output");
      await mkdir(path, { recursive: true });

      await expect(store.read(testRun("output"))).rejects.toBeInstanceOf(UnsafeFilePathError);
      await expect(store.write(testRun("output"), chunks("x"), { maxBytes: MAX })).rejects.toBeInstanceOf(
        UnsafeFilePathError,
      );
      // unlink(2) on a directory: EPERM on macOS, EISDIR on Linux.
      expectWithoutPath(await store.remove(testRun("output")).catch((error: unknown) => error), ["EPERM", "EISDIR"], "unlink");
      expect((await stat(path)).isDirectory()).toBe(true);
    });
  });
});

describe("createLocalDiskFileStore, as the API starts", () => {
  beforeEach(useTemporaryRoot);
  afterEach(removeTemporaries);

  it("refuses a relative root", async () => {
    await expect(createLocalDiskFileStore("file-store")).rejects.toThrow(
      "The file store's root (TELFLO_FILE_STORE_ROOT) must be an absolute path, received: file-store",
    );
  });

  it("refuses a root that doesn't exist", async () => {
    const missing = join(root, "missing");
    await expect(createLocalDiskFileStore(missing)).rejects.toThrow(
      `The file store's root (TELFLO_FILE_STORE_ROOT) does not exist: ${missing}`,
    );
  });

  it("refuses a root that is a file", async () => {
    const file = join(root, "a-file");
    await writeFile(file, "");
    await expect(createLocalDiskFileStore(file)).rejects.toThrow(
      `The file store's root (TELFLO_FILE_STORE_ROOT) is not a directory: ${file}`,
    );
  });

  it("refuses a root it can't write, leaving no probe behind", async () => {
    const readOnly = await temporaryDirectory();
    await chmod(readOnly, 0o500);
    await expect(createLocalDiskFileStore(readOnly)).rejects.toThrow(
      `The file store's root (TELFLO_FILE_STORE_ROOT) is not writable: ${readOnly}`,
    );
    await chmod(readOnly, 0o700);
    expect(await readdir(readOnly)).toEqual([]);
  });

  it("leaves a writable root as it found it", async () => {
    const fresh = await temporaryDirectory();
    await createLocalDiskFileStore(fresh);
    expect(await readdir(fresh)).toEqual([]);
  });

  it("resolves a root reached through a link once, and keeps files under the real directory", async () => {
    const real = await realpath(await temporaryDirectory());
    const link = join(root, "link-to-root");
    await symlink(real, link);
    const linked = await createLocalDiskFileStore(link);
    await linked.write(testInput(), chunks("through the link"), { maxBytes: MAX });
    expect(await filesUnder(real)).toEqual([`organizations/${ORGANIZATION_A}/users/${USER}/test-inputs/${FILE}`]);
  });

  it("createFileStore builds the local-disk store from settings, with the same checks", async () => {
    const fromSettings = await createFileStore({ kind: "local", root });
    await fromSettings.write(testRun("output"), chunks("from settings"), { maxBytes: MAX });
    expect(await readAll(store, testRun("output"))).toBe("from settings");
    await expect(createFileStore({ kind: "local", root: "/nonexistent/telflo-file-store-placeholder" })).rejects.toThrow(
      /does not exist/,
    );
  });
});
