import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { consume, fileKeyName } from "./file-key.js";
import {
  FileStoreError,
  FileTooLargeError,
  type FileCopyResult,
  type FileKey,
  type FileReadResult,
  type FileWriteOptions,
  type FileWriteResult,
  type IFileStore,
  type S3FileStoreSettings,
} from "./file-store.js";

// The S3 FileStore: one bucket, any S3-protocol server (AWS, or SeaweedFS in
// development and tests), each object named `<prefix><fileKeyName(key)>`, a
// key's ids checked before any request (file-key.ts).
//
// A write is read into memory up to its maxBytes (at most MAX_BUFFERED_BYTES),
// hashed as it comes, then sent as one PutObject carrying its length and
// SHA-256, which the server checks: a PUT replaces an object atomically, so
// the file appears whole or not at all. A copy is a read, then a write.
// Encryption at rest is the bucket's own default: no header is set.
//
// Credentials come only from the AWS SDK's default chain (the standard
// `AWS_*` variables, the shared files, web identity, container and instance
// roles): the client is given none, and Telflo's settings hold none.
//
// It logs nothing: no key, no bytes, no name, and the client has no logger.
// Its errors are the interface's own: an S3 error, its message, `$response`
// and `stack` quote the bucket, the object's name (which holds the key's
// ids), the server's text, the endpoint or the request's signature, so none
// of it is kept, only a token-shaped code and the operation's fixed name
// (FileStoreError).

/** The most bytes one write may hold in memory. Every caller's maxBytes is far below it. */
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

type S3Operation = "PutObject" | "GetObject" | "DeleteObject";

/** A code that is a name and nothing else: no space, slash or text. */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;

/** Names that say nothing: the SDK's base class and its fallbacks for a reply with no code. */
const GENERIC_ERROR_CODES: ReadonlySet<string> = new Set(["Error", "Unknown", "UnknownError", "S3ServiceException"]);

/**
 * The error's code, when it has one worth keeping: the first of S3's `Code`,
 * the SDK's `name` and Node's `code` that matches ERROR_CODE and isn't
 * generic (`AccessDenied`, `NoSuchBucket`, `SignatureDoesNotMatch`,
 * `TimeoutError`, `ECONNREFUSED`, …). Nothing else of the error is read.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { Code, name, code } = error as {
    Code?: unknown;
    name?: unknown;
    code?: unknown;
  };
  for (const candidate of [Code, name, code]) {
    if (typeof candidate === "string" && ERROR_CODE.test(candidate) && !GENERIC_ERROR_CODES.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** A new error in place of the SDK's: its code and the operation, nothing else (no message, no cause). */
function storeError(error: unknown, operation: S3Operation): FileStoreError {
  return new FileStoreError(errorCode(error), operation);
}

function isNoSuchKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NoSuchKey";
}

function noop(): void {}

/**
 * The client, built once per store. No `credentials`: the SDK's default chain
 * resolves them on the first request. No `logger`.
 * `ignoreConfiguredEndpointUrls`: only Telflo's setting picks the endpoint,
 * never `AWS_ENDPOINT_URL*` or a config file's `endpoint_url`. The timeouts
 * and attempts bound an operation against a server that never answers to about
 * 12.3 s, so the dispatcher's two answer-file writes fit its 30-second
 * reserve; `throwOnRequestTimeout`, or a request timeout only warns on
 * `console`. No socket timeout: it would cut a body a slow reader paused.
 */
function createClient(settings: S3FileStoreSettings): S3Client {
  return new S3Client({
    region: settings.region,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
    forcePathStyle: settings.forcePathStyle,
    ignoreConfiguredEndpointUrls: true,
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: 2_000,
      requestTimeout: 4_000,
      throwOnRequestTimeout: true,
    },
  });
}

/**
 * Checks before `listen` (index.ts) that the API can use its bucket, then
 * returns the store: it writes an empty probe, asks for a name that doesn't
 * exist (which must answer NoSuchKey: without `s3:ListBucket`, S3 answers a
 * missing key with AccessDenied, and every "not found" would become a
 * failure), then removes the probe. Probe names begin with `.`, which no
 * key's name does. Each failure names the bucket, the prefix, the step and
 * the code only.
 */
export async function createS3FileStore(settings: S3FileStoreSettings): Promise<IFileStore> {
  const client = createClient(settings);
  const { bucket, prefix } = settings;
  const where = prefix === "" ? bucket : `${bucket} with prefix ${prefix} (TELFLO_FILE_STORE_PREFIX)`;
  const refuse = (problem: string, operation: S3Operation, code: string | undefined, advice = ""): Error => {
    client.destroy();
    return new Error(
      `The file store's bucket (TELFLO_FILE_STORE_BUCKET) ${problem}: ${where} (${operation}: ${code ?? "unknown error"})${advice}`,
    );
  };

  // Sent as a write sends its object: its length and its SHA-256.
  const probe = `${prefix}.write-probe-${randomUUID()}`;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: probe,
        Body: new Uint8Array(0),
        ContentLength: 0,
        ChecksumSHA256: createHash("sha256").digest("base64"),
        ContentType: "application/octet-stream",
      }),
    );
  } catch (error) {
    throw refuse("can't be written", "PutObject", errorCode(error));
  }

  // A missing name must answer NoSuchKey. Refused, the probe is still
  // removed if it can be (its own failure is the refusal's to report).
  let missingAnswer: string | undefined;
  try {
    const answer = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `${prefix}.missing-probe-${randomUUID()}`,
      }),
    );
    if (answer.Body instanceof Readable) answer.Body.destroy();
    missingAnswer = "answered found";
  } catch (error) {
    if (!isNoSuchKey(error)) missingAnswer = errorCode(error) ?? "unknown error";
  }
  if (missingAnswer !== undefined) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probe })).catch(noop);
    throw refuse(
      "can't tell a missing file",
      "GetObject",
      missingAnswer,
      ". A missing file must answer NoSuchKey: grant the API's role s3:ListBucket on the bucket.",
    );
  }

  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probe }));
  } catch (error) {
    throw refuse("can't have a file removed", "DeleteObject", errorCode(error));
  }

  return s3FileStore(client, bucket, prefix);
}

/**
 * How long a read's body may send nothing while its reader is asking for
 * bytes. The client's request timeout ends at the reply's headers and there is
 * no socket timeout (which would cut a reader who paused), so a body that
 * stalls after its headers would otherwise wait forever. A reader that stops
 * asking is never cut.
 */
export const READ_IDLE_TIMEOUT_MS = 10_000;

/**
 * The SDK's body as the store's own stream: the body's bytes, re-emitted; any
 * error of the body (a reset quotes the SDK's text, a checksum mismatch both
 * digests) replaced by a FileStoreError with its code; destroying it destroys
 * the body, which frees the socket. Not `stream.pipeline`, which would forward
 * the body's error.
 *
 * The idle timer (READ_IDLE_TIMEOUT_MS) runs only while the stream waits for
 * the body on its reader's behalf: armed each time the stream asks for more
 * (`read`), cleared when a chunk arrives (the stream asks again if it still
 * wants more, and stops asking once its buffer is full and the body is
 * paused), at the body's end and when the stream is destroyed. On expiry the
 * stream errors with FileStoreError("TimeoutError", "GetObject") and the body
 * is destroyed.
 */
function storeStream(body: Readable): Readable {
  let isBodyEnded = false;
  let idleTimer: NodeJS.Timeout | undefined;
  function stopIdleTimer(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  function startIdleTimer(): void {
    stopIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      stream.destroy(new FileStoreError("TimeoutError", "GetObject"));
    }, READ_IDLE_TIMEOUT_MS);
  }
  const stream = new Readable({
    read() {
      if (!isBodyEnded) startIdleTimer();
      body.resume();
    },
    destroy(error, callback) {
      stopIdleTimer();
      body.off("data", onData);
      body.off("end", onEnd);
      body.off("error", onError);
      body.off("close", onClose);
      // Destroying an unfinished body may emit its own error: never seen.
      body.on("error", noop);
      if (!isBodyEnded) body.destroy();
      callback(error);
    },
  });
  function onData(chunk: Uint8Array): void {
    stopIdleTimer();
    if (!stream.push(chunk)) body.pause();
  }
  function onEnd(): void {
    isBodyEnded = true;
    stopIdleTimer();
    stream.push(null);
  }
  function onError(error: unknown): void {
    stream.destroy(storeError(error, "GetObject"));
  }
  function onClose(): void {
    // Closed before its end with no error of its own: as much a failure.
    if (!isBodyEnded) stream.destroy(new FileStoreError(undefined, "GetObject"));
  }
  body.on("data", onData);
  body.on("end", onEnd);
  body.on("error", onError);
  body.on("close", onClose);
  return stream;
}

function s3FileStore(client: S3Client, bucket: string, prefix: string): IFileStore {
  /** The key's object name. Checks every id and name first (InvalidFileKeyError), before any request. */
  function objectName(key: FileKey): string {
    return `${prefix}${fileKeyName(key)}`;
  }

  async function write(
    key: FileKey,
    content: AsyncIterable<Uint8Array> | Readable,
    options: FileWriteOptions,
  ): Promise<FileWriteResult> {
    try {
      const name = objectName(key);
      const { maxBytes, signal } = options;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError("maxBytes must be a non-negative integer.");
      }
      if (maxBytes > MAX_BUFFERED_BYTES) {
        throw new RangeError(`maxBytes must be at most ${MAX_BUFFERED_BYTES} for the S3 file store.`);
      }
      signal?.throwIfAborted();
      const hash = createHash("sha256");
      const parts: Uint8Array[] = [];
      let sizeBytes = 0;
      await consume(content, signal, async (chunk) => {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("A file's content must be bytes.");
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maxBytes) throw new FileTooLargeError(maxBytes);
        hash.update(chunk);
        parts.push(chunk);
      });
      // An abort after the last chunk, before the request: the old object stays.
      signal?.throwIfAborted();
      const body = Buffer.concat(parts, sizeBytes);
      const digest = hash.digest();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: name,
            Body: body,
            // Always: without it the SDK warns on `console`.
            ContentLength: body.byteLength,
            // The SDK then sends this checksum alone; the server refuses a body that doesn't match it.
            ChecksumSHA256: digest.toString("base64"),
            ContentType: "application/octet-stream",
          }),
          signal === undefined ? {} : { abortSignal: signal },
        );
      } catch (error) {
        // The SDK's AbortError carries the reason as its cause: the reason itself is the answer.
        if (signal?.aborted) throw signal.reason;
        throw storeError(error, "PutObject");
      }
      return { sizeBytes, sha256: digest.toString("hex") };
    } catch (error) {
      // A Readable the write never finished is destroyed, so its producer
      // (an upload's request) doesn't wait on it.
      if (content instanceof Readable) content.destroy();
      throw error;
    }
  }

  async function read(key: FileKey): Promise<FileReadResult> {
    const name = objectName(key);
    let output;
    try {
      output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: name }));
    } catch (error) {
      if (isNoSuchKey(error)) return { found: false };
      throw storeError(error, "GetObject");
    }
    const { Body: body, ContentLength: sizeBytes } = output;
    if (!(body instanceof Readable)) throw new FileStoreError("InvalidBody", "GetObject");
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      body.on("error", noop);
      body.destroy();
      throw new FileStoreError("InvalidContentLength", "GetObject");
    }
    return { found: true, sizeBytes, stream: storeStream(body) };
  }

  async function copy(from: FileKey, to: FileKey): Promise<FileCopyResult> {
    // Both keys are checked before any request.
    objectName(from);
    objectName(to);
    const source = await read(from);
    if (!source.found) return { found: false };
    // The source is already bounded by its own write; its errors arrive mapped.
    const written = await write(to, source.stream, {
      maxBytes: MAX_BUFFERED_BYTES,
    });
    return { found: true, ...written };
  }

  async function remove(key: FileKey): Promise<void> {
    const name = objectName(key);
    try {
      // A key with no object answers 204 as well.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: name }));
    } catch (error) {
      throw storeError(error, "DeleteObject");
    }
  }

  return { write, read, copy, remove };
}
