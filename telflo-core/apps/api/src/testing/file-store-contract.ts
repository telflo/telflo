import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileTooLargeError,
  InvalidFileKeyError,
  type FileKey,
  type IFileStore,
} from "../file-store/file-store.js";

// The cases every file store passes (D23-1 decision 27), written against
// IFileStore alone: nothing here knows whether the store keeps its files on
// a disk or in a bucket. A store's test file calls it once, at the top:
//
//   describeFileStoreContract("LocalDiskFileStore", async () => {
//     const root = ...; // a fresh, empty place for this one test
//     return {
//       store: await createLocalDiskFileStore(root),
//       cleanUp: () => rm(root, { recursive: true, force: true }),
//       countBackendCalls: () => filesystem.calls,
//     };
//   });
//
// and keeps its own backend's cases (paths, links, objects, its errors)
// beside it. `countBackendCalls` is a running count of the calls the store
// makes to its backend (the local test's counted `node:fs/promises`; for S3
// a spy on `S3Client.prototype.send`, restored by `cleanUp`). The suite
// reads it as the difference around one method's call, so it never resets
// it.

/** What `setup` gives each test. */
export interface FileStoreUnderTest {
  /** A fresh store holding no file. */
  readonly store: IFileStore;
  /** Removes what the test left and undoes the setup (a spy restored). */
  cleanUp(): Promise<void>;
  /** How many calls the store has made to its backend so far: a running count. */
  countBackendCalls(): number;
}

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

/** Every byte value, then a UTF-8 BOM, a NUL and line endings: bytes no text decoding keeps. */
const BYTES = Uint8Array.from([...Array.from({ length: 256 }, (_, value) => value), 0xef, 0xbb, 0xbf, 0, 10, 13]);

function testInput(organizationId = ORGANIZATION_A, userId = USER, fileId = FILE): FileKey {
  return { kind: "test-input", organizationId, userId, fileId };
}

function testRun(name: "input" | "output" | "decoded-input", organizationId = ORGANIZATION_A, runId = RUN): FileKey {
  return { kind: "test-run", organizationId, runId, name };
}

function testTemplate(templateId = TEMPLATE): FileKey {
  return { kind: "test-template", templateId };
}

function definitionInput(organizationId = ORGANIZATION_A, inputId = DEFINITION_INPUT): FileKey {
  return { kind: "test-definition-input", organizationId, inputId };
}

function organizationLogo(organizationId = ORGANIZATION_A, logoId = LOGO): FileKey {
  return { kind: "organization-logo", organizationId, logoId };
}

function libraryFile(fileId = LIBRARY_FILE): FileKey {
  return { kind: "library-file", fileId };
}

/** One key of every kind, and each of a run's file names. */
const KEYS: [string, FileKey][] = [
  ["a person's test input", testInput()],
  ["a run's input", testRun("input")],
  ["a run's output", testRun("output")],
  ["a run's decoded input", testRun("decoded-input")],
  ["a test template", testTemplate()],
  ["a test definition's input (D14b detail 18)", definitionInput()],
  ["an organization's logo (D23-2 decision 30)", organizationLogo()],
  ["a library file (D23-2 decision 30)", libraryFile()],
];

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function* chunks(...parts: (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? Buffer.from(part) : part;
}

/** The key's file's bytes, or undefined when it has none. */
async function readBytes(store: IFileStore, key: FileKey): Promise<Uint8Array | undefined> {
  const result = await store.read(key);
  return result.found ? new Uint8Array(await buffer(result.stream)) : undefined;
}

async function readText(store: IFileStore, key: FileKey): Promise<string | undefined> {
  const bytes = await readBytes(store, key);
  return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const NEVER = new Promise<never>(() => {});

/** A Readable that counts how often it was asked for bytes, and pushes `parts` one per ask. */
function countedReadable(...parts: string[]): { source: Readable; reads: () => number } {
  let reads = 0;
  const source = new Readable({
    read() {
      reads += 1;
      this.push(reads <= parts.length ? Buffer.from(parts[reads - 1]!) : null);
    },
  });
  return { source, reads: () => reads };
}

/**
 * The cases of D23-1 decision 27, for one store. `setup` runs before each
 * test and gives it a fresh, empty store; its `cleanUp` runs after it.
 */
export function describeFileStoreContract(name: string, setup: () => Promise<FileStoreUnderTest>): void {
  describe(`${name}: the file store contract (D23-1 decision 27)`, () => {
    let underTest: FileStoreUnderTest | undefined;
    let store: IFileStore;

    beforeEach(async () => {
      underTest = await setup();
      store = underTest.store;
    });

    afterEach(async () => {
      const finished = underTest;
      underTest = undefined;
      await finished?.cleanUp();
    });

    /** The backend calls `operation` makes: the count's difference around it. */
    async function backendCallsOf(operation: () => Promise<unknown>): Promise<{ calls: number; outcome: unknown }> {
      const counter = underTest!;
      const before = counter.countBackendCalls();
      const outcome = await operation().then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
      return { calls: counter.countBackendCalls() - before, outcome };
    }

    describe("a round trip of every kind of key", () => {
      it.each(KEYS)(
        "%s: its exact bytes come back, with the size and SHA-256 the write returned, and remove takes them away",
        async (_name, key) => {
          const written = await store.write(key, chunks(BYTES.subarray(0, 100), BYTES.subarray(100)), {
            maxBytes: MAX,
          });
          expect(written).toEqual({ sizeBytes: BYTES.byteLength, sha256: sha256(BYTES) });

          const read = await store.read(key);
          expect(read.found).toBe(true);
          if (!read.found) return;
          expect(read.sizeBytes).toBe(BYTES.byteLength);
          expect(new Uint8Array(await buffer(read.stream))).toEqual(BYTES);

          await store.remove(key);
          expect(await store.read(key)).toEqual({ found: false });
        },
      );

      it.each(KEYS)("%s: an empty file round-trips", async (_name, key) => {
        expect(await store.write(key, chunks(), { maxBytes: MAX })).toEqual({ sizeBytes: 0, sha256: sha256("") });
        const read = await store.read(key);
        expect(read.found).toBe(true);
        if (!read.found) return;
        expect(read.sizeBytes).toBe(0);
        expect((await buffer(read.stream)).byteLength).toBe(0);
      });

      it("streams from a Readable, keeping its bytes exactly", async () => {
        const source = Readable.from([BYTES.subarray(0, 3), BYTES.subarray(3)]);
        expect(await store.write(testInput(), source, { maxBytes: MAX })).toEqual({
          sizeBytes: BYTES.byteLength,
          sha256: sha256(BYTES),
        });
        expect(await readBytes(store, testInput())).toEqual(BYTES);
      });

      it("a write replaces a file already at the key", async () => {
        await store.write(testInput(), chunks("first"), { maxBytes: MAX });
        expect(await store.write(testInput(), chunks("second"), { maxBytes: MAX })).toEqual({
          sizeBytes: 6,
          sha256: sha256("second"),
        });
        const read = await store.read(testInput());
        expect(read.found && read.sizeBytes).toBe(6);
        if (read.found) read.stream.destroy();
        expect(await readText(store, testInput())).toBe("second");
      });
    });

    describe("a key with no file", () => {
      it.each(KEYS)(
        "%s: read answers not found, remove resolves, copy answers not found and creates nothing",
        async (_name, key) => {
          const destination = testRun("decoded-input", ORGANIZATION_B);
          expect(await store.read(key)).toEqual({ found: false });
          await expect(store.remove(key)).resolves.toBeUndefined();
          expect(await store.copy(key, destination)).toEqual({ found: false });
          expect(await store.read(destination)).toEqual({ found: false });
        },
      );

      it("a file at another key answers nothing for it", async () => {
        await store.write(testInput(ORGANIZATION_A, USER, TEMPLATE), chunks("x"), { maxBytes: MAX });
        expect(await store.read(testInput())).toEqual({ found: false });
      });
    });

    describe("maxBytes", () => {
      it("keeps a file of exactly maxBytes", async () => {
        expect(await store.write(testInput(), chunks("12345", "67890"), { maxBytes: 10 })).toEqual({
          sizeBytes: 10,
          sha256: sha256("1234567890"),
        });
        expect(await readText(store, testInput())).toBe("1234567890");
      });

      it("refuses one byte more with FileTooLargeError, destroying the source and keeping no file", async () => {
        const source = Readable.from([Buffer.from("123456"), Buffer.from("78901"), Buffer.from("never read")]);
        const write = store.write(testInput(), source, { maxBytes: 10 });
        await expect(write).rejects.toBeInstanceOf(FileTooLargeError);
        await expect(write).rejects.toMatchObject({ maxBytes: 10 });
        expect(source.destroyed).toBe(true);
        expect(await store.read(testInput())).toEqual({ found: false });
      });

      it("refuses too large an overwrite and keeps the file already there", async () => {
        await store.write(testInput(), chunks("kept"), { maxBytes: 10 });
        await expect(store.write(testInput(), chunks("far too long"), { maxBytes: 10 })).rejects.toBeInstanceOf(
          FileTooLargeError,
        );
        expect(await readText(store, testInput())).toBe("kept");
      });

      it("maxBytes 0 keeps an empty file and refuses a single byte", async () => {
        expect(await store.write(testRun("output"), chunks(), { maxBytes: 0 })).toEqual({
          sizeBytes: 0,
          sha256: sha256(""),
        });
        expect(await readText(store, testRun("output"))).toBe("");
        await expect(store.write(testInput(), chunks("x"), { maxBytes: 0 })).rejects.toBeInstanceOf(FileTooLargeError);
        expect(await store.read(testInput())).toEqual({ found: false });
      });

      it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        "refuses maxBytes %s with a RangeError before any byte is read, and before any backend call",
        async (maxBytes) => {
          const { source, reads } = countedReadable("x");
          const { calls, outcome } = await backendCallsOf(() => store.write(testInput(), source, { maxBytes }));
          expect((outcome as { error?: unknown }).error).toBeInstanceOf(RangeError);
          expect(calls).toBe(0);
          expect(reads()).toBe(0);
          expect(source.destroyed).toBe(true);
          expect(await store.read(testInput())).toEqual({ found: false });
        },
      );
    });

    describe("an abort rejects with the signal's reason and keeps the file already at the key", () => {
      it("aborted before the write: nothing is read, and the old file stays (or none appears)", async () => {
        const signal = AbortSignal.abort();
        const fresh = countedReadable("replacement");
        await expect(store.write(testInput(), fresh.source, { maxBytes: MAX, signal })).rejects.toBe(signal.reason);
        expect(fresh.reads()).toBe(0);
        expect(fresh.source.destroyed).toBe(true);
        expect(await store.read(testInput())).toEqual({ found: false });

        await store.write(testRun("input"), chunks("kept"), { maxBytes: MAX });
        await expect(store.write(testRun("input"), chunks("replacement"), { maxBytes: MAX, signal })).rejects.toBe(
          signal.reason,
        );
        expect(await readText(store, testRun("input"))).toBe("kept");
      });

      it("aborted while an iterable source waits for its next chunk: no file appears", async () => {
        const controller = new AbortController();
        const waiting = deferred();
        async function* stalled(): AsyncIterable<Uint8Array> {
          yield Buffer.from("the first part");
          waiting.resolve();
          await NEVER;
        }

        const write = store.write(testInput(), stalled(), { maxBytes: MAX, signal: controller.signal });
        await waiting.promise;
        controller.abort();
        await expect(write).rejects.toBe(controller.signal.reason);
        expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
        expect(await store.read(testInput())).toEqual({ found: false });
      });

      it("aborted while a Readable source waits: the source is destroyed and the old file stays", async () => {
        await store.write(testInput(), chunks("kept"), { maxBytes: MAX });
        const controller = new AbortController();
        const waiting = deferred();
        // One chunk, then nothing, ever: a stalled upload. The second read is
        // the store asking for more.
        let reads = 0;
        const source = new Readable({
          read() {
            reads += 1;
            if (reads === 1) this.push(Buffer.from("replacement"));
            else waiting.resolve();
          },
        });

        const write = store.write(testInput(), source, { maxBytes: MAX, signal: controller.signal });
        await waiting.promise;
        controller.abort();
        await expect(write).rejects.toBe(controller.signal.reason);
        expect(source.destroyed).toBe(true);
        expect(await readText(store, testInput())).toBe("kept");
      });

      it("aborted after the last chunk, as the source ends: the old file stays", async () => {
        await store.write(testInput(), chunks("kept"), { maxBytes: MAX });
        const controller = new AbortController();
        async function* abortingAtTheEnd(): AsyncIterable<Uint8Array> {
          yield Buffer.from("the whole ");
          yield Buffer.from("replacement");
          controller.abort();
        }

        // The reason exists only once the source has aborted, so it is read after.
        const error = await store
          .write(testInput(), abortingAtTheEnd(), { maxBytes: MAX, signal: controller.signal })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(controller.signal.aborted).toBe(true);
        expect(error).toBe(controller.signal.reason);
        expect(await readText(store, testInput())).toBe("kept");
      });
    });

    describe("a source that doesn't give bytes", () => {
      it("a source that fails rejects with its error and keeps the old file (or none)", async () => {
        async function* failing(): AsyncIterable<Uint8Array> {
          yield Buffer.from("part");
          throw new Error("the upload broke off");
        }
        await expect(store.write(testRun("input"), failing(), { maxBytes: MAX })).rejects.toThrow("the upload broke off");
        expect(await store.read(testRun("input"))).toEqual({ found: false });

        await store.write(testRun("output"), chunks("kept"), { maxBytes: MAX });
        await expect(store.write(testRun("output"), failing(), { maxBytes: MAX })).rejects.toThrow("the upload broke off");
        expect(await readText(store, testRun("output"))).toBe("kept");
      });

      it("a source that yields something other than bytes is refused with a TypeError, keeping the old file (or none)", async () => {
        const strings = (): AsyncIterable<Uint8Array> =>
          (async function* () {
            yield "text" as unknown as Uint8Array;
          })();
        await expect(store.write(testRun("input"), strings(), { maxBytes: MAX })).rejects.toThrow(TypeError);
        expect(await store.read(testRun("input"))).toEqual({ found: false });

        await store.write(testRun("output"), chunks("kept"), { maxBytes: MAX });
        await expect(store.write(testRun("output"), strings(), { maxBytes: MAX })).rejects.toThrow(TypeError);
        expect(await readText(store, testRun("output"))).toBe("kept");
      });
    });

    describe("a malformed key is refused by every method, before any backend call", () => {
      const BAD_IDS: [string, unknown][] = [
        ["..", ".."],
        ["a path climbing out", "../../../../etc/passwd"],
        ["a slash", `${FILE}/x`],
        ["a leading slash", `/${FILE}`],
        ["a backslash", "..\\.."],
        ["a NUL", `${FILE}\0`],
        ["a NUL inside", `${FILE.slice(0, 8)}\0${FILE.slice(9)}`],
        ["upper case", FILE.toUpperCase()],
        ["not a uuid", "not-a-uuid"],
        ["no hyphens", FILE.replaceAll("-", "")],
        ["braces", `{${FILE}}`],
        ["a trailing newline", `${FILE}\n`],
        ["a leading space", ` ${FILE}`],
        ["empty", ""],
        ["a number", 42],
        ["undefined", undefined],
      ];

      // Built literally: a helper's default parameter would replace undefined.
      const FIELDS: [string, (id: unknown) => FileKey][] = [
        [
          "a test input's organizationId",
          (id) => ({ kind: "test-input", organizationId: id as string, userId: USER, fileId: FILE }),
        ],
        [
          "a test input's userId",
          (id) => ({ kind: "test-input", organizationId: ORGANIZATION_A, userId: id as string, fileId: FILE }),
        ],
        [
          "a test input's fileId",
          (id) => ({ kind: "test-input", organizationId: ORGANIZATION_A, userId: USER, fileId: id as string }),
        ],
        [
          "a run's organizationId",
          (id) => ({ kind: "test-run", organizationId: id as string, runId: RUN, name: "input" }),
        ],
        [
          "a run's runId",
          (id) => ({ kind: "test-run", organizationId: ORGANIZATION_A, runId: id as string, name: "input" }),
        ],
        ["a template's templateId", (id) => ({ kind: "test-template", templateId: id as string })],
        [
          "a definition input's organizationId",
          (id) => ({ kind: "test-definition-input", organizationId: id as string, inputId: DEFINITION_INPUT }),
        ],
        [
          "a definition input's inputId",
          (id) => ({ kind: "test-definition-input", organizationId: ORGANIZATION_A, inputId: id as string }),
        ],
        [
          "a logo's organizationId",
          (id) => ({ kind: "organization-logo", organizationId: id as string, logoId: LOGO }),
        ],
        [
          "a logo's logoId",
          (id) => ({ kind: "organization-logo", organizationId: ORGANIZATION_A, logoId: id as string }),
        ],
        ["a library file's fileId", (id) => ({ kind: "library-file", fileId: id as string })],
      ];

      function operationsOn(key: FileKey): [string, () => Promise<unknown>][] {
        const good = testRun("output");
        return [
          ["write", () => store.write(key, chunks("x"), { maxBytes: MAX })],
          // A file found is closed at once: the test needs only the call.
          [
            "read",
            async () => {
              const result = await store.read(key);
              if (result.found) result.stream.destroy();
              return result;
            },
          ],
          ["copy from", () => store.copy(key, good)],
          ["copy to", () => store.copy(good, key)],
          ["remove", () => store.remove(key)],
        ];
      }

      async function expectRefusedWithoutBackend(key: FileKey): Promise<void> {
        for (const [operation, call] of operationsOn(key)) {
          const { calls, outcome } = await backendCallsOf(call);
          expect((outcome as { error?: unknown }).error, operation).toBeInstanceOf(InvalidFileKeyError);
          expect(calls, operation).toBe(0);
        }
      }

      for (const [field, keyWith] of FIELDS) {
        it.each(BAD_IDS)(`${field}: %s`, async (_name, id) => {
          await expectRefusedWithoutBackend(keyWith(id));
        });
      }

      it.each(["../input", "Input", "input/", "", "output\0", "decoded_input", "logs"])(
        "a run's file name that isn't input, output or decoded-input (%j)",
        async (fileName) => {
          await expectRefusedWithoutBackend({
            kind: "test-run",
            organizationId: ORGANIZATION_A,
            runId: RUN,
            name: fileName as "input",
          });
        },
      );

      it("an unknown kind", async () => {
        await expectRefusedWithoutBackend({ kind: "unplanned-kind", fileId: FILE } as unknown as FileKey);
      });

      it("the error never carries the offending value", async () => {
        const secretLooking = "../../private-name.json";
        const error = await store.read(testInput(ORGANIZATION_A, USER, secretLooking)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(InvalidFileKeyError);
        expect((error as Error).message).not.toContain("private-name");
        expect((error as Error).message).toBe("The file key's fileId is not a canonical lower-case UUID.");
      });

      it("a valid key reaches the backend by every method (the count above means something)", async () => {
        for (const [operation, call] of operationsOn(testInput())) {
          const { calls, outcome } = await backendCallsOf(call);
          expect((outcome as { error?: unknown }).error, operation).toBeUndefined();
          expect(calls, operation).toBeGreaterThan(0);
        }
      });
    });

    describe("copy", () => {
      it("copies exact bytes, with their size and SHA-256, and leaves the source", async () => {
        await store.write(testInput(), chunks(BYTES), { maxBytes: MAX });
        expect(await store.copy(testInput(), testRun("input"))).toEqual({
          found: true,
          sizeBytes: BYTES.byteLength,
          sha256: sha256(BYTES),
        });
        const copied = await store.read(testRun("input"));
        expect(copied.found && copied.sizeBytes).toBe(BYTES.byteLength);
        if (copied.found) copied.stream.destroy();
        expect(await readBytes(store, testRun("input"))).toEqual(BYTES);
        expect(await readBytes(store, testInput())).toEqual(BYTES);
      });

      it("copies a person's input or a template into a definition's input, and that into a run's (D14b)", async () => {
        await store.write(testInput(), chunks("from my files\n"), { maxBytes: MAX });
        await store.write(testTemplate(), chunks("from a template\n"), { maxBytes: MAX });
        const otherInput = definitionInput(ORGANIZATION_A, FILE);

        expect(await store.copy(testInput(), definitionInput())).toMatchObject({
          found: true,
          sha256: sha256("from my files\n"),
        });
        expect(await store.copy(testTemplate(), otherInput)).toMatchObject({ found: true });
        expect(await store.copy(definitionInput(), testRun("input"))).toMatchObject({ found: true });

        expect(await readText(store, testRun("input"))).toBe("from my files\n");
        expect(await readText(store, otherInput)).toBe("from a template\n");
        // The person's file can go: the definition keeps its own copy (D14b decision 1).
        await store.remove(testInput());
        expect(await readText(store, definitionInput())).toBe("from my files\n");
        expect(await readText(store, testTemplate())).toBe("from a template\n");
      });

      it("replaces a file already at the destination", async () => {
        await store.write(testInput(), chunks("new"), { maxBytes: MAX });
        await store.write(testRun("input"), chunks("older"), { maxBytes: MAX });
        expect(await store.copy(testInput(), testRun("input"))).toEqual({
          found: true,
          sizeBytes: 3,
          sha256: sha256("new"),
        });
        expect(await readText(store, testRun("input"))).toBe("new");
      });

      it("answers not found for a source with no file, and leaves the destination as it was", async () => {
        expect(await store.copy(testInput(), testRun("input"))).toEqual({ found: false });
        expect(await store.read(testRun("input"))).toEqual({ found: false });

        await store.write(testRun("output"), chunks("kept"), { maxBytes: MAX });
        expect(await store.copy(testInput(), testRun("output"))).toEqual({ found: false });
        expect(await readText(store, testRun("output"))).toBe("kept");
      });
    });

    describe("keys never collide", () => {
      it("two organizations' keys of the same kind and ids never collide", async () => {
        const keysOf = (organization: string): FileKey[] => [
          testInput(organization),
          testRun("input", organization),
          testRun("output", organization),
          testRun("decoded-input", organization),
          definitionInput(organization),
          organizationLogo(organization),
        ];
        for (const organization of [ORGANIZATION_A, ORGANIZATION_B]) {
          for (const [index, key] of keysOf(organization).entries()) {
            await store.write(key, chunks(`${organization} ${index}`), { maxBytes: MAX });
          }
        }

        for (const organization of [ORGANIZATION_A, ORGANIZATION_B]) {
          for (const [index, key] of keysOf(organization).entries()) {
            expect(await readText(store, key)).toBe(`${organization} ${index}`);
          }
        }

        for (const key of keysOf(ORGANIZATION_A)) await store.remove(key);
        for (const key of keysOf(ORGANIZATION_A)) expect(await store.read(key)).toEqual({ found: false });
        for (const [index, key] of keysOf(ORGANIZATION_B).entries()) {
          expect(await readText(store, key)).toBe(`${ORGANIZATION_B} ${index}`);
        }
      });

      it("two people's files in one organization, with the same file id, never collide", async () => {
        await store.write(testInput(ORGANIZATION_A, USER), chunks("mine"), { maxBytes: MAX });
        await store.write(testInput(ORGANIZATION_A, OTHER_USER), chunks("theirs"), { maxBytes: MAX });
        expect(await readText(store, testInput(ORGANIZATION_A, USER))).toBe("mine");
        expect(await readText(store, testInput(ORGANIZATION_A, OTHER_USER))).toBe("theirs");
        await store.remove(testInput(ORGANIZATION_A, OTHER_USER));
        expect(await readText(store, testInput(ORGANIZATION_A, USER))).toBe("mine");
      });

      it("a template and a definition input with the same id never collide", async () => {
        const template = testTemplate(DEFINITION_INPUT);
        await store.write(template, chunks("the template"), { maxBytes: MAX });
        await store.write(definitionInput(), chunks("the definition's input"), { maxBytes: MAX });
        expect(await readText(store, template)).toBe("the template");
        expect(await readText(store, definitionInput())).toBe("the definition's input");

        await store.remove(template);
        expect(await store.read(template)).toEqual({ found: false });
        expect(await readText(store, definitionInput())).toBe("the definition's input");
      });

      it("a logo, a library file, a template and a definition input with the same id never collide (D23-2 decision 30)", async () => {
        const sameId = LOGO;
        const keys: FileKey[] = [
          organizationLogo(ORGANIZATION_A, sameId),
          libraryFile(sameId),
          testTemplate(sameId),
          definitionInput(ORGANIZATION_A, sameId),
        ];
        for (const [index, key] of keys.entries()) await store.write(key, chunks(`kind ${index}`), { maxBytes: MAX });
        for (const [index, key] of keys.entries()) expect(await readText(store, key)).toBe(`kind ${index}`);

        await store.remove(organizationLogo(ORGANIZATION_A, sameId));
        await store.remove(libraryFile(sameId));
        expect(await store.read(organizationLogo(ORGANIZATION_A, sameId))).toEqual({ found: false });
        expect(await store.read(libraryFile(sameId))).toEqual({ found: false });
        expect(await readText(store, testTemplate(sameId))).toBe("kind 2");
        expect(await readText(store, definitionInput(ORGANIZATION_A, sameId))).toBe("kind 3");
      });
    });

    describe("remove", () => {
      it("removing twice is not an error, a read after it answers not found, and it removes only its own key", async () => {
        await store.write(testRun("input"), chunks("input"), { maxBytes: MAX });
        await store.write(testRun("output"), chunks("output"), { maxBytes: MAX });
        await expect(store.remove(testRun("output"))).resolves.toBeUndefined();
        await expect(store.remove(testRun("output"))).resolves.toBeUndefined();
        expect(await store.read(testRun("output"))).toEqual({ found: false });
        expect(await readText(store, testRun("input"))).toBe("input");
      });
    });
  });
}
