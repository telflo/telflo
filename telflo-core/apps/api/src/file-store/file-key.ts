import { Readable } from "node:stream";
import { InvalidFileKeyError, TEST_RUN_FILE_NAMES, type FileKey } from "./file-store.js";

// What every file store shares (D23-1 decision 17): a key's layout, checked
// before any backend call, and how a write reads its content, so an abort
// ends a write the same way in each store. The local disk joins a key's
// segments into a path under its root; an object store names its object by
// `fileKeyName`.

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RUN_FILE_NAMES: ReadonlySet<string> = new Set(TEST_RUN_FILE_NAMES);

/** A path under the root, as the segments of its directory and its file's name. */
export interface KeyPath {
  directorySegments: string[];
  fileName: string;
}

function canonicalId(value: unknown, field: string): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new InvalidFileKeyError(`The file key's ${field} is not a canonical lower-case UUID.`);
  }
  return value;
}

/**
 * The key's path under the root. Pure: it checks every id and name, and
 * touches no file. The kinds' layouts are D14a decision 3's, D14b
 * detail 18's for a definition's input, and D23-2 decision 30's for a logo
 * and a library file.
 */
export function keyPath(key: FileKey): KeyPath {
  switch (key.kind) {
    case "test-input":
      return {
        directorySegments: [
          "organizations",
          canonicalId(key.organizationId, "organizationId"),
          "users",
          canonicalId(key.userId, "userId"),
          "test-inputs",
        ],
        fileName: canonicalId(key.fileId, "fileId"),
      };
    case "test-run": {
      const organizationId = canonicalId(key.organizationId, "organizationId");
      const runId = canonicalId(key.runId, "runId");
      if (typeof key.name !== "string" || !RUN_FILE_NAMES.has(key.name)) {
        throw new InvalidFileKeyError(`The file key's name must be one of ${TEST_RUN_FILE_NAMES.join(", ")}.`);
      }
      return { directorySegments: ["organizations", organizationId, "test-runs", runId], fileName: key.name };
    }
    case "test-template":
      return {
        directorySegments: ["global", "test-templates"],
        fileName: canonicalId(key.templateId, "templateId"),
      };
    case "test-definition-input":
      return {
        directorySegments: ["organizations", canonicalId(key.organizationId, "organizationId"), "test-definition-inputs"],
        fileName: canonicalId(key.inputId, "inputId"),
      };
    case "organization-logo":
      return {
        directorySegments: ["organizations", canonicalId(key.organizationId, "organizationId"), "logos"],
        fileName: canonicalId(key.logoId, "logoId"),
      };
    case "library-file":
      return {
        directorySegments: ["global", "library-files"],
        fileName: canonicalId(key.fileId, "fileId"),
      };
    default: {
      // A key from untyped code: refused, as an id would be.
      const _unknown: never = key;
      throw new InvalidFileKeyError("The file key's kind is not one the file store knows.");
    }
  }
}

/**
 * The key's name as an object store keeps it: its segments and file name
 * joined by `/` (`organizations/<org>/test-runs/<run>/output`). Checked as
 * `keyPath` checks it, so a refused key throws InvalidFileKeyError here too.
 */
export function fileKeyName(key: FileKey): string {
  const { directorySegments, fileName } = keyPath(key);
  return [...directorySegments, fileName].join("/");
}

function noop(): void {}

/**
 * Feeds each chunk of `content` to `onChunk`, one at a time. An abort ends it
 * at once, even while the source is waiting for its next chunk (a stream
 * pipeline would wait for the source). On any failure a Readable source is
 * destroyed, and any other source's iterator is told to return.
 */
export async function consume(
  content: AsyncIterable<Uint8Array> | Readable,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const iterator = content[Symbol.asyncIterator]();
  let removeAbortListener = noop;
  const aborted = new Promise<never>((_, reject) => {
    if (signal === undefined) return;
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  aborted.catch(noop);
  try {
    for (;;) {
      const next = iterator.next();
      next.catch(noop);
      const result = await Promise.race([next, aborted]);
      if (result.done) return;
      signal?.throwIfAborted();
      await onChunk(result.value);
    }
  } catch (error) {
    if (content instanceof Readable) content.destroy();
    else iterator.return?.().catch(noop);
    throw error;
  } finally {
    removeAbortListener();
  }
}
