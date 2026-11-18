import type { Readable } from "node:stream";

/**
 * The files the platform keeps (ADR 0012; D14a decisions 2 and 3, Preflight
 * ruling 11). Only ids name a file, never a person's file name or a URL: a
 * key is built from ids the API has already authorized, and the store
 * refuses any id that isn't a canonical lower-case UUID.
 *
 * - `test-input`: a person's upload or saved sample, in one organization
 *   (`organizations/<org>/users/<user>/test-inputs/<file>`).
 * - `test-run`: one of a run's own files
 *   (`organizations/<org>/test-runs/<run>/<input|output|decoded-input>`).
 * - `test-template`: a product-wide test template (D14b decision 3,
 *   `global/test-templates/<template>`).
 * - `test-definition-input`: a test definition's own copy of its input,
 *   shared by the definitions that reference it in one organization (D14b
 *   decisions 1 and 4, detail 18:
 *   `organizations/<org>/test-definition-inputs/<input>`).
 * - `organization-logo`: an organization's logo, one file per logo id, so a
 *   new logo never overwrites the one a cached page still shows (D23-2
 *   decisions 18 and 30: `organizations/<org>/logos/<logo>`).
 * - `library-file`: a file in the product-wide library (D23-2 decisions 18
 *   and 30: `global/library-files/<file>`).
 */
export type FileKey =
  | { kind: "test-input"; organizationId: string; userId: string; fileId: string }
  | { kind: "test-run"; organizationId: string; runId: string; name: TestRunFileName }
  | { kind: "test-template"; templateId: string }
  | { kind: "test-definition-input"; organizationId: string; inputId: string }
  | { kind: "organization-logo"; organizationId: string; logoId: string }
  | { kind: "library-file"; fileId: string };

export const TEST_RUN_FILE_NAMES = ["input", "output", "decoded-input"] as const;

export type TestRunFileName = (typeof TEST_RUN_FILE_NAMES)[number];

export interface FileWriteOptions {
  /**
   * The most bytes the file may hold; one more refuses the write
   * (FileTooLargeError). S3FileStore buffers a write, so it refuses a
   * maxBytes above MAX_BUFFERED_BYTES (64 MiB) with a RangeError.
   */
  maxBytes: number;
  /** Aborting it stops the write, which then leaves nothing behind. */
  signal?: AbortSignal | undefined;
}

export interface FileWriteResult {
  sizeBytes: number;
  /** The SHA-256 of the bytes written, lower-case hex. */
  sha256: string;
}

export type FileReadResult =
  | {
      found: true;
      sizeBytes: number;
      /** The file's bytes. The caller must consume or destroy it: it holds the file open. */
      stream: Readable;
    }
  | { found: false };

export type FileCopyResult = ({ found: true } & FileWriteResult) | { found: false };

/**
 * Where the platform's files live: `LocalDiskFileStore` (local-disk-file-store.ts,
 * D14a) or `S3FileStore` (s3-file-store.ts, D23-1), behind the same
 * interface. Callers get one from createFileStore and never name an
 * implementation (ADR 0020).
 *
 * No implementation logs a key, a file's bytes or any name.
 */
export interface IFileStore {
  /**
   * Streams `content` into the key's file, replacing any file already there.
   * The file appears whole or not at all: an error, an abort or more than
   * `maxBytes` leaves no file and no partial file behind (a file already at
   * the key is kept).
   *
   * One exception in each store, where a write rejects with the new file
   * already at the key:
   * - the local disk: the new file is renamed into place, then its directory
   *   is flushed to disk, and only that flush fails;
   * - S3: the server committed the PUT but its answer was lost (a timeout, a
   *   dropped connection, or an abort arriving after the server committed;
   *   D23-1 decision 18).
   * So a caller that must not keep a file after a failed write calls
   * `remove(key)` on ANY rejection (D14a Ruling 25), as the upload's and the
   * dispatcher's clean-ups do.
   */
  write(key: FileKey, content: AsyncIterable<Uint8Array> | Readable, options: FileWriteOptions): Promise<FileWriteResult>;
  /** The key's file as a stream, or `{found: false}` when there is none. */
  read(key: FileKey): Promise<FileReadResult>;
  /**
   * Copies one key's file to another key, as a write: whole or not at all.
   * `{found: false}` when the source has no file.
   */
  copy(from: FileKey, to: FileKey): Promise<FileCopyResult>;
  /** Removes the key's file. A key with no file is not an error. */
  remove(key: FileKey): Promise<void>;
}

/**
 * Where the file store keeps its files (TELFLO_FILE_STORE, D23-1 decisions 15
 * and 16): one kind per install, chosen by `kind`.
 */
export type FileStoreSettings = LocalFileStoreSettings | S3FileStoreSettings;

/** The local disk (TELFLO_FILE_STORE=local, the default; TELFLO_FILE_STORE_ROOT). */
export interface LocalFileStoreSettings {
  kind: "local";
  /** An absolute path to an existing, writable directory. */
  root: string;
}

/**
 * An S3-protocol bucket (TELFLO_FILE_STORE=s3). No credential: the AWS SDK's
 * default chain finds them (the pod's IAM role on EKS, the standard `AWS_*`
 * variables locally; D23-1 decision 4). None of these is a secret.
 */
export interface S3FileStoreSettings {
  kind: "s3";
  /** TELFLO_FILE_STORE_BUCKET. */
  bucket: string;
  /**
   * TELFLO_FILE_STORE_PREFIX: put before every object's name, so installs
   * sharing a bucket keep apart. `""` for none, else ending with one `/`.
   */
  prefix: string;
  /** TELFLO_FILE_STORE_S3_REGION. */
  region: string;
  /** TELFLO_FILE_STORE_S3_ENDPOINT, a non-AWS server only; undefined is AWS's own for the region. */
  endpoint: string | undefined;
  /** TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE. */
  forcePathStyle: boolean;
}

/** A write passed its `maxBytes`. Nothing was kept. */
export class FileTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes.`);
    this.name = "FileTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * A key the store refuses: an id that isn't a canonical lower-case UUID, an
 * unknown kind or run file name. Checked before any filesystem call. The
 * message never carries the offending value.
 */
export class InvalidFileKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFileKeyError";
  }
}

/**
 * The path a key names isn't the plain file under the root it should be: a
 * symbolic link, or a directory on the way that resolves elsewhere. Nothing
 * was read or written through it. The message carries no path.
 */
export class UnsafeFilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFilePathError";
  }
}

/**
 * A call the store made to its backend failed in a way it doesn't handle
 * itself. On the local disk (a directory it can't write, a full disk, a file
 * where a directory should be) it keeps the call's `code` (`EACCES`,
 * `ENOTDIR`, …) and `syscall` (`open`, `unlink`, …); on S3 a token-shaped
 * code (`AccessDenied`, `SlowDown`, `TimeoutError`, …) and the operation's
 * name (`PutObject`, `GetObject`, `DeleteObject`; D23-1 decision 22). Nothing
 * else: Node's and the SDK's own errors name the path or the bucket and the
 * object key, which hold the key's ids, so neither they nor the original
 * error (no `cause`) are kept (D14a Ruling 25). A caller may store its
 * message.
 */
export class FileStoreError extends Error {
  readonly code: string | undefined;
  readonly syscall: string | undefined;

  constructor(code: string | undefined, syscall: string | undefined) {
    super(`A file store operation failed (${syscall ?? "unknown call"}: ${code ?? "unknown error"}).`);
    this.name = "FileStoreError";
    this.code = code;
    this.syscall = syscall;
  }
}
