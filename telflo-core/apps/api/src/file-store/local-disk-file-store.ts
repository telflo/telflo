import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { consume, keyPath } from "./file-key.js";
import {
  FileStoreError,
  FileTooLargeError,
  UnsafeFilePathError,
  type FileCopyResult,
  type FileKey,
  type FileReadResult,
  type FileWriteOptions,
  type FileWriteResult,
  type IFileStore,
} from "./file-store.js";

// The local-disk FileStore (ADR 0012; D14a decision 2, Preflight ruling 11):
// a directory on a mounted volume, compose's `file-store`. Every path
// is built from a key's ids, each checked to be a canonical lower-case UUID
// before any filesystem call, under the root as it resolved at start. A
// directory on the way that is a symbolic link, or resolves anywhere but
// where it should, is refused, and files are opened with O_NOFOLLOW.
//
// What that holds, and what it doesn't (D14a Ruling 25): each check is
// true of the disk when it runs, but Node has no openat(2) or
// RESOLVE_BENEATH to make a check and the open, rename or unlink after it
// one step. So a directory swapped for a symbolic link between the two can
// still land a file outside the root, or read or remove one there. Swapping
// it needs write access inside the root, and only the API's own user has
// that: compose's `file-store` volume is the API's alone (0700, owned
// by `node`), the tester never mounts it, and nothing else runs as that
// user. Short of a writer inside the root, nothing is read or written
// outside it.
//
// It logs nothing: a key's ids, a file's bytes and any name stay out of the
// logs (ADR 0024). Its errors carry no ids and no paths but the root's: a
// filesystem call's own error names its path, so any the store doesn't
// handle itself is rethrown as a FileStoreError, keeping only its code and
// syscall (fsCall). A read stream's errors come from read(2) on a file
// already open, and name no path.

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * One filesystem call of the store's own work. Its failure is rethrown as a
 * FileStoreError with the same `code` and `syscall`, so the code checks
 * below still read it, and nothing that names a path (Node's message,
 * `path`, `dest`) leaves the store (D14a Ruling 25).
 */
async function fsCall<Result>(call: () => Promise<Result>): Promise<Result> {
  try {
    return await call();
  } catch (error) {
    const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
    throw new FileStoreError(typeof code === "string" ? code : undefined, typeof syscall === "string" ? syscall : undefined);
  }
}

function noop(): void {}

/** Writes all of `chunk` at the file's current position. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await fsCall(() => handle.write(chunk, offset, chunk.byteLength - offset));
    if (bytesWritten <= 0) throw new Error("The file store could not write to a file.");
    offset += bytesWritten;
  }
}

/** Flushes a directory's entries (a rename into it) to disk. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsCall(() => open(directory, constants.O_RDONLY | constants.O_DIRECTORY));
  try {
    await fsCall(() => handle.sync());
  } finally {
    await fsCall(() => handle.close());
  }
}

/**
 * Checks before `listen` (index.ts) that TELFLO_FILE_STORE_ROOT is an
 * absolute path to a directory the API can write, by creating and removing a
 * probe file in it, then resolves it once: every path is built under the
 * resolved root (macOS's temporary directory, `/var/…`, is `/private/var/…`).
 */
export async function createLocalDiskFileStore(root: string): Promise<IFileStore> {
  if (!isAbsolute(root)) {
    throw new Error(`The file store's root (TELFLO_FILE_STORE_ROOT) must be an absolute path, received: ${root}`);
  }
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`The file store's root (TELFLO_FILE_STORE_ROOT) does not exist: ${root}`);
    }
    throw error;
  }
  if (!(await stat(resolvedRoot)).isDirectory()) {
    throw new Error(`The file store's root (TELFLO_FILE_STORE_ROOT) is not a directory: ${root}`);
  }
  const probe = join(resolvedRoot, `.write-probe-${randomUUID()}`);
  try {
    const handle = await open(
      probe,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    await handle.close();
    await unlink(probe);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new Error(`The file store's root (TELFLO_FILE_STORE_ROOT) is not writable: ${root}`);
    }
    throw error;
  }
  return localDiskFileStore(resolvedRoot);
}

function localDiskFileStore(root: string): IFileStore {
  /** The key's directory and file, as absolute paths under the root. Touches no file. */
  function locate(key: FileKey): { directory: string; file: string; segments: string[] } {
    const { directorySegments, fileName } = keyPath(key);
    const directory = join(root, ...directorySegments);
    const file = join(directory, fileName);
    // Lexically inside the root. The ids are checked already, so this never
    // fails unless that check does: it is the second of two. No key the
    // store's interface takes reaches it (keyPath joins only checked ids and
    // fixed names), so no test does: defence in depth, should keyPath ever
    // be loosened (D14a Ruling 25).
    const fromRoot = relative(root, file);
    if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
      throw new UnsafeFilePathError("The file key names a path outside the file store's root.");
    }
    return { directory, file, segments: directorySegments };
  }

  /**
   * The directory must resolve to exactly itself: no symbolic link on the
   * way. True when it does, false when it doesn't exist.
   */
  async function directoryResolves(directory: string): Promise<boolean> {
    let resolved: string;
    try {
      resolved = await fsCall(() => realpath(directory));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (resolved !== directory) {
      throw new UnsafeFilePathError("A directory in the file store resolves outside its expected place.");
    }
    return true;
  }

  /**
   * Creates the key's directories one at a time, refusing any that is a
   * symbolic link or not a directory, so nothing is created through a link
   * outside the root (`mkdir -p` would follow it), then checks the whole
   * directory resolves to itself.
   */
  async function ensureDirectory(segments: string[]): Promise<string> {
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        await fsCall(() => mkdir(current, { mode: DIRECTORY_MODE }));
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      const stats = await fsCall(() => lstat(current));
      if (!stats.isDirectory()) {
        throw new UnsafeFilePathError("A directory in the file store is a symbolic link or not a directory.");
      }
    }
    await directoryResolves(current);
    return current;
  }

  /** A file already at the key may be replaced only if it is a plain file. */
  async function refuseUnsafeTarget(file: string): Promise<void> {
    let stats;
    try {
      stats = await fsCall(() => lstat(file));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (!stats.isFile()) {
      throw new UnsafeFilePathError("The file store's file is a symbolic link or not a plain file.");
    }
  }

  async function write(
    key: FileKey,
    content: AsyncIterable<Uint8Array> | Readable,
    options: FileWriteOptions,
  ): Promise<FileWriteResult> {
    let handle: FileHandle | undefined;
    let temporary: string | undefined;
    let isRenamed = false;
    try {
      const { file, segments } = locate(key);
      const { maxBytes, signal } = options;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError("maxBytes must be a non-negative integer.");
      }
      signal?.throwIfAborted();
      const directory = await ensureDirectory(segments);
      // In the same directory, so the rename is atomic; its leading dot
      // keeps it apart from every key's name.
      temporary = join(directory, `.${randomUUID()}.tmp`);
      const temporaryPath = temporary;
      handle = await fsCall(() =>
        open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE),
      );
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const output = handle;
      await consume(content, signal, async (chunk) => {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("A file's content must be bytes.");
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maxBytes) throw new FileTooLargeError(maxBytes);
        hash.update(chunk);
        await writeAll(output, chunk);
      });
      signal?.throwIfAborted();
      await fsCall(() => output.sync());
      await fsCall(() => output.close());
      handle = undefined;
      await refuseUnsafeTarget(file);
      await fsCall(() => rename(temporaryPath, file));
      isRenamed = true;
      await syncDirectory(directory);
      return { sizeBytes, sha256: hash.digest("hex") };
    } catch (error) {
      // A Readable the write never reached is destroyed too, so its producer
      // (an upload's request) doesn't wait on it.
      if (content instanceof Readable) content.destroy();
      if (handle !== undefined) await handle.close().catch(noop);
      if (temporary !== undefined && !isRenamed) await unlink(temporary).catch(noop);
      throw error;
    }
  }

  async function read(key: FileKey): Promise<FileReadResult> {
    const { directory, file } = locate(key);
    if (!(await directoryResolves(directory))) return { found: false };
    let handle: FileHandle;
    try {
      // O_NONBLOCK: a FIFO someone left here opens at once, and is refused
      // below, instead of blocking the open. It changes nothing for a file.
      handle = await fsCall(() => open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { found: false };
      if (code === "ELOOP" || code === "EMLINK") {
        throw new UnsafeFilePathError("The file store's file is a symbolic link.");
      }
      throw error;
    }
    try {
      const opened = handle;
      const stats = await fsCall(() => opened.stat());
      if (!stats.isFile()) throw new UnsafeFilePathError("The file store's file is not a plain file.");
      return { found: true, sizeBytes: stats.size, stream: handle.createReadStream() };
    } catch (error) {
      await handle.close().catch(noop);
      throw error;
    }
  }

  async function copy(from: FileKey, to: FileKey): Promise<FileCopyResult> {
    // Both keys are checked before either is touched.
    locate(from);
    locate(to);
    const source = await read(from);
    if (!source.found) return { found: false };
    // The source is already bounded by its own write.
    const written = await write(to, source.stream, { maxBytes: Number.MAX_SAFE_INTEGER });
    return { found: true, ...written };
  }

  async function remove(key: FileKey): Promise<void> {
    const { directory, file } = locate(key);
    if (!(await directoryResolves(directory))) return;
    try {
      await fsCall(() => unlink(file));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  return { write, read, copy, remove };
}
